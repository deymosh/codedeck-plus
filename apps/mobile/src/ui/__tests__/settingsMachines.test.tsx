// @vitest-environment jsdom
/**
 * Settings → Machines (Phase 2b): one block per paired machine (name + host
 * badge + truncated pubkey + MachineCredentials) and the confirm-gated
 * "Remove machine" flow calling core.removeMachine.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildFakePhoneCore, tick } from '../../core/__tests__/nativeCoreFixture';
import type { MachineView } from '../../core/nativeCoreTypes';
import type { PhoneCore } from '../../core/phoneCore';
import { PhoneCoreProvider } from '../coreContext';
import { SettingsScreen } from '../screens/SettingsScreen';

afterEach(cleanup);

const MACHINE = 'a'.repeat(64);
const MACHINE_2 = 'b'.repeat(64);

function machine(pubkeyHex: string, name: string, host: MachineView['host']): MachineView {
  return {
    pubkeyHex,
    name,
    host,
    capabilities: [],
    folders: [],
    roots: [],
    machineOffline: false,
    sessions: {},
  };
}

async function makeCore(machines: MachineView[] = [machine(MACHINE, 'laptop', 'vscode')]) {
  const { phone, fake } = await buildFakePhoneCore({
    machines: { machines: Object.fromEntries(machines.map((m) => [m.pubkeyHex, m])) },
  });
  // `Intent::RemoveMachine` drops it from the view Rust-side — see that
  // intent's own tests for the full cascade (sessions, transcripts, unread).
  fake.onDispatch((intent) => {
    if (typeof intent === 'object' && 'removeMachine' in intent) {
      const { [intent.removeMachine.pubkeyHex]: _removed, ...rest } = fake.views.machines.machines;
      fake.setView('machines', { machines: rest });
    }
  });
  return { core: phone, fake };
}

function renderSettings(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <SettingsScreen />
    </PhoneCoreProvider>,
  );
}

describe('Settings — Machines section (Phase 2b)', () => {
  it('renders a block per machine: name, host badge, truncated pubkey, credentials', async () => {
    const { core } = await makeCore();
    renderSettings(core);

    const block = screen.getByTestId('machine-block');
    expect(block.textContent).toContain('laptop');
    expect(block.textContent).toContain('vscode');
    expect(block.textContent).toContain(`${MACHINE.slice(0, 16)}…${MACHINE.slice(-8)}`);
    expect(screen.getByText('Machine credentials…')).toBeTruthy();
  });

  it('Remove machine requires the confirm step; Cancel keeps the machine', async () => {
    const { core } = await makeCore();
    renderSettings(core);

    fireEvent.click(screen.getByText('Remove machine…'));
    expect(screen.getByText(/Remove laptop from this phone\?/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(core.machines.getState().machines[MACHINE]).toBeTruthy();
    expect(screen.getByTestId('machine-block')).toBeTruthy();
  });

  it('confirming removes the machine (block gone, store empty)', async () => {
    const { core } = await makeCore();
    renderSettings(core);

    fireEvent.click(screen.getByText('Remove machine…'));
    await act(async () => {
      fireEvent.click(screen.getByText('Remove machine'));
      await tick();
    });
    expect(core.machines.getState().machines[MACHINE]).toBeUndefined();
    expect(screen.queryByTestId('machine-block')).toBeNull();
  });

  // Multi-bridge layout regression (the overlapping-Settings screenshot): the
  // per-machine list and the Mesh block each render inside their own <section>
  // wrapper so their rows are one non-shrinking unit in the `.screen` scroll
  // column instead of loose siblings that collapse under content pressure.
  // jsdom applies no real flex layout, so this guards the structure; the
  // `.screen > * { flex-shrink: 0 }` rule itself is checked manually.
  it('renders one block per machine, each inside the Machines <section>', async () => {
    const { core } = await makeCore([
      machine(MACHINE, 'laptop', 'vscode'),
      machine(MACHINE_2, 'server', 'cli'),
    ]);
    renderSettings(core);

    const blocks = screen.getAllByTestId('machine-block');
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const section = block.closest('section');
      expect(section).not.toBeNull();
      expect(section!.textContent).toContain('Machines');
    }
  });

  it('wraps the Mesh section in its own <section>', async () => {
    const { core } = await makeCore();
    renderSettings(core);

    const meshTitle = screen.getByText('Mesh (remote testing)');
    expect(meshTitle.closest('section')).not.toBeNull();
  });
});
