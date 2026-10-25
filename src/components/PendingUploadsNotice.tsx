// =========================================================================
// AI Tech Interview - Pending Uploads Notice
// Warns on the results page when answers for this session are still stored
// on this device (the evaluation cannot include them yet).
// =========================================================================

'use client';

import { CloudUpload } from 'lucide-react';
import { useOfflineSupport } from '@/hooks/useOfflineSupport';

export interface PendingUploadsNoticeProps {
  sessionId: string;
  className?: string;
}

export function PendingUploadsNotice({ sessionId, className = '' }: PendingUploadsNoticeProps) {
  const { state, recordsForSession } = useOfflineSupport();
  const records = recordsForSession(sessionId);
  if (records.length === 0) return null;

  const attention = records.filter((r) => r.status === 'rejected').length;

  return (
    <div className={`bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800 ${className}`} role="status">
      <div className="flex items-center gap-2 font-medium">
        <CloudUpload className="h-4 w-4" />
        {records.length === 1 ? '1 answer' : `${records.length} answers`} from this session{' '}
        {state.isOnline ? 'are still uploading from this device' : 'are saved on this device and will upload when you are back online'}
        .
      </div>
      <p className="mt-1">
        These results do not include {records.length === 1 ? 'it' : 'them'} yet. Reload this page after the upload finishes.
        {attention > 0 && ` ${attention} could not be uploaded — use the sync panel in the corner to retry or discard.`}
      </p>
    </div>
  );
}

export default PendingUploadsNotice;
