// Mocked checks for the per-question status helpers used by InterviewRoom.
import { describe, it, expect } from 'vitest';
import { ATTENTION_AFTER_ATTEMPTS } from '@/lib/offline-storage';
import type { PendingResponseSummary } from '@/lib/sync-controller';
import {
  describeSyncStatus,
  formatCountdown,
  getQuestionSyncStatus,
  latestLocalRecord,
  mergeLocalRecords,
  type QuestionState,
} from '@/lib/interview-sync-status';

function rec(over: Partial<PendingResponseSummary> = {}): PendingResponseSummary {
  return {
    id: over.id ?? 'r1',
    clientResponseId: over.id ?? 'r1',
    questionId: 'q1',
    sessionId: 's1',
    mimeType: 'audio/webm',
    audioSize: 10,
    transcription: 'local transcript',
    durationSeconds: 33,
    recordedAt: 1_000,
    status: 'pending',
    attempts: 0,
    nextRetryAt: 0,
    version: 2,
    ...over,
  };
}

describe('latestLocalRecord / getQuestionSyncStatus', () => {
  it('picks the newest record for the question in the session', () => {
    const records = [
      rec({ id: 'old', recordedAt: 1_000 }),
      rec({ id: 'new', recordedAt: 2_000 }),
      rec({ id: 'other-q', questionId: 'q2', recordedAt: 3_000 }),
      rec({ id: 'other-s', sessionId: 's2', recordedAt: 4_000 }),
    ];
    expect(latestLocalRecord(records, 's1', 'q1')?.id).toBe('new');
    expect(latestLocalRecord(records, 's1', 'q3')).toBeUndefined();
  });

  it('maps record status to a UI status', () => {
    expect(getQuestionSyncStatus([], 's1', 'q1')).toEqual({ kind: 'none' });
    expect(getQuestionSyncStatus([rec()], 's1', 'q1').kind).toBe('pending');
    expect(getQuestionSyncStatus([rec({ status: 'uploading' })], 's1', 'q1').kind).toBe('uploading');
    const retrying = getQuestionSyncStatus([rec({ status: 'failed', attempts: 1, nextRetryAt: 5_000 })], 's1', 'q1');
    expect(retrying).toMatchObject({ kind: 'retrying', retryAt: 5_000 });
    expect(getQuestionSyncStatus([rec({ status: 'failed', attempts: ATTENTION_AFTER_ATTEMPTS })], 's1', 'q1').kind).toBe('attention');
    expect(getQuestionSyncStatus([rec({ status: 'rejected' })], 's1', 'q1').kind).toBe('attention');
  });
});

describe('describeSyncStatus', () => {
  const opts = { now: 1_000, isOnline: true, answered: true };

  it('describes every status', () => {
    expect(describeSyncStatus({ kind: 'none' }, opts)).toEqual({ label: 'Saved', tone: 'success' });
    expect(describeSyncStatus({ kind: 'none' }, { ...opts, answered: false })).toEqual({ label: 'Not answered', tone: 'neutral' });
    expect(describeSyncStatus({ kind: 'pending', record: rec() }, opts)).toMatchObject({ label: 'Saved on this device', detail: 'Waiting to upload' });
    expect(describeSyncStatus({ kind: 'pending', record: rec() }, { ...opts, isOnline: false }).detail).toMatch(/back online/);
    expect(describeSyncStatus({ kind: 'uploading', record: rec() }, opts)).toMatchObject({ label: 'Uploading…', tone: 'info' });
    const retrying = describeSyncStatus(
      { kind: 'retrying', record: rec({ status: 'failed', attempts: 2, lastError: 'HTTP 503' }), retryAt: 16_000 },
      opts
    );
    expect(retrying.tone).toBe('warning');
    expect(retrying.detail).toBe('Attempt 2 failed (HTTP 503). Next try in 15s.');
    expect(describeSyncStatus({ kind: 'attention', record: rec({ status: 'rejected', lastError: 'Session not found' }) }, opts)).toEqual({
      label: 'Upload rejected',
      tone: 'error',
      detail: 'Session not found',
    });
    expect(describeSyncStatus({ kind: 'attention', record: rec({ status: 'failed', attempts: 9 }) }, opts).label).toBe('Upload keeps failing');
  });

  it('formats countdowns', () => {
    expect(formatCountdown(1_000, 5_000)).toBe('0s');
    expect(formatCountdown(5_500, 1_000)).toBe('5s');
    expect(formatCountdown(121_000, 1_000)).toBe('2m');
    expect(formatCountdown(130_000, 1_000)).toBe('2m 9s');
  });
});

describe('mergeLocalRecords', () => {
  const base = (): Map<string, QuestionState> =>
    new Map([
      ['q1', { answered: false }],
      ['q2', { answered: true, transcription: 'server', responseId: 'srv-2' }],
      ['q3', { answered: false }],
    ]);

  it('marks questions with local recordings as answered, keeping the server responseId', () => {
    const merged = mergeLocalRecords(base(), [rec({ id: 'a', questionId: 'q1' }), rec({ id: 'b', questionId: 'q2', transcription: 'local 2' })], 's1');
    expect(merged).not.toBeNull();
    expect(merged!.get('q1')).toEqual({ answered: true, transcription: 'local transcript', duration: 33, responseId: undefined, localRecordId: 'a' });
    expect(merged!.get('q2')).toEqual({ answered: true, transcription: 'local 2', duration: 33, responseId: 'srv-2', localRecordId: 'b' });
    expect(merged!.get('q3')).toEqual({ answered: false });
  });

  it('returns null when the state already reflects the records (no re-render loop)', () => {
    const first = mergeLocalRecords(base(), [rec({ id: 'a', questionId: 'q1' })], 's1')!;
    expect(mergeLocalRecords(first, [rec({ id: 'a', questionId: 'q1' })], 's1')).toBeNull();
    expect(mergeLocalRecords(base(), [], 's1')).toBeNull();
    expect(mergeLocalRecords(base(), [rec({ sessionId: 'other' })], 's1')).toBeNull();
  });

  it('re-merges when a newer local recording replaces the previous one', () => {
    const first = mergeLocalRecords(base(), [rec({ id: 'a', questionId: 'q1', recordedAt: 1 })], 's1')!;
    const second = mergeLocalRecords(first, [rec({ id: 'b', questionId: 'q1', recordedAt: 2, transcription: 'take two' })], 's1');
    expect(second!.get('q1')).toMatchObject({ localRecordId: 'b', transcription: 'take two' });
  });
});
