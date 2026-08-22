/**
 * CDX-074: the process-level backstop for fire-and-forget failures.
 *
 * The bridge is built out of background chains — transcript appends, registry
 * saves, relay publishes, git polls. CDX-060/074 wrapped the individual ones in
 * `bg()`, but a `bg()` that is itself forgotten, a `void promise` added
 * tomorrow, or a rejection raised inside a listener the SDK calls, all land in
 * the same place: Node's default `--unhandled-rejections=throw`, which turns
 * the rejection into an uncaught exception and **kills the process**.
 *
 * That is precisely the CDX-038/CDX-039 symptom we already paid for once — the
 * bridge disappearing with no outcome line, while a phone still shows a live
 * session and a systemd unit restart-loops. So until this file existed, the
 * claim "the bridge can no longer be crashed by a fire-and-forget rejection"
 * was false no matter how many individual chains were wrapped.
 *
 * The policy, deliberately split, because the two events mean different things:
 *
 * - **unhandledRejection → log loudly, KEEP RUNNING.** A rejected background
 *   promise says one piece of I/O failed; it says nothing about the integrity
 *   of the process. Taking a live bridge (and every session on it) down for it
 *   is a strictly worse outcome than continuing without whatever that chain was
 *   doing. It is NOT swallowed: every one prints an ordinal, the reason and the
 *   stack, so it is greppable in the device logs and the run-sheet can assert
 *   on it. And it is bounded — past `maxRejections` the process has stopped
 *   being a bridge and is just a rejection generator, so it exits non-zero and
 *   lets a supervisor start a clean one.
 *
 * - **uncaughtException → log loudly, EXIT NON-ZERO.** Here the process state
 *   genuinely is untrustworthy (a synchronous throw escaped every frame). This
 *   handler exists only to make the death *diagnosable* and the exit code
 *   *right*, never to survive it. Continuing here is the "handler that silently
 *   swallows a genuine crash" that is worse than no handler at all.
 *
 * Interaction with CDX-023 (`run` must exit promptly on SIGTERM): the guards
 * install two `process.on` listeners and NOTHING else — no timers, no sockets,
 * no ref'd handles — so they cannot hold the event loop open past shutdown, and
 * `release()` removes them. Interaction with CDX-038/039 (the bridge must not
 * silently vanish): every path out of here writes a line first; the ONLY silent
 * exit these guards can produce is none.
 *
 * Hosts that do not own their process — the VS Code extension shares one with
 * every other extension — pass `onFatal` and never let it exit.
 */
import { inspect } from 'node:util';

/** The slice of `process` the guards touch. Injected so tests need no signals. */
export interface GuardProcess {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (...args: never[]) => void): unknown;
  off(event: 'unhandledRejection' | 'uncaughtException', listener: (...args: never[]) => void): unknown;
}

export interface ProcessGuardOptions {
  /** Where the loud lines go. The CLI passes process.stderr; VS Code an OutputChannel writer. */
  log: (line: string) => void;
  /**
   * What "give up" means for this host. Default: `process.exit(code)`.
   * A host that does not own the process (VS Code) passes a no-op that logs —
   * and then NOTHING here ever ends the process.
   */
  onFatal?: (code: number) => void;
  /**
   * Unhandled rejections tolerated before the process is declared unhealthy.
   * `Infinity` disables the bound (the right choice for a shared host, which
   * has no supervisor to restart it). Default 100.
   */
  maxRejections?: number;
  /**
   * Install the `uncaughtException` listener too (default true).
   *
   * A host that does not own its process must pass `false`. Adding an
   * `uncaughtException` listener SUPPRESSES Node's default "print and die" for
   * the WHOLE process — in a VSCode extension host that would silently change
   * crash behaviour for every other extension in it, which is not ours to
   * decide. `unhandledRejection` carries no such risk: VSCode already registers
   * its own listener there, and extra listeners are additive.
   */
  catchUncaughtExceptions?: boolean;
  /** Test seam; production = the real `process`. */
  proc?: GuardProcess;
}

export interface ProcessGuards {
  /** Remove both listeners (tests, and hosts that deactivate). */
  release(): void;
  /** How many unhandled rejections have been absorbed so far. */
  rejectionCount(): number;
}

const DEFAULT_MAX_REJECTIONS = 100;

/** Errors keep their stack; anything else is inspected rather than `String()`d
 *  (a rejected `{ code: 'ENOENT' }` must not print as `[object Object]`). */
export function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  return inspect(reason, { depth: 3 });
}

export function installProcessGuards(opts: ProcessGuardOptions): ProcessGuards {
  const proc = opts.proc ?? (process as unknown as GuardProcess);
  const fatal = opts.onFatal ?? ((code: number) => process.exit(code));
  const max = opts.maxRejections ?? DEFAULT_MAX_REJECTIONS;
  let rejections = 0;

  const onRejection = (reason: unknown): void => {
    rejections++;
    opts.log(
      `codedeck-bridge: UNHANDLED REJECTION #${rejections} — a background promise failed with ` +
        `nobody awaiting it. The bridge is STILL RUNNING (a fire-and-forget failure must not take ` +
        `live sessions down), but whatever that chain was doing did NOT happen:\n` +
        describeReason(reason),
    );
    if (rejections >= max) {
      opts.log(
        `codedeck-bridge: ${rejections} unhandled rejections — this process has stopped being a ` +
          `bridge. Exiting 1 so a supervisor can start a clean one.`,
      );
      fatal(1);
    }
  };

  const onException = (err: unknown): void => {
    opts.log(
      `codedeck-bridge: UNCAUGHT EXCEPTION — a synchronous throw escaped every frame, so this ` +
        `process's state is no longer trustworthy. Exiting 1 (this is NOT a silent death: a ` +
        `supervisor should restart the bridge):\n` +
        describeReason(err),
    );
    fatal(1);
  };

  const catchExceptions = opts.catchUncaughtExceptions ?? true;
  proc.on('unhandledRejection', onRejection as (...args: never[]) => void);
  if (catchExceptions) proc.on('uncaughtException', onException as (...args: never[]) => void);

  return {
    release: () => {
      proc.off('unhandledRejection', onRejection as (...args: never[]) => void);
      if (catchExceptions) proc.off('uncaughtException', onException as (...args: never[]) => void);
    },
    rejectionCount: () => rejections,
  };
}
