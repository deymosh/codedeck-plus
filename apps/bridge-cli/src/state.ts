/**
 * CLI state: `$CODEDECK_HOME/state.json` (mode 0600 — it holds the bridge's
 * secret key) + a pid lockfile so two bridges never share one state file
 * (CDB-036: "refuse double-run with an actionable error").
 *
 * Layout: { "secretKeyHex": "...", "kv": { ... } } — `kv` is the BridgeCore
 * KeyValueStorage (pairedPhones, lastSeenTimestamp, processedEventIds), so the
 * engine and the CLI subcommands share ONE source of truth for paired phones.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  generateKeypair,
  keypairFromSecret,
  bytesToHex,
  hexToBytes,
  type Keypair,
  type KeyValueStorage,
} from '@codedeck/core';
import type { PairedPhone } from '@codedeck/protocol';

const KV_PAIRED_PHONES = 'pairedPhones';
/** CDX-062: BridgeCore's provider-profile key. The stored value holds auth
 *  TOKENS — CliState only ever exposes a redacted summary of it. */
const KV_PROVIDER_PROFILES = 'providerProfiles';

interface StateFile {
  secretKeyHex?: string;
  kv: Record<string, string>;
}

/** Redacted view of one stored provider profile (CDX-062) — the token itself
 *  NEVER leaves state.json via this surface, only `hasToken`. */
export interface ProviderProfileSummary {
  id: string;
  label: string;
  baseUrl: string;
  modelCount: number;
  hasToken: boolean;
}

export class CliState {
  readonly statePath: string;

  private data: StateFile;

  constructor(readonly homeDir: string) {
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    this.statePath = path.join(homeDir, 'state.json');
    this.data = { kv: {} };
    if (fs.existsSync(this.statePath)) {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      } catch (err) {
        throw new Error(
          `corrupt state file ${this.statePath}: ${err instanceof Error ? err.message : err}. ` +
          'Move it aside to start fresh (this loses the bridge identity and pairings).',
        );
      }
      const file = raw as Partial<StateFile>;
      this.data = {
        ...(typeof file.secretKeyHex === 'string' ? { secretKeyHex: file.secretKeyHex } : {}),
        kv: typeof file.kv === 'object' && file.kv !== null ? { ...file.kv } : {},
      };
      // Older/hand-edited files may be group/world readable — tighten on load.
      try { fs.chmodSync(this.statePath, 0o600); } catch { /* best-effort */ }
    }
  }

  /** True once an identity exists on disk (status must not create one). */
  hasIdentity(): boolean {
    return typeof this.data.secretKeyHex === 'string' && this.data.secretKeyHex.length === 64;
  }

  /** The bridge identity, generated + persisted on first use. */
  identity(): Keypair {
    if (this.hasIdentity()) {
      return keypairFromSecret(hexToBytes(this.data.secretKeyHex!));
    }
    const keys = generateKeypair();
    this.data.secretKeyHex = bytesToHex(keys.secretKey);
    this.persist();
    return keys;
  }

  // --- KV (BridgeCore storage) ---

  get(key: string): string | undefined {
    return this.data.kv[key];
  }

  set(key: string, value: string): void {
    this.data.kv[key] = value;
    this.persist();
  }

  delete(key: string): void {
    delete this.data.kv[key];
    this.persist();
  }

  /** Async adapter for BridgeCore's host.storage. */
  storage(): KeyValueStorage {
    return {
      get: async (key) => this.get(key),
      set: async (key, value) => { this.set(key, value); },
      delete: async (key) => { this.delete(key); },
    };
  }

  // --- Paired phones (stored under the same kv key BridgeCore uses) ---

  pairedPhones(): PairedPhone[] {
    const raw = this.get(KV_PAIRED_PHONES);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((p): p is PairedPhone =>
            typeof p === 'object' && p !== null && typeof (p as PairedPhone).pubkeyHex === 'string')
        : [];
    } catch {
      return [];
    }
  }

  setPairedPhones(phones: PairedPhone[]): void {
    this.set(KV_PAIRED_PHONES, JSON.stringify(phones));
  }

  // --- Provider profiles (CDX-062; same kv key BridgeCore uses) ---

  /** Redacted summaries of the stored custom provider profiles — for the
   *  startup banner and `status`. Never returns a token. */
  providerProfiles(): ProviderProfileSummary[] {
    const raw = this.get(KV_PROVIDER_PROFILES);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { profiles?: unknown };
      if (!Array.isArray(parsed.profiles)) return [];
      return parsed.profiles
        .filter((p): p is Record<string, unknown> =>
          typeof p === 'object' && p !== null && typeof (p as Record<string, unknown>).id === 'string')
        .map((p) => ({
          id: String(p.id),
          label: typeof p.label === 'string' ? p.label : '',
          baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
          modelCount: Array.isArray(p.models) ? p.models.length : 0,
          hasToken: typeof p.authToken === 'string' && p.authToken.length > 0,
        }));
    } catch {
      return [];
    }
  }

  /** Atomic 0600 write: temp file in the same dir, chmod, rename. */
  private persist(): void {
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // writeFileSync mode is umask-filtered — enforce explicitly
    fs.renameSync(tmp, this.statePath);
  }
}

// --- Lock (refuse double-run) ---

export class LockHeldError extends Error {
  constructor(readonly pid: number, readonly lockPath: string) {
    super(
      `another codedeck-bridge is already running (pid ${pid}). ` +
      `Stop it first, or delete ${lockPath} if that process is gone.`,
    );
    this.name = 'LockHeldError';
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but owned by someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function lockPathFor(homeDir: string): string {
  return path.join(homeDir, 'bridge.lock');
}

/** The pid currently holding the lock, or null (no lock / stale lock). */
export function lockHolder(homeDir: string): number | null {
  const lockPath = lockPathFor(homeDir);
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export interface Lock {
  lockPath: string;
  release(): void;
}

/**
 * flock-style exclusive-create pid lock. A lockfile whose pid is dead is stale
 * and reclaimed. Throws LockHeldError when a live process holds it.
 */
export function acquireLock(homeDir: string): Lock {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const lockPath = lockPathFor(homeDir);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return {
        lockPath,
        release: () => {
          try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = lockHolder(homeDir);
      if (holder !== null) throw new LockHeldError(holder, lockPath);
      // Stale (dead pid / unreadable) — remove and retry.
      try { fs.rmSync(lockPath, { force: true }); } catch { /* race — retry */ }
    }
  }
  throw new Error(`could not acquire ${lockPath} (repeated races) — is another bridge starting?`);
}
