// @vitest-environment jsdom
//
// Mocked checks for the React bindings: the hook, the global status
// indicator and the per-question badge, driven by the real SyncController
// over fake-indexeddb with `fetch` stubbed. No database or Azure.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { closeOfflineDB, getAllPendingResponses, savePendingResponse, ATTENTION_AFTER_ATTEMPTS } from '@/lib/offline-storage';
import { resetSyncControllerForTests, getSyncController } from '@/lib/sync-controller';
import { useOfflineSupport } from '@/hooks/useOfflineSupport';
import { OfflineStatusIndicator } from '@/components/OfflineStatusIndicator';
import { ResponseSyncBadge } from '@/components/ResponseSyncBadge';
import { PendingUploadsNotice } from '@/components/PendingUploadsNotice';

const audio = () => new Blob(['bytes'], { type: 'audio/webm' });

function stubFetch(impl: () => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}
const networkDown = () => stubFetch(async () => { throw new TypeError('Failed to fetch'); });
const notFound = () =>
  stubFetch(async () => new Response(JSON.stringify({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }), { status: 404 }));
const confirmed = () =>
  stubFetch(async () =>
    new Response(JSON.stringify({ success: true, data: { outcome: 'created', responseId: 'r', syncedAt: 'now', audio: { stored: true, bytes: 5, sha256: null } } }), { status: 201 })
  );

beforeEach(() => {
  closeOfflineDB();
  resetSyncControllerForTests();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  resetSyncControllerForTests();
  closeOfflineDB();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useOfflineSupport', () => {
  it('exposes one shared state and the queue actions', async () => {
    networkDown();
    const { result } = renderHook(() => useOfflineSupport());
    expect(result.current.state.pendingCount).toBe(0);

    let recordId = '';
    await act(async () => {
      const record = await result.current.saveRecording({ questionId: 'q1', sessionId: 's1', audioBlob: audio(), durationSeconds: 4 });
      recordId = record.id;
    });
    await waitFor(() => expect(result.current.state.summary.failed).toBe(1));
    expect(result.current.state.pendingCount).toBe(1);
    expect(result.current.recordsForSession('s1')).toHaveLength(1);
    expect(result.current.recordsForSession('other')).toHaveLength(0);
    expect(result.current.state.records[0]).toMatchObject({ id: recordId, lastErrorCode: 'NETWORK' });

    // A second hook instance (another component) sees the same state.
    const second = renderHook(() => useOfflineSupport());
    expect(second.result.current.state).toEqual(result.current.state);
    expect(second.result.current.state.records).toBe(result.current.state.records);

    await act(async () => {
      await result.current.discard(recordId);
    });
    await waitFor(() => expect(result.current.state.pendingCount).toBe(0));
    expect(second.result.current.state.pendingCount).toBe(0);
  });

  it('triggerSync uploads and the answer disappears from the queue once confirmed', async () => {
    const fetchMock = confirmed();
    await savePendingResponse({ questionId: 'q1', sessionId: 's1', audioBlob: null, durationSeconds: 4 });
    const { result } = renderHook(() => useOfflineSupport());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await getAllPendingResponses()).toHaveLength(0));
    await waitFor(() => expect(result.current.state.lastRun).toMatchObject({ synced: 1, failed: 0 }));
    expect(result.current.state.pendingCount).toBe(0);
  });
});

describe('OfflineStatusIndicator', () => {
  it('renders nothing when online with an empty queue', async () => {
    confirmed();
    const { container } = render(<OfflineStatusIndicator />);
    await act(async () => { await getSyncController().start(); });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows retrying state with details, and Retry now re-attempts', async () => {
    const fetchMock = networkDown();
    await savePendingResponse({ questionId: 'q1', sessionId: 's1', audioBlob: audio(), durationSeconds: 4 });
    render(<OfflineStatusIndicator />);
    await screen.findByText(/1 answer waiting — retrying in/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Show details'));
    expect(screen.getByText(/Answer recorded at .* \(4s\)/)).toBeTruthy();
    expect(screen.getByText(/Retry in \d+s \(Failed to fetch\)/)).toBeTruthy();

    fireEvent.click(screen.getByText('Retry now'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((await getAllPendingResponses())[0].attempts).toBe(2);
  });

  it('shows rejected answers as needing attention and lets the user discard them', async () => {
    notFound();
    await savePendingResponse({ questionId: 'q1', sessionId: 's1', audioBlob: audio(), durationSeconds: 4 });
    render(<OfflineStatusIndicator />);
    await screen.findByText('1 answer could not be uploaded');
    fireEvent.click(screen.getByLabelText('Show details'));
    expect(screen.getByText('Rejected: Session not found')).toBeTruthy();

    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByText('Discard'));
    expect(await getAllPendingResponses()).toHaveLength(1);

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('Discard'));
    await waitFor(async () => expect(await getAllPendingResponses()).toHaveLength(0));
    await waitFor(() => expect(screen.queryByText('1 answer could not be uploaded')).toBeNull());
  });

  it('shows the offline state without attempting uploads', async () => {
    const fetchMock = confirmed();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await savePendingResponse({ questionId: 'q1', sessionId: 's1', audioBlob: audio(), durationSeconds: 4 });
    render(<OfflineStatusIndicator />);
    await screen.findByText('Offline — 1 answer saved on this device');
    expect(screen.getByText(/upload automatically when you are back online/)).toBeTruthy();
    expect(screen.queryByText('Retry now')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    // Back online: the indicator disappears once the upload is confirmed.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});

describe('PendingUploadsNotice', () => {
  it('warns only for the session that still has local answers', async () => {
    networkDown();
    await savePendingResponse({ questionId: 'q1', sessionId: 's1', audioBlob: audio(), durationSeconds: 4 });
    const other = render(<PendingUploadsNotice sessionId="s2" />);
    await act(async () => { await getSyncController().start(); });
    expect(other.container).toBeEmptyDOMElement();
    other.unmount();

    render(<PendingUploadsNotice sessionId="s1" />);
    await screen.findByText(/1 answer from this session are still uploading from this device/);
    expect(screen.getByText(/These results do not include it yet/)).toBeTruthy();
  });
});

describe('ResponseSyncBadge', () => {
  const record = (over: Partial<Parameters<typeof ResponseSyncBadge>[0]['status'] extends infer S ? S extends { record: infer R } ? R : never : never> = {}) => ({
    id: 'r1', clientResponseId: 'r1', questionId: 'q1', sessionId: 's1', mimeType: 'audio/webm', audioSize: 5,
    durationSeconds: 4, recordedAt: 1, status: 'pending' as const, attempts: 0, nextRetryAt: 0, version: 2 as const, ...over,
  });

  it('renders the confirmed, pending and uploading states', () => {
    const { rerender } = render(<ResponseSyncBadge status={{ kind: 'none' }} isOnline answered />);
    expect(screen.getByText('Saved')).toBeTruthy();
    rerender(<ResponseSyncBadge status={{ kind: 'pending', record: record() }} isOnline answered />);
    expect(screen.getByText('Saved on this device')).toBeTruthy();
    expect(screen.getByText('Waiting to upload')).toBeTruthy();
    rerender(<ResponseSyncBadge status={{ kind: 'uploading', record: record({ status: 'uploading' }) }} isOnline answered />);
    expect(screen.getByText('Uploading…')).toBeTruthy();
  });

  it('offers retry and discard for answers that need attention', () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    render(
      <ResponseSyncBadge
        status={{ kind: 'attention', record: record({ status: 'failed', attempts: ATTENTION_AFTER_ATTEMPTS, lastError: 'HTTP 500' }) }}
        isOnline
        answered
        onRetry={onRetry}
        onDiscard={onDiscard}
      />
    );
    expect(screen.getByText('Upload keeps failing')).toBeTruthy();
    expect(screen.getByText('HTTP 500')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry now'));
    fireEvent.click(screen.getByText('Discard'));
    expect(onRetry).toHaveBeenCalledWith('r1');
    expect(onDiscard).toHaveBeenCalledWith('r1');
  });

  it('hides retry while offline and renders nothing for unanswered questions', () => {
    const { container, rerender } = render(
      <ResponseSyncBadge status={{ kind: 'retrying', record: record({ status: 'failed', attempts: 1 }), retryAt: Date.now() + 5000 }} isOnline={false} answered onRetry={vi.fn()} />
    );
    expect(screen.queryByText('Retry now')).toBeNull();
    rerender(<ResponseSyncBadge status={{ kind: 'none' }} isOnline answered={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
