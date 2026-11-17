/**
 * What the CodeDeck Pi extension and the driver agree on. The extension runs
 * inside Pi's process and reaches the driver only through Pi's RPC records,
 * so every name both sides match on is defined here, once, and bundled into
 * both.
 *
 * Three paths carry what the tools need:
 *
 * - **Requests** that wait for an answer (a question, a plan to approve, a
 *   sub-agent's tool call to allow): an extension `editor` dialog whose title
 *   is `PI_REQUEST_PREFIX` + the operation and whose prefill is the request
 *   as JSON. The driver answers with the reply as JSON, or cancels.
 * - **Progress** of a running tool (a sub-agent's work): the tool's
 *   `onUpdate`, which Pi reports as `tool_execution_update` with the
 *   update's `details`.
 * - **Events** outside any tool call (a background task ending after the
 *   turn): `pi.appendEntry(PI_ENTRY_TYPE, …)`, which Pi reports as
 *   `entry_appended`.
 */

/** The prefix the `tool_call` dialog's title carries, before the call's id.
 *  The driver matches on it to tell CodeDeck's gate from another extension's
 *  own dialog. */
export const PI_PERMISSION_PREFIX = 'codedeck-permission:';

/** The prefix of a request dialog's title, before its operation. */
export const PI_REQUEST_PREFIX = 'codedeck-request:';

/** The custom entry type of the extension's out-of-turn events. */
export const PI_ENTRY_TYPE = 'codedeck';

/** The tools the extension adds. */
export const PI_TOOL = {
  todo: 'todo',
  ask: 'ask',
  exitPlan: 'exit_plan',
  task: 'task',
  bashBackground: 'bash_background',
  taskOutput: 'task_output',
  taskStop: 'task_stop',
  webFetch: 'web_fetch',
  memory: 'memory',
} as const;

/** One question of an `ask` request, as the model writes it. */
export interface PiQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** Who a sub-agent is, on everything it does. */
export interface PiSubagent {
  /** The kind it runs as (`explore`, `general`). */
  label: string;
  /** The parent's `task` call it works under. */
  parentCallId: string;
}

/** The requests the extension sends the driver, by operation. */
export type PiRequest =
  /** Ask the user; the reply is `{ answers }`, one per question. */
  | { op: 'ask'; callId: string; questions: PiQuestion[] }
  /** Present a finished plan; the reply is `{ approved, mode?, feedback? }`. */
  | { op: 'plan'; callId: string; plan: string }
  /** A sub-agent wants to run a tool; the reply is `{ allow }`. */
  | { op: 'permission'; subagent: PiSubagent; callId: string; toolName: string; input: Record<string, unknown> }
  /** What the session is set to now; the reply is `{ mode }`. */
  | { op: 'session' };

/** The answer to one question: the labels chosen, or the text typed. */
export type PiAnswer = { selected: string[] } | { text: string } | { skipped: true };

export interface PiAskReply {
  answers: PiAnswer[];
}

export interface PiPlanReply {
  approved: boolean;
  /** The mode the session switched to, when approved. */
  mode?: string;
  /** What the user wants changed, when they sent the plan back. */
  feedback?: string;
}

export interface PiPermissionReply {
  allow: boolean;
}

export interface PiSessionReply {
  mode: string;
}

/** The driver's session modes the extension acts on. */
export const PI_PLAN_MODE = 'plan';
