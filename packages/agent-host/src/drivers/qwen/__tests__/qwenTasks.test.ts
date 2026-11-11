/**
 * Qwen Code's background-task updates as `background_task` entries, on frames
 * recorded from Qwen Code 0.27.1 over ACP (a shell cancelled with
 * `qwen/control/session/task/cancel`). The live round trip is in
 * qwenFakeModel.test.ts; these are the cases it cannot stage on demand.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { QwenBackgroundTasks } from '../tasks';

const backgroundTask = { taskId: 'bg_98782ba8', sourceTurnId: 's########1', status: 'cancelled', kind: 'shell', commandLabel: 'sleep 20; echo late' };
const text = 'Background shell "sleep 20; echo late" was cancelled.';

const message = (source: string): SessionUpdate =>
  ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    _meta: { source, qwenDiscreteMessage: true, backgroundTask },
  }) as unknown as SessionUpdate;

describe('Qwen Code background tasks', () => {
  it('ends a task this session never saw start, named by its command, and drops the repeat', () => {
    // A resumed conversation: the shell started under an earlier process.
    const tasks = new QwenBackgroundTasks();
    const ended = tasks.read(message('background_task_completed'));
    expect(ended.drop).toBe(true);
    expect(ended.entries).toEqual([
      expect.objectContaining({ entryType: 'background_task', taskId: 'bg_98782ba8', kind: 'shell', title: 'sleep 20; echo late', status: 'stopped', summary: text }),
    ]);
    // The same end, repeated as the first message of the turn Qwen Code
    // starts about it, is not said twice.
    expect(tasks.read(message('background_notification'))).toEqual({ entries: [], drop: true });
    // The model's reply to it is the conversation.
    expect(tasks.read(message('background_notification_response'))).toEqual({ entries: [], drop: false });
  });

  it('leaves a foreground shell call alone', () => {
    const tasks = new QwenBackgroundTasks();
    const call = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      rawInput: { command: 'ls' },
      _meta: { toolName: 'run_shell_command' },
      content: [{ type: 'content', content: { type: 'text', text: 'Background shell started.\nid: bg_1\n' } }],
    } as unknown as SessionUpdate;
    expect(tasks.read(call)).toEqual({ entries: [], drop: false });
  });
});
