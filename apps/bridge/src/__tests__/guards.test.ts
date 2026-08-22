/**
 * CDX-074: the process-level backstop the `bg()` work kept deferring.
 *
 * Before this, `grep -rn "process.on" packages/*\/src apps/*\/src` found NOTHING
 * — so on Node's default `--unhandled-rejections=throw` a single forgotten
 * background chain still killed the bridge, and the claim "the bridge can no
 * longer be crashed by a fire-and-forget rejection" was false. These tests pin
 * the two halves of the policy and, just as importantly, pin that the guard
 * cannot become the silent-death mode CDX-038/039 already cost us.
 */
import { describe, it, expect } from 'vitest';
import { installProcessGuards, describeReason, type GuardProcess } from '@codedeck/core';

type Listener = (...args: never[]) => void;

/** A fake `process` that lets a test fire the two events synchronously. */
function fakeProc(): GuardProcess & {
  fire(event: 'unhandledRejection' | 'uncaughtException', arg: unknown): void;
  count(event: 'unhandledRejection' | 'uncaughtException'): number;
} {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return this;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    fire(event, arg) {
      for (const l of [...(listeners.get(event) ?? [])]) (l as (a: unknown) => void)(arg);
    },
    count: (event) => listeners.get(event)?.size ?? 0,
  };
}

function harness(over: Partial<Parameters<typeof installProcessGuards>[0]> = {}) {
  const proc = fakeProc();
  const lines: string[] = [];
  const exits: number[] = [];
  const guards = installProcessGuards({
    log: (l) => lines.push(l),
    onFatal: (code) => exits.push(code),
    proc,
    ...over,
  });
  return { proc, lines, exits, guards };
}

describe('installProcessGuards — unhandledRejection (CDX-074)', () => {
  it('a fire-and-forget rejection is LOUD and the process keeps running', () => {
    const { proc, lines, exits, guards } = harness();
    proc.fire('unhandledRejection', new Error('transcript append failed: ENOSPC'));
    expect(exits).toEqual([]); // the whole point: no crash
    expect(guards.rejectionCount()).toBe(1);
    // Loud enough to grep for on a device, and it says what it did NOT do.
    expect(lines[0]).toContain('UNHANDLED REJECTION #1');
    expect(lines[0]).toContain('STILL RUNNING');
    expect(lines[0]).toContain('transcript append failed: ENOSPC');
    expect(lines[0]).toContain('guards.test.ts'); // the stack, not just the message
  });

  it('never swallows: every rejection prints, with an ordinal', () => {
    const { proc, lines } = harness();
    for (let i = 0; i < 5; i++) proc.fire('unhandledRejection', new Error(`boom-${i}`));
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => /UNHANDLED REJECTION #(\d+)/.exec(l)?.[1])).toEqual(['1', '2', '3', '4', '5']);
    expect(lines[4]).toContain('boom-4');
  });

  it('a non-Error reason is inspected, not stringified into [object Object]', () => {
    const { proc, lines } = harness();
    proc.fire('unhandledRejection', { code: 'ENOENT', path: '/nope' });
    expect(lines[0]).not.toContain('[object Object]');
    expect(lines[0]).toContain("code: 'ENOENT'");
    expect(describeReason(undefined)).toBe('undefined');
  });

  it('a rejection STORM is bounded — the bridge stops pretending to be one', () => {
    // Absorbing forever would be the "silently swallows a genuine crash" trap:
    // a process that rejects on every turn is not serving the phone, it is
    // generating log lines. Exit non-zero so a supervisor restarts it clean.
    const { proc, lines, exits } = harness({ maxRejections: 3 });
    for (let i = 0; i < 3; i++) proc.fire('unhandledRejection', new Error('again'));
    expect(exits).toEqual([1]);
    expect(lines.at(-1)).toContain('3 unhandled rejections');
    expect(lines.at(-1)).toContain('Exiting 1');
  });
});

describe('installProcessGuards — uncaughtException (CDX-074)', () => {
  it('exits NON-ZERO and says why — a genuine crash is never survived', () => {
    const { proc, lines, exits } = harness();
    proc.fire('uncaughtException', new TypeError('x is not a function'));
    expect(exits).toEqual([1]);
    expect(lines[0]).toContain('UNCAUGHT EXCEPTION');
    expect(lines[0]).toContain('no longer trustworthy');
    expect(lines[0]).toContain('x is not a function');
  });

  it('CDX-038/039: no path out of the guard is silent', () => {
    // The failure those items fixed was the bridge VANISHING with nothing
    // printed. A handler that exits without a line would reintroduce it.
    const { proc, lines, exits } = harness({ maxRejections: 1 });
    proc.fire('unhandledRejection', new Error('a'));
    proc.fire('uncaughtException', new Error('b'));
    expect(exits).toEqual([1, 1]);
    expect(lines.every((l) => l.startsWith('codedeck-bridge:'))).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(3); // rejection + storm verdict + exception
  });
});

describe('installProcessGuards — host constraints', () => {
  it('CDX-023: exactly two listeners and NOTHING else — nothing can hold the loop open', () => {
    // The guard must not add a timer/socket/ref'd handle, or `run` would stop
    // exiting promptly on SIGTERM. release() must leave the process as found.
    const { proc, guards } = harness();
    expect(proc.count('unhandledRejection')).toBe(1);
    expect(proc.count('uncaughtException')).toBe(1);
    guards.release();
    expect(proc.count('unhandledRejection')).toBe(0);
    expect(proc.count('uncaughtException')).toBe(0);
  });

  it('a host that does not own its process installs the rejection guard ONLY', () => {
    // The VSCode shape. Registering an uncaughtException listener there would
    // suppress Node's default crash for every other extension in the host.
    const { proc, lines, exits, guards } = harness({
      catchUncaughtExceptions: false,
      maxRejections: Number.POSITIVE_INFINITY,
    });
    expect(proc.count('unhandledRejection')).toBe(1);
    expect(proc.count('uncaughtException')).toBe(0);
    for (let i = 0; i < 500; i++) proc.fire('unhandledRejection', new Error('vscode churn'));
    expect(exits).toEqual([]); // no ceiling, so nothing ever calls onFatal
    expect(lines).toHaveLength(500);
    guards.release();
    expect(proc.count('unhandledRejection')).toBe(0);
  });
});
