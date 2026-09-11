// @vitest-environment jsdom
/**
 * CDX-046 — the session header's permission mode is a tappable cycle button
 * (PLAN → YOLO → EDITS), not the read-only badge 0.9.0 shipped: a tap sends
 * the mode command optimistically (pending pulse), and the store's
 * mode-confirmed ingestion is what both settles the pending state and drives
 * the displayed mode.
 *
 * Timing rules (cooldown / timeout-revert) are owned by core/modeCycle and
 * proven on virtual time in modeCycle.test.ts — this is the React wiring.
 * "mode-confirmed lands in the store" is Rust's `Router` folding the bridge
 * message into `MachinesView` now — scripted here via the fake core's
 * `machines` view rather than the deleted local `updateSessionInfo` call.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RemoteSessionInfo } from '@codedeck/protocol';
import { buildFakePhoneCore, tick } from '../../core/__tests__/nativeCoreFixture';
import type { FakeNativeCore } from '../../core/__tests__/nativeCoreFixture';
import type { MachineView } from '../../core/nativeCoreTypes';
import type { PhoneCore } from '../../core/phoneCore';
import { PhoneCoreProvider } from '../coreContext';
import { SessionScreen } from '../screens/SessionScreen';

afterEach(cleanup);

// virtua (TranscriptView) needs ResizeObserver; the attention chevrons read
// matchMedia. jsdom has neither — neither is under test here.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    class RO {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as Record<string, unknown>)['ResizeObserver'] = RO;
  }
  (window as unknown as Record<string, unknown>)['matchMedia'] = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
});

const MACHINE = 'a'.repeat(64);

const sessionInfo = (permissionMode: RemoteSessionInfo['permissionMode']): RemoteSessionInfo => ({
  id: 's1',
  slug: 's1',
  cwd: '/home/x/s1',
  lastActivity: '2026-08-08T10:00:00.000Z',
  lineCount: 0,
  title: null,
  project: 'proj-s1',
  ...(permissionMode ? { permissionMode } : {}),
});

function machineWith(permissionMode: RemoteSessionInfo['permissionMode']): MachineView {
  return {
    pubkeyHex: MACHINE,
    name: 'laptop',
    capabilities: [],
    folders: [],
    roots: [],
    protocolVersion: null,
    machineOffline: false,
    lastHeartbeatAt: null,
    sessions: { s1: { info: sessionInfo(permissionMode), presence: 'live', lastListedAt: 0 } },
  };
}

async function makeCore(permissionMode: RemoteSessionInfo['permissionMode']) {
  return buildFakePhoneCore({ machines: { machines: { [MACHINE]: machineWith(permissionMode) } } });
}

/** Simulates a `mode-confirmed` (or any) session-info update landing via the
 *  Rust `Router` — the native `machines` adapter has no write path of its
 *  own, so the test drives the view directly. */
async function updateSessionInfo(fake: FakeNativeCore, permissionMode: RemoteSessionInfo['permissionMode']): Promise<void> {
  await act(async () => {
    fake.setView('machines', { machines: { [MACHINE]: machineWith(permissionMode) } });
    await tick();
  });
}

function renderSession(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <SessionScreen machinePubkey={MACHINE} sessionId="s1" />
    </PhoneCoreProvider>,
  );
}

describe('mode cycle button (CDX-046)', () => {
  it('renders the confirmed mode as a tappable button with the legacy label', async () => {
    const { phone: core } = await makeCore('plan');
    renderSession(core);

    const btn = screen.getByTestId('mode-button');
    expect(btn.tagName).toBe('BUTTON'); // pre-fix: a read-only <span> badge
    expect(btn.textContent).toBe('PLAN');
    expect(btn.className).toMatch(/boxed/); // CDX-045 rectangular language
  });

  it('tap sends the NEXT mode and pulses pending until mode-confirmed lands in the store', async () => {
    const { phone: core, fake } = await makeCore('plan');
    const modeChange = vi.spyOn(core.api, 'modeChange').mockResolvedValue(true);
    renderSession(core);

    fireEvent.click(screen.getByTestId('mode-button'));
    expect(modeChange).toHaveBeenCalledWith(MACHINE, 's1', 'default');

    // Optimistic display + pending pulse while the round-trip is in flight.
    const btn = screen.getByTestId('mode-button');
    expect(btn.textContent).toBe('YOLO');
    expect(btn.getAttribute('data-pending')).toBe('true');

    // mode-confirmed → the Router folds it into MachinesView → pending
    // settles, display stays on the confirmed mode.
    await updateSessionInfo(fake, 'default');
    expect(btn.textContent).toBe('YOLO');
    expect(btn.getAttribute('data-pending')).toBeNull();
  });

  it('a mode-confirmed from elsewhere (no tap) just updates the displayed mode', async () => {
    const { phone: core, fake } = await makeCore('plan');
    renderSession(core);

    await updateSessionInfo(fake, 'acceptEdits');
    const btn = screen.getByTestId('mode-button');
    expect(btn.textContent).toBe('EDITS');
    expect(btn.getAttribute('data-pending')).toBeNull();
  });
});
