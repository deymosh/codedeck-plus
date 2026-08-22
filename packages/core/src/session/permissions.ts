/**
 * Permission arbitration — ported verbatim in logic from the old bridge's
 * `SdkSessionManager.handlePermission()` and its security helpers (covered by
 * the old security.test.ts, cases re-ported here).
 *
 * Structure changed: the arbitration now lives in a `PermissionBroker` class
 * with injected callbacks, so it is testable without a real SDK and without
 * the session manager. Behavior changes vs the old code:
 *   - the pending-permission/question timeout default is 1 HOUR (was 24h),
 *     and it is injectable for tests.
 * Everything else — order, guards, messages, SDK result shapes — is the old
 * battle-tested logic.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionMode } from '@codedeck/protocol';
import type { SdkPermissionResult, SdkPermissionUpdate } from '../sdk/facade';

// --- Security helpers (ported from old sdkSession.ts / deviceActions.ts) ---

/**
 * Secret-bearing paths a device-test session must never read (signing keystores + their cleartext
 * password files + env files). Matched case-insensitively anywhere in a tool's string arguments.
 * This is the enforced half of the SKILL.md "dev builds only, never touch release keystores" rule.
 *
 * CDX-013 widened the ported list with the classic credential files the old
 * regex missed: SSH keys, cloud/registry credentials, PEM material, and git
 * credential stores.
 */
const SECRET_PATH_PATTERNS = [
  String.raw`\.keystore`,
  String.raw`\.jks`,
  String.raw`\.p12`,
  String.raw`\.pfx`,
  String.raw`key\.properties`,
  String.raw`keystore\.properties`,
  String.raw`(?<![A-Za-z0-9])\.env`,
  // CDX-013 additions:
  String.raw`\.ssh`,
  String.raw`id_(?:rsa|ed25519|ecdsa|dsa)`,
  String.raw`\.pem`,
  String.raw`\.netrc`,
  String.raw`\.npmrc`,
  String.raw`\.aws/credentials`,
  String.raw`\.git-credentials`,
  String.raw`\.credentials\.json`,
];

const SECRET_PATH_RE = new RegExp(
  `(${SECRET_PATH_PATTERNS.join('|')})(?![A-Za-z0-9])`,
  'i',
);

/** Tools whose arguments can name a filesystem path / shell command we should screen. */
const PATH_BEARING_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit']);

/** True if a (test-session) tool call references a secret-bearing path in any of its string args. */
export function touchesSecretPath(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (!PATH_BEARING_TOOLS.has(toolName)) return false;
  const haystack = JSON.stringify(toolInput ?? {});
  return SECRET_PATH_RE.test(haystack);
}

/** Absolute path of the harness plan-authoring directory (`~/.claude/plans`, honoring CLAUDE_CONFIG_DIR). */
function plansDirPath(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const base = env && env.trim() ? env.trim() : path.join(os.homedir(), '.claude');
  return path.join(base, 'plans');
}

/**
 * Detect a benign write confined to the harness plan directory (`~/.claude/plans`).
 *
 * In plan mode the SDK gates writes through canUseTool. A plan sub-agent's `mkdir -p ~/.claude/plans`
 * (or writing the plan file itself) would otherwise block on phone approval — and if that prompt is
 * never surfaced/answered it deadlocks the whole session (the sub-agent never returns to the parent).
 * Auto-allowing ONLY this narrow, safe path breaks that deadlock without weakening plan mode for real
 * edits. Fails CLOSED: anything ambiguous returns false and falls through to normal phone approval.
 */
export function isBenignPlanDirWrite(toolName: string, toolInput: Record<string, unknown>): boolean {
  const plansDir = plansDirPath();
  // Expand ONLY a bare `~` / `~/...` (current user's home). `~otheruser` is deliberately left
  // unexpanded so it cannot resolve into our plans dir — it falls through to phone approval.
  const expandTilde = (p: string): string =>
    p === '~' ? os.homedir()
    : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2))
    : p;
  const underPlans = (p: unknown): boolean => {
    if (typeof p !== 'string' || !p) return false;
    const resolved = path.resolve(expandTilde(p));
    return resolved === plansDir || resolved.startsWith(plansDir + path.sep);
  };

  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return underPlans(toolInput.file_path);
    case 'NotebookEdit':
      return underPlans(toolInput.notebook_path ?? toolInput.file_path);
    case 'Bash': {
      let command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
      if (!command) return false;
      // Strip harmless trailing `echo "<literal>"` status messages the harness appends. Only
      // string-literal echoes (no $, backtick, backslash, or redirection) are removed.
      command = command.replace(/(^|;)\s*echo\s+(?:"[^"$`\\]*"|'[^']*')\s*(?=;|$)/g, '$1');
      command = command.replace(/^\s*;+|;+\s*$/g, '').trim();
      // Strip a harmless stderr-suppression redirect on the mkdir.
      command = command.replace(/\s+2>\s*\/dev\/null\b/g, '').trim();
      // Whatever remains must be a single simple mkdir with no chaining/redirection metacharacters.
      // `~` is allowed through (expandTilde handles it below); `..` is still rejected.
      if (/[;&|`$<>]|\.\./.test(command)) return false;
      const m = command.match(/^mkdir\s+(?:-p\s+)?(['"]?)([^'"]+)\1$/);
      if (!m) return false;
      return underPlans(m[2]);
    }
    default:
      return false;
  }
}

/**
 * Scrub common secret shapes from text before it leaves the machine over the
 * relay (logcat, tool output). Defense-in-depth — ported from deviceActions.ts.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, '[REDACTED_JWT]')
    .replace(/\bnsec1[02-9ac-hj-np-z]{20,}/gi, '[REDACTED_NSEC]')
    .replace(/([A-Za-z]*(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|auth))\s*[=:]\s*["']?[^\s"'&]+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{64,}\b/g, '[REDACTED_HEX]');
}

// --- Broker types ---

/** Per-call context the session runner passes alongside the SDK's canUseTool args. */
export interface PermissionContext {
  sessionId: string;
  /** The session's CURRENT tracked permission mode. */
  permissionMode: PermissionMode;
  /** True when this session has the on-device adb MCP tools (device-test session).
   *  Enforces the secret-path deny-list regardless of permission mode. */
  testSession?: boolean;
  /** Best-effort friendly sub-agent type (e.g. 'Plan') for labelling the card. */
  agentLabel?: string;
}

/** Subset of the SDK canUseTool options the broker consumes. */
export interface PermissionCallOptions {
  toolUseID: string;
  agentID?: string;
  title?: string;
  description?: string;
}

export interface PermissionCard {
  sessionId: string;
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  title?: string;
  description?: string;
  /** Opaque sub-agent ID if this tool call originates inside a sub-agent. */
  agentId?: string;
  /** True when the request came from a sub-agent rather than the top-level turn. */
  isSubAgent?: boolean;
  /** Best-effort friendly sub-agent type (e.g. 'Plan'). */
  agentLabel?: string;
}

export interface QuestionSpec {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface PermissionBrokerCallbacks {
  /** A generic tool call needs phone approval — publish a permission card. */
  onPermissionCard: (card: PermissionCard) => void;
  /** An AskUserQuestion is blocking the turn — publish a question card. */
  onQuestionCard: (sessionId: string, toolUseId: string, questions: QuestionSpec[]) => void;
  /** An ExitPlanMode is pending — publish the dedicated plan card (the generic
   *  permission card is suppressed for it). */
  onPlanCard: (sessionId: string, toolUseId: string) => void;
  /** The SDK autonomously changed permission mode (EnterPlanMode). The owner of
   *  the session state must update its tracked mode. */
  onAutoModeChange: (sessionId: string, mode: PermissionMode) => void;
  /** The set of pending permissions/questions for a session changed (something
   *  started or stopped waiting) — republish session state to the phone. */
  onPendingChanged?: (sessionId: string) => void;
  log: (msg: string) => void;
}

export interface PermissionBrokerOptions {
  /** How long a pending permission/question may wait before auto-deny.
   *  Default 1 hour (the old bridge used 24h; shortened deliberately). */
  timeoutMs?: number;
}

interface PendingPermission {
  sessionId: string;
  toolName: string;
  resolve: (result: SdkPermissionResult) => void;
}

interface PendingQuestion {
  sessionId: string;
  /** The full original tool input, echoed back (plus answers) in updatedInput. */
  input: Record<string, unknown>;
  /** The questions array from the tool input. */
  questions: QuestionSpec[];
  /** Accumulated answers so far (question text → selected answer). */
  answers: Record<string, string>;
  /** Number of answers still needed before resolving. */
  remaining: number;
  /** Resolves the canUseTool promise with the collected answers. */
  resolve: (result: SdkPermissionResult) => void;
}

/** Default pending timeout: 1 hour (deliberate change from the old 24h). */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Arbitrates SDK canUseTool calls. Order (mode checks only where noted):
 *  1. test-session secret-path hard deny (mode-independent)
 *  2. AskUserQuestion → pending-question promise + question card
 *  3. EnterPlanMode → auto-allow + tracked-mode flip callback
 *  4. mode 'default' → allow everything (YOLO)
 *  5. narrow benign plans-dir write auto-allow
 *  6. ExitPlanMode → pending permission, dedicated plan card (generic card suppressed)
 *  7. everything else → pending permission + permission card
 */
export class PermissionBroker {
  private readonly callbacks: PermissionBrokerCallbacks;
  private readonly timeoutMs: number;

  /** Pending generic permissions, keyed by toolUseId (globally unique per SDK call). */
  private pendingPermissions = new Map<string, PendingPermission>();
  /** Pending AskUserQuestion groups, keyed by toolUseId. */
  private pendingQuestions = new Map<string, PendingQuestion>();
  /** Per-session arrival order of question groups — last entry is the active card. */
  private questionOrder = new Map<string, string[]>();

  constructor(callbacks: PermissionBrokerCallbacks, options?: PermissionBrokerOptions) {
    this.callbacks = callbacks;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  }

  /** The SDK canUseTool callback, plus our per-session context. */
  handleCanUseTool(
    ctx: PermissionContext,
    toolName: string,
    toolInput: Record<string, unknown>,
    options: PermissionCallOptions,
  ): Promise<SdkPermissionResult> {
    const { sessionId } = ctx;

    // SECURITY: device-test sessions run with full Read/Bash/Grep and (in YOLO mode) auto-approve.
    // Hard-deny any tool call that touches signing keystores / secret files, BEFORE the mode check,
    // so a prompt-injected or confused test agent can never exfiltrate release keys through the
    // Nostr output channel. This is an enforced control, not a prose guideline. Mode-independent.
    if (ctx.testSession && touchesSecretPath(toolName, toolInput)) {
      this.callbacks.log(`[perm] DENIED secret-path access by test session ${sessionId}: ${toolName}`);
      return Promise.resolve({
        behavior: 'deny',
        message: 'Blocked: device-test sessions may not read signing keystores or secret files (keystore/.jks/.p12/key.properties/keystore.properties/.env). This is a hard security boundary.',
      });
    }

    // AskUserQuestion: block until the user answers on the phone.
    // The SDK expects answers via updatedInput.answers (keyed by the FULL question text).
    if (toolName === 'AskUserQuestion') {
      const rawQuestions = (toolInput.questions as QuestionSpec[]) || [];
      this.callbacks.onQuestionCard(sessionId, options.toolUseID, rawQuestions);

      return new Promise<SdkPermissionResult>((resolve) => {
        const timer = setTimeout(() => {
          this.removeQuestion(options.toolUseID);
          this.callbacks.log(`[perm] Question timed out (${options.toolUseID}) in ${sessionId}`);
          resolve({ behavior: 'deny', message: 'Question timed out' });
          // Notify so the phone clears the "waiting_question" state on timeout.
          this.callbacks.onPendingChanged?.(sessionId);
        }, this.timeoutMs);
        timer.unref?.();

        const wrappedResolve = (result: SdkPermissionResult) => {
          clearTimeout(timer);
          resolve(result);
        };

        this.pendingQuestions.set(options.toolUseID, {
          sessionId,
          input: toolInput,
          questions: rawQuestions,
          answers: {},
          remaining: rawQuestions.length,
          resolve: wrappedResolve,
        });
        const order = this.questionOrder.get(sessionId) ?? [];
        order.push(options.toolUseID);
        this.questionOrder.set(sessionId, order);

        // Notify so the phone immediately shows a visible "waiting_question" state. Without this
        // the phone never learns the turn is blocked on the user — exactly how an unanswered
        // question deadlocks it.
        this.callbacks.log(`[perm] WAITING ON ANSWER: AskUserQuestion (${options.toolUseID}) in ${sessionId}`);
        this.callbacks.onPendingChanged?.(sessionId);
      });
    }

    // EnterPlanMode: SDK is autonomously entering plan mode. Tell the session owner to update its
    // tracked mode so subsequent canUseTool calls (especially ExitPlanMode) are correctly forwarded
    // to the phone instead of auto-approved.
    if (toolName === 'EnterPlanMode') {
      this.callbacks.onAutoModeChange(sessionId, 'plan');
      this.callbacks.log(`[perm] EnterPlanMode: switched ${sessionId} to plan mode`);
      return Promise.resolve({ behavior: 'allow' as const, updatedInput: {} });
    }

    // Default mode = YOLO: auto-approve everything (matches old bridge behavior
    // where the bridge simulated pressing '1' for every permission prompt)
    if (ctx.permissionMode === 'default') {
      return Promise.resolve({ behavior: 'allow', updatedInput: {} });
    }

    // Plan-authoring escape hatch: a plan-mode write confined to the harness plan directory
    // (~/.claude/plans) — typically a sub-agent's `mkdir -p ~/.claude/plans` — would otherwise
    // block on phone approval and can deadlock the whole session. Auto-allow ONLY this narrow,
    // safe path; everything else still forwards to the phone. (Narrow + fail-closed.)
    if (isBenignPlanDirWrite(toolName, toolInput)) {
      this.callbacks.log(`[perm] Auto-allowed benign plans-dir write in ${sessionId}: ${toolName}`);
      return Promise.resolve({ behavior: 'allow', updatedInput: {} });
    }

    // Plan / acceptEdits: forward to phone for manual approval. Capture sub-agent origin so the
    // phone can label the card ("Sub-agent wants to run ...") — canUseTool exposes only an opaque
    // agentID, not the agent type, so the friendly name is best-effort (ctx.agentLabel).
    const agentId = options.agentID;
    const isSubAgent = !!agentId;
    return new Promise<SdkPermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(options.toolUseID);
        this.callbacks.log(`[perm] Permission timed out for ${toolName} (${options.toolUseID}) in session ${sessionId}`);
        resolve({ behavior: 'deny', message: 'Permission timed out' });
        this.callbacks.onPendingChanged?.(sessionId);
      }, this.timeoutMs);
      timer.unref?.();

      const wrappedResolve = (result: SdkPermissionResult) => {
        clearTimeout(timer);
        resolve(result);
      };

      this.pendingPermissions.set(options.toolUseID, { sessionId, toolName, resolve: wrappedResolve });

      // ExitPlanMode is surfaced via the dedicated plan card — the plan-approval / exit-plan
      // handlers resolve this pending permission. Skip the generic permission card to avoid a
      // duplicate prompt next to the plan card.
      if (toolName === 'ExitPlanMode') {
        this.callbacks.onPlanCard(sessionId, options.toolUseID);
      } else {
        this.callbacks.onPermissionCard({
          sessionId,
          toolName,
          toolUseId: options.toolUseID,
          toolInput,
          title: options.title,
          description: options.description,
          agentId,
          isSubAgent,
          agentLabel: isSubAgent ? ctx.agentLabel : undefined,
        });
      }

      // Notify so the phone immediately shows a visible "waiting_permission" state — a buried
      // prompt is exactly how a turn deadlocks.
      this.callbacks.log(`[perm] WAITING ON APPROVAL: ${toolName} (${options.toolUseID})${isSubAgent ? ` [subagent ${agentId}]` : ''} in ${sessionId}`);
      this.callbacks.onPendingChanged?.(sessionId);
    });
  }

  /** Resolve a pending permission request from the phone. */
  resolvePermission(requestId: string, allow: boolean, modifier?: 'always' | 'never'): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      this.callbacks.log(`[perm] No pending permission for ${requestId}`);
      return false;
    }

    this.pendingPermissions.delete(requestId);
    // Permission answered — notify so the phone clears the "waiting_permission" state.
    this.callbacks.onPendingChanged?.(pending.sessionId);

    if (allow) {
      const result: SdkPermissionResult = { behavior: 'allow', updatedInput: {} };
      // "Always allow" → persist as a project-scoped allow rule so it survives across sessions.
      // Uses projectSettings (not session) because "Always Allow" implies persistence.
      if (modifier === 'always') {
        const rule: SdkPermissionUpdate = {
          type: 'addRules',
          rules: [{ toolName: pending.toolName }],
          behavior: 'allow',
          destination: 'projectSettings',
        };
        result.updatedPermissions = [rule];
      }
      pending.resolve(result);
    } else {
      pending.resolve({
        behavior: 'deny',
        message: modifier === 'never' ? 'User denied (never ask again)' : 'User denied',
      });
    }
    return true;
  }

  /** Find a pending permission by tool name (e.g. resolve ExitPlanMode from a plan-approval tap). */
  findPendingPermission(sessionId: string, toolName: string): string | undefined {
    for (const [toolUseId, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId && pending.toolName === toolName) return toolUseId;
    }
    return undefined;
  }

  /**
   * Answer the active pending AskUserQuestion for a session.
   * - `{ text }`: free-text answer to the next unanswered question in the group.
   * - `{ keypress }`: 1-based option selection resolved against that question's options.
   * Questions in a multi-question group are answered IN ORDER — the target index within the
   * group is `questions.length - remaining` (how many are already answered). Keying off
   * `remaining` — not any per-entry index — is what makes a 3-question group resolve q0,q1,q2
   * instead of overwriting the last question three times.
   * Returns false when no pending question matches (caller may fall back to plain input).
   */
  answerQuestion(sessionId: string, answer: { text: string } | { keypress: string }): boolean {
    const active = this.activeQuestion(sessionId);
    if (!active) {
      this.callbacks.log(`[perm] No pending question for answer in ${sessionId}`);
      return false;
    }
    const { toolUseId, pending } = active;
    const idx = Math.max(0, pending.questions.length - pending.remaining);
    const target = pending.questions[idx];

    let answerText: string;
    if ('text' in answer) {
      answerText = answer.text;
    } else {
      const keyNum = parseInt(answer.keypress, 10);
      if (isNaN(keyNum) || keyNum < 1) return false;
      const options = target?.options;
      if (!options || keyNum > options.length) {
        this.callbacks.log(`[perm] No option ${answer.keypress} for pending question in ${sessionId}`);
        return false;
      }
      answerText = options[keyNum - 1]!.label;
    }

    const questionText = target?.question ?? '';
    this.recordAnswer(toolUseId, pending, questionText, answerText);
    return true;
  }

  /** True while any AskUserQuestion group is pending for the session (input should route here). */
  hasPendingQuestions(sessionId: string): boolean {
    return this.activeQuestion(sessionId) !== null;
  }

  /** True while any generic permission is pending for the session. */
  hasPendingPermissions(sessionId: string): boolean {
    for (const pending of this.pendingPermissions.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Resolve+clear every pending permission and AskUserQuestion promise for a session with a deny.
   * Each promise's resolve is the wrappedResolve that clears its timeout, so this cannot
   * double-resolve later (a subsequent phone answer finds the entry gone and no-ops).
   *
   * Why questions too: an orphaned pending question is exactly what strands a turn after an
   * auto-restart — the old query is abandoned but its canUseTool promise lives on, and the SDK
   * emits "Tool permission stream closed before response received". Draining here lets the phone
   * clear its waiting state and the user retry.
   */
  denyAllPending(sessionId: string, reason: string): void {
    let changed = false;
    for (const [toolUseId, pending] of this.pendingPermissions) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingPermissions.delete(toolUseId);
      pending.resolve({ behavior: 'deny', message: reason });
      changed = true;
    }
    for (const [toolUseId, pending] of this.pendingQuestions) {
      if (pending.sessionId !== sessionId) continue;
      this.removeQuestion(toolUseId);
      pending.resolve({ behavior: 'deny', message: reason });
      changed = true;
    }
    if (changed) this.callbacks.onPendingChanged?.(sessionId);
  }

  // --- Internal ---

  /** Most-recently-asked still-pending question group for a session (matches the phone's active card). */
  private activeQuestion(sessionId: string): { toolUseId: string; pending: PendingQuestion } | null {
    const order = this.questionOrder.get(sessionId);
    if (!order) return null;
    for (let i = order.length - 1; i >= 0; i--) {
      const toolUseId = order[i];
      if (!toolUseId) continue;
      const pending = this.pendingQuestions.get(toolUseId);
      if (pending) return { toolUseId, pending };
    }
    return null;
  }

  private removeQuestion(toolUseId: string): void {
    const pending = this.pendingQuestions.get(toolUseId);
    this.pendingQuestions.delete(toolUseId);
    if (!pending) return;
    const order = this.questionOrder.get(pending.sessionId);
    if (order) {
      const i = order.indexOf(toolUseId);
      if (i >= 0) order.splice(i, 1);
      if (order.length === 0) this.questionOrder.delete(pending.sessionId);
    }
  }

  /**
   * Record one answer for a pending AskUserQuestion and resolve the promise once all questions
   * in the group have been answered.
   *
   * SDK 0.3.x AskUserQuestion keys answers by the FULL question text (see
   * AskUserQuestionOutput.answers: "question text -> answer string"), NOT the short header.
   * Keying by header leaves the per-question lookup undefined and crashes the SDK's result
   * builder ("undefined is not an object ... map").
   */
  private recordAnswer(
    toolUseId: string,
    pending: PendingQuestion,
    questionText: string,
    answer: string,
  ): void {
    pending.answers[questionText] = answer;
    pending.remaining--;

    if (pending.remaining <= 0) {
      // All questions answered — resolve the canUseTool promise
      this.removeQuestion(toolUseId);

      // Echo the original input (questions/options/multiSelect) and add the collected answers.
      // The SDK fills AskUserQuestionInput.answers from here.
      pending.resolve({
        behavior: 'allow',
        updatedInput: { ...pending.input, answers: pending.answers },
      });

      // Notify so the phone clears the "waiting_question" state now that the group is answered.
      this.callbacks.onPendingChanged?.(pending.sessionId);
    }
  }
}
