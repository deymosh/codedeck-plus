/**
 * Default session mode (CDX-047) — the "default mode for new sessions"
 * preference is applied by sending a mode change on session-ready: exactly
 * once per new session, and only when the preference differs from the mode
 * the session came up in (the bridge starts sessions in plan).
 */
import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  encodeBridgeToPhone,
  LIVE_KIND,
  type BridgeToPhoneMessage,
  type RemoteSessionInfo,
} from '@codedeck/protocol';
import { createDefaultModeApplier } from '../defaultSessionMode';
import { createPhoneCore, type PhoneCore } from '../createPhoneCore';
import { encryptTo, generateKeypair, type Keypair } from '../crypto';
import { memoryKV, type PhoneTransport } from '../ports';

describe('createDefaultModeApplier (unit)', () => {
  function harness(defaultMode: 'plan' | 'default' | 'acceptEdits') {
    const sendMode = vi.fn();
    const apply = createDefaultModeApplier({ defaultMode: () => defaultMode, sendMode });
    return { apply, sendMode };
  }

  it('sends the preferred mode when it differs from the session start mode', () => {
    const { apply, sendMode } = harness('acceptEdits');
    apply('m1', { id: 's1', permissionMode: 'plan' });
    expect(sendMode).toHaveBeenCalledExactlyOnceWith('m1', 's1', 'acceptEdits');
  });

  it('stays silent when the session already started in the preferred mode', () => {
    const { apply, sendMode } = harness('plan');
    apply('m1', { id: 's1', permissionMode: 'plan' });
    // No reported mode → the bridge default is plan; still no send.
    apply('m1', { id: 's2' });
    expect(sendMode).not.toHaveBeenCalled();
  });

  it('fires at most once per session — a replayed session-ready must not re-send', () => {
    const { apply, sendMode } = harness('default');
    apply('m1', { id: 's1', permissionMode: 'plan' });
    apply('m1', { id: 's1', permissionMode: 'plan' }); // duplicate delivery
    expect(sendMode).toHaveBeenCalledTimes(1);
    // A DIFFERENT session on the same machine gets its own application.
    apply('m1', { id: 's2', permissionMode: 'plan' });
    expect(sendMode).toHaveBeenCalledTimes(2);
  });
});

describe('phone-core wiring (session-ready path)', () => {
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

  const session = (id: string): RemoteSessionInfo => ({
    id,
    slug: id,
    cwd: `/work/${id}`,
    lastActivity: '2026-08-08T10:00:00.000Z',
    lineCount: 0,
    title: null,
    project: id,
    permissionMode: 'plan', // the bridge starts sessions in plan
  });

  it('session-ready applies a differing preference exactly once; a matching one never sends', async () => {
    const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
    const machine = generateKeypair();
    core.machines.getState().registerMachine({
      pubkeyHex: machine.pubkeyHex,
      name: 'test machine',
    });
    core.settings.getState().setDefaultMode('acceptEdits');
    const modeChange = vi.spyOn(core.api, 'modeChange').mockResolvedValue(true);

    const ready = bridgeEvent(core, machine, {
      type: 'session-ready',
      pendingId: 's1',
      session: session('s1'),
    });
    core.api.ingest(ready);
    expect(modeChange).toHaveBeenCalledExactlyOnceWith(machine.pubkeyHex, 's1', 'acceptEdits');

    // Redelivered session-ready (relay replay) → still exactly once.
    core.api.ingest(ready);
    expect(modeChange).toHaveBeenCalledTimes(1);

    // Preference back to the start mode → the next new session sends nothing.
    core.settings.getState().setDefaultMode('plan');
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'session-ready',
        pendingId: 's2',
        session: session('s2'),
      }),
    );
    expect(modeChange).toHaveBeenCalledTimes(1);
    await core.stop();
  });
});
