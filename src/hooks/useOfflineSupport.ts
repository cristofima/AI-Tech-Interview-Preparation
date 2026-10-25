// =========================================================================
// AI Tech Interview - Offline Support Hook
// Thin React binding over the per-tab SyncController. Every component that
// uses this hook sees the same state (one store per tab, not per component).
// =========================================================================

'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { NewPendingResponseInput, PendingResponse } from '@/lib/offline-storage';
import type { SyncRunResult } from '@/lib/response-sync';
import {
  INITIAL_SYNC_STATE,
  getSyncController,
  type PendingResponseSummary,
  type SyncState,
} from '@/lib/sync-controller';

// =========================================================================
// Types
// =========================================================================

export interface OfflineState extends SyncState {
  /** Answers stored on this device that the server has not confirmed yet. */
  pendingCount: number;
}

export type SyncResult = SyncRunResult & { timestamp: number };

export interface UseOfflineSupportReturn {
  state: OfflineState;
  /** Durably save a recording on this device, then upload it (write-ahead). */
  saveRecording: (input: NewPendingResponseInput) => Promise<PendingResponse>;
  /** @deprecated use saveRecording */
  saveResponseOffline: (input: NewPendingResponseInput) => Promise<void>;
  /** Try to upload everything that is due right now. */
  triggerSync: () => Promise<SyncResult>;
  retry: (id: string) => Promise<void>;
  retryAll: () => Promise<void>;
  discard: (id: string) => Promise<void>;
  refreshPendingCount: () => Promise<void>;
  /** Local records for one session (e.g. the interview being taken). */
  recordsForSession: (sessionId: string) => PendingResponseSummary[];
}

// =========================================================================
// Hook Implementation
// =========================================================================

function subscribe(listener: () => void): () => void {
  return getSyncController().subscribe(listener);
}

function getSnapshot(): SyncState {
  return getSyncController().getState();
}

function getServerSnapshot(): SyncState {
  return INITIAL_SYNC_STATE;
}

export function useOfflineSupport(): UseOfflineSupportReturn {
  const syncState = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Start coordinating once per tab; the controller is a singleton and keeps
  // running while other components (e.g. the status indicator) use it.
  useEffect(() => {
    void getSyncController().start();
  }, []);

  const state = useMemo<OfflineState>(
    () => ({ ...syncState, pendingCount: syncState.summary.total }),
    [syncState]
  );

  const saveRecording = useCallback((input: NewPendingResponseInput) => getSyncController().saveRecording(input), []);

  const saveResponseOffline = useCallback(async (input: NewPendingResponseInput) => {
    await getSyncController().saveRecording(input);
  }, []);

  const triggerSync = useCallback(async (): Promise<SyncResult> => {
    const result = await getSyncController().requestSync('manual');
    return {
      synced: result?.synced ?? 0,
      failed: result?.failed ?? 0,
      errors: result?.errors ?? [],
      timestamp: Date.now(),
    };
  }, []);

  const retry = useCallback((id: string) => getSyncController().retry(id), []);
  const retryAll = useCallback(() => getSyncController().retryAll(), []);
  const discard = useCallback((id: string) => getSyncController().discard(id), []);
  const refreshPendingCount = useCallback(() => getSyncController().refresh(), []);

  const recordsForSession = useCallback(
    (sessionId: string) => syncState.records.filter((r) => r.sessionId === sessionId),
    [syncState.records]
  );

  return {
    state,
    saveRecording,
    saveResponseOffline,
    triggerSync,
    retry,
    retryAll,
    discard,
    refreshPendingCount,
    recordsForSession,
  };
}
