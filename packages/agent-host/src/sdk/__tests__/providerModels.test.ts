/**
 * Reading the models an endpoint serves — a provider's own API or a gateway
 * in front of several — from its `/v1/models`.
 */
import { describe, expect, it, vi } from 'vitest';
import { fetchProviderModels, MAX_ENDPOINT_MODELS, parseProviderModels, providerModelsUrl } from '../providerModels';

const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

/** An endpoint answering with `body`. */
const answering = (body: unknown, status = 200) =>
  vi.fn(async (_url: string, _headers: Record<string, string>) => ({
    status,
    text: typeof body === 'string' ? body : JSON.stringify(body),
  }));

describe('providerModelsUrl', () => {
  it('lists under /v1 of the root, unless the root already ends in it', () => {
    expect(providerModelsUrl('http://gateway.example:3458')).toBe('http://gateway.example:3458/v1/models');
    expect(providerModelsUrl('http://gateway.example:3458/')).toBe('http://gateway.example:3458/v1/models');
    expect(providerModelsUrl('https://openrouter.ai/api')).toBe('https://openrouter.ai/api/v1/models');
    expect(providerModelsUrl('https://gateway.example/v1')).toBe('https://gateway.example/v1/models');
  });
});

describe('parseProviderModels', () => {
  it('reads the shapes endpoints answer with, keeping what says something', () => {
    expect(parseProviderModels({ data: [{ id: 'kimi-k2' }, { id: 'glm-4.6', context_length: 200_000 }] })).toEqual([
      { id: 'kimi-k2' },
      { id: 'glm-4.6', contextWindow: 200_000 },
    ]);
    expect(parseProviderModels(['a', 'b'])).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(parseProviderModels({ models: [{ id: 'x', name: 'X' }] })).toEqual([{ id: 'x', label: 'X' }]);
    // A name that only repeats the id says nothing.
    expect(parseProviderModels({ data: [{ id: 'x', name: 'x' }] })).toEqual([{ id: 'x' }]);
  });

  it('drops duplicates, blanks and anything that is not a model', () => {
    expect(parseProviderModels({ data: [{ id: 'a' }, { id: 'a' }, { id: '  ' }, { no: 'id' }, 7] })).toEqual([{ id: 'a' }]);
    expect(parseProviderModels({ error: 'nope' })).toEqual([]);
    expect(parseProviderModels('not a list')).toEqual([]);
    expect(parseProviderModels(null)).toEqual([]);
  });

  it('keeps a routed id whole and names its upstream as the provider', () => {
    expect(
      parseProviderModels({
        data: [
          { id: 'Claude Code API/claude-sonnet-5', display_name: 'Claude Sonnet 5' },
          { id: 'Z.ai (Global) - Coding Plan/glm-5.2', display_name: 'Z.ai (Global) - Coding Plan/GLM-5.2' },
          { id: 'deepseek/deepseek-chat' },
        ],
      }),
    ).toEqual([
      { id: 'Claude Code API/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Claude Code API' },
      { id: 'Z.ai (Global) - Coding Plan/glm-5.2', label: 'GLM-5.2', provider: 'Z.ai (Global) - Coding Plan' },
      { id: 'deepseek/deepseek-chat', provider: 'deepseek' },
    ]);
  });

  it("decodes claude-code-router's ids for Claude Code and reads what it says about context", () => {
    expect(
      parseProviderModels({
        data: [
          {
            id: `anthropic/claude-ccr-h${hex('Z.ai (Global) - Coding Plan/glm-5.3-flash')}[1m]`,
            display_name: 'Z.ai (Global) - Coding Plan/GLM-5.3-Flash (1M context)',
            max_input_tokens: 1_310_720,
            capabilities: { context_window: { max_input_tokens: 1_310_720, supports_1m_context: true } },
          },
          {
            id: `anthropic/claude-ccr-h${hex('Golem/local-model')}`,
            display_name: 'Golem/local-model',
            // A size the router does not know.
            max_input_tokens: 0,
          },
        ],
      }),
    ).toEqual([
      {
        id: 'Z.ai (Global) - Coding Plan/glm-5.3-flash',
        label: 'GLM-5.3-Flash (1M context)',
        provider: 'Z.ai (Global) - Coding Plan',
        contextWindow: 1_310_720,
        oneMillionContext: true,
      },
      { id: 'Golem/local-model', label: 'local-model', provider: 'Golem' },
    ]);
  });

  it('lists a model once when it comes with and without the [1m] marker', () => {
    expect(parseProviderModels({ data: [{ id: 'claude-opus-5' }, { id: 'claude-opus-5[1m]' }] })).toEqual([
      { id: 'claude-opus-5', oneMillionContext: true },
    ]);
  });

  it('keeps a phone-sized list', () => {
    const many = Array.from({ length: MAX_ENDPOINT_MODELS + 5 }, (_, i) => ({ id: `m${i}` }));
    expect(parseProviderModels({ data: many })).toHaveLength(MAX_ENDPOINT_MODELS);
  });
});

describe('fetchProviderModels', () => {
  it('asks with the token and the extra headers', async () => {
    const httpGet = answering({ data: [{ id: 'kimi-k2' }] });
    const models = await fetchProviderModels('https://gw.example/', {
      token: 'sk-1',
      headers: { 'user-agent': 'ua' },
      httpGet,
      log: () => {},
      tag: '[t]',
    });
    expect(models).toEqual([{ id: 'kimi-k2' }]);
    expect(httpGet).toHaveBeenCalledWith('https://gw.example/v1/models', { 'user-agent': 'ua', authorization: 'Bearer sk-1' });
  });

  it('answers nothing — and says why — when the endpoint refuses, breaks or lists nothing', async () => {
    const logs: string[] = [];
    const options = (httpGet: Parameters<typeof fetchProviderModels>[1]['httpGet']) => ({
      httpGet,
      log: (line: string) => logs.push(line),
      tag: '[t]',
    });
    expect(await fetchProviderModels('https://gw.example', options(answering({}, 401)))).toBeUndefined();
    expect(await fetchProviderModels('https://gw.example', options(answering('<html>')))).toBeUndefined();
    expect(await fetchProviderModels('https://gw.example', options(answering({ data: [] })))).toBeUndefined();
    expect(
      await fetchProviderModels(
        'https://gw.example',
        options(async () => {
          throw new Error('ECONNREFUSED');
        }),
      ),
    ).toBeUndefined();
    expect(await fetchProviderModels('not a url', options(answering({ data: [{ id: 'a' }] })))).toBeUndefined();
    expect(logs.some((line) => /^\[t\] .*answered 401/.test(line))).toBe(true);
    expect(logs.some((line) => /listed no models/.test(line))).toBe(true);
    expect(logs.some((line) => /ECONNREFUSED/.test(line))).toBe(true);
    expect(logs.some((line) => /not a URL/.test(line))).toBe(true);
  });
});
