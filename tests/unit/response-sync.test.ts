// Mocked checks for the sync engine loop. The uploader is injected, so no
// network, database or Azure is involved.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  claimNextPendingResponse,
  closeOfflineDB,
  getAllPendingResponses,
  getPendingResponse,
  savePendingResponse,
} from '@/lib/offline-storage';
import {
  computeBlobSha256,
  defaultUploader,
  isRetriableStatus,
  isUploadConfirmed,
  syncPendingData,
  uploadWithoutStorage,
  type SyncAck,
  type UploadOutcome,
  type Uploader,
} from '@/lib/response-sync';

const audio = () => new Blob(['bytes'], { type: 'audio/webm' });

async function save(questionId: string, recordedAt: number, sessionId = 's1') {
  return savePendingResponse({ questionId, sessionId, audioBlob: audio(), durationSeconds: 5, recordedAt });
}

beforeEach(() => closeOfflineDB());
afterEach(() => {
  closeOfflineDB();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isRetriableStatus', () => {
  it('treats 5xx, 408 and 429 as transient and other 4xx as terminal', () => {
    expect(isRetriableStatus(500)).toBe(true);
    expect(isRetriableStatus(503)).toBe(true);
    expect(isRetriableStatus(408)).toBe(true);
    expect(isRetriableStatus(429)).toBe(true);
    expect(isRetriableStatus(400)).toBe(false);
    expect(isRetriableStatus(404)).toBe(false);
    expect(isRetriableStatus(413)).toBe(false);
  });
});

describe('syncPendingData', () => {
  it('does nothing while offline', async () => {
    await save('q1', 1_000);
    const uploader = vi.fn<Uploader>();
    const result = await syncPendingData({ uploader, online: () => false });
    expect(result).toEqual({ synced: 0, failed: 0, errors: [] });
    expect(uploader).not.toHaveBeenCalled();
  });

  it('uploads due records oldest-first and deletes them only when confirmed', async () => {
    await save('q2', 2_000);
    await save('q1', 1_000);
    const order: string[] = [];
    const uploader: Uploader = async (record) => {
      order.push(record.questionId);
      return { confirmed: true, outcome: 'created' };
    };
    const result = await syncPendingData({ uploader, online: () => true, owner: 'tab-a' });
    expect(result).toEqual({ synced: 2, failed: 0, errors: [] });
    expect(order).toEqual(['q1', 'q2']);
    expect(await getAllPendingResponses()).toHaveLength(0);
  });

  it('keeps the record and schedules a retry when the upload is not confirmed', async () => {
    const r = await save('q1', 1_000);
    let now = 10_000;
    const uploader: Uploader = async () => ({ confirmed: false, retriable: true, error: 'HTTP 503', code: 'HTTP_503' });

    const first = await syncPendingData({ uploader, online: () => true, owner: 'tab-a', now: () => now });
    expect(first.synced).toBe(0);
    expect(first.failed).toBe(1);
    expect(first.errors[0]).toContain('HTTP 503');

    const stored = await getPendingResponse(r.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.attempts).toBe(1);
    expect(stored?.nextRetryAt).toBeGreaterThan(now);

    // Same run again before the retry time: nothing is attempted.
    const calls = vi.fn(uploader);
    const second = await syncPendingData({ uploader: calls, online: () => true, owner: 'tab-a', now: () => now + 1 });
    expect(calls).not.toHaveBeenCalled();
    expect(second.failed).toBe(0);

    // After the backoff the record is retried.
    now = stored!.nextRetryAt + 1;
    const third = await syncPendingData({ uploader: calls, online: () => true, owner: 'tab-a', now: () => now });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(third.failed).toBe(1);
    expect((await getPendingResponse(r.id))?.attempts).toBe(2);
  });

  it('marks terminal failures as rejected and never retries them automatically', async () => {
    const r = await save('q1', 1_000);
    const uploader = vi.fn<Uploader>(async () => ({
      confirmed: false,
      retriable: false,
      error: 'Session not found',
      code: 'SESSION_NOT_FOUND',
    }));
    await syncPendingData({ uploader, online: () => true, owner: 'tab-a' });
    await syncPendingData({ uploader, online: () => true, owner: 'tab-a', now: () => Number.MAX_SAFE_INTEGER - 1 });
    expect(uploader).toHaveBeenCalledTimes(1);
    const stored = await getPendingResponse(r.id);
    expect(stored?.status).toBe('rejected');
    expect(stored?.lastErrorCode).toBe('SESSION_NOT_FOUND');
  });

  it('treats an uploader exception as a retriable failure', async () => {
    const r = await save('q1', 1_000);
    const uploader: Uploader = async () => {
      throw new Error('socket hang up');
    };
    const result = await syncPendingData({ uploader, online: () => true, owner: 'tab-a' });
    expect(result.failed).toBe(1);
    const stored = await getPendingResponse(r.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.lastError).toBe('socket hang up');
    expect(stored?.lastErrorCode).toBe('UPLOAD_EXCEPTION');
  });

  it('skips records that another tab is currently uploading', async () => {
    const r = await save('q1', 1_000);
    await claimNextPendingResponse('tab-b', { now: 10_000, leaseMs: 60_000 });
    const uploader = vi.fn<Uploader>(async () => ({ confirmed: true, outcome: 'created' }));
    await syncPendingData({ uploader, online: () => true, owner: 'tab-a', now: () => 20_000 });
    expect(uploader).not.toHaveBeenCalled();
    expect((await getPendingResponse(r.id))?.leaseOwner).toBe('tab-b');
  });

  it('picks up an upload that a crashed tab left behind once the lease expires', async () => {
    await save('q1', 1_000);
    await claimNextPendingResponse('tab-crashed', { now: 10_000, leaseMs: 1_000 });
    const uploader = vi.fn<Uploader>(async () => ({ confirmed: true, outcome: 'created' }));
    const result = await syncPendingData({ uploader, online: () => true, owner: 'tab-a', now: () => 12_000 });
    expect(result.synced).toBe(1);
    expect(await getAllPendingResponses()).toHaveLength(0);
  });

  it('keeps the lease alive during a long upload', async () => {
    // Only fake intervals: fake-indexeddb schedules its transactions with timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const r = await save('q1', 1_000);
      let now = 10_000;
      let resolveUpload!: (o: UploadOutcome) => void;
      const uploader: Uploader = () => new Promise<UploadOutcome>((res) => (resolveUpload = res));

      const run = syncPendingData({ uploader, online: () => true, owner: 'tab-a', now: () => now, leaseMs: 3_000 });
      // Let the claim happen.
      await new Promise((res) => setTimeout(res, 20));
      expect((await getPendingResponse(r.id))?.leaseUntil).toBe(13_000);

      now = 12_000;
      vi.advanceTimersByTime(1_000); // heartbeat every leaseMs/3
      await new Promise((res) => setTimeout(res, 20));
      expect((await getPendingResponse(r.id))?.leaseUntil).toBe(15_000);

      resolveUpload({ confirmed: true, outcome: 'created' });
      await run;
      expect(await getAllPendingResponses()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports progress for each transition', async () => {
    await save('q1', 1_000);
    await save('q2', 2_000);
    const events: string[] = [];
    let n = 0;
    const uploader: Uploader = async () =>
      n++ === 0
        ? { confirmed: true, outcome: 'created' }
        : { confirmed: false, retriable: true, error: 'HTTP 503', code: 'HTTP_503' };
    await syncPendingData({
      uploader,
      online: () => true,
      owner: 'tab-a',
      onProgress: (e) => events.push(`${e.type}:${e.record.questionId}`),
    });
    expect(events).toEqual(['claimed:q1', 'confirmed:q1', 'claimed:q2', 'failed:q2']);
  });

  it('can be restricted to one session', async () => {
    await save('q1', 1_000, 's1');
    await save('q1', 1_000, 's2');
    const uploader = vi.fn<Uploader>(async () => ({ confirmed: true, outcome: 'created' }));
    await syncPendingData({ uploader, online: () => true, owner: 'tab-a', sessionId: 's2' });
    expect(uploader).toHaveBeenCalledTimes(1);
    expect(uploader.mock.calls[0][0].sessionId).toBe('s2');
  });
});

describe('isUploadConfirmed', () => {
  const ack = (over: Partial<SyncAck> = {}): SyncAck => ({
    outcome: 'created',
    responseId: 'r1',
    syncedAt: 'now',
    audio: { stored: true, bytes: 5, sha256: 'abc' },
    ...over,
  });

  it('requires stored audio with a matching checksum', () => {
    expect(isUploadConfirmed({ audioSize: 5, audioSha256: 'abc' }, ack())).toBe(true);
    expect(isUploadConfirmed({ audioSize: 5, audioSha256: 'abc' }, ack({ audio: { stored: true, bytes: 5, sha256: 'zzz' } }))).toBe(false);
    expect(isUploadConfirmed({ audioSize: 5, audioSha256: 'abc' }, ack({ audio: { stored: false, bytes: 0, sha256: null } }))).toBe(false);
  });

  it('falls back to a byte-size comparison when no local checksum exists', () => {
    expect(isUploadConfirmed({ audioSize: 5 }, ack())).toBe(true);
    expect(isUploadConfirmed({ audioSize: 6 }, ack())).toBe(false);
  });

  it('confirms answers without audio and superseded answers', () => {
    expect(isUploadConfirmed({ audioSize: 0 }, ack({ audio: { stored: false, bytes: 0, sha256: null } }))).toBe(true);
    expect(isUploadConfirmed({ audioSize: 5, audioSha256: 'abc' }, ack({ outcome: 'superseded', audio: { stored: false, bytes: 0, sha256: null } }))).toBe(true);
  });
});

describe('computeBlobSha256', () => {
  it('matches Node\'s SHA-256', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('bytes').digest('hex');
    expect(await computeBlobSha256(new Blob(['bytes']))).toBe(expected);
  });
});

describe('uploadWithoutStorage', () => {
  it('uploads from memory with the same idempotent protocol and never touches IndexedDB', async () => {
    const uploader = vi.fn<Uploader>(async () => ({ confirmed: true, outcome: 'created', responseId: 'r1' }));
    const outcome = await uploadWithoutStorage(
      { questionId: 'q1', sessionId: 's1', audioBlob: audio(), durationSeconds: 7, recordedAt: 1_000 },
      uploader
    );
    expect(outcome).toEqual({ confirmed: true, outcome: 'created', responseId: 'r1' });
    const record = uploader.mock.calls[0][0];
    expect(record.clientResponseId).toBe(record.id);
    expect(record).toMatchObject({ questionId: 'q1', sessionId: 's1', audioSize: 5, recordedAt: 1_000, durationSeconds: 7 });
    expect(await getAllPendingResponses()).toHaveLength(0);
  });
});

describe('defaultUploader (fetch mocked)', () => {
  const record = async () => save('q1', 1_000);
  const sha = async () => (await computeBlobSha256(audio()))!;
  const okBody = async (over: Partial<SyncAck> = {}) =>
    JSON.stringify({
      success: true,
      data: { outcome: 'created', responseId: 'r1', syncedAt: 'now', audio: { stored: true, bytes: 5, sha256: await sha() }, ...over },
    });

  it('sends the idempotency fields, checksum and audio as multipart form data', async () => {
    const fetchMock = vi.fn(async () => new Response(await okBody(), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await record();
    const outcome = await defaultUploader(r);
    expect(outcome).toEqual({ confirmed: true, outcome: 'created', responseId: 'r1' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/responses/sync');
    const body = init.body as FormData;
    expect(body.get('clientResponseId')).toBe(r.clientResponseId);
    expect(body.get('recordedAt')).toBe('1000');
    expect(body.get('questionId')).toBe('q1');
    expect(body.get('sessionId')).toBe('s1');
    expect(body.get('durationSeconds')).toBe('5');
    expect(body.get('audioSha256')).toBe(await sha());
    expect(body.get('audioMimeType')).toBe('audio/webm');
    expect(body.get('recordedOffline')).toBe('false');
    expect((body.get('audio') as File).size).toBe(5);

    // The checksum is persisted on the local record for later comparisons.
    expect((await getPendingResponse(r.id))?.audioSha256).toBe(await sha());
  });

  it('confirms a retry that the server reports as duplicate (lost acknowledgement)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(await okBody({ outcome: 'duplicate' }), { status: 200 })));
    expect(await defaultUploader(await record())).toEqual({ confirmed: true, outcome: 'duplicate', responseId: 'r1' });
  });

  it('confirms a superseded upload so the obsolete local copy is dropped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(await okBody({ outcome: 'superseded', audio: { stored: false, bytes: 0, sha256: null } }), { status: 200 })
    ));
    expect((await defaultUploader(await record())).confirmed).toBe(true);
  });

  it('does NOT confirm a 2xx whose audio acknowledgement is missing or mismatching', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(await okBody({ audio: { stored: false, bytes: 0, sha256: null } }), { status: 201 })
    ));
    expect(await defaultUploader(await record())).toMatchObject({ confirmed: false, retriable: true, code: 'AUDIO_NOT_CONFIRMED' });

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(await okBody({ audio: { stored: true, bytes: 5, sha256: 'not-ours' } }), { status: 201 })
    ));
    expect(await defaultUploader(await record())).toMatchObject({ confirmed: false, code: 'AUDIO_NOT_CONFIRMED' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('OK', { status: 200 })));
    expect(await defaultUploader(await record())).toMatchObject({ confirmed: false, retriable: true, code: 'UNCONFIRMED_ACK' });
  });

  it('maps network errors to retriable failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const outcome = await defaultUploader(await record());
    expect(outcome).toEqual({ confirmed: false, retriable: true, error: 'Failed to fetch', code: 'NETWORK' });
  });

  it('maps 4xx with an error body to terminal failures and 5xx to retriable ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ success: false, error: { code: 'QUESTION_NOT_FOUND', message: 'Question not found' } }), { status: 404 })
    ));
    expect(await defaultUploader(await record())).toEqual({
      confirmed: false, retriable: false, error: 'Question not found', code: 'QUESTION_NOT_FOUND',
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })));
    expect(await defaultUploader(await record())).toEqual({
      confirmed: false, retriable: true, error: 'HTTP 502', code: 'HTTP_502',
    });
  });

  it('retries a checksum mismatch even though it is a 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ success: false, error: { code: 'AUDIO_CHECKSUM_MISMATCH', message: 'mismatch' } }), { status: 400 })
    ));
    expect(await defaultUploader(await record())).toMatchObject({ confirmed: false, retriable: true, code: 'AUDIO_CHECKSUM_MISMATCH' });
  });
});
