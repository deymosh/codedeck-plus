/**
 * Embedded OpenCode server: resolves the `opencode` CLI binary and spawns
 * `opencode serve` as a child process the bridge owns for its own lifetime —
 * the counterpart to `OpenCodeFacade({ baseUrl })`'s EXTERNAL-server mode for
 * bridges that would rather run their own OpenCode server than point at one
 * running elsewhere (`apps/bridge/src/commands.ts` picks between the two).
 *
 * `@opencode-ai/sdk`'s own `createOpencodeServer()` cannot be reused for this:
 * it always spawns the literal string `opencode` (PATH-resolved by
 * cross-spawn) with no way to hand it an explicit binary path or extra env,
 * and returns only a bare `close()` closure with no pid/lifecycle visibility.
 * This module resolves the binary the same way `resolveClaudeExecutable`
 * (facade.ts) and `resolveNvpnPath` (mesh/meshAdmin.ts) resolve theirs —
 * explicit path → env var → `which` → well-known install locations — and
 * spawns it directly so the bridge controls exactly what runs and how it
 * shuts down.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Resolve the `opencode` binary: explicit path → CODEDECK_OPENCODE_PATH →
 *  `which opencode` → well-known global-install locations → null. Mirrors
 *  resolveClaudeExecutable's order (facade.ts) and resolveNvpnPath's shape
 *  (mesh/meshAdmin.ts) — kept consistent rather than inventing a third
 *  resolution order for a third optional binary. */
export function resolveOpenCodePath(
  explicitPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string | null {
  const isFile = (p: string): boolean => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  };

  if (explicitPath && isFile(explicitPath)) return explicitPath;

  const fromEnv = env.CODEDECK_OPENCODE_PATH?.trim();
  if (fromEnv && isFile(fromEnv)) return fromEnv;

  try {
    const out = execFileSync('which', ['opencode'], { timeout: 3000, encoding: 'utf8' }).trim();
    if (out && isFile(out)) return out;
  } catch { /* not on PATH */ }

  const candidates = [
    path.join(homedir, '.local', 'share', 'pnpm', 'opencode'),
    path.join(homedir, '.npm-global', 'bin', 'opencode'),
    path.join(homedir, '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ];
  for (const p of candidates) {
    if (isFile(p)) return p;
  }
  return null;
}

/** Injectable spawn seam for tests — same spirit as meshAdmin.ts's ExecFn. */
export type SpawnFn = typeof spawn;

export interface StartOpenCodeServerOptions {
  /** Resolved binary path (from resolveOpenCodePath) — never a bare command
   *  name, so there is no PATH-resolution ambiguity at spawn time. */
  command: string;
  /** 0 = OS-assigned ephemeral port (default) — avoids collisions with any
   *  other OpenCode instance on the host without needing a config knob. */
  port?: number;
  /** How long to wait for the "opencode server listening on <url>" line
   *  before giving up and killing the process. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
}

export interface OpenCodeServerHandle {
  url: string;
  pid: number | undefined;
  /** SIGTERM, wait, SIGKILL if it doesn't exit in time. Always resolves —
   *  best-effort, matching every other shutdown-path cleanup in this repo. */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Grace period between SIGTERM and SIGKILL on shutdown. */
const CLOSE_GRACE_MS = 5_000;

const LISTENING_PREFIX = 'opencode server listening';

function parseListeningUrl(line: string): string | null {
  if (!line.startsWith(LISTENING_PREFIX)) return null;
  const match = line.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

function closeProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const kill = setTimeout(() => {
      proc.kill('SIGKILL');
    }, CLOSE_GRACE_MS);
    kill.unref?.();
    proc.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

/**
 * Spawn `<command> serve --hostname=127.0.0.1 --port=<port>` and resolve once
 * it prints its ready line. Hostname is hardcoded to loopback — this process
 * is spawned FOR the bridge's own exclusive use, never for anything else to
 * reach, so there is no reason to ever bind it wider.
 */
export function startOpenCodeServer(opts: StartOpenCodeServerOptions): Promise<OpenCodeServerHandle> {
  const port = opts.port ?? 0;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doSpawn = opts.spawnFn ?? spawn;

  return new Promise((resolve, reject) => {
    const proc = doSpawn(
      opts.command,
      ['serve', '--hostname=127.0.0.1', `--port=${port}`],
      { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let settled = false;
    let output = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`opencode serve did not report ready within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      output += chunk.toString();
      for (const line of output.split('\n')) {
        const url = parseListeningUrl(line.trim());
        if (url) {
          settled = true;
          clearTimeout(timer);
          proc.stdout?.off('data', onData);
          proc.stderr?.off('data', onStderr);
          resolve({
            url,
            pid: proc.pid,
            close: () => closeProcess(proc),
          });
          return;
        }
      }
    };
    // Named (not inline) so it can be `.off()`'d at every settle point below —
    // otherwise it outlives this function's promise and keeps appending every
    // stderr chunk from the spawned process into `output` for as long as the
    // bridge keeps the server running, which is unboundedly long.
    const onStderr = (chunk: Buffer): void => { output += chunk.toString(); };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onStderr);

    proc.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off('data', onData);
      proc.stderr?.off('data', onStderr);
      reject(err);
    });
    proc.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off('data', onData);
      proc.stderr?.off('data', onStderr);
      const trimmed = output.trim();
      reject(new Error(`opencode serve exited with code ${code}${trimmed ? `: ${trimmed}` : ''}`));
    });
  });
}
