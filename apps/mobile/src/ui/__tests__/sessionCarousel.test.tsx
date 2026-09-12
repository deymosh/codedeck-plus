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
 *
 * Unread clearing on select and DM conversation creation are Rust's job now
 * (`Intent::SelectSession`/`Intent::StartDmConversation`); this file scripts
 * the fake core's dispatch to do just enough of that (or seeds the resulting
 * view directly) to exercise the carousel's own navigation/scroll/chevron
 * logic, which is still entirely a TS/React concern.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { OutputEntry, RemoteSessionInfo } from '../../core/nativeCoreTypes';
import { buildFakePhoneCore, tick } from '../../core/__tests__/nativeCoreFixture';
import type { DmConversation, MachineView } from '../../core/nativeCoreTypes';
import type { PhoneCore } from '../../core/phoneCore';
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
 *  transcript entry, s-new selected. `initialUnread` seeds sessions unread
 *  BEFORE mount (native `markSessionUnread` is a no-op — see nativeUi.ts). */
async function makeSessionCore(
  initialUnread: string[] = [],
  sessionOverrides: Record<string, Partial<RemoteSessionInfo>> = {},
) {
  const machine: MachineView = {
    pubkeyHex: MACHINE,
    name: 'laptop',
    capabilities: [],
    folders: [],
    roots: [],
    protocolVersion: null,
    machineOffline: false,
    lastHeartbeatAt: null,
    sessions: {
      's-new': {
        info: sessionInfo('s-new', { lastActivity: '2026-08-08T11:00:00.000Z', ...sessionOverrides['s-new'] }),
        presence: 'live',
        lastListedAt: 0,
      },
      's-old': {
        info: sessionInfo('s-old', { lastActivity: '2026-08-08T10:00:00.000Z', ...sessionOverrides['s-old'] }),
        presence: 'live',
        lastListedAt: 0,
      },
    },
  };
  const { phone, fake } = await buildFakePhoneCore({
    machines: { machines: { [MACHINE]: machine } },
    ui: {
      selectedMachine: MACHINE,
      selectedSession: 's-new',
      panelMode: 'session',
      activeDmPeer: null,
      activeMarmotGroup: null,
      unreadSessions: initialUnread.map((id) => `${MACHINE} ${id}`),
      respondedCards: {},
      planApprovalChoices: {},
      credentialsStatus: {},
      deviceConfigStatus: {},
      providerProfileStatus: {},
      undoToast: null,
    },
  });
  fake.setTranscript(MACHINE, 's-new', {
    rows: [{ seq: 1, entry: entry('hello new') }],
    haveRanges: [[1, 1]],
    sync: { state: 'idle', attempts: 0, nextRetryAt: null, localHigh: 1, target: 1, contiguous: true },
  });
  fake.setTranscript(MACHINE, 's-old', {
    rows: [{ seq: 1, entry: entry('hello old') }],
    haveRanges: [[1, 1]],
    sync: { state: 'idle', attempts: 0, nextRetryAt: null, localHigh: 1, target: 1, contiguous: true },
  });
  // selectSession's own optimistic set + dispatch clears the target
  // session's unread mark Rust-side — scripted here, see module doc.
  fake.onDispatch((intent) => {
    if (typeof intent === 'object' && intent.selectSession) {
      const { sessionId } = intent.selectSession;
      fake.setView('ui', {
        ...fake.views.ui,
        unreadSessions: fake.views.ui.unreadSessions.filter((k) => k !== `${MACHINE} ${sessionId}`),
      });
    }
  });
  return { core: phone, fake };
}

/** `SessionScreen`'s mount effect hydrates the transcript asynchronously
 *  (`core.transcript.getState().hydrateSession`) — await a tick so a seeded
 *  transcript has actually landed before a test inspects it. */
async function renderPanel(core: PhoneCore) {
  const result = render(
    <PhoneCoreProvider value={core}>
      <MainPanel isWide={true} onOpenSidebar={() => {}} />
    </PhoneCoreProvider>,
  );
  await act(async () => {
    await tick();
  });
  return result;
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
    const { core } = await makeSessionCore(['s-old']);
    vi.useFakeTimers();
    await renderPanel(core);

    scrollSpy.mockClear();
    swipe(screen.getByTestId('main-panel'), -80);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLIDE_DURATION_MS + 50);
    });

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
    const { core } = await makeSessionCore(); // s-new selected = index 0
    vi.useFakeTimers();
    await renderPanel(core);

    swipe(screen.getByTestId('main-panel'), 80);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(core.ui.getState().selectedSession).toBe('s-new');
  });

  it('input bar stays outside the slide region (static while content slides)', async () => {
    mockMatchMedia(true);
    const { core } = await makeSessionCore();
    await renderPanel(core);

    const slide = screen.getByTestId('session-slide');
    // The transcript slides…
    expect(within(slide).getByTestId('vlist')).toBeTruthy();
    // …the composer does not.
    expect(within(slide).queryByPlaceholderText('Message the session…')).toBeNull();
    expect(screen.getByPlaceholderText('Message the session…')).toBeTruthy();
  });

  it('attention chevrons point at waiting/unread sessions left and right (touch only)', async () => {
    mockMatchMedia(true);
    // s-old (to the RIGHT of s-new) waits on a permission.
    const { core } = await makeSessionCore([], { 's-old': { state: 'waiting_permission' } });
    await renderPanel(core);

    expect(screen.getByTestId('nav-hint-right')).toBeTruthy();
    expect(screen.queryByTestId('nav-hint-left')).toBeNull();

    // Now view s-old: s-new (to the LEFT) is unread → left chevron.
    core.ui.getState().selectSession(MACHINE, 's-old');
    cleanup();
    const { core: core2 } = await makeSessionCore(['s-new'], { 's-old': { state: 'waiting_permission' } });
    core2.ui.getState().selectSession(MACHINE, 's-old');
    await renderPanel(core2);
    expect(screen.getByTestId('nav-hint-left')).toBeTruthy();
    expect(screen.queryByTestId('nav-hint-right')).toBeNull();

    // Fine pointer (fresh mount — media state is read at mount) → no hints.
    cleanup();
    mockMatchMedia(false);
    await renderPanel(core2);
    expect(screen.queryByTestId('nav-hint-left')).toBeNull();
    expect(screen.queryByTestId('nav-hint-right')).toBeNull();
  });

  it('no chevrons when nothing needs attention', async () => {
    mockMatchMedia(true);
    const { core } = await makeSessionCore();
    await renderPanel(core);
    expect(screen.queryByTestId('nav-hint-left')).toBeNull();
    expect(screen.queryByTestId('nav-hint-right')).toBeNull();
  });
});

describe('DM swipe carousel (wrap)', () => {
  it('left swipe on the last conversation wraps to the first; right swipe wraps back', async () => {
    mockMatchMedia(true);
    vi.useFakeTimers();
    const dConv: DmConversation = {
      peerPubkey: PEER_D,
      protocol: 'nip17',
      lastMessageAt: 2000,
      unreadCount: 0,
      lastPreview: '',
    };
    const cConv: DmConversation = {
      peerPubkey: PEER_C,
      protocol: 'nip17',
      lastMessageAt: 1000,
      unreadCount: 0,
      lastPreview: '',
    };
    const { phone: core, fake } = await buildFakePhoneCore({
      dm: { conversations: [dConv, cConv], messages: {}, activePeer: PEER_C, eventsReceived: 0, unwrapFailures: 0, invalidRumors: 0 },
      ui: {
        selectedMachine: null,
        selectedSession: null,
        panelMode: 'dm',
        activeDmPeer: PEER_C, // index 1 = last
        activeMarmotGroup: null,
        unreadSessions: [],
        respondedCards: {},
        planApprovalChoices: {},
        credentialsStatus: {},
        deviceConfigStatus: {},
        providerProfileStatus: {},
        undoToast: null,
      },
    });
    fake.onDispatch((intent) => {
      if (typeof intent === 'object' && intent.selectDmPeer) {
        fake.setView('dm', { ...fake.views.dm!, activePeer: intent.selectDmPeer.peer });
      }
    });
    await renderPanel(core);

    swipe(screen.getByTestId('main-panel'), -80);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLIDE_DURATION_MS + 50);
    });
    expect(core.ui.getState().activeDmPeer).toBe(PEER_D); // wrapped to index 0
    expect(core.ui.getState().panelMode).toBe('dm');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SWIPE_DEBOUNCE_MS);
    });
    swipe(screen.getByTestId('main-panel'), 80);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLIDE_DURATION_MS + 50);
    });
    expect(core.ui.getState().activeDmPeer).toBe(PEER_C); // wrapped back to last
  });
});
