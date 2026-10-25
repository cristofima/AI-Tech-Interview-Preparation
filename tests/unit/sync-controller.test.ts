// Mocked checks for cross-tab coordination. Two SyncController instances
// share one fake IndexedDB (same origin), a fake Web Locks manager and a fake
// BroadcastChannel hub. No network, database or Azure.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  claimNextPendingResponse,
  closeOfflineDB,
  getAllPendingResponses,
  getPendingResponse,
  savePendingResponse,
} from '@/lib/offline-storage';
import type { Uploader, UploadOutcome } from '@/lib/response-sync';
import {
  SyncController,
  SYNC_LOCK_NAME,
  getSyncController,
  resetSyncControllerForTests,
  type ChannelLike,
  type EventTargetLike,
  type LockManagerLike,
  type SyncMessage,
  type TimerLike,
} from '@/lib/sync-controller';

// -------------------------------------------------------------------------
// Fakes
// -------------------------------------------------------------------------

/** In-memory Web Locks: `ifAvailable` semantics, released when the callback settles. */
class FakeLocks {
  private held = new Map<string, string>();
  readonly log: string[] = [];

  forTab(tab: string): LockManagerLike & { releaseAll: () => void } {
    return {
      request: async (name, _options, callback) => {
        if (this.held.has(name)) {
          this.log.push(`${tab}:denied`);
          return callback(null);
        }
        this.held.set(name, tab);
        this.log.push(`${tab}:acquired`);
        try {
          return await callback({ name });
        } finally {
          if (this.held.get(name) === tab) this.held.delete(name);
          this.log.push(`${tab}:released`);
        }
      },
      // Simulates the browser releasing the lock when the tab dies.
      releaseAll: () => {
        for (const [name, owner] of this.held) if (owner === tab) this.held.delete(name);
      },
    };
  }

  holder(name = SYNC_LOCK_NAME) {
    return this.held.get(name) ?? null;
  }
}

/** In-memory BroadcastChannel hub; delivery is asynchronous like the real one. */
class FakeChannelHub {
  private channels = new Set<FakeChannel>();
  readonly messages: SyncMessage[] = [];
  create = (): ChannelLike => {
    const channel = new FakeChannel(this);
    this.channels.add(channel);
    return channel;
  };
  broadcast(from: FakeChannel, message: SyncMessage) {
    this.messages.push(message);
    for (const channel of this.channels) {
      if (channel !== from) setTimeout(() => channel.deliver(message), 0);
    }
  }
  remove(channel: FakeChannel) {
    this.channels.delete(channel);
  }
}

class FakeChannel implements ChannelLike {
  private listeners = new Set<(event: { data: SyncMessage }) => void>();
  constructor(private hub: FakeChannelHub) {}
  postMessage(message: SyncMessage) {
    this.hub.broadcast(this, message);
  }
  addEventListener(_type: 'message', listener: (event: { data: SyncMessage }) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: (event: { data: SyncMessage }) => void) {
    this.listeners.delete(listener);
  }
  close() {
    this.hub.remove(this);
  }
  deliver(message: SyncMessage) {
    for (const l of this.listeners) l({ data: message });
  }
}

/** Manual timer: tests fire scheduled callbacks explicitly. */
class FakeTimer implements TimerLike {
  private next = 1;
  readonly scheduled = new Map<number, { fn: () => void; delayMs: number }>();
  set(fn: () => void, delayMs: number) {
    const id = this.next++;
    this.scheduled.set(id, { fn, delayMs });
    return id;
  }
  clear(handle: unknown) {
    this.scheduled.delete(handle as number);
  }
  get pendingDelays() {
    return Array.from(this.scheduled.values()).map((t) => t.delayMs);
  }
  fireAll() {
    const entries = Array.from(this.scheduled.entries());
    this.scheduled.clear();
    for (const [, t] of entries) t.fn();
  }
}

class FakeTarget implements EventTargetLike {
  visibilityState = 'visible';
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string) {
    for (const l of this.listeners.get(type) ?? []) l();
  }
  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

const flush = (ms = 30) => new Promise((res) => setTimeout(res, ms));
const audio = () => new Blob(['bytes'], { type: 'audio/webm' });
const save = (questionId: string, recordedAt: number) =>
  savePendingResponse({ questionId, sessionId: 's1', audioBlob: audio(), durationSeconds: 5, recordedAt });

interface Tab {
  controller: SyncController;
  timer: FakeTimer;
  network: FakeTarget;
  visibility: FakeTarget;
  uploads: string[];
  locks: ReturnType<FakeLocks['forTab']>;
}

function makeTab(
  name: string,
  shared: { locks: FakeLocks; hub: FakeChannelHub; clock: { now: number }; online: { value: boolean } },
  uploader?: Uploader
): Tab {
  const timer = new FakeTimer();
  const network = new FakeTarget();
  const visibility = new FakeTarget();
  const uploads: string[] = [];
  const locks = shared.locks.forTab(name);
  const controller = new SyncController({
    owner: name,
    uploader:
      uploader ??
      (async (record) => {
        uploads.push(record.id);
        return { confirmed: true, outcome: 'created' } as UploadOutcome;
      }),
    locks,
    createChannel: shared.hub.create,
    networkTarget: network,
    visibilityTarget: visibility,
    timer,
    now: () => shared.clock.now,
    online: () => shared.online.value,
    minDelayMs: 1_000,
    leaseMs: 10_000,
  });
  return { controller, timer, network, visibility, uploads, locks };
}

function makeShared() {
  return { locks: new FakeLocks(), hub: new FakeChannelHub(), clock: { now: 100_000 }, online: { value: true } };
}

beforeEach(() => closeOfflineDB());
afterEach(() => {
  closeOfflineDB();
  resetSyncControllerForTests();
  vi.restoreAllMocks();
});

// -------------------------------------------------------------------------
// Single tab
// -------------------------------------------------------------------------
describe('SyncController (single tab)', () => {
  it('start() recovers interrupted uploads, publishes the queue and syncs', async () => {
    const r = await save('q1', 1_000);
    // An upload that a previous page load left behind with an expired lease.
    await claimNextPendingResponse('dead-tab', { now: 1_000, leaseMs: 1_000 });
    expect((await getPendingResponse(r.id))?.status).toBe('uploading');

    const shared = makeShared();
    const tab = makeTab('A', shared);
    const states: string[] = [];
    tab.controller.subscribe((s) => states.push(`${s.isSyncing ? 'syncing' : 'idle'}:${s.summary.total}`));

    await tab.controller.start();
    expect(tab.uploads).toEqual([r.id]);
    expect(await getAllPendingResponses()).toHaveLength(0);
    const state = tab.controller.getState();
    expect(state.summary.total).toBe(0);
    expect(state.lastRun).toMatchObject({ synced: 1, failed: 0, by: 'this-tab' });
    expect(state.isSyncing).toBe(false);
    expect(state.nextAttemptAt).toBeNull();
    expect(states).toContain('syncing:1');
    tab.controller.stop();
  });

  it('saveRecording is write-ahead: stored locally first, then uploaded', async () => {
    const shared = makeShared();
    let release!: (o: UploadOutcome) => void;
    const tab = makeTab('A', shared, async () => new Promise<UploadOutcome>((res) => (release = res)));
    await tab.controller.start();

    const record = await tab.controller.saveRecording({ questionId: 'q1', sessionId: 's1', audioBlob: audio(), durationSeconds: 3 });
    // Durable before the upload finished.
    expect((await getPendingResponse(record.id))).toBeDefined();
    expect(tab.controller.getState().summary.total).toBe(1);
    await flush();
    expect(tab.controller.getState().isSyncing).toBe(true);
    expect(tab.controller.getState().summary.uploading).toBe(1);

    release({ confirmed: true, outcome: 'created' });
    await flush();
    expect(tab.controller.getState().summary.total).toBe(0);
    expect(tab.controller.getState().isSyncing).toBe(false);
    tab.controller.stop();
  });

  it('schedules the next attempt at the retry time and runs it when the timer fires', async () => {
    const shared = makeShared();
    const tab = makeTab('A', shared, async () => ({ confirmed: false, retriable: true, error: 'HTTP 503', code: 'HTTP_503' }));
    const r = await save('q1', 1_000);
    await tab.controller.start();

    const state = tab.controller.getState();
    expect(state.summary.failed).toBe(1);
    expect(state.records[0]).toMatchObject({ id: r.id, status: 'failed', attempts: 1, lastErrorCode: 'HTTP_503' });
    expect(state.records[0]).not.toHaveProperty('audioBlob');
    const retryAt = state.records[0].nextRetryAt;
    expect(state.nextAttemptAt).toBe(retryAt);
    expect(tab.timer.pendingDelays).toEqual([retryAt - shared.clock.now]);

    shared.clock.now = retryAt + 1;
    tab.timer.fireAll();
    await flush();
    expect(tab.controller.getState().records[0].attempts).toBe(2);
    expect(tab.timer.pendingDelays).toHaveLength(1);
    tab.controller.stop();
    expect(tab.timer.pendingDelays).toHaveLength(0);
  });

  it('does not upload while offline and syncs on the online event', async () => {
    const shared = makeShared();
    shared.online.value = false;
    const tab = makeTab('A', shared);
    await save('q1', 1_000);
    await tab.controller.start();
    expect(tab.uploads).toEqual([]);
    expect(tab.controller.getState().isOnline).toBe(false);
    expect(tab.controller.getState().summary.pending).toBe(1);

    shared.online.value = true;
    tab.network.emit('online');
    await flush();
    expect(tab.uploads).toHaveLength(1);
    expect(tab.controller.getState().isOnline).toBe(true);
    expect(tab.controller.getState().summary.total).toBe(0);

    tab.network.emit('offline');
    expect(tab.controller.getState().isOnline).toBe(false);
    tab.controller.stop();
  });

  it('coalesces sync requests made during a run into one follow-up run', async () => {
    const shared = makeShared();
    const pending: Array<(o: UploadOutcome) => void> = [];
    const tab = makeTab('A', shared, async () => new Promise<UploadOutcome>((res) => pending.push(res)));
    await save('q1', 1_000);
    const acquisitions = () => shared.locks.log.filter((l) => l === 'A:acquired').length;

    void tab.controller.start(); // start() awaits the (stalled) run; do not block on it
    await flush();
    expect(pending).toHaveLength(1);
    void tab.controller.requestSync('manual');
    void tab.controller.requestSync('manual');
    void tab.controller.requestSync('manual');
    pending[0]({ confirmed: true, outcome: 'created' });
    await flush();
    expect(acquisitions()).toBe(2); // initial run + exactly one follow-up
    tab.controller.stop();
  });

  it('retry / retryAll / discard update the queue and notify other tabs', async () => {
    const shared = makeShared();
    const tab = makeTab('A', shared, async () => ({ confirmed: false, retriable: false, error: 'gone', code: 'SESSION_NOT_FOUND' }));
    const a = await save('q1', 1_000);
    const b = await save('q2', 2_000);
    await tab.controller.start();
    expect(tab.controller.getState().summary.rejected).toBe(2);
    expect(tab.controller.getState().summary.needsAttention).toBe(2);

    await tab.controller.discard(a.id);
    expect(tab.controller.getState().summary.total).toBe(1);
    expect(shared.hub.messages.at(-1)).toMatchObject({ type: 'queue-changed', from: 'A' });

    await tab.controller.retry(b.id);
    await flush();
    expect((await getPendingResponse(b.id))?.attempts).toBe(2); // retried immediately, rejected again

    await tab.controller.retryAll();
    await flush();
    expect((await getPendingResponse(b.id))?.attempts).toBe(3);
    tab.controller.stop();
  });

  it('refreshes and syncs when the tab becomes visible', async () => {
    const shared = makeShared();
    const tab = makeTab('A', shared);
    await tab.controller.start();
    await save('q1', 1_000); // written by something else (e.g. another tab without a channel)
    tab.visibility.emit('visibilitychange');
    await flush();
    expect(tab.uploads).toHaveLength(1);
    tab.controller.stop();
  });

  it('stop() removes every listener', async () => {
    const shared = makeShared();
    const tab = makeTab('A', shared);
    await tab.controller.start();
    expect(tab.network.count('online')).toBe(1);
    tab.controller.stop();
    expect(tab.network.count('online')).toBe(0);
    expect(tab.network.count('offline')).toBe(0);
    expect(tab.visibility.count('visibilitychange')).toBe(0);
  });

  it('surfaces storage failures in state.error instead of throwing', async () => {
    const shared = makeShared();
    const tab = makeTab('A', shared);
    const original = globalThis.indexedDB;
    // @ts-expect-error – simulate an environment without IndexedDB
    globalThis.indexedDB = undefined;
    try {
      await tab.controller.start();
      expect(tab.controller.getState().error).toMatch(/IndexedDB/);
    } finally {
      globalThis.indexedDB = original;
      tab.controller.stop();
    }
  });
});

// -------------------------------------------------------------------------
// Two tabs
// -------------------------------------------------------------------------
describe('SyncController (two tabs)', () => {
  it('only the leader uploads; the other tab learns the result via broadcast', async () => {
    const shared = makeShared();
    const slow: Array<(o: UploadOutcome) => void> = [];
    const tabA = makeTab('A', shared, async () => new Promise<UploadOutcome>((res) => slow.push(res)));
    const tabB = makeTab('B', shared);
    await save('q1', 1_000);
    await save('q2', 2_000);

    void tabA.controller.start();
    await flush();
    expect(shared.locks.holder()).toBe('A');
    await tabB.controller.start(); // lock busy → B gets null and stays a follower
    expect(tabB.uploads).toEqual([]);
    expect(tabB.controller.getState().isSyncing).toBe(false);
    expect(tabB.controller.getState().summary.uploading).toBe(1);
    expect(shared.locks.log).toContain('B:denied');

    slow[0]({ confirmed: true, outcome: 'created' });
    await flush();
    slow[1]({ confirmed: true, outcome: 'created' });
    await flush();

    expect(tabB.uploads).toEqual([]);
    expect(tabB.controller.getState().summary.total).toBe(0);
    expect(tabB.controller.getState().lastRun).toMatchObject({ synced: 2, by: 'other-tab' });
    tabA.controller.stop();
    tabB.controller.stop();
  });

  it('a recording saved in one tab shows up in the other tab immediately', async () => {
    const shared = makeShared();
    shared.online.value = false; // keep it in the queue so we can observe it
    const tabA = makeTab('A', shared);
    const tabB = makeTab('B', shared);
    await tabA.controller.start();
    await tabB.controller.start();

    await tabA.controller.saveRecording({ questionId: 'q1', sessionId: 's1', audioBlob: audio(), durationSeconds: 3 });
    await flush();
    expect(tabB.controller.getState().summary.pending).toBe(1);
    expect(tabB.controller.getState().records[0].questionId).toBe('q1');
    tabA.controller.stop();
    tabB.controller.stop();
  });

  it('the same record is never uploaded twice even when both tabs sync without Web Locks', async () => {
    const shared = makeShared();
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const uploader: Uploader = async (record) => {
      started.push(record.id);
      await new Promise<void>((res) => releases.push(res));
      return { confirmed: true, outcome: 'created' };
    };
    const mk = (name: string) =>
      new SyncController({
        owner: name,
        uploader,
        locks: null, // no leader election
        createChannel: shared.hub.create,
        networkTarget: null,
        visibilityTarget: null,
        timer: new FakeTimer(),
        now: () => shared.clock.now,
        online: () => true,
        leaseMs: 10_000,
      });
    const a = mk('A');
    const b = mk('B');
    await save('q1', 1_000);
    await save('q2', 2_000);

    void a.start();
    void b.start();
    await flush();
    // Both engines ran concurrently, but each record was claimed by exactly one.
    expect(started.sort()).toHaveLength(2);
    expect(new Set(started).size).toBe(2);
    releases.forEach((r) => r());
    await flush();
    expect(await getAllPendingResponses()).toHaveLength(0);
    a.stop();
    b.stop();
  });

  it('a follower takes over an upload left behind by a leader that died mid-upload', async () => {
    const shared = makeShared();
    const tabA = makeTab('A', shared, () => new Promise<UploadOutcome>(() => undefined)); // never resolves
    const tabB = makeTab('B', shared);
    const r = await save('q1', 1_000);

    void tabA.controller.start();
    await flush();
    expect((await getPendingResponse(r.id))?.leaseOwner).toBe('A');
    await tabB.controller.start();
    expect(tabB.uploads).toEqual([]);
    // B sleeps until A's lease would expire.
    const leaseUntil = (await getPendingResponse(r.id))!.leaseUntil!;
    expect(tabB.controller.getState().nextAttemptAt).toBe(leaseUntil + 1);

    // Tab A dies: the browser releases its lock; its lease is never renewed.
    tabA.controller.stop();
    tabA.locks.releaseAll();
    shared.clock.now = leaseUntil + 1;
    tabB.timer.fireAll();
    await flush();

    expect(tabB.uploads).toEqual([r.id]);
    expect(await getAllPendingResponses()).toHaveLength(0);
    tabB.controller.stop();
  });

  it('a tab ignores its own broadcasts', async () => {
    const shared = makeShared();
    const tab = makeTab('A', shared);
    await tab.controller.start();
    const refresh = vi.spyOn(tab.controller, 'refresh');
    await tab.controller.discard('nothing'); // one refresh from the action itself
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    tab.controller.stop();
  });
});

describe('getSyncController', () => {
  it('returns one instance per tab', () => {
    const a = getSyncController();
    expect(getSyncController()).toBe(a);
    resetSyncControllerForTests();
    expect(getSyncController()).not.toBe(a);
  });
});
