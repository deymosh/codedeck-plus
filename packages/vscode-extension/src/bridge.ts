/**
 * The bridge processes the extension starts: the long-running `run`, and a
 * `pair --json` for each pairing. Nothing here knows VS Code, so it is
 * tested against real child processes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

export type BridgeState =
  | { kind: 'stopped' }
  /** Spawned, not serving yet. */
  | { kind: 'starting' }
  /**
   * Serving: the bridge has printed its banner, which it does only once it
   * holds its home's lock, so `pair` can reach it from here on.
   */
  | { kind: 'running'; pid: number | undefined }
  /** Another bridge holds this home (a service, a terminal, another window). */
  | { kind: 'elsewhere' }
  | { kind: 'failed'; message: string };

export interface Command {
  command: string;
  args: string[];
}

/** How long a bridge asked to stop gets to close its sessions before it is killed. */
export const STOP_GRACE_MS = 10_000;

/**
 * Runs `command`, handing each line of its stdout and stderr to `onLine`,
 * and resolves with its exit code (`null` when a signal ended it, -1 when it
 * could not be started).
 */
export function runLines(
  { command, args }: Command,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
): { child: ChildProcess; exited: Promise<number | null> } {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const streams = [
    readline.createInterface({ input: child.stdout! }).on('line', (line) => onLine(line, 'stdout')),
    readline.createInterface({ input: child.stderr! }).on('line', (line) => onLine(line, 'stderr')),
  ];
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      onLine(`cannot run ${command}: ${err.message}`, 'stderr');
      resolve(-1);
    });
    // `close`, not `exit`: every line of output has been read by then.
    child.on('close', (code) => {
      streams.forEach((s) => s.close());
      resolve(code);
    });
  });
  return { child, exited };
}

interface Run {
  child: ChildProcess;
  exited: Promise<number | null>;
  stopping: boolean;
}

/** The `codedeck-bridge run` this window started, if any. */
export class Bridge {
  private run: Run | undefined;
  private current: BridgeState = { kind: 'stopped' };

  constructor(
    private readonly onState: (state: BridgeState) => void,
    private readonly onLine: (line: string) => void,
  ) {}

  get state(): BridgeState {
    return this.current;
  }

  /** Starts the bridge; a no-op while one runs. */
  start(command: Command): void {
    if (this.run) return;
    let lastError = '';
    const { child, exited } = runLines(command, (line, stream) => {
      if (stream === 'stderr' && line.trim()) lastError = line.trim();
      if (stream === 'stdout' && this.current.kind === 'starting' && this.run?.child === child) {
        this.set({ kind: 'running', pid: child.pid });
      }
      this.onLine(line);
    });
    const run: Run = { child, exited, stopping: false };
    this.run = run;
    this.set({ kind: 'starting' });
    void exited.then((code) => {
      this.run = undefined;
      if (run.stopping || code === 0) {
        this.set({ kind: 'stopped' });
      } else if (lastError.includes('already running')) {
        // The bridge's own refusal when its home is locked: "a bridge is
        // already running on <home>". Pairing still works through that one.
        this.set({ kind: 'elsewhere' });
      } else {
        this.set({ kind: 'failed', message: lastError || `the bridge exited with code ${code}` });
      }
    });
  }

  /**
   * Stops the bridge and resolves once it has exited: SIGTERM, which it
   * answers by closing its sessions, then a kill after
   * {@link STOP_GRACE_MS}. On Windows the first signal already ends the
   * process; its agent host sees its stdin close and stops the agents.
   */
  async stop(): Promise<void> {
    const run = this.run;
    if (!run) return;
    run.stopping = true;
    run.child.kill('SIGTERM');
    const timer = setTimeout(() => run.child.kill('SIGKILL'), STOP_GRACE_MS);
    await run.exited;
    clearTimeout(timer);
  }

  private set(state: BridgeState): void {
    this.current = state;
    this.onState(state);
  }
}
