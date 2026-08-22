/**
 * CLI state file (0600, atomic, one source of truth for pairings) + the
 * double-run lock (CDB-036: refuse with an actionable error).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { statSync, writeFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliState, acquireLock, lockHolder, lockPathFor, LockHeldError } from '../state';

let home: string;

beforeEach(() => {
  home = path.join(os.tmpdir(), `codedeck-cli-state-${process.pid}-${Math.random().toString(36).slice(2)}`);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('CliState', () => {
  it('creates the home dir 0700 and state.json 0600', () => {
    const state = new CliState(home);
    state.identity();
    expect(mode(home)).toBe(0o700);
    expect(mode(state.statePath)).toBe(0o600);
  });

  it('persists the identity across instances (secret key round-trip)', () => {
    const first = new CliState(home);
    expect(first.hasIdentity()).toBe(false);
    const keys = first.identity();
    const second = new CliState(home);
    expect(second.hasIdentity()).toBe(true);
    expect(second.identity().npub).toBe(keys.npub);
    expect(second.identity().pubkeyHex).toBe(keys.pubkeyHex);
  });

  it('kv round-trips and survives reload; storage() adapts it for BridgeCore', async () => {
    const state = new CliState(home);
    state.set('lastSeenTimestamp', '123');
    const storage = state.storage();
    await storage.set('processedEventIds', '["a","b"]');
    expect(await storage.get('lastSeenTimestamp')).toBe('123');

    const reloaded = new CliState(home);
    expect(reloaded.get('processedEventIds')).toBe('["a","b"]');
    reloaded.delete('lastSeenTimestamp');
    expect(new CliState(home).get('lastSeenTimestamp')).toBeUndefined();
  });

  it('pairedPhones() reads/writes the same kv key BridgeCore uses', () => {
    const state = new CliState(home);
    expect(state.pairedPhones()).toEqual([]);
    const phone = { npub: 'npub1x', pubkeyHex: 'ab'.repeat(32), label: 'Pixel', pairedAt: 'now' };
    state.setPairedPhones([phone]);
    // BridgeCore reads host.storage.get('pairedPhones') — same bytes.
    expect(JSON.parse(new CliState(home).get('pairedPhones')!)).toEqual([phone]);
    expect(new CliState(home).pairedPhones()).toEqual([phone]);
  });

  it('rejects a corrupt state file with an actionable error (never silently regenerates the key)', () => {
    const state = new CliState(home);
    state.identity();
    writeFileSync(state.statePath, '{broken');
    expect(() => new CliState(home)).toThrow(/corrupt state file .*state\.json/);
  });
});

describe('lock', () => {
  it('acquire → holder visible → release → reacquirable', () => {
    const lock = acquireLock(home);
    expect(existsSync(lockPathFor(home))).toBe(true);
    expect(lockHolder(home)).toBe(process.pid);
    lock.release();
    expect(lockHolder(home)).toBeNull();
    acquireLock(home).release();
  });

  it('refuses a second instance with pid + lock path in the error', () => {
    const lock = acquireLock(home);
    try {
      expect(() => acquireLock(home)).toThrow(LockHeldError);
      try {
        acquireLock(home);
        expect.unreachable('second acquire must throw');
      } catch (e) {
        const err = e as LockHeldError;
        expect(err.message).toContain(`pid ${process.pid}`);
        expect(err.message).toContain(lockPathFor(home));
      }
    } finally {
      lock.release();
    }
  });

  it('reclaims a stale lock left by a dead pid', () => {
    acquireLock(home).release();
    // Forge a lock from a pid that cannot be alive (max pid is far below this).
    writeFileSync(lockPathFor(home), '999999999\n');
    expect(lockHolder(home)).toBeNull();
    const lock = acquireLock(home); // must not throw
    expect(lockHolder(home)).toBe(process.pid);
    lock.release();
  });
});
