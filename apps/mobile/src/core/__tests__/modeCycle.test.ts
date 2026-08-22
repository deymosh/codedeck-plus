/**
 * Mode cycle controller (CDX-046) — cycle order, pending → confirmed,
 * pending → timeout-revert, and the 600ms tap cooldown, all on virtual time
 * (injected Timers + now, the deleteController test pattern).
 */
import { describe, expect, it, vi } from 'vitest';
import { ManualTimers } from '@codedeck/testkit';
import type { PermissionMode } from '@codedeck/protocol';
import {
  MODE_CONFIRM_TIMEOUT_MS,
  MODE_CYCLE,
  MODE_LABELS,
  MODE_TAP_COOLDOWN_MS,
  createModeCycle,
} from '../modeCycle';

function harness(initial: PermissionMode | undefined = 'plan') {
  const timers = new ManualTimers();
  let nowMs = 1_000_000;
  let confirmed: PermissionMode | undefined = initial;
  const send = vi.fn();
  const onChange = vi.fn();
  const ctl = createModeCycle({
    send,
    confirmed: () => confirmed,
    onChange,
    timers,
    now: () => nowMs,
  });
  const advance = (ms: number): void => {
    nowMs += ms;
    timers.advance(ms);
  };
  const confirm = (mode: PermissionMode): void => {
    confirmed = mode;
    ctl.noteConfirmed();
  };
  return { ctl, send, onChange, advance, confirm };
}

describe('mode cycle controller (CDX-046)', () => {
  it('taps cycle plan → default → acceptEdits → plan, sending each request', () => {
    const { ctl, send, advance, confirm } = harness('plan');
    expect(ctl.displayed()).toBe('plan');

    ctl.tap();
    expect(send).toHaveBeenNthCalledWith(1, 'default');
    confirm('default');
    advance(MODE_TAP_COOLDOWN_MS);

    ctl.tap();
    expect(send).toHaveBeenNthCalledWith(2, 'acceptEdits');
    confirm('acceptEdits');
    advance(MODE_TAP_COOLDOWN_MS);

    ctl.tap();
    expect(send).toHaveBeenNthCalledWith(3, 'plan');
    confirm('plan');
    expect(ctl.displayed()).toBe('plan');
  });

  it('no confirmed mode yet → treated as plan (legacy fallback), labels cover the cycle', () => {
    const { ctl, send } = harness(undefined);
    expect(ctl.displayed()).toBe('plan');
    ctl.tap();
    expect(send).toHaveBeenCalledWith('default');
    expect(MODE_CYCLE.map((m) => MODE_LABELS[m])).toEqual(['PLAN', 'YOLO', 'EDITS']);
  });

  it('pending → confirmed: shows the requested mode as pending until the matching mode-confirmed lands', () => {
    const { ctl, advance, confirm } = harness('plan');
    ctl.tap();
    expect(ctl.isPending()).toBe(true);
    expect(ctl.displayed()).toBe('default'); // optimistic display, pulsing

    // A non-matching confirmation (stale echo of the old mode) settles nothing.
    confirm('plan');
    expect(ctl.isPending()).toBe(true);

    confirm('default');
    expect(ctl.isPending()).toBe(false);
    expect(ctl.displayed()).toBe('default');

    // The revert timer was cleared — the timeout later must not flip anything.
    advance(MODE_CONFIRM_TIMEOUT_MS + 1_000);
    expect(ctl.displayed()).toBe('default');
  });

  it('pending → timeout: reverts to the last CONFIRMED mode after ~8s of silence', () => {
    const { ctl, onChange, advance } = harness('plan');
    ctl.tap();
    expect(ctl.displayed()).toBe('default');

    advance(MODE_CONFIRM_TIMEOUT_MS - 1);
    expect(ctl.displayed()).toBe('default'); // still waiting

    onChange.mockClear();
    advance(1);
    expect(ctl.isPending()).toBe(false);
    expect(ctl.displayed()).toBe('plan'); // the request is presumed lost
    expect(onChange).toHaveBeenCalled(); // the UI re-renders the revert
  });

  it('600ms cooldown: a second tap inside the window is swallowed', () => {
    const { ctl, send, advance } = harness('plan');
    ctl.tap();
    ctl.tap(); // immediate double-tap
    advance(MODE_TAP_COOLDOWN_MS - 1);
    ctl.tap(); // still inside the window
    expect(send).toHaveBeenCalledTimes(1);

    advance(1); // window over
    ctl.tap();
    expect(send).toHaveBeenCalledTimes(2);
    // Un-confirmed rapid cycling walks on from the pending display.
    expect(send).toHaveBeenNthCalledWith(2, 'acceptEdits');
  });

  it('dispose clears the revert timer', () => {
    const { ctl, onChange, advance } = harness('plan');
    ctl.tap();
    onChange.mockClear();
    ctl.dispose();
    advance(MODE_CONFIRM_TIMEOUT_MS + 1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
