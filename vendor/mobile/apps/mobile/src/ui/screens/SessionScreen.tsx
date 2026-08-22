/**
 * Session screen (Phase 3c) — TranscriptView (virtua + single-owner pin, bug
 * C's cure) + session header (state, cwd, effort selector, usage, interrupt)
 * + the outbox-backed input bar. The 3b naive keep-at-bottom scroll is GONE —
 * the pin hook inside TranscriptView is the only scroll driver in the app.
 *
 * CDX-044: the model is chosen ONCE, when the session is started
 * (NewSessionModal's picker) — the header carries no model dropdown. The
 * protocol/core side of mid-session model changes (`bridgeApi.modelChange`,
 * the machines-store model list) is deliberately KEPT; only the header
 * control is gone.
 *
 * A still-pending permission can be buried under a collapsed sub-agent group,
 * which is exactly how a prompt goes unseen and a turn deadlocks — so the
 * latest pending permission is mirrored in an always-visible bar above the
 * input (ported RemotePermissionBar behaviour).
 *
 * Phase 8 split: the header rows + GsdStrip + TranscriptView live inside one
 * `.slide` region (MainPanel's swipe carousel translates it via `slideRef`);
 * the permission bar + attachment strip + input bar stay OUTSIDE, static
 * while the content slides (old-app MainPanel layout). The carousel slides
 * this container AROUND the transcript — useTranscriptPin remains the single
 * scroll owner. Touch devices also get ‹/› attention chevrons in the compact
 * header when a session needing attention lies left/right in carousel order.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { effortLevelSchema, type UsageData } from '@codedeck/protocol';
import { createModeCycle, MODE_LABELS } from '../../core/modeCycle';
import { realTimers } from '../../core/ports';
import { useConnection, useMachines, useOutbox, usePhoneCore, useQuickPrompts, useSettings, useTranscript, useUi } from '../coreContext';
import { appendToDraft } from '../appendToDraft';
import { GsdStrip } from '../gsd/GsdStrip';
import { AttachIcon, MicIcon } from '../icons';
import { recognizeSpeech } from '../../platform/stt';
import { DEFAULT_BLOSSOM_SERVER, uploadDmImage } from '../../platform/dmImages';
import { modelLabel } from '../modelLabel';
import { findPendingPermission } from '../transcript/displayEntries';
import { TranscriptView } from '../transcript/TranscriptView';
import { contextBadge, usageBadges, type UsageBadge } from '../usageFormat';
import { getOrderedSessionKeys } from '../getOrderedSessionKeys';
import {
  SESSION_IMAGE_SEND_BUDGET_MS,
  processImageFile,
  sendSessionImage,
} from '../imageFile';
import { describeError, isCancelled, withDeadline } from '../../core/deadline';
import type { EncryptedImageRef } from '../../core/dmAttachments';
import { cx, presenceBadge, shared as s, stateBadge } from '../shared';
import { useAttentionDirection } from '../useAttentionDirection';
import { useAutoGrowTextarea } from '../autoGrowTextarea';
import { useMediaQuery } from '../useMediaQuery';
import styles from './SessionScreen.module.css';

const sessionKeyOf = (machine: string, sessionId: string): string => `${machine} ${sessionId}`;

const EFFORT_LEVELS = effortLevelSchema.options;

/** The backstop is the send budget plus a grace, so the bounded stages inside
 *  always get to report their own, more specific error first. */
const SESSION_IMAGE_SEND_BACKSTOP_MS = SESSION_IMAGE_SEND_BUDGET_MS + 5_000;

/**
 * Severity for the usage BOX (CDX-045), ported from the old app's
 * `UsageBadge.severity()` — the worst utilization across the reported windows
 * colors the whole rectangle, as it did in `codedeck/src/components/`.
 * Presentation only, and deliberately here rather than in `usageFormat.ts`:
 * that module's formatting is unit-tested and stays untouched. The ≥90
 * critical threshold still comes from its `critical` flag; only the ≥75
 * warning tier reads the same snapshot the badges were built from.
 */
function usageSeverity(
  usage: UsageData | undefined,
  badges: UsageBadge[],
): 'ok' | 'warn' | 'critical' {
  if (badges.some((b) => b.critical)) return 'critical';
  const utilizations = [usage?.fiveHour, usage?.sevenDay, usage?.sevenDayOpus, usage?.sevenDaySonnet]
    .map((w) => w?.utilization)
    .filter((u): u is number => typeof u === 'number' && Number.isFinite(u));
  return utilizations.some((u) => u >= 75) ? 'warn' : 'ok';
}

export function SessionScreen({
  machinePubkey,
  sessionId,
  onMenu,
  slideRef,
}: {
  machinePubkey: string;
  sessionId: string;
  /** Narrow one-screen shell: ☰ opens the session drawer (Phase 2a). */
  onMenu?: () => void;
  /** Phase 8: the swipe carousel translates the header+transcript region via
   *  this ref; the input/permission bars below stay static. */
  slideRef?: React.Ref<HTMLDivElement>;
}) {
  const core = usePhoneCore();
  const connectionStatus = useConnection((st) => st.status);
  const sessionKey = sessionKeyOf(machinePubkey, sessionId);
  const sessionInfo = useMachines(
    (s) => s.machines[machinePubkey]?.sessions[sessionId]?.info,
  );
  const usage = useMachines((s) => s.machines[machinePubkey]?.sessions[sessionId]?.usage);
  const transcript = useTranscript((s) => s.sessions[sessionKey]);
  const outboxItems = useOutbox((s) => s.items);
  const respondedCards = useUi((s) => s.respondedCards[sessionKey]);

  // Phase 8: ‹/› attention chevrons — same ordered list as the swipe carousel,
  // same predicate as the sidebar's attention dot. Touch devices only.
  const isTouchDevice = useMediaQuery('(pointer: coarse)');
  const allMachines = useMachines((s) => s.machines);
  const orderedKeys = useMemo(() => getOrderedSessionKeys(allMachines), [allMachines]);
  const currentKey = useMemo(
    () => ({ machine: machinePubkey, sessionId }),
    [machinePubkey, sessionId],
  );
  const attention = useAttentionDirection(orderedKeys, currentKey);

  const [draft, setDraft] = useState('');
  const draftRef = useRef<HTMLTextAreaElement>(null);
  // CDX-025: the composer must grow with its own wrapped text instead of
  // slicing the second line off against the rounded bottom border. CSS holds
  // a two-line floor; this carries it up to `.textarea`'s max-height.
  useAutoGrowTextarea(draftRef, draft);

  // Mode cycle button (CDX-046): tappable PLAN → YOLO → EDITS, replacing the
  // read-only badge. The controller (core/modeCycle) owns cooldown / pending /
  // timeout-revert; this component only re-renders on its onChange tick and
  // feeds it the store's confirmed mode.
  const confirmedMode = sessionInfo?.permissionMode;
  const [, setModeTick] = useState(0);
  const modeCycle = useMemo(
    () =>
      createModeCycle({
        send: (mode) => void core.api.modeChange(machinePubkey, sessionId, mode),
        confirmed: () =>
          core.machines.getState().session(machinePubkey, sessionId)?.info.permissionMode,
        onChange: () => setModeTick((n) => n + 1),
        timers: realTimers,
        now: Date.now,
      }),
    [core, machinePubkey, sessionId],
  );
  useEffect(() => () => modeCycle.dispose(), [modeCycle]);
  // mode-confirmed landed in the machines store (onModeConfirmed →
  // updateSessionInfo) → settle the pending request.
  useEffect(() => {
    modeCycle.noteConfirmed();
  }, [modeCycle, confirmedMode]);

  // Image attachment (Phase 5, CDX-029): staged file → processed + uploaded on
  // Send (Blossom first, relay chunks as fallback) → upload-image message with
  // the draft as the accompanying text. Gated on the machine advertising the
  // `images` capability in its sessions heartbeat. Same staged-attachment
  // pattern as DmChatScreen.
  const capabilities = useMachines((s) => s.machines[machinePubkey]?.capabilities);
  const canAttachImages = capabilities?.includes('images') ?? false;
  const blossomServer = useSettings((st) => st.blossomServer);
  // CDX-048: the 5h/7d usage box is gated by Settings → "Show usage badge".
  const showUsageBadge = useSettings((st) => st.showUsageBadge);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingImage, setPendingImage] = useState<{ file: File; previewUrl: string | null } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // CDX-068: rises on every ✕/replace. A send whose generation is stale has
  // been ABANDONED by the user and writes nothing back — no banner about an
  // attachment they already dropped, no `setDraft('')` over text they have
  // since retyped, no `setUploading(false)` stomping a newer upload.
  const attachGenerationRef = useRef(0);
  /**
   * CDX-086: the generation counter above guards WRITE-BACK; this aborts the
   * WORK. Both are needed and neither substitutes for the other — the founder hit
   * ✕ on a wedged upload and the image was delivered anyway, because the only
   * guard on that path ran after the publish had already happened.
   */
  const sendAbortRef = useRef<AbortController | null>(null);
  /** Bytes already on the server, so a retry never re-uploads them. */
  const uploadedRefRef = useRef<EncryptedImageRef | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [sentUnconfirmed, setSentUnconfirmed] = useState(false);

  const clearPendingImage = (): void => {
    if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage(null);
  };

  /** Stop the work, THEN stop the writes. Order matters only for clarity; both
   *  must happen or the old bug comes back in one form or the other. */
  const cancelInFlightSend = (): void => {
    attachGenerationRef.current++;
    sendAbortRef.current?.abort();
    sendAbortRef.current = null;
  };

  /** The ✕ handler — deliberately live even mid-upload (CDX-068). A read that
   *  has not come back yet leaves the composer in a state whose ONLY exit is
   *  this button; disabling it while `uploading` made a stalled read
   *  unrecoverable without leaving the screen. CDX-086: it now genuinely
   *  cancels, rather than only ignoring the result. */
  const removePendingImage = (): void => {
    cancelInFlightSend();
    clearPendingImage();
    setUploading(false);
    setUploadError(null);
    setUploadProgress(null);
    setSentUnconfirmed(false);
    uploadedRefRef.current = null;
  };

  const pickImage = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    cancelInFlightSend(); // replaces (and cancels) any in-flight send
    if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
    const previewUrl =
      typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
    setPendingImage({ file, previewUrl });
    setUploading(false);
    setUploadError(null);
    setUploadProgress(null);
    setSentUnconfirmed(false);
    uploadedRefRef.current = null;
    e.target.value = '';
  };

  // Leaving the screen must not leave a publish loop running behind it.
  useEffect(() => () => sendAbortRef.current?.abort(), []);

  // Quick prompts (CDX-049): tappable shortcuts above the input bar; a tap
  // INSERTS the prompt into the draft (appends, never auto-sends) — the
  // ported legacy bar's contract in this rebuild.
  const quickPromptList = useQuickPrompts((st) => st.prompts);
  const insertPrompt = (text: string): void => {
    setDraft((d) => appendToDraft(d, text));
    draftRef.current?.focus();
  };

  // Mic (plan §5): native STT via the codedeck-stt plugin (Android system
  // recognizer). Result appends to the draft; on desktop/denied the plugin
  // returns null and we just focus the input (the plan's desktop behaviour).
  const mic = async (): Promise<void> => {
    const text = await recognizeSpeech();
    if (text) setDraft((d) => appendToDraft(d, text));
    else draftRef.current?.focus();
  };

  // Hydrate persisted rows + reconcile toward the advertised seqHigh on mount.
  useEffect(() => {
    void core.transcript.getState().hydrateSession(machinePubkey, sessionId);
    const target = core.machines.getState().session(machinePubkey, sessionId)?.info.seqHigh ?? 0;
    if (target > 0) {
      void core.transcript.getState().ensureSynced(machinePubkey, sessionId, target);
    }
  }, [core, machinePubkey, sessionId]);

  // Ask for the machine's model list once if we don't have it. The header no
  // longer has a model select (CDX-044), but this is what WARMS the shared
  // machines-store list so NewSessionModal's picker is already populated the
  // moment it opens — the modal re-requests on its own mount as the fallback,
  // and a modal opening with an empty list is the regression this guards.
  useEffect(() => {
    if (!core.machines.getState().machine(machinePubkey)?.models) {
      void core.api.modelsRequest(machinePubkey);
    }
  }, [core, machinePubkey]);

  // Refresh the subscription-usage snapshot on open (CDX-011 usage polish):
  // the bridge only publishes usage when asked; unsupported SDKs publish
  // nothing and the header just shows no usage badge.
  useEffect(() => {
    void core.api.usageRequest(machinePubkey, sessionId);
  }, [core, machinePubkey, sessionId]);

  const pendingPermission = useMemo(() => {
    const entries = transcript
      ? Object.entries(transcript.entries)
          .map(([seq, entry]) => ({ seq: Number(seq), entry }))
          .sort((a, b) => a.seq - b.seq)
      : [];
    return findPendingPermission(entries, respondedCards);
  }, [transcript, respondedCards]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (pendingImage) {
      await sendWithImage(text);
      return;
    }
    if (text === '') return;
    setDraft('');
    await core.outbox.getState().send(machinePubkey, sessionId, text);
  };

  /** Blossom-first upload; on total failure the draft AND the staged image
   *  survive (inline error, nothing sent). CDX-068: the read now carries a
   *  deadline, so a stalled provider ends in the banner rather than a spinner
   *  that never stops — and if the user gave up first and hit ✕, the stale
   *  generation makes every write below a no-op. */
  const sendWithImage = async (text: string): Promise<void> => {
    if (!pendingImage || uploading) return;
    const generation = attachGenerationRef.current;
    const abandoned = (): boolean => generation !== attachGenerationRef.current;
    const controller = new AbortController();
    sendAbortRef.current = controller;
    setUploading(true);
    setUploadError(null);
    setSentUnconfirmed(false);
    try {
      const image = await processImageFile(pendingImage.file);
      if (abandoned()) return;
      const secretKey = core.identity.getState().keypair.secretKey;
      const existingRef = uploadedRefRef.current;
      /**
       * The outer backstop. Every stage below it is bounded tighter, so THIS
       * MUST NEVER BE THE THING THAT FIRES — if it does, an unbounded stage has
       * been added. It exists so "the spinner always resolves" is a structural
       * guarantee rather than the sum of several assumptions.
       */
      const outcome = await withDeadline(
        sendSessionImage(image, text, {
          signal: controller.signal,
          ...(existingRef ? { existingRef } : {}),
          onUploaded: (ref) => {
            uploadedRefRef.current = ref;
          },
          onProgress: (done, total) => {
            if (!abandoned()) setUploadProgress({ done, total });
          },
          uploadToBlossom: (bytes, opts) =>
            uploadDmImage(bytes, secretKey, blossomServer || DEFAULT_BLOSSOM_SERVER, opts),
          sendBlossom: (p) => core.api.uploadImageBlossom(machinePubkey, { sessionId, ...p }),
          sendChunk: (p) =>
            core.api.uploadImageChunk(machinePubkey, { sessionId, ...p }, { attempts: 1 }),
          log: (msg) => console.log(msg),
        }),
        SESSION_IMAGE_SEND_BACKSTOP_MS,
        'image send',
        () => controller.abort(),
      );
      if (abandoned()) return;
      clearPendingImage();
      setDraft('');
      uploadedRefRef.current = null;
      if (outcome === 'blossom-unconfirmed') setSentUnconfirmed(true);
    } catch (err) {
      // A cancel is the user's own doing — no banner, and removePendingImage has
      // already tidied the composer.
      if (abandoned() || isCancelled(err)) return;
      setUploadError(describeError(err));
    } finally {
      if (!abandoned()) {
        setUploading(false);
        setUploadProgress(null);
      }
      if (sendAbortRef.current === controller) sendAbortRef.current = null;
    }
  };

  const respondPending = (allow: boolean): void => {
    if (!pendingPermission) return;
    core.ui.getState().markCardResponded(machinePubkey, sessionId, pendingPermission.requestId);
    void core.api.permissionResponse(
      machinePubkey,
      sessionId,
      pendingPermission.requestId,
      allow,
    );
  };

  const state = sessionInfo?.state;
  const running = state === 'running';
  const hasUnresolvedOutbox = Object.values(outboxItems).some(
    (i) => i.machine === machinePubkey && i.sessionId === sessionId && i.state === 'failed',
  );
  // Usage badges (CDX-011): context % with real token counts when the SDK
  // reported the window; subscription windows with reset countdown tooltips.
  const ctxText = contextBadge(sessionInfo?.contextPercentage, sessionInfo?.contextWindow);
  // The tag is terse by necessity; the tooltip carries the full id (and says so
  // when the bridge reported none, rather than leaving a bare "?" unexplained).
  const modelTitle = sessionInfo?.model
    ? `Model: ${sessionInfo.model} — context window used`
    : 'Model not reported by the bridge — context window used';
  const usageBadgeList = usageBadges(usage, Date.now());

  return (
    <>
      {/* Slide region — the swipe carousel translates ONLY this container. */}
      <div ref={slideRef ?? null} className={styles.slide} data-testid="session-slide">
      <div className={styles.header}>
        {isTouchDevice && attention.left && (
          <span className={styles.navHint} data-side="left" data-testid="nav-hint-left" aria-hidden="true">
            {'‹'}
          </span>
        )}
        {isTouchDevice && attention.right && (
          <span className={styles.navHint} data-side="right" data-testid="nav-hint-right" aria-hidden="true">
            {'›'}
          </span>
        )}
        {onMenu && (
          <button className={styles.menuBtn} onClick={onMenu} aria-label="Open sessions">
            ☰
          </button>
        )}
        {state && <span className={cx(stateBadge(state), styles.boxed)}>{state}</span>}
        <span className={styles.cwd} title={sessionInfo?.cwd}>
          {sessionInfo?.cwd ?? ''}
        </span>
        <span
          className={cx(
            presenceBadge(connectionStatus === 'connected' ? 'live' : 'offline'),
            styles.boxed,
          )}
        >
          {connectionStatus}
        </span>
        {/* CDX-087: model tag + context in ONE rectangle above the usage box,
          * the old app's `.header-model-badge` (codedeck/src/styles/header.css
          * :139-158). Read-only — the model is chosen once, at session start
          * (CDX-044), so this is a label and not a control. */}
        {(ctxText || sessionInfo) && (
          <span className={styles.ctxBox} data-testid="ctx-badge" title={modelTitle}>
            <span className={styles.modelTag} data-testid="model-tag">
              {modelLabel(sessionInfo?.model)}
            </span>
            {ctxText && <span className={styles.ctxPct}> · {ctxText}</span>}
          </span>
        )}
        {showUsageBadge && usageBadgeList.length > 0 && (
          <span
            className={styles.usageBox}
            data-testid="usage-box"
            data-severity={usageSeverity(usage, usageBadgeList)}
          >
            {usageBadgeList.map((b) => (
              <span
                key={b.text.slice(0, 2)}
                className={styles.usageRow}
                data-testid="usage-badge"
                {...(b.title ? { title: b.title } : {})}
              >
                {b.text}
              </span>
            ))}
          </span>
        )}
        {running && (
          <button
            className={styles.stopBtn}
            onClick={() => void core.api.interrupt(machinePubkey, sessionId)}
          >
            Stop
          </button>
        )}
      </div>
      {/* Row 2 — effort + mode. No model select: the model is picked once, at
        * create time, in NewSessionModal (CDX-044). */}
      <div className={styles.header}>
        <select
          className={styles.select}
          aria-label="Effort"
          value={sessionInfo?.effortLevel ?? ''}
          onChange={(e) => {
            const level = effortLevelSchema.safeParse(e.target.value);
            if (level.success) void core.api.effortChange(machinePubkey, sessionId, level.data);
          }}
        >
          <option value="" disabled>
            effort…
          </option>
          {EFFORT_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        {sessionInfo?.permissionMode && (
          <button
            className={cx(
              s.badge,
              styles.boxed,
              styles.modeBtn,
              modeCycle.isPending() && styles.modePending,
            )}
            data-testid="mode-button"
            data-pending={modeCycle.isPending() || undefined}
            aria-label="Permission mode"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => modeCycle.tap()}
            title={modeCycle.isPending() ? 'Applying…' : 'Tap to switch mode'}
          >
            {MODE_LABELS[modeCycle.displayed()]}
          </button>
        )}
        {hasUnresolvedOutbox && (
          <span className={cx(stateBadge('waiting_permission'), styles.boxed)}>send failed</span>
        )}
        {/* CDX-059(b): the FULL stored title (≤80 chars, `…` exactly at the
          * 77+`...` boundary) gets an on-device surface — the sidebar card
          * CSS-truncates at ~30 chars, which left the >80-char title rule
          * with no device observable at all. Wraps instead of ellipsizing so
          * the stored ellipsis itself is what a device check reads. */}
        {sessionInfo?.title && (
          <span className={styles.fullTitle} data-testid="session-full-title">
            {sessionInfo.title}
          </span>
        )}
      </div>

      <GsdStrip machinePubkey={machinePubkey} sessionId={sessionId} />

      <TranscriptView machinePubkey={machinePubkey} sessionId={sessionId} />
      </div>

      {pendingPermission && (
        <div className={styles.pendingBar} aria-live="assertive">
          <span className={styles.pendingLabel}>
            {pendingPermission.isSubAgent
              ? `${pendingPermission.agentLabel ?? 'Sub-agent'}: `
              : ''}
            {pendingPermission.toolName} needs permission
          </span>
          <button className={styles.allowBtn} onClick={() => respondPending(true)}>
            Allow
          </button>
          <button className={styles.denyBtn} onClick={() => respondPending(false)}>
            Deny
          </button>
        </div>
      )}

      {pendingImage && (
        <div className={styles.attachStrip} data-testid="session-attach-strip">
          {pendingImage.previewUrl && (
            <img
              className={styles.attachThumb}
              src={pendingImage.previewUrl}
              alt="attachment preview"
            />
          )}
          <span className={styles.attachName}>{pendingImage.file.name}</span>
          <span className={styles.attachSize}>
            {/* Keeps the `uploading…` substring — it is the oracle several
              * device checks and host tests read. */}
            {uploading
              ? uploadProgress
                ? `uploading… ${uploadProgress.done}/${uploadProgress.total}`
                : 'uploading…'
              : `${Math.max(1, Math.round(pendingImage.file.size / 1024))} KB`}
          </span>
          {/* Never disabled (CDX-068): this is the escape hatch from an
            * upload — or a file read — that has not come back. */}
          <button className={s.btnSmall} onClick={removePendingImage} aria-label="Remove attachment">
            ✕
          </button>
        </div>
      )}
      {uploadError && (
        <div className={s.bannerError} data-testid="session-upload-failed">
          Image upload failed: {uploadError}
        </div>
      )}
      {/* CDX-086: the frame reached an open socket but no relay confirmed it
        * inside the window. Almost certainly delivered — and the honest
        * confirmation is the image turning up in the transcript — so say that
        * rather than either claiming success or crying failure. */}
      {sentUnconfirmed && (
        <div className={s.bannerOk} data-testid="session-upload-unconfirmed">
          Image sent — the relay never confirmed it. If it doesn’t appear above, send it again.
        </div>
      )}

      {/* Quick prompts (CDX-049) — directly above the input bar; hidden
        * entirely when the user has none defined. */}
      {quickPromptList.length > 0 && (
        <div className={styles.quickPromptBar} data-testid="quick-prompt-bar">
          {quickPromptList.map((qp) => (
            <button
              key={qp.id}
              type="button"
              className={styles.quickPromptBtn}
              title={qp.text}
              onClick={() => insertPrompt(qp.text)}
            >
              {qp.label}
            </button>
          ))}
        </div>
      )}

      <div className={styles.inputbar}>
        {canAttachImages && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={pickImage}
              data-testid="session-file-input"
            />
            <button
              className={styles.attachBtn}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="Attach image"
              title="Attach image"
            >
              <AttachIcon />
            </button>
          </>
        )}
        <textarea
          ref={draftRef}
          className={styles.textarea}
          rows={1}
          value={draft}
          placeholder="Message the session…"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className={styles.micBtn}
          onClick={() => void mic()}
          aria-label="Dictate with voice"
          title="Dictate with voice"
        >
          <MicIcon />
        </button>
        <button
          className={s.btnPrimary}
          onClick={() => void send()}
          disabled={(draft.trim() === '' && pendingImage === null) || uploading}
        >
          Send
        </button>
      </div>
    </>
  );
}
