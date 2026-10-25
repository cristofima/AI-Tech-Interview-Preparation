// Mocked checks for the server-side submission policy (in-memory fake DB,
// no PostgreSQL). The same scenarios run against a real database in
// tests/integration/response-sync.pg.test.ts.
import { describe, it, expect } from 'vitest';
import {
  MAX_AUDIO_BYTES,
  decideSubmission,
  effectiveRecordedAt,
  parseSyncFormData,
  sha256Hex,
  submitResponse,
  SubmissionError,
  type ExistingResponseRow,
  type SubmissionInput,
} from '@/lib/response-submission';
import { createFakeDb } from './fake-submission-db';

const bytes = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

function input(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  const audioBytes = bytes('audio-1');
  return {
    questionId: 'q1',
    sessionId: 's1',
    clientResponseId: 'client-1',
    recordedAt: new Date('2024-06-01T10:00:00Z'),
    transcription: 'first answer',
    durationSeconds: 42,
    audio: { bytes: audioBytes, mimeType: 'audio/webm', sha256: sha256Hex(audioBytes) },
    recordedOffline: false,
    legacyClient: false,
    ...overrides,
  };
}

function row(overrides: Partial<ExistingResponseRow> = {}): ExistingResponseRow {
  return {
    id: 'resp_1',
    clientResponseId: 'client-0',
    recordedAt: new Date('2024-06-01T09:00:00Z'),
    completedAt: new Date('2024-06-01T09:00:05Z'),
    createdAt: new Date('2024-06-01T09:00:05Z'),
    audioSizeBytes: 10,
    audioSha256: 'abc',
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// Pure decision
// -------------------------------------------------------------------------
describe('decideSubmission', () => {
  const incoming = { clientResponseId: 'client-1', recordedAt: new Date('2024-06-01T10:00:00Z') };

  it('creates when nothing is stored', () => {
    expect(decideSubmission(null, incoming)).toBe('create');
  });

  it('detects a repeat of the same recording (lost acknowledgement)', () => {
    expect(decideSubmission(row({ clientResponseId: 'client-1' }), incoming)).toBe('duplicate');
  });

  it('refuses to overwrite a newer stored recording', () => {
    expect(decideSubmission(row({ recordedAt: new Date('2024-06-01T11:00:00Z') }), incoming)).toBe('superseded');
  });

  it('updates when the incoming recording is newer or equal', () => {
    expect(decideSubmission(row({ recordedAt: new Date('2024-06-01T09:59:59Z') }), incoming)).toBe('update');
    expect(decideSubmission(row({ recordedAt: new Date('2024-06-01T10:00:00Z') }), incoming)).toBe('update');
  });

  it('falls back to completedAt/createdAt for rows written by older builds', () => {
    const legacyNewer = row({ clientResponseId: null, recordedAt: null, completedAt: new Date('2024-06-01T12:00:00Z') });
    expect(decideSubmission(legacyNewer, incoming)).toBe('superseded');

    const legacyOlder = row({ clientResponseId: null, recordedAt: null, completedAt: new Date('2024-05-01T00:00:00Z') });
    expect(decideSubmission(legacyOlder, incoming)).toBe('update');

    const noCompleted = row({ clientResponseId: null, recordedAt: null, completedAt: null, createdAt: new Date('2024-06-01T12:00:00Z') });
    expect(effectiveRecordedAt(noCompleted).toISOString()).toBe('2024-06-01T12:00:00.000Z');
    expect(decideSubmission(noCompleted, incoming)).toBe('superseded');
  });

  it('a null stored clientResponseId never counts as a duplicate', () => {
    expect(decideSubmission(row({ clientResponseId: null, recordedAt: new Date(0) }), { ...incoming, clientResponseId: '' })).toBe('update');
  });
});

// -------------------------------------------------------------------------
// Request parsing
// -------------------------------------------------------------------------
describe('parseSyncFormData', () => {
  function form(fields: Record<string, string>, audio?: Blob, audioName = 'response.webm') {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (audio) fd.append('audio', audio, audioName);
    return fd;
  }

  it('parses a full v2 request and verifies the checksum', async () => {
    const blob = new Blob(['hello audio'], { type: 'audio/webm;codecs=opus' });
    const expected = sha256Hex(bytes('hello audio'));
    const parsed = await parseSyncFormData(
      form(
        {
          questionId: 'q1',
          sessionId: 's1',
          durationSeconds: '17',
          transcription: ' some text ',
          clientResponseId: 'abc-123',
          recordedAt: '1717236000000',
          audioSha256: expected.toUpperCase(),
          audioMimeType: 'audio/webm;codecs=opus',
          recordedOffline: 'true',
        },
        blob
      )
    );
    expect(parsed).toMatchObject({
      questionId: 'q1',
      sessionId: 's1',
      durationSeconds: 17,
      transcription: 'some text',
      clientResponseId: 'abc-123',
      recordedOffline: true,
      legacyClient: false,
    });
    expect(parsed.recordedAt.getTime()).toBe(1717236000000);
    expect(parsed.audio?.sha256).toBe(expected);
    expect(parsed.audio?.mimeType).toBe('audio/webm;codecs=opus');
    expect(new TextDecoder().decode(parsed.audio!.bytes)).toBe('hello audio');
  });

  it('rejects requests without questionId/sessionId', async () => {
    await expect(parseSyncFormData(form({ questionId: 'q1' }))).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
  });

  it('rejects a checksum mismatch', async () => {
    await expect(
      parseSyncFormData(form({ questionId: 'q1', sessionId: 's1', audioSha256: 'deadbeef' }, new Blob(['x'])))
    ).rejects.toMatchObject({ status: 400, code: 'AUDIO_CHECKSUM_MISMATCH' });
  });

  it('rejects oversized audio', async () => {
    const big = new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)]);
    await expect(parseSyncFormData(form({ questionId: 'q1', sessionId: 's1' }, big))).rejects.toMatchObject({
      status: 413,
      code: 'AUDIO_TOO_LARGE',
    });
  });

  it('rejects an invalid recordedAt', async () => {
    await expect(parseSyncFormData(form({ questionId: 'q1', sessionId: 's1', recordedAt: 'yesterday' }))).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });
  });

  it('supports pre-v2 clients: generates an id and uses "now" as recordedAt', async () => {
    const before = Date.now();
    const parsed = await parseSyncFormData(form({ questionId: 'q1', sessionId: 's1', durationSeconds: 'NaN' }));
    expect(parsed.legacyClient).toBe(true);
    expect(parsed.clientResponseId).toMatch(/^legacy-/);
    expect(parsed.recordedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(parsed.durationSeconds).toBeNull();
    expect(parsed.audio).toBeNull();
  });

  it('treats an empty audio part as "no audio"', async () => {
    const parsed = await parseSyncFormData(form({ questionId: 'q1', sessionId: 's1' }, new Blob([])));
    expect(parsed.audio).toBeNull();
  });
});

// -------------------------------------------------------------------------
// Persistence against the in-memory fake
// -------------------------------------------------------------------------
describe('submitResponse', () => {
  const seed = { sessions: ['s1'], questions: [{ id: 'q1', sessionId: 's1' }, { id: 'q2', sessionId: 's1' }] };

  it('rejects unknown sessions and questions', async () => {
    const db = createFakeDb(seed);
    await expect(submitResponse(db.run, input({ sessionId: 'nope' }))).rejects.toMatchObject({ status: 404, code: 'SESSION_NOT_FOUND' });
    await expect(submitResponse(db.run, input({ questionId: 'q9' }))).rejects.toMatchObject({ status: 404, code: 'QUESTION_NOT_FOUND' });
    expect(db.responses.size).toBe(0);
  });

  it('takes a per-question advisory lock inside the transaction', async () => {
    const db = createFakeDb(seed);
    await submitResponse(db.run, input());
    expect(db.calls[0]).toBe('raw:SELECT pg_advisory_xact_lock(hashtext(?)):s1:q1');
  });

  it('creates a row with audio and echoes the audio acknowledgement', async () => {
    const db = createFakeDb(seed);
    const result = await submitResponse(db.run, input({ recordedOffline: true }));
    expect(result.outcome).toBe('created');
    expect(result.audio).toEqual({ stored: true, bytes: 7, sha256: sha256Hex(bytes('audio-1')) });

    const stored = db.responses.get(result.responseId)!;
    expect(stored.clientResponseId).toBe('client-1');
    expect(stored.transcription).toBe('first answer');
    expect(stored.durationSeconds).toBe(42);
    expect(stored.status).toBe('completed');
    expect(stored.isOffline).toBe(true);
    expect(stored.recordedAt.toISOString()).toBe('2024-06-01T10:00:00.000Z');
    expect(stored.startedAt?.toISOString()).toBe('2024-06-01T10:00:00.000Z');
    expect(new TextDecoder().decode(stored.audioBlob!)).toBe('audio-1');
    expect(stored.audioMimeType).toBe('audio/webm');
    expect(stored.syncedAt).toBeInstanceOf(Date);
  });

  it('reports audio as not stored when the submission had none', async () => {
    const db = createFakeDb(seed);
    const result = await submitResponse(db.run, input({ audio: null }));
    expect(result.outcome).toBe('created');
    expect(result.audio).toEqual({ stored: false, bytes: 0, sha256: null });
  });

  it('a repeat submission with the same clientResponseId is a duplicate: one row, nothing rewritten', async () => {
    const db = createFakeDb(seed);
    const first = await submitResponse(db.run, input());
    const callsAfterFirst = db.calls.length;

    const second = await submitResponse(db.run, input({ transcription: 'tampered', durationSeconds: 1 }));
    expect(second.outcome).toBe('duplicate');
    expect(second.responseId).toBe(first.responseId);
    expect(second.audio).toEqual(first.audio);
    expect(db.responses.size).toBe(1);
    expect(db.responses.get(first.responseId)!.transcription).toBe('first answer');
    expect(db.calls.slice(callsAfterFirst)).not.toContain('update');
  });

  it('a duplicate backfills audio that the first attempt could not store', async () => {
    const db = createFakeDb(seed);
    const first = await submitResponse(db.run, input({ audio: null }));
    expect(first.audio.stored).toBe(false);

    const second = await submitResponse(db.run, input());
    expect(second.outcome).toBe('duplicate');
    expect(second.audio.stored).toBe(true);
    expect(second.audio.sha256).toBe(sha256Hex(bytes('audio-1')));
    expect(db.responses.size).toBe(1);
    expect(db.responses.get(first.responseId)!.audioSha256).toBe(sha256Hex(bytes('audio-1')));
  });

  it('an older recording never overwrites a newer stored answer', async () => {
    const db = createFakeDb(seed);
    const newer = await submitResponse(
      db.run,
      input({ clientResponseId: 'client-new', recordedAt: new Date('2024-06-01T12:00:00Z'), transcription: 'newer answer' })
    );
    const stale = await submitResponse(
      db.run,
      input({ clientResponseId: 'client-old', recordedAt: new Date('2024-06-01T11:00:00Z'), transcription: 'older answer' })
    );
    expect(stale.outcome).toBe('superseded');
    expect(stale.responseId).toBe(newer.responseId);
    expect(db.responses.size).toBe(1);
    expect(db.responses.get(newer.responseId)!.transcription).toBe('newer answer');
    expect(db.responses.get(newer.responseId)!.clientResponseId).toBe('client-new');
  });

  it('a newer recording replaces the stored answer and drops its stale evaluation', async () => {
    const db = createFakeDb(seed);
    const first = await submitResponse(db.run, input({ clientResponseId: 'client-old', recordedAt: new Date('2024-06-01T10:00:00Z') }));
    db.seedEvaluation(first.responseId);
    db.seedEvaluation('some-other-response');

    const audio2 = bytes('audio-2-longer');
    const second = await submitResponse(
      db.run,
      input({
        clientResponseId: 'client-new',
        recordedAt: new Date('2024-06-01T10:05:00Z'),
        transcription: 'second answer',
        audio: { bytes: audio2, mimeType: 'audio/ogg', sha256: sha256Hex(audio2) },
      })
    );
    expect(second.outcome).toBe('updated');
    expect(second.responseId).toBe(first.responseId);
    expect(second.audio).toEqual({ stored: true, bytes: audio2.byteLength, sha256: sha256Hex(audio2) });

    const stored = db.responses.get(first.responseId)!;
    expect(stored.transcription).toBe('second answer');
    expect(stored.clientResponseId).toBe('client-new');
    expect(stored.audioMimeType).toBe('audio/ogg');
    expect(Array.from(db.evaluations.values())).toEqual([{ responseId: 'some-other-response' }]);
  });

  it('replaces rows written by older builds (no clientResponseId/recordedAt) when the recording is newer', async () => {
    const db = createFakeDb(seed);
    const legacy = db.seedResponse({
      questionId: 'q1',
      sessionId: 's1',
      transcription: 'legacy',
      completedAt: new Date('2024-01-01T00:00:00Z'),
    });
    const result = await submitResponse(db.run, input());
    expect(result.outcome).toBe('updated');
    expect(result.responseId).toBe(legacy.id);
    expect(db.responses.get(legacy.id)!.transcription).toBe('first answer');
  });

  it('keeps rows written by older builds that are newer than the recording', async () => {
    const db = createFakeDb(seed);
    db.seedResponse({
      questionId: 'q1',
      sessionId: 's1',
      transcription: 'legacy but newer',
      completedAt: new Date('2030-01-01T00:00:00Z'),
    });
    const result = await submitResponse(db.run, input());
    expect(result.outcome).toBe('superseded');
    expect(result.audio.stored).toBe(false);
  });

  it('surfaces SubmissionError instances unchanged', async () => {
    const db = createFakeDb(seed);
    const err = await submitResponse(db.run, input({ sessionId: 'x' })).catch((e) => e);
    expect(err).toBeInstanceOf(SubmissionError);
  });
});
