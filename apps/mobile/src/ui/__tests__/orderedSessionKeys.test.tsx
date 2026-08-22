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
import { createPhoneCore, type PhoneCore } from '../../core/createPhoneCore';
import { memoryKV, type PhoneTransport } from '../../core/ports';
import { PhoneCoreProvider } from '../coreContext';
import { getOrderedSessionKeys } from '../getOrderedSessionKeys';
import { Sidebar } from '../Sidebar';

afterEach(cleanup);

const M_ALPHA = 'a'.repeat(64);
const M_BETA = 'b'.repeat(64);

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

const sessionInfo = (id: string, lastActivity: string): RemoteSessionInfo => ({
  id,
  slug: id,
  cwd: `/home/x/${id}`,
  lastActivity,
  lineCount: 0,
  title: id,
  project: `proj-${id}`,
});

/** Two machines registered "wrong way round" (beta first), sessions upserted
 *  in scrambled activity order. */
async function makeCore(): Promise<PhoneCore> {
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
  const m = core.machines.getState();
  m.registerMachine({ pubkeyHex: M_BETA, name: 'zeppelin' });
  m.registerMachine({ pubkeyHex: M_ALPHA, name: 'anvil' });
  m.applySessionUpsert(M_BETA, sessionInfo('b-old', '2026-08-08T08:00:00.000Z'), 0);
  m.applySessionUpsert(M_BETA, sessionInfo('b-new', '2026-08-08T11:00:00.000Z'), 0);
  m.applySessionUpsert(M_ALPHA, sessionInfo('a-mid', '2026-08-08T10:00:00.000Z'), 0);
  m.applySessionUpsert(M_ALPHA, sessionInfo('a-new', '2026-08-08T12:00:00.000Z'), 0);
  m.applySessionUpsert(M_ALPHA, sessionInfo('a-old', '2026-08-08T09:00:00.000Z'), 0);
  return core;
}

describe('getOrderedSessionKeys', () => {
  it('orders machines by name asc, sessions by lastActivity desc', async () => {
    const core = await makeCore();
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
    const core = await makeCore();
    core.pendingSessions
      .getState()
      .applyPending(M_ALPHA, {
        pendingId: 'p1',
        machine: M_ALPHA,
        createdAt: '2026-08-08T12:30:00.000Z',
      });
    const keys = getOrderedSessionKeys(core.machines.getState().machines);
    expect(keys).toHaveLength(5);
    expect(keys.some((k) => k.sessionId === 'p1')).toBe(false);
  });

  it('divergence guard: sidebar session-card order equals the shared order', async () => {
    const core = await makeCore();
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
