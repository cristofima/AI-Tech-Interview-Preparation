// =========================================================================
// AI Tech Interview - Response Submission (server side)
// Idempotent, order-aware persistence of a recorded answer and its audio.
//
// Policy (one QuestionResponse row per (questionId, sessionId)):
//   • same clientResponseId as the stored row      → 'duplicate'   (no rewrite; backfill audio if missing)
//   • stored row recorded later than the incoming  → 'superseded'  (nothing overwritten)
//   • no stored row                                → 'created'
//   • otherwise (incoming is newer)                → 'updated'     (stale evaluation removed)
//
// Audio is stored in question_responses.audio_blob together with its MIME
// type, size and SHA-256. The checksum is verified against the one the client
// sent, and echoed back so the client can decide whether its local copy may
// be deleted.
//
// Concurrency: the whole decision runs inside one transaction that holds a
// PostgreSQL advisory lock keyed on (sessionId, questionId), so two retries of
// the same answer (e.g. from two tabs) are serialised and the second one sees
// the first one's row.
// =========================================================================

import { createHash, randomUUID } from 'node:crypto';

// =========================================================================
// Constants
// =========================================================================

/** Upper bound for one recording. 10 minutes of Opus at 64 kbps is ~5 MB. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// =========================================================================
// Types
// =========================================================================

export type SubmissionOutcome = 'created' | 'updated' | 'duplicate' | 'superseded';

export interface SubmissionAudio {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  sha256: string;
}

export interface SubmissionInput {
  questionId: string;
  sessionId: string;
  clientResponseId: string;
  recordedAt: Date;
  transcription?: string;
  durationSeconds: number | null;
  audio: SubmissionAudio | null;
  recordedOffline: boolean;
  /** True when the client did not send clientResponseId/recordedAt (pre-v2 client). */
  legacyClient: boolean;
}

export interface SubmissionAudioAck {
  /** True only when audio bytes for this row are persisted on the server. */
  stored: boolean;
  bytes: number;
  sha256: string | null;
}

export interface SubmissionResult {
  outcome: SubmissionOutcome;
  responseId: string;
  syncedAt: string;
  audio: SubmissionAudioAck;
}

export class SubmissionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SubmissionError';
  }
}

/** The columns the decision needs. `audioBlob` is deliberately not selected. */
export interface ExistingResponseRow {
  id: string;
  clientResponseId: string | null;
  recordedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  audioSizeBytes: number | null;
  audioSha256: string | null;
}

const existingSelect = {
  id: true,
  clientResponseId: true,
  recordedAt: true,
  completedAt: true,
  createdAt: true,
  audioSizeBytes: true,
  audioSha256: true,
} as const;

/**
 * Narrow view of the Prisma transaction client used by submitResponse.
 * The real PrismaClient satisfies it structurally; tests use an in-memory fake.
 */
export interface SubmissionTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  interviewSession: {
    findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null>;
  };
  interviewQuestion: {
    findFirst(args: { where: { id: string; sessionId: string }; select: { id: true } }): Promise<{ id: string } | null>;
  };
  questionResponse: {
    findUnique(args: {
      where: { questionId_sessionId: { questionId: string; sessionId: string } };
      select: typeof existingSelect;
    }): Promise<ExistingResponseRow | null>;
    create(args: { data: ResponseWriteData & { questionId: string; sessionId: string }; select: { id: true; completedAt: true } }): Promise<{
      id: string;
      completedAt: Date | null;
    }>;
    update(args: { where: { id: string }; data: Partial<ResponseWriteData>; select: { id: true; completedAt: true } }): Promise<{
      id: string;
      completedAt: Date | null;
    }>;
  };
  responseEvaluation: {
    deleteMany(args: { where: { responseId: string } }): Promise<{ count: number }>;
  };
}

/**
 * Runs `fn` inside a database transaction. With Prisma:
 *   const run: TransactionRunner = (fn) => prisma.$transaction(fn);
 */
export type TransactionRunner = <R>(fn: (tx: SubmissionTx) => Promise<R>) => Promise<R>;

export interface ResponseWriteData {
  clientResponseId: string;
  recordedAt: Date;
  transcription: string | null;
  durationSeconds: number | null;
  audioBlob: Uint8Array<ArrayBuffer> | null;
  audioMimeType: string | null;
  audioSizeBytes: number | null;
  audioSha256: string | null;
  status: string;
  isOffline: boolean;
  syncedAt: Date;
  startedAt?: Date;
  completedAt: Date;
}

// =========================================================================
// Helpers
// =========================================================================

export function sha256Hex(bytes: Uint8Array<ArrayBuffer>): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Effective recording time of a stored row. Rows written by older builds have
 * no recordedAt, so fall back to when they were completed/created.
 */
export function effectiveRecordedAt(row: Pick<ExistingResponseRow, 'recordedAt' | 'completedAt' | 'createdAt'>): Date {
  return row.recordedAt ?? row.completedAt ?? row.createdAt;
}

/**
 * Pure decision: what should happen to the stored row for this question?
 */
export function decideSubmission(
  existing: ExistingResponseRow | null,
  incoming: { clientResponseId: string; recordedAt: Date }
): 'create' | 'duplicate' | 'superseded' | 'update' {
  if (!existing) return 'create';
  if (existing.clientResponseId !== null && existing.clientResponseId === incoming.clientResponseId) {
    return 'duplicate';
  }
  if (effectiveRecordedAt(existing).getTime() > incoming.recordedAt.getTime()) {
    return 'superseded';
  }
  return 'update';
}

function audioAck(row: { audioSizeBytes: number | null; audioSha256: string | null }): SubmissionAudioAck {
  return {
    stored: row.audioSha256 !== null,
    bytes: row.audioSizeBytes ?? 0,
    sha256: row.audioSha256,
  };
}

function audioColumns(audio: SubmissionAudio | null) {
  return {
    audioBlob: audio ? audio.bytes : null,
    audioMimeType: audio ? audio.mimeType : null,
    audioSizeBytes: audio ? audio.bytes.byteLength : null,
    audioSha256: audio ? audio.sha256 : null,
  };
}

// =========================================================================
// Request parsing
// =========================================================================

/**
 * Validate and normalise a multipart sync request. Throws SubmissionError
 * with a 4xx status for client errors.
 */
export async function parseSyncFormData(formData: FormData): Promise<SubmissionInput> {
  const questionId = stringField(formData, 'questionId');
  const sessionId = stringField(formData, 'sessionId');
  if (!questionId || !sessionId) {
    throw new SubmissionError(400, 'INVALID_REQUEST', 'Missing required fields: questionId, sessionId');
  }

  const transcription = stringField(formData, 'transcription') || undefined;
  const durationRaw = stringField(formData, 'durationSeconds');
  const durationParsed = durationRaw ? parseInt(durationRaw, 10) : NaN;
  const durationSeconds = Number.isFinite(durationParsed) && durationParsed >= 0 ? durationParsed : null;

  let clientResponseId = stringField(formData, 'clientResponseId');
  const recordedAtRaw = stringField(formData, 'recordedAt');
  const legacyClient = !clientResponseId;
  if (!clientResponseId) {
    clientResponseId = `legacy-${randomUUID()}`;
  } else if (clientResponseId.length > 128) {
    throw new SubmissionError(400, 'INVALID_REQUEST', 'clientResponseId is too long');
  }

  let recordedAt: Date;
  if (recordedAtRaw) {
    const ms = Number(recordedAtRaw);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new SubmissionError(400, 'INVALID_REQUEST', 'recordedAt must be a unix timestamp in milliseconds');
    }
    recordedAt = new Date(ms);
  } else {
    recordedAt = new Date();
  }

  const recordedOffline = stringField(formData, 'recordedOffline') === 'true';

  const audioEntry = formData.get('audio');
  let audio: SubmissionAudio | null = null;
  if (audioEntry !== null && typeof audioEntry !== 'string') {
    const file = audioEntry as Blob;
    if (file.size > MAX_AUDIO_BYTES) {
      throw new SubmissionError(413, 'AUDIO_TOO_LARGE', `Audio exceeds ${MAX_AUDIO_BYTES} bytes`);
    }
    if (file.size > 0) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = sha256Hex(bytes);
      const claimed = stringField(formData, 'audioSha256');
      if (claimed && claimed.toLowerCase() !== sha256) {
        throw new SubmissionError(400, 'AUDIO_CHECKSUM_MISMATCH', 'Uploaded audio does not match the declared checksum');
      }
      const mimeType = stringField(formData, 'audioMimeType') || file.type || 'application/octet-stream';
      audio = { bytes, mimeType, sha256 };
    }
  }

  return {
    questionId,
    sessionId,
    clientResponseId,
    recordedAt,
    transcription,
    durationSeconds,
    audio,
    recordedOffline,
    legacyClient,
  };
}

function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

// =========================================================================
// Persistence
// =========================================================================

/**
 * Persist the submission. Throws SubmissionError(404) when the session or
 * question does not exist.
 */
export async function submitResponse(runInTransaction: TransactionRunner, input: SubmissionInput): Promise<SubmissionResult> {
  return runInTransaction(async (tx) => {
    // Serialise concurrent submissions for the same question.
    const lockKey = `${input.sessionId}:${input.questionId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const session = await tx.interviewSession.findUnique({ where: { id: input.sessionId }, select: { id: true } });
    if (!session) {
      throw new SubmissionError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }
    const question = await tx.interviewQuestion.findFirst({
      where: { id: input.questionId, sessionId: input.sessionId },
      select: { id: true },
    });
    if (!question) {
      throw new SubmissionError(404, 'QUESTION_NOT_FOUND', 'Question not found in this session');
    }

    const existing = await tx.questionResponse.findUnique({
      where: { questionId_sessionId: { questionId: input.questionId, sessionId: input.sessionId } },
      select: existingSelect,
    });

    const decision = decideSubmission(existing, input);
    const now = new Date();

    if (decision === 'duplicate' && existing) {
      // A retry after a lost acknowledgement. Do not rewrite the answer; only
      // fill in audio if the first attempt could not store it.
      let audioRow: { audioSizeBytes: number | null; audioSha256: string | null } = existing;
      if (existing.audioSha256 === null && input.audio) {
        await tx.questionResponse.update({
          where: { id: existing.id },
          data: audioColumns(input.audio),
          select: { id: true, completedAt: true },
        });
        audioRow = { audioSizeBytes: input.audio.bytes.byteLength, audioSha256: input.audio.sha256 };
      }
      return {
        outcome: 'duplicate',
        responseId: existing.id,
        syncedAt: (existing.completedAt ?? now).toISOString(),
        audio: audioAck(audioRow),
      };
    }

    if (decision === 'superseded' && existing) {
      // A newer answer to this question is already stored; the incoming one
      // is obsolete and must not overwrite it.
      return {
        outcome: 'superseded',
        responseId: existing.id,
        syncedAt: (existing.completedAt ?? now).toISOString(),
        audio: audioAck(existing),
      };
    }

    const writeData: ResponseWriteData = {
      clientResponseId: input.clientResponseId,
      recordedAt: input.recordedAt,
      transcription: input.transcription ?? null,
      durationSeconds: input.durationSeconds,
      ...audioColumns(input.audio),
      status: 'completed',
      isOffline: input.recordedOffline,
      syncedAt: now,
      completedAt: now,
    };

    if (decision === 'create') {
      const created = await tx.questionResponse.create({
        data: { ...writeData, questionId: input.questionId, sessionId: input.sessionId, startedAt: input.recordedAt },
        select: { id: true, completedAt: true },
      });
      return {
        outcome: 'created',
        responseId: created.id,
        syncedAt: (created.completedAt ?? now).toISOString(),
        audio: audioAck(writeData),
      };
    }

    // decision === 'update': the incoming recording is newer than the stored one.
    const updated = await tx.questionResponse.update({
      where: { id: existing!.id },
      data: writeData,
      select: { id: true, completedAt: true },
    });
    // The old evaluation scored a different answer; drop it so the results
    // page re-evaluates the new one.
    await tx.responseEvaluation.deleteMany({ where: { responseId: existing!.id } });
    return {
      outcome: 'updated',
      responseId: updated.id,
      syncedAt: (updated.completedAt ?? now).toISOString(),
      audio: audioAck(writeData),
    };
  });
}
