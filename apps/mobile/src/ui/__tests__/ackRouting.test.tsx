// @vitest-environment jsdom
/**
 * CDX-011: credentials-ack / device-config-ack routing — the formerly
 * "deliberately unrouted" acks now land in uiStore and render as saved/failed
 * feedback (MachineCredentials on the machine screen, MeshSection's device-
 * config lines). Acks enter as REAL NIP-44-encrypted bridge events through
 * api.ingest — the full wire path, not a store poke.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import {
  LIVE_KIND,
  decodePhoneToBridge,
  encodeBridgeToPhone,
  type BridgeToPhoneMessage,
} from '@codedeck/protocol';
import type { PhoneCore } from '../../core/createPhoneCore';
import { createPhoneCore } from '../../core/createPhoneCore';
import { decryptFrom, encryptTo, generateKeypair, type Keypair } from '../../core/crypto';
import { memoryKV, type PhoneTransport } from '../../core/ports';
import { PhoneCoreProvider } from '../coreContext';
import { MachineCredentials } from '../screens/MachineCredentials';

afterEach(cleanup);

function fakeTransport() {
  const published: NostrEvent[] = [];
  const transport: PhoneTransport = {
    subscribe: () => ({ close: () => {} }),
    publish: async (event) => {
      published.push(event);
      return true;
    },
  };
  return { transport, published };
}

async function makeCore(): Promise<{
  core: PhoneCore;
  published: NostrEvent[];
  machine: Keypair;
}> {
  const { transport, published } = fakeTransport();
  const core = await createPhoneCore({ kv: memoryKV(), transport });
  const machine = generateKeypair();
  core.machines.getState().registerMachine({
    pubkeyHex: machine.pubkeyHex,
    name: 'office laptop',
    label: 'office',
  });
  return { core, published, machine };
}

function bridgeEvent(core: PhoneCore, machine: Keypair, msg: BridgeToPhoneMessage): NostrEvent {
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

describe('ack routing into uiStore (real encrypted ingest)', () => {
  it('credentials-ack: saving → saved with key/PAT/keyValid detail', async () => {
    const { core, machine } = await makeCore();
    core.ui.getState().noteCredentialsSent(machine.pubkeyHex);
    expect(core.ui.getState().credentialsStatus[machine.pubkeyHex]?.state).toBe('saving');

    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'credentials-ack',
        machine: 'office laptop',
        success: true,
        hasAnthropicKey: true,
        hasGithubPat: false,
        keyValid: true,
      }),
    );
    const status = core.ui.getState().credentialsStatus[machine.pubkeyHex]!;
    expect(status.state).toBe('saved');
    expect(status.hasAnthropicKey).toBe(true);
    expect(status.hasGithubPat).toBe(false);
    expect(status.keyValid).toBe(true);
  });

  it('failed acks carry the error; device-config-ack routes the same way', async () => {
    const { core, machine } = await makeCore();
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'credentials-ack',
        machine: 'office laptop',
        success: false,
        hasAnthropicKey: false,
        hasGithubPat: false,
        error: 'disk full',
      }),
    );
    expect(core.ui.getState().credentialsStatus[machine.pubkeyHex]).toMatchObject({
      state: 'failed',
      error: 'disk full',
    });

    core.ui.getState().noteDeviceConfigSent(machine.pubkeyHex);
    expect(core.ui.getState().deviceConfigStatus[machine.pubkeyHex]?.state).toBe('saving');
    core.api.ingest(bridgeEvent(core, machine, { type: 'device-config-ack', success: true }));
    expect(core.ui.getState().deviceConfigStatus[machine.pubkeyHex]?.state).toBe('saved');
    core.api.ingest(
      bridgeEvent(core, machine, { type: 'device-config-ack', success: false, error: 'no roster' }),
    );
    expect(core.ui.getState().deviceConfigStatus[machine.pubkeyHex]).toMatchObject({
      state: 'failed',
      error: 'no roster',
    });
  });
});

describe('MachineCredentials UI', () => {
  it('save sends set-credentials with exactly the filled fields (empty = leave alone) and shows saving → saved', async () => {
    const { core, published, machine } = await makeCore();
    render(
      <PhoneCoreProvider value={core}>
        <MachineCredentials machinePubkey={machine.pubkeyHex} />
      </PhoneCoreProvider>,
    );

    fireEvent.click(screen.getByText('Machine credentials…'));
    fireEvent.change(screen.getByLabelText('Anthropic API key'), {
      target: { value: 'sk-ant-ui-test' },
    });
    fireEvent.click(screen.getByText('Save on bridge'));

    // The exact wire message: decrypt what the phone published to the bridge.
    await Promise.resolve();
    const cmd = published.at(-1)!;
    const phone = core.identity.getState().keypair;
    const decoded = decodePhoneToBridge(
      decryptFrom(machine.secretKey, phone.pubkeyHex, cmd.content),
    );
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.msg).toMatchObject({ type: 'set-credentials', anthropicApiKey: 'sk-ant-ui-test' });
    expect((decoded.msg as { githubPat?: unknown }).githubPat).toBeUndefined();

    // Optimistic "saving…" until the ack lands, then the saved detail line.
    expect(screen.getByTestId('credentials-status').textContent).toContain('Saving');
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'credentials-ack',
        machine: 'office laptop',
        success: true,
        hasAnthropicKey: true,
        hasGithubPat: false,
        keyValid: false,
      }),
    );
    expect((await screen.findByTestId('credentials-status')).textContent).toContain('INVALID');
    // The password draft is cleared on send (secrets don't linger in the DOM).
    expect((screen.getByLabelText('Anthropic API key') as HTMLInputElement).value).toBe('');
  });

  it('Clear key sends an explicit null (delete semantics)', async () => {
    const { core, published, machine } = await makeCore();
    render(
      <PhoneCoreProvider value={core}>
        <MachineCredentials machinePubkey={machine.pubkeyHex} />
      </PhoneCoreProvider>,
    );
    fireEvent.click(screen.getByText('Machine credentials…'));
    fireEvent.click(screen.getByText('Clear key'));
    await Promise.resolve();
    const phone = core.identity.getState().keypair;
    const decoded = decodePhoneToBridge(
      decryptFrom(machine.secretKey, phone.pubkeyHex, published.at(-1)!.content),
    );
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.msg).toMatchObject({ type: 'set-credentials', anthropicApiKey: null });
  });
});
