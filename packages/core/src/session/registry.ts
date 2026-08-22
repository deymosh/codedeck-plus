/**
 * SessionRegistry — persistent session records.
 *
 * DELIBERATE REWRITE of the old bridge's in-memory-only session map, which is
 * half of the "phone loses session history" bug: a bridge restart forgot every
 * session, and deactivate published an EMPTY session list that the phone
 * couldn't distinguish from "your sessions are gone".
 *
 * Design rules:
 * - Every record persists to <stateDir>/registry.json, rewritten atomically
 *   (temp + rename) on every mutation, loaded on construction.
 * - `markOffline()` flips all sessions to state 'offline' at shutdown so the
 *   final session-list publish is truthful instead of empty.
 * - Removal records an explicit tombstone (capped 100, FIFO) so the next
 *   session-list publish carries `removedSessions` — the ONLY way a bridge
 *   deletes a session from the phone.
 */
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  EffortLevel,
  PermissionMode,
  RemoteSessionInfo,
  SessionState,
} from '@codedeck/protocol';

export interface SessionRecord {
  sessionId: string;
  /** The Claude Agent SDK's own session id (for --resume); null until known. */
  sdkSessionId: string | null;
  /**
   * CDX-073: the last sdkSessionId dropped as unresumable. `sdkSessionId` is the
   * ONLY pointer to the conversation the SDK keeps on disk, so clearing it used
   * to destroy the evidence along with the pointer — a wrong drop orphaned the
   * conversation silently and forever. Recorded here so the drop stays
   * diagnosable and the conversation stays hand-recoverable. Never resumed
   * automatically: it was dropped because resuming it failed.
   */
  previousSdkSessionId?: string;
  cwd: string;
  model?: string;
  /** CDX-062: id of the custom provider profile this session was bound to at
   *  creation (absent = Anthropic). Survives resume-on-boot + auto-restart. */
  providerId?: string;
  effortLevel?: EffortLevel;
  permissionMode?: PermissionMode;
  title: string | null;
  project: string;
  createdAt: string;
  lastActivity: string;
  state: SessionState;
  /** A commit landed in this session's cwd since it started (git-detection). */
  committed?: boolean;
  /** SDK-resolved context-window size in tokens (honest denominator, incl. 1M beta). */
  contextWindow?: number;
  /** SDK-authoritative context usage, 0–100 (the Claude Code terminal meter). */
  contextPercentage?: number;
}

/** The slice of TranscriptStore the registry needs — injectable for tests. */
export interface SeqHighSource {
  seqHigh(sessionId: string): number;
}

interface RegistryFile {
  sessions: SessionRecord[];
  removedSessions: string[];
}

const TOMBSTONE_CAP = 100;

/**
 * CDX-060: temp-name sequence shared by EVERY registry instance in this
 * process. The old per-instance counter meant two instances over the same
 * state dir (the restart/"reopen" pattern tests use, same pid) both produced
 * `registry.json.tmp-<pid>-1`, `-2`, … — and when their saves interleaved,
 * the second writer's rename(2) fired against a temp path the first had
 * already renamed away: `ENOENT rename registry.json.tmp-…`, the parallel-load
 * flake. A module-level counter makes the name unique per write per process;
 * the pid keeps it unique across processes.
 */
let sharedTmpSeq = 0;

export class SessionRegistry {
  private readonly filePath: string;
  private readonly logFn?: (msg: string) => void;
  private readonly records = new Map<string, SessionRecord>();
  private removed: string[] = [];
  /** Serializes persists so concurrent mutations can't interleave temp writes. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(stateDir: string, log?: (msg: string) => void) {
    this.filePath = path.join(stateDir, 'registry.json');
    this.logFn = log;
    mkdirSync(stateDir, { recursive: true });
    this.loadSync();
  }

  private loadSync(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return; // first boot — no registry yet
    }
    try {
      const parsed = JSON.parse(raw) as RegistryFile;
      for (const rec of parsed.sessions ?? []) {
        if (rec && typeof rec.sessionId === 'string' && rec.sessionId.length > 0) {
          this.records.set(rec.sessionId, rec);
        }
      }
      this.removed = (parsed.removedSessions ?? []).filter(
        (id): id is string => typeof id === 'string',
      ).slice(-TOMBSTONE_CAP);
    } catch (err) {
      // Atomic writes should make this impossible, but never let a corrupt
      // registry brick the bridge: preserve the evidence and start empty.
      this.log(`[Registry] registry.json corrupt (${err}) — moved aside, starting empty`);
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt`);
      } catch {
        // best effort
      }
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(
      {
        sessions: [...this.records.values()],
        removedSessions: [...this.removed],
      } satisfies RegistryFile,
      null,
      2,
    );
    const next = this.writeChain.then(() => this.writeSnapshot(snapshot));
    // The stored chain always has a rejection handler: one failed write must
    // neither wedge later persists nor escape as an unhandled rejection.
    this.writeChain = next.then(
      () => undefined,
      (err) => {
        this.log(`[Registry] persist failed: ${err}`);
      },
    );
    return next;
  }

  /** One atomic write-temp-then-rename attempt, with the CDX-060 hardening. */
  private async writeSnapshot(snapshot: string): Promise<void> {
    const attempt = async (): Promise<void> => {
      const tmp = `${this.filePath}.tmp-${process.pid}-${++sharedTmpSeq}`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, this.filePath);
    };
    try {
      await attempt();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // CDX-060: ENOENT on rename is a lost race — something removed our temp
      // file between write and rename (typically a test-teardown sweep of the
      // state dir racing an in-flight fire-and-forget save). The snapshot is
      // still current, so retry once under a fresh temp name. If the state dir
      // itself is gone, the retry's writeFile throws ENOENT too and the
      // failure propagates to be logged/awaited like any other.
      await attempt();
    }
  }

  get(sessionId: string): SessionRecord | undefined {
    const rec = this.records.get(sessionId);
    return rec ? { ...rec } : undefined;
  }

  list(): SessionRecord[] {
    return [...this.records.values()].map((rec) => ({ ...rec }));
  }

  /** Create or replace a full record. */
  upsert(record: SessionRecord): Promise<void> {
    this.records.set(record.sessionId, { ...record });
    return this.persist();
  }

  /** Patch an existing record; no-op (resolved) when the session is unknown. */
  update(
    sessionId: string,
    patch: Partial<Omit<SessionRecord, 'sessionId'>>,
  ): Promise<SessionRecord | undefined> {
    const existing = this.records.get(sessionId);
    if (!existing) { return Promise.resolve(undefined); }
    const updated = { ...existing, ...patch };
    this.records.set(sessionId, updated);
    const done = this.persist().then(() => ({ ...updated }));
    // CDX-060: most call sites fire-and-forget updates (`void registry.update…`).
    // persist()'s chain handles ITS promise, but this derived one would still
    // reject unhandled and take down whatever vitest worker/test happens to be
    // running — the flake's visible form. Awaiting callers still see the error.
    done.catch(() => undefined);
    return done;
  }

  /**
   * Delete a record and remember its id as a tombstone (capped FIFO) so the
   * next session-list publish can carry it in `removedSessions`.
   */
  remove(sessionId: string): Promise<boolean> {
    const existed = this.records.delete(sessionId);
    if (!this.removed.includes(sessionId)) {
      this.removed.push(sessionId);
      if (this.removed.length > TOMBSTONE_CAP) {
        this.removed = this.removed.slice(-TOMBSTONE_CAP);
      }
    }
    const done = this.persist().then(() => existed);
    done.catch(() => undefined); // CDX-060 — see update()
    return done;
  }

  /** Tombstoned session ids, oldest first (max 100). */
  removedSessions(): string[] {
    return [...this.removed];
  }

  /**
   * Flip every session to state 'offline' — called at shutdown so the final
   * session-list publish stays truthful (the old bridge published an empty
   * list, which wiped the phone).
   */
  markOffline(): Promise<void> {
    for (const rec of this.records.values()) {
      rec.state = 'offline';
    }
    return this.persist();
  }

  /** Map registry records + transcript seqHigh to protocol RemoteSessionInfo. */
  toRemoteSessionInfo(transcript: SeqHighSource): RemoteSessionInfo[] {
    return [...this.records.values()].map((rec) => {
      const seqHigh = transcript.seqHigh(rec.sessionId);
      const info: RemoteSessionInfo = {
        id: rec.sessionId,
        slug: rec.sessionId.slice(0, 8),
        cwd: rec.cwd,
        lastActivity: rec.lastActivity,
        lineCount: seqHigh,
        title: rec.title,
        project: rec.project,
        state: rec.state,
        seqHigh,
      };
      if (rec.permissionMode !== undefined) { info.permissionMode = rec.permissionMode; }
      if (rec.effortLevel !== undefined) { info.effortLevel = rec.effortLevel; }
      if (rec.model !== undefined) { info.model = rec.model; }
      // CDX-062: providerLabel is NOT resolved here — the orchestrator owns
      // the live profile lookup at publish time (label survives deletion).
      if (rec.providerId !== undefined) { info.providerId = rec.providerId; }
      if (rec.committed) { info.committed = true; }
      if (rec.contextWindow !== undefined) { info.contextWindow = rec.contextWindow; }
      if (rec.contextPercentage !== undefined) { info.contextPercentage = rec.contextPercentage; }
      return info;
    });
  }

  private log(msg: string): void {
    this.logFn?.(msg);
  }
}
