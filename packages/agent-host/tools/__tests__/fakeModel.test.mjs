/**
 * Which tool the fake model's `/tool` calls, given the tools a request
 * offers. The lists are the DeepSeek Harness's own (0.2.2-rc.1, read from a
 * `--dump` of a live session): its shell tool is `pwsh` on Windows and `bash`
 * elsewhere, and `ask_user_question` comes first either way — so a shell
 * name this server does not know falls back to the question tool, whose
 * required `questions` the call does not carry.
 */
import { describe, expect, it } from 'vitest';
import { planReply } from '../fake-model.mjs';

const HARNESS_TOOLS = (shell) =>
  ['ask_user_question', 'create_goal', 'edit', 'glob', 'grep', shell, 'read', 'write'].map((name) => ({
    name,
    input_schema: { type: 'object' },
  }));

const toolTurn = (shell) => ({
  stream: true,
  tools: HARNESS_TOOLS(shell),
  messages: [{ role: 'user', content: [{ type: 'text', text: '/tool' }] }],
});

describe('/tool', () => {
  for (const shell of ['bash', 'pwsh']) {
    it(`calls the Harness's ${shell} with the command and description it requires`, () => {
      const reply = planReply(toolTurn(shell), 'anthropic');
      expect(reply).toMatchObject({ kind: 'tool', name: shell });
      // Both are required and refused when empty.
      expect(reply.args).toEqual({ command: expect.stringMatching(/\S/), description: expect.stringMatching(/\S/) });
    });
  }
});
