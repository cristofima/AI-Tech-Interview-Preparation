// =========================================================================
// AI Tech Interview - Offline Status Indicator Component
// Shows the real state of answers saved on this device: offline, waiting,
// uploading, retrying (with countdown) or needing attention (retry/discard).
// =========================================================================

'use client';

import { useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, CloudUpload, Loader2, RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { useOfflineSupport } from '@/hooks/useOfflineSupport';
import { useNow } from '@/hooks/useNow';
import { ATTENTION_AFTER_ATTEMPTS } from '@/lib/offline-storage';
import { formatCountdown } from '@/lib/interview-sync-status';
import type { PendingResponseSummary } from '@/lib/sync-controller';
import { cn } from '@/lib/utils';

// =========================================================================
// Types
// =========================================================================

export interface OfflineStatusProps {
  className?: string;
}

// =========================================================================
// Helpers
// =========================================================================

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function recordLabel(record: PendingResponseSummary): string {
  const when = new Date(record.recordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Answer recorded at ${when} (${record.durationSeconds}s)`;
}

function recordStatus(record: PendingResponseSummary, now: number): string {
  switch (record.status) {
    case 'uploading':
      return 'Uploading…';
    case 'pending':
      return 'Waiting to upload';
    case 'failed':
      return record.attempts >= ATTENTION_AFTER_ATTEMPTS
        ? `Failed ${record.attempts} times: ${record.lastError ?? 'unknown error'}`
        : `Retry in ${formatCountdown(record.nextRetryAt, now)} (${record.lastError ?? 'unknown error'})`;
    case 'rejected':
      return `Rejected: ${record.lastError ?? 'unknown error'}`;
  }
}


// =========================================================================
// Component
// =========================================================================

export function OfflineStatusIndicator({ className = '' }: OfflineStatusProps) {
  const { state, triggerSync, retryAll, retry, discard } = useOfflineSupport();
  const [expanded, setExpanded] = useState(false);
  const { summary, records, isOnline, isSyncing, nextAttemptAt, error } = state;
  const now = useNow(nextAttemptAt !== null || summary.failed > 0);

  // Nothing to report.
  if (isOnline && summary.total === 0 && !error) {
    return null;
  }

  const tone = !isOnline
    ? 'bg-red-100 text-red-800 border-red-200'
    : summary.needsAttention > 0 || error
      ? 'bg-red-50 text-red-800 border-red-200'
      : 'bg-yellow-100 text-yellow-800 border-yellow-200';

  let headline: string;
  if (error) {
    headline = `Local storage problem: ${error}`;
  } else if (!isOnline) {
    headline =
      summary.total > 0
        ? `Offline — ${plural(summary.total, 'answer')} saved on this device`
        : 'Offline';
  } else if (isSyncing || summary.uploading > 0) {
    headline = `Uploading ${plural(summary.total, 'answer')}…`;
  } else if (summary.needsAttention > 0) {
    headline = `${plural(summary.needsAttention, 'answer')} could not be uploaded`;
  } else if (nextAttemptAt !== null && summary.failed > 0) {
    headline = `${plural(summary.total, 'answer')} waiting — retrying in ${formatCountdown(nextAttemptAt, now)}`;
  } else {
    headline = `${plural(summary.total, 'answer')} waiting to upload`;
  }

  const showRetry = isOnline && !isSyncing && summary.total > 0;

  return (
    <div
      className={cn('fixed bottom-4 right-4 max-w-sm rounded-lg shadow-lg border p-4 text-sm z-50', tone, className)}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        {!isOnline ? (
          <WifiOff className="h-4 w-4 shrink-0" />
        ) : isSyncing || summary.uploading > 0 ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        ) : summary.needsAttention > 0 || error ? (
          <AlertCircle className="h-4 w-4 shrink-0" />
        ) : (
          <CloudUpload className="h-4 w-4 shrink-0" />
        )}
        <span className="font-medium flex-1">{headline}</span>
        {showRetry && (
          <button
            type="button"
            onClick={() => {
              void retryAll();
              void triggerSync();
            }}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-white/70 hover:bg-white rounded transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Retry now
          </button>
        )}
        {records.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="p-1 rounded hover:bg-white/50"
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide details' : 'Show details'}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>
        )}
      </div>

      {!isOnline && summary.total > 0 && (
        <p className="mt-1 text-xs opacity-80">They will upload automatically when you are back online.</p>
      )}

      {expanded && records.length > 0 && (
        <ul className="mt-3 space-y-2 max-h-60 overflow-y-auto">
          {records
            .slice()
            .sort((a, b) => a.recordedAt - b.recordedAt)
            .map((record) => {
              const needsAttention =
                record.status === 'rejected' || (record.status === 'failed' && record.attempts >= ATTENTION_AFTER_ATTEMPTS);
              return (
                <li key={record.id} className="bg-white/60 rounded p-2" data-record-status={record.status}>
                  <div className="text-xs font-medium">{recordLabel(record)}</div>
                  <div className="text-xs opacity-80">{recordStatus(record, now)}</div>
                  {(needsAttention || record.status === 'failed') && isOnline && (
                    <div className="mt-1 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void retry(record.id)}
                        className="inline-flex items-center gap-1 text-xs underline hover:opacity-80"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Retry
                      </button>
                      {needsAttention && (
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm('Discard this recorded answer? It has not been uploaded.')) {
                              void discard(record.id);
                            }
                          }}
                          className="inline-flex items-center gap-1 text-xs underline hover:opacity-80"
                        >
                          <Trash2 className="h-3 w-3" />
                          Discard
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}

export default OfflineStatusIndicator;
