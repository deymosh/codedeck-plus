/**
 * The `dsh --profile acp` process behind the driver: where its entry point
 * comes from, the environment it runs in, and the ACP connection to it.
 *
 * The sharing, respawn and idle close are the ACP runtime's (acp/runtime);
 * what is the harness's own is here: its CLI, the `--profile acp` argument,
 * `$DSH_HOME`, the plugin socket each process gets, and the two things the
 * harness says on stderr that ACP does not carry — a question its model
 * asked, and an MCP server it could not start.
 *
 * The harness's own state — profiles, sessions, credentials — lives under
 * `$DSH_HOME`, the one variable every environment shares: the conversation a
 * session resumes is on disk, not in the process.
 */
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { AcpRuntime, type AcpProcess, type AcpProcessEvents, type AcpProcessSpec, type SpawnFn } from '../../acp/runtime';
import { agentCacheDir } from '../../install/agentInstall';
import { isFile } from '../../sdk/executable';
import { bridgeSocketPath } from './bridge';
import { DSH_LABEL } from './install';
import { BRIDGE_SOCKET_ENV, QUESTION_MARKER } from './plugin';

export type { SpawnFn } from '../../acp/runtime';

/** The ACP profile the driver runs: the automation surface, ACP on stdio. */
export const DSH_PROFILE = 'acp';

/** How the harness reports one MCP server's trouble on stderr, e.g.
 *  `mcp-client(demo): ...`. */
const MCP_FAILURE = /mcp-client\(([^)]+)\)/;

/** What the runtime attaches to one harness process: the socket its CodeDeck
 *  plugin answers on (plugin.ts), and the MCP servers it has complained about
 *  since it started — the one failure signal ACP does not carry. */
export interface DeepSeekChannel {
  readonly socket: string;
  readonly failures: Map<string, string>;
}

/** What the driver is told about a process, whichever sessions it serves. */
export interface DeepSeekProcessEvents extends AcpProcessEvents {
  /** The harness's model asked the user something (the plugin pushes it on
   *  stderr, the one stream that is not the protocol's). */
  question?(line: string): void;
}

/** One live harness process. */
export type DeepSeekProcess = AcpProcess<DeepSeekChannel>;

export interface DeepSeekRuntimeOptions {
  /** An operator-provided CLI entry point (a `dsh` they installed and want
   *  used, `CODEDECK_DEEPSEEK_PATH`); wins over the installed tree. */
  dshPath?: string;
  /** `$DSH_HOME` — the harness's state root. */
  home: string;
  cacheDir: string;
  registry?: string;
  log: (message: string) => void;
  /** Installs the runtime tree (install.ts). */
  installDsh: (options: { cacheDir: string; registry?: string; log: (message: string) => void }) => Promise<string>;
  /** Spawn seam for tests. */
  spawnFn?: SpawnFn;
  /** A counter that changes when the configuration a process loads
   *  changes, read at each spawn. The runtime does not know what that
   *  configuration is; the driver that owns it does. */
  configVersion?: () => number;
  /** How long a process outlives its last session (0 to close at once). */
  idleCloseMs?: number;
}

/** `$DSH_HOME`: the operator's override, else a `dsh` beside the installed
 *  agent binaries (the bridge passes its own home, so this follows it). */
export function dshHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEDECK_DEEPSEEK_HOME?.trim() || path.join(path.dirname(agentCacheDir(env)), 'dsh');
}

/** The harness's profile directory, where its own configuration lives. */
export function dshProfileDir(home: string, profile: string = DSH_PROFILE): string {
  return path.join(home, 'profiles', profile);
}

/**
 * How to run the harness's CLI: an operator's own entry point may be a
 * directory's `bin.js` (this host runs it with its own node) or an executable
 * of their own, which is run as it stands. Never through a shell: the
 * arguments a session contributes are never shell syntax.
 */
export function dshCommand(entry: string, args: string[]): { command: string; args: string[] } {
  return /\.[cm]?js$/i.test(entry) ? { command: process.execPath, args: [entry, ...args] } : { command: entry, args };
}

export class DeepSeekRuntime extends AcpRuntime<DeepSeekChannel, DeepSeekProcessEvents> {
  private entry: Promise<string> | null = null;
  private knownVersion?: string;

  constructor(private readonly dsh: DeepSeekRuntimeOptions) {
    super({
      log: dsh.log,
      tag: 'deepseek',
      label: DSH_LABEL,
      spawnFn: dsh.spawnFn,
      configVersion: dsh.configVersion,
      idleCloseMs: dsh.idleCloseMs,
    });
  }

  /** The CLI entry point: the operator's own, else the installed tree. */
  override entryPoint(): Promise<string> {
    if (this.dsh.dshPath) {
      const explicit = this.dsh.dshPath;
      if (!isFile(explicit)) return Promise.reject(new Error(`CODEDECK_DEEPSEEK_PATH points at ${explicit}, which is not a file`));
      return Promise.resolve(explicit);
    }
    this.entry ??= this.dsh
      .installDsh({
        cacheDir: this.dsh.cacheDir,
        ...(this.dsh.registry !== undefined ? { registry: this.dsh.registry } : {}),
        log: this.log,
      })
      .catch((error: unknown) => {
        // A download that failed is attempted again by the next session
        // rather than remembered as this driver's permanent state.
        this.entry = null;
        throw error;
      });
    return this.entry;
  }

  /** One process's command, environment and handle. */
  protected override spec(entry: string, env: Record<string, string>): AcpProcessSpec<DeepSeekChannel> {
    // The harness's state root is the driver's to set, never the session's:
    // a session that moved it would lose the conversation it is resuming.
    const command = dshCommand(entry, ['--profile', DSH_PROFILE]);
    // Not part of the environment's identity (the runtime hashes it to share
    // processes): it names this one process, whichever sessions share it.
    const socket = bridgeSocketPath(this.dsh.home, randomBytes(6).toString('hex'));
    return {
      command: command.command,
      args: command.args,
      env: { ...env, DSH_HOME: this.dsh.home, [BRIDGE_SOCKET_ENV]: socket },
      handle: { socket, failures: new Map() },
      detail: `profile ${DSH_PROFILE}`,
    };
  }

  /** The harness logs its own diagnostics on stderr (ACP owns stdout). A
   *  failed MCP server is only visible there, so those lines are read as a
   *  status signal; a question this bridge is asked to carry is the driver's,
   *  not the log's. */
  protected override stderr(line: string, process_: DeepSeekProcess, events: DeepSeekProcessEvents): boolean {
    if (line.includes(QUESTION_MARKER)) {
      events.question?.(line);
      return true;
    }
    const failure = MCP_FAILURE.exec(line);
    if (failure?.[1] !== undefined) process_.handle.failures.set(failure[1], line);
    return false;
  }

  /** The plugin removes its socket as it closes; a process that was killed
   *  never got to, and the path is nobody's now. */
  protected override cleanup(process_: DeepSeekProcess): void {
    if (process.platform !== 'win32') rmSync(process_.handle.socket, { force: true });
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
      this.log(`[deepseek] the DeepSeek Harness runtime is not ready yet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The runtime's own `node_modules`: every `@deepseek-ai/*` package the
   * harness ships resolves from here, which is where a shipped bundle's
   * version is found (a profile installs only what a user added).
   */
  async packagesRoot(): Promise<string | undefined> {
    let file = await this.entryPoint();
    for (let depth = 0; depth < 8; depth++) {
      const dir = path.dirname(file);
      if (dir === file) break;
      if (path.basename(dir) === 'node_modules') return dir;
      file = dir;
    }
    return undefined;
  }

  /**
   * The harness's own version, from its package's manifest: what `initialize`
   * reports as `agentInfo` is a fixed placeholder (`0.0.1`), not the release.
   * Undefined when the runtime is not one the tree describes (an operator's
   * own entry point outside any `node_modules`).
   */
  async version(): Promise<string | undefined> {
    if (this.knownVersion !== undefined) return this.knownVersion;
    try {
      const root = await this.packagesRoot();
      if (root === undefined) return undefined;
      const manifest = JSON.parse(await readFile(path.join(root, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      // Only a found version is kept: one the tree cannot tell yet may be
      // readable once an install finishes.
      if (typeof manifest.version === 'string') this.knownVersion = manifest.version;
    } catch {
      // No runtime yet, or a tree without the manifest: the line goes without.
    }
    return this.knownVersion;
  }

  /** Close every process, and forget the resolved entry point. Called on host
   *  shutdown. */
  override async close(): Promise<void> {
    await super.close();
    this.entry = null;
  }
}
