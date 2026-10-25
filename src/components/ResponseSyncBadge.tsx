// =========================================================================
// AI Tech Interview - Response Sync Badge
// Shows what happened to one recorded answer: saved on device, uploading,
// retrying, needs attention, or confirmed by the server.
// =========================================================================

'use client';

import { AlertCircle, Check, CloudUpload, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useNow } from '@/hooks/useNow';
import { describeSyncStatus, type QuestionSyncStatus, type StatusTone } from '@/lib/interview-sync-status';
import { cn } from '@/lib/utils';

export interface ResponseSyncBadgeProps {
  status: QuestionSyncStatus;
  isOnline: boolean;
  /** Whether the question counts as answered (server or local). */
  answered: boolean;
  onRetry?: (recordId: string) => void;
  onDiscard?: (recordId: string) => void;
  className?: string;
}

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-gray-100 text-gray-600',
  info: 'bg-blue-50 text-blue-700',
  warning: 'bg-yellow-50 text-yellow-800',
  error: 'bg-red-50 text-red-700',
  success: 'bg-green-50 text-green-700',
};


export function ResponseSyncBadge({ status, isOnline, answered, onRetry, onDiscard, className }: ResponseSyncBadgeProps) {
  const now = useNow(status.kind === 'retrying');
  const description = describeSyncStatus(status, { now, isOnline, answered });
  if (status.kind === 'none' && !answered) return null;

  const Icon =
    status.kind === 'uploading'
      ? Loader2
      : status.kind === 'pending'
        ? CloudUpload
        : status.kind === 'retrying'
          ? RefreshCw
          : status.kind === 'attention'
            ? AlertCircle
            : Check;

  const record = status.kind === 'none' ? null : status.record;

  return (
    <div className={cn('inline-flex flex-col items-start gap-1 text-left', className)} data-sync-status={status.kind}>
      <span
        className={cn('inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium', TONE_CLASSES[description.tone])}
        title={description.detail}
      >
        <Icon className={cn('h-3.5 w-3.5', status.kind === 'uploading' && 'animate-spin')} />
        {description.label}
      </span>
      {description.detail && (
        <span className="text-xs text-gray-500 max-w-xs">{description.detail}</span>
      )}
      {record && (status.kind === 'attention' || status.kind === 'retrying') && (
        <span className="flex items-center gap-3">
          {onRetry && isOnline && (
            <button
              type="button"
              onClick={() => onRetry(record.id)}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 underline"
            >
              <RefreshCw className="h-3 w-3" />
              Retry now
            </button>
          )}
          {onDiscard && status.kind === 'attention' && (
            <button
              type="button"
              onClick={() => onDiscard(record.id)}
              className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-800 underline"
            >
              <Trash2 className="h-3 w-3" />
              Discard
            </button>
          )}
        </span>
      )}
    </div>
  );
}

export default ResponseSyncBadge;
