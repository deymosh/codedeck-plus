/**
 * The OpenCode session's modes and the permission rules each one runs
 * under. A mode names both the agent the session runs (the plan agent in
 * Plan mode, the session's persona everywhere else) and whether a tool call
 * reaches the phone.
 */
import type { PermissionRule } from '@opencode/client';
import { PERMISSION_ALLOW_ALWAYS } from '../../sdk/tools';
import type { PermissionOption } from '../../sdk/types';

/** `ask` sends every permission OpenCode asks for to the phone; `default`
 *  (the auto-approve mode every agent shares) allows them all; `plan` runs
 *  OpenCode's own plan agent, which may not edit, asking like `ask`. */
export const AUTO_APPROVE_MODE = 'default';
export const DEFAULT_MODE = 'ask';
export const PLAN_MODE = 'plan';
export const OPENCODE_MODES = [
  { id: DEFAULT_MODE, label: 'Ask', description: 'Ask before each tool call' },
  { id: PLAN_MODE, label: 'Plan', description: 'Explore and plan without editing; switch to Ask or YOLO to build it' },
  { id: AUTO_APPROVE_MODE, label: 'YOLO', description: 'Run every tool without asking' },
];
/** The OpenCode agent the plan mode runs. In any other mode a prompt names
 *  none, so OpenCode uses its default agent (`build`, or the operator's). */
export const PLAN_AGENT = 'plan';
/** The agent every other mode runs. */
export const BUILD_AGENT = 'build';

/**
 * The permission rules a session runs under, from its mode and the rules of
 * the agent it runs.
 *
 * V2's base policy ALLOWS every tool in the project: left alone, a session
 * would never ask, and the phone's approval card would never appear. The ask
 * modes therefore state the rule that makes OpenCode ask — the last matching
 * rule wins, and `*`/`*` matches everything — while the auto-approve mode
 * states the allow it already had, so a mode switch always lands on an
 * explicit rule rather than on whatever the operator configured.
 *
 * The session's rules are matched after the agent's own, so that catch-all
 * alone would also override what the agent forbids (the plan agent's
 * `edit` deny, a custom agent's `shell` deny). The agent's rules therefore
 * follow it again, in their order: a deny stays a deny, and every other
 * effect becomes the mode's — the mode decides whether a call asks, the
 * agent what it may never do.
 */
export function permissionRules(mode: string, agentRules: readonly PermissionRule[] = []): PermissionRule[] {
  const effect = mode === AUTO_APPROVE_MODE ? 'allow' : 'ask';
  return [
    { action: '*', resource: '*', effect },
    ...agentRules.map((rule): PermissionRule => ({ action: rule.action, resource: rule.resource, effect: rule.effect === 'deny' ? rule.effect : effect })),
  ];
}

/** OpenCode's "always": it saves a rule for the project that every later
 *  session obeys, across server restarts, until it is removed. The rule is
 *  the pattern OpenCode offers with the ask (`echo *` for `echo hi`), often
 *  wider than the call on the card, so the label names it. */
export function allowInProject(save: readonly string[]): PermissionOption {
  const what = save.map((pattern) => `"${pattern}"`).join(', ');
  return { ...PERMISSION_ALLOW_ALWAYS, label: `Always allow ${what} in this project` };
}
