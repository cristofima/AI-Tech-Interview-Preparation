// =========================================================================
// AI Tech Interview - Sync Controller (one per tab)
//
// Coordinates the response sync engine across browser tabs and exposes a
// small observable state for the UI.
//
//   • Leader election: `navigator.locks` — only one tab runs the engine at a
//     time; the lock is released automatically when that tab closes or
//     crashes, so another tab can take over. Without Web Locks the engine
//     still runs safely because every record claim is an atomic IndexedDB
//     transaction (see offline-storage.ts).
//   • Notifications: `BroadcastChannel` — tabs tell each other when the queue
//     changed or a sync finished, so every status indicator stays current.
//   • Scheduling: after each run the controller sleeps exactly until the next
//     record becomes due (backoff expiry or an interrupted upload's lease
//     expiry) and retries then. It also wakes up on `online`, when the tab
//     becomes visible, and on cross-tab notifications.
//
// Every browser dependency is injectable so the controller can be tested in
// Node with fake locks, channels and timers.
// =========================================================================

import {
  computeNextDueTime,
  discardPendingResponse,
  getAllPendingResponses,
  isOnline as defaultIsOnline,
  recoverInterruptedUploads,
  retryAllPendingResponses,
  retryPendingResponse,
  savePendingResponse,
  summarizePendingResponses,
  type NewPendingResponseInput,
  type PendingResponse,
  type PendingSummary,
} from '@/lib/offline-storage';
import { getSyncOwnerId, syncPendingData, type SyncRunResult, type Uploader } from '@/lib/response-sync';

// =========================================================================
// Types
// =========================================================================

export const SYNC_LOCK_NAME = 'ai-interview-response-sync';
export const SYNC_CHANNEL_NAME = 'ai-interview-response-sync';

/** A pending record as shown to the UI (no audio blob). */
export type PendingResponseSummary = Omit<PendingResponse, 'audioBlob'>;

export interface SyncState {
  isOnline: boolean;
  /** This tab is currently running the engine. */
  isSyncing: boolean;
  summary: PendingSummary;
  records: PendingResponseSummary[];
  lastRun: (SyncRunResult & { at: number; by: 'this-tab' | 'other-tab' }) | null;
  /** When the scheduler will next try (ms), or null when nothing is waiting. */
  nextAttemptAt: number | null;
  /** Last storage/coordination failure that is not tied to one record. */
  error: string | null;
}

export type SyncReason =
  | 'startup'
  | 'manual'
  | 'recording-saved'
  | 'online'
  | 'visible'
  | 'timer'
  | 'queue-changed'
  | 'follow-up';

export type SyncMessage =
  | { type: 'queue-changed'; from: string }
  | { type: 'sync-finished'; from: string; result: SyncRunResult; at: number };

export interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown | null) => Promise<T>
  ): Promise<T>;
}

export interface ChannelLike {
  postMessage(message: SyncMessage): void;
  addEventListener(type: 'message', listener: (event: { data: SyncMessage }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: SyncMessage }) => void): void;
  close(): void;
}

export interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface TimerLike {
  set(fn: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface SyncControllerOptions {
  owner?: string;
  uploader?: Uploader;
  /** null disables leader election (engine still safe thanks to atomic claims). */
  locks?: LockManagerLike | null;
  createChannel?: () => ChannelLike | null;
  /** Source of online/offline events (window). */
  networkTarget?: EventTargetLike | null;
  /** Source of visibilitychange events (document). */
  visibilityTarget?: (EventTargetLike & { visibilityState?: string }) | null;
  timer?: TimerLike;
  now?: () => number;
  online?: () => boolean;
  /** Minimum delay between scheduled runs. */
  minDelayMs?: number;
  /** Lease length handed to the engine. */
  leaseMs?: number;
}

// =========================================================================
// Defaults (browser globals)
// =========================================================================

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks) {
    return navigator.locks as unknown as LockManagerLike;
  }
  return null;
}

function defaultCreateChannel(): ChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(SYNC_CHANNEL_NAME) as unknown as ChannelLike;
  } catch {
    return null;
  }
}

const defaultTimer: TimerLike = {
  set: (fn, delay) => setTimeout(fn, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function emptySummary(): PendingSummary {
  return { total: 0, pending: 0, uploading: 0, failed: 0, rejected: 0, needsAttention: 0 };
}

/** State before the controller has read IndexedDB (also the SSR snapshot). */
export const INITIAL_SYNC_STATE: SyncState = Object.freeze({
  isOnline: true,
  isSyncing: false,
  summary: emptySummary(),
  records: [],
  lastRun: null,
  nextAttemptAt: null,
  error: null,
}) as SyncState;

function toSummary(record: PendingResponse): PendingResponseSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { audioBlob, ...rest } = record;
  return rest;
}

// =========================================================================
// Controller
// =========================================================================

export class SyncController {
  private readonly owner: string;
  private readonly uploader: Uploader | undefined;
  private readonly locks: LockManagerLike | null;
  private readonly createChannel: () => ChannelLike | null;
  private readonly networkTarget: EventTargetLike | null;
  private readonly visibilityTarget: (EventTargetLike & { visibilityState?: string }) | null;
  private readonly timer: TimerLike;
  private readonly now: () => number;
  private readonly online: () => boolean;
  private readonly minDelayMs: number;
  private readonly leaseMs: number | undefined;

  private state: SyncState;
  private readonly listeners = new Set<(state: SyncState) => void>();
  private channel: ChannelLike | null = null;
  private timerHandle: unknown = null;
  private started = false;
  private running: Promise<SyncRunResult | null> | null = null;
  private rerunRequested = false;
  /** Why the most recent run started (diagnostics). */
  lastReason: SyncReason | null = null;

  constructor(options: SyncControllerOptions = {}) {
    this.owner = options.owner ?? getSyncOwnerId();
    this.uploader = options.uploader;
    this.locks = options.locks === undefined ? defaultLocks() : options.locks;
    this.createChannel = options.createChannel ?? defaultCreateChannel;
    this.networkTarget =
      options.networkTarget === undefined ? (typeof window !== 'undefined' ? window : null) : options.networkTarget;
    this.visibilityTarget =
      options.visibilityTarget === undefined ? (typeof document !== 'undefined' ? document : null) : options.visibilityTarget;
    this.timer = options.timer ?? defaultTimer;
    this.now = options.now ?? Date.now;
    this.online = options.online ?? defaultIsOnline;
    this.minDelayMs = options.minDelayMs ?? 1_000;
    this.leaseMs = options.leaseMs;

    this.state = { ...INITIAL_SYNC_STATE };
  }

  // ---------------------------------------------------------------------
  // Observation
  // ---------------------------------------------------------------------

  getState(): SyncState {
    return this.state;
  }

  subscribe(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        console.error('[sync-controller] listener failed', error);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Begin coordinating: recover interrupted uploads, publish the current
   * queue, listen for network/visibility/cross-tab events and run a sync.
   */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;

    this.channel = this.createChannel();
    this.channel?.addEventListener('message', this.handleMessage);
    this.networkTarget?.addEventListener('online', this.handleOnline);
    this.networkTarget?.addEventListener('offline', this.handleOffline);
    this.visibilityTarget?.addEventListener('visibilitychange', this.handleVisibility);
    this.setState({ isOnline: this.online() });

    return recoverInterruptedUploads(this.now())
      .catch((error) => {
        this.setState({ error: error instanceof Error ? error.message : 'Storage unavailable' });
        return 0;
      })
      .then(async () => {
        await this.refresh();
        await this.requestSync('startup');
      });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.channel?.removeEventListener('message', this.handleMessage);
    this.channel?.close();
    this.channel = null;
    this.networkTarget?.removeEventListener('online', this.handleOnline);
    this.networkTarget?.removeEventListener('offline', this.handleOffline);
    this.visibilityTarget?.removeEventListener('visibilitychange', this.handleVisibility);
    this.clearTimer();
  }

  // ---------------------------------------------------------------------
  // Queue actions (used by the UI)
  // ---------------------------------------------------------------------

  /**
   * Write-ahead save of a recording, then try to upload it right away.
   * Resolves as soon as the recording is durably stored locally.
   */
  async saveRecording(input: NewPendingResponseInput): Promise<PendingResponse> {
    const record = await savePendingResponse(input);
    await this.queueChanged();
    void this.requestSync('recording-saved');
    return record;
  }

  async retry(id: string): Promise<void> {
    await retryPendingResponse(id);
    await this.queueChanged();
    void this.requestSync('manual');
  }

  async retryAll(): Promise<void> {
    await retryAllPendingResponses();
    await this.queueChanged();
    void this.requestSync('manual');
  }

  async discard(id: string): Promise<void> {
    await discardPendingResponse(id);
    await this.queueChanged();
  }

  /**
   * Re-read the queue from IndexedDB, publish it and (re)arm the scheduler.
   */
  async refresh(): Promise<void> {
    await this.refreshRecords();
    this.scheduleNext();
  }

  private async refreshRecords(): Promise<void> {
    try {
      const records = (await getAllPendingResponses()).map(toSummary);
      this.setState({
        records,
        summary: summarizePendingResponses(records as PendingResponse[]),
        error: null,
      });
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : 'Storage unavailable' });
    }
  }

  /**
   * Run the engine now if this tab can become the leader. Concurrent requests
   * are coalesced into one follow-up run. Resolves with the run result, or
   * null when offline / another tab is the leader.
   */
  requestSync(reason: SyncReason = 'manual'): Promise<SyncRunResult | null> {
    if (!this.online()) {
      this.setState({ isOnline: false });
      return Promise.resolve(null);
    }
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = this.runOnce(reason).finally(() => {
      this.running = null;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.requestSync('follow-up');
      }
    });
    return this.running;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async runOnce(reason: SyncReason): Promise<SyncRunResult | null> {
    this.clearTimer();
    this.lastReason = reason;
    this.setState({ isSyncing: true, isOnline: true });
    let result: SyncRunResult | null = null;
    try {
      result = await this.withLeaderLock(() =>
        syncPendingData({
          owner: this.owner,
          uploader: this.uploader,
          now: this.now,
          online: this.online,
          leaseMs: this.leaseMs,
          onProgress: () => {
            void this.refreshRecords();
          },
        })
      );
      if (result) {
        const at = this.now();
        this.setState({ lastRun: { ...result, at, by: 'this-tab' } });
        this.post({ type: 'sync-finished', from: this.owner, result, at });
      }
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : 'Sync failed' });
    } finally {
      this.setState({ isSyncing: false });
      await this.refresh();
    }
    return result;
  }

  private async withLeaderLock<T>(fn: () => Promise<T>): Promise<T | null> {
    if (!this.locks) return fn();
    return this.locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, async (lock) => (lock ? fn() : null));
  }

  private async queueChanged(): Promise<void> {
    await this.refresh();
    this.post({ type: 'queue-changed', from: this.owner });
  }

  private post(message: SyncMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch (error) {
      console.warn('[sync-controller] broadcast failed', error);
    }
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (!this.started) return;
    const due = computeNextDueTime(this.state.records);
    if (due === null) {
      if (this.state.nextAttemptAt !== null) this.setState({ nextAttemptAt: null });
      return;
    }
    const at = Math.max(due, this.now() + this.minDelayMs);
    this.timerHandle = this.timer.set(() => {
      this.timerHandle = null;
      void this.requestSync('timer');
    }, at - this.now());
    if (this.state.nextAttemptAt !== at) this.setState({ nextAttemptAt: at });
  }

  private clearTimer(): void {
    if (this.timerHandle !== null) {
      this.timer.clear(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private readonly handleMessage = (event: { data: SyncMessage }): void => {
    const message = event.data;
    if (!message || message.from === this.owner) return;
    if (message.type === 'queue-changed') {
      void this.refresh().then(() => this.requestSync('queue-changed'));
    } else if (message.type === 'sync-finished') {
      this.setState({ lastRun: { ...message.result, at: message.at, by: 'other-tab' } });
      void this.refresh();
    }
  };

  private readonly handleOnline = (): void => {
    this.setState({ isOnline: true });
    void this.requestSync('online');
  };

  private readonly handleOffline = (): void => {
    this.setState({ isOnline: false });
  };

  private readonly handleVisibility = (): void => {
    if (this.visibilityTarget?.visibilityState === 'visible') {
      void this.refresh().then(() => this.requestSync('visible'));
    }
  };
}

// =========================================================================
// Per-tab singleton
// =========================================================================

let singleton: SyncController | null = null;

/**
 * The controller shared by every component in this tab.
 */
export function getSyncController(): SyncController {
  if (!singleton) {
    singleton = new SyncController();
  }
  return singleton;
}

/** Tests only. */
export function resetSyncControllerForTests(): void {
  singleton?.stop();
  singleton = null;
}
