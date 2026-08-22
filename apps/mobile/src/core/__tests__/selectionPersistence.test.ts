/**
 * CDX-054 — the selected session survives a WebView reload (activity
 * recreation on a configuration change / fold-unfold). The manifest's
 * `density` configChanges addition is the device-side primary fix; this file
 * proves the belt-and-braces path: selection persisted through KV, timestamp
 * refreshed on selection change AND on the raw app-hide signal, restored on a
 * fresh core within the TTL — and deliberately NOT restored on a cold start
 * (TTL expired), for a vanished session, or after deselection.
 */
import { describe, it, expect } from 'vitest';
import {
  LAST_SELECTION_KEY,
  SELECTION_RESTORE_TTL_MS,
  decodeSelection,
  encodeSelection,
  isRestorable,
} from '../selectionPersistence';
import { createPhoneCore } from '../createPhoneCore';
import { generateKeypair } from '../crypto';
import { memoryKV, type KV, type PhoneTransport } from '../ports';
import { PROTOCOL_VERSION, type RemoteSessionInfo } from '@codedeck/protocol';

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

const info = (id: string): RemoteSessionInfo => ({
  id,
  slug: `slug-${id}`,
  cwd: '/work',
  lastActivity: new Date(0).toISOString(),
  lineCount: 0,
  title: null,
  project: 'proj',
});

async function makeCore(kv: KV, now: () => number, machinePubkey?: string) {
  const machine = machinePubkey ?? generateKeypair().pubkeyHex;
  const core = await createPhoneCore({ kv, transport: nullTransport, now });
  if (!core.machines.getState().machine(machine)) {
    core.machines.getState().registerMachine({ pubkeyHex: machine, name: 'm', label: 'm' });
  }
  core.machines.getState().applySessionList(
    machine,
    { type: 'sessions', machine: 'm', sessions: [info('s1')], protocolVersion: PROTOCOL_VERSION },
    now(),
  );
  return { core, machine };
}

describe('selectionPersistence — encode/decode', () => {
  it('round-trips; garbage and partial records decode to null', () => {
    const sel = { machine: 'm1', sessionId: 's1', at: 42 };
    expect(decodeSelection(encodeSelection(sel))).toEqual(sel);
    expect(decodeSelection(undefined)).toBeNull();
    expect(decodeSelection('not json')).toBeNull();
    expect(decodeSelection('{"machine":"m1"}')).toBeNull();
    expect(decodeSelection('{"machine":"","sessionId":"s","at":1}')).toBeNull();
    expect(decodeSelection('{"machine":"m","sessionId":"s","at":"soon"}')).toBeNull();
  });

  it('isRestorable: fresh within the TTL, stale beyond it', () => {
    const sel = { machine: 'm', sessionId: 's', at: 1_000 };
    expect(isRestorable(sel, 1_000 + SELECTION_RESTORE_TTL_MS)).toBe(true);
    expect(isRestorable(sel, 1_000 + SELECTION_RESTORE_TTL_MS + 1)).toBe(false);
    expect(isRestorable(null, 0)).toBe(false);
  });

  it('isRestorable: a backward clock correction (record stamped in the future) is NOT restorable', () => {
    // Android boots with the RTC ahead and NTP corrects it seconds later, so
    // `now` legitimately moves BACKWARDS across a reload. Pre-fix `now - at <=
    // TTL` was true for every negative delta, so a stale selection stayed
    // restorable indefinitely — the 60 s invariant only held forwards.
    const sel = { machine: 'm', sessionId: 's', at: 1_000_000 };
    expect(isRestorable(sel, 1_000_000)).toBe(true); // zero delta: the fresh boundary
    expect(isRestorable(sel, 999_999)).toBe(false); // 1 ms backwards
    expect(isRestorable(sel, 1_000_000 - 6 * 3_600_000)).toBe(false); // RTC six hours ahead
  });
});

describe('phone-core wiring — selection survives a reboot within the TTL', () => {
  it('select → reload (same KV, seconds later) → selection restored', async () => {
    let at = 1_000_000;
    const kv = memoryKV();
    const { core, machine } = await makeCore(kv, () => at);
    core.ui.getState().selectSession(machine, 's1');
    await core.stop();

    at += 2_000; // a recreation reloads within seconds
    const { core: rebooted } = await makeCore(kv, () => at, machine);
    expect(rebooted.ui.getState().selectedMachine).toBe(machine);
    expect(rebooted.ui.getState().selectedSession).toBe('s1');
    expect(rebooted.ui.getState().panelMode).toBe('session');
    await rebooted.stop();
  });

  it('a cold start (TTL expired) opens with no selection — drawer home survives', async () => {
    let at = 1_000_000;
    const kv = memoryKV();
    const { core, machine } = await makeCore(kv, () => at);
    core.ui.getState().selectSession(machine, 's1');
    await core.stop();

    at += SELECTION_RESTORE_TTL_MS + 1;
    const { core: rebooted } = await makeCore(kv, () => at, machine);
    expect(rebooted.ui.getState().selectedSession).toBeNull();
    await rebooted.stop();
  });

  it('the app-hide signal refreshes the timestamp — a fold after long reading still restores', async () => {
    let at = 1_000_000;
    const kv = memoryKV();
    const { core, machine } = await makeCore(kv, () => at);
    core.ui.getState().selectSession(machine, 's1');

    at += 10 * 60_000; // ten minutes of reading, no selection change
    // The fold: onPause fires visibilitychange (raw hide) right before the
    // WebView dies — the settle event may never come.
    core.connection.getState().dispatch({ type: 'visibility', visible: false });
    await core.stop();

    at += 2_000;
    const { core: rebooted } = await makeCore(kv, () => at, machine);
    expect(rebooted.ui.getState().selectedSession).toBe('s1');
    await rebooted.stop();
  });

  it('a selection pointing at a session that no longer exists is not restored', async () => {
    let at = 1_000_000;
    const kv = memoryKV();
    await kv.set(
      LAST_SELECTION_KEY,
      encodeSelection({ machine: 'f'.repeat(64), sessionId: 'ghost', at }),
    );
    at += 1_000;
    const { core } = await makeCore(kv, () => at);
    expect(core.ui.getState().selectedSession).toBeNull();
    await core.stop();
  });

  it('deselection (machine cleared) removes the record — no zombie restore', async () => {
    let at = 1_000_000;
    const kv = memoryKV();
    const { core, machine } = await makeCore(kv, () => at);
    core.ui.getState().selectSession(machine, 's1');
    core.ui.getState().selectMachine(null); // back to no-selection
    await core.stop();

    at += 1_000;
    const { core: rebooted } = await makeCore(kv, () => at, machine);
    expect(rebooted.ui.getState().selectedSession).toBeNull();
    await rebooted.stop();
  });
});
