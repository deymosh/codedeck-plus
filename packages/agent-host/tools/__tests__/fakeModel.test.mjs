/**
 * Which tool the fake model's `/tool` calls, given the tools a request
 * offers. The lists are the DeepSeek Harness's own (0.2.2-rc.1, read from a
 * `--dump` of a live session): its shell tool is `pwsh` on Windows and `bash`
 * elsewhere, and `ask_user_question` comes first either way — so a shell
 * name this server does not know falls back to the question tool, whose
 * required `questions` the call does not carry.
 */
import { describe, expect, it } from 'vitest';
import { planReply, startFakeModel } from '../fake-model.mjs';

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

describe('/write', () => {
  it("writes the named file with Pi's write, a \\n in the content a line break", () => {
    const reply = planReply(
      {
        stream: true,
        tools: ['read', 'bash', 'edit', 'write'].map((name) => ({ name, input_schema: { type: 'object' } })),
        messages: [{ role: 'user', content: [{ type: 'text', text: '/write src/a.ts const x = 1;\\nexport {};' }] }],
      },
      'anthropic',
    );
    expect(reply).toMatchObject({ kind: 'tool', name: 'write', args: { path: 'src/a.ts', content: 'const x = 1;\nexport {};' } });
  });
});

describe('a required key', () => {
  it('answers a model request only when it carries the key, as a bearer or an x-api-key', async () => {
    const model = await startFakeModel({ key: 'sk-required' });
    try {
      const ask = (headers) =>
        fetch(`${model.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        });
      const missing = await ask({});
      expect(missing.status).toBe(401);
      expect(await missing.text()).not.toContain('sk-');
      expect((await ask({ authorization: 'Bearer sk-other' })).status).toBe(401);
      expect((await ask({ authorization: 'Bearer sk-required' })).status).toBe(200);
      expect((await ask({ 'x-api-key': 'sk-required' })).status).toBe(200);
    } finally {
      await model.close();
    }
  });
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
