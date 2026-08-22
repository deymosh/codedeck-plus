/**
 * SessionRegistry: persistence across instances, atomic rewrites, markOffline
 * (the truthful-shutdown fix), tombstone cap, and RemoteSessionInfo mapping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRegistry, type SessionRecord } from '../session/registry';

function record(id: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id,
    sdkSessionId: null,
    cwd: `/work/${id}`,
    title: null,
    project: 'proj',
    createdAt: '2026-08-05T00:00:00Z',
    lastActivity: '2026-08-05T00:00:00Z',
    state: 'idle',
    ...patch,
  };
}

describe('SessionRegistry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-registry-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('mutations persist across a new instance (restart)', async () => {
    const reg = new SessionRegistry(dir);
    await reg.upsert(record('s1', { model: 'opus', effortLevel: 'high' }));
    await reg.upsert(record('s2'));
    await reg.update('s1', { sdkSessionId: 'sdk-abc', state: 'running', title: 'Fix the bug' });
    await reg.remove('s2');

    const reopened = new SessionRegistry(dir);
    expect(reopened.list()).toHaveLength(1);
    const s1 = reopened.get('s1');
    expect(s1?.sdkSessionId).toBe('sdk-abc');
    expect(s1?.state).toBe('running');
    expect(s1?.title).toBe('Fix the bug');
    expect(s1?.model).toBe('opus');
    expect(reopened.get('s2')).toBeUndefined();
    expect(reopened.removedSessions()).toEqual(['s2']);
  });

  it('update of an unknown session resolves undefined without creating it', async () => {
    const reg = new SessionRegistry(dir);
    expect(await reg.update('ghost', { state: 'running' })).toBeUndefined();
    expect(reg.list()).toHaveLength(0);
  });

  it('markOffline flips every session to offline and persists it', async () => {
    const reg = new SessionRegistry(dir);
    await reg.upsert(record('s1', { state: 'running' }));
    await reg.upsert(record('s2', { state: 'waiting_permission' }));
    await reg.markOffline();

    expect(reg.list().every((r) => r.state === 'offline')).toBe(true);
    const reopened = new SessionRegistry(dir);
    expect(reopened.list().every((r) => r.state === 'offline')).toBe(true);
  });

  it('tombstone list caps at 100, FIFO', async () => {
    const reg = new SessionRegistry(dir);
    for (let i = 1; i <= 105; i++) {
      await reg.remove(`s${i}`);
    }
    const removed = reg.removedSessions();
    expect(removed).toHaveLength(100);
    expect(removed[0]).toBe('s6'); // oldest 5 evicted
    expect(removed[99]).toBe('s105');

    const reopened = new SessionRegistry(dir);
    expect(reopened.removedSessions()).toEqual(removed);
  });

  it('remove reports whether the session existed and does not duplicate tombstones', async () => {
    const reg = new SessionRegistry(dir);
    await reg.upsert(record('s1'));
    expect(await reg.remove('s1')).toBe(true);
    expect(await reg.remove('s1')).toBe(false);
    expect(reg.removedSessions()).toEqual(['s1']);
  });

  it('registry.json is always complete JSON after every mutation (atomic rewrite)', async () => {
    const file = path.join(dir, 'registry.json');
    const reg = new SessionRegistry(dir);
    for (let i = 1; i <= 10; i++) {
      await reg.upsert(record(`s${i}`));
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { sessions: unknown[] };
      expect(parsed.sessions).toHaveLength(i);
    }
  });

  it('garbage temp files around registry.json do not affect loading', async () => {
    const reg = new SessionRegistry(dir);
    await reg.upsert(record('s1'));
    // Simulated crash debris: half-written temp files that never got renamed.
    await fs.writeFile(path.join(dir, 'registry.json.tmp-9999-1'), '{"sessions": [{"sess');
    await fs.writeFile(path.join(dir, 'registry.json.tmp-9999-2'), 'not json at all');

    const reopened = new SessionRegistry(dir);
    expect(reopened.get('s1')).toBeDefined();
    expect(reopened.list()).toHaveLength(1);
  });

  it('a corrupt registry.json is moved aside instead of crashing the bridge', async () => {
    await fs.writeFile(path.join(dir, 'registry.json'), '{"sessions": [{"truncated');
    const logs: string[] = [];
    const reg = new SessionRegistry(dir, (msg) => logs.push(msg));
    expect(reg.list()).toEqual([]);
    expect(logs.some((l) => l.includes('corrupt'))).toBe(true);
    await expect(fs.access(path.join(dir, 'registry.json.corrupt'))).resolves.toBeUndefined();
  });

  it('toRemoteSessionInfo maps records + transcript seqHigh', async () => {
    const reg = new SessionRegistry(dir);
    await reg.upsert(record('session-alpha', {
      model: 'opus',
      effortLevel: 'high',
      permissionMode: 'acceptEdits',
      title: 'T',
      state: 'running',
    }));
    await reg.upsert(record('session-beta'));

    const seqHighs: Record<string, number> = { 'session-alpha': 42 };
    const infos = reg.toRemoteSessionInfo({ seqHigh: (id) => seqHighs[id] ?? 0 });

    const alpha = infos.find((i) => i.id === 'session-alpha');
    expect(alpha).toMatchObject({
      id: 'session-alpha',
      slug: 'session-',
      cwd: '/work/session-alpha',
      lineCount: 42,
      seqHigh: 42,
      title: 'T',
      project: 'proj',
      state: 'running',
      model: 'opus',
      effortLevel: 'high',
      permissionMode: 'acceptEdits',
    });

    const beta = infos.find((i) => i.id === 'session-beta');
    expect(beta?.seqHigh).toBe(0);
    expect(beta?.lineCount).toBe(0);
    expect(beta?.model).toBeUndefined();
  });

  it('list() and get() return copies — external mutation does not leak in', async () => {
    const reg = new SessionRegistry(dir);
    await reg.upsert(record('s1'));
    const got = reg.get('s1');
    if (got) { got.state = 'running'; }
    expect(reg.get('s1')?.state).toBe('idle');
  });

  // --- CDX-060: the `ENOENT rename registry.json.tmp-…` parallel-load flake ---

  it('CDX-060: two instances over the same dir save concurrently without temp-name collisions', async () => {
    // Pre-fix, both instances (same pid, per-instance counters) produced the
    // IDENTICAL `registry.json.tmp-<pid>-<n>` sequence; interleaved saves then
    // renamed each other's temp file away → ENOENT on the loser's rename. The
    // shared per-process counter makes this deterministic-green.
    const a = new SessionRegistry(dir);
    const b = new SessionRegistry(dir);
    const writes: Promise<unknown>[] = [];
    for (let i = 1; i <= 40; i++) {
      writes.push(a.upsert(record(`a${i}`)));
      writes.push(b.upsert(record(`b${i}`)));
    }
    await Promise.all(writes); // pre-fix: a coin-flip ENOENT rejection here

    // What CDX-060 actually guarantees, and all it guarantees: no rejection
    // above, and a registry.json that is complete, parseable, and made of
    // well-formed records — never torn or half-merged.
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'registry.json'), 'utf8')) as {
      sessions: SessionRecord[];
      removedSessions: string[];
    };
    expect(Array.isArray(parsed.sessions)).toBe(true);
    for (const rec of parsed.sessions) {
      expect(typeof rec.sessionId).toBe('string');
      expect(rec.cwd).toBe(`/work/${rec.sessionId}`); // record intact, not spliced
    }
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);

    // KNOWN HAZARD — CDX-075, filed and UNFIXED. persist() serializes the WHOLE
    // in-memory map, so the last rename replaces the other instance's snapshot
    // outright: this is a whole-file lost update (the real two-bridge CDX-033
    // hazard), NOT correct behaviour, and it must not be asserted as such. The
    // invariant below is the one a fix must preserve — at least one instance's
    // complete 40-record snapshot survives un-torn — and it holds BOTH today
    // (40/0) and after a merging fix lands (40/40), so CDX-075 will not have to
    // break this suite to be correct.
    const ids = parsed.sessions.map((r) => r.sessionId);
    const fromA = ids.filter((id) => id.startsWith('a')).length;
    const fromB = ids.filter((id) => id.startsWith('b')).length;
    expect(Math.max(fromA, fromB)).toBe(40);
  });

  it('CDX-060: ENOENT on rename is retried as a lost race, not thrown', async () => {
    const reg = new SessionRegistry(dir);
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file or directory, rename 'registry.json.tmp-x'"), {
        code: 'ENOENT',
      }),
    );
    try {
      await reg.upsert(record('s1')); // must succeed via the retry
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
    const reopened = new SessionRegistry(dir);
    expect(reopened.get('s1')).toBeDefined();
  });

  it('CDX-060: a non-ENOENT rename failure still surfaces to an awaiting caller and does not wedge the chain', async () => {
    const reg = new SessionRegistry(dir);
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );
    try {
      await expect(reg.upsert(record('s1'))).rejects.toThrow('EACCES');
    } finally {
      spy.mockRestore();
    }
    await reg.upsert(record('s2')); // the chain kept going
    expect(new SessionRegistry(dir).get('s2')).toBeDefined();
  });

  it('CDX-060: a fire-and-forget update whose persist fails logs instead of raising an unhandled rejection', async () => {
    const logs: string[] = [];
    const reg = new SessionRegistry(dir, (m) => logs.push(m));
    await reg.upsert(record('s1'));

    // Both the attempt and its retry fail — the terminal-failure path.
    const spy = vi.spyOn(fs, 'rename').mockImplementation(() =>
      Promise.reject(Object.assign(new Error('ENOENT: rename'), { code: 'ENOENT' })),
    );
    try {
      // The runner's pattern: `void this.registry.update(…)`. Pre-fix this
      // rejected a promise nobody held → an unhandled rejection that vitest
      // pinned on whatever unrelated test was running (the 4-random-reds form
      // of the flake). Vitest fails THIS test if one escapes now.
      void reg.update('s1', { state: 'running' });
      const start = Date.now();
      while (!logs.some((l) => l.includes('persist failed')) && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      spy.mockRestore();
    }
    expect(logs.some((l) => l.includes('persist failed'))).toBe(true);

    await reg.upsert(record('s2')); // and the chain survived the failure
    expect(reg.get('s2')).toBeDefined();
  });
});
