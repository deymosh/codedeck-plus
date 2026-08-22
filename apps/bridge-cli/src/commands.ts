/**
 * Subcommand implementations (CDB-036): run (default), pair, status, unpair,
 * folders. Thin over @codedeck/core — the CLI contributes argv/config/state
 * plumbing and terminal rendering, nothing protocol-shaped.
 */
import {
  BridgeCore,
  RealSdkFacade,
  listAllWorkspaceFolders,
  resolveClaudeExecutable,
  type MeshAdmin,
  type PairingCloseReason,
  type PoolFactory,
  type SdkFacade,
} from '@codedeck/core';
import type { ResolvedCliConfig } from './config';
import { createCliHost, type CliHost } from './host';
import {
  acquireLock,
  lockHolder,
  CliState,
  LockHeldError,
  type Lock,
  type ProviderProfileSummary,
} from './state';

/** CDX-062: render the stored provider profiles for the banner / `status` —
 *  id, label, base URL, model count, and token PRESENCE only (never the token). */
function formatProviderProfiles(profiles: ProviderProfileSummary[]): string[] {
  if (profiles.length === 0) return [];
  return [
    `  providers:  ${profiles.length} custom profile(s)`,
    ...profiles.map(
      (p) =>
        `    - ${p.id} "${p.label}" ${p.baseUrl} (${p.modelCount} model(s), token ${p.hasToken ? 'yes' : 'no'})`,
    ),
  ];
}

export interface CommandIo {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** Injectable for tests; production = process. */
  onSignal?: (handler: (signal: string) => void) => void;
}

/** Injectable seams for tests (in-memory relay, fake SDK, fake process exit).
 *  Production callers pass nothing and get the real thing. */
export interface CommandDeps {
  facade?: SdkFacade;
  poolFactory?: PoolFactory;
  meshAdmin?: MeshAdmin;
  heartbeatIntervalMs?: number;
  /** Register a handler to run on ACTUAL process exit (default process.once('exit')). */
  onExit?: (handler: () => void) => void;
  /** Force-terminate the process (default process.exit). */
  exit?: (code: number) => void;
  /** CDX-023 failsafe grace after shutdown completes (default 3s). */
  failsafeExitMs?: number;
  /** CDX-038/CDX-039 event-loop keepalive (default: a real ref'd interval).
   *  Injectable so tests can observe that it is taken AND released. */
  holdEventLoop?: () => { release(): void };
  /** Pairing-window duration for `pair`, and for the window `run` opens when
   *  nothing is paired (default: core's 10 min). Tests use a short one. */
  pairingWindowMs?: number;
}

function defaultOnSignal(handler: (signal: string) => void): void {
  process.once('SIGINT', () => handler('SIGINT'));
  process.once('SIGTERM', () => handler('SIGTERM'));
}

/** CDX-033: hold `bridge.lock` until the PROCESS exits, not until the shutdown
 *  hooks resolve. The dying process keeps relay sockets (and possibly the SDK
 *  subprocess) alive for seconds after the hooks complete; releasing the lock
 *  in that window let a fresh `codedeck-bridge run` start alongside the dying
 *  one — two bridges under one identity (device-found, twice). */
function releaseLockOnExit(lock: Lock, deps: CommandDeps): void {
  (deps.onExit ?? ((h) => process.once('exit', h)))(() => lock.release());
}

/**
 * CDX-038 / CDX-039: hold Node's event loop open for as long as a command is
 * meant to be running.
 *
 * NOTHING else in the bridge refs the loop. Every BridgeCore timer (heartbeat,
 * git poll, retention sweep, pairing expiry) is deliberately unref'd, and
 * `process.once('SIGINT')` does not count as a handle — so the only thing that
 * ever kept `run`/`pair` alive was an open relay socket. That produced two
 * device-found failures with one cause:
 *
 *   - CDX-038: with 0 paired phones BridgePool.connect() has no authors to
 *     filter on, skips subscribing entirely, and opens no socket. `run` printed
 *     "No phones paired yet…", the loop drained, and the process exited 0 — so
 *     the first command a new user types quit on them, and a systemd unit
 *     installed before pairing restart-looped.
 *   - CDX-039: `pair`'s only handle is the pairing subscription. When every
 *     relay dropped it (~53s into a 600s window) the loop drained and the
 *     process vanished with no outcome line at all.
 *
 * An explicit ref'd handle makes "the process silently disappeared" impossible;
 * every exit now goes through a path that prints why.
 */
const KEEPALIVE_TICK_MS = 60_000;

export function holdEventLoop(): { release(): void } {
  const timer = setInterval(() => {}, KEEPALIVE_TICK_MS); // deliberately NOT unref'd
  return { release: () => clearInterval(timer) };
}

/** CDX-023 defense-in-depth: after shutdown completes, anything still keeping
 *  the event loop alive is a lingering handle we do not own (known: nostr-tools
 *  2.24.1 arms an uncleared 20s ping-race timer inside AbstractRelay.pingpong()
 *  that relay.close() cannot reach). Give the loop a short grace to drain
 *  naturally, then force the exit. The timer is unref'd, so a clean drain
 *  never waits on it. */
const FAILSAFE_EXIT_MS = 3_000;

function scheduleFailsafeExit(io: CommandIo, deps: CommandDeps, code: number): void {
  const timer = setTimeout(() => {
    io.err.write('codedeck-bridge: event loop still alive after shutdown (lingering relay sockets/timers) — forcing exit.\n');
    (deps.exit ?? process.exit)(code);
  }, deps.failsafeExitMs ?? FAILSAFE_EXIT_MS);
  timer.unref?.();
}

const CLAUDE_MISSING =
  'error: `claude` executable not found on PATH.\n' +
  'Install Claude Code (https://claude.com/claude-code), or point the bridge at it with\n' +
  'CODEDECK_CLAUDE_PATH=/path/to/claude (or --claude-path, or "claudePath" in config.json).';

interface StartedBridge {
  core: BridgeCore;
  host: CliHost;
  lock: Lock;
  state: CliState;
}

/** Shared startup for `run` and `pair`: claude check → lock → identity → core. */
async function startBridge(
  resolved: ResolvedCliConfig,
  io: CommandIo,
  deps: CommandDeps,
): Promise<StartedBridge | number> {
  const claude = resolveClaudeExecutable(resolved.config.claudePath);
  if (!claude) {
    io.err.write(`${CLAUDE_MISSING}\n`);
    return 1;
  }
  resolved.config.claudePath = claude; // pass the resolved binary to every session

  let lock: Lock;
  try {
    lock = acquireLock(resolved.homeDir);
  } catch (e) {
    if (e instanceof LockHeldError) {
      io.err.write(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  try {
    const state = new CliState(resolved.homeDir);
    const keys = state.identity();
    const host = createCliHost({
      config: resolved.config,
      state,
      homeDir: resolved.homeDir,
      npub: keys.npub,
      out: io.out,
      err: io.err,
    });
    const core = await BridgeCore.start({
      host,
      secretKey: keys.secretKey,
      facade: deps.facade ?? new RealSdkFacade(),
      ...(deps.poolFactory ? { poolFactory: deps.poolFactory } : {}),
      ...(deps.meshAdmin ? { meshAdmin: deps.meshAdmin } : {}),
      ...(deps.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: deps.heartbeatIntervalMs }
        : {}),
    });

    io.out.write(
      `codedeck-bridge running\n` +
      `  machine:    ${resolved.config.machineName} (host: ${resolved.config.host})\n` +
      `  npub:       ${keys.npub}\n` +
      `  relays:     ${resolved.config.relays.join(', ')}\n` +
      `  workspaces: ${resolved.config.workspaceRoots.join(', ')}\n` +
      `  claude:     ${claude}\n` +
      `  paired:     ${core.pairedPhones().length} phone(s)\n` +
      formatProviderProfiles(state.providerProfiles()).map((l) => `${l}\n`).join(''),
    );
    return { core, host, lock, state };
  } catch (e) {
    lock.release();
    throw e;
  }
}

/**
 * `run` — long-lived bridge; SIGINT/SIGTERM triggers the truthful offline
 * publish.
 *
 * CDX-038: with 0 paired phones `run` used to print "run `codedeck-bridge
 * pair`" and exit. That advice is not even actionable: `pair` and `run` both
 * take the same `bridge.lock`, so a second terminal would be refused with
 * "a bridge is running (pid N)" — the user had to kill `run` to follow its own
 * instructions. So `run` serves the pairing path ITSELF: it opens a pairing
 * window, renders the QR, and keeps re-opening one for as long as no phone has
 * paired. The moment a phone pairs, the bridge stops offering pairing and just
 * runs. One command for a new user, and nothing ever exits, so a systemd unit
 * installed before pairing cannot restart-loop.
 */
export async function cmdRun(
  resolved: ResolvedCliConfig,
  io: CommandIo,
  deps: CommandDeps = {},
): Promise<number> {
  const started = await startBridge(resolved, io, deps);
  if (typeof started === 'number') return started;
  const { host, core, lock } = started;
  releaseLockOnExit(lock, deps); // CDX-033: NOT released when the hooks resolve
  const keepAlive = (deps.holdEventLoop ?? holdEventLoop)(); // CDX-038/CDX-039

  // CDX-038: an unpaired bridge is useless, so running one IS the request to
  // pair. Windows are re-opened (fresh token each time) only while nothing is
  // paired — pairing stops being on offer as soon as the bridge has a phone.
  const openPairing = (): void => {
    if (core.pairedPhones().length > 0) return;
    io.out.write(
      'No phones paired yet — opening a pairing window. Scan the QR below with the\n' +
      'CodeDeck app (or use the pairing URL / bridge npub). The bridge keeps running\n' +
      'either way; a new window opens automatically until a phone pairs.\n',
    );
    core.openPairingWindow({
      ...(deps.pairingWindowMs !== undefined ? { durationMs: deps.pairingWindowMs } : {}),
      onPaired: (phone) => {
        io.out.write(`Phone "${phone.label}" paired (${phone.npub}). Bridge is now serving it.\n`);
      },
      onClosed: (reason: PairingCloseReason) => {
        if (reason !== 'expired') return; // 'paired'/'closed' need no new window
        io.out.write('Pairing window expired with no phone paired — opening a fresh one.\n');
        openPairing();
      },
    });
  };
  if (core.pairedPhones().length === 0) openPairing();

  await new Promise<void>((resolve) => {
    (io.onSignal ?? defaultOnSignal)((signal) => {
      io.out.write(`Received ${signal} — shutting down gracefully...\n`);
      void host.runShutdownHooks().then(resolve);
    });
  });
  keepAlive.release(); // the process is allowed to end now — and only now
  scheduleFailsafeExit(io, deps, 0); // CDX-023
  return 0;
}

/** `pair` — open the pairing window, render the QR, wait for success/expiry. */
export async function cmdPair(
  resolved: ResolvedCliConfig,
  io: CommandIo,
  deps: CommandDeps = {},
): Promise<number> {
  const started = await startBridge(resolved, io, deps);
  if (typeof started === 'number') return started;
  const { host, core, lock } = started;
  releaseLockOnExit(lock, deps); // CDX-033: same restart race as `run`
  const keepAlive = (deps.holdEventLoop ?? holdEventLoop)(); // CDX-039

  // Fold mesh manual-join info (network id + admin device id, both public)
  // into the QR so the phone can self-join the mesh from the same scan
  // (CDX-028: nvpn 4.1.x removed bearer invites). Best-effort: when nvpn/mesh
  // isn't set up this is null and the pure-pairing QR still works.
  const meshInfo = await core.meshAdmin.onboardingInfo();
  if (meshInfo) {
    io.out.write(
      `Pairing QR includes mesh join info for network ${meshInfo.networkId} (admin ${meshInfo.adminDeviceId.slice(0, 12)}…).\n`,
    );
  }

  // CDX-039: EVERY way out of the wait now resolves to a named outcome, and
  // every outcome prints. A pairing window that ends must never again look
  // like "the phone can't reach the relay".
  const outcome = await new Promise<'paired' | 'expired' | 'aborted' | 'closed'>((resolve) => {
    (io.onSignal ?? defaultOnSignal)((signal) => {
      // The old handler discarded the signal name, so an externally killed
      // `pair` was indistinguishable from one that died on its own.
      io.out.write(`Received ${signal} — aborting pairing.\n`);
      resolve('aborted');
    });
    core.openPairingWindow({
      ...(deps.pairingWindowMs !== undefined ? { durationMs: deps.pairingWindowMs } : {}),
      ...(meshInfo
        ? { mesh: { adminDeviceId: meshInfo.adminDeviceId, netid: meshInfo.networkId } }
        : {}),
      onPaired: (phone) => {
        io.out.write(`Phone "${phone.label}" paired (${phone.npub}).\n`);
        resolve('paired');
      },
      onClosed: (reason: PairingCloseReason) => {
        if (reason === 'expired') resolve('expired');
        // 'closed' = revoked out from under us (nothing in the CLI does this
        // today). Previously it resolved nothing and the process just ended.
        else if (reason === 'closed') resolve('closed');
      },
    });
  });

  if (outcome === 'expired') {
    io.err.write('Pairing window expired — no phone paired. Run `codedeck-bridge pair` again.\n');
  } else if (outcome === 'aborted') {
    io.out.write('Pairing aborted.\n');
  } else if (outcome === 'closed') {
    io.err.write('Pairing window closed before any phone paired. Run `codedeck-bridge pair` again.\n');
  }
  await host.runShutdownHooks();
  keepAlive.release();
  const code = outcome === 'paired' ? 0 : 1;
  scheduleFailsafeExit(io, deps, code); // CDX-023
  return code;
}

/** `status` — report config/identity/pairings/lock without touching the relay
 *  (and without creating an identity as a side effect). */
export async function cmdStatus(resolved: ResolvedCliConfig, io: CommandIo): Promise<number> {
  const { config, homeDir, configFile, configFileExists } = resolved;
  const claude = resolveClaudeExecutable(config.claudePath);
  const holder = lockHolder(homeDir);

  const state = new CliState(homeDir);
  const identity = state.hasIdentity() ? state.identity().npub : null;
  const phones = state.pairedPhones();

  const lines = [
    'codedeck-bridge status',
    `  home:       ${homeDir}`,
    `  config:     ${configFileExists ? configFile : `${configFile} (not found — using defaults)`}`,
    `  machine:    ${config.machineName} (host: ${config.host})`,
    `  identity:   ${identity ?? 'not created yet (created on first `run`/`pair`)'}`,
    `  relays:     ${config.relays.join(', ')}`,
    `  workspaces: ${config.workspaceRoots.join(', ')}`,
    `  claude:     ${claude ?? 'NOT FOUND (install Claude Code or set CODEDECK_CLAUDE_PATH)'}`,
    `  bridge:     ${holder !== null ? `running (pid ${holder})` : 'not running'}`,
    `  paired:     ${phones.length} phone(s)`,
    ...phones.map((p) => `    - ${p.label} ${p.npub} (paired ${p.pairedAt})`),
    ...formatProviderProfiles(state.providerProfiles()),
  ];
  io.out.write(`${lines.join('\n')}\n`);
  return 0;
}

/** `unpair <npub|hex|label>` or `unpair --all`. Refuses while a bridge runs. */
export async function cmdUnpair(
  resolved: ResolvedCliConfig,
  io: CommandIo,
  target: string | undefined,
  all: boolean,
): Promise<number> {
  const holder = lockHolder(resolved.homeDir);
  if (holder !== null) {
    io.err.write(
      `error: a bridge is running (pid ${holder}) and owns the state file. ` +
      'Stop it first, then unpair.\n',
    );
    return 1;
  }
  if (!all && !target) {
    io.err.write('usage: codedeck-bridge unpair <npub|pubkey-hex|label> | --all\n');
    return 1;
  }

  const state = new CliState(resolved.homeDir);
  const phones = state.pairedPhones();
  if (phones.length === 0) {
    io.err.write('No phones are paired.\n');
    return 1;
  }

  const keep = all
    ? []
    : phones.filter((p) => p.npub !== target && p.pubkeyHex !== target && p.label !== target);
  if (!all && keep.length === phones.length) {
    io.err.write(
      `error: no paired phone matches "${target}". Paired:\n` +
      phones.map((p) => `  - ${p.label} ${p.npub}\n`).join(''),
    );
    return 1;
  }

  state.setPairedPhones(keep);
  const removed = phones.length - keep.length;
  io.out.write(`Unpaired ${removed} phone(s). ${keep.length} remaining.\n`);
  return 0;
}

/** `folders` — the project folders a phone's picker would see. */
export async function cmdFolders(resolved: ResolvedCliConfig, io: CommandIo): Promise<number> {
  const folders = listAllWorkspaceFolders(resolved.config.workspaceRoots);
  if (folders.length === 0) {
    io.out.write(`No project folders found under: ${resolved.config.workspaceRoots.join(', ')}\n`);
    return 0;
  }
  io.out.write(`${folders.join('\n')}\n`);
  return 0;
}
