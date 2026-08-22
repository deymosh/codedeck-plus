/**
 * Notifications (Phase 5c) — the pure decision function (event ×
 * app-visibility → notify or not), live-entry classification, formatting,
 * and the coordinator's cooldown dedup. All app-local state — no relay
 * sniffing anywhere (memory rule: never 1059-based detection).
 */
import { describe, it, expect } from 'vitest';
import type { OutputEntry } from '@codedeck/protocol';
import {
  classifyOutputEntry,
  createNotificationCoordinator,
  decideNotify,
  decidePing,
  formatNotifyEvent,
  notifyKey,
  NOTIFY_COOLDOWN_MS,
  type NotifyEvent,
} from '../notifications';
import { sessionKeyOf } from '../stores/ui';
import { finalizeEvent } from 'nostr-tools/pure';
import { encodeBridgeToPhone, LIVE_KIND, type BridgeToPhoneMessage } from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../createPhoneCore';
import { encryptTo, generateKeypair, type Keypair } from '../crypto';
import { memoryKV, type PhoneTransport } from '../ports';

const ALL_EVENTS: NotifyEvent[] = [
  { type: 'permission-request', machine: 'm1', sessionId: 's1', toolName: 'Bash' },
  { type: 'question', machine: 'm1', sessionId: 's1' },
  { type: 'plan-approval', machine: 'm1', sessionId: 's1' },
  { type: 'session-finished', machine: 'm1', sessionId: 's1' },
  { type: 'session-failed', machine: 'm1', sessionId: 's1', reason: 'boom' },
  { type: 'dm-received', peer: 'p1', peerLabel: 'alice', preview: 'hi' },
];

const entry = (partial: Partial<OutputEntry>): OutputEntry => ({
  entryType: 'system',
  content: '',
  timestamp: new Date(0).toISOString(),
  ...partial,
});

describe('decideNotify — the pure event × visibility decision', () => {
  it('hidden app → notify, for every event type', () => {
    for (const event of ALL_EVENTS) {
      expect(decideNotify(event, false), event.type).toBe(true);
    }
  });

  it('visible (foregrounded) app → suppressed, for every event type', () => {
    for (const event of ALL_EVENTS) {
      expect(decideNotify(event, true), event.type).toBe(false);
    }
  });
});

describe('decidePing — hidden OR not-viewing-this-session (CDX-026b chime rule)', () => {
  const permission = ALL_EVENTS[0]!; // machine m1, session s1
  const dm = ALL_EVENTS[5]!;
  const s1Key = sessionKeyOf('m1', 's1');

  it('hidden app → ping, for every event type, whatever is active', () => {
    for (const event of ALL_EVENTS) {
      expect(decidePing(event, false, s1Key), event.type).toBe(true);
      expect(decidePing(event, false, null), event.type).toBe(true);
    }
  });

  it('visible + a DIFFERENT session active → ping', () => {
    expect(decidePing(permission, true, sessionKeyOf('m1', 'OTHER'))).toBe(true);
    expect(decidePing(permission, true, sessionKeyOf('m2', 's1'))).toBe(true);
    expect(decidePing(permission, true, null)).toBe(true); // no session in view
  });

  it('visible + viewing exactly this session → no ping (the card on screen is the signal)', () => {
    expect(decidePing(permission, true, s1Key)).toBe(false);
  });

  it('DM events ping even when visible — the per-conversation unread gate upstream already excluded the open conversation', () => {
    expect(decidePing(dm, true, s1Key)).toBe(true);
    expect(decidePing(dm, true, null)).toBe(true);
  });
});

describe('classifyOutputEntry — live entries only, displayEntries vocabulary', () => {
  it('system special=permission_request → permission-request with tool name', () => {
    const e = entry({ metadata: { special: 'permission_request', tool_name: 'Bash' } });
    expect(classifyOutputEntry('m', 's', e)).toEqual({
      type: 'permission-request',
      machine: 'm',
      sessionId: 's',
      toolName: 'Bash',
    });
  });

  it('system special=ask_question / plan_approval → question / plan-approval', () => {
    expect(
      classifyOutputEntry('m', 's', entry({ metadata: { special: 'ask_question' } }))?.type,
    ).toBe('question');
    expect(
      classifyOutputEntry('m', 's', entry({ metadata: { special: 'plan_approval' } }))?.type,
    ).toBe('plan-approval');
  });

  it('system stream_end marker → session-finished', () => {
    expect(
      classifyOutputEntry('m', 's', entry({ metadata: { stream_end: true } }))?.type,
    ).toBe('session-finished');
  });

  it('error special=session_died/session_failed → session-failed with reason', () => {
    const e = entry({
      entryType: 'error',
      content: 'it died',
      metadata: { special: 'session_died' },
    });
    expect(classifyOutputEntry('m', 's', e)).toEqual({
      type: 'session-failed',
      machine: 'm',
      sessionId: 's',
      reason: 'it died',
    });
  });

  it('ordinary text/tool/system/error entries never notify', () => {
    expect(classifyOutputEntry('m', 's', entry({ entryType: 'text', content: 'hi' }))).toBeNull();
    expect(classifyOutputEntry('m', 's', entry({ entryType: 'tool_use' }))).toBeNull();
    expect(classifyOutputEntry('m', 's', entry({ content: 'status line' }))).toBeNull();
    expect(
      classifyOutputEntry('m', 's', entry({ entryType: 'error', content: 'generic' })),
    ).toBeNull();
  });
});

describe('formatNotifyEvent', () => {
  it('permission request names the tool; DM uses peer label + preview', () => {
    expect(formatNotifyEvent(ALL_EVENTS[0]!)).toEqual({
      title: 'Permission needed',
      body: 'Claude wants to use Bash',
    });
    expect(formatNotifyEvent(ALL_EVENTS[5]!)).toEqual({ title: 'alice', body: 'hi' });
  });
});

describe('coordinator — decision + cooldown → the Notifier port', () => {
  function makeCoordinator(visible: () => boolean) {
    let at = 0;
    const sent: Array<{ title: string; body: string }> = [];
    const coordinator = createNotificationCoordinator({
      notifier: { notify: (n) => sent.push(n) },
      visible,
      now: () => at,
    });
    return { coordinator, sent, tick: (ms: number) => (at += ms) };
  }

  it('delivers when hidden, suppresses when visible', () => {
    let visible = true;
    const { coordinator, sent } = makeCoordinator(() => visible);
    coordinator.emit(ALL_EVENTS[0]!);
    expect(sent).toHaveLength(0);
    visible = false;
    coordinator.emit(ALL_EVENTS[0]!);
    expect(sent).toHaveLength(1);
  });

  it('same session+type within the cooldown → one notification; distinct keys pass', () => {
    const { coordinator, sent, tick } = makeCoordinator(() => false);
    coordinator.emit(ALL_EVENTS[0]!);
    coordinator.emit(ALL_EVENTS[0]!); // duplicate, inside cooldown
    coordinator.emit(ALL_EVENTS[3]!); // different type → different key
    expect(sent).toHaveLength(2);
    tick(NOTIFY_COOLDOWN_MS);
    coordinator.emit(ALL_EVENTS[0]!); // cooldown elapsed
    expect(sent).toHaveLength(3);
  });

  it('notifyKey scopes sessions apart and DMs by peer', () => {
    expect(notifyKey(ALL_EVENTS[0]!)).not.toBe(
      notifyKey({ type: 'permission-request', machine: 'm1', sessionId: 'OTHER' }),
    );
    expect(notifyKey(ALL_EVENTS[5]!)).toBe(notifyKey({ type: 'dm-received', peer: 'p1' }));
  });
});

describe('coordinator — master toggle (CDX-048): disabled kills notify AND ping', () => {
  function makeToggledCoordinator() {
    let enabled = true;
    const sent: Array<{ title: string; body: string }> = [];
    const pings: number[] = [];
    const coordinator = createNotificationCoordinator({
      notifier: { notify: (n) => sent.push(n) },
      visible: () => false, // hidden — everything WOULD fire if enabled
      ping: () => pings.push(1),
      activeSessionKey: () => null,
      enabled: () => enabled,
      now: () => 0,
    });
    return { coordinator, sent, pings, setEnabled: (on: boolean) => (enabled = on) };
  }

  it('disabled → no OS notification and no chime, for every event type', () => {
    const { coordinator, sent, pings, setEnabled } = makeToggledCoordinator();
    setEnabled(false);
    for (const event of ALL_EVENTS) coordinator.emit(event);
    expect(sent).toHaveLength(0);
    expect(pings).toHaveLength(0);
  });

  it('re-enabling restores delivery, and the disabled emits burned no cooldown', () => {
    const { coordinator, sent, pings, setEnabled } = makeToggledCoordinator();
    setEnabled(false);
    coordinator.emit(ALL_EVENTS[0]!); // suppressed — must not consume the slot
    setEnabled(true);
    coordinator.emit(ALL_EVENTS[0]!); // same key, immediately after
    expect(sent).toHaveLength(1);
    expect(pings).toHaveLength(1);
  });
});

describe('coordinator — ping + notify share ONE cooldown; ping is permission-independent', () => {
  function makePingCoordinator(opts: {
    visible: () => boolean;
    activeSessionKey?: () => string | null;
    notifier?: { notify: (n: { title: string; body: string }) => void };
  }) {
    let at = 0;
    const sent: Array<{ title: string; body: string }> = [];
    const pings: number[] = [];
    const coordinator = createNotificationCoordinator({
      notifier: opts.notifier ?? { notify: (n) => sent.push(n) },
      visible: opts.visible,
      ping: () => pings.push(at),
      ...(opts.activeSessionKey ? { activeSessionKey: opts.activeSessionKey } : {}),
      now: () => at,
    });
    return { coordinator, sent, pings, tick: (ms: number) => (at += ms) };
  }

  it('hidden → one ping + one notification per session:type per cooldown window', () => {
    const { coordinator, sent, pings, tick } = makePingCoordinator({ visible: () => false });
    coordinator.emit(ALL_EVENTS[0]!);
    coordinator.emit(ALL_EVENTS[0]!); // duplicate inside cooldown → NEITHER fires
    expect(pings).toHaveLength(1);
    expect(sent).toHaveLength(1);
    tick(NOTIFY_COOLDOWN_MS);
    coordinator.emit(ALL_EVENTS[0]!);
    expect(pings).toHaveLength(2);
    expect(sent).toHaveLength(2);
  });

  it('visible + different session active → ping fires, OS notification suppressed', () => {
    const { coordinator, sent, pings } = makePingCoordinator({
      visible: () => true,
      activeSessionKey: () => sessionKeyOf('m1', 'OTHER'),
    });
    coordinator.emit(ALL_EVENTS[0]!); // m1 s1
    expect(pings).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('visible + viewing exactly the event session → nothing fires and no cooldown is burned', () => {
    let active: string | null = sessionKeyOf('m1', 's1');
    const { coordinator, sent, pings } = makePingCoordinator({
      visible: () => true,
      activeSessionKey: () => active,
    });
    coordinator.emit(ALL_EVENTS[0]!);
    expect(pings).toHaveLength(0);
    expect(sent).toHaveLength(0);
    // Immediately after switching away the same event may fire — the
    // suppressed emit must not have consumed the cooldown slot.
    active = null;
    coordinator.emit(ALL_EVENTS[0]!);
    expect(pings).toHaveLength(1);
  });

  it('ping fires even when OS delivery is denied (notifier is a no-op) or throws', () => {
    const denied = makePingCoordinator({
      visible: () => false,
      notifier: { notify: () => {} }, // permission denied → platform delivers nothing
    });
    denied.coordinator.emit(ALL_EVENTS[1]!);
    expect(denied.pings).toHaveLength(1);

    const throwing = makePingCoordinator({
      visible: () => false,
      notifier: {
        notify: () => {
          throw new Error('no permission');
        },
      },
    });
    expect(() => throwing.coordinator.emit(ALL_EVENTS[1]!)).toThrow();
    expect(throwing.pings).toHaveLength(1); // ping already fired — it comes first
  });
});

describe('phone-core wiring (live output path)', () => {
  const nullTransport: PhoneTransport = {
    subscribe: () => ({ close: () => {} }),
    publish: async () => true,
  };

  /** Encrypt + sign one bridge→phone message as the machine would. */
  function bridgeEvent(core: PhoneCore, machine: Keypair, msg: BridgeToPhoneMessage) {
    const phonePubkey = core.identity.getState().keypair.pubkeyHex;
    return finalizeEvent(
      {
        kind: LIVE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', phonePubkey]],
        content: encryptTo(machine.secretKey, phonePubkey, encodeBridgeToPhone(msg)),
      },
      machine.secretKey,
    );
  }

  it('a live permission_request entry notifies iff the app is hidden; sync path never does', async () => {
    const sent: Array<{ title: string; body: string }> = [];
    const core = await createPhoneCore({
      kv: memoryKV(),
      transport: nullTransport,
      notifier: { notify: (n) => sent.push(n) },
    });
    const machine = generateKeypair();
    core.machines.getState().registerMachine({
      pubkeyHex: machine.pubkeyHex,
      name: 'test machine',
      label: 'test',
    });
    const permissionEntry = entry({
      metadata: { special: 'permission_request', tool_name: 'Edit' },
    });

    // Foregrounded (initial FSM state is visible:true) → suppressed.
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'output',
        sessionId: 's1',
        seq: 1,
        entry: permissionEntry,
      }),
    );
    expect(sent).toHaveLength(0);

    // Hidden → notifies.
    core.connection.getState().dispatch({ type: 'visibility', visible: false });
    core.connection.getState().dispatch({ type: 'visibility-settled' });
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'output',
        sessionId: 's1',
        seq: 2,
        entry: permissionEntry,
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('Edit');

    // Sync catch-up (applySyncChunk path) carries the same entry — no notify
    // (replayed history must never fire a notification storm).
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'sync-chunk',
        sessionId: 's1',
        syncId: 'sync1',
        range: [3, 3],
        entries: [{ seq: 3, entry: permissionEntry }],
      }),
    );
    expect(sent).toHaveLength(1);
    await core.stop();
  });

  it('settings master toggle OFF → a hidden-app permission request neither notifies nor pings (CDX-048)', async () => {
    const sent: Array<{ title: string; body: string }> = [];
    const pings: number[] = [];
    const core = await createPhoneCore({
      kv: memoryKV(),
      transport: nullTransport,
      notifier: { notify: (n) => sent.push(n) },
      ping: () => pings.push(1),
    });
    const machine = generateKeypair();
    core.machines.getState().registerMachine({
      pubkeyHex: machine.pubkeyHex,
      name: 'test machine',
      label: 'test',
    });
    core.connection.getState().dispatch({ type: 'visibility', visible: false });
    core.connection.getState().dispatch({ type: 'visibility-settled' });
    const permissionEntry = entry({
      metadata: { special: 'permission_request', tool_name: 'Edit' },
    });

    core.settings.getState().setNotificationsEnabled(false);
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'output',
        sessionId: 's1',
        seq: 1,
        entry: permissionEntry,
      }),
    );
    expect(sent).toHaveLength(0);
    expect(pings).toHaveLength(0);

    // Flipping it back ON restores both channels (the same event key — the
    // suppressed emit burned no cooldown).
    core.settings.getState().setNotificationsEnabled(true);
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'output',
        sessionId: 's1',
        seq: 2,
        entry: permissionEntry,
      }),
    );
    expect(sent).toHaveLength(1);
    expect(pings).toHaveLength(1);
    await core.stop();
  });
});
