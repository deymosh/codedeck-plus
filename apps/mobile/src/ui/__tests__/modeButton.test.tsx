// @vitest-environment jsdom
/**
 * CDX-046 — the session header's permission mode is a tappable cycle button
 * (PLAN → YOLO → EDITS), not the read-only badge 0.9.0 shipped: a tap sends
 * the mode command optimistically (pending pulse), and the store's
 * mode-confirmed ingestion (onModeConfirmed → updateSessionInfo) is what both
 * settles the pending state and drives the displayed mode.
 *
 * Timing rules (cooldown / timeout-revert) are owned by core/modeCycle and
 * proven on virtual time in modeCycle.test.ts — this is the React wiring.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RemoteSessionInfo, SessionListMessage } from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../../core/createPhoneCore';
import { memoryKV, type PhoneTransport } from '../../core/ports';
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

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

async function makeCore(permissionMode: RemoteSessionInfo['permissionMode']): Promise<PhoneCore> {
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
  core.machines.getState().registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
  const heartbeat: SessionListMessage = {
    type: 'sessions',
    machine: 'laptop',
    sessions: [
      {
        id: 's1',
        slug: 's1',
        cwd: '/home/x/s1',
        lastActivity: '2026-08-08T10:00:00.000Z',
        lineCount: 0,
        title: null,
        project: 'proj-s1',
        ...(permissionMode ? { permissionMode } : {}),
      },
    ],
    protocolVersion: 10,
  };
  core.machines.getState().applySessionList(MACHINE, heartbeat, Date.now());
  return core;
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
    const core = await makeCore('plan');
    renderSession(core);

    const btn = screen.getByTestId('mode-button');
    expect(btn.tagName).toBe('BUTTON'); // pre-fix: a read-only <span> badge
    expect(btn.textContent).toBe('PLAN');
    expect(btn.className).toMatch(/boxed/); // CDX-045 rectangular language
  });

  it('tap sends the NEXT mode and pulses pending until mode-confirmed lands in the store', async () => {
    const core = await makeCore('plan');
    const modeChange = vi.spyOn(core.api, 'modeChange').mockResolvedValue(true);
    renderSession(core);

    fireEvent.click(screen.getByTestId('mode-button'));
    expect(modeChange).toHaveBeenCalledWith(MACHINE, 's1', 'default');

    // Optimistic display + pending pulse while the round-trip is in flight.
    const btn = screen.getByTestId('mode-button');
    expect(btn.textContent).toBe('YOLO');
    expect(btn.getAttribute('data-pending')).toBe('true');

    // mode-confirmed → machines store (the createPhoneCore onModeConfirmed
    // path) → pending settles, display stays on the confirmed mode.
    act(() => {
      core.machines.getState().updateSessionInfo(MACHINE, 's1', { permissionMode: 'default' });
    });
    expect(btn.textContent).toBe('YOLO');
    expect(btn.getAttribute('data-pending')).toBeNull();
  });

  it('a mode-confirmed from elsewhere (no tap) just updates the displayed mode', async () => {
    const core = await makeCore('plan');
    renderSession(core);

    act(() => {
      core.machines.getState().updateSessionInfo(MACHINE, 's1', {
        permissionMode: 'acceptEdits',
      });
    });
    const btn = screen.getByTestId('mode-button');
    expect(btn.textContent).toBe('EDITS');
    expect(btn.getAttribute('data-pending')).toBeNull();
  });
});
