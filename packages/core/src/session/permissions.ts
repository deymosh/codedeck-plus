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
import type { PermissionOption } from '@codedeck/protocol';
import { AUTO_APPROVE_MODE, permissionOptionsFor } from '../agents';
import type { PermissionMode, SdkPermissionResult, SdkPermissionUpdate } from '../sdk/facade';

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
  /** The agent the session runs on (decides which permission choices apply). */
  agent: string;
  /** The session's CURRENT tracked mode (an agent mode id). */
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
  /** The choices the phone may answer with. */
  options: PermissionOption[];
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
  /** An AskUserQuestion is blocking the turn — publish its question card. */
  onQuestionCard: (sessionId: string, requestId: string, questions: QuestionSpec[]) => void;
  /** An ExitPlanMode is pending — publish the plan approval card (the generic
   *  permission card is suppressed for it). */
  onPlanCard: (sessionId: string, requestId: string) => void;
  /** A card stopped waiting — answered, timed out or drained. `summary` is a
   *  short human description of the outcome. */
  onResolved: (sessionId: string, requestId: string, summary: string) => void;
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
  /** A plan approval (ExitPlanMode) rather than a permission card. */
  plan: boolean;
  options: PermissionOption[];
  resolve: (result: SdkPermissionResult) => void;
}

interface PendingQuestion {
  sessionId: string;
  /** The full original tool input, echoed back (plus answers) in updatedInput. */
  input: Record<string, unknown>;
  /** The questions array from the tool input. */
  questions: QuestionSpec[];
  /** Answers so far, by question index. */
  answers: Map<number, string>;
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
 *  4. auto-approve mode → allow everything (YOLO)
 *  5. narrow benign plans-dir write auto-allow
 *  6. ExitPlanMode → pending permission, plan approval card (generic card suppressed)
 *  7. everything else → pending permission + permission card
 *
 * Every card it publishes is later closed by exactly one `onResolved`.
 */
export class PermissionBroker {
  private readonly callbacks: PermissionBrokerCallbacks;
  private readonly timeoutMs: number;

  /** Pending permissions and plan approvals, keyed by toolUseId (globally unique per SDK call). */
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
    const requestId = options.toolUseID;

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
      this.callbacks.onQuestionCard(sessionId, requestId, rawQuestions);

      return new Promise<SdkPermissionResult>((resolve) => {
        const timer = setTimeout(() => {
          this.removeQuestion(requestId);
          this.callbacks.log(`[perm] Question timed out (${requestId}) in ${sessionId}`);
          resolve({ behavior: 'deny', message: 'Question timed out' });
          this.callbacks.onResolved(sessionId, requestId, 'Timed out');
          // Notify so the phone clears the "waiting_question" state on timeout.
          this.callbacks.onPendingChanged?.(sessionId);
        }, this.timeoutMs);
        timer.unref?.();

        const wrappedResolve = (result: SdkPermissionResult) => {
          clearTimeout(timer);
          resolve(result);
        };

        this.pendingQuestions.set(requestId, {
          sessionId,
          input: toolInput,
          questions: rawQuestions,
          answers: new Map(),
          resolve: wrappedResolve,
        });
        const order = this.questionOrder.get(sessionId) ?? [];
        order.push(requestId);
        this.questionOrder.set(sessionId, order);

        // Notify so the phone immediately shows a visible "waiting_question" state. Without this
        // the phone never learns the turn is blocked on the user — exactly how an unanswered
        // question deadlocks it.
        this.callbacks.log(`[perm] WAITING ON ANSWER: AskUserQuestion (${requestId}) in ${sessionId}`);
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

    // Auto-approve mode = YOLO: approve everything (matches old bridge behavior
    // where the bridge simulated pressing '1' for every permission prompt).
    if (ctx.permissionMode === AUTO_APPROVE_MODE) {
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

    // Any other mode: forward to the phone for manual approval. Capture sub-agent origin so the
    // phone can label the card ("Sub-agent wants to run ...") — canUseTool exposes only an opaque
    // agentID, not the agent type, so the friendly name is best-effort (ctx.agentLabel).
    const agentId = options.agentID;
    const isSubAgent = !!agentId;
    const plan = toolName === 'ExitPlanMode';
    const cardOptions = plan ? [] : permissionOptionsFor(ctx.agent);
    return new Promise<SdkPermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        this.callbacks.log(`[perm] Permission timed out for ${toolName} (${requestId}) in session ${sessionId}`);
        resolve({ behavior: 'deny', message: 'Permission timed out' });
        this.callbacks.onResolved(sessionId, requestId, 'Timed out');
        this.callbacks.onPendingChanged?.(sessionId);
      }, this.timeoutMs);
      timer.unref?.();

      const wrappedResolve = (result: SdkPermissionResult) => {
        clearTimeout(timer);
        resolve(result);
      };

      this.pendingPermissions.set(requestId, {
        sessionId,
        toolName,
        plan,
        options: cardOptions,
        resolve: wrappedResolve,
      });

      // ExitPlanMode is answered through the plan approval card; skip the generic
      // permission card to avoid a duplicate prompt next to it.
      if (plan) {
        this.callbacks.onPlanCard(sessionId, requestId);
      } else {
        this.callbacks.onPermissionCard({
          sessionId,
          toolName,
          toolUseId: requestId,
          toolInput,
          title: options.title,
          description: options.description,
          options: cardOptions,
          agentId,
          isSubAgent,
          agentLabel: isSubAgent ? ctx.agentLabel : undefined,
        });
      }

      // Notify so the phone immediately shows a visible "waiting_permission" state — a buried
      // prompt is exactly how a turn deadlocks.
      this.callbacks.log(`[perm] WAITING ON APPROVAL: ${toolName} (${requestId})${isSubAgent ? ` [subagent ${agentId}]` : ''} in ${sessionId}`);
      this.callbacks.onPendingChanged?.(sessionId);
    });
  }

  /** Answer a pending permission card with one of its options. Returns false
   *  when nothing is pending under `requestId` or the option is not offered. */
  resolvePermission(requestId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.plan) {
      this.callbacks.log(`[perm] No pending permission for ${requestId}`);
      return false;
    }
    const option = pending.options.find((o) => o.id === optionId);
    if (!option) {
      this.callbacks.log(`[perm] Option '${optionId}' is not offered for ${requestId}`);
      return false;
    }

    this.pendingPermissions.delete(requestId);
    if (option.kind === 'allow_once' || option.kind === 'allow_always') {
      const result: SdkPermissionResult = { behavior: 'allow', updatedInput: {} };
      // "Always allow" → persist as a project-scoped allow rule so it survives across sessions.
      // Uses projectSettings (not session) because "Always Allow" implies persistence.
      if (option.kind === 'allow_always') {
        const rule: SdkPermissionUpdate = {
          type: 'addRules',
          rules: [{ toolName: pending.toolName }],
          behavior: 'allow',
          destination: 'projectSettings',
        };
        result.updatedPermissions = [rule];
      }
      pending.resolve(result);
      this.callbacks.onResolved(pending.sessionId, requestId, option.kind === 'allow_always' ? 'Always allowed' : 'Allowed');
    } else {
      pending.resolve({ behavior: 'deny', message: 'User denied' });
      this.callbacks.onResolved(pending.sessionId, requestId, 'Denied');
    }
    // Permission answered — notify so the phone clears the "waiting_permission" state.
    this.callbacks.onPendingChanged?.(pending.sessionId);
    return true;
  }

  /**
   * Answer a pending plan approval: approve (the plan runs) or keep planning
   * (ExitPlanMode is denied and the agent stays in plan mode). Returns false
   * when no plan approval is pending under `requestId`.
   */
  resolvePlanApproval(requestId: string, approve: boolean, summary: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || !pending.plan) {
      this.callbacks.log(`[perm] No pending plan approval for ${requestId}`);
      return false;
    }
    this.pendingPermissions.delete(requestId);
    pending.resolve(
      approve
        ? { behavior: 'allow', updatedInput: {} }
        : { behavior: 'deny', message: 'The user wants to keep planning — revise the plan with their feedback.' },
    );
    this.callbacks.onResolved(pending.sessionId, requestId, summary);
    this.callbacks.onPendingChanged?.(pending.sessionId);
    return true;
  }

  /**
   * Answer question `index` of the ask `requestId`. The ask resolves (and its
   * card closes) once every question has an answer. Returns false when no such
   * question is pending in this session.
   */
  answerQuestion(sessionId: string, requestId: string, index: number, answer: string): boolean {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending || pending.sessionId !== sessionId || index < 0 || index >= pending.questions.length) {
      this.callbacks.log(`[perm] No pending question ${requestId}#${index} in ${sessionId}`);
      return false;
    }
    this.recordAnswer(requestId, pending, index, answer);
    return true;
  }

  /**
   * Answer the first unanswered question of the session's active ask with
   * free text — plain input typed while a question blocks the turn can only be
   * its answer. Returns false when no question is pending.
   */
  answerActiveQuestion(sessionId: string, text: string): boolean {
    const active = this.activeQuestion(sessionId);
    if (!active) {
      this.callbacks.log(`[perm] No pending question for answer in ${sessionId}`);
      return false;
    }
    const { requestId, pending } = active;
    const index = pending.questions.findIndex((_, i) => !pending.answers.has(i));
    this.recordAnswer(requestId, pending, Math.max(0, index), text);
    return true;
  }

  /** The labels of a question's options at `indices` — how a chosen option
   *  becomes an answer string. Null when the question or an index is unknown. */
  optionLabels(requestId: string, index: number, indices: readonly number[]): string | null {
    const options = this.pendingQuestions.get(requestId)?.questions[index]?.options ?? [];
    const labels: string[] = [];
    for (const i of indices) {
      const label = options[i]?.label;
      if (label === undefined) return null;
      labels.push(label);
    }
    return labels.length > 0 ? labels.join(', ') : null;
  }

  /** True while any AskUserQuestion group is pending for the session (input should route here). */
  hasPendingQuestions(sessionId: string): boolean {
    return this.activeQuestion(sessionId) !== null;
  }

  /** True while any permission or plan approval is pending for the session. */
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
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve({ behavior: 'deny', message: reason });
      this.callbacks.onResolved(sessionId, requestId, reason);
      changed = true;
    }
    for (const [requestId, pending] of this.pendingQuestions) {
      if (pending.sessionId !== sessionId) continue;
      this.removeQuestion(requestId);
      pending.resolve({ behavior: 'deny', message: reason });
      this.callbacks.onResolved(sessionId, requestId, reason);
      changed = true;
    }
    if (changed) this.callbacks.onPendingChanged?.(sessionId);
  }

  // --- Internal ---

  /** Most-recently-asked still-pending question group for a session (matches the phone's active card). */
  private activeQuestion(sessionId: string): { requestId: string; pending: PendingQuestion } | null {
    const order = this.questionOrder.get(sessionId);
    if (!order) return null;
    for (let i = order.length - 1; i >= 0; i--) {
      const requestId = order[i];
      if (!requestId) continue;
      const pending = this.pendingQuestions.get(requestId);
      if (pending) return { requestId, pending };
    }
    return null;
  }

  private removeQuestion(requestId: string): void {
    const pending = this.pendingQuestions.get(requestId);
    this.pendingQuestions.delete(requestId);
    if (!pending) return;
    const order = this.questionOrder.get(pending.sessionId);
    if (order) {
      const i = order.indexOf(requestId);
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
  private recordAnswer(requestId: string, pending: PendingQuestion, index: number, answer: string): void {
    pending.answers.set(index, answer);
    if (pending.answers.size < pending.questions.length) return;

    // All questions answered — resolve the canUseTool promise.
    this.removeQuestion(requestId);
    const answers: Record<string, string> = {};
    const summary: string[] = [];
    pending.questions.forEach((q, i) => {
      const a = pending.answers.get(i) ?? '';
      answers[q.question] = a;
      summary.push(a);
    });
    // Echo the original input (questions/options/multiSelect) and add the collected answers.
    // The SDK fills AskUserQuestionInput.answers from here.
    pending.resolve({ behavior: 'allow', updatedInput: { ...pending.input, answers } });
    this.callbacks.onResolved(pending.sessionId, requestId, summary.join(' · '));

    // Notify so the phone clears the "waiting_question" state now that the group is answered.
    this.callbacks.onPendingChanged?.(pending.sessionId);
  }
}
