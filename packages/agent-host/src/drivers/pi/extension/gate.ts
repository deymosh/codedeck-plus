/**
 * The permission gate: every tool call Pi is about to run is held until the
 * driver answers.
 *
 * Pi has no permission system of its own. Its extension UI `select` is a
 * dialog the RPC client answers with `extension_ui_response`, and a
 * `tool_call` handler may wait on it, so the gate asks the driver through
 * that dialog. The title carries the call's id (`PI_PERMISSION_PREFIX` + id)
 * so the driver can build the card from the `tool_execution_start` facts it
 * already has. Only "allow" lets the call run; the other answers block it
 * with the reason the model is given. The driver decides whether to ask the
 * phone at all: `yolo`, a read-only tool and "allow for this session" are
 * answered "allow" without a card, and plan mode refuses whatever could
 * change something.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PI_PERMISSION_PREFIX, PI_TOOL } from './protocol';

/** The driver's answers. */
export const GATE = { allow: 'allow', deny: 'deny', plan: 'plan' } as const;

/** The reason a denied call's result carries. */
export const DENIED_REASON = 'Denied by the user';

/** The reason a call refused in plan mode carries: what the model should do
 *  instead. */
export const PLAN_REASON = `Refused: the session is in plan mode, where nothing may change. Explore read-only, then present the plan with ${PI_TOOL.exitPlan}.`;

export function installGate(pi: Pick<ExtensionAPI, 'on'>): void {
  pi.on('tool_call', async (event, ctx) => {
    const choice = await ctx.ui.select(PI_PERMISSION_PREFIX + event.toolCallId, [GATE.allow, GATE.deny, GATE.plan]);
    if (choice === GATE.allow) return undefined;
    return { block: true, reason: choice === GATE.plan ? PLAN_REASON : DENIED_REASON };
  });
}
