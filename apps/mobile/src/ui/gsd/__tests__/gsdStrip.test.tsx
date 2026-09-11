// @vitest-environment jsdom
/**
 * GsdStrip (Phase 5c): render states — no/unavailable gsd-state → hidden,
 * stages render with the Discuss/Plan/Execute marks, current-stage highlight,
 * refresh via the existing gsd-request command path, CD-055 busy gate.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { GsdState, RemoteSessionInfo } from '@codedeck/protocol';
import { buildFakePhoneCore } from '../../../core/__tests__/nativeCoreFixture';
import type { PhoneCore } from '../../../core/phoneCore';
import { PhoneCoreProvider } from '../../coreContext';
import { GsdStrip } from '../GsdStrip';
import { phaseStages, stripSummary } from '../gsdStages';

afterEach(cleanup);

const MACHINE = 'a'.repeat(64);
const SESSION = 'session-1';

const sessionInfo = (state?: RemoteSessionInfo['state']): RemoteSessionInfo => ({
  id: SESSION,
  slug: 'test',
  cwd: '/home/x/proj',
  lastActivity: new Date(0).toISOString(),
  lineCount: 0,
  title: null,
  project: 'proj',
  ...(state !== undefined ? { state } : {}),
});

const gsdState = (partial?: Partial<GsdState>): GsdState => ({
  installed: true,
  available: true,
  hasGit: true,
  situation: 'planning',
  summary: '',
  milestone: 'v1.0 — MVP',
  currentPhase: '2',
  totalPhases: 3,
  percent: 50,
  phases: [
    { number: '1', name: 'Foundation', diskStatus: 'complete', plans: 2, summaries: 2, recentlyTouched: false, action: null, command: null, planCount: null, needsYou: null },
    { number: '2', name: 'Core', diskStatus: 'planned', plans: 1, summaries: 0, recentlyTouched: true, action: 'execute', command: '/gsd-execute-phase 2', planCount: 1, needsYou: 0 },
    { number: '3', name: 'Polish', diskStatus: 'empty', plans: 0, summaries: 0, recentlyTouched: false, action: null, command: null, planCount: null, needsYou: null },
  ],
  actions: [
    { id: 'execute-phase', label: 'Execute phase 2', command: '/gsd-execute-phase 2', recommended: true },
  ],
  recommended: 'execute-phase',
  paused: false,
  blockers: [],
  verifyFailed: false,
  execution: null,
  ...partial,
});

async function makeCore(gsd: GsdState | null, state?: RemoteSessionInfo['state']): Promise<PhoneCore> {
  const { phone } = await buildFakePhoneCore({
    machines: {
      machines: {
        [MACHINE]: {
          pubkeyHex: MACHINE,
          name: 'laptop',
          capabilities: [],
          folders: [],
          roots: [],
          protocolVersion: null,
          machineOffline: false,
          lastHeartbeatAt: null,
          sessions: {
            [SESSION]: {
              info: sessionInfo(state),
              presence: 'live',
              lastListedAt: 0,
              ...(gsd ? { gsd } : {}),
            },
          },
        },
      },
    },
  });
  return phone;
}

function renderStrip(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <GsdStrip machinePubkey={MACHINE} sessionId={SESSION} />
    </PhoneCoreProvider>,
  );
}

describe('GsdStrip render states', () => {
  it('no gsd-state for the session → renders nothing but STILL fires gsd-request (CDX-032)', async () => {
    // The bridge only publishes gsd-state in reply to gsd-request, so the
    // phone must initiate even (especially) when it has no state yet —
    // otherwise neither side ever moves and the strip is unreachable.
    const core = await makeCore(null);
    const request = vi.spyOn(core.api, 'gsdRequest').mockResolvedValue(true);
    renderStrip(core);
    expect(screen.queryByTestId('gsd-strip')).toBeNull();
    expect(request).toHaveBeenCalledWith(MACHINE, SESSION);
  });

  it('gsd.available=false (no .planning/) → hidden', async () => {
    const core = await makeCore(gsdState({ available: false }));
    renderStrip(core);
    expect(screen.queryByTestId('gsd-strip')).toBeNull();
  });

  it('available → summary line renders and mount requests a refresh via gsd-request', async () => {
    const core = await makeCore(gsdState());
    const request = vi.spyOn(core.api, 'gsdRequest').mockResolvedValue(true);
    renderStrip(core);
    expect(screen.getByTestId('gsd-strip')).toBeTruthy();
    // v1.0 — MVP · Phase 2/3 · Planning · 50%
    expect(screen.getByText(stripSummary(gsdState()))).toBeTruthy();
    expect(request).toHaveBeenCalledWith(MACHINE, SESSION);
  });

  it('expanding renders every phase with its stage marks; the current phase is highlighted', async () => {
    const core = await makeCore(gsdState());
    vi.spyOn(core.api, 'gsdRequest').mockResolvedValue(true);
    renderStrip(core);
    fireEvent.click(screen.getByRole('button', { name: 'Show GSD phases' }));

    const strip = screen.getByTestId('gsd-strip');
    const rows = strip.querySelectorAll('[data-phase]');
    expect(rows).toHaveLength(3);
    // Marks come from the shared phaseStages table (complete / planned / empty).
    expect(rows[0]!.textContent).toContain(phaseStages(gsdState().phases[0]!).marks.join(' ')); // ✓ ✓ ✓
    expect(rows[1]!.textContent).toContain('✓ ✓ ○');
    expect(rows[2]!.textContent).toContain('· · ·');
    // Current-stage highlight: exactly phase 2 carries data-current.
    const current = strip.querySelectorAll('[data-current]');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('data-phase')).toBe('2');
  });

  it('recommended action sends its command through the outbox; busy session blocks it (CD-055)', async () => {
    const idle = await makeCore(gsdState(), 'idle');
    vi.spyOn(idle.api, 'gsdRequest').mockResolvedValue(true);
    const send = vi.spyOn(idle.outbox.getState(), 'send').mockResolvedValue(undefined as never);
    renderStrip(idle);
    fireEvent.click(screen.getByText('Execute phase 2'));
    expect(send).toHaveBeenCalledWith(MACHINE, SESSION, '/gsd-execute-phase 2');
    cleanup();

    // waiting_permission → the strip says so and offers no action chip.
    const busy = await makeCore(gsdState(), 'waiting_permission');
    vi.spyOn(busy.api, 'gsdRequest').mockResolvedValue(true);
    renderStrip(busy);
    expect(screen.getByText('Waiting on you')).toBeTruthy();
    expect(screen.queryByText('Execute phase 2')).toBeNull();
  });
});
