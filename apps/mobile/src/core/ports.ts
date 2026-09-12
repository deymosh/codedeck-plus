/**
 * Ports — the seams between the framework-free phone core and its environment.
 *
 * The core never touches localStorage or real timers directly: everything is
 * injected through these interfaces so it runs headless in vitest (CDX-009
 * Phase 3a). The socket/SQLite ports this module also described belonged to
 * the local WebView composition (retired — see git history); `client-runtime`
 * owns the transport and persistence now, reached through `NativeCore`
 * (`platform/nativeCore.ts`), not through a port here.
 */

// --- Key/value persistence port (NOT raw localStorage) ---

export interface KV {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory KV — tests, and a safe default before Phase 3b wires SQLite. */
export function memoryKV(initial?: Record<string, string>): KV & { dump(): Map<string, string> } {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
    dump: () => new Map(map),
  };
}

// --- Publish verdicts ---
//
// The socket transport these once described (`PhoneTransport`, a nostr-tools
// SimplePool wrapper) was the local WebView composition's own — retired with
// it (see git history). `PublishVerdict`/`PublishResult`/
// `PublishConfirmOptions` survive because `BridgeApiLike`'s two genuine gaps
// (`uploadImageBlossom`/`uploadImageChunk` — see `services/bridgeApi.ts`'s
// module doc) still type their return/options shape against them.

/**
 * CDX-086: what actually happened to a publish. The boolean this replaces
 * collapsed two opposite outcomes into `false`, and got one of them backwards:
 *
 * - `accepted`    a relay returned OK. Delivered, confirmed.
 * - `unconfirmed` the frame WAS written to an open socket, but no OK arrived
 *                 inside nostr-tools' 4.4 s publishTimeout. This is very
 *                 probably delivery, and treating it as failure is the founder's
 *                 stuck-upload bug: the phone re-uploaded a 3 MB photo over ~115
 *                 relay events that the bridge had already received.
 * - `rejected`    a relay said no (`rate-limited:`, `blocked:`, `pow:`). Real,
 *                 and retrying the same event will not help.
 * - `unreachable` no relay could even be connected to. nostr-tools RESOLVES
 *                 these with a `"connection failure: …"` string rather than
 *                 rejecting, so the old boolean reported them as SUCCESS.
 */
export type PublishVerdict = 'accepted' | 'unconfirmed' | 'rejected' | 'unreachable';

export interface PublishResult {
  verdict: PublishVerdict;
  /** Relay-reported reasons, for logs and the error banner. */
  detail?: string;
}

export interface PublishConfirmOptions {
  /** Wall clock for the WHOLE confirmation, shared across republishes. */
  budgetMs?: number;
  /**
   * Max publishes of the SAME signed event. Republishing an identical event is
   * idempotent end to end — the bridge dedupes by event id — which is precisely
   * why the retry must live here and not above BridgeApi.send, where each call
   * would rebuild the command with a fresh created_at and NIP-44 nonce, yield a
   * new event id, and get the image injected twice.
   */
  attempts?: number;
  signal?: AbortSignal;
}

// --- Async transcript storage port (in-memory now, SQLite in Phase 3b) ---

export interface TranscriptEntryRow {
  seq: number;
  /** JSON-serializable OutputEntry (kept opaque here to avoid a protocol
   *  dependency in the port). */
  entry: unknown;
}

/**
 * Per-(machine, session) transcript persistence with INSERT OR IGNORE
 * semantics on (machine, session, seq) — the SQLite PK in 3b, a Map here.
 */
export interface TranscriptStorage {
  /** Insert rows, ignoring seqs already present. Returns the seqs actually inserted. */
  insertIgnore(machine: string, session: string, rows: TranscriptEntryRow[]): Promise<number[]>;
  /** All stored seqs for a session, ascending. */
  seqs(machine: string, session: string): Promise<number[]>;
  /** Rows with from <= seq <= to, ascending. */
  readRange(machine: string, session: string, from: number, to: number): Promise<TranscriptEntryRow[]>;
  /** Drop a session's rows (explicit user/tombstone removal only). */
  remove(machine: string, session: string): Promise<void>;
}

export function memoryTranscriptStorage(): TranscriptStorage {
  const data = new Map<string, Map<number, unknown>>();
  const table = (machine: string, session: string): Map<number, unknown> => {
    const key = `${machine}\u0000${session}`;
    let t = data.get(key);
    if (!t) {
      t = new Map();
      data.set(key, t);
    }
    return t;
  };
  return {
    insertIgnore: async (machine, session, rows) => {
      const t = table(machine, session);
      const inserted: number[] = [];
      for (const { seq, entry } of rows) {
        if (t.has(seq)) continue;
        t.set(seq, entry);
        inserted.push(seq);
      }
      return inserted;
    },
    seqs: async (machine, session) =>
      [...table(machine, session).keys()].sort((a, b) => a - b),
    readRange: async (machine, session, from, to) =>
      [...table(machine, session).entries()]
        .filter(([seq]) => seq >= from && seq <= to)
        .sort((a, b) => a[0] - b[0])
        .map(([seq, entry]) => ({ seq, entry })),
    remove: async (machine, session) => {
      data.delete(`${machine}\u0000${session}`);
    },
  };
}

// --- OS notification port (Phase 5c) ---

/**
 * The OS-notification seam. Production: @tauri-apps/plugin-notification
 * (platform/notifier). Tests: a spy. The core decides WHEN to notify
 * (core/notifications.ts); this port only delivers.
 */
export interface Notifier {
  /** `tag` (CDX-026c) groups deliveries so they can be cancelled when the user
   *  handles the underlying thing in-app (answers the permission, opens the DM
   *  conversation). Platforms that can't cancel may ignore it. */
  notify(content: { title: string; body: string; tag?: string }): void;
  /** Best-effort removal of previously-delivered notifications for a tag
   *  (CDX-026c). Optional — test spies and cancel-less platforms omit it;
   *  callers must treat failures as ignorable. */
  cancel?(tag: string): void;
}

// --- Timers / clock / entropy ---

/** Same shape as @codedeck/core's SyncTimers seam (duplicated by design — the
 *  phone core must not import core). */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type Logger = (msg: string) => void;
