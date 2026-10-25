// Mocked checks for the IndexedDB storage layer (fake-indexeddb, no network).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDB } from 'idb';
import {
  DB_NAME,
  DB_VERSION,
  ATTENTION_AFTER_ATTEMPTS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  claimNextPendingResponse,
  closeOfflineDB,
  completePendingResponse,
  computeBackoffMs,
  discardPendingResponse,
  extendLease,
  getAllPendingResponses,
  getNextDueTime,
  getPendingResponse,
  getPendingResponsesBySession,
  getPendingResponsesCount,
  getPendingSummary,
  markPendingResponseFailed,
  migratePendingResponseV1,
  recoverInterruptedUploads,
  retryAllPendingResponses,
  retryPendingResponse,
  savePendingResponse,
  setPendingResponseChecksum,
  type PendingResponseV1,
} from '@/lib/offline-storage';

const audio = (text = 'audio-bytes') => new Blob([text], { type: 'audio/webm;codecs=opus' });

async function save(overrides: Partial<Parameters<typeof savePendingResponse>[0]> = {}) {
  return savePendingResponse({
    questionId: 'q1',
    sessionId: 's1',
    audioBlob: audio(),
    transcription: 'hello',
    durationSeconds: 12,
    recordedAt: 1_000,
    ...overrides,
  });
}

beforeEach(() => {
  closeOfflineDB();
});
afterEach(() => {
  closeOfflineDB();
});

// -------------------------------------------------------------------------
// Backoff policy
// -------------------------------------------------------------------------
describe('computeBackoffMs', () => {
  it('grows exponentially from 5s and caps at 5 minutes (no jitter)', () => {
    const noJitter = () => 0.5;
    expect(computeBackoffMs(1, noJitter)).toBe(BACKOFF_BASE_MS);
    expect(computeBackoffMs(2, noJitter)).toBe(15_000);
    expect(computeBackoffMs(3, noJitter)).toBe(45_000);
    expect(computeBackoffMs(4, noJitter)).toBe(135_000);
    expect(computeBackoffMs(5, noJitter)).toBe(BACKOFF_MAX_MS);
    expect(computeBackoffMs(50, noJitter)).toBe(BACKOFF_MAX_MS);
  });

  it('applies at most ±20% jitter', () => {
    expect(computeBackoffMs(1, () => 0)).toBe(4_000);
    expect(computeBackoffMs(1, () => 1)).toBe(6_000);
  });
});

// -------------------------------------------------------------------------
// Saving
// -------------------------------------------------------------------------
describe('savePendingResponse', () => {
  it('writes a v2 record with a stable clientResponseId and audio metadata', async () => {
    const record = await save();
    expect(record.version).toBe(2);
    expect(record.status).toBe('pending');
    expect(record.clientResponseId).toBe(record.id);
    expect(record.mimeType).toBe('audio/webm;codecs=opus');
    expect(record.audioSize).toBe('audio-bytes'.length);
    expect(record.attempts).toBe(0);
    expect(record.nextRetryAt).toBe(0);

    const stored = await getPendingResponse(record.id);
    expect(stored?.audioBlob).toBeInstanceOf(Blob);
    expect(await stored!.audioBlob.text()).toBe('audio-bytes');
  });

  it('stores an empty blob when no audio was captured', async () => {
    const record = await save({ audioBlob: null });
    expect(record.audioSize).toBe(0);
    expect(record.mimeType).toBe('application/octet-stream');
  });

  it('discards older not-yet-uploading recordings of the same question', async () => {
    const first = await save({ recordedAt: 1_000 });
    const otherQuestion = await save({ questionId: 'q2', recordedAt: 1_500 });
    const second = await save({ recordedAt: 2_000 });

    const ids = (await getAllPendingResponses()).map((r) => r.id).sort();
    expect(ids).toEqual([otherQuestion.id, second.id].sort());
    expect(await getPendingResponse(first.id)).toBeUndefined();
  });

  it('keeps an older recording that is currently uploading', async () => {
    const first = await save({ recordedAt: 1_000 });
    const claimed = await claimNextPendingResponse('tab-a', { now: 5_000 });
    expect(claimed?.id).toBe(first.id);

    await save({ recordedAt: 2_000 });
    expect(await getPendingResponsesCount()).toBe(2);
    expect((await getPendingResponse(first.id))?.status).toBe('uploading');
  });
});

// -------------------------------------------------------------------------
// Claim / lease / recovery
// -------------------------------------------------------------------------
describe('claimNextPendingResponse', () => {
  it('claims the oldest due record and leases it to the owner', async () => {
    const older = await save({ questionId: 'q1', recordedAt: 1_000 });
    await save({ questionId: 'q2', recordedAt: 2_000 });

    const claimed = await claimNextPendingResponse('tab-a', { now: 10_000, leaseMs: 60_000 });
    expect(claimed?.id).toBe(older.id);
    expect(claimed?.status).toBe('uploading');
    expect(claimed?.leaseOwner).toBe('tab-a');
    expect(claimed?.leaseUntil).toBe(70_000);
    expect(claimed?.lastAttemptAt).toBe(10_000);
  });

  it('never hands the same record to two owners while the lease is live', async () => {
    await save();
    const [a, b] = await Promise.all([
      claimNextPendingResponse('tab-a', { now: 10_000 }),
      claimNextPendingResponse('tab-b', { now: 10_000 }),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it('reclaims a record whose lease expired (interrupted upload)', async () => {
    await save();
    const first = await claimNextPendingResponse('tab-a', { now: 10_000, leaseMs: 1_000 });
    expect(first).not.toBeNull();

    expect(await claimNextPendingResponse('tab-b', { now: 10_500 })).toBeNull();
    const reclaimed = await claimNextPendingResponse('tab-b', { now: 11_001 });
    expect(reclaimed?.id).toBe(first!.id);
    expect(reclaimed?.leaseOwner).toBe('tab-b');
  });

  it('skips records whose retry time has not arrived', async () => {
    const r = await save();
    await claimNextPendingResponse('tab-a', { now: 10_000 });
    await markPendingResponseFailed(r.id, 'tab-a', { error: 'boom', retriable: true }, { now: 10_000, random: () => 0.5 });

    expect(await claimNextPendingResponse('tab-a', { now: 14_999 })).toBeNull();
    expect((await claimNextPendingResponse('tab-a', { now: 15_000 }))?.id).toBe(r.id);
  });

  it('never claims rejected records', async () => {
    const r = await save();
    await claimNextPendingResponse('tab-a', { now: 10_000 });
    await markPendingResponseFailed(r.id, 'tab-a', { error: 'not found', code: 'SESSION_NOT_FOUND', retriable: false });
    expect(await claimNextPendingResponse('tab-a', { now: Number.MAX_SAFE_INTEGER - 1 })).toBeNull();
  });

  it('can be limited to one session', async () => {
    await save({ sessionId: 's1', recordedAt: 1_000 });
    const s2 = await save({ sessionId: 's2', recordedAt: 2_000 });
    const claimed = await claimNextPendingResponse('tab-a', { now: 10_000, sessionId: 's2' });
    expect(claimed?.id).toBe(s2.id);
  });
});

describe('extendLease', () => {
  it('extends only for the current owner', async () => {
    const r = await save();
    await claimNextPendingResponse('tab-a', { now: 10_000, leaseMs: 1_000 });
    expect(await extendLease(r.id, 'tab-b', { now: 10_500, leaseMs: 1_000 })).toBe(false);
    expect(await extendLease(r.id, 'tab-a', { now: 10_500, leaseMs: 1_000 })).toBe(true);
    expect((await getPendingResponse(r.id))?.leaseUntil).toBe(11_500);
  });
});

describe('recoverInterruptedUploads', () => {
  it('returns expired uploads to pending and leaves live leases alone', async () => {
    const a = await save({ questionId: 'q1', recordedAt: 1_000 });
    const b = await save({ questionId: 'q2', recordedAt: 2_000 });
    await claimNextPendingResponse('tab-a', { now: 10_000, leaseMs: 1_000 }); // a
    await claimNextPendingResponse('tab-a', { now: 10_000, leaseMs: 100_000 }); // b

    expect(await recoverInterruptedUploads(20_000)).toBe(1);
    expect((await getPendingResponse(a.id))?.status).toBe('pending');
    expect((await getPendingResponse(a.id))?.leaseOwner).toBeUndefined();
    expect((await getPendingResponse(b.id))?.status).toBe('uploading');
  });
});

// -------------------------------------------------------------------------
// Failure / completion / user actions
// -------------------------------------------------------------------------
describe('markPendingResponseFailed', () => {
  it('schedules a retriable failure with backoff and clears the lease', async () => {
    const r = await save();
    await claimNextPendingResponse('tab-a', { now: 10_000 });
    const updated = await markPendingResponseFailed(
      r.id,
      'tab-a',
      { error: 'HTTP 503', code: 'HTTP_503', retriable: true },
      { now: 10_000, random: () => 0.5 }
    );
    expect(updated?.status).toBe('failed');
    expect(updated?.attempts).toBe(1);
    expect(updated?.nextRetryAt).toBe(15_000);
    expect(updated?.lastError).toBe('HTTP 503');
    expect(updated?.lastErrorCode).toBe('HTTP_503');
    expect(updated?.leaseOwner).toBeUndefined();
    expect(updated?.leaseUntil).toBeUndefined();
  });

  it('marks terminal failures as rejected', async () => {
    const r = await save();
    await claimNextPendingResponse('tab-a', { now: 10_000 });
    const updated = await markPendingResponseFailed(r.id, 'tab-a', {
      error: 'Question not found',
      code: 'QUESTION_NOT_FOUND',
      retriable: false,
    });
    expect(updated?.status).toBe('rejected');
    expect(updated?.nextRetryAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('does not clobber a record whose lease was taken over by another tab', async () => {
    const r = await save();
    await claimNextPendingResponse('tab-a', { now: 10_000, leaseMs: 1_000 });
    await claimNextPendingResponse('tab-b', { now: 12_000, leaseMs: 60_000 }); // tab-a's lease expired

    const result = await markPendingResponseFailed(r.id, 'tab-a', { error: 'late failure', retriable: true });
    expect(result?.status).toBe('uploading');
    expect(result?.leaseOwner).toBe('tab-b');
    expect(result?.attempts).toBe(0);
  });

  it('returns null for unknown ids', async () => {
    expect(await markPendingResponseFailed('nope', 'tab-a', { error: 'x', retriable: true })).toBeNull();
  });
});

describe('completePendingResponse / discardPendingResponse', () => {
  it('deletes the record and is idempotent', async () => {
    const r = await save();
    await completePendingResponse(r.id);
    await completePendingResponse(r.id);
    expect(await getPendingResponsesCount()).toBe(0);

    const d = await save();
    await discardPendingResponse(d.id);
    expect(await getPendingResponsesCount()).toBe(0);
  });
});

describe('retryPendingResponse / retryAllPendingResponses', () => {
  it('makes failed and rejected records due immediately, but not uploading ones', async () => {
    const failed = await save({ questionId: 'q1', recordedAt: 1_000 });
    const rejected = await save({ questionId: 'q2', recordedAt: 2_000 });
    const uploading = await save({ questionId: 'q3', recordedAt: 3_000 });

    await claimNextPendingResponse('tab-a', { now: 10_000 });
    await markPendingResponseFailed(failed.id, 'tab-a', { error: 'x', retriable: true }, { now: 10_000 });
    await claimNextPendingResponse('tab-a', { now: 10_000 });
    await markPendingResponseFailed(rejected.id, 'tab-a', { error: 'y', retriable: false }, { now: 10_000 });
    await claimNextPendingResponse('tab-a', { now: 10_000, leaseMs: 100_000 });

    expect(await retryPendingResponse(uploading.id)).toBe(false);
    expect(await retryPendingResponse(rejected.id)).toBe(true);
    expect((await getPendingResponse(rejected.id))?.status).toBe('pending');

    expect(await retryAllPendingResponses()).toBe(1); // only `failed` still needs it
    expect((await getPendingResponse(failed.id))?.nextRetryAt).toBe(0);
    expect((await getPendingResponse(uploading.id))?.status).toBe('uploading');
  });
});

describe('setPendingResponseChecksum', () => {
  it('stores the checksum', async () => {
    const r = await save();
    await setPendingResponseChecksum(r.id, 'abc');
    expect((await getPendingResponse(r.id))?.audioSha256).toBe('abc');
  });
});

// -------------------------------------------------------------------------
// Summary / scheduling helpers
// -------------------------------------------------------------------------
describe('getPendingSummary / getNextDueTime', () => {
  it('counts by status and flags records needing attention', async () => {
    const a = await save({ questionId: 'q1', recordedAt: 1_000 });
    const b = await save({ questionId: 'q2', recordedAt: 2_000 });
    await save({ questionId: 'q3', recordedAt: 3_000 });

    await claimNextPendingResponse('tab-a', { now: 10_000 });
    for (let i = 0; i < ATTENTION_AFTER_ATTEMPTS; i++) {
      await markPendingResponseFailed(a.id, 'tab-a', { error: 'x', retriable: true }, { now: 10_000, random: () => 0.5 });
    }
    await claimNextPendingResponse('tab-a', { now: 10_000 });
    await markPendingResponseFailed(b.id, 'tab-a', { error: 'y', retriable: false });

    const summary = await getPendingSummary();
    expect(summary).toEqual({
      total: 3,
      pending: 1,
      uploading: 0,
      failed: 1,
      rejected: 1,
      needsAttention: 2,
    });

    // The pending record is due now (0); failed one later; rejected never.
    expect(await getNextDueTime()).toBe(0);
  });

  it('reports the earliest retry time when nothing is due now', async () => {
    const r = await save();
    await claimNextPendingResponse('tab-a', { now: 10_000 });
    await markPendingResponseFailed(r.id, 'tab-a', { error: 'x', retriable: true }, { now: 10_000, random: () => 0.5 });
    expect(await getNextDueTime()).toBe(15_000);
  });

  it('returns null when only rejected records remain', async () => {
    const r = await save();
    await claimNextPendingResponse('tab-a', { now: 10_000 });
    await markPendingResponseFailed(r.id, 'tab-a', { error: 'x', retriable: false });
    expect(await getNextDueTime()).toBeNull();
  });
});

// -------------------------------------------------------------------------
// Migration of existing v1 records
// -------------------------------------------------------------------------
describe('v1 → v2 migration', () => {
  function v1Record(overrides: Partial<PendingResponseV1> = {}): PendingResponseV1 {
    return {
      id: 'q1-1700000000000',
      questionId: 'q1',
      sessionId: 's1',
      audioBlob: audio('legacy'),
      transcription: 'legacy transcript',
      durationSeconds: 30,
      recordedAt: 1_700_000_000_000,
      status: 'pending',
      retryCount: 0,
      ...overrides,
    };
  }

  it('migratePendingResponseV1 normalises every v1 status to pending', () => {
    for (const status of ['pending', 'syncing', 'synced', 'failed'] as const) {
      const migrated = migratePendingResponseV1(v1Record({ status, retryCount: 2, lastError: 'old' }));
      expect(migrated.status).toBe('pending');
      expect(migrated.version).toBe(2);
      expect(migrated.clientResponseId).toBe('q1-1700000000000');
      expect(migrated.attempts).toBe(2);
      expect(migrated.nextRetryAt).toBe(0);
      expect(migrated.lastError).toBe('old');
      expect(migrated.mimeType).toBe('audio/webm;codecs=opus');
      expect(migrated.audioSize).toBe('legacy'.length);
    }
  });

  it('upgrades a real v1 database in place, keeping audio and the original id', async () => {
    // Create a v1 database exactly as the previous build did.
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        const store = db.createObjectStore('pendingResponses', { keyPath: 'id' });
        store.createIndex('by-session', 'sessionId');
        store.createIndex('by-status', 'status');
        db.createObjectStore('cachedSessions', { keyPath: 'id' }).createIndex('by-updated', 'updatedAt');
        db.createObjectStore('cachedQuestions', { keyPath: 'id' }).createIndex('by-session', 'sessionId');
        const sync = db.createObjectStore('syncQueue', { keyPath: 'id' });
        sync.createIndex('by-created', 'createdAt');
        sync.createIndex('by-type', 'type');
      },
    });
    await v1.put('pendingResponses', v1Record({ id: 'a', status: 'pending' }));
    await v1.put('pendingResponses', v1Record({ id: 'b', questionId: 'q2', status: 'syncing', retryCount: 1 }));
    await v1.put('pendingResponses', v1Record({ id: 'c', questionId: 'q3', status: 'failed', retryCount: 3, lastError: 'HTTP 500' }));
    await v1.put('cachedSessions', { id: 's1', updatedAt: 1 });
    v1.close();

    // Opening through the app code triggers the upgrade.
    const records = (await getAllPendingResponses()).sort((a, b) => a.id.localeCompare(b.id));
    expect(records.map((r) => [r.id, r.status, r.attempts, r.version])).toEqual([
      ['a', 'pending', 0, 2],
      ['b', 'pending', 1, 2],
      ['c', 'pending', 3, 2],
    ]);
    expect(records[1].clientResponseId).toBe('b');
    expect(await records[1].audioBlob.text()).toBe('legacy');

    // The migrated records are immediately claimable.
    const claimed = await claimNextPendingResponse('tab-a', { now: Date.now() });
    expect(claimed).not.toBeNull();

    // Legacy stores survived and the version is bumped.
    closeOfflineDB();
    const raw = await openDB(DB_NAME, DB_VERSION);
    expect(raw.version).toBe(DB_VERSION);
    expect(Array.from(raw.objectStoreNames).sort()).toEqual(['cachedQuestions', 'cachedSessions', 'pendingResponses', 'syncQueue']);
    expect(await raw.count('cachedSessions')).toBe(1);
    raw.close();
  });

  it('by-session index still works for migrated records', async () => {
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        const store = db.createObjectStore('pendingResponses', { keyPath: 'id' });
        store.createIndex('by-session', 'sessionId');
        store.createIndex('by-status', 'status');
      },
    });
    await v1.put('pendingResponses', v1Record({ id: 'a', sessionId: 'sX' }));
    v1.close();

    const bySession = await getPendingResponsesBySession('sX');
    expect(bySession.map((r) => r.id)).toEqual(['a']);
  });
});
