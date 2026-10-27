/**
 * The ACP fake stands in for two real agents, and a fake is only useful for
 * as long as its shapes are the agent's. These tests drive it with the
 * driver's own ACP client and assert what the pinned builds were probed
 * answering: the initialize capabilities, the session lifecycle each one
 * serves, how a tool call names its tool, what an unoffered config value is
 * refused with, the permission ask, and the end of a turn.
 *
 * The expectations are the probe's observations (the comment on fakeAgent.ts
 * says how they were taken). A bump of either agent should be re-probed
 * before these are touched.
 */
import { describe, expect, it } from 'vitest';
import { AcpClient, AcpRequestError } from '../acp';
import { FakeAgent, type AcpProfile } from './fakeAgent';

/** An ACP client on one fake's stdio, as a driver's runtime would open it. */
function connect(profile: AcpProfile): { agent: FakeAgent; client: AcpClient } {
  const agent = new FakeAgent(profile);
  const client = new AcpClient({ stdin: agent.child.stdin, stdout: agent.child.stdout, log: () => {}, tag: 'profile' });
  return { agent, client };
}

async function initialize(profile: AcpProfile) {
  const { agent, client } = connect(profile);
  const response = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  return { agent, client, response };
}

const MODEL_OPTION = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'm1',
  options: [{ value: 'm1', name: 'M1' }],
};

const EFFORT_OPTION = {
  id: 'reasoning_effort',
  name: 'Reasoning effort',
  category: 'thought_level',
  type: 'select',
  currentValue: 'high',
  options: [
    { value: 'off', name: 'Off' },
    { value: 'high', name: 'High' },
  ],
};

/** The refusal an agent answers a request with, as the client raises it. */
async function expectRefusal(promise: Promise<unknown>): Promise<AcpRequestError> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AcpRequestError);
  return failure as AcpRequestError;
}

describe('initialize, as each pinned agent answers it', () => {
  it('the DeepSeek Harness advertises close, list and resume, and no load', async () => {
    const { response } = await initialize('deepseek');
    expect(response.agentInfo).toEqual({ name: 'deepseek-harness-acp', version: '0.0.1' });
    expect(response.agentCapabilities).toEqual({
      mcpCapabilities: { http: true },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    });
    expect(response.authMethods).toEqual([]);
  });

  it('Qwen Code advertises list and resume, load (not close), and no auth prompt', async () => {
    const { response } = await initialize('qwen');
    expect(response.agentInfo).toEqual({ name: 'qwen-code', title: 'Qwen Code', version: '0.26.1' });
    expect(response.agentCapabilities).toMatchObject({
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpCapabilities: { sse: true, http: true },
      sessionCapabilities: { list: {}, resume: {} },
    });
    // `session/close` is the one lifecycle method it does not have.
    expect(response.agentCapabilities?.sessionCapabilities).not.toHaveProperty('close');
  });
});

describe('the session lifecycle each agent serves', () => {
  it('the harness closes a session, then calls the same id unknown; it lists only closed ones', async () => {
    const { agent, client } = await initialize('deepseek');
    const created = await client.request('session/new', { cwd: '/w', mcpServers: [] });
    // Nothing is listed while the conversation is live.
    expect(await client.request('session/list', { cwd: '/w' })).toEqual({ sessions: [] });

    expect(await client.request('session/close', { sessionId: created.sessionId })).toEqual({});
    expect(agent.closed).toEqual([created.sessionId]);
    expect(await client.request('session/list', { cwd: '/w' })).toMatchObject({
      sessions: [{ sessionId: created.sessionId, cwd: '/w' }],
    });
    const again = await expectRefusal(client.request('session/close', { sessionId: created.sessionId }));
    expect(again).toMatchObject({ code: -32602, message: `Invalid params: unknown session: ${created.sessionId}` });

    // It has no session/load.
    const load = await expectRefusal(client.request('session/load', { sessionId: created.sessionId, cwd: '/w', mcpServers: [] }));
    expect(load).toMatchObject({ code: -32601, message: '"Method not found": session/load' });
  });

  it('Qwen Code refuses session/close and lists live sessions for the cwd it is given', async () => {
    const { client } = await initialize('qwen');
    const created = await client.request('session/new', { cwd: '/w', mcpServers: [] });

    // It lists the conversation while it is live — but only for a cwd.
    expect(await client.request('session/list', { cwd: '/w' })).toMatchObject({
      sessions: [{ sessionId: created.sessionId, cwd: '/w' }],
    });
    expect(await client.request('session/list', {})).toEqual({ sessions: [] });

    const close = await expectRefusal(client.request('session/close', { sessionId: created.sessionId }));
    expect(close).toMatchObject({ code: -32601, message: '"Method not found": session/close' });
  });
});

describe('config options', () => {
  it('the harness refuses an unoffered model and an unknown config id', async () => {
    const { agent, client } = await initialize('deepseek');
    agent.options = [MODEL_OPTION, EFFORT_OPTION];
    const created = await client.request('session/new', { cwd: '/w', mcpServers: [] });

    const accepted = await client.request('session/set_config_option', { sessionId: created.sessionId, configId: 'model', value: 'm1' });
    expect(accepted.configOptions?.[0]).toMatchObject({ id: 'model', currentValue: 'm1' });
    const model = await expectRefusal(
      client.request('session/set_config_option', { sessionId: created.sessionId, configId: 'model', value: 'nope' }),
    );
    expect(model).toMatchObject({ code: -32602, message: 'Invalid params: unknown model option: nope' });
    const effort = await expectRefusal(
      client.request('session/set_config_option', { sessionId: created.sessionId, configId: 'reasoning_effort', value: 'turbo' }),
    );
    expect(effort).toMatchObject({ code: -32602, message: 'Invalid params: unknown reasoning effort for m1: turbo' });
    const id = await expectRefusal(
      client.request('session/set_config_option', { sessionId: created.sessionId, configId: 'nope', value: 'x' }),
    );
    expect(id).toMatchObject({ code: -32602, message: 'Invalid params: unknown session config option: nope' });
  });

  it('Qwen Code refuses an unoffered model and effort with its own wording', async () => {
    const { agent, client } = await initialize('qwen');
    agent.options = [MODEL_OPTION, EFFORT_OPTION];
    const created = await client.request('session/new', { cwd: '/w', mcpServers: [] });

    const model = await expectRefusal(
      client.request('session/set_config_option', { sessionId: created.sessionId, configId: 'model', value: 'nope' }),
    );
    expect(model).toMatchObject({ code: -32602, message: "Invalid params: Model 'nope' not found for authType 'openai'" });
    const effort = await expectRefusal(
      client.request('session/set_config_option', { sessionId: created.sessionId, configId: 'reasoning_effort', value: 'turbo' }),
    );
    expect(effort).toMatchObject({
      code: -32602,
      message: 'Invalid params: Unknown reasoning effort: turbo. Choose one of: default, off, high',
    });
    const id = await expectRefusal(
      client.request('session/set_config_option', { sessionId: created.sessionId, configId: 'nope', value: 'x' }),
    );
    expect(id).toMatchObject({ code: -32602, message: 'Invalid params: Unsupported configId: nope' });
  });
});

describe('a tool call names its tool the way each agent does', () => {
  it('the harness puts the name in title and takes no _meta', async () => {
    const { agent, client } = await initialize('deepseek');
    const updates: Array<Record<string, unknown>> = [];
    client.on('session/update', (notification) => updates.push(notification.update as Record<string, unknown>));

    agent.toolCall('s1', 'c1', 'bash', { command: 'ls' });
    // A permission round trip proves the notification before it was read.
    client.onRequest('session/request_permission', async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } as const }));
    await agent.askPermission('s1', 'c1');

    expect(updates).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command: 'ls' } },
    ]);
    expect(updates[0]).not.toHaveProperty('name');
    expect(updates[0]).not.toHaveProperty('_meta');
  });

  it('Qwen Code keeps the name in _meta.toolName and sends the arguments in a second update', async () => {
    const { agent, client } = await initialize('qwen');
    const updates: Array<Record<string, unknown>> = [];
    client.on('session/update', (notification) => updates.push(notification.update as Record<string, unknown>));

    agent.toolCall('s1', 'c1', 'run_shell_command', { command: 'ls' });
    client.onRequest('session/request_permission', async () => ({ outcome: { outcome: 'selected', optionId: 'proceed_once' } as const }));
    await agent.askPermission('s1', 'c1');

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      status: 'pending',
      title: 'Shell',
      kind: 'execute',
      rawInput: {},
      _meta: { toolName: 'run_shell_command' },
    });
    expect(updates[0]).not.toHaveProperty('name');
    expect(updates[1]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'in_progress',
      rawInput: { command: 'ls' },
      _meta: { toolName: 'run_shell_command' },
    });
  });
});

describe('the permission ask', () => {
  it('the harness names only the tool call and offers Allow once or Reject', async () => {
    const { agent: harness, client: peer } = connect('deepseek');
    let asked: Record<string, unknown> | undefined;
    peer.onRequest('session/request_permission', async (request) => {
      asked = request as Record<string, unknown>;
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } as const };
    });

    const outcome = await harness.askPermission('s1', 'c1');
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });
    expect(asked).toEqual({
      sessionId: 's1',
      toolCall: { toolCallId: 'c1' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });
  });

  it('Qwen Code repeats the call and offers allow-always choices beside Allow and Reject', async () => {
    const { agent, client } = await initialize('qwen');
    let asked: Record<string, unknown> | undefined;
    client.onRequest('session/request_permission', async (request) => {
      asked = request as Record<string, unknown>;
      return { outcome: { outcome: 'selected', optionId: 'proceed_once' } as const };
    });

    agent.toolCall('s1', 'c1', 'run_shell_command', { command: 'echo hi' });
    const outcome = await agent.askPermission('s1', 'c1');
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'proceed_once' });

    const options = (asked as { options: Array<{ optionId: string; kind: string }> }).options;
    expect(options.map((option) => option.optionId)).toEqual([
      'proceed_always_project',
      'proceed_always_user',
      'proceed_once',
      'cancel',
    ]);
    expect(options.map((option) => option.kind)).toEqual(['allow_always', 'allow_always', 'allow_once', 'reject_once']);
    expect(asked).toMatchObject({
      toolCall: {
        toolCallId: 'c1',
        status: 'pending',
        title: 'Shell',
        kind: 'execute',
        rawInput: { command: 'echo hi' },
        _meta: { toolName: 'run_shell_command' },
      },
    });
  });
});

describe('the end of a turn', () => {
  it('the harness answers a stop reason alone; Qwen Code adds its branch point', async () => {
    const deepseek = await initialize('deepseek');
    const deepseekSession = await deepseek.client.request('session/new', { cwd: '/w', mcpServers: [] });
    expect(
      await deepseek.client.request('session/prompt', { sessionId: deepseekSession.sessionId, prompt: [{ type: 'text', text: 'hi' }] }),
    ).toEqual({ stopReason: 'end_turn' });

    const qwen = await initialize('qwen');
    const qwenSession = await qwen.client.request('session/new', { cwd: '/w', mcpServers: [] });
    const result = await qwen.client.request('session/prompt', { sessionId: qwenSession.sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(result).toMatchObject({
      stopReason: 'end_turn',
      _meta: { 'qwen.branchPoint': { assistantRecordUuid: expect.any(String), checkpointUuid: expect.any(String) } },
    });
  });
});
