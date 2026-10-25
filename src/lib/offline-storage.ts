// =========================================================================
// AI Tech Interview - Offline Storage with IndexedDB
// Uses 'idb' library for promise-based IndexedDB access
//
// This module owns the durable, local copy of every recorded answer.
// A recording is written here BEFORE any upload is attempted, and it is only
// deleted after the server confirms that both the answer and its audio were
// persisted (see src/lib/response-sync.ts).
//
// Record lifecycle
//   pending ──claim──▶ uploading ──confirmed──▶ (deleted)
//      ▲                   │
//      │   retriable error │ (attempts++, nextRetryAt = now + backoff)
//      └──── failed ◀──────┤
//                          │ terminal error (4xx)
//                       rejected   (kept so the user can retry or discard)
//
// All state transitions happen inside a single IndexedDB readwrite
// transaction, so they are atomic even when several tabs share the database.
// =========================================================================

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';

// =========================================================================
// Type Definitions
// =========================================================================

export type PendingResponseStatus = 'pending' | 'uploading' | 'failed' | 'rejected';

/**
 * A recorded answer that still has to be confirmed by the server.
 */
export interface PendingResponse {
  /** Local primary key. Equal to clientResponseId for records created by v2. */
  id: string;
  /** Idempotency key sent with every upload attempt. Never changes. */
  clientResponseId: string;
  questionId: string;
  sessionId: string;
  audioBlob: Blob;
  /** MIME type of audioBlob (e.g. audio/webm;codecs=opus). */
  mimeType: string;
  /** Byte size of audioBlob, stored so the summary does not need to read blobs. */
  audioSize: number;
  /** Hex SHA-256 of audioBlob, computed before the first upload attempt. */
  audioSha256?: string;
  transcription?: string;
  durationSeconds: number;
  /** Client timestamp (ms) when the recording finished. Used for ordering on the server. */
  recordedAt: number;
  /** True when the browser was offline at recording time (informational). */
  recordedOffline?: boolean;
  status: PendingResponseStatus;
  /** Number of upload attempts that have finished (success or failure). */
  attempts: number;
  lastAttemptAt?: number;
  /** Earliest time (ms) the record may be claimed again. 0 = immediately. */
  nextRetryAt: number;
  lastError?: string;
  /** Machine-readable error code from the last attempt (HTTP_500, NETWORK, SESSION_NOT_FOUND, ...). */
  lastErrorCode?: string;
  /** Tab/engine id that currently holds the upload lease. */
  leaseOwner?: string;
  /** Lease expiry (ms). An 'uploading' record with an expired lease is reclaimable. */
  leaseUntil?: number;
  /** Schema version of this record. */
  version: 2;
}

/**
 * Shape of records written by the v1 storage code. Kept for the migration.
 */
export interface PendingResponseV1 {
  id: string;
  questionId: string;
  sessionId: string;
  audioBlob: Blob;
  transcription?: string;
  durationSeconds: number;
  recordedAt: number;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  retryCount: number;
  lastError?: string;
}

export interface NewPendingResponseInput {
  questionId: string;
  sessionId: string;
  audioBlob: Blob | null;
  transcription?: string;
  durationSeconds: number;
  recordedAt?: number;
  recordedOffline?: boolean;
  /** Optional explicit id (defaults to a fresh UUID). */
  id?: string;
}

export interface PendingSummary {
  total: number;
  pending: number;
  uploading: number;
  failed: number;
  rejected: number;
  /** Records that failed repeatedly and probably need the user's attention. */
  needsAttention: number;
}

export interface FailureInput {
  error: string;
  code?: string;
  /** false → the record becomes 'rejected' and is not retried automatically. */
  retriable: boolean;
}

// Legacy stores (no longer used by the app). They are kept in the schema so an
// upgrade never drops data that an older build may have written.
interface LegacyCachedSession {
  id: string;
  updatedAt: number;
}
interface LegacyCachedQuestion {
  id: string;
  sessionId: string;
}
interface LegacySyncQueueItem {
  id: string;
  type: string;
  createdAt: number;
}

interface OfflineDB extends DBSchema {
  pendingResponses: {
    key: string;
    value: PendingResponse;
    indexes: {
      'by-session': string;
      'by-status': string;
    };
  };
  cachedSessions: {
    key: string;
    value: LegacyCachedSession;
    indexes: { 'by-updated': number };
  };
  cachedQuestions: {
    key: string;
    value: LegacyCachedQuestion;
    indexes: { 'by-session': string };
  };
  syncQueue: {
    key: string;
    value: LegacySyncQueueItem;
    indexes: { 'by-created': number; 'by-type': string };
  };
}

// =========================================================================
// Constants & policies
// =========================================================================

export const DB_NAME = 'ai-interview-offline';
export const DB_VERSION = 2;

/** How long a claimed record stays leased to one tab before others may reclaim it. */
export const DEFAULT_LEASE_MS = 60_000;
/** Backoff: 5s, 15s, 45s, 2m15s, then capped at 5 minutes. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_FACTOR = 3;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** After this many failed attempts the UI flags the record as needing attention. */
export const ATTENTION_AFTER_ATTEMPTS = 5;

/**
 * Exponential backoff with ±20% jitter. `attempts` is the number of attempts
 * that have already failed (>= 1).
 */
export function computeBackoffMs(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempts - 1);
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, exponent));
  const jitter = 1 + (random() * 2 - 1) * 0.2;
  return Math.round(base * jitter);
}

// =========================================================================
// Database Initialization
// =========================================================================

let dbPromise: Promise<IDBPDatabase<OfflineDB>> | null = null;

export function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * Migrate a v1 record in place. Exported for tests.
 */
export function migratePendingResponseV1(record: PendingResponseV1): PendingResponse {
  const blob = record.audioBlob instanceof Blob ? record.audioBlob : new Blob();
  return {
    id: record.id,
    clientResponseId: record.id,
    questionId: record.questionId,
    sessionId: record.sessionId,
    audioBlob: blob,
    mimeType: blob.type || 'application/octet-stream',
    audioSize: blob.size,
    transcription: record.transcription,
    durationSeconds: record.durationSeconds,
    recordedAt: record.recordedAt,
    // v1 never retried 'failed' records and left interrupted uploads at
    // 'syncing' forever. Every old record becomes claimable again; the server
    // is idempotent so re-uploading is safe.
    status: 'pending',
    attempts: record.retryCount ?? 0,
    nextRetryAt: 0,
    lastError: record.lastError,
    version: 2,
  };
}

async function migrateV1Records(
  tx: IDBPTransaction<OfflineDB, ('pendingResponses' | 'cachedSessions' | 'cachedQuestions' | 'syncQueue')[], 'versionchange'>
): Promise<void> {
  const store = tx.objectStore('pendingResponses');
  let cursor = await store.openCursor();
  while (cursor) {
    const value = cursor.value as unknown as PendingResponseV1 | PendingResponse;
    if ((value as PendingResponse).version !== 2) {
      await cursor.update(migratePendingResponseV1(value as PendingResponseV1));
    }
    cursor = await cursor.continue();
  }
}

function getDB(): Promise<IDBPDatabase<OfflineDB>> {
  if (!isIndexedDBAvailable()) {
    return Promise.reject(new Error('IndexedDB is not available in this environment'));
  }

  if (!dbPromise) {
    dbPromise = openDB<OfflineDB>(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains('pendingResponses')) {
          const responseStore = db.createObjectStore('pendingResponses', { keyPath: 'id' });
          responseStore.createIndex('by-session', 'sessionId');
          responseStore.createIndex('by-status', 'status');
        }
        if (!db.objectStoreNames.contains('cachedSessions')) {
          const sessionStore = db.createObjectStore('cachedSessions', { keyPath: 'id' });
          sessionStore.createIndex('by-updated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('cachedQuestions')) {
          const questionStore = db.createObjectStore('cachedQuestions', { keyPath: 'id' });
          questionStore.createIndex('by-session', 'sessionId');
        }
        if (!db.objectStoreNames.contains('syncQueue')) {
          const syncStore = db.createObjectStore('syncQueue', { keyPath: 'id' });
          syncStore.createIndex('by-created', 'createdAt');
          syncStore.createIndex('by-type', 'type');
        }

        if (oldVersion > 0 && oldVersion < 2) {
          await migrateV1Records(tx);
        }
      },
      blocked() {
        console.warn('[offline-storage] upgrade blocked by another open tab');
      },
      blocking() {
        // Another tab wants to upgrade: release our connection so it can.
        closeOfflineDB();
      },
      terminated() {
        dbPromise = null;
      },
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }

  return dbPromise;
}

/**
 * Close the cached connection (used when another tab upgrades, and by tests).
 */
export function closeOfflineDB(): void {
  const pending = dbPromise;
  dbPromise = null;
  if (pending) {
    pending.then((db) => db.close()).catch(() => undefined);
  }
}

// =========================================================================
// Helpers
// =========================================================================

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function isClaimable(record: PendingResponse, now: number): boolean {
  if (record.status === 'pending' || record.status === 'failed') {
    return record.nextRetryAt <= now;
  }
  if (record.status === 'uploading') {
    return (record.leaseUntil ?? 0) < now; // lease expired → interrupted upload
  }
  return false;
}

// =========================================================================
// Pending Responses: write & read
// =========================================================================

/**
 * Durably save a recording before any upload is attempted.
 *
 * Older local records for the same question that have not started uploading
 * are discarded: the newer recording supersedes them, and the server applies
 * the same rule with `recordedAt`.
 */
export async function savePendingResponse(input: NewPendingResponseInput): Promise<PendingResponse> {
  const db = await getDB();
  const blob = input.audioBlob ?? new Blob();
  const id = input.id ?? newId();
  const record: PendingResponse = {
    id,
    clientResponseId: id,
    questionId: input.questionId,
    sessionId: input.sessionId,
    audioBlob: blob,
    mimeType: blob.type || 'application/octet-stream',
    audioSize: blob.size,
    transcription: input.transcription,
    durationSeconds: input.durationSeconds,
    recordedAt: input.recordedAt ?? Date.now(),
    recordedOffline: input.recordedOffline ?? false,
    status: 'pending',
    attempts: 0,
    nextRetryAt: 0,
    version: 2,
  };

  const tx = db.transaction('pendingResponses', 'readwrite');
  const existing = await tx.store.index('by-session').getAll(input.sessionId);
  for (const other of existing) {
    if (
      other.questionId === input.questionId &&
      other.id !== id &&
      other.status !== 'uploading' &&
      other.recordedAt <= record.recordedAt
    ) {
      await tx.store.delete(other.id);
    }
  }
  await tx.store.put(record);
  await tx.done;
  return record;
}

export async function getPendingResponse(id: string): Promise<PendingResponse | undefined> {
  const db = await getDB();
  return db.get('pendingResponses', id);
}

/**
 * All locally stored responses, regardless of status.
 */
export async function getAllPendingResponses(): Promise<PendingResponse[]> {
  const db = await getDB();
  return db.getAll('pendingResponses');
}

export async function getPendingResponsesBySession(sessionId: string): Promise<PendingResponse[]> {
  const db = await getDB();
  return db.getAllFromIndex('pendingResponses', 'by-session', sessionId);
}

export function summarizePendingResponses(records: PendingResponse[]): PendingSummary {
  const summary: PendingSummary = {
    total: records.length,
    pending: 0,
    uploading: 0,
    failed: 0,
    rejected: 0,
    needsAttention: 0,
  };
  for (const r of records) {
    summary[r.status] += 1;
    if (r.status === 'rejected' || (r.status === 'failed' && r.attempts >= ATTENTION_AFTER_ATTEMPTS)) {
      summary.needsAttention += 1;
    }
  }
  return summary;
}

export async function getPendingSummary(): Promise<PendingSummary> {
  return summarizePendingResponses(await getAllPendingResponses());
}

/**
 * Number of answers that are not yet confirmed by the server.
 */
export async function getPendingResponsesCount(): Promise<number> {
  const db = await getDB();
  return db.count('pendingResponses');
}

// =========================================================================
// Pending Responses: upload lifecycle (atomic transitions)
// =========================================================================

/**
 * Atomically claim the next record that is due for upload.
 *
 * Eligible: 'pending'/'failed' with nextRetryAt <= now, or 'uploading' whose
 * lease expired (the owning tab crashed or was closed mid-upload). The claim
 * and the status change happen in one readwrite transaction, so two tabs can
 * never claim the same record.
 *
 * Returns the claimed record (now 'uploading') or null when nothing is due.
 */
export async function claimNextPendingResponse(
  owner: string,
  options: { now?: number; leaseMs?: number; sessionId?: string } = {}
): Promise<PendingResponse | null> {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const db = await getDB();
  const tx = db.transaction('pendingResponses', 'readwrite');
  const records = options.sessionId
    ? await tx.store.index('by-session').getAll(options.sessionId)
    : await tx.store.getAll();

  // Oldest recording first so answers arrive in the order they were given.
  const candidate = records
    .filter((r) => isClaimable(r, now))
    .sort((a, b) => a.recordedAt - b.recordedAt)[0];

  if (!candidate) {
    await tx.done;
    return null;
  }

  const claimed: PendingResponse = {
    ...candidate,
    status: 'uploading',
    leaseOwner: owner,
    leaseUntil: now + leaseMs,
    lastAttemptAt: now,
  };
  await tx.store.put(claimed);
  await tx.done;
  return claimed;
}

/**
 * Extend the lease of a record while a long upload is in progress.
 * Returns false if the record is gone or is no longer owned by `owner`.
 */
export async function extendLease(
  id: string,
  owner: string,
  options: { now?: number; leaseMs?: number } = {}
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const db = await getDB();
  const tx = db.transaction('pendingResponses', 'readwrite');
  const record = await tx.store.get(id);
  if (!record || record.status !== 'uploading' || record.leaseOwner !== owner) {
    await tx.done;
    return false;
  }
  await tx.store.put({ ...record, leaseUntil: now + leaseMs });
  await tx.done;
  return true;
}

/**
 * Persist the audio checksum once it has been computed (before first upload).
 */
export async function setPendingResponseChecksum(id: string, audioSha256: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('pendingResponses', 'readwrite');
  const record = await tx.store.get(id);
  if (record && record.audioSha256 !== audioSha256) {
    await tx.store.put({ ...record, audioSha256 });
  }
  await tx.done;
}

/**
 * The server confirmed the answer AND its audio: the local copy can go.
 * Safe to call more than once.
 */
export async function completePendingResponse(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('pendingResponses', id);
}

/**
 * Record a failed attempt. Retriable failures are rescheduled with backoff;
 * terminal failures become 'rejected' and wait for the user.
 *
 * If the lease was taken over by another tab in the meantime the record is
 * left untouched (that tab owns the outcome now).
 */
export async function markPendingResponseFailed(
  id: string,
  owner: string,
  failure: FailureInput,
  options: { now?: number; random?: () => number } = {}
): Promise<PendingResponse | null> {
  const now = options.now ?? Date.now();
  const db = await getDB();
  const tx = db.transaction('pendingResponses', 'readwrite');
  const record = await tx.store.get(id);
  if (!record) {
    await tx.done;
    return null;
  }
  if (record.status === 'uploading' && record.leaseOwner && record.leaseOwner !== owner) {
    await tx.done;
    return record;
  }
  const attempts = record.attempts + 1;
  const updated: PendingResponse = {
    ...record,
    status: failure.retriable ? 'failed' : 'rejected',
    attempts,
    lastAttemptAt: now,
    nextRetryAt: failure.retriable ? now + computeBackoffMs(attempts, options.random) : Number.MAX_SAFE_INTEGER,
    lastError: failure.error,
    lastErrorCode: failure.code,
    leaseOwner: undefined,
    leaseUntil: undefined,
  };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

/**
 * Make a record claimable right now (user pressed "Retry"). Works for
 * 'failed' and 'rejected' records; 'uploading' records are left alone.
 */
export async function retryPendingResponse(id: string): Promise<boolean> {
  const db = await getDB();
  const tx = db.transaction('pendingResponses', 'readwrite');
  const record = await tx.store.get(id);
  if (!record || record.status === 'uploading') {
    await tx.done;
    return false;
  }
  await tx.store.put({ ...record, status: 'pending', nextRetryAt: 0 });
  await tx.done;
  return true;
}

/**
 * Make every failed/rejected record claimable right now. Returns how many changed.
 */
export async function retryAllPendingResponses(): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('pendingResponses', 'readwrite');
  const records = await tx.store.getAll();
  let changed = 0;
  for (const record of records) {
    if (record.status === 'failed' || record.status === 'rejected') {
      await tx.store.put({ ...record, status: 'pending', nextRetryAt: 0 });
      changed += 1;
    }
  }
  await tx.done;
  return changed;
}

/**
 * Drop a local record without uploading it (user chose to discard).
 */
export async function discardPendingResponse(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('pendingResponses', id);
}

/**
 * Return 'uploading' records with an expired lease to 'pending'. Called on
 * startup so an interrupted upload is visible as pending immediately instead
 * of only when the next claim runs.
 */
export async function recoverInterruptedUploads(now: number = Date.now()): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('pendingResponses', 'readwrite');
  const records = await tx.store.index('by-status').getAll('uploading');
  let recovered = 0;
  for (const record of records) {
    if ((record.leaseUntil ?? 0) < now) {
      await tx.store.put({ ...record, status: 'pending', leaseOwner: undefined, leaseUntil: undefined });
      recovered += 1;
    }
  }
  await tx.done;
  return recovered;
}

/**
 * Earliest moment anything in `records` becomes due (retry time, or lease
 * expiry of an interrupted upload), or null when nothing is waiting.
 */
export function computeNextDueTime(
  records: Array<Pick<PendingResponse, 'status' | 'nextRetryAt' | 'leaseUntil'>>
): number | null {
  let next: number | null = null;
  for (const r of records) {
    let due: number | null = null;
    if (r.status === 'pending' || r.status === 'failed') due = r.nextRetryAt;
    else if (r.status === 'uploading') due = (r.leaseUntil ?? 0) + 1;
    if (due !== null && (next === null || due < next)) next = due;
  }
  return next;
}

/**
 * Earliest due time across the stored records, or null.
 */
export async function getNextDueTime(): Promise<number | null> {
  return computeNextDueTime(await getAllPendingResponses());
}

// =========================================================================
// Network Status Utilities
// =========================================================================

/**
 * Check if the browser is online
 */
export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

/**
 * Listen for online/offline events
 */
export function onNetworkChange(callback: (isOnline: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleOnline = () => callback(true);
  const handleOffline = () => callback(false);

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
