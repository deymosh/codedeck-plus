/**
 * The host's own request handling never relays a credential: not in the
 * reply it writes for the bridge, and not in the diagnostic line it logs.
 *
 * The provider checks here run the real provider code over a fake HTTP seam,
 * so the failure text the host receives is the same shape a real client's
 * would be — one that may quote the request headers (the token included).
 */
import { describe, expect, it } from 'vitest';
import type { HttpGet, HttpPost } from '../../sdk/net';
import type { Driver } from '../../sdk/driver';
import type { AgentInfo, ProviderBinding } from '../../sdk/types';
import { OPENAI_API, checkToken, listModels } from '../../sdk/providerApi';
import { TEST_SECRETS, expectNoSecretLeaks } from '../../sdk/__tests__/secrets';
import { FakeDriver } from '../../drivers/fake/driver';
import { Agents } from '../agents';
import { AgentHost } from '../host';

interface Frame {
  v: number;
  id?: string;
  kind: string;
  payload?: Record<string, unknown>;
}

const INFO: AgentInfo = {
  id: 'stub',
  displayName: 'Stub',
  modes: [],
  efforts: [],
  supports: {} as AgentInfo['supports'],
  credentials: [],
};

const profile = (): ProviderBinding => ({
  id: 'home',
  label: 'Home router',
  baseUrl: 'https://gw.example',
  authToken: TEST_SECRETS.providerToken,
  models: [{ id: 'm' }],
});

/** A driver whose provider paths are the real ones, over a fake HTTP seam. */
function providerDriver(http: { get: HttpGet; post: HttpPost }): Driver {
  return {
    info: () => INFO,
    startSession: () => {
      throw new Error('this test does not start sessions');
    },
    listModels: async () => ({ models: [] }),
    checkProvider: (provider, model) => checkToken(OPENAI_API, provider, model, http.post),
    listProviderModels: (baseUrl, token) => listModels(OPENAI_API, baseUrl, token, http.get),
  };
}

function harness(driver: Driver) {
  const frames: Frame[] = [];
  const logs: string[] = [];
  const host = new AgentHost(
    Agents.of([driver]),
    { write: (line) => frames.push(JSON.parse(line) as Frame), log: (line) => logs.push(line) },
    '9.9.9',
  );
  let next = 0;
  const send = (kind: string, payload: Record<string, unknown>, id = `b${++next}`) =>
    host.handleLine(JSON.stringify({ v: 1, id, kind, payload }));
  const reply = (id: string): Frame | undefined => frames.find((frame) => frame.id === id);
  return { host, frames, logs, send, reply };
}

describe('the host relays no secret', () => {
  it('a provider check whose request failed answers without the token', async () => {
    const h = harness(
      providerDriver({
        post: async () => {
          throw new Error(`HTTP 500 — authorization: Bearer ${TEST_SECRETS.providerToken}`);
        },
        get: async () => {
          throw new Error('not used');
        },
      }),
    );
    await h.send('check-provider', { agent: 'stub', provider: profile(), model: 'm' }, 'c');
    expect(h.reply('c')).toMatchObject({ kind: 'credential-checked', payload: {} });
    expectNoSecretLeaks({ logs: h.logs, frames: h.frames });
  });

  it('a model list that failed does not echo the token in its error', async () => {
    const h = harness(
      providerDriver({
        post: async () => ({ status: 200 }),
        get: async (_url, headers) => {
          // A client whose failure quotes the request it was given.
          throw new Error(`request failed: authorization=${headers.authorization}`);
        },
      }),
    );
    await h.send(
      'list-provider-models',
      { agent: 'stub', baseUrl: 'https://gw.example', authToken: TEST_SECRETS.providerToken },
      'l',
    );
    expect(h.reply('l')).toMatchObject({ kind: 'error' });
    expectNoSecretLeaks({ logs: h.logs, frames: h.frames });
  });

  it('an MCP server added with a header secret is reported without it', async () => {
    const h = harness(new FakeDriver());
    await h.send(
      'mcp-action',
      {
        agent: 'fake',
        action: 'add',
        servers: [
          {
            name: 'gh',
            setup: { type: 'http', url: 'https://x/mcp', headers: { Authorization: `Bearer ${TEST_SECRETS.githubPat}` } },
          },
        ],
      },
      'm',
    );
    expect(h.reply('m')).toMatchObject({
      kind: 'mcp-servers',
      payload: { servers: [{ name: 'gh', headerKeys: ['Authorization'] }] },
    });
    expectNoSecretLeaks({ logs: h.logs, frames: h.frames });
  });

  it('a session that fails to start does not carry its credentials in the error', async () => {
    // The host receives whatever a driver throws; a driver that quotes an
    // environment variable in its refusal must still not put the value on
    // the wire. (The drivers themselves redact before throwing — see each
    // driver's secrets test — so this asserts the host does not add it back.)
    const h = harness(new FakeDriver());
    await h.send(
      'start-session',
      {
        sessionId: 's1',
        agent: 'fake',
        cwd: '',
        credentials: { fake_token: TEST_SECRETS.apiKey },
        env: { GITHUB_TOKEN: TEST_SECRETS.githubPat },
      },
      'st',
    );
    expect(h.reply('st')).toMatchObject({ kind: 'error', payload: { message: 'the fake agent needs a working directory' } });
    expectNoSecretLeaks({ logs: h.logs, frames: h.frames });
  });
});
