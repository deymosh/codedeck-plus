/**
 * deleteController (Phase 3) — optimistic swipe-to-delete with a 4s undo:
 * delete→undo restores the identical SessionView; delete→4s sends exactly ONE
 * close-session; a heartbeat during the window cannot resurrect the card but
 * after undo merges normally again; a second delete commits the first
 * immediately; dismissed entries prune after 1h; and the dismissed map never
 * round-trips through the KV.
 */
import { describe, expect, it, vi } from 'vitest';
import { ManualTimers } from '@codedeck/testkit';
import type { RemoteSessionInfo, SessionListMessage } from '@codedeck/protocol';
import { PROTOCOL_VERSION } from '@codedeck/protocol';
import { createPhoneCore } from '../createPhoneCore';
import { memoryKV, type PhoneTransport } from '../ports';
import { UNDO_DELAY_MS } from '../deleteController';
import { DISMISSED_TTL_MS } from '../stores/machines';

const MACHINE = 'a'.repeat(64);

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

const info = (id: string, patch: Partial<RemoteSessionInfo> = {}): RemoteSessionInfo => ({
  id,
  slug: `slug-${id}`,
  cwd: `/work/${id}`,
  lastActivity: '2026-08-08T10:00:00.000Z',
  lineCount: 0,
  title: null,
  project: `proj-${id}`,
  ...patch,
});

const list = (sessions: RemoteSessionInfo[]): SessionListMessage => ({
  type: 'sessions',
  machine: 'laptop',
  sessions,
  protocolVersion: PROTOCOL_VERSION,
});

async function harness() {
  const timers = new ManualTimers();
  let nowMs = 1_000_000;
  const kv = memoryKV();
  const core = await createPhoneCore({
    kv,
    transport: nullTransport,
    timers,
    now: () => nowMs,
  });
  core.machines.getState().registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
  const closeSpy = vi.spyOn(core.api, 'closeSession').mockResolvedValue(true);
  /** Advance the injected clock AND the injected timers together. */
  const advance = (ms: number): void => {
    nowMs += ms;
    timers.advance(ms);
  };
  return { core, kv, closeSpy, advance, now: () => nowMs };
}

describe('deleteController', () => {
  it('delete → undo restores the identical SessionView and cancels the close-session', async () => {
    const { core, closeSpy, advance, now } = await harness();
    core.machines.getState().applySessionList(MACHINE, list([info('s1', { title: 'One' })]), now());
    core.machines.getState().applyUsage(MACHINE, 's1', {
      available: true,
      subscriptionType: 'max',
      fiveHour: { utilization: 42, resetsAt: null },
      fetchedAt: '2026-08-08T10:00:00.000Z',
    });
    const before = core.machines.getState().session(MACHINE, 's1');
    expect(before).toBeDefined();

    core.deleteSession(MACHINE, 's1', 'One');
    expect(core.machines.getState().session(MACHINE, 's1')).toBeUndefined();
    expect(core.ui.getState().undoToast).toEqual({ machine: MACHINE, sessionId: 's1', label: 'One' });

    advance(2_000);
    core.undoDelete();

    // Deep-equal restore, per-session extras (usage) included.
    expect(core.machines.getState().session(MACHINE, 's1')).toEqual(before);
    expect(core.ui.getState().undoToast).toBeNull();

    // The armed timer is dead — no close-session ever leaves.
    advance(60_000);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('delete → 4s fires exactly ONE close-session and clears the toast', async () => {
    const { core, closeSpy, advance, now } = await harness();
    core.machines.getState().applySessionList(MACHINE, list([info('s1')]), now());

    core.deleteSession(MACHINE, 's1');
    advance(UNDO_DELAY_MS - 1);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(core.ui.getState().undoToast).not.toBeNull();

    advance(1);
    expect(closeSpy).toHaveBeenCalledExactlyOnceWith(MACHINE, 's1');
    expect(core.ui.getState().undoToast).toBeNull();

    // Nothing else pending: more time, more undo taps — still one send.
    core.undoDelete();
    advance(60_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(core.machines.getState().session(MACHINE, 's1')).toBeUndefined();
  });

  it('a heartbeat during the undo window does NOT resurrect the dismissed session', async () => {
    const { core, advance, now } = await harness();
    core.machines.getState().applySessionList(MACHINE, list([info('s1'), info('s2')]), now());

    core.deleteSession(MACHINE, 's1');
    advance(1_000);
    core.machines.getState().applySessionList(MACHINE, list([info('s1'), info('s2')]), now());

    expect(core.machines.getState().session(MACHINE, 's1')).toBeUndefined();
    expect(core.machines.getState().session(MACHINE, 's2')).toBeDefined();
  });

  it('after undo a heartbeat DOES merge the session normally again', async () => {
    const { core, advance, now } = await harness();
    core.machines.getState().applySessionList(MACHINE, list([info('s1')]), now());

    core.deleteSession(MACHINE, 's1');
    core.undoDelete();
    advance(1_000);
    core.machines.getState().applySessionList(MACHINE, list([info('s1', { title: 'Fresh' })]), now());

    const view = core.machines.getState().session(MACHINE, 's1');
    expect(view?.info.title).toBe('Fresh');
    expect(view?.presence).toBe('live');
  });

  it('a second delete while one is pending commits the first immediately', async () => {
    const { core, closeSpy, advance, now } = await harness();
    core.machines.getState().applySessionList(MACHINE, list([info('s1'), info('s2')]), now());

    core.deleteSession(MACHINE, 's1', 'First');
    advance(1_000);
    core.deleteSession(MACHINE, 's2', 'Second');

    // First committed NOW (not at its 4s mark); toast switched to the second.
    expect(closeSpy).toHaveBeenCalledExactlyOnceWith(MACHINE, 's1');
    expect(core.ui.getState().undoToast?.label).toBe('Second');

    // Undo now only rescues the SECOND delete.
    core.undoDelete();
    expect(core.machines.getState().session(MACHINE, 's1')).toBeUndefined();
    expect(core.machines.getState().session(MACHINE, 's2')).toBeDefined();

    advance(60_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('dismissed entries prune after 1h — the bridge is trusted again', async () => {
    const { core, advance, now } = await harness();
    core.machines.getState().applySessionList(MACHINE, list([info('s1')]), now());

    core.deleteSession(MACHINE, 's1');
    advance(UNDO_DELAY_MS); // commit (bridge never processes it in this test)

    // Just inside the TTL: still shielded.
    advance(DISMISSED_TTL_MS - UNDO_DELAY_MS - 1);
    core.machines.getState().applySessionList(MACHINE, list([info('s1')]), now());
    expect(core.machines.getState().session(MACHINE, 's1')).toBeUndefined();

    // At/after the TTL: pruned, session merges again.
    advance(1);
    core.machines.getState().applySessionList(MACHINE, list([info('s1')]), now());
    expect(core.machines.getState().session(MACHINE, 's1')).toBeDefined();
    expect(core.machines.getState().dismissedSessions).toEqual({});
  });

  it('the dismissed map never round-trips through the KV', async () => {
    const { core, kv, now } = await harness();
    core.machines.getState().applySessionList(MACHINE, list([info('s1')]), now());
    core.deleteSession(MACHINE, 's1');
    expect(core.machines.getState().dismissedSessions['s1']).toBeDefined();

    for (const [, value] of kv.dump()) {
      expect(value).not.toContain('dismissed');
    }

    // A second core over the same KV boots with an empty dismissed map.
    const rebooted = await createPhoneCore({ kv, transport: nullTransport });
    expect(rebooted.machines.getState().dismissedSessions).toEqual({});
  });

  it('deleting the selected session clears the selection and its unread dot', async () => {
    const { core, now } = await harness();
    core.machines.getState().applySessionList(MACHINE, list([info('s1')]), now());
    core.ui.getState().selectSession(MACHINE, 's1');
    core.ui.getState().markSessionUnread(MACHINE, 's1');

    core.deleteSession(MACHINE, 's1');

    expect(core.ui.getState().selectedSession).toBeNull();
    expect(core.ui.getState().isSessionUnread(MACHINE, 's1')).toBe(false);
  });

  it('deleting an unknown session is a harmless no-op', async () => {
    const { core, closeSpy, advance } = await harness();
    core.deleteSession(MACHINE, 'ghost');
    expect(core.ui.getState().undoToast).toBeNull();
    advance(60_000);
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
