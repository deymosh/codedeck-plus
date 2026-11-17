/**
 * Where the Pi CLI comes from, and the state root every Pi process shares.
 *
 * There is no process pool here: a Pi process serves exactly one conversation
 * (the RPC mode's `new_session` and `--session` switch are the same process,
 * but a CodeDeck session never leaves its own), so each driver session owns
 * one child and closes it with the session (rpc.ts).
 *
 * Pi's own state — provider credentials, settings, sessions — lives under
 * `$PI_CODING_AGENT_DIR`, the directory every process is pointed at. A
 * conversation resumed after a restart is on disk, not in the process.
 */
import * as path from 'node:path';
import { agentCacheDir } from '../../install/agentInstall';
import { isFile } from '../../sdk/executable';
import { packageVersionOf } from '../../sdk/version';

/** `$PI_CODING_AGENT_DIR` inside a CodeDeck-managed home: the directory Pi
 *  writes `settings.json`, `auth.json`, `models.json` and `sessions/` into. */
export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

/** `$CODEDECK_PI_HOME`: the operator's override, else a `pi` directory beside
 *  the installed agent binaries (the bridge passes its own home, so this
 *  follows it). Absolute: a process starts inside `cwd`, so a relative path
 *  would resolve a second time, against the session's working directory. */
export function piHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CODEDECK_PI_HOME?.trim() || path.join(path.dirname(agentCacheDir(env)), 'pi'));
}

/**
 * How to run Pi's CLI: an operator's own entry point may be the bundle's
 * `cli.js` (this host runs it with its own node) or an executable of their
 * own, which is run as it stands. Never through a shell: the arguments a
 * session contributes are never shell syntax.
 */
export function piCommand(entry: string, args: string[]): { command: string; args: string[] } {
  return /\.[cm]?js$/i.test(entry) ? { command: process.execPath, args: [entry, ...args] } : { command: entry, args };
}

export interface PiRuntimeOptions {
  /** An operator-provided CLI (a `pi` they installed and want used,
   *  `CODEDECK_PI_PATH`); wins over the installed tree. */
  piPath?: string;
  cacheDir: string;
  registry?: string;
  log: (message: string) => void;
  /** Installs the runtime tree (install.ts). */
  installPi: (options: { cacheDir: string; registry?: string; log: (message: string) => void }) => Promise<string>;
}

export class PiRuntime {
  private entry: Promise<string> | null = null;
  private knownVersion?: string;

  constructor(private readonly pi: PiRuntimeOptions) {}

  /** The CLI entry point: the operator's own, else the installed tree. */
  entryPoint(): Promise<string> {
    if (this.pi.piPath) {
      // The host's path: Pi starts in the session's cwd, where a relative one
      // would name another file.
      const explicit = path.resolve(this.pi.piPath);
      if (!isFile(explicit)) return Promise.reject(new Error(`CODEDECK_PI_PATH points at ${explicit}, which is not a file`));
      return Promise.resolve(explicit);
    }
    this.entry ??= this.pi
      .installPi({
        cacheDir: this.pi.cacheDir,
        ...(this.pi.registry !== undefined ? { registry: this.pi.registry } : {}),
        log: this.pi.log,
      })
      .catch((error: unknown) => {
        // A download that failed is attempted again by the next session
        // rather than remembered as this driver's permanent state.
        this.entry = null;
        throw error;
      });
    return this.entry;
  }

  /**
   * Resolve the runtime now — installing it when the machine has none — so a
   * session that comes later does not wait for the download. A failure is
   * only logged: the next session asks again, and reports it then.
   */
  async prepare(): Promise<void> {
    try {
      await this.entryPoint();
    } catch (error) {
      this.pi.log(`[pi] the Pi runtime is not ready yet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Pi's own version, from its package's manifest. An operator's own CLI
   * counts too: its entry is followed through symlinks to the package it
   * belongs to. Undefined when no Pi manifest is above it.
   */
  async version(): Promise<string | undefined> {
    if (this.knownVersion !== undefined) return this.knownVersion;
    try {
      // Only a found version is kept: one the tree cannot tell yet may be
      // readable once an install finishes.
      this.knownVersion = await packageVersionOf(await this.entryPoint(), '@earendil-works/pi-coding-agent');
    } catch {
      // No runtime yet: the line goes without.
    }
    return this.knownVersion;
  }

  /** Forget the resolved entry point. Called on host shutdown. */
  async close(): Promise<void> {
    this.entry = null;
  }
}
