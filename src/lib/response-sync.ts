// =========================================================================
// AI Tech Interview - Response Sync Engine
// Drains locally stored recordings (src/lib/offline-storage.ts) to the server.
//
//   claim (atomic) → upload → confirmed ? delete local : schedule retry
//
// The uploader is injectable so the engine can be tested without a network.
// =========================================================================

import {
  claimNextPendingResponse,
  completePendingResponse,
  extendLease,
  isOnline,
  markPendingResponseFailed,
  setPendingResponseChecksum,
  DEFAULT_LEASE_MS,
  type NewPendingResponseInput,
  type PendingResponse,
} from '@/lib/offline-storage';

// =========================================================================
// Types
// =========================================================================

export type UploadOutcome =
  | { confirmed: true; outcome: SyncAck['outcome']; responseId?: string }
  | { confirmed: false; retriable: boolean; error: string; code: string };

export type Uploader = (record: PendingResponse) => Promise<UploadOutcome>;

export interface SyncRunResult {
  synced: number;
  failed: number;
  errors: string[];
}

export type SyncProgressEvent =
  | { type: 'claimed'; record: PendingResponse }
  | { type: 'confirmed'; record: PendingResponse; outcome: SyncAck['outcome'] }
  | { type: 'failed'; record: PendingResponse; error: string; code: string; retriable: boolean };

export interface SyncRunOptions {
  /** Identifies the tab/engine holding leases. */
  owner?: string;
  uploader?: Uploader;
  /** Called after each state transition so the UI can update mid-run. */
  onProgress?: (event: SyncProgressEvent) => void;
  /** Restrict the run to one session (used right after a recording is saved). */
  sessionId?: string;
  /** Override for tests. */
  now?: () => number;
  /** Override for tests. */
  online?: () => boolean;
  leaseMs?: number;
  /** Safety valve: maximum records processed in one run. */
  maxRecords?: number;
}

// =========================================================================
// Default uploader (multipart POST to /api/responses/sync)
// =========================================================================

/**
 * Map an HTTP status to a retry decision. 5xx, 408 and 429 are transient;
 * other 4xx mean the request itself is wrong and retrying will not help.
 */
export function isRetriableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** Error codes from the server that are worth retrying even though they are 4xx. */
const RETRIABLE_ERROR_CODES = new Set(['AUDIO_CHECKSUM_MISMATCH']);

/** Shape of a successful /api/responses/sync acknowledgement. */
export interface SyncAck {
  outcome: 'created' | 'updated' | 'duplicate' | 'superseded';
  responseId: string;
  syncedAt: string;
  audio: { stored: boolean; bytes: number; sha256: string | null };
}

/**
 * Hex SHA-256 of a blob via Web Crypto. Returns null when SubtleCrypto is not
 * available (non-secure contexts); the server then falls back to a size check.
 */
export async function computeBlobSha256(blob: Blob): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

/**
 * Decide whether the server's acknowledgement proves that nothing is lost if
 * the local copy is deleted.
 *
 *   superseded → a newer answer already exists on the server; ours is obsolete
 *   no audio   → only the answer had to be saved
 *   otherwise  → the server must report stored audio matching our checksum
 *                (or our byte size when no checksum could be computed)
 */
export function isUploadConfirmed(
  record: Pick<PendingResponse, 'audioSize' | 'audioSha256'>,
  ack: SyncAck
): boolean {
  if (ack.outcome === 'superseded') return true;
  if (record.audioSize === 0) return true;
  if (!ack.audio?.stored) return false;
  if (record.audioSha256) return ack.audio.sha256 === record.audioSha256;
  return ack.audio.bytes === record.audioSize;
}

function buildFormData(record: PendingResponse, audioSha256: string | null): FormData {
  const formData = new FormData();
  formData.append('audio', record.audioBlob, 'response.webm');
  formData.append('questionId', record.questionId);
  formData.append('sessionId', record.sessionId);
  formData.append('durationSeconds', String(record.durationSeconds));
  formData.append('clientResponseId', record.clientResponseId);
  formData.append('recordedAt', String(record.recordedAt));
  formData.append('audioMimeType', record.mimeType);
  formData.append('recordedOffline', record.recordedOffline ? 'true' : 'false');
  if (audioSha256) {
    formData.append('audioSha256', audioSha256);
  }
  if (record.transcription) {
    formData.append('transcription', record.transcription);
  }
  return formData;
}

/**
 * Upload one record to the sync endpoint and interpret the acknowledgement.
 * A 2xx without a verifiable audio acknowledgement is NOT a confirmation.
 */
export const defaultUploader: Uploader = async (record) => {
  const audioSha256 = record.audioSize > 0 ? await computeBlobSha256(record.audioBlob) : null;
  if (audioSha256 && audioSha256 !== record.audioSha256) {
    await setPendingResponseChecksum(record.id, audioSha256).catch(() => undefined);
  }
  const recordWithChecksum = { ...record, audioSha256: audioSha256 ?? undefined };

  let response: Response;
  try {
    response = await fetch('/api/responses/sync', {
      method: 'POST',
      body: buildFormData(record, audioSha256),
    });
  } catch (error) {
    return {
      confirmed: false,
      retriable: true,
      error: error instanceof Error ? error.message : 'Network error',
      code: 'NETWORK',
    };
  }

  let json: { success?: boolean; data?: SyncAck; error?: { code?: string; message?: string } } | null = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (response.ok) {
    const ack = json?.success ? json.data : undefined;
    if (!ack || !ack.outcome) {
      return {
        confirmed: false,
        retriable: true,
        error: 'Server did not acknowledge the upload',
        code: 'UNCONFIRMED_ACK',
      };
    }
    if (!isUploadConfirmed(recordWithChecksum, ack)) {
      return {
        confirmed: false,
        retriable: true,
        error: 'Server saved the answer but did not confirm the audio',
        code: 'AUDIO_NOT_CONFIRMED',
      };
    }
    return { confirmed: true, outcome: ack.outcome, responseId: ack.responseId };
  }

  const message = json?.error?.message ?? `HTTP ${response.status}`;
  const code = json?.error?.code ?? `HTTP_${response.status}`;
  return {
    confirmed: false,
    retriable: isRetriableStatus(response.status) || RETRIABLE_ERROR_CODES.has(code),
    error: message,
    code,
  };
};

/**
 * Fallback for environments where IndexedDB is unavailable: upload straight
 * from memory, once, with the same idempotent protocol. Nothing is retried
 * because nothing could be stored.
 */
export async function uploadWithoutStorage(
  input: NewPendingResponseInput,
  uploader: Uploader = defaultUploader
): Promise<UploadOutcome> {
  const blob = input.audioBlob ?? new Blob();
  const id =
    input.id ??
    (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
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
    status: 'uploading',
    attempts: 0,
    nextRetryAt: 0,
    version: 2,
  };
  return uploader(record);
}

// =========================================================================
// Engine
// =========================================================================

let defaultOwner: string | null = null;

/**
 * Stable id for this tab/engine instance (used as the lease owner).
 */
export function getSyncOwnerId(): string {
  if (!defaultOwner) {
    defaultOwner =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `tab-${crypto.randomUUID()}`
        : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return defaultOwner;
}

/**
 * Process every record that is due right now. Records that fail are
 * rescheduled with backoff and are not retried within the same run.
 */
export async function syncPendingData(options: SyncRunOptions = {}): Promise<SyncRunResult> {
  const owner = options.owner ?? getSyncOwnerId();
  const uploader = options.uploader ?? defaultUploader;
  const now = options.now ?? Date.now;
  const online = options.online ?? isOnline;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxRecords = options.maxRecords ?? 500;

  const result: SyncRunResult = { synced: 0, failed: 0, errors: [] };
  if (!online()) return result;

  const seen = new Set<string>();

  for (let i = 0; i < maxRecords; i++) {
    const record = await claimNextPendingResponse(owner, {
      now: now(),
      leaseMs,
      sessionId: options.sessionId,
    });
    if (!record || seen.has(record.id)) break;
    seen.add(record.id);
    options.onProgress?.({ type: 'claimed', record });

    // Keep the lease alive for long uploads so other tabs do not reclaim it.
    const heartbeat = setInterval(() => {
      extendLease(record.id, owner, { now: now(), leaseMs }).catch(() => undefined);
    }, Math.max(1_000, Math.floor(leaseMs / 3)));

    let outcome: UploadOutcome;
    try {
      outcome = await uploader(record);
    } catch (error) {
      outcome = {
        confirmed: false,
        retriable: true,
        error: error instanceof Error ? error.message : 'Unknown error',
        code: 'UPLOAD_EXCEPTION',
      };
    } finally {
      clearInterval(heartbeat);
    }

    if (outcome.confirmed) {
      await completePendingResponse(record.id);
      result.synced += 1;
      options.onProgress?.({ type: 'confirmed', record, outcome: outcome.outcome });
    } else {
      await markPendingResponseFailed(
        record.id,
        owner,
        { error: outcome.error, code: outcome.code, retriable: outcome.retriable },
        { now: now() }
      );
      result.failed += 1;
      result.errors.push(`Response ${record.id}: ${outcome.error}`);
      options.onProgress?.({ type: 'failed', record, error: outcome.error, code: outcome.code, retriable: outcome.retriable });
    }

    if (!online()) break;
  }

  return result;
}
