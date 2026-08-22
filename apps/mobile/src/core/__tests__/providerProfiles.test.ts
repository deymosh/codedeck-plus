/**
 * CDX-062 — custom provider profiles on the phone core:
 * - machines slice: applyProviderProfiles is a PLAIN REPLACE (no CDX-035
 *   empty-answer dance — the bridge always answers from storage, so an empty
 *   list truthfully means zero profiles), the list survives heartbeats
 *   (CDX-022 spread invariant), and it NEVER persists (zero profile copies at
 *   rest — serialize strips it, hydrate drops any stale copy).
 * - ui slice: transient set-provider-profile round-trip feedback, mirroring
 *   the credentials slice.
 * - wire routing: provider-profiles / provider-profile-ack enter as REAL
 *   NIP-44-encrypted bridge events through api.ingest and land in the right
 *   stores (full dispatch + createPhoneCore wiring, not a store poke).
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import {
  LIVE_KIND,
  PROTOCOL_VERSION,
  encodeBridgeToPhone,
  type BridgeToPhoneMessage,
  type ProviderProfileInfo,
  type SessionListMessage,
} from '@codedeck/protocol';
import { createPhoneCore } from '../createPhoneCore';
import { encryptTo, generateKeypair } from '../crypto';
import { createMachinesStore, hydrateMachines, serializeMachines } from '../stores/machines';
import { createUiStore } from '../stores/ui';
import { memoryKV, type PhoneTransport } from '../ports';

const list = (patch: Partial<SessionListMessage> = {}): SessionListMessage => ({
  type: 'sessions',
  machine: 'box',
  sessions: [],
  protocolVersion: PROTOCOL_VERSION,
  ...patch,
});

const profile = (id: string, patch: Partial<ProviderProfileInfo> = {}): ProviderProfileInfo => ({
  id,
  label: id.toUpperCase(),
  baseUrl: `https://api.${id}.example/anthropic`,
  models: [{ id: `${id}-model` }],
  hasToken: true,
  ...patch,
});

const profilesMsg = (profiles: ProviderProfileInfo[]) =>
  ({ type: 'provider-profiles', machine: 'box', profiles }) as const;

describe('machinesStore.applyProviderProfiles (CDX-062)', () => {
  it('plain replace: a new list wholly replaces the old — including an EMPTY one', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().applySessionList('pk', list(), 10);

    store.getState().applyProviderProfiles('pk', profilesMsg([profile('kimi'), profile('router')]));
    expect(store.getState().machine('pk')!.providerProfiles?.map((p) => p.id)).toEqual([
      'kimi',
      'router',
    ]);

    store.getState().applyProviderProfiles('pk', profilesMsg([profile('kimi', { hasToken: false })]));
    expect(store.getState().machine('pk')!.providerProfiles).toHaveLength(1);
    expect(store.getState().machine('pk')!.providerProfiles![0]!.hasToken).toBe(false);

    // Unlike applyModels (CDX-035), [] is authoritative: the bridge answered
    // from storage and genuinely stores zero profiles now.
    store.getState().applyProviderProfiles('pk', profilesMsg([]));
    expect(store.getState().machine('pk')!.providerProfiles).toEqual([]);
  });

  it('unknown machine is dropped, never a throw', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    expect(() =>
      store.getState().applyProviderProfiles('ghost', profilesMsg([profile('kimi')])),
    ).not.toThrow();
    expect(store.getState().machine('ghost')).toBeUndefined();
  });

  it('the list SURVIVES a heartbeat burst (CDX-022 spread invariant)', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().applySessionList('pk', list(), 10);
    store.getState().applyProviderProfiles('pk', profilesMsg([profile('kimi')]));

    for (let at = 20; at < 100; at += 10) {
      store.getState().applySessionList('pk', list(), at);
    }
    expect(store.getState().machine('pk')!.providerProfiles?.map((p) => p.id)).toEqual(['kimi']);
  });

  it('NEVER persists: serialize strips the list, hydrate drops a stale copy', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().applySessionList('pk', list(), 10);
    store.getState().applyProviderProfiles('pk', profilesMsg([profile('kimi')]));

    const raw = serializeMachines(store.getState().machines);
    expect(raw).not.toContain('providerProfiles');
    expect(hydrateMachines(raw)['pk']!.providerProfiles).toBeUndefined();

    // Belt-and-braces: even a hand-planted copy in the KV does not hydrate.
    const tampered = JSON.parse(raw) as Record<string, unknown>[];
    tampered[0]!['providerProfiles'] = [profile('planted')];
    expect(hydrateMachines(JSON.stringify(tampered))['pk']!.providerProfiles).toBeUndefined();
  });
});

describe('uiStore providerProfileStatus (CDX-062, transient ack feedback)', () => {
  it('sent → saving; success ack → saved with the tokenValid verdict', () => {
    const ui = createUiStore({ now: () => 42 });
    ui.getState().noteProviderProfileSent('pk', 'kimi');
    expect(ui.getState().providerProfileStatus['pk']).toEqual({
      state: 'saving',
      at: 42,
      profileId: 'kimi',
    });

    ui.getState().applyProviderProfileAck('pk', {
      profileId: 'kimi',
      success: true,
      tokenValid: true,
    });
    expect(ui.getState().providerProfileStatus['pk']).toMatchObject({
      state: 'saved',
      profileId: 'kimi',
      tokenValid: true,
    });
  });

  it('failure ack → failed with error; absent tokenValid stays absent (tri-state)', () => {
    const ui = createUiStore({ now: () => 1 });
    ui.getState().applyProviderProfileAck('pk', {
      profileId: 'kimi',
      success: false,
      error: 'disk full',
    });
    const status = ui.getState().providerProfileStatus['pk']!;
    expect(status.state).toBe('failed');
    expect(status.error).toBe('disk full');
    expect('tokenValid' in status).toBe(false);
  });
});

describe('wire routing through api.ingest (real encrypted events)', () => {
  const nullTransport: PhoneTransport = {
    subscribe: () => ({ close: () => {} }),
    publish: async () => true,
  };

  it('provider-profiles → machines slice, provider-profile-ack → ui slice', async () => {
    const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
    const machine = generateKeypair();
    core.machines.getState().registerMachine({ pubkeyHex: machine.pubkeyHex, name: 'box' });
    const phonePubkey = core.identity.getState().keypair.pubkeyHex;

    const bridgeEvent = (msg: BridgeToPhoneMessage): NostrEvent =>
      finalizeEvent(
        {
          kind: LIVE_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', phonePubkey]],
          content: encryptTo(machine.secretKey, phonePubkey, encodeBridgeToPhone(msg)),
        },
        machine.secretKey,
      );

    core.api.ingest(bridgeEvent(profilesMsg([profile('kimi')])));
    expect(
      core.machines.getState().machine(machine.pubkeyHex)!.providerProfiles?.map((p) => p.id),
    ).toEqual(['kimi']);

    core.api.ingest(
      bridgeEvent({
        type: 'provider-profile-ack',
        machine: 'box',
        profileId: 'kimi',
        success: true,
        tokenValid: false,
      }),
    );
    expect(core.ui.getState().providerProfileStatus[machine.pubkeyHex]).toMatchObject({
      state: 'saved',
      profileId: 'kimi',
      tokenValid: false,
    });
  });
});
