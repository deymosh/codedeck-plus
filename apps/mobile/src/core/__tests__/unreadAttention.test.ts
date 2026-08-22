/**
 * Per-session unread + attention (Phase 1, CDX-026b): the sessionNeedsAttention
 * predicate, the ui store's unread set / panel-mode state, and the phone-core
 * wiring — live card entries and heartbeat waiting-transitions mark unread,
 * plain live output ("agent working") clears it, viewing/replying clears it,
 * and the heartbeat transition path notifies a backgrounded phone that never
 * saw the live card.
 */
import { describe, it, expect } from 'vitest';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  encodeBridgeToPhone,
  LIVE_KIND,
  PROTOCOL_VERSION,
  type BridgeToPhoneMessage,
  type OutputEntry,
  type RemoteSessionInfo,
} from '@codedeck/protocol';
import { sessionNeedsAttention } from '../sessionNeedsAttention';
import { createUiStore, sessionKeyOf } from '../stores/ui';
import { NOTIFY_COOLDOWN_MS, dmNotifyTag, sessionNotifyTag } from '../notifications';
import { createPhoneCore, type PhoneCore, type PhoneCoreDeps } from '../createPhoneCore';
import { encryptTo, generateKeypair, type Keypair } from '../crypto';
import { memoryKV, type PhoneTransport } from '../ports';

describe('sessionNeedsAttention — the single attention predicate', () => {
  it('waiting states light up regardless of unread; unread lights up regardless of state', () => {
    expect(sessionNeedsAttention('waiting_permission', false)).toBe(true);
    expect(sessionNeedsAttention('waiting_question', false)).toBe(true);
    expect(sessionNeedsAttention('running', true)).toBe(true);
    expect(sessionNeedsAttention(undefined, true)).toBe(true);
  });

  it('everything else is quiet', () => {
    expect(sessionNeedsAttention('running', false)).toBe(false);
    expect(sessionNeedsAttention('idle', false)).toBe(false);
    expect(sessionNeedsAttention('offline', false)).toBe(false);
    expect(sessionNeedsAttention(undefined, false)).toBe(false);
  });
});

describe('ui store — unread set + panel mode', () => {
  it('mark/clear/isSessionUnread round-trip, keyed per machine+session', () => {
    const ui = createUiStore();
    ui.getState().markSessionUnread('m1', 's1');
    expect(ui.getState().isSessionUnread('m1', 's1')).toBe(true);
    expect(ui.getState().isSessionUnread('m1', 's2')).toBe(false);
    expect(ui.getState().isSessionUnread('m2', 's1')).toBe(false);
    expect(ui.getState().unreadSessions.has(sessionKeyOf('m1', 's1'))).toBe(true);
    ui.getState().clearSessionUnread('m1', 's1');
    expect(ui.getState().isSessionUnread('m1', 's1')).toBe(false);
  });

  it('mark is idempotent and clear of an unmarked session is a no-op (no state churn)', () => {
    const ui = createUiStore();
    ui.getState().markSessionUnread('m1', 's1');
    const after = ui.getState().unreadSessions;
    ui.getState().markSessionUnread('m1', 's1');
    expect(ui.getState().unreadSessions).toBe(after); // same Set instance
    ui.getState().clearSessionUnread('m1', 'NEVER-MARKED');
    expect(ui.getState().unreadSessions).toBe(after);
  });

  it('selectSession clears unread when visible, keeps it when hidden', () => {
    let visible = true;
    const ui = createUiStore({ visible: () => visible });
    ui.getState().markSessionUnread('m1', 's1');
    ui.getState().selectSession('m1', 's1');
    expect(ui.getState().isSessionUnread('m1', 's1')).toBe(false);

    visible = false;
    ui.getState().markSessionUnread('m1', 's2');
    ui.getState().selectSession('m1', 's2');
    expect(ui.getState().isSessionUnread('m1', 's2')).toBe(true); // hidden → dot survives
  });

  it('panel mode follows selection: session / dm / marmot', () => {
    const ui = createUiStore();
    expect(ui.getState().panelMode).toBe('session');
    ui.getState().selectDmPeer('peer1');
    expect(ui.getState().panelMode).toBe('dm');
    expect(ui.getState().activeDmPeer).toBe('peer1');
    ui.getState().selectMarmotGroup('group1');
    expect(ui.getState().panelMode).toBe('marmot');
    expect(ui.getState().activeMarmotGroup).toBe('group1');
    ui.getState().selectSession('m1', 's1');
    expect(ui.getState().panelMode).toBe('session');
    ui.getState().selectMachine('m1');
    expect(ui.getState().panelMode).toBe('session');
  });
});

// --- Phone-core wiring ---

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

const entry = (partial: Partial<OutputEntry>): OutputEntry => ({
  entryType: 'system',
  content: '',
  timestamp: new Date(0).toISOString(),
  ...partial,
});

const info = (id: string, patch: Partial<RemoteSessionInfo> = {}): RemoteSessionInfo => ({
  id,
  slug: `slug-${id}`,
  cwd: '/work',
  lastActivity: new Date(0).toISOString(),
  lineCount: 0,
  title: null,
  project: 'proj',
  ...patch,
});

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

async function makeCore(extra: Partial<PhoneCoreDeps> = {}) {
  const machine = generateKeypair();
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport, ...extra });
  core.machines.getState().registerMachine({
    pubkeyHex: machine.pubkeyHex,
    name: 'test machine',
    label: 'test',
  });
  const liveOutput = (sessionId: string, seq: number, e: OutputEntry) =>
    core.api.ingest(bridgeEvent(core, machine, { type: 'output', sessionId, seq, entry: e }));
  const sessionList = (sessions: RemoteSessionInfo[]) =>
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'sessions',
        machine: 'test machine',
        sessions,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
  const hide = () => {
    core.connection.getState().dispatch({ type: 'visibility', visible: false });
    core.connection.getState().dispatch({ type: 'visibility-settled' });
  };
  return { core, machine, liveOutput, sessionList, hide };
}

const permissionCard = entry({ metadata: { special: 'permission_request', tool_name: 'Edit' } });
const streamEnd = entry({ metadata: { stream_end: true } });
const plainOutput = entry({ entryType: 'text', content: 'working on it' });

describe('phone-core wiring — live output path marks/clears unread', () => {
  it('a live card entry marks unread when the session is not in view; stream_end too', async () => {
    const { core, machine, liveOutput } = await makeCore();
    liveOutput('s1', 1, permissionCard);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);

    liveOutput('s2', 1, streamEnd);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's2')).toBe(true);
    await core.stop();
  });

  it('no mark when the app is visible AND the session is the ui selection', async () => {
    const { core, machine, liveOutput } = await makeCore();
    core.ui.getState().selectSession(machine.pubkeyHex, 's1');
    liveOutput('s1', 1, permissionCard);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);

    // Same selection but viewed through the DM panel → NOT watching → marks.
    core.ui.getState().selectDmPeer('somepeer');
    liveOutput('s1', 2, streamEnd);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    await core.stop();
  });

  it('a hidden app marks even the selected session', async () => {
    const { core, machine, liveOutput, hide } = await makeCore();
    core.ui.getState().selectSession(machine.pubkeyHex, 's1');
    hide();
    liveOutput('s1', 1, permissionCard);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    await core.stop();
  });

  it('a plain live output entry CLEARS unread — agent working, not waiting on the user', async () => {
    const { core, machine, liveOutput } = await makeCore();
    liveOutput('s1', 1, permissionCard);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    liveOutput('s1', 2, plainOutput);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);
    await core.stop();
  });

  it('CDX-053: the turn-finish dot survives the trailing system/result/usage entries', async () => {
    const { core, machine, liveOutput, hide } = await makeCore();
    hide();
    liveOutput('s1', 1, streamEnd); // turn finished while backgrounded → dot
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);

    // The exact device-observed killer: unclassified live entries trailing the
    // stream_end (result summary, token counts, a plain status line).
    liveOutput('s1', 2, entry({ content: 'Session complete (exit 0)' }));
    liveOutput('s1', 3, entry({ content: 'Tokens: 1,234 in / 567 out' }));
    liveOutput('s1', 4, entry({ content: 'some status line' }));
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    await core.stop();
  });

  it('CDX-053: a generic error artifact does not eat the dot either', async () => {
    const { core, machine, liveOutput, hide } = await makeCore();
    hide();
    liveOutput('s1', 1, streamEnd);
    liveOutput('s1', 2, entry({ entryType: 'error', content: 'transient tool error' }));
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    await core.stop();
  });

  it('CDX-053: real agent activity (tool traffic / thinking) still clears — the old-app nuance survives', async () => {
    const { core, machine, liveOutput } = await makeCore();
    liveOutput('s1', 1, permissionCard);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    liveOutput('s1', 2, entry({ entryType: 'tool_use', content: 'Edit(file.ts)' }));
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);

    liveOutput('s2', 1, permissionCard);
    liveOutput('s2', 2, entry({ entryType: 'thinking', content: 'hmm' }));
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's2')).toBe(false);
    await core.stop();
  });

  it('CDX-053: the heartbeat turn-finish mark survives a trailing live system entry too', async () => {
    const { core, machine, liveOutput, sessionList, hide } = await makeCore();
    hide();
    sessionList([info('s1', { state: 'running' })]);
    sessionList([info('s1', { state: 'idle' })]); // heartbeat running→idle → dot
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    liveOutput('s1', 1, entry({ content: 'Tokens: 9 in / 9 out' }));
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    await core.stop();
  });

  it('sync catch-up entries never touch unread (live-only path)', async () => {
    const { core, machine } = await makeCore();
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'sync-chunk',
        sessionId: 's1',
        syncId: 'sync1',
        range: [1, 1],
        entries: [{ seq: 1, entry: permissionCard }],
      }),
    );
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);
    await core.stop();
  });

  it('an outbox send clears the session unread mark (replying = read)', async () => {
    const { core, machine, liveOutput } = await makeCore();
    liveOutput('s1', 1, permissionCard);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    await core.outbox.getState().send(machine.pubkeyHex, 's1', 'go ahead');
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);
    await core.stop();
  });
});

describe('phone-core wiring — heartbeat waiting-transitions (CDX-026b)', () => {
  it('transition into waiting_permission marks unread AND notifies a hidden phone', async () => {
    const sent: Array<{ title: string; body: string }> = [];
    const { core, machine, sessionList, hide } = await makeCore({
      notifier: { notify: (n) => sent.push(n) },
    });
    hide();

    sessionList([info('s1', { state: 'running' })]);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);
    expect(sent).toHaveLength(0);

    sessionList([info('s1', { state: 'waiting_permission' })]);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('Permission needed');
    await core.stop();
  });

  it('first sight of an already-waiting session counts as a transition (question → notify)', async () => {
    const sent: Array<{ title: string; body: string }> = [];
    const { core, machine, sessionList, hide } = await makeCore({
      notifier: { notify: (n) => sent.push(n) },
    });
    hide();
    sessionList([info('s1', { state: 'waiting_question' })]);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('Question from Claude');
    await core.stop();
  });

  it('repeat snapshots of the same waiting state never re-mark or re-notify (even past the cooldown)', async () => {
    let at = 0;
    const sent: Array<{ title: string; body: string }> = [];
    const { core, machine, sessionList, hide } = await makeCore({
      notifier: { notify: (n) => sent.push(n) },
      now: () => at,
    });
    hide();
    sessionList([info('s1', { state: 'waiting_permission' })]);
    expect(sent).toHaveLength(1);

    // The user read the session (hidden selection does not clear; clear directly).
    core.ui.getState().clearSessionUnread(machine.pubkeyHex, 's1');
    at += NOTIFY_COOLDOWN_MS + 1; // well past the cooldown — only the transition guard protects now
    sessionList([info('s1', { state: 'waiting_permission' })]);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);
    expect(sent).toHaveLength(1);

    // Leaving and re-entering waiting IS a new transition.
    sessionList([info('s1', { state: 'running' })]);
    at += NOTIFY_COOLDOWN_MS + 1;
    sessionList([info('s1', { state: 'waiting_permission' })]);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    expect(sent).toHaveLength(2);
    await core.stop();
  });

  it('no mark and no notification for the visible + foreground-watched session', async () => {
    const sent: Array<{ title: string; body: string }> = [];
    const { core, machine, sessionList } = await makeCore({
      notifier: { notify: (n) => sent.push(n) },
    });
    core.ui.getState().selectSession(machine.pubkeyHex, 's1');
    sessionList([info('s1', { state: 'waiting_permission' })]);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);
    expect(sent).toHaveLength(0);
    await core.stop();
  });

  it('the live card and the heartbeat transition share one cooldown — no double notification', async () => {
    const sent: Array<{ title: string; body: string }> = [];
    const { core, machine, liveOutput, sessionList, hide } = await makeCore({
      notifier: { notify: (n) => sent.push(n) },
    });
    hide();
    liveOutput('s1', 1, permissionCard); // live path notifies
    sessionList([info('s1', { state: 'waiting_permission' })]); // heartbeat path — same key, cooldown eats it
    expect(sent).toHaveLength(1);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    await core.stop();
  });

  it('the ping seam fires for heartbeat transitions without any notifier (permission-independent)', async () => {
    let pings = 0;
    const { core, machine, sessionList, hide } = await makeCore({ ping: () => pings++ });
    hide();
    sessionList([info('s1', { state: 'waiting_permission' })]);
    expect(pings).toBe(1);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    await core.stop();
  });
});

describe('phone-core wiring — heartbeat running→idle turn finish (CDX-026b completed)', () => {
  it('running → idle marks unread and emits session-finished on a hidden phone', async () => {
    const sent: Array<{ title: string; body: string; tag?: string }> = [];
    const { core, machine, sessionList, hide } = await makeCore({
      notifier: { notify: (n) => sent.push(n) },
    });
    hide();
    sessionList([info('s1', { state: 'running' })]);
    expect(sent).toHaveLength(0);

    sessionList([info('s1', { state: 'idle' })]);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('Session finished');
    expect(sent[0]!.tag).toBe(sessionNotifyTag(machine.pubkeyHex, 's1'));
    await core.stop();
  });

  it('idle → idle repeats (and first sight of an idle session) never mark or notify', async () => {
    let at = 0;
    const sent: Array<{ title: string; body: string }> = [];
    const { core, machine, sessionList, hide } = await makeCore({
      notifier: { notify: (n) => sent.push(n) },
      now: () => at,
    });
    hide();
    // First sight already idle — no transition, no noise.
    sessionList([info('s1', { state: 'idle' })]);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);
    expect(sent).toHaveLength(0);

    // Repeat idle snapshots stay silent even past the cooldown.
    at += NOTIFY_COOLDOWN_MS + 1;
    sessionList([info('s1', { state: 'idle' })]);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);
    expect(sent).toHaveLength(0);
    await core.stop();
  });

  it('no mark and no notification for the visible + foreground-watched session', async () => {
    const sent: Array<{ title: string; body: string }> = [];
    const { core, machine, sessionList } = await makeCore({
      notifier: { notify: (n) => sent.push(n) },
    });
    core.ui.getState().selectSession(machine.pubkeyHex, 's1');
    sessionList([info('s1', { state: 'running' })]);
    sessionList([info('s1', { state: 'idle' })]);
    expect(core.ui.getState().isSessionUnread(machine.pubkeyHex, 's1')).toBe(false);
    expect(sent).toHaveLength(0);
    await core.stop();
  });

  it('the live stream_end and the heartbeat idle-transition share one cooldown — no double fire', async () => {
    const sent: Array<{ title: string; body: string }> = [];
    const { core, machine, liveOutput, sessionList, hide } = await makeCore({
      notifier: { notify: (n) => sent.push(n) },
    });
    hide();
    sessionList([info('s1', { state: 'running' })]);
    liveOutput('s1', 1, streamEnd); // live path emits session-finished
    sessionList([info('s1', { state: 'idle' })]); // heartbeat path — cooldown eats it
    expect(sent).toHaveLength(1);
    await core.stop();
  });
});

describe('phone-core wiring — notification cancel on view (CDX-026c)', () => {
  it('selecting a session (visible) cancels its tag; opening a DM cancels the peer tag', async () => {
    const cancelled: string[] = [];
    const { core, machine } = await makeCore({
      notifier: { notify: () => {}, cancel: (tag) => cancelled.push(tag) },
    });
    core.ui.getState().selectSession(machine.pubkeyHex, 's1');
    expect(cancelled).toEqual([sessionNotifyTag(machine.pubkeyHex, 's1')]);
    core.ui.getState().selectDmPeer('peerX');
    expect(cancelled).toEqual([
      sessionNotifyTag(machine.pubkeyHex, 's1'),
      dmNotifyTag('peerX'),
    ]);
    await core.stop();
  });

  it('a hidden-app selection does not cancel (mirror of the unread-clear gate)', async () => {
    const cancelled: string[] = [];
    const { core, machine, hide } = await makeCore({
      notifier: { notify: () => {}, cancel: (tag) => cancelled.push(tag) },
    });
    hide();
    core.ui.getState().selectSession(machine.pubkeyHex, 's1');
    expect(cancelled).toEqual([]);
    await core.stop();
  });
});

describe('phone-core wiring — first-message title fallback (Phase 6)', () => {
  it('an outbox send titles an untitled session; later sends never re-title', async () => {
    const { core, machine, sessionList } = await makeCore();
    sessionList([info('s1', { state: 'idle' })]);
    await core.outbox.getState().send(machine.pubkeyHex, 's1', 'Fix the login\nbug please');
    expect(core.machines.getState().session(machine.pubkeyHex, 's1')?.info.title).toBe(
      'Fix the login bug please',
    );
    await core.outbox.getState().send(machine.pubkeyHex, 's1', 'second message');
    expect(core.machines.getState().session(machine.pubkeyHex, 's1')?.info.title).toBe(
      'Fix the login bug please',
    );
    await core.stop();
  });

  it('a titleless heartbeat preserves the client title; a bridge-authored title overwrites it', async () => {
    const { core, machine, sessionList } = await makeCore();
    sessionList([info('s1', { state: 'idle' })]);
    await core.outbox.getState().send(machine.pubkeyHex, 's1', 'stopgap title');
    sessionList([info('s1', { state: 'idle' })]); // title: null heartbeat
    expect(core.machines.getState().session(machine.pubkeyHex, 's1')?.info.title).toBe(
      'stopgap title',
    );
    sessionList([info('s1', { state: 'idle', title: 'Bridge topical title' })]);
    expect(core.machines.getState().session(machine.pubkeyHex, 's1')?.info.title).toBe(
      'Bridge topical title',
    );
    await core.stop();
  });

  it('the title survives a KV persistence round-trip (fresh-core reboot)', async () => {
    const kv = memoryKV();
    const { core, machine, sessionList } = await makeCore({ kv });
    sessionList([info('s1', { state: 'idle' })]);
    await core.outbox.getState().send(machine.pubkeyHex, 's1', 'persisted title');
    await core.stop();

    const rebooted = await createPhoneCore({ kv, transport: nullTransport });
    expect(rebooted.machines.getState().session(machine.pubkeyHex, 's1')?.info.title).toBe(
      'persisted title',
    );
    await rebooted.stop();
  });
});
