/**
 * mergeSessionList — the bug-B session-loss killer, tested property-style:
 * absence marks stale and NEVER deletes; removal only via tombstones or user
 * delete; machineOffline keeps sessions; grace periods; persist round-trips
 * can never truncate.
 */
import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  type ModelsMessage,
  type RemoteSessionInfo,
  type SessionListMessage,
} from '@codedeck/protocol';
import {
  createMachinesStore,
  hydrateMachines,
  mergeSessionList,
  serializeMachines,
  titleFromFirstMessage,
  type SessionView,
} from '../stores/machines';
import { memoryKV } from '../ports';

const info = (id: string, patch: Partial<RemoteSessionInfo> = {}): RemoteSessionInfo => ({
  id,
  slug: `slug-${id}`,
  cwd: '/work',
  lastActivity: new Date(0).toISOString(),
  lineCount: 0,
  title: null,
  project: 'proj',
  ...patch,
});

const list = (
  sessions: RemoteSessionInfo[],
  patch: Partial<SessionListMessage> = {},
): SessionListMessage => ({
  type: 'sessions',
  machine: 'm1',
  sessions,
  protocolVersion: PROTOCOL_VERSION,
  ...patch,
});

const view = (id: string, presence: SessionView['presence'] = 'live', lastListedAt = 0): SessionView => ({
  info: info(id),
  presence,
  lastListedAt,
});

describe('mergeSessionList — contract cases', () => {
  it('upserts listed sessions as live', () => {
    const next = mergeSessionList({}, list([info('a'), info('b')]), 100);
    expect(Object.keys(next).sort()).toEqual(['a', 'b']);
    expect(next['a']!.presence).toBe('live');
    expect(next['a']!.lastListedAt).toBe(100);
  });

  it('ABSENCE NEVER DELETES: a missing session is kept and marked stale', () => {
    const prev = { a: view('a'), b: view('b') };
    const next = mergeSessionList(prev, list([info('a')]), 100);
    expect(next['b']).toBeDefined();
    expect(next['b']!.presence).toBe('stale');
    expect(next['a']!.presence).toBe('live');
  });

  it('an EMPTY incoming list deletes nothing (the old data-loss vector)', () => {
    const prev = { a: view('a'), b: view('b'), c: view('c') };
    const next = mergeSessionList(prev, list([]), 100);
    expect(Object.keys(next).sort()).toEqual(['a', 'b', 'c']);
    expect(Object.values(next).every((v) => v.presence === 'stale')).toBe(true);
  });

  it('tombstones are the only bridge-driven removal, and only hit their target', () => {
    const prev = { a: view('a'), b: view('b') };
    const next = mergeSessionList(prev, list([info('a')], { removedSessions: ['b'] }), 100);
    expect(next['b']).toBeUndefined();
    expect(next['a']).toBeDefined();
  });

  it('a tombstone for an unknown session is harmless', () => {
    const next = mergeSessionList({ a: view('a') }, list([info('a')], { removedSessions: ['ghost'] }), 100);
    expect(Object.keys(next)).toEqual(['a']);
  });

  it('machineOffline keeps every session, marked offline — never an empty view', () => {
    const prev = { a: view('a'), b: view('b') };
    const next = mergeSessionList(
      prev,
      list([info('a', { state: 'offline' })], { machineOffline: true }),
      100,
    );
    expect(Object.keys(next).sort()).toEqual(['a', 'b']);
    expect(next['a']!.presence).toBe('offline');
    expect(next['b']!.presence).toBe('offline');
  });

  it('grace period: a recently-listed absentee keeps its presence, an old one goes stale', () => {
    const prev = { fresh: view('fresh', 'live', 95), old: view('old', 'live', 10) };
    const next = mergeSessionList(prev, list([]), 100, { staleGraceMs: 10 });
    expect(next['fresh']!.presence).toBe('live');
    expect(next['old']!.presence).toBe('stale');
  });

  it('does not mutate prev (pure)', () => {
    const prev = { a: view('a') };
    const frozen = JSON.stringify(prev);
    mergeSessionList(prev, list([], { removedSessions: ['a'] }), 100);
    expect(JSON.stringify(prev)).toBe(frozen);
  });
});

// --- Property-style: random op sequences preserve the no-loss invariant ---

/** Deterministic LCG so failures are reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe('title merge guard (Phase 6) — incoming.title ?? prev.title semantics', () => {
  const titled = (id: string, title: string): SessionView => ({
    info: info(id, { title }),
    presence: 'live',
    lastListedAt: 0,
  });

  it('a titleless (null) incoming session keeps the previously held title', () => {
    const next = mergeSessionList({ s1: titled('s1', 'client stopgap') }, list([info('s1')]), 1);
    expect(next['s1']!.info.title).toBe('client stopgap');
  });

  it('a non-null incoming title always wins (bridge topical title overwrites the stopgap)', () => {
    const next = mergeSessionList(
      { s1: titled('s1', 'client stopgap') },
      list([info('s1', { title: 'bridge topical' })]),
      1,
    );
    expect(next['s1']!.info.title).toBe('bridge topical');
  });

  it('no previous title → incoming null stays null (no fabrication)', () => {
    const next = mergeSessionList({ s1: view('s1') }, list([info('s1')]), 1);
    expect(next['s1']!.info.title).toBeNull();
  });

  it('the guard also covers applySessionUpsert and applySessionReplaced', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().registerMachine({ pubkeyHex: 'm1', name: 'm1' });
    store.getState().applySessionUpsert('m1', info('s1'), 0);
    store.getState().noteFirstUserMessage('m1', 's1', 'stopgap');

    // Titleless upsert of the same session keeps the stopgap.
    store.getState().applySessionUpsert('m1', info('s1'), 1);
    expect(store.getState().session('m1', 's1')?.info.title).toBe('stopgap');

    // Titleless replacement inherits the predecessor's title...
    store.getState().applySessionReplaced('m1', 's1', info('s2'), 2);
    expect(store.getState().session('m1', 's2')?.info.title).toBe('stopgap');
    // ...and a titled replacement wins outright.
    store.getState().applySessionReplaced('m1', 's2', info('s3', { title: 'bridge' }), 3);
    expect(store.getState().session('m1', 's3')?.info.title).toBe('bridge');
  });
});

describe('noteFirstUserMessage (Phase 6) + titleFromFirstMessage', () => {
  it('titles an untitled existing session only; unknown sessions and titled sessions are no-ops', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().registerMachine({ pubkeyHex: 'm1', name: 'm1' });
    store.getState().applySessionUpsert('m1', info('s1'), 0);

    store.getState().noteFirstUserMessage('m1', 'UNKNOWN', 'hello');
    expect(store.getState().session('m1', 'UNKNOWN')).toBeUndefined();

    store.getState().noteFirstUserMessage('m1', 's1', 'first\nmessage  ');
    expect(store.getState().session('m1', 's1')?.info.title).toBe('first message');

    store.getState().noteFirstUserMessage('m1', 's1', 'second message');
    expect(store.getState().session('m1', 's1')?.info.title).toBe('first message');
  });

  it('whitespace-only text never sets an empty title', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().registerMachine({ pubkeyHex: 'm1', name: 'm1' });
    store.getState().applySessionUpsert('m1', info('s1'), 0);
    store.getState().noteFirstUserMessage('m1', 's1', '  \n \n ');
    expect(store.getState().session('m1', 's1')?.info.title).toBeNull();
  });

  it('80-char truncation is exact: 80 stays, 81 becomes slice(0,77) + "..."', () => {
    const eighty = 'a'.repeat(80);
    expect(titleFromFirstMessage(eighty)).toBe(eighty);
    const eightyOne = 'b'.repeat(81);
    expect(titleFromFirstMessage(eightyOne)).toBe('b'.repeat(77) + '...');
    expect(titleFromFirstMessage(eightyOne)).toHaveLength(80);
    expect(titleFromFirstMessage('line1\nline2\n line3 ')).toBe('line1 line2  line3');
  });

  it('a set title survives serialize → hydrate (KV round-trip)', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().registerMachine({ pubkeyHex: 'm1', name: 'm1' });
    store.getState().applySessionUpsert('m1', info('s1'), 0);
    store.getState().noteFirstUserMessage('m1', 's1', 'persisted stopgap');
    const hydrated = hydrateMachines(serializeMachines(store.getState().machines));
    expect(hydrated['m1']!.sessions['s1']!.info.title).toBe('persisted stopgap');
  });
});

describe('mergeSessionList — property: sessions are lost ONLY to tombstones', () => {
  // 6k merge steps: <1s alone, but worker contention in the full parallel run
  // can starve it past vitest's 5s default — give it explicit headroom.
  it('holds over 200 random heartbeat sequences', { timeout: 30_000 }, () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = prng(seed);
      const universe = Array.from({ length: 8 }, (_, i) => `s${i}`);
      let state: Record<string, SessionView> = {};
      const everKnown = new Set<string>();
      const tombstoned = new Set<string>();
      let now = 0;

      for (let step = 0; step < 30; step++) {
        now += Math.floor(rnd() * 1000);
        const listed = universe.filter(() => rnd() < 0.4);
        const removed = universe.filter(() => rnd() < 0.1);
        const machineOffline = rnd() < 0.15;
        const msg = list(
          listed.map((id) => info(id)),
          {
            ...(removed.length > 0 ? { removedSessions: removed } : {}),
            ...(machineOffline ? { machineOffline: true } : {}),
          },
        );
        for (const id of listed) {
          everKnown.add(id);
          tombstoned.delete(id); // re-listing resurrects
        }
        for (const id of removed) tombstoned.add(id);

        state = mergeSessionList(state, msg, now);

        // Invariant: everything ever listed and not tombstoned is still here.
        for (const id of everKnown) {
          if (!tombstoned.has(id)) {
            expect(state[id], `seed ${seed} step ${step}: lost session ${id}`).toBeDefined();
          } else {
            expect(state[id], `seed ${seed} step ${step}: tombstoned ${id} survived`).toBeUndefined();
          }
        }
        // Invariant: presence of every kept session is one of the 3 honest states.
        for (const v of Object.values(state)) {
          expect(['live', 'stale', 'offline']).toContain(v.presence);
        }
      }
    }
  });
});

describe('machines persistence — round-trip can never truncate', () => {
  it('serialize → hydrate keeps every machine and session (presences honest offline)', () => {
    const kv = memoryKV();
    const store = createMachinesStore({ kv });
    store.getState().registerMachine({ pubkeyHex: 'pk1', name: 'M1', label: 'Laptop' });
    store.getState().applySessionList('pk1', list([info('a'), info('b')]), 50);
    store.getState().applySessionList('pk1', list([info('a')]), 60); // b goes stale
    store.getState().registerMachine({ pubkeyHex: 'pk2', name: 'M2' });

    const raw = serializeMachines(store.getState().machines);
    const hydrated = hydrateMachines(raw);
    expect(Object.keys(hydrated).sort()).toEqual(['pk1', 'pk2']);
    expect(Object.keys(hydrated['pk1']!.sessions).sort()).toEqual(['a', 'b']);
    expect(hydrated['pk1']!.sessions['b']!.presence).toBe('offline');
    expect(hydrated['pk1']!.label).toBe('Laptop');
    expect(hydrated['pk1']!.machineOffline).toBe(true); // honest until a live heartbeat
  });

  it('property: hydrate(serialize(x)) never loses a session, over random stores', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rnd = prng(seed * 7919);
      const sessions: Record<string, SessionView> = {};
      const ids: string[] = [];
      const n = 1 + Math.floor(rnd() * 10);
      for (let i = 0; i < n; i++) {
        const id = `sess-${seed}-${i}`;
        ids.push(id);
        sessions[id] = view(id, rnd() < 0.5 ? 'live' : 'stale', Math.floor(rnd() * 1e6));
      }
      const machines = {
        pk: {
          pubkeyHex: 'pk',
          name: 'M',
          capabilities: ['sync/1'],
          folders: ['a'],
          roots: ['/work'],
          protocolVersion: PROTOCOL_VERSION,
          machineOffline: false,
          lastHeartbeatAt: 1,
          sessions,
        },
      };
      const hydrated = hydrateMachines(serializeMachines(machines));
      expect(Object.keys(hydrated['pk']!.sessions).sort()).toEqual([...ids].sort());
    }
  });

  it('hydrate tolerates garbage without throwing', () => {
    expect(hydrateMachines(undefined)).toEqual({});
    expect(hydrateMachines('not json')).toEqual({});
    expect(hydrateMachines('{"a":1}')).toEqual({});
    expect(hydrateMachines('[{"nope":true}]')).toEqual({});
  });
});

describe('CDX-022 — a heartbeat must not wipe the machine record (absence never deletes)', () => {
  const modelsMsg = (
    ids: string[],
    defaultModel?: string,
  ): ModelsMessage => ({
    type: 'models',
    models: ids.map((id) => ({ id, label: id.toUpperCase() })),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
  });

  it('models-response → heartbeat (no models) → the list SURVIVES', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().registerMachine({ pubkeyHex: 'pk', name: 'box' });
    store.getState().applySessionList('pk', list([info('s1')]), 10);

    store.getState().applyModels('pk', modelsMsg(['opus', 'sonnet'], 'opus'));
    expect(store.getState().machine('pk')!.models).toHaveLength(2);

    // The refresh-sessions heartbeat that used to wipe the picker.
    store.getState().applySessionList('pk', list([info('s1')]), 20);
    expect(store.getState().machine('pk')!.models).toHaveLength(2);
    expect(store.getState().machine('pk')!.defaultModel).toBe('opus');

    // …and it still survives a whole burst of them.
    for (let at = 30; at < 100; at += 10) {
      store.getState().applySessionList('pk', list([info('s1')]), at);
    }
    expect(store.getState().machine('pk')!.models?.map((m) => m.id)).toEqual(['opus', 'sonnet']);
    expect(store.getState().machine('pk')!.defaultModel).toBe('opus');
  });

  it('MIRROR CASE: a heartbeat BEFORE any models-response does not poison the record', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().applySessionList('pk', list([info('s1')]), 10);
    expect(store.getState().machine('pk')!.models).toBeUndefined();
    store.getState().applyModels('pk', modelsMsg(['haiku']));
    expect(store.getState().machine('pk')!.models?.map((m) => m.id)).toEqual(['haiku']);
    store.getState().applySessionList('pk', list([info('s1')]), 20);
    expect(store.getState().machine('pk')!.models?.map((m) => m.id)).toEqual(['haiku']);
  });

  it('a genuinely CHANGED models-response still replaces the old list (preserve ≠ freeze)', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().applySessionList('pk', list([]), 10);
    store.getState().applyModels('pk', modelsMsg(['old-a', 'old-b'], 'old-a'));
    store.getState().applyModels('pk', modelsMsg(['new-a'], 'new-a'));
    expect(store.getState().machine('pk')!.models?.map((m) => m.id)).toEqual(['new-a']);
    expect(store.getState().machine('pk')!.defaultModel).toBe('new-a');
  });

  it('an EMPTY models-response never wipes a good list (CDX-035 reason-only message)', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().applySessionList('pk', list([]), 10);
    store.getState().applyModels('pk', modelsMsg(['opus']));
    store.getState().applyModels('pk', { type: 'models', models: [], error: 'no live SDK session answered' });
    expect(store.getState().machine('pk')!.models?.map((m) => m.id)).toEqual(['opus']);
    expect(store.getState().machine('pk')!.modelsError).toBe('no live SDK session answered');
    // …and a later good answer clears the error.
    store.getState().applyModels('pk', modelsMsg(['opus', 'sonnet']));
    expect(store.getState().machine('pk')!.modelsError).toBeUndefined();
    expect(store.getState().machine('pk')!.models).toHaveLength(2);
  });

  it('the host badge and other machine-level fields survive a field-less heartbeat too', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().applySessionList('pk', list([], { host: 'vscode' }), 10);
    expect(store.getState().machine('pk')!.host).toBe('vscode');
    store.getState().applySessionList('pk', list([]), 20); // no host on the wire
    expect(store.getState().machine('pk')!.host).toBe('vscode');
    // A DIFFERENT host on the wire still wins.
    store.getState().applySessionList('pk', list([], { host: 'cli' }), 30);
    expect(store.getState().machine('pk')!.host).toBe('cli');
  });

  it('the model list survives a KV round-trip (serialize → hydrate)', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().applySessionList('pk', list([]), 10);
    store.getState().applyModels('pk', modelsMsg(['opus', 'fable'], 'opus'));
    const hydrated = hydrateMachines(serializeMachines(store.getState().machines));
    expect(hydrated['pk']!.models?.map((m) => m.id)).toEqual(['opus', 'fable']);
    expect(hydrated['pk']!.defaultModel).toBe('opus');
  });
});

describe('machinesStore — dedup by pubkey + user removal', () => {
  it('same machine name on two pubkeys stays two machines (host badge disambiguates)', () => {
    const store = createMachinesStore({ kv: memoryKV() });
    store.getState().applySessionList('pkA', list([], { machine: 'box', host: 'cli' } as Partial<SessionListMessage>), 1);
    store.getState().applySessionList('pkB', list([], { machine: 'box', host: 'vscode' } as Partial<SessionListMessage>), 1);
    expect(store.getState().machinePubkeys().sort()).toEqual(['pkA', 'pkB']);
    expect(store.getState().machine('pkA')!.host).toBe('cli');
    expect(store.getState().machine('pkB')!.host).toBe('vscode');
  });

  it('userRemoveSession is the only local removal path and persists', async () => {
    const kv = memoryKV();
    const store = createMachinesStore({ kv });
    store.getState().applySessionList('pk', list([info('a'), info('b')]), 1);
    store.getState().userRemoveSession('pk', 'a');
    expect(store.getState().session('pk', 'a')).toBeUndefined();
    expect(store.getState().session('pk', 'b')).toBeDefined();
    // Wait a tick for the fire-and-forget persist, then check the KV copy.
    await new Promise((r) => setTimeout(r, 0));
    const hydrated = hydrateMachines(await kv.get('machines'));
    expect(hydrated['pk']!.sessions['a']).toBeUndefined();
    expect(hydrated['pk']!.sessions['b']).toBeDefined();
  });
});
