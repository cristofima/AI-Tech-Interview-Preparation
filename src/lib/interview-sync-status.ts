// =========================================================================
// AI Tech Interview - Per-question sync status helpers
// Pure functions used by InterviewRoom to show what happened to an answer.
// =========================================================================

import { ATTENTION_AFTER_ATTEMPTS } from '@/lib/offline-storage';
import type { PendingResponseSummary } from '@/lib/sync-controller';

// =========================================================================
// Types
// =========================================================================

export interface QuestionState {
  answered: boolean;
  transcription?: string;
  responseId?: string;
  duration?: number;
  /** Id of the local IndexedDB record when the answer was saved on this device. */
  localRecordId?: string;
}

export type QuestionSyncStatus =
  | { kind: 'none' }
  | { kind: 'pending'; record: PendingResponseSummary }
  | { kind: 'uploading'; record: PendingResponseSummary }
  | { kind: 'retrying'; record: PendingResponseSummary; retryAt: number }
  | { kind: 'attention'; record: PendingResponseSummary };

export type StatusTone = 'neutral' | 'info' | 'warning' | 'error' | 'success';

export interface StatusDescription {
  label: string;
  tone: StatusTone;
  detail?: string;
}

// =========================================================================
// Helpers
// =========================================================================

/**
 * Newest local record for a question, if any.
 */
export function latestLocalRecord(
  records: PendingResponseSummary[],
  sessionId: string,
  questionId: string
): PendingResponseSummary | undefined {
  let latest: PendingResponseSummary | undefined;
  for (const r of records) {
    if (r.sessionId !== sessionId || r.questionId !== questionId) continue;
    if (!latest || r.recordedAt > latest.recordedAt) latest = r;
  }
  return latest;
}

export function getQuestionSyncStatus(
  records: PendingResponseSummary[],
  sessionId: string,
  questionId: string
): QuestionSyncStatus {
  const record = latestLocalRecord(records, sessionId, questionId);
  if (!record) return { kind: 'none' };
  switch (record.status) {
    case 'uploading':
      return { kind: 'uploading', record };
    case 'rejected':
      return { kind: 'attention', record };
    case 'failed':
      if (record.attempts >= ATTENTION_AFTER_ATTEMPTS) return { kind: 'attention', record };
      return { kind: 'retrying', record, retryAt: record.nextRetryAt };
    case 'pending':
    default:
      return { kind: 'pending', record };
  }
}

export function formatCountdown(targetMs: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((targetMs - now) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * Human-readable description of a question's sync status.
 */
export function describeSyncStatus(
  status: QuestionSyncStatus,
  options: { now: number; isOnline: boolean; answered: boolean }
): StatusDescription {
  switch (status.kind) {
    case 'none':
      return options.answered
        ? { label: 'Saved', tone: 'success' }
        : { label: 'Not answered', tone: 'neutral' };
    case 'pending':
      return options.isOnline
        ? { label: 'Saved on this device', tone: 'info', detail: 'Waiting to upload' }
        : { label: 'Saved on this device', tone: 'info', detail: 'Will upload when you are back online' };
    case 'uploading':
      return { label: 'Uploading…', tone: 'info' };
    case 'retrying':
      return {
        label: 'Upload failed, retrying',
        tone: 'warning',
        detail: `Attempt ${status.record.attempts} failed (${status.record.lastError ?? 'unknown error'}). Next try in ${formatCountdown(status.retryAt, options.now)}.`,
      };
    case 'attention':
      return {
        label: status.record.status === 'rejected' ? 'Upload rejected' : 'Upload keeps failing',
        tone: 'error',
        detail: status.record.lastError ?? 'Unknown error',
      };
  }
}

/**
 * Reflect local records in the per-question UI state (e.g. after a reload):
 * a question with a local recording counts as answered, with that
 * recording's transcription. Returns null when nothing changed.
 */
export function mergeLocalRecords(
  states: Map<string, QuestionState>,
  records: PendingResponseSummary[],
  sessionId: string
): Map<string, QuestionState> | null {
  let next: Map<string, QuestionState> | null = null;
  for (const [questionId, current] of states) {
    const record = latestLocalRecord(records, sessionId, questionId);
    if (!record) continue;
    if (current.answered && current.localRecordId === record.id) continue;
    if (!next) next = new Map(states);
    next.set(questionId, {
      answered: true,
      transcription: record.transcription,
      duration: record.durationSeconds,
      responseId: current.responseId,
      localRecordId: record.id,
    });
  }
  return next;
}
