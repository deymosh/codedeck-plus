// @vitest-environment jsdom
/**
 * CDX-031: a bridge started on TWO `--workspace` roots must let the phone
 * start a session in the SECOND root.
 *
 * This settles the unconfirmed device observation of 2026-08-08 — bridge on
 * `gsd-proj` + `plain-proj`, and the NewSessionModal offered only "Default
 * (workspace root)" + "New folder…". It was REAL, and the gap was bridge-side:
 * the heartbeat's `folders` is the union of what lives INSIDE the roots
 * (`listAllWorkspaceFolders` enumerates each root's children), so a root never
 * appears among its own entries and two flat project roots advertise nothing
 * at all. Every downstream link — codec, machines store, modal — was fine and
 * faithfully rendered the empty list it was given.
 *
 * This used to drive the chain for real: a live `BridgeCore` over an
 * in-memory relay → its actual 30515 heartbeat → the production phone core's
 * machines store → `NewSessionModal` → back down to the SDK session the
 * bridge spawns. That whole round trip through a real bridge is Rust's job to
 * prove now (`crates/client-core`'s wire tests already cover `roots` staying
 * absolute and in `--workspace` order — see `wire::events`); a TS test has no
 * bridge process to drive anymore. What is still this file's job: given a
 * `MachinesView` carrying two roots (the exact shape a real heartbeat would
 * produce), does `NewSessionModal` offer both, and does picking the second
 * one dispatch `Intent::CreateSession` with THAT root as `cwd`.
 */
import { describe, it, expect } from 'vitest';
import { afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildFakePhoneCore } from '../core/__tests__/nativeCoreFixture';
import type { MachineView } from '../core/nativeCoreTypes';
import { PhoneCoreProvider } from '../ui/coreContext';
import { NewSessionModal } from '../ui/NewSessionModal';

afterEach(cleanup);

const MACHINE = 'a'.repeat(64);
const ROOT_A = '/work/gsd-proj';
const ROOT_B = '/work/plain-proj';

function machineWithRoots(roots: string[], folders: string[]): MachineView {
  return {
    pubkeyHex: MACHINE,
    name: 'multiroot-machine',
    capabilities: [],
    folders,
    roots,
    machineOffline: false,
    sessions: {},
  };
}

describe('two workspace roots → folder picker (CDX-031)', () => {
  it('the modal offers the second root, and creating there dispatches cwd = that root', async () => {
    const { phone: core, fake } = await buildFakePhoneCore({
      // The regression this guards: `folders` lists what is INSIDE the roots
      // (rootA's one child) and can name neither root itself — exactly what
      // two flat project roots produce. `roots` is what the picker must use.
      machines: { machines: { [MACHINE]: machineWithRoots([ROOT_A, ROOT_B], ['projA']) } },
    });

    render(
      <PhoneCoreProvider value={core}>
        <NewSessionModal machinePubkey={MACHINE} onClose={() => {}} />
      </PhoneCoreProvider>,
    );

    // One radio per root, valued with the absolute path the bridge can match.
    expect((screen.getByDisplayValue(ROOT_A) as HTMLInputElement).type).toBe('radio');
    const secondRoot = screen.getByDisplayValue(ROOT_B) as HTMLInputElement;
    expect(secondRoot.type).toBe('radio');
    // Labelled by basename — the absolute path would ellipsize away on a phone.
    expect(screen.getByText('plain-proj')).toBeTruthy();
    expect(screen.getAllByTestId('root-option')).toHaveLength(2);

    // Pick the SECOND root and create — oracle (a) of the CDX-031 device step.
    fireEvent.click(secondRoot);
    fireEvent.click(screen.getByText('Create'));

    expect(fake.dispatched).toContainEqual({
      createSession: {
        machine: MACHINE,
        cwd: ROOT_B,
        createCwd: null,
        model: null,
        defaultEffort: null,
        providerId: null,
        testSession: null,
      },
    });
  });

  it('a single-root bridge shows no root rows — Default already is that root', async () => {
    // Guard against the fix adding a redundant duplicate row everywhere: the
    // rows only appear when there is a choice to make.
    const { phone: core } = await buildFakePhoneCore({
      machines: { machines: { [MACHINE]: machineWithRoots(['/only/root'], []) } },
    });

    render(
      <PhoneCoreProvider value={core}>
        <NewSessionModal machinePubkey={MACHINE} onClose={() => {}} />
      </PhoneCoreProvider>,
    );

    expect(screen.queryAllByTestId('root-option')).toHaveLength(0);
    expect(screen.getByText('Default (workspace root)')).toBeTruthy();
  });
});
