/**
 * Plan mode: the session explores read-only and presents a plan, which the
 * user approves (switching the session to a working mode) or sends back.
 *
 * The mode is the driver's: its gate refuses every call that could change
 * something while the session is in it. The extension asks the driver for the
 * mode as each run starts and, in plan mode, tells the model so; `exit_plan`
 * presents the plan as the phone's plan card.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { request } from './channel';
import { PI_PLAN_MODE, PI_TOOL, type PiPlanReply, type PiSessionReply } from './protocol';

/** What the model is told while the session is in plan mode. */
export const PLAN_MODE_PROMPT = [
  '# Plan mode',
  'The session is in plan mode: explore and think, change nothing. Only read-only tools run',
  '(read, grep, find, ls, read-only shell commands such as git status, git diff, cat); anything',
  'that would write a file, install, or run the project is refused.',
  `When you know what to do, present the plan with \`${PI_TOOL.exitPlan}\`: the steps, the files`,
  'each touches, and how the result will be checked. The user approves it or sends it back with',
  'what to change. Do not start the work before the plan is approved.',
].join('\n');

export function registerPlanMode(pi: Pick<ExtensionAPI, 'registerTool' | 'on'>): void {
  pi.on('before_agent_start', async (event, ctx) => {
    const session = await request<PiSessionReply>(ctx.ui, { op: 'session' });
    if (session?.mode !== PI_PLAN_MODE) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_PROMPT}` };
  });

  pi.registerTool({
    name: PI_TOOL.exitPlan,
    label: 'Present plan',
    description:
      'In plan mode, present the finished plan for the user to approve. Approval switches the session to a ' +
      'working mode; otherwise the reply says what to change.',
    promptSnippet: `${PI_TOOL.exitPlan}: present a plan for approval (plan mode only)`,
    parameters: {
      type: 'object',
      properties: { plan: { type: 'string', description: 'The plan, in Markdown.' } },
      required: ['plan'],
    } as never,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const plan = typeof (params as { plan?: unknown }).plan === 'string' ? (params as { plan: string }).plan.trim() : '';
      if (plan === '') throw new Error('the plan is empty');
      const session = await request<PiSessionReply>(ctx.ui, { op: 'session' });
      if (session?.mode !== PI_PLAN_MODE) {
        return {
          content: [{ type: 'text', text: 'The session is not in plan mode: go ahead with the work.' }],
          details: { approved: true },
        };
      }
      const reply = await request<PiPlanReply>(ctx.ui, { op: 'plan', callId: toolCallId, plan });
      if (!reply) throw new Error('The user did not answer the plan.');
      const text = reply.approved
        ? `The user approved the plan; the session is now in ${reply.mode ?? 'a working'} mode. Carry it out.`
        : `The user sent the plan back${reply.feedback ? `: ${reply.feedback}` : '.'} Revise it and present it again with ${PI_TOOL.exitPlan}.`;
      return { content: [{ type: 'text', text }], details: reply };
    },
  });
}
