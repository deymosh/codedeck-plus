// @vitest-environment jsdom
/**
 * Phase 8 integration: the MainPanel swipe carousel.
 *
 * - A left swipe navigates to the next session in the sidebar's order via
 *   selectSession (P1 semantics: unread cleared, panelMode set) and the
 *   transcript pin's CDX-024 session-switch reset scrolls the NEW transcript
 *   to the bottom — asserted via a scroll spy on the (mocked) virtua handle,
 *   proving the single scroll owner (useTranscriptPin) did the scroll; the
 *   carousel itself never scrolls the transcript.
 * - The input bar stays OUTSIDE SessionScreen's slide region (static while
 *   the content slides).
 * - ‹/› attention chevrons render on touch devices when a session needing
 *   attention lies left/right in carousel order.
 * - DM mode: the unified conversation order wraps (last → first).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { OutputEntry, RemoteSessionInfo } from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../../core/createPhoneCore';
import { memoryKV, type PhoneTransport } from '../../core/ports';
import { PhoneCoreProvider } from '../coreContext';
import { MainPanel } from '../MainPanel';
import { SLIDE_DURATION_MS, SWIPE_DEBOUNCE_MS } from '../useSwipeToNavigate';

// Scroll spy: the mocked virtua handle records every scrollToIndex — only
// useTranscriptPin (the single scroll owner) ever calls it.
const { scrollSpy } = vi.hoisted(() => ({ scrollSpy: vi.fn() }));

vi.mock('virtua', async () => {
  const React = await import('react');
  return {
    VList: React.forwardRef(function VListMock(
      props: { children?: React.ReactNode },
      ref: React.Ref<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: scrollSpy,
        scrollOffset: 0,
        viewportSize: 0,
        scrollSize: 1000, // never "at bottom" → geometry stays honest in jsdom
      }));
      return React.createElement('div', { 'data-testid': 'vlist' }, props.children);
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  scrollSpy.mockClear();
});

const MACHINE = 'a'.repeat(64);
const PEER_C = 'c'.repeat(64);
const PEER_D = 'd'.repeat(64);

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

function mockMatchMedia(matches: boolean): void {
  (window as unknown as Record<string, unknown>)['matchMedia'] = (query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

const sessionInfo = (id: string, over: Partial<RemoteSessionInfo> = {}): RemoteSessionInfo => ({
  id,
  slug: id,
  cwd: `/home/x/${id}`,
  lastActivity: '2026-08-08T10:00:00.000Z',
  lineCount: 0,
  title: id,
  project: `proj-${id}`,
  ...over,
});

const entry = (content: string): OutputEntry => ({
  entryType: 'text',
  content,
  timestamp: new Date(0).toISOString(),
});

/** Machine with two sessions in carousel order [s-new, s-old], both with a
 *  transcript entry, s-new selected. */
async function makeSessionCore(): Promise<PhoneCore> {
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
  const m = core.machines.getState();
  m.registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
  m.applySessionUpsert(MACHINE, sessionInfo('s-new', { lastActivity: '2026-08-08T11:00:00.000Z' }), 0);
  m.applySessionUpsert(MACHINE, sessionInfo('s-old', { lastActivity: '2026-08-08T10:00:00.000Z' }), 0);
  await core.transcript.getState().applyOutput(MACHINE, 's-new', 1, entry('hello new'));
  await core.transcript.getState().applyOutput(MACHINE, 's-old', 1, entry('hello old'));
  core.ui.getState().selectSession(MACHINE, 's-new');
  return core;
}

function renderPanel(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <MainPanel isWide={true} onOpenSidebar={() => {}} />
    </PhoneCoreProvider>,
  );
}

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

function swipe(el: Element, dx: number): void {
  fireEvent.touchStart(el, touch(200, 50));
  fireEvent.touchMove(el, touch(200 + dx, 50));
  fireEvent.touchEnd(el);
}

describe('session swipe carousel', () => {
  it('left swipe selects the next session (unread cleared) and the pin owner scrolls the new transcript', async () => {
    mockMatchMedia(true);
    const core = await makeSessionCore();
    core.ui.getState().markSessionUnread(MACHINE, 's-old');
    vi.useFakeTimers();
    renderPanel(core);

    scrollSpy.mockClear();
    swipe(screen.getByTestId('main-panel'), -80);
    act(() => vi.advanceTimersByTime(SLIDE_DURATION_MS + 50));

    // selectSession ran with full P1 semantics.
    const ui = core.ui.getState();
    expect(ui.selectedSession).toBe('s-old');
    expect(ui.selectedMachine).toBe(MACHINE);
    expect(ui.panelMode).toBe('session');
    expect(ui.unreadSessions.has(`${MACHINE} s-old`)).toBe(false);

    // CDX-024: sessionKey change → session-switch reset → the ONE pin-owner
    // effect scrolled the fresh transcript to its live end.
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('clamps at the edges: right swipe on the first session goes nowhere', async () => {
    mockMatchMedia(true);
    const core = await makeSessionCore(); // s-new selected = index 0
    vi.useFakeTimers();
    renderPanel(core);

    swipe(screen.getByTestId('main-panel'), 80);
    act(() => vi.advanceTimersByTime(1000));
    expect(core.ui.getState().selectedSession).toBe('s-new');
  });

  it('input bar stays outside the slide region (static while content slides)', async () => {
    mockMatchMedia(true);
    const core = await makeSessionCore();
    renderPanel(core);

    const slide = screen.getByTestId('session-slide');
    // The transcript slides…
    expect(within(slide).getByTestId('vlist')).toBeTruthy();
    // …the composer does not.
    expect(within(slide).queryByPlaceholderText('Message the session…')).toBeNull();
    expect(screen.getByPlaceholderText('Message the session…')).toBeTruthy();
  });

  it('attention chevrons point at waiting/unread sessions left and right (touch only)', async () => {
    mockMatchMedia(true);
    const core = await makeSessionCore();
    // s-old (to the RIGHT of s-new) waits on a permission.
    core.machines
      .getState()
      .applySessionUpsert(
        MACHINE,
        sessionInfo('s-old', {
          lastActivity: '2026-08-08T10:00:00.000Z',
          state: 'waiting_permission',
        }),
        0,
      );
    renderPanel(core);

    expect(screen.getByTestId('nav-hint-right')).toBeTruthy();
    expect(screen.queryByTestId('nav-hint-left')).toBeNull();

    // Now view s-old: s-new (to the LEFT) is unread → left chevron.
    act(() => {
      core.ui.getState().selectSession(MACHINE, 's-old');
      core.ui.getState().markSessionUnread(MACHINE, 's-new');
    });
    expect(screen.getByTestId('nav-hint-left')).toBeTruthy();
    expect(screen.queryByTestId('nav-hint-right')).toBeNull();

    // Fine pointer (fresh mount — media state is read at mount) → no hints.
    cleanup();
    mockMatchMedia(false);
    renderPanel(core);
    expect(screen.queryByTestId('nav-hint-left')).toBeNull();
    expect(screen.queryByTestId('nav-hint-right')).toBeNull();
  });

  it('no chevrons when nothing needs attention', async () => {
    mockMatchMedia(true);
    const core = await makeSessionCore();
    renderPanel(core);
    expect(screen.queryByTestId('nav-hint-left')).toBeNull();
    expect(screen.queryByTestId('nav-hint-right')).toBeNull();
  });
});

describe('DM swipe carousel (wrap)', () => {
  it('left swipe on the last conversation wraps to the first; right swipe wraps back', async () => {
    mockMatchMedia(true);
    vi.useFakeTimers();
    const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
    core.dm.getState().startConversation(PEER_C);
    vi.advanceTimersByTime(1000); // PEER_D newer → unified order [D, C]
    core.dm.getState().startConversation(PEER_D);
    core.ui.getState().selectDmPeer(PEER_C); // index 1 = last
    renderPanel(core);

    swipe(screen.getByTestId('main-panel'), -80);
    act(() => vi.advanceTimersByTime(SLIDE_DURATION_MS + 50));
    expect(core.ui.getState().activeDmPeer).toBe(PEER_D); // wrapped to index 0
    expect(core.ui.getState().panelMode).toBe('dm');

    act(() => vi.advanceTimersByTime(SWIPE_DEBOUNCE_MS));
    swipe(screen.getByTestId('main-panel'), 80);
    act(() => vi.advanceTimersByTime(SLIDE_DURATION_MS + 50));
    expect(core.ui.getState().activeDmPeer).toBe(PEER_C); // wrapped back to last
  });
});
