// Mocked checks for POST /api/responses/sync: HTTP mapping on top of the
// submission module. `@/lib/prisma` is replaced by the in-memory fake, so no
// PostgreSQL connection is made.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from './fake-submission-db';
import { sha256Hex } from '@/lib/response-submission';

let db: FakeDb;

vi.mock('@/lib/prisma', () => ({
  get prisma() {
    return { $transaction: (fn: Parameters<FakeDb['run']>[0]) => db.run(fn) };
  },
}));

const { POST } = await import('@/app/api/responses/sync/route');

function request(fields: Record<string, string>, audio?: Blob) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (audio) fd.append('audio', audio, 'response.webm');
  return new NextRequest('http://localhost/api/responses/sync', { method: 'POST', body: fd });
}

const base = { questionId: 'q1', sessionId: 's1', durationSeconds: '30', transcription: 'hi' };

beforeEach(() => {
  db = createFakeDb({ sessions: ['s1'], questions: [{ id: 'q1', sessionId: 's1' }] });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('POST /api/responses/sync', () => {
  it('returns 201 created with the audio acknowledgement', async () => {
    const blob = new Blob(['audio!'], { type: 'audio/webm' });
    const res = await POST(request({ ...base, clientResponseId: 'c1', recordedAt: '1717236000000' }, blob));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.outcome).toBe('created');
    expect(json.data.audio).toEqual({ stored: true, bytes: 6, sha256: sha256Hex(new TextEncoder().encode('audio!') as Uint8Array<ArrayBuffer>) });
    expect(typeof json.data.responseId).toBe('string');
    expect(typeof json.data.syncedAt).toBe('string');
  });

  it('returns 200 duplicate on a retry of the same recording', async () => {
    const blob = new Blob(['audio!'], { type: 'audio/webm' });
    await POST(request({ ...base, clientResponseId: 'c1', recordedAt: '1717236000000' }, blob));
    const res = await POST(request({ ...base, clientResponseId: 'c1', recordedAt: '1717236000000' }, blob));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.outcome).toBe('duplicate');
    expect(json.data.audio.stored).toBe(true);
    expect(db.responses.size).toBe(1);
  });

  it('returns 200 superseded when a newer answer is already stored', async () => {
    await POST(request({ ...base, clientResponseId: 'new', recordedAt: '1717236100000' }));
    const res = await POST(request({ ...base, clientResponseId: 'old', recordedAt: '1717236000000' }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.outcome).toBe('superseded');
  });

  it('returns 200 updated when the recording is newer', async () => {
    await POST(request({ ...base, clientResponseId: 'old', recordedAt: '1717236000000' }));
    const res = await POST(request({ ...base, clientResponseId: 'new', recordedAt: '1717236100000' }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.outcome).toBe('updated');
  });

  it('maps validation and lookup failures to 4xx with error codes', async () => {
    expect((await POST(request({ sessionId: 's1' }))).status).toBe(400);
    const notFound = await POST(request({ ...base, sessionId: 'missing' }));
    expect(notFound.status).toBe(404);
    expect((await notFound.json()).error.code).toBe('SESSION_NOT_FOUND');
    const badQuestion = await POST(request({ ...base, questionId: 'missing' }));
    expect((await badQuestion.json()).error.code).toBe('QUESTION_NOT_FOUND');
    const mismatch = await POST(request({ ...base, audioSha256: '00' }, new Blob(['x'])));
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error.code).toBe('AUDIO_CHECKSUM_MISMATCH');
  });

  it('still accepts the pre-v2 request shape (no clientResponseId)', async () => {
    const res = await POST(request(base, new Blob(['legacy'])));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.outcome).toBe('created');
    expect(json.data.audio.stored).toBe(true);
  });

  it('returns 500 SYNC_FAILED on unexpected database errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.tx.interviewSession.findUnique = async () => {
      throw new Error('connection refused');
    };
    const res = await POST(request({ ...base, clientResponseId: 'c1' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toEqual({ code: 'SYNC_FAILED', message: 'connection refused' });
  });
});
