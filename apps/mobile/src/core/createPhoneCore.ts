/**
 * createPhoneCore — the composition root of the framework-free phone core.
 *
 * Wires identity + stores + BridgeApi + PhoneNostrClient + the connection FSM
 * into one headless engine. Tests drive it directly against a real BridgeCore
 * over the in-memory relay (phoneCore.contract.test.ts); Phase 3b/3c mount the
 * React UI and the Tauri seams (SQLite transcript storage, real relay
 * transport, visibility/network/resume event sources) on top of exactly this.
 */
import type { NostrEvent } from 'nostr-tools/core';
import { createConnectionStore, type ConnectionStore } from './stores/connection';
import {
  createMachinesStore,
  loadPersistedMachines,
  type MachinesStore,
  type MergeOptions,
} from './stores/machines';
import { createTranscriptStore, type TranscriptStore } from './stores/transcript';
import { createOutboxStore, loadPersistedOutbox, type OutboxStore } from './stores/outbox';
import {
  createPendingSessionsStore,
  type PendingSessionsStore,
} from './stores/pendingSessions';
import { createIdentityStore, loadOrCreateIdentity, type IdentityStore } from './stores/identity';
import {
  createDmStore,
  loadPersistedDm,
  truncatePeerLabel,
  type DmStore,
  type ProfileFetcher,
} from './stores/dm';
import {
  createMarmotStore,
  loadPersistedMarmot,
  WELCOME_RUMOR_KIND,
  type MarmotPlatform,
  type MarmotStore,
} from './stores/marmot';
import {
  classifyOutputEntry,
  createNotificationCoordinator,
  dmNotifyTag,
  isAgentActivityEntry,
  sessionNotifyTag,
} from './notifications';
import { createDefaultModeApplier } from './defaultSessionMode';
import { createDeleteController } from './deleteController';
import {
  LAST_SELECTION_KEY,
  encodeSelection,
  isRestorable,
  loadPersistedSelection,
} from './selectionPersistence';
import { createPairingStore, type PairingStore } from './stores/pairing';
import {
  createQuickPromptsStore,
  loadPersistedQuickPrompts,
  type QuickPromptsStore,
} from './stores/quickPrompts';
import { createSettingsStore, loadPersistedSettings, type SettingsStore } from './stores/settings';
import { createUiStore, sessionKeyOf, type UiStore } from './stores/ui';
import type { SessionState } from '@codedeck/protocol';
import { BridgeApi } from './services/bridgeApi';
import { PhoneNostrClient } from './services/nostrClient';
import {
  memoryTranscriptStorage,
  realTimers,
  type KV,
  type Logger,
  type Notifier,
  type PhoneTransport,
  type Timers,
  type TranscriptStorage,
} from './ports';

export const LAST_STORED_SEEN_KEY = 'client.lastStoredSeen';

export interface PhoneCoreDeps {
  kv: KV;
  transport: PhoneTransport;
  /** Defaults to the in-memory port (SQLite lands in Phase 3b). */
  transcriptStorage?: TranscriptStorage;
  timers?: Timers;
  now?: () => number;
  /** Jitter source for reconnect backoff. */
  random?: () => number;
  /** Outbox inputId generator. */
  newId?: () => string;
  mergeOptions?: MergeOptions;
  syncMaxAttempts?: number;
  outboxConfirmTimeoutMs?: number;
  /** CDX-040: pair-ack deadline override (default PAIR_ACK_TIMEOUT_MS). */
  pairTimeoutMs?: number;
  /** One-shot kind-0 profile resolution for DM peers (platform/profileFetch).
   *  Absent → DM peers show truncated npubs only. */
  profileFetcher?: ProfileFetcher;
  /** Marmot/MLS engine seam (Phase 6, platform/marmot over the Tauri
   *  commands). Absent/null → Marmot DMs unavailable, NIP-17 only (plain
   *  browser dev, headless tests that don't care). */
  marmot?: MarmotPlatform | null;
  /** OS-notification delivery (Phase 5c). Absent → no notifications (headless
   *  tests, or a platform without them). Decisions stay in core/notifications. */
  notifier?: Notifier;
  /** In-app attention chime (Web Audio in the platform layer). Fires under
   *  decidePing's hidden-or-not-viewing rule, independent of the OS
   *  notification permission. Absent → silent. */
  ping?: () => void;
  /** One-QR mesh setup (Phase 5d, CDX-028 manual-join): fired after a
   *  successful pairing whose QR bundled `netid` + `meshadmin`. The platform
   *  layer dispatches the engine's `manual_add_network` (plugin); absent →
   *  the join info is ignored (headless tests, desktop). */
  onMeshJoin?: (adminNpub: string, networkId: string) => void;
  log?: Logger;
}

export interface PhoneCore {
  identity: IdentityStore;
  connection: ConnectionStore;
  machines: MachinesStore;
  transcript: TranscriptStore;
  outbox: OutboxStore;
  pendingSessions: PendingSessionsStore;
  pairing: PairingStore;
  dm: DmStore;
  marmot: MarmotStore;
  settings: SettingsStore;
  quickPrompts: QuickPromptsStore;
  ui: UiStore;
  api: BridgeApi;
  client: PhoneNostrClient;

  /** Begin connecting (idempotent). */
  start(): void;
  /** Deliberate shutdown: FSM → stopped, sockets closed, writes flushed. */
  stop(): Promise<void>;
  /** Await queued transcript writes (tests / suspend). */
  flush(): Promise<void>;
  /** Unpair a machine everywhere it lives (Phase 2b, first UI caller): the
   *  machines entry, its sessions' transcripts (memory + persisted rows) and
   *  unread marks, a dangling selection, and the relay authors filter. The
   *  bridge side keeps running — this only forgets it locally. */
  removeMachine(pubkeyHex: string): Promise<void>;
  /** Optimistic session delete with a 4s undo window (Phase 3): dismissed +
   *  removed locally now; close-session reaches the bridge only after the
   *  window passes. `label` is what the undo toast shows. */
  deleteSession(machine: string, sessionId: string, label?: string): void;
  /** Cancel a pending deleteSession and restore the snapshot. */
  undoDelete(): void;
}

export async function createPhoneCore(deps: PhoneCoreDeps): Promise<PhoneCore> {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? realTimers;
  const random = deps.random ?? Math.random;
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const log = deps.log;
  const storage = deps.transcriptStorage ?? memoryTranscriptStorage();

  // --- Persisted state ---
  const keypair = await loadOrCreateIdentity(deps.kv, log);
  const settingsData = await loadPersistedSettings(deps.kv);
  const quickPromptsInit = await loadPersistedQuickPrompts(deps.kv);
  const machinesInit = await loadPersistedMachines(deps.kv);
  const outboxInit = await loadPersistedOutbox(deps.kv);
  const dmInit = await loadPersistedDm(deps.kv);
  const marmotInit = await loadPersistedMarmot(deps.kv);
  let lastStoredSeen = Number((await deps.kv.get(LAST_STORED_SEEN_KEY)) ?? '0') || 0;

  // Mutual references are wired through closures; everything below is
  // assigned before start() can run.
  let client!: PhoneNostrClient;
  let connection!: ConnectionStore;

  const identity = createIdentityStore(keypair);

  // `connection` is assigned below (closure wiring) and every consumer runs
  // post-construction; the guard keeps early calls safe anyway.
  const isVisible = (): boolean => (connection ? connection.getState().visible : true);

  const ui = createUiStore({
    now,
    visible: isVisible,
    // CDX-026c: opening a session/DM in-app cancels its delivered OS
    // notifications (best-effort; a cancel-less notifier just no-ops).
    ...(deps.notifier?.cancel
      ? {
          onSessionViewed: (machine: string, sessionId: string) =>
            deps.notifier?.cancel?.(sessionNotifyTag(machine, sessionId)),
          onDmOpened: (peer: string) => deps.notifier?.cancel?.(dmNotifyTag(peer)),
        }
      : {}),
  });

  /** The user is looking at exactly this session right now — visible app,
   *  session panel in view, this machine+session selected. Such a session
   *  never gets an unread mark (the UI itself is the signal). */
  const viewingSession = (machine: string, sessionId: string): boolean => {
    const s = ui.getState();
    return (
      isVisible() &&
      s.panelMode === 'session' &&
      s.selectedMachine === machine &&
      s.selectedSession === sessionId
    );
  };

  // OS notifications (Phase 5c) + attention ping: store-driven events → pure
  // decisions on app visibility / viewed session → the Notifier port and the
  // ping closure. Without both seams the coordinator is inert.
  const notifications = deps.notifier || deps.ping
    ? createNotificationCoordinator({
        notifier: deps.notifier ?? { notify: () => {} },
        visible: isVisible,
        // Master toggle (CDX-048) — kills notify AND ping at the coordinator.
        // (`settings` is declared below; the closure runs post-construction,
        // the same deferred-capture pattern as client/connection/dm.)
        enabled: () => settings.getState().notificationsEnabled,
        ...(deps.ping ? { ping: deps.ping } : {}),
        activeSessionKey: () => {
          const s = ui.getState();
          return s.panelMode === 'session' && s.selectedMachine && s.selectedSession
            ? sessionKeyOf(s.selectedMachine, s.selectedSession)
            : null;
        },
        now,
      })
    : null;

  const settings = createSettingsStore(
    {
      kv: deps.kv,
      onRelaysChanged: (relays) => {
        client.setRelays(relays);
        // The DM subscription still points at the old relay set — restart it
        // (fresh epoch) and let it republish the kind-10050 advertisement.
        if (dm.getState().subscribed) dm.getState().start();
        // Same for Marmot: fresh 445 subscription + fresh KP/10051 publish.
        if (marmot.getState().subscribed) marmot.getState().start();
      },
      ...(log ? { log } : {}),
    },
    settingsData,
  );

  // Quick prompts (CDX-049): user-defined labeled shortcuts for the bar above
  // the session input. Own persisted slice, like the legacy separate store.
  const quickPrompts = createQuickPromptsStore(
    { kv: deps.kv, newId, ...(log ? { log } : {}) },
    quickPromptsInit,
  );

  // Marmot (Phase 6) is assigned right below; the dm deps only call it at
  // runtime (closure wiring, same pattern as client/connection).
  let marmot!: MarmotStore;

  // NIP-17 DMs (Phase 5b): keypair from identityStore, sockets via the shared
  // transport, relay list from settings. Subscription lifecycle is driven by
  // the connection FSM below (open-socket/close-socket effects).
  const dm = createDmStore(
    {
      kv: deps.kv,
      transport: deps.transport,
      keypair: () => identity.getState().keypair,
      relays: () => settings.getState().relays,
      now,
      ...(deps.profileFetcher ? { profileFetcher: deps.profileFetcher } : {}),
      // DM notifications respect the per-conversation unread gate: an open
      // conversation's messages never notify (they never count unread).
      ...(notifications
        ? {
            onIncoming: (msg: { peerPubkey: string; content: string }, countsUnread: boolean) => {
              if (!countsUnread) return;
              const profile = dm.getState().profiles[msg.peerPubkey];
              const peerLabel =
                profile?.displayName ?? profile?.name ?? truncatePeerLabel(msg.peerPubkey);
              const preview =
                msg.content.length > 120 ? `${msg.content.slice(0, 117)}…` : msg.content;
              notifications.emit({
                type: 'dm-received',
                peer: msg.peerPubkey,
                peerLabel,
                preview,
              });
            },
          }
        : {}),
      // Phase 6: Marmot welcomes (kind-444 rumors) ride the SAME 1059
      // subscription as NIP-17 DMs — route them to the MLS engine instead of
      // counting them invalid. The engine re-unwraps with its own keys.
      onWrappedRumor: (event, rumorKind) => {
        if (rumorKind !== WELCOME_RUMOR_KIND) return false;
        if (!deps.marmot) return false;
        marmot.getState().ingestGiftWrap(event);
        return true;
      },
      ...(log ? { log } : {}),
    },
    dmInit,
  );

  // Marmot MLS DMs (Phase 6, CDX-012): MDK in Rust via the platform seam; this
  // store owns transport + the unified-conversation data. Same FSM-driven
  // lifecycle as the dm store.
  marmot = createMarmotStore(
    {
      kv: deps.kv,
      transport: deps.transport,
      marmot: deps.marmot ?? null,
      keypair: () => identity.getState().keypair,
      relays: () => settings.getState().relays,
      now,
      ...(notifications
        ? {
            onIncoming: (msg: { groupId: string; senderPubkey: string; content: string }, countsUnread: boolean) => {
              if (!countsUnread) return;
              // Peer profiles are per-pubkey and protocol-agnostic — reuse
              // the dm store's cache for the notification label.
              const profile = dm.getState().profiles[msg.senderPubkey];
              const peerLabel =
                profile?.displayName ?? profile?.name ?? truncatePeerLabel(msg.senderPubkey);
              const preview =
                msg.content.length > 120 ? `${msg.content.slice(0, 117)}…` : msg.content;
              notifications.emit({
                type: 'dm-received',
                peer: msg.senderPubkey,
                peerLabel,
                preview,
              });
            },
          }
        : {}),
      ...(log ? { log } : {}),
    },
    marmotInit,
  );

  const machines = createMachinesStore(
    {
      kv: deps.kv,
      ...(deps.mergeOptions ? { mergeOptions: deps.mergeOptions } : {}),
      ...(log ? { log } : {}),
    },
    machinesInit,
  );

  const transcript = createTranscriptStore({
    storage,
    send: (machine, msg) => void api.send(machine, msg),
    now,
    ...(deps.syncMaxAttempts !== undefined ? { maxAttempts: deps.syncMaxAttempts } : {}),
    ...(log ? { log } : {}),
  });

  const outbox = createOutboxStore(
    {
      kv: deps.kv,
      publish: (machine, msg) => api.send(machine, msg),
      now,
      newId,
      // Replying to a session means the user has seen it — clear its unread
      // dot. Second call (Phase 6): an untitled session takes its first user
      // message as a stopgap title until the bridge authors a topical one.
      onSend: (machine, sessionId, text) => {
        ui.getState().clearSessionUnread(machine, sessionId);
        machines.getState().noteFirstUserMessage(machine, sessionId, text);
      },
      ...(deps.outboxConfirmTimeoutMs !== undefined
        ? { confirmTimeoutMs: deps.outboxConfirmTimeoutMs }
        : {}),
      ...(log ? { log } : {}),
    },
    outboxInit,
  );

  const pendingSessions = createPendingSessionsStore({ now });

  const pairing: PairingStore = createPairingStore({
    onCandidate: () => {
      // The candidate must pass the authors filter before its pair-ack arrives.
      client.resubscribe();
    },
    send: (machine, msg) => void api.send(machine, msg),
    onPaired: (candidate, machineName, host) => {
      machines.getState().registerMachine({
        pubkeyHex: candidate.pubkeyHex,
        name: machineName,
        label: candidate.machine,
        ...(host !== undefined ? { host } : {}),
      });
      // Candidate relays already include any the pair-ack carried (deduped in
      // the pairing store) — merging here covers manual-npub pairing too.
      if (candidate.relays.length > 0) {
        settings.getState().addRelays(candidate.relays);
      }
      // One-QR mesh setup (CDX-028): the pairing QR bundled the mesh
      // manual-join pair (admin device id + network id) — hand both to the
      // platform to dispatch manual_add_network (idempotent engine-side;
      // connect stays a deliberate user action in Settings → Mesh).
      if (candidate.meshAdmin && candidate.netid) {
        deps.onMeshJoin?.(candidate.meshAdmin, candidate.netid);
      }
      client.resubscribe();
    },
    identity: () => ({ npub: keypair.npub, pubkeyHex: keypair.pubkeyHex }),
    timers, // CDX-040: the pair-ack deadline runs on the injected seam
    ...(deps.pairTimeoutMs !== undefined ? { pairTimeoutMs: deps.pairTimeoutMs } : {}),
    ...(log ? { log } : {}),
  });

  // Default mode for NEW sessions (CDX-047): the bridge starts sessions in
  // plan mode; a differing preference is applied once, on session-ready.
  const applyDefaultMode = createDefaultModeApplier({
    defaultMode: () => settings.getState().defaultMode,
    sendMode: (machine, sessionId, mode) => void api.modeChange(machine, sessionId, mode),
  });

  /** Reconcile one machine's transcripts against its advertised seqHighs. */
  const reconcileMachine = (machinePubkey: string): void => {
    const machine = machines.getState().machine(machinePubkey);
    if (!machine) return;
    for (const view of Object.values(machine.sessions)) {
      const target = view.info.seqHigh ?? 0;
      if (target > 0) {
        void transcript.getState().ensureSynced(machinePubkey, view.info.id, target);
      }
    }
  };

  const api = new BridgeApi({
    identity: () => keypair,
    isKnownMachine: (pubkeyHex) =>
      machines.getState().machines[pubkeyHex] !== undefined ||
      pairing.getState().candidate?.pubkeyHex === pubkeyHex,
    publish: (event: NostrEvent) => client.publish(event),
    publishConfirmed: (event, opts) => client.publishConfirmed(event, opts),
    now,
    timers,
    ...(log ? { log } : {}),
    onDecryptFailure: () => connection.getState().dispatch({ type: 'decrypt-failure' }),
    handlers: {
      onSessions: (msg, machine) => {
        // CDX-013: only a PAIRED machine may create/update its machine entry.
        // The ingest gate lets the pairing CANDIDATE through (its pair-ack must
        // arrive), but a candidate must not self-register by sending a session
        // list before the ack — registerMachine on pair-ack is the ONLY door.
        if (!machines.getState().machines[machine]) {
          log?.(`[PhoneCore] dropping session list from unpaired ${machine.slice(0, 8)}…`);
          return;
        }
        // CDX-026b: capture the pre-merge session states — a backgrounded
        // phone catching up over sync never sees live cards/stream_end, so
        // the heartbeat TRANSITION into a waiting state is the truthful
        // attention signal.
        const prevSessions = machines.getState().machines[machine]?.sessions ?? {};
        const at = now();
        machines.getState().applySessionList(machine, msg, at);
        connection.getState().dispatch({ type: 'heartbeat-received', machine, at });
        const isWaiting = (state?: SessionState): boolean =>
          state === 'waiting_permission' || state === 'waiting_question';
        for (const info of msg.sessions) {
          // Mark on the TRANSITION into waiting (or first sight of an
          // already-waiting session) — never on every snapshot, never for the
          // session the user is foreground-watching, never for a session the
          // user just deleted (applySessionList filtered its card; a dot or
          // notification for an invisible card would dangle).
          if (machines.getState().dismissedSessions[info.id] !== undefined) continue;
          const prevState = prevSessions[info.id]?.info.state;
          const enteredWaiting = isWaiting(info.state) && !isWaiting(prevState);
          // CDX-026b (turn finish): running → idle in the heartbeat is the
          // truthful "Claude finished" signal for a backgrounded phone — sync
          // catch-up never replays live stream_end entries. Strictly the
          // TRANSITION: idle → idle repeats and first sight of an idle
          // session stay silent. The live stream_end path may have fired
          // already; the shared cooldown dedupes the pair.
          const turnFinished = info.state === 'idle' && prevState === 'running';
          if (!enteredWaiting && !turnFinished) continue;
          if (viewingSession(machine, info.id)) continue;
          ui.getState().markSessionUnread(machine, info.id);
          // The live-output path may already have emitted for the same card —
          // the coordinator's shared per-(type, session) cooldown is what
          // prevents a double ping/notification.
          notifications?.emit(
            turnFinished
              ? { type: 'session-finished', machine, sessionId: info.id }
              : info.state === 'waiting_permission'
                ? { type: 'permission-request', machine, sessionId: info.id }
                : { type: 'question', machine, sessionId: info.id },
          );
        }
        for (const id of msg.removedSessions ?? []) {
          void transcript.getState().removeSession(machine, id);
        }
        // A pending placeholder whose session shows up in the list is resolved
        // (the bridge uses the sessionId as the pendingId).
        for (const info of msg.sessions) {
          pendingSessions.getState().resolve(info.id);
        }
        pendingSessions.getState().sweep();
        // Self-healing transcripts: any advertised seqHigh above local
        // coverage starts (or backoff-gates) a sync cycle.
        reconcileMachine(machine);
        outbox.getState().sweep();
      },
      onOutput: (msg, machine) => {
        void transcript.getState().applyOutput(machine, msg.sessionId, msg.seq, msg.entry);
        // Unread + notify on LIVE entries only — sync catch-up bypasses this
        // handler, so replayed history can never mark dots or fire a
        // notification storm. A card/stream_end/failure marks the session
        // unread unless the user is watching it; a live entry showing the
        // agent actively WORKING (assistant text/thinking/tool traffic —
        // NOT waiting on us) clears the dot (old-app nuance). CDX-053: the
        // clear is gated on isAgentActivityEntry — the trailing system
        // result/usage entries a finished turn emits right after stream_end
        // (and error artifacts) must never wipe a just-set attention dot on
        // a backgrounded, never-viewed session.
        const event = classifyOutputEntry(machine, msg.sessionId, msg.entry);
        if (event) {
          if (!viewingSession(machine, msg.sessionId)) {
            ui.getState().markSessionUnread(machine, msg.sessionId);
          }
          notifications?.emit(event);
        } else if (isAgentActivityEntry(msg.entry)) {
          ui.getState().clearSessionUnread(machine, msg.sessionId);
        }
      },
      onInputAck: (msg) => outbox.getState().confirm(msg.inputId),
      onInputFailed: (msg) => {
        if (msg.inputId) outbox.getState().fail(msg.inputId, msg.reason);
      },
      onSyncBegin: (msg, machine) => void transcript.getState().applySyncBegin(machine, msg),
      onSyncChunk: (msg, machine) => void transcript.getState().applySyncChunk(machine, msg),
      onSyncEnd: (msg, machine) => void transcript.getState().applySyncEnd(machine, msg),
      onSessionPending: (msg, machine) =>
        pendingSessions.getState().applyPending(machine, msg),
      onSessionFailed: (msg, machine) => {
        pendingSessions.getState().applyFailed(msg.pendingId, msg.reason);
        notifications?.emit({
          type: 'session-failed',
          machine,
          sessionId: msg.pendingId,
          ...(msg.reason ? { reason: msg.reason } : {}),
        });
      },
      onSessionReady: (msg, machine) => {
        pendingSessions.getState().resolve(msg.pendingId);
        machines.getState().applySessionUpsert(machine, msg.session, now());
        // CDX-047: apply the "default mode for new sessions" preference —
        // once per session, and only when it differs from the mode the
        // session came up in (the bridge starts in plan).
        applyDefaultMode(machine, msg.session);
      },
      onCloseSessionAck: (msg, machine) => {
        // The bridge removed the session (registry + transcript) whether or not
        // it was still running — mirror that locally; the next heartbeat's
        // tombstone would do the same, this just makes the UI immediate.
        machines.getState().userRemoveSession(machine, msg.sessionId);
        void transcript.getState().removeSession(machine, msg.sessionId);
      },
      onModels: (msg, machine) => machines.getState().applyModels(machine, msg),
      onUsage: (msg, machine) =>
        machines.getState().applyUsage(machine, msg.sessionId, msg.usage),
      onGsdState: (msg, machine) =>
        machines.getState().applyGsd(machine, msg.sessionId, msg.gsd),
      onSessionReplaced: (msg, machine) =>
        machines.getState().applySessionReplaced(machine, msg.oldSessionId, msg.newSession, now()),
      onModeConfirmed: (msg, machine) =>
        machines.getState().updateSessionInfo(machine, msg.sessionId, { permissionMode: msg.mode }),
      onEffortConfirmed: (msg, machine) =>
        machines.getState().updateSessionInfo(machine, msg.sessionId, { effortLevel: msg.level }),
      onModelConfirmed: (msg, machine) =>
        machines.getState().updateSessionInfo(machine, msg.sessionId, { model: msg.model }),
      onPairAck: (msg, machine) => pairing.getState().handlePairAck(machine, msg),
      // Fire-and-answer acks → transient UI feedback (CDX-011; formerly
      // deliberately unrouted). folder-ack stays inside BridgeApi's correlated
      // request/response path.
      onCredentialsAck: (msg, machine) => ui.getState().applyCredentialsAck(machine, msg),
      onDeviceConfigAck: (msg, machine) => ui.getState().applyDeviceConfigAck(machine, msg),
      // CDX-062: redacted provider-profile list → machines slice (bridge-
      // authoritative, plain replace); the set-provider-profile ack → the same
      // transient uiStore feedback pattern as credentials.
      onProviderProfiles: (msg, machine) =>
        machines.getState().applyProviderProfiles(machine, msg),
      onProviderProfileAck: (msg, machine) =>
        ui.getState().applyProviderProfileAck(machine, msg),
    },
  });

  // Swipe-to-delete with undo (Phase 3): optimistic removal + deferred
  // close-session, over the same injected timers/now as everything else.
  const deleteController = createDeleteController({
    machines,
    ui,
    closeSession: (machine, sessionId) => api.closeSession(machine, sessionId),
    timers,
    now,
    ...(log ? { log } : {}),
  });

  client = new PhoneNostrClient({
    transport: deps.transport,
    phonePubkey: keypair.pubkeyHex,
    authors: () => {
      const authors = machines.getState().machinePubkeys();
      const candidate = pairing.getState().candidate;
      if (candidate && !authors.includes(candidate.pubkeyHex)) {
        authors.push(candidate.pubkeyHex);
      }
      return authors;
    },
    onEvent: (event) => api.ingest(event),
    onSocketOpen: () => connection.getState().dispatch({ type: 'socket-open', at: now() }),
    onSocketClose: () => connection.getState().dispatch({ type: 'socket-close' }),
    lastStoredSeen: () => lastStoredSeen,
    noteStoredSeen: (ts) => {
      lastStoredSeen = ts;
      void deps.kv.set(LAST_STORED_SEEN_KEY, String(ts)).catch((err) => {
        log?.(`[PhoneCore] persist lastStoredSeen failed: ${err}`);
      });
    },
    ...(log ? { log } : {}),
  });

  connection = createConnectionStore({
    timers,
    now,
    random,
    ...(log ? { log } : {}),
    handlers: {
      // The DM 1059 subscription shares the socket lifecycle: every
      // (re)connect starts a fresh epoch with a fresh catch-up window, every
      // deliberate teardown closes it silently (its own epoch guard).
      openSocket: () => {
        client.connect();
        dm.getState().start();
        marmot.getState().start();
      },
      closeSocket: () => {
        client.disconnect();
        dm.getState().stop();
        marmot.getState().stop();
      },
      refreshAndReconcile: () => {
        // A (re)connect means the world may have moved: reset sync cycles so
        // no earlier failure blocks this connection, ask every machine for a
        // fresh list (the stored 30515's seqHigh goes stale — CDX-008), and
        // reconcile from what we already know while the answers travel.
        transcript.getState().onReconnect();
        for (const machinePubkey of machines.getState().machinePubkeys()) {
          void api.refreshSessions(machinePubkey);
          reconcileMachine(machinePubkey);
        }
        outbox.getState().sweep();
      },
    },
  });

  // Rehydrate transcript coverage for persisted sessions so the first
  // sync-request after boot carries truthful haveRanges.
  for (const machine of Object.values(machines.getState().machines)) {
    for (const sessionId of Object.keys(machine.sessions)) {
      void transcript.getState().hydrateSession(machine.pubkeyHex, sessionId);
    }
  }
  await transcript.getState().flush();

  // CDX-054: the selected session must survive a WebView reload (activity
  // recreation on a configuration change the manifest misses, process death
  // during a fold). Restore the persisted selection when it is fresh (TTL —
  // a genuine cold start still opens on the drawer) and the session still
  // exists; then keep the record current: every selection change persists it,
  // and every app-hide refreshes the timestamp — a recreation always passes
  // through onPause/visibilitychange first, so the reload that follows finds
  // a just-refreshed record no matter how long the session had been open.
  const persistedSelection = await loadPersistedSelection(deps.kv);
  if (persistedSelection && isRestorable(persistedSelection, now())) {
    const { machine, sessionId } = persistedSelection;
    if (machines.getState().machine(machine)?.sessions[sessionId]) {
      ui.getState().selectSession(machine, sessionId);
    }
  }
  const persistSelection = (): void => {
    const s = ui.getState();
    const op =
      s.panelMode === 'session' && s.selectedMachine !== null && s.selectedSession !== null
        ? deps.kv.set(
            LAST_SELECTION_KEY,
            encodeSelection({ machine: s.selectedMachine, sessionId: s.selectedSession, at: now() }),
          )
        : deps.kv.delete(LAST_SELECTION_KEY);
    void op.catch((err) => log?.(`[PhoneCore] persist selection failed: ${err}`));
  };
  ui.subscribe((s, prev) => {
    if (
      s.selectedMachine !== prev.selectedMachine ||
      s.selectedSession !== prev.selectedSession ||
      s.panelMode !== prev.panelMode
    ) {
      persistSelection();
    }
  });
  connection.subscribe((s, prev) => {
    // Raw hide signal (hiddenPending) AND the debounced settle: the raw one is
    // what still runs when the WebView is torn down before the settle timer.
    if ((s.hiddenPending && !prev.hiddenPending) || (!s.visible && prev.visible)) {
      persistSelection();
    }
  });

  return {
    identity,
    connection,
    machines,
    transcript,
    outbox,
    pendingSessions,
    pairing,
    dm,
    marmot,
    settings,
    quickPrompts,
    ui,
    api,
    client,

    start: () => connection.getState().dispatch({ type: 'connect-requested' }),
    stop: async () => {
      connection.getState().dispatch({ type: 'disconnect-requested' });
      await transcript.getState().flush();
    },
    flush: () => transcript.getState().flush(),

    // Cross-store companion cleanup lives HERE (composition root), keeping the
    // machines store single-purpose: removeMachine alone would leave orphaned
    // transcripts/unread dots and a selection pointing into the void.
    removeMachine: async (pubkeyHex: string) => {
      const machine = machines.getState().machine(pubkeyHex);
      const sessionIds = machine ? Object.keys(machine.sessions) : [];
      machines.getState().removeMachine(pubkeyHex);
      for (const sessionId of sessionIds) {
        ui.getState().clearSessionUnread(pubkeyHex, sessionId);
        void transcript.getState().removeSession(pubkeyHex, sessionId);
      }
      if (ui.getState().selectedMachine === pubkeyHex) {
        ui.getState().selectMachine(null);
      }
      // Drop the machine from the relay subscription's authors filter.
      client.resubscribe();
      await transcript.getState().flush();
    },

    deleteSession: deleteController.requestDelete,
    undoDelete: deleteController.undo,
  };
}
