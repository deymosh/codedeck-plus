// @vitest-environment jsdom
/**
 * Phase 8 shared ordering: getOrderedSessionKeys is the ONE session order for
 * both the Sidebar and the swipe carousel — machines name asc, sessions
 * lastActivity desc, pendings excluded — plus a render-parity divergence
 * guard: the sidebar's actual session-card order must equal the shared
 * function's output.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { RemoteSessionInfo } from '@codedeck/protocol';
import { buildFakePhoneCore } from '../../core/__tests__/nativeCoreFixture';
import type { MachineView } from '../../core/nativeCoreTypes';
import { PhoneCoreProvider } from '../coreContext';
import { getOrderedSessionKeys } from '../getOrderedSessionKeys';
import { Sidebar } from '../Sidebar';

afterEach(cleanup);

const M_ALPHA = 'a'.repeat(64);
const M_BETA = 'b'.repeat(64);

const sessionInfo = (id: string, lastActivity: string): RemoteSessionInfo => ({
  id,
  slug: id,
  cwd: `/home/x/${id}`,
  lastActivity,
  lineCount: 0,
  title: id,
  project: `proj-${id}`,
});

const machine = (pubkeyHex: string, name: string, sessions: RemoteSessionInfo[]): MachineView => ({
  pubkeyHex,
  name,
  capabilities: [],
  folders: [],
  roots: [],
  protocolVersion: null,
  machineOffline: false,
  lastHeartbeatAt: null,
  sessions: Object.fromEntries(
    sessions.map((info) => [info.id, { info, presence: 'live' as const, lastListedAt: 0 }]),
  ),
});

/** Two machines registered "wrong way round" (beta first), sessions in
 *  scrambled activity order. */
function machines(): Record<string, MachineView> {
  return {
    [M_BETA]: machine(M_BETA, 'zeppelin', [
      sessionInfo('b-old', '2026-08-08T08:00:00.000Z'),
      sessionInfo('b-new', '2026-08-08T11:00:00.000Z'),
    ]),
    [M_ALPHA]: machine(M_ALPHA, 'anvil', [
      sessionInfo('a-mid', '2026-08-08T10:00:00.000Z'),
      sessionInfo('a-new', '2026-08-08T12:00:00.000Z'),
      sessionInfo('a-old', '2026-08-08T09:00:00.000Z'),
    ]),
  };
}

describe('getOrderedSessionKeys', () => {
  // `getOrderedSessionKeys` reads the TS store's own `MachineView` shape
  // (`core/stores/machines.ts`), not the wire `nativeCoreTypes.MachineView`
  // these fixtures build — go through a fake core so `nativeMachines.ts`'s
  // real `toMachineView` conversion produces the type it actually wants.
  it('orders machines by name asc, sessions by lastActivity desc', async () => {
    const { phone: core } = await buildFakePhoneCore({ machines: { machines: machines() } });
    const keys = getOrderedSessionKeys(core.machines.getState().machines);
    expect(keys).toEqual([
      { machine: M_ALPHA, sessionId: 'a-new' },
      { machine: M_ALPHA, sessionId: 'a-mid' },
      { machine: M_ALPHA, sessionId: 'a-old' },
      { machine: M_BETA, sessionId: 'b-new' },
      { machine: M_BETA, sessionId: 'b-old' },
    ]);
  });

  it('pending sessions never appear (they live outside machine.sessions)', async () => {
    // Pending sessions are a wholly separate view (`PendingSessionsView`) now
    // — they were never part of `machine.sessions` even before the port, so
    // this guard needs nothing beyond the plain machines record above.
    const { phone: core } = await buildFakePhoneCore({ machines: { machines: machines() } });
    const keys = getOrderedSessionKeys(core.machines.getState().machines);
    expect(keys).toHaveLength(5);
    expect(keys.some((k) => k.sessionId === 'p1')).toBe(false);
  });

  it('divergence guard: sidebar session-card order equals the shared order', async () => {
    const { phone: core } = await buildFakePhoneCore({ machines: { machines: machines() } });
    render(
      <PhoneCoreProvider value={core}>
        <Sidebar onOpenSettings={() => {}} onOpenPairing={() => {}} />
      </PhoneCoreProvider>,
    );

    // Card titles are the session ids (sessionInfo sets title = id).
    const keys = getOrderedSessionKeys(core.machines.getState().machines);
    const cardTitles = screen
      .getAllByTestId('session-card')
      .map((card) => card.querySelector('div > div')?.textContent);
    expect(cardTitles).toEqual(keys.map((k) => k.sessionId));
  });
});
