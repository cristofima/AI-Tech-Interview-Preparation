// =========================================================================
// REAL INTEGRATION TEST — requires PostgreSQL.
//
//   DATABASE_URL=postgresql://user:pass@localhost:5432/ai_interview_test \
//   pnpm exec prisma db push && pnpm test:integration
//
// Exercises repeat submissions (idempotency), ordering (superseded/updated),
// audio persistence (bytes + SHA-256 round-trip) and concurrent retries
// through the real Prisma client, the real advisory lock and the real route
// handler. No Azure services are used. Skipped when DATABASE_URL is unset.
// =========================================================================
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { SubmissionInput } from '@/lib/response-submission';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  console.warn('[integration] DATABASE_URL not set — PostgreSQL integration tests skipped');
}

describeIfDb('POST /api/responses/sync against PostgreSQL', () => {
  type Prisma = typeof import('@/lib/prisma').prisma;
  type Submission = typeof import('@/lib/response-submission');
  type Route = typeof import('@/app/api/responses/sync/route');

  let prisma: Prisma;
  let submission: Submission;
  let route: Route;
  let sessionId: string;
  let questionIds: string[];
  const createdSessions: string[] = [];

  const bytes = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

  function input(over: Partial<SubmissionInput> = {}): SubmissionInput {
    const audio = bytes(`audio-${over.clientResponseId ?? 'x'}`);
    return {
      questionId: questionIds[0],
      sessionId,
      clientResponseId: randomUUID(),
      recordedAt: new Date('2024-06-01T10:00:00Z'),
      transcription: 'an answer',
      durationSeconds: 30,
      audio: { bytes: audio, mimeType: 'audio/webm;codecs=opus', sha256: sha(audio) },
      recordedOffline: true,
      legacyClient: false,
      ...over,
    };
  }

  const submit = (i: SubmissionInput) =>
    submission.submitResponse((fn) => prisma.$transaction(fn), i);

  async function rowsFor(questionId: string) {
    return prisma.questionResponse.findMany({ where: { questionId, sessionId } });
  }

  beforeAll(async () => {
    prisma = (await import('@/lib/prisma')).prisma;
    submission = await import('@/lib/response-submission');
    route = await import('@/app/api/responses/sync/route');
    await prisma.$queryRaw`SELECT 1`;
  });

  afterEach(async () => {
    // Fresh session for every test; cascade removes questions/responses/evaluations.
    if (sessionId) {
      await prisma.questionResponse.deleteMany({ where: { sessionId } });
    }
  });

  afterAll(async () => {
    if (createdSessions.length) {
      await prisma.interviewSession.deleteMany({ where: { id: { in: createdSessions } } });
    }
    await prisma.$disconnect();
  });

  beforeAll(async () => {
    const session = await prisma.interviewSession.create({
      data: {
        roleTitle: 'Integration Test Engineer',
        jobDescription: 'offline sync integration test',
        seniorityLevel: 'mid',
        questions: {
          create: [1, 2, 3].map((n) => ({
            questionNumber: n,
            question: `Question ${n}`,
            category: 'technical',
            difficulty: 'mid',
            expectedTopics: [],
            timeLimitSeconds: 60,
          })),
        },
      },
      include: { questions: { orderBy: { questionNumber: 'asc' } } },
    });
    sessionId = session.id;
    createdSessions.push(session.id);
    questionIds = session.questions.map((q) => q.id);
  });

  it('persists the answer and its audio; bytes and checksum round-trip', async () => {
    const i = input();
    const result = await submit(i);
    expect(result.outcome).toBe('created');
    expect(result.audio).toEqual({ stored: true, bytes: i.audio!.bytes.byteLength, sha256: i.audio!.sha256 });

    const rows = await rowsFor(questionIds[0]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.clientResponseId).toBe(i.clientResponseId);
    expect(row.recordedAt?.toISOString()).toBe('2024-06-01T10:00:00.000Z');
    expect(row.status).toBe('completed');
    expect(row.isOffline).toBe(true);
    expect(row.syncedAt).not.toBeNull();
    expect(row.audioMimeType).toBe('audio/webm;codecs=opus');
    expect(row.audioSizeBytes).toBe(i.audio!.bytes.byteLength);
    expect(row.audioSha256).toBe(i.audio!.sha256);
    expect(Buffer.from(row.audioBlob!).equals(Buffer.from(i.audio!.bytes))).toBe(true);
    expect(sha(row.audioBlob!)).toBe(i.audio!.sha256);
  });

  it('repeat submission with the same clientResponseId creates no duplicate and rewrites nothing', async () => {
    const i = input({ transcription: 'original' });
    const first = await submit(i);
    const retry = await submit({ ...i, transcription: 'changed on retry', durationSeconds: 1 });

    expect(retry.outcome).toBe('duplicate');
    expect(retry.responseId).toBe(first.responseId);
    expect(retry.audio).toEqual(first.audio);

    const rows = await rowsFor(questionIds[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].transcription).toBe('original');
    expect(rows[0].durationSeconds).toBe(30);
  });

  it('a retry backfills audio missing from the first attempt', async () => {
    const i = input();
    const first = await submit({ ...i, audio: null });
    expect(first.audio.stored).toBe(false);

    const retry = await submit(i);
    expect(retry.outcome).toBe('duplicate');
    expect(retry.audio.stored).toBe(true);
    const rows = await rowsFor(questionIds[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].audioSha256).toBe(i.audio!.sha256);
    expect(Buffer.from(rows[0].audioBlob!).equals(Buffer.from(i.audio!.bytes))).toBe(true);
  });

  it('an older recording arriving late does not overwrite the newer stored answer', async () => {
    const newer = await submit(input({ clientResponseId: 'newer-' + randomUUID(), recordedAt: new Date('2024-06-01T12:00:00Z'), transcription: 'newer' }));
    const stale = await submit(input({ clientResponseId: 'older-' + randomUUID(), recordedAt: new Date('2024-06-01T11:00:00Z'), transcription: 'older' }));
    expect(stale.outcome).toBe('superseded');
    expect(stale.responseId).toBe(newer.responseId);

    const rows = await rowsFor(questionIds[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].transcription).toBe('newer');
    expect(rows[0].audioSha256).toBe(sha(bytes(`audio-${rows[0].clientResponseId}`)));
  });

  it('a newer recording replaces the answer, its audio, and removes the stale evaluation', async () => {
    const first = await submit(input({ clientResponseId: 'first-' + randomUUID(), recordedAt: new Date('2024-06-01T10:00:00Z') }));
    await prisma.responseEvaluation.create({
      data: {
        responseId: first.responseId,
        questionId: questionIds[0],
        sessionId,
        relevanceScore: 1, technicalAccuracyScore: 1, clarityScore: 1, depthScore: 1, structureScore: 1, confidenceScore: 1, overallScore: 1,
        strengths: [], improvements: [], suggestion: 'n/a', performanceBand: 'poor',
      },
    });

    const second = input({ clientResponseId: 'second-' + randomUUID(), recordedAt: new Date('2024-06-01T10:10:00Z'), transcription: 'second' });
    const result = await submit(second);
    expect(result.outcome).toBe('updated');
    expect(result.responseId).toBe(first.responseId);

    const rows = await rowsFor(questionIds[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].transcription).toBe('second');
    expect(rows[0].clientResponseId).toBe(second.clientResponseId);
    expect(Buffer.from(rows[0].audioBlob!).equals(Buffer.from(second.audio!.bytes))).toBe(true);
    expect(await prisma.responseEvaluation.count({ where: { responseId: first.responseId } })).toBe(0);
  });

  it('concurrent retries of the same recording yield exactly one row (advisory lock)', async () => {
    const i = input();
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(i)));
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(5);
    expect(new Set(results.map((r) => r.responseId)).size).toBe(1);
    expect(await rowsFor(questionIds[0])).toHaveLength(1);
  });

  it('concurrent different recordings of one question end with the newest stored', async () => {
    const base = new Date('2024-06-01T10:00:00Z').getTime();
    const inputs = Array.from({ length: 5 }, (_, n) =>
      input({ clientResponseId: `c${n}-` + randomUUID(), recordedAt: new Date(base + n * 1000), transcription: `answer ${n}` })
    );
    await Promise.all(inputs.map((i) => submit(i)));
    const rows = await rowsFor(questionIds[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].transcription).toBe('answer 4');
    expect(rows[0].clientResponseId).toBe(inputs[4].clientResponseId);
  });

  it('the route handler round-trips multipart audio end to end', async () => {
    const audio = new Blob(['route audio bytes'], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('questionId', questionIds[1]);
    fd.append('sessionId', sessionId);
    fd.append('durationSeconds', '12');
    fd.append('transcription', 'via route');
    fd.append('clientResponseId', randomUUID());
    fd.append('recordedAt', String(Date.parse('2024-06-01T10:00:00Z')));
    fd.append('audioSha256', sha(bytes('route audio bytes')));
    fd.append('audio', audio, 'response.webm');

    const req = () => new NextRequest('http://localhost/api/responses/sync', { method: 'POST', body: fd });
    const first = await route.POST(req());
    expect(first.status).toBe(201);
    const firstJson = await first.json();
    expect(firstJson.data.outcome).toBe('created');
    expect(firstJson.data.audio).toEqual({ stored: true, bytes: 17, sha256: sha(bytes('route audio bytes')) });

    const second = await route.POST(req());
    expect(second.status).toBe(200);
    expect((await second.json()).data.outcome).toBe('duplicate');

    const rows = await rowsFor(questionIds[1]);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].audioBlob!).toString()).toBe('route audio bytes');
  });

  it('rejects unknown questions without writing', async () => {
    await expect(submit(input({ questionId: 'does-not-exist' }))).rejects.toMatchObject({ code: 'QUESTION_NOT_FOUND' });
    expect(await prisma.questionResponse.count({ where: { sessionId } })).toBe(0);
  });
});
