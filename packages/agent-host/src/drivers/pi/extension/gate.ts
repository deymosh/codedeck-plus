/**
 * The permission gate: every tool call Pi is about to run is held until the
 * driver answers.
 *
 * Pi has no permission system of its own. Its extension UI `select` is a
 * dialog the RPC client answers with `extension_ui_response`, and a
 * `tool_call` handler may wait on it, so the gate asks the driver through
 * that dialog. The title carries the call's id (`PI_PERMISSION_PREFIX` + id)
 * so the driver can build the card from the `tool_execution_start` facts it
 * already has. Anything but "allow" blocks the call with a fixed reason. The
 * driver decides whether to ask the phone at all: `yolo`, a read-only tool
 * and "allow for this session" are answered "allow" without a card.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PI_PERMISSION_PREFIX } from './protocol';

/** The reason a denied call's result carries. */
export const DENIED_REASON = 'Denied by the user';

export function installGate(pi: Pick<ExtensionAPI, 'on'>): void {
  pi.on('tool_call', async (event, ctx) => {
    const choice = await ctx.ui.select(PI_PERMISSION_PREFIX + event.toolCallId, ['allow', 'deny']);
    if (choice !== 'allow') return { block: true, reason: DENIED_REASON };
    return undefined;
  });
}
