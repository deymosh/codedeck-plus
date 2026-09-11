/**
 * `PhoneCore` — the shape `createPhoneCoreNative.ts` builds and
 * `usePhoneCore()`/every screen consumes. The local, WebView-driven
 * composition this interface used to also describe an implementation of
 * (`createPhoneCore()`) is retired — see git history — now that
 * `createPhoneCoreNative` is the only composition root.
 */
import type { ConnectionStore } from './stores/connection';
import type { DmStore } from './stores/dm';
import type { IdentityStore } from './stores/identity';
import type { MachinesStore } from './stores/machines';
import type { MarmotStore } from './stores/marmot';
import type { OutboxStore } from './stores/outbox';
import type { PairingStore } from './stores/pairing';
import type { PendingSessionsStore } from './stores/pendingSessions';
import type { QuickPromptsStore } from './stores/quickPrompts';
import type { SettingsStore } from './stores/settings';
import type { TranscriptStore } from './stores/transcript';
import type { UiStore } from './stores/ui';
import type { BridgeApiLike } from './services/bridgeApi';

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
  api: BridgeApiLike;

  /** Begin connecting (idempotent). */
  start(): void;
  /** Deliberate shutdown: FSM → stopped, sockets closed, writes flushed. */
  stop(): Promise<void>;
  /** Await queued transcript writes (tests / suspend). */
  flush(): Promise<void>;
  /** Unpair a machine everywhere it lives: the machines entry, its sessions'
   *  transcripts and unread marks, a dangling selection, and the relay
   *  authors filter. The bridge side keeps running — this only forgets it
   *  locally. */
  removeMachine(pubkeyHex: string): Promise<void>;
  /** Optimistic session delete with a 4s undo window: dismissed + removed
   *  locally now; close-session reaches the bridge only after the window
   *  passes. `label` is what the undo toast shows. */
  deleteSession(machine: string, sessionId: string, label?: string): void;
  /** Cancel a pending deleteSession and restore the snapshot. */
  undoDelete(): void;
  /**
   * Attach + send a session image. `Intent::SendSessionImage` does the
   * entire Blossom-upload-then-chunk-fallback as one atomic step inside
   * Rust, so `SessionScreen.tsx` dispatches through this directly instead of
   * going through `BridgeApiLike.uploadImageBlossom`/`uploadImageChunk`
   * (see `createNativeBridgeApi`'s module doc for why those two cannot shim
   * it).
   */
  sendSessionImageNative(params: {
    machine: string;
    sessionId: string;
    text: string;
    /** Raw decoded bytes — the screen already has these from processing the
     *  picked file; this composition itself does no decoding. */
    image: Uint8Array;
    filename: string;
    mimeType: string;
  }): Promise<void>;
}
