/**
 * The `qwen --acp` process behind the driver: where its entry point comes
 * from, the environment it runs in, and the ACP connection to it.
 *
 * The sharing, respawn and idle close are the ACP runtime's (acp/runtime);
 * what is Qwen Code's own is here: its CLI, the `--acp` argument, `$QWEN_HOME`,
 * and the two switches that keep it from updating itself or phoning home.
 *
 * Qwen Code's state — its settings, its conversation transcripts — lives under
 * `$QWEN_HOME`, the one variable every environment shares: the conversation a
 * session resumes is on disk, not in the process. The driver writes the
 * provider settings there (settings.ts); this module only points the process
 * at the directory.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { AcpRuntime, type AcpProcessEvents, type AcpProcessSpec, type SpawnFn } from '../../acp/runtime';
import { agentCacheDir } from '../../install/agentInstall';
import { isFile } from '../../sdk/executable';
import { QWEN_LABEL } from './install';

export type { SpawnFn } from '../../acp/runtime';

/** `$QWEN_HOME`: the operator's override, else a `qwen` directory beside the
 *  installed agent binaries (the bridge passes its own home, so this follows
 *  it). Qwen Code reads its settings and writes its transcripts here. */
export function qwenHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEDECK_QWEN_HOME?.trim() || path.join(path.dirname(agentCacheDir(env)), 'qwen');
}

/** Qwen Code's settings file, directly inside `$QWEN_HOME`. */
export function qwenSettingsPath(home: string): string {
  return path.join(home, 'settings.json');
}

/** The environment every Qwen process runs with: telemetry and the usage
 *  statistics ping off, whatever the operator's own settings say. */
export const QWEN_OFF_ENV: Record<string, string> = {
  QWEN_TELEMETRY_ENABLED: 'false',
  QWEN_USAGE_STATISTICS_ENABLED: 'false',
};

/**
 * How to run Qwen Code's CLI: an operator's own entry point may be a
 * `cli-entry.js` (this host runs it with its own node) or an executable of
 * their own, which is run as it stands. Never through a shell: the arguments a
 * session contributes are never shell syntax.
 */
export function qwenCommand(entry: string, args: string[]): { command: string; args: string[] } {
  return /\.[cm]?js$/i.test(entry) ? { command: process.execPath, args: [entry, ...args] } : { command: entry, args };
}

export interface QwenRuntimeOptions {
  /** An operator-provided CLI entry point (a `qwen` they installed and want
   *  used, `CODEDECK_QWEN_PATH`); wins over the installed tree. */
  qwenPath?: string;
  /** `$QWEN_HOME` — Qwen Code's state root. */
  home: string;
  cacheDir: string;
  registry?: string;
  log: (message: string) => void;
  /** Installs the runtime tree (install.ts). */
  installQwen: (options: { cacheDir: string; registry?: string; log: (message: string) => void }) => Promise<string>;
  /** Spawn seam for tests. */
  spawnFn?: SpawnFn;
  /** How long a process outlives its last session (0 to close at once). */
  idleCloseMs?: number;
}

export class QwenRuntime extends AcpRuntime<undefined, AcpProcessEvents> {
  private entry: Promise<string> | null = null;
  private knownVersion?: string;

  constructor(private readonly qwen: QwenRuntimeOptions) {
    super({
      log: qwen.log,
      tag: 'qwen',
      label: QWEN_LABEL,
      spawnFn: qwen.spawnFn,
      idleCloseMs: qwen.idleCloseMs,
    });
  }

  /** The CLI entry point: the operator's own, else the installed tree. */
  override entryPoint(): Promise<string> {
    if (this.qwen.qwenPath) {
      const explicit = this.qwen.qwenPath;
      if (!isFile(explicit)) return Promise.reject(new Error(`CODEDECK_QWEN_PATH points at ${explicit}, which is not a file`));
      return Promise.resolve(explicit);
    }
    this.entry ??= this.qwen
      .installQwen({
        cacheDir: this.qwen.cacheDir,
        ...(this.qwen.registry !== undefined ? { registry: this.qwen.registry } : {}),
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

  /** One process's command and environment. */
  protected override spec(entry: string, env: Record<string, string>): AcpProcessSpec<undefined> {
    const command = qwenCommand(entry, ['--acp']);
    // Qwen Code's state root is the driver's to set, never the session's: a
    // session that moved it would lose the conversation it is resuming.
    return {
      command: command.command,
      args: command.args,
      env: { ...env, ...QWEN_OFF_ENV, QWEN_HOME: this.qwen.home },
      handle: undefined,
      detail: 'acp',
    };
  }

  /**
   * Resolve the runtime now — installing it when the machine has none — so a
   * session that comes later does not wait for the download. A failure is only
   * logged: the next session asks again, and reports it then.
   */
  async prepare(): Promise<void> {
    try {
      await this.entryPoint();
    } catch (error) {
      this.log(`[qwen] the Qwen Code runtime is not ready yet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Qwen Code's own version, from its package's manifest. `initialize`
   * reports the real release as `agentInfo.version` (the session reads that
   * directly); this is for a reader that has no process — and undefined for an
   * operator's own entry point outside any package directory.
   */
  async version(): Promise<string | undefined> {
    if (this.knownVersion !== undefined) return this.knownVersion;
    try {
      const root = await this.packagesRoot();
      if (root === undefined) return undefined;
      const manifest = JSON.parse(await readFile(path.join(root, '@qwen-code', 'qwen-code', 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      if (typeof manifest.version === 'string') this.knownVersion = manifest.version;
    } catch {
      // No runtime yet, or a tree without the manifest: the line goes without.
    }
    return this.knownVersion;
  }

  /** The `node_modules` the installed tree sits in, or undefined for an
   *  operator's own entry point. */
  private async packagesRoot(): Promise<string | undefined> {
    let file = await this.entryPoint();
    for (let depth = 0; depth < 8; depth++) {
      const dir = path.dirname(file);
      if (dir === file) break;
      if (path.basename(dir) === 'node_modules') return dir;
      file = dir;
    }
    return undefined;
  }

  /** Close every process, and forget the resolved entry point. Called on host
   *  shutdown. */
  override async close(): Promise<void> {
    await super.close();
    this.entry = null;
  }
}
