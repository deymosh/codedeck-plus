// @vitest-environment jsdom
/**
 * CDX-011: credentials-ack / device-config-ack routing — the formerly
 * "deliberately unrouted" acks land in the ui store and render as saved/
 * failed feedback (MachineCredentials on the machine screen).
 *
 * Decrypting a real NIP-44 event through `api.ingest` was the WebView
 * transport's own inbound path — dead now (Rust's `Router` decrypts/decodes/
 * dispatches internally; `createNativeBridgeApi`'s `ingest` is a documented
 * no-op). What is left worth testing here is: `setCredentials` dispatches the
 * right `Intent`, and `MachineCredentials` renders whatever `UiView.
 * credentialsStatus` says — seeded directly, the way a real ack would set it.
 * The optimistic "Saving…" write (`noteCredentialsSent`) is also a documented,
 * still-open native gap (see nativeUi.ts's module doc) and is not asserted.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildFakePhoneCore, tick } from '../../core/__tests__/nativeCoreFixture';
import type { CredentialsAck, DeviceConfigAck } from '../../core/nativeCoreTypes';
import { generateKeypair, type Keypair } from '../../core/crypto';
import { PhoneCoreProvider } from '../coreContext';
import { MachineCredentials } from '../screens/MachineCredentials';

afterEach(cleanup);

async function makeCore(machine: Keypair) {
  return buildFakePhoneCore({
    machines: {
      machines: {
        [machine.pubkeyHex]: {
          pubkeyHex: machine.pubkeyHex,
          name: 'office laptop',
          label: 'office',
          capabilities: [],
          folders: [],
          roots: [],
          protocolVersion: null,
          machineOffline: false,
          lastHeartbeatAt: null,
          sessions: {},
        },
      },
    },
  });
}

describe('MachineCredentials UI', () => {
  it('save dispatches set-credentials with exactly the filled fields (empty = leave alone), then the ack renders saved/INVALID', async () => {
    const machine = generateKeypair();
    const { phone: core, fake } = await makeCore(machine);
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

    expect(fake.dispatched).toContainEqual({
      setCredentials: { machine: machine.pubkeyHex, anthropicApiKey: 'sk-ant-ui-test' },
    });

    // The bridge answers; the Router folds the ack into UiView — seeded here.
    const acked: CredentialsAck = {
      state: 'saved',
      at: Date.now(),
      hasAnthropicKey: true,
      hasGithubPat: false,
      keyValid: false,
    };
    await act(async () => {
      fake.setView('ui', {
        ...fake.views.ui,
        credentialsStatus: { [machine.pubkeyHex]: acked },
      });
      await tick();
    });
    expect((await screen.findByTestId('credentials-status')).textContent).toContain('INVALID');
    // The password draft is cleared on send (secrets don't linger in the DOM).
    expect((screen.getByLabelText('Anthropic API key') as HTMLInputElement).value).toBe('');
  });

  it('Clear key sends an explicit null (delete semantics)', async () => {
    const machine = generateKeypair();
    const { phone: core, fake } = await makeCore(machine);
    render(
      <PhoneCoreProvider value={core}>
        <MachineCredentials machinePubkey={machine.pubkeyHex} />
      </PhoneCoreProvider>,
    );
    fireEvent.click(screen.getByText('Machine credentials…'));
    fireEvent.click(screen.getByText('Clear key'));

    expect(fake.dispatched).toContainEqual({
      setCredentials: { machine: machine.pubkeyHex, anthropicApiKey: null },
    });
  });

  it('a failed credentials-ack carries the error, and device-config-ack renders the same way', async () => {
    const machine = generateKeypair();
    const { phone: core, fake } = await makeCore(machine);
    render(
      <PhoneCoreProvider value={core}>
        <MachineCredentials machinePubkey={machine.pubkeyHex} />
      </PhoneCoreProvider>,
    );
    fireEvent.click(screen.getByText('Machine credentials…'));

    const failedCreds: CredentialsAck = { state: 'failed', at: Date.now(), error: 'disk full' };
    await act(async () => {
      fake.setView('ui', { ...fake.views.ui, credentialsStatus: { [machine.pubkeyHex]: failedCreds } });
      await tick();
    });
    expect((await screen.findByTestId('credentials-status')).textContent).toContain('disk full');

    const savedConfig: DeviceConfigAck = { state: 'saved', at: Date.now() };
    await act(async () => {
      fake.setView('ui', { ...fake.views.ui, deviceConfigStatus: { [machine.pubkeyHex]: savedConfig } });
      await tick();
    });
    expect(core.ui.getState().deviceConfigStatus[machine.pubkeyHex]?.state).toBe('saved');

    const failedConfig: DeviceConfigAck = { state: 'failed', at: Date.now(), error: 'no roster' };
    await act(async () => {
      fake.setView('ui', { ...fake.views.ui, deviceConfigStatus: { [machine.pubkeyHex]: failedConfig } });
      await tick();
    });
    expect(core.ui.getState().deviceConfigStatus[machine.pubkeyHex]).toMatchObject({
      state: 'failed',
      error: 'no roster',
    });
  });
});
