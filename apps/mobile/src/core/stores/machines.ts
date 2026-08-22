/**
 * machinesStore — paired bridges and their session lists.
 *
 * The heart is `mergeSessionList`, a pure function with the contract that kills
 * bug B's session-loss vector:
 * - sessions present in the incoming list are upserted (presence 'live', or
 *   'offline' when the list is a machineOffline shutdown publish)
 * - ABSENCE NEVER DELETES: a known session missing from the incoming list is
 *   kept and marked 'stale'
 * - removal happens ONLY via explicit `removedSessions` tombstones — or a user
 *   delete through `userRemoveSession`
 * - persistence serializes the FULL machine map — the persister structurally
 *   cannot truncate (the old app persisted a merged-short list, permanently
 *   losing sessions)
 *
 * Machines are keyed (deduped) by bridge pubkey — identity is the keypair; the
 * 30515 `host` field is only a UI badge for two bridges on one box.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  BridgeHostKind,
  GsdState,
  ModelsMessage,
  ProviderProfileInfo,
  ProviderProfilesMessage,
  RemoteSessionInfo,
  SessionListMessage,
  UsageData,
} from '@codedeck/protocol';
import type { KV, Logger } from '../ports';

export type ListingPresence = 'live' | 'stale' | 'offline';

export interface SessionView {
  info: RemoteSessionInfo;
  presence: ListingPresence;
  /** ms timestamp this session was last present in an incoming list. */
  lastListedAt: number;
  /** Latest claude.ai usage snapshot (usage message, 3c routing). */
  usage?: UsageData;
  /** Latest GSD workflow state (gsd-state message, 3c routing — stored, not
   *  rendered until the Phase-5 strip; never dropped). */
  gsd?: GsdState;
}

export interface MachineView {
  pubkeyHex: string;
  /** Machine name from the last heartbeat (or pairing), UI display. */
  name: string;
  /** Which host binary — badge only, never identity. */
  host?: BridgeHostKind;
  /** User-facing label captured at pairing time. */
  label?: string;
  capabilities: string[];
  folders: string[];
  /** CDX-031: absolute workspace roots in `--workspace` order. `folders` lists
   *  what is inside them and can never name a root, so this is the only way
   *  the picker can offer root 2..N. Empty on pre-CDX-031 bridges. */
  roots: string[];
  protocolVersion: number | null;
  machineOffline: boolean;
  lastHeartbeatAt: number | null;
  sessions: Record<string, SessionView>;
  /** SDK-reported model list (models message, 3c routing). Machines are keyed
   *  by pubkey, so two hosts on one box each keep their own list. */
  models?: Array<{ id: string; label?: string }>;
  defaultModel?: string;
  /** CDX-035: why the bridge could not answer with a list (models message with
   *  an empty `models` + `error`). Rendered next to the picker; cleared by the
   *  next non-empty answer. */
  modelsError?: string;
  /** CDX-062: the bridge's REDACTED custom-provider profile list (each entry
   *  carries `hasToken`, never the token). Bridge-authoritative + in-memory
   *  only: serializeMachines strips it (the phone persists zero profile
   *  copies), so `undefined` = "not fetched this boot" and drives the
   *  re-request loop; `[]` = the bridge genuinely stores zero profiles. */
  providerProfiles?: ProviderProfileInfo[];
}

export interface MergeOptions {
  /** A session absent from an incoming list keeps its previous presence while
   *  it was listed within this window (rapid-fire partial lists during session
   *  creation shouldn't flicker everything stale). Default 0 = stale at once. */
  staleGraceMs?: number;
}

/** Phase 6 title-merge guard: a null/undefined incoming title must not wipe a
 *  title we already hold (the client-side first-message stopgap) — but a
 *  non-null incoming title always wins (bridge-authored topical titles
 *  overwrite the stopgap). Old-app semantics: `incoming.title ?? prev.title`. */
function withGuardedTitle(
  incoming: RemoteSessionInfo,
  prev: SessionView | undefined,
): RemoteSessionInfo {
  if (incoming.title != null || prev?.info.title == null) return incoming;
  return { ...incoming, title: prev.info.title };
}

/**
 * Pure session-list merge. Returns a NEW session map; `prev` is not mutated.
 */
export function mergeSessionList(
  prev: Record<string, SessionView>,
  incoming: SessionListMessage,
  now: number,
  opts: MergeOptions = {},
): Record<string, SessionView> {
  const staleGraceMs = opts.staleGraceMs ?? 0;
  const next: Record<string, SessionView> = {};
  const presence: ListingPresence = incoming.machineOffline ? 'offline' : 'live';

  const listed = new Set<string>();
  for (const info of incoming.sessions) {
    listed.add(info.id);
    // Spread the previous view first: per-session extras (usage, gsd) survive
    // every heartbeat; info/presence/lastListedAt are authoritative (except a
    // titleless heartbeat, which keeps our stopgap title — withGuardedTitle).
    next[info.id] = {
      ...prev[info.id],
      info: withGuardedTitle(info, prev[info.id]),
      presence,
      lastListedAt: now,
    };
  }

  for (const [id, view] of Object.entries(prev)) {
    if (listed.has(id)) continue;
    // Absence NEVER deletes.
    if (incoming.machineOffline) {
      next[id] = { ...view, presence: 'offline' };
    } else if (now - view.lastListedAt <= staleGraceMs) {
      next[id] = { ...view };
    } else {
      next[id] = { ...view, presence: 'stale' };
    }
  }

  // Tombstones are the ONLY bridge-driven removal path.
  for (const id of incoming.removedSessions ?? []) {
    delete next[id];
  }

  return next;
}

// --- First-message title fallback (Phase 6 stopgap) ---

/** Old-app first-message title: newlines → spaces, trim, >80 chars →
 *  slice(0,77)+'...'. Empty input yields '' (caller skips it). */
export function titleFromFirstMessage(text: string): string {
  const title = text.replace(/\n/g, ' ').trim();
  return title.length > 80 ? title.slice(0, 77) + '...' : title;
}

// --- Dismissed sessions (swipe-to-delete resurrection shield, Phase 3) ---

/** How long a user-dismissed session id keeps suppressing incoming lists.
 *  After this the bridge is trusted again (it should have processed the
 *  close-session long ago; if the session still exists, it's real). */
export const DISMISSED_TTL_MS = 60 * 60 * 1000;

/** Drop entries older than DISMISSED_TTL_MS. Returns the SAME object when
 *  nothing expired so callers can cheaply detect no-change. */
function pruneDismissed(
  dismissed: Record<string, number>,
  now: number,
): Record<string, number> {
  let changed = false;
  const next: Record<string, number> = {};
  for (const [id, at] of Object.entries(dismissed)) {
    if (now - at >= DISMISSED_TTL_MS) {
      changed = true;
      continue;
    }
    next[id] = at;
  }
  return changed ? next : dismissed;
}

// --- Persistence (round-trip can never truncate) ---

export function serializeMachines(machines: Record<string, MachineView>): string {
  // CDX-062: provider profiles are bridge-authoritative and never persisted on
  // the phone (zero profile copies at rest, even redacted ones) — a fresh boot
  // re-requests the live list instead of trusting a stale local copy.
  return JSON.stringify(
    Object.values(machines).map(({ providerProfiles: _providerProfiles, ...m }) => m),
  );
}

/** Hydrate persisted machines. Every presence comes back 'offline' — honest
 *  until the first live heartbeat proves otherwise. Unknown/corrupt input
 *  yields an empty map (never a throw at boot). */
export function hydrateMachines(raw: string | undefined): Record<string, MachineView> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const out: Record<string, MachineView> = {};
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as MachineView;
    if (typeof raw.pubkeyHex !== 'string' || raw.pubkeyHex.length === 0) continue;
    // CDX-062 belt-and-braces: even if a profile list somehow reached the KV
    // (older build, hand-edited storage), it never hydrates — an absent field
    // keeps the boot-time re-request loop honest.
    const { providerProfiles: _stale, ...m } = raw;
    const sessions: Record<string, SessionView> = {};
    for (const [id, view] of Object.entries(m.sessions ?? {})) {
      sessions[id] = { ...view, presence: 'offline' };
    }
    out[m.pubkeyHex] = {
      ...m,
      name: typeof m.name === 'string' ? m.name : m.pubkeyHex.slice(0, 8),
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
      folders: Array.isArray(m.folders) ? m.folders : [],
      roots: Array.isArray(m.roots) ? m.roots : [],
      protocolVersion: typeof m.protocolVersion === 'number' ? m.protocolVersion : null,
      machineOffline: true,
      lastHeartbeatAt: typeof m.lastHeartbeatAt === 'number' ? m.lastHeartbeatAt : null,
      sessions,
    };
  }
  return out;
}

// --- Store ---

export interface MachinesStoreState {
  machines: Record<string, MachineView>;
  /** sessionId → dismissedAtMs for user-deleted sessions in their undo/settle
   *  window. IN-MEMORY ONLY — deliberately outside `machines`, so
   *  serializeMachines can never persist it (a reboot trusts the bridge
   *  again). Entries expire after DISMISSED_TTL_MS. */
  dismissedSessions: Record<string, number>;

  registerMachine(machine: {
    pubkeyHex: string;
    name: string;
    label?: string;
    /** Host badge learned at pairing (pair-ack); heartbeats keep it current. */
    host?: BridgeHostKind;
  }): void;
  removeMachine(pubkeyHex: string): void;
  applySessionList(machinePubkey: string, msg: SessionListMessage, at: number): void;
  applySessionUpsert(machinePubkey: string, info: RemoteSessionInfo, at: number): void;
  applySessionReplaced(machinePubkey: string, oldSessionId: string, info: RemoteSessionInfo, at: number): void;
  updateSessionInfo(machinePubkey: string, sessionId: string, patch: Partial<RemoteSessionInfo>): void;
  /** Phase 6 stopgap: the FIRST user message titles an untitled session
   *  (normalized via titleFromFirstMessage). No-op when the session is unknown
   *  or already titled — a bridge-authored title is never overwritten. */
  noteFirstUserMessage(machinePubkey: string, sessionId: string, text: string): void;
  /** Explicit user delete — one of exactly two removal paths. */
  userRemoveSession(machinePubkey: string, sessionId: string): void;
  /** Shield a user-deleted session from resurrection by stale heartbeats:
   *  applySessionList filters non-expired dismissed ids BEFORE merging. */
  dismissSession(sessionId: string, at: number): void;
  /** Undo a delete: un-dismiss and re-insert the exact snapshotted view. */
  restoreSession(machinePubkey: string, view: SessionView): void;
  /** usage message → per-session snapshot (3c routing). */
  applyUsage(machinePubkey: string, sessionId: string, usage: UsageData): void;
  /** gsd-state message → stored per session (3c routing; rendered Phase 5). */
  applyGsd(machinePubkey: string, sessionId: string, gsd: GsdState): void;
  /** models message → per-machine model list (3c routing). */
  applyModels(machinePubkey: string, msg: ModelsMessage): void;
  /** provider-profiles message → per-machine redacted profile list (CDX-062).
   *  PLAIN REPLACE, deliberately unlike applyModels' CDX-035 dance: the bridge
   *  always answers straight from its storage (there is no "could not answer"
   *  case and no error field on the wire), so an empty list truthfully means
   *  zero stored profiles and must replace whatever we held. */
  applyProviderProfiles(machinePubkey: string, msg: ProviderProfilesMessage): void;

  machine(pubkeyHex: string): MachineView | undefined;
  session(machinePubkey: string, sessionId: string): SessionView | undefined;
  machinePubkeys(): string[];
}

export type MachinesStore = StoreApi<MachinesStoreState>;

export interface MachinesStoreDeps {
  kv: KV;
  storageKey?: string;
  mergeOptions?: MergeOptions;
  log?: Logger;
}

export const MACHINES_STORAGE_KEY = 'machines';

export function createMachinesStore(
  deps: MachinesStoreDeps,
  initialMachines: Record<string, MachineView> = {},
): MachinesStore {
  const storageKey = deps.storageKey ?? MACHINES_STORAGE_KEY;

  const store = createStore<MachinesStoreState>()((set, get) => {
    const persist = (): void => {
      void deps.kv.set(storageKey, serializeMachines(get().machines)).catch((err) => {
        deps.log?.(`[Machines] persist failed: ${err}`);
      });
    };

    const withMachine = (
      pubkeyHex: string,
      update: (machine: MachineView) => MachineView,
    ): void => {
      const machines = get().machines;
      const machine = machines[pubkeyHex];
      if (!machine) {
        deps.log?.(`[Machines] update for unknown machine ${pubkeyHex.slice(0, 8)}… dropped`);
        return;
      }
      set({ machines: { ...machines, [pubkeyHex]: update(machine) } });
      persist();
    };

    return {
      machines: initialMachines,
      dismissedSessions: {},

      registerMachine: ({ pubkeyHex, name, label, host }) => {
        const machines = get().machines;
        const existing = machines[pubkeyHex];
        const machine: MachineView = existing
          ? {
              ...existing,
              name,
              ...(label !== undefined ? { label } : {}),
              ...(host !== undefined ? { host } : {}),
            }
          : {
              pubkeyHex,
              name,
              ...(label !== undefined ? { label } : {}),
              ...(host !== undefined ? { host } : {}),
              capabilities: [],
              folders: [],
              roots: [],
              protocolVersion: null,
              machineOffline: false,
              lastHeartbeatAt: null,
              sessions: {},
            };
        set({ machines: { ...machines, [pubkeyHex]: machine } });
        persist();
      },

      removeMachine: (pubkeyHex) => {
        const machines = { ...get().machines };
        delete machines[pubkeyHex];
        set({ machines });
        persist();
      },

      applySessionList: (machinePubkey, msg, at) => {
        const machines = get().machines;
        const existing = machines[machinePubkey];
        // Resurrection shield: a session the user just deleted (optimistic
        // removal, undo window / close-session still in flight) is filtered
        // out of the incoming list BEFORE the merge — a stale heartbeat must
        // not bring the card back. Expired entries are pruned here, on the
        // same clock the merge uses.
        const dismissedPrev = get().dismissedSessions;
        const dismissed = pruneDismissed(dismissedPrev, at);
        const incoming = msg.sessions.some((s) => dismissed[s.id] !== undefined)
          ? { ...msg, sessions: msg.sessions.filter((s) => dismissed[s.id] === undefined) }
          : msg;
        const sessions = mergeSessionList(
          existing?.sessions ?? {},
          incoming,
          at,
          deps.mergeOptions ?? {},
        );
        // CDX-022: this record is built by SPREADING the existing one, never
        // from scratch. A heartbeat carries no `models`/`defaultModel`, so a
        // rebuilt-from-scratch literal silently wiped the model list every
        // ~40s and the phone's picker collapsed back to "list unavailable"
        // seconds after it populated. Same discipline as
        // `incoming.title ?? prev.title` and mergeSessionList: ABSENCE NEVER
        // DELETES — a field the wire omits keeps its stored value; a field the
        // wire carries (including an explicit empty array) always wins.
        const machine: MachineView = {
          ...existing,
          pubkeyHex: machinePubkey,
          name: msg.machine,
          ...(msg.host !== undefined ? { host: msg.host } : {}),
          capabilities: msg.capabilities ? [...msg.capabilities] : (existing?.capabilities ?? []),
          folders: msg.folders ? [...msg.folders] : (existing?.folders ?? []),
          roots: msg.roots ? [...msg.roots] : (existing?.roots ?? []),
          protocolVersion: msg.protocolVersion,
          machineOffline: !!msg.machineOffline,
          lastHeartbeatAt: at,
          sessions,
        };
        set({
          machines: { ...machines, [machinePubkey]: machine },
          ...(dismissed !== dismissedPrev ? { dismissedSessions: dismissed } : {}),
        });
        persist();
      },

      applySessionUpsert: (machinePubkey, info, at) =>
        withMachine(machinePubkey, (machine) => ({
          ...machine,
          sessions: {
            ...machine.sessions,
            [info.id]: {
              info: withGuardedTitle(info, machine.sessions[info.id]),
              presence: 'live',
              lastListedAt: at,
            },
          },
        })),

      applySessionReplaced: (machinePubkey, oldSessionId, info, at) =>
        withMachine(machinePubkey, (machine) => {
          const sessions = { ...machine.sessions };
          // The replaced predecessor carries the conversation — its stopgap
          // title survives a titleless replacement announcement.
          const prev = sessions[oldSessionId] ?? sessions[info.id];
          delete sessions[oldSessionId];
          sessions[info.id] = {
            info: withGuardedTitle(info, prev),
            presence: 'live',
            lastListedAt: at,
          };
          return { ...machine, sessions };
        }),

      updateSessionInfo: (machinePubkey, sessionId, patch) =>
        withMachine(machinePubkey, (machine) => {
          const session = machine.sessions[sessionId];
          if (!session) return machine;
          return {
            ...machine,
            sessions: {
              ...machine.sessions,
              [sessionId]: { ...session, info: { ...session.info, ...patch } },
            },
          };
        }),

      noteFirstUserMessage: (machinePubkey, sessionId, text) =>
        withMachine(machinePubkey, (machine) => {
          const session = machine.sessions[sessionId];
          if (!session || session.info.title) return machine;
          const title = titleFromFirstMessage(text);
          if (!title) return machine;
          return {
            ...machine,
            sessions: {
              ...machine.sessions,
              [sessionId]: { ...session, info: { ...session.info, title } },
            },
          };
        }),

      userRemoveSession: (machinePubkey, sessionId) =>
        withMachine(machinePubkey, (machine) => {
          const sessions = { ...machine.sessions };
          delete sessions[sessionId];
          return { ...machine, sessions };
        }),

      // NOTE: dismiss/restore touch ONLY the in-memory dismissed map (and, for
      // restore, the machine's sessions via withMachine, which persists the
      // machines map). The dismissed map itself never reaches the KV.
      dismissSession: (sessionId, at) => {
        const dismissed = pruneDismissed(get().dismissedSessions, at);
        set({ dismissedSessions: { ...dismissed, [sessionId]: at } });
      },

      restoreSession: (machinePubkey, view) => {
        const dismissed = { ...get().dismissedSessions };
        delete dismissed[view.info.id];
        set({ dismissedSessions: dismissed });
        withMachine(machinePubkey, (machine) => ({
          ...machine,
          sessions: { ...machine.sessions, [view.info.id]: view },
        }));
      },

      applyUsage: (machinePubkey, sessionId, usage) =>
        withMachine(machinePubkey, (machine) => {
          const session = machine.sessions[sessionId];
          if (!session) return machine;
          return {
            ...machine,
            sessions: { ...machine.sessions, [sessionId]: { ...session, usage } },
          };
        }),

      applyGsd: (machinePubkey, sessionId, gsd) =>
        withMachine(machinePubkey, (machine) => {
          const session = machine.sessions[sessionId];
          if (!session) return machine;
          return {
            ...machine,
            sessions: { ...machine.sessions, [sessionId]: { ...session, gsd } },
          };
        }),

      applyModels: (machinePubkey, msg) =>
        withMachine(machinePubkey, (machine) => {
          // CDX-035: an EMPTY list is a "could not answer" report, not "this
          // SDK supports zero models" — it carries a reason and must never
          // overwrite a good list we already hold. A NON-empty answer is
          // always authoritative (a genuinely changed list still replaces the
          // old one) and clears any stored reason.
          if (msg.models.length === 0) {
            const next = { ...machine };
            if (msg.error !== undefined) next.modelsError = msg.error;
            else delete next.modelsError;
            return next;
          }
          const next: MachineView = {
            ...machine,
            models: msg.models.map((m) => ({
              id: m.id,
              ...(m.label !== undefined ? { label: m.label } : {}),
            })),
            ...(msg.defaultModel !== undefined ? { defaultModel: msg.defaultModel } : {}),
          };
          delete next.modelsError;
          return next;
        }),

      applyProviderProfiles: (machinePubkey, msg) =>
        withMachine(machinePubkey, (machine) => ({
          ...machine,
          providerProfiles: msg.profiles.map((p) => ({ ...p })),
        })),

      machine: (pubkeyHex) => get().machines[pubkeyHex],
      session: (machinePubkey, sessionId) => get().machines[machinePubkey]?.sessions[sessionId],
      machinePubkeys: () => Object.keys(get().machines),
    };
  });

  return store;
}

/** Load persisted machines for createMachinesStore's `initialMachines`. */
export async function loadPersistedMachines(
  kv: KV,
  storageKey: string = MACHINES_STORAGE_KEY,
): Promise<Record<string, MachineView>> {
  return hydrateMachines(await kv.get(storageKey));
}
