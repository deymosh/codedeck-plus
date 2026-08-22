// @vitest-environment jsdom
/**
 * Phase 3 swipe-to-delete UI: the ported swipe hook on Sidebar session cards
 * (sub-threshold snaps back, vertical scroll never triggers, ≥80px commits
 * with the slide-out) and the UndoToast (delete shows it, Undo restores the
 * card in the sidebar).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RemoteSessionInfo } from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../../core/createPhoneCore';
import { memoryKV, type PhoneTransport } from '../../core/ports';
import { UNDO_DELAY_MS } from '../../core/deleteController';
import { PhoneCoreProvider } from '../coreContext';
import { Sidebar } from '../Sidebar';
import { UndoToast } from '../UndoToast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MACHINE = 'a'.repeat(64);

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

const sessionInfo = (id: string, over: Partial<RemoteSessionInfo> = {}): RemoteSessionInfo => ({
  id,
  slug: id,
  cwd: `/home/x/${id}`,
  lastActivity: '2026-08-08T10:00:00.000Z',
  lineCount: 0,
  title: null,
  project: `proj-${id}`,
  ...over,
});

async function makeCore(): Promise<PhoneCore> {
  // Default realTimers: vi.useFakeTimers() (installed before any delete) puts
  // both the hook's 200ms slide-out and the controller's 4s window on the
  // fake clock.
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
  core.machines.getState().registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
  core.machines.getState().applySessionUpsert(MACHINE, sessionInfo('s1', { title: 'One' }), 0);
  vi.spyOn(core.api, 'closeSession').mockResolvedValue(true);
  return core;
}

const noop = (): void => {};

function renderSidebar(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <Sidebar onOpenSettings={noop} onOpenPairing={noop} />
      <UndoToast />
    </PhoneCoreProvider>,
  );
}

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

/** Swipe horizontally from (200, 50) by dx, then release. */
function swipe(el: Element, dx: number): void {
  fireEvent.touchStart(el, touch(200, 50));
  fireEvent.touchMove(el, touch(200 + dx, 50));
  fireEvent.touchEnd(el);
}

describe('swipe-to-delete on session cards', () => {
  it('sub-threshold swipe snaps back — no delete, no toast', async () => {
    const core = await makeCore();
    vi.useFakeTimers();
    renderSidebar(core);

    const card = screen.getByTestId('session-card');
    swipe(card, -50);

    expect((card as HTMLElement).style.transform).toBe('translateX(0)');
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId('session-card')).toBeTruthy();
    expect(screen.queryByTestId('undo-toast')).toBeNull();
    expect(core.machines.getState().session(MACHINE, 's1')).toBeDefined();
  });

  it('vertical scroll never triggers the swipe', async () => {
    const core = await makeCore();
    vi.useFakeTimers();
    renderSidebar(core);

    const card = screen.getByTestId('session-card');
    fireEvent.touchStart(card, touch(200, 50));
    fireEvent.touchMove(card, touch(160, 150)); // dy dominates dx
    fireEvent.touchEnd(card);

    expect((card as HTMLElement).style.transform).toBe('');
    act(() => vi.advanceTimersByTime(1_000));
    expect(core.machines.getState().session(MACHINE, 's1')).toBeDefined();
    expect(screen.queryByTestId('undo-toast')).toBeNull();
  });

  it('≥80px swipe slides out, deletes the card, and shows the undo toast', async () => {
    const core = await makeCore();
    vi.useFakeTimers();
    renderSidebar(core);

    const card = screen.getByTestId('session-card');
    swipe(card, -100);

    // Slide-out armed, delete not fired yet.
    expect((card as HTMLElement).style.transform).toBe('translateX(-100%)');
    expect(core.machines.getState().session(MACHINE, 's1')).toBeDefined();

    act(() => vi.advanceTimersByTime(200));

    expect(screen.queryByTestId('session-card')).toBeNull();
    expect(core.machines.getState().session(MACHINE, 's1')).toBeUndefined();
    const toast = screen.getByTestId('undo-toast');
    expect(toast.textContent).toContain('Deleted "One"');
  });

  it('Undo within the window brings the card back into the sidebar', async () => {
    const core = await makeCore();
    vi.useFakeTimers();
    renderSidebar(core);

    swipe(screen.getByTestId('session-card'), -120);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByTestId('session-card')).toBeNull();

    fireEvent.click(screen.getByText('Undo'));

    expect(screen.getByTestId('session-card').textContent).toContain('One');
    expect(screen.queryByTestId('undo-toast')).toBeNull();
    // Undo killed the deferred close-session.
    act(() => vi.advanceTimersByTime(UNDO_DELAY_MS + 1_000));
    expect(core.api.closeSession).not.toHaveBeenCalled();
  });

  it('letting the window lapse removes the toast and sends the close', async () => {
    const core = await makeCore();
    vi.useFakeTimers();
    renderSidebar(core);

    swipe(screen.getByTestId('session-card'), -120);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByTestId('undo-toast')).toBeTruthy();

    act(() => vi.advanceTimersByTime(UNDO_DELAY_MS));

    expect(screen.queryByTestId('undo-toast')).toBeNull();
    expect(core.api.closeSession).toHaveBeenCalledTimes(1);
    expect(core.api.closeSession).toHaveBeenCalledWith(MACHINE, 's1');
  });
});
