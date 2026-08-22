/**
 * FakeSdkFacade smoke test — emit() feeds messages(), records are captured,
 * and the canUseTool callback is reachable for permission-flow tests.
 */
import { describe, it, expect } from 'vitest';
import { isProviderBoundSession } from '@codedeck/core';
import type { SdkMessage, SdkSessionOptions } from '@codedeck/core';
import { FakeSdkFacade } from '../fakeSdk';

const userMsg = (text: string): SdkMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
} as SdkMessage);

const allow = async () => ({ behavior: 'allow' as const, updatedInput: {} });

describe('FakeSdkFacade', () => {
  it('emit() → messages() yields, in order, and ends on end()', async () => {
    const facade = new FakeSdkFacade();
    const handle = facade.createSession({
      sessionId: 's1',
      cwd: '/work',
      permissionMode: 'plan',
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    });

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const msg of handle.messages()) {
        seen.push((msg as { message: { content: string } }).message.content);
      }
    })();

    facade.emit('s1', userMsg('one'));
    facade.emit('s1', userMsg('two'));
    await new Promise((r) => setImmediate(r));
    await handle.end();
    await consumer;

    expect(seen).toEqual(['one', 'two']);
    expect(facade.session('s1').ended).toBe(true);
  });

  it('records inputs, mode/model/effort changes, and interrupts', async () => {
    const facade = new FakeSdkFacade();
    const handle = facade.createSession({
      sessionId: 's1',
      cwd: '/work',
      permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    });

    handle.pushInput('hello');
    await handle.setPermissionMode('acceptEdits');
    await handle.setModel('claude-opus-4-8');
    await handle.setEffort('max');
    await handle.interrupt();

    const s = facade.session('s1');
    expect(s.inputs).toEqual(['hello']);
    expect(s.modes).toEqual(['acceptEdits']);
    expect(s.models).toEqual(['claude-opus-4-8']);
    expect(s.efforts).toEqual(['max']);
    expect(s.interrupts).toBe(1);
  });

  it('exposes the wired canUseTool so tests can drive permission flows', async () => {
    const facade = new FakeSdkFacade();
    const calls: string[] = [];
    facade.createSession({
      sessionId: 's1',
      cwd: '/work',
      permissionMode: 'plan',
      canUseTool: async (toolName) => {
        calls.push(toolName);
        return { behavior: 'deny', message: 'nope' };
      },
    });

    const result = await facade.canUseTool('s1')('Bash', { command: 'ls' }, {
      toolUseID: 'tu1',
      requestId: 'r1',
      signal: new AbortController().signal,
    });
    expect(calls).toEqual(['Bash']);
    expect(result).toEqual({ behavior: 'deny', message: 'nope' });
  });

  it('scripts supportedModels()', async () => {
    const facade = new FakeSdkFacade();
    facade.models = [{ id: 'claude-opus-4-8', label: 'Opus' }];
    await expect(facade.supportedModels()).resolves.toEqual([{ id: 'claude-opus-4-8', label: 'Opus' }]);
  });

  it('supportedModels mirrors the CDX-062 provider guard: only-provider-bound live handles answer []', async () => {
    const OPUS = [{ id: 'claude-opus-4-8', label: 'Opus' }];
    const facade = new FakeSdkFacade();
    facade.models = OPUS;

    // A live handle bound to a custom provider must never answer the Anthropic
    // model list (mirrors RealSdkFacade's guard). CDX-071: the binding is the
    // explicit `providerId` session option, not anything in `env`.
    const bound = facade.createSession({
      sessionId: 'kimi-1',
      cwd: '/work',
      permissionMode: 'plan',
      canUseTool: allow,
      providerId: 'kimi-k3',
      fallbackModel: null,
      env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-x' },
    });
    await expect(facade.supportedModels()).resolves.toEqual([]);

    // An Anthropic handle alongside restores the answer.
    facade.createSession({ sessionId: 'a-1', cwd: '/work', permissionMode: 'plan', canUseTool: allow });
    await expect(facade.supportedModels()).resolves.toEqual(OPUS);

    // An ENDED provider handle no longer suppresses anything.
    facade.session('a-1').ended = true;
    await bound.end();
    await expect(facade.supportedModels()).resolves.toEqual(OPUS);
  });

  it('CDX-071: the fake and the real facade agree on which sessions are provider-bound', async () => {
    // The real facade decides `RealSdkSessionHandle.customProvider` with
    // exactly one call — `isProviderBoundSession(opts)` — and then filters
    // those handles out of supportedModels(). The fake cannot spawn a
    // subprocess, so agreement is pinned at that shared predicate: for each
    // options shape below, the fake's answer with ONE live handle of that shape
    // must be [] iff the real facade's rule calls it provider-bound.
    const OPUS = [{ id: 'claude-opus-4-8', label: 'Opus' }];

    /** The documented LLM-gateway operator shell — the CDX-022 regression bed:
     *  every session on such a machine inherits these, provider-bound or not. */
    const GATEWAY_ENV = {
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://llm-gateway.corp.example/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-gateway',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Tenant: acme',
    };

    const cases: Array<{ what: string; opts: Partial<SdkSessionOptions> }> = [
      { what: 'plain Anthropic session, clean shell', opts: {} },
      // The one that mattered: gateway env alone must NOT mark it bound.
      { what: 'plain Anthropic session on a gateway-configured operator shell', opts: { env: GATEWAY_ENV } },
      { what: 'explicit provider binding', opts: { providerId: 'kimi-k3' } },
      { what: 'provider binding via the fallbackModel tri-state', opts: { fallbackModel: null } },
      { what: 'both provider signals, gateway shell underneath', opts: { providerId: 'kimi-k3', fallbackModel: null, env: GATEWAY_ENV } },
      { what: 'explicit fallback model on a gateway shell', opts: { fallbackModel: 'claude-sonnet-4-6', env: GATEWAY_ENV } },
    ];

    for (const { what, opts } of cases) {
      const facade = new FakeSdkFacade();
      facade.models = OPUS;
      facade.createSession({
        sessionId: 's1',
        cwd: '/work',
        permissionMode: 'plan',
        canUseTool: allow,
        ...opts,
      });
      const realSaysBound = isProviderBoundSession(facade.session('s1').options);
      const fakeSaysBound = (await facade.supportedModels()).length === 0;
      expect(`${what}: ${fakeSaysBound}`).toBe(`${what}: ${realSaysBound}`);
    }

    // And the headline: the gateway case is bound in NEITHER, so the phone's
    // model list survives on an LLM-gateway machine.
    expect(isProviderBoundSession({ fallbackModel: undefined })).toBe(false);
  });
});
