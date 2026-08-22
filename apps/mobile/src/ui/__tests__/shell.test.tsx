// @vitest-environment jsdom
/**
 * Phase 2a one-screen shell: Sidebar (machine groups, sorted session cards,
 * attention dot, pending cards, empty state), MainPanel (panelMode switch),
 * App (wide inline sidebar vs narrow drawer + scrim).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { RemoteSessionInfo } from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../../core/createPhoneCore';
import { memoryKV, type PhoneTransport } from '../../core/ports';
import { PhoneCoreProvider } from '../coreContext';
import { App } from '../App';
import { MainPanel } from '../MainPanel';
import { Sidebar } from '../Sidebar';

afterEach(cleanup);

const MACHINE = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

// virtua (TranscriptView) needs ResizeObserver; jsdom has none.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    class RO {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as Record<string, unknown>)['ResizeObserver'] = RO;
  }
});

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
  title: null,
  project: `proj-${id}`,
  ...over,
});

async function makeCore(withMachine = true): Promise<PhoneCore> {
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
  if (withMachine) {
    core.machines.getState().registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
  }
  return core;
}

const noop = (): void => {};

function renderSidebar(core: PhoneCore, over: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return render(
    <PhoneCoreProvider value={core}>
      <Sidebar onOpenSettings={noop} onOpenPairing={noop} {...over} />
    </PhoneCoreProvider>,
  );
}

describe('Sidebar', () => {
  it('committed badge shows by default and hides when "Show commit badge" is OFF (CDX-048)', async () => {
    const core = await makeCore();
    core.machines.getState().applySessionUpsert(
      MACHINE,
      sessionInfo('s1', { title: 'One', committed: true }),
      0,
    );
    renderSidebar(core);
    expect(screen.getByText('committed')).toBeTruthy();
    cleanup();

    core.settings.getState().setShowCommitBadge(false);
    renderSidebar(core);
    expect(screen.queryByText('committed')).toBeNull();
  });

  it('renders machine group with sessions sorted by lastActivity desc', async () => {
    const core = await makeCore();
    core.machines.getState().applySessionUpsert(
      MACHINE,
      sessionInfo('older', { title: 'Older', lastActivity: '2026-08-08T09:00:00.000Z' }),
      0,
    );
    core.machines.getState().applySessionUpsert(
      MACHINE,
      sessionInfo('newer', { title: 'Newer', lastActivity: '2026-08-08T11:00:00.000Z' }),
      0,
    );
    renderSidebar(core);

    expect(screen.getByText('laptop')).toBeTruthy();
    const cards = screen.getAllByTestId('session-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain('Newer');
    expect(cards[1]!.textContent).toContain('Older');
    // Meta line carries the project.
    expect(cards[0]!.textContent).toContain('proj-newer');
  });

  it('attention dot: waiting_permission and unread sessions breathe; idle does not', async () => {
    const core = await makeCore();
    core.machines.getState().applySessionUpsert(
      MACHINE,
      sessionInfo('waiting', { state: 'waiting_permission' }),
      0,
    );
    core.machines.getState().applySessionUpsert(MACHINE, sessionInfo('quiet', { state: 'idle' }), 0);
    core.machines.getState().applySessionUpsert(MACHINE, sessionInfo('unread', { state: 'idle' }), 0);
    core.ui.getState().markSessionUnread(MACHINE, 'unread');
    renderSidebar(core);

    expect(screen.getAllByLabelText('Needs attention')).toHaveLength(2);
  });

  it('tapping a card selects the session (panelMode session, unread cleared) and closes the drawer', async () => {
    const core = await makeCore();
    core.machines.getState().applySessionUpsert(MACHINE, sessionInfo('s1', { title: 'One' }), 0);
    core.ui.getState().markSessionUnread(MACHINE, 's1');
    const onSelected = vi.fn();
    renderSidebar(core, { onSessionSelected: onSelected });

    fireEvent.click(screen.getByTestId('session-card'));

    const ui = core.ui.getState();
    expect(ui.selectedMachine).toBe(MACHINE);
    expect(ui.selectedSession).toBe('s1');
    expect(ui.panelMode).toBe('session');
    expect(ui.isSessionUnread(MACHINE, 's1')).toBe(false);
    expect(onSelected).toHaveBeenCalledOnce();
  });

  it('per-machine + opens the NewSessionModal for that machine (Phase 2b)', async () => {
    const core = await makeCore();
    vi.spyOn(core.api, 'modelsRequest').mockResolvedValue(true);
    renderSidebar(core);

    expect(screen.queryByTestId('new-session-modal')).toBeNull();
    fireEvent.click(screen.getByLabelText('New session on laptop'));
    const modal = screen.getByTestId('new-session-modal');
    expect(modal).toBeTruthy();
    expect(screen.getByText('New session on laptop', { selector: 'h1' })).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByTestId('new-session-modal')).toBeNull();
  });

  it('renders the bottom-pinned DM section (Phase 2b)', async () => {
    const core = await makeCore();
    renderSidebar(core);
    const section = screen.getByTestId('dm-section');
    expect(section.textContent).toContain('Messages');
    expect(section.textContent).toContain('No conversations yet.');
  });

  it('pending cards render and a failed one dismisses', async () => {
    const core = await makeCore();
    core.pendingSessions
      .getState()
      .applyPending(MACHINE, { pendingId: 'p1', machine: 'laptop', createdAt: '2026-08-08' });
    core.pendingSessions
      .getState()
      .applyPending(MACHINE, { pendingId: 'p2', machine: 'laptop', createdAt: '2026-08-08' });
    core.pendingSessions.getState().applyFailed('p2', 'spawn exploded');
    renderSidebar(core);

    expect(screen.getByText('Starting session…')).toBeTruthy();
    expect(screen.getByText('spawn exploded')).toBeTruthy();
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByText('spawn exploded')).toBeNull();
  });

  it('no machines → empty state with a Pair a machine action', async () => {
    const core = await makeCore(false);
    const onOpenPairing = vi.fn();
    renderSidebar(core, { onOpenPairing });

    fireEvent.click(screen.getByText('Pair a machine'));
    expect(onOpenPairing).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('session-card')).toBeNull();
  });

  it('header gear and pair buttons call their handlers', async () => {
    const core = await makeCore();
    const onOpenSettings = vi.fn();
    const onOpenPairing = vi.fn();
    renderSidebar(core, { onOpenSettings, onOpenPairing });

    fireEvent.click(screen.getByLabelText('Settings'));
    fireEvent.click(screen.getByLabelText('Pair a machine'));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onOpenPairing).toHaveBeenCalledOnce();
  });
});

function renderPanel(core: PhoneCore, isWide = true, onOpenSidebar = noop) {
  return render(
    <PhoneCoreProvider value={core}>
      <MainPanel isWide={isWide} onOpenSidebar={onOpenSidebar} />
    </PhoneCoreProvider>,
  );
}

describe('MainPanel', () => {
  // Phase 8: MainPanel hosts the swipe carousel, whose coarse-pointer gate
  // reads matchMedia — give jsdom one (fine pointer; swiping isn't under test).
  beforeEach(() => mockMatchMedia(false));

  it('nothing selected → empty placeholder', async () => {
    const core = await makeCore();
    renderPanel(core);
    expect(screen.getByTestId('main-panel-empty')).toBeTruthy();
    expect(screen.getByText('Select a session')).toBeTruthy();
  });

  it('panelMode session + selection → SessionScreen', async () => {
    const core = await makeCore();
    core.machines.getState().applySessionUpsert(MACHINE, sessionInfo('s1'), 0);
    core.ui.getState().selectSession(MACHINE, 's1');
    renderPanel(core);

    expect(screen.queryByTestId('main-panel-empty')).toBeNull();
    // SessionScreen header: effort selector + the session's cwd.
    expect(screen.getByLabelText('Effort')).toBeTruthy();
    expect(screen.getByText('/home/x/s1')).toBeTruthy();
    // CDX-044: the model is chosen ONCE at create time (NewSessionModal), so
    // the session header carries no model dropdown any more. It used to.
    expect(screen.queryByLabelText('Model')).toBeNull();
    // CDX-087: but it DOES carry a read-only model label. Removing the control
    // is the decision; losing the indicator was the accident.
    expect(screen.getByTestId('model-tag')).toBeTruthy();
  });

  it('panelMode dm → DmChatScreen (with drawer access bar on narrow)', async () => {
    const core = await makeCore();
    core.ui.getState().selectDmPeer(PEER);
    renderPanel(core, false);

    expect(screen.queryByTestId('main-panel-empty')).toBeNull();
    expect(screen.getByLabelText('Open sessions')).toBeTruthy();
  });

  it('panelMode marmot → MarmotChatScreen', async () => {
    const core = await makeCore();
    core.ui.getState().selectMarmotGroup('group-1');
    renderPanel(core);

    expect(screen.getByTestId('marmot-chat')).toBeTruthy();
  });
});

function renderApp(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <App />
    </PhoneCoreProvider>,
  );
}

describe('App shell', () => {
  it('wide → inline sidebar, no drawer/scrim', async () => {
    mockMatchMedia(true);
    const core = await makeCore();
    renderApp(core);

    expect(screen.getByTestId('sidebar')).toBeTruthy();
    expect(screen.queryByTestId('drawer')).toBeNull();
    expect(screen.queryByTestId('scrim')).toBeNull();
    expect(screen.getByTestId('main-panel-empty')).toBeTruthy();
  });

  it('narrow → drawer open by default (nothing selected); scrim tap closes it', async () => {
    mockMatchMedia(false);
    const core = await makeCore();
    renderApp(core);

    const drawer = screen.getByTestId('drawer');
    expect(drawer.getAttribute('data-open')).toBe('true');
    fireEvent.click(screen.getByTestId('scrim'));
    expect(screen.getByTestId('drawer').getAttribute('data-open')).toBe('false');
    expect(screen.queryByTestId('scrim')).toBeNull();
    // The empty panel offers the way back in.
    fireEvent.click(screen.getByText('☰ Sessions'));
    expect(screen.getByTestId('drawer').getAttribute('data-open')).toBe('true');
  });

  it('narrow: selecting a session closes the drawer and shows the session', async () => {
    mockMatchMedia(false);
    const core = await makeCore();
    core.machines.getState().applySessionUpsert(MACHINE, sessionInfo('s1', { title: 'One' }), 0);
    renderApp(core);

    fireEvent.click(within(screen.getByTestId('sidebar')).getByTestId('session-card'));
    expect(screen.getByTestId('drawer').getAttribute('data-open')).toBe('false');
    expect(screen.getByText('/home/x/s1')).toBeTruthy();
    // Narrow session header carries the drawer trigger.
    expect(screen.getByLabelText('Open sessions')).toBeTruthy();
  });

  it('no machines → pairing overlay auto-opens (first-run), closable', async () => {
    mockMatchMedia(true);
    const core = await makeCore(false);
    renderApp(core);

    expect(screen.getByTestId('screen-overlay')).toBeTruthy();
    expect(screen.getByText('Pair a machine', { selector: 'h1' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByText('Pair a machine', { selector: 'h1' })).toBeNull();
  });

  it('gear opens Settings on a ScreenOverlay, ✕ closes it (Phase 2b)', async () => {
    mockMatchMedia(true);
    const core = await makeCore();
    renderApp(core);

    fireEvent.click(screen.getByLabelText('Settings'));
    expect(screen.getByTestId('screen-overlay')).toBeTruthy();
    expect(screen.getByText('Settings', { selector: 'h1' })).toBeTruthy();
    // SettingsScreen content actually rendered inside the overlay.
    expect(screen.getByLabelText('UI scale')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByText('Settings', { selector: 'h1' })).toBeNull();
  });
});
