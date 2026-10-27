/**
 * One fake OpenCode 2.x server for every OpenCode test.
 *
 * Behaviour verified against OpenCode 2.1.4 on 2026-10-27; re-probe on a
 * version bump (`packages/agent-host/tools/fake-model.mjs` for a real
 * session, throwaway XDG dirs and `serve --port=0` for the rest). What the
 * probes established, and this fake therefore states:
 *
 *  - `provider.list` lists only the providers the server can use, and an
 *    empty list for the first moments after it starts (registration); the
 *    `integration.list` ids are every provider it knows (about 235) and
 *    `provider.get` describes one that `provider.list` leaves out.
 *  - `config.get` is an array of documents: one `{type:'document', info}`
 *    from the config file and one `{type:'directory', info:{}}`. A config
 *    file's `mcp` section reads back as `{servers: {name: config}}`, not as
 *    the bare map the file spells.
 *  - MCP `add` puts a server in the running inventory only: `mcp.list`
 *    shows it, `config.get` and the file do not, and a server restart loses
 *    it. `remove` likewise drops a config-file server from the inventory
 *    without touching the file, so it returns on the next start.
 *    `disconnect` reports status `disabled` in `mcp.list` and changes
 *    nothing in the config document; `connect` reports `connected`.
 *  - `plugin.list` is the 90 built-in plugins by `id` plus package plugins
 *    named by `source.target` (they carry no `id`). A package that fails to
 *    load is a `{source:{type:'package',target}, state:{status:'failed',
 *    error}}` entry. `plugin.update({targets})` accepts only packages in
 *    that inventory, and throws `InvalidRequestError` ("Plugin packages are
 *    not in the current server inventory: …") otherwise.
 *  - `integration.connect.key` creates an active credential, deactivating
 *    the integration's previous one; `credential.list` carries the secret;
 *    `credential.activate` switches which one is active; removing the
 *    active one leaves another of that integration active.
 *    `integration.oauth.status` is stateful (an attempt stays complete) and
 *    throws `IntegrationAttemptNotFoundError` for an attempt it does not
 *    know; `oauth.cancel` of an unknown attempt resolves.
 *  - `event.subscribe` opens immediately (a `server.connected` event at
 *    once), buffers what happens while the caller is still setting up, and
 *    stays open for the session's life. A client abort ends the iterator
 *    cleanly; the server being killed makes it throw (a `ClientError:
 *    Transport: terminated`), which is what the driver turns into an error
 *    end. `holdStream` therefore defaults to true.
 *  - A real turn is `session.execution.started`, `session.step.started`,
 *    `session.text.delta`/`ended`, `session.step.ended` (with the step's own
 *    `tokens`) and `session.execution.succeeded`; 2.1.4 does not send
 *    `session.idle` for that turn.
 *
 * The fake's own state, not a mock's return value, is what its methods read
 * and write, so a test can make calls in any order and see what a server
 * would. Every method is a `vi.fn` around that state, so a test can assert
 * a call, or replace one method where the scenario is about a failure.
 */
import { vi } from 'vitest';
import type {
  AgentGetOutput,
  AgentInfo,
  CredentialEntry,
  IntegrationInfo,
  McpServer,
  ModelInfo,
  OpenCodeClient,
  PluginInfo,
  ProviderInfo,
  SessionInfo,
} from '@opencode/client';

/** An event as the client's async iterator yields it; `type` is the switch
 *  the driver reads. The rest of a 2.1.4 event (`id`, `created`, `durable`)
 *  is not read by the driver, so a fixture may state only what it needs. */
export type FakeEvent = {
  type: string;
  data?: Record<string, unknown>;
  location?: { directory?: string };
  [key: string]: unknown;
};

export interface FakeAgentRow {
  id: string;
  name: string;
  mode: 'primary' | 'subagent' | 'all';
  hidden: boolean;
  description?: string;
  color?: string;
  /** The agent's own permission rules, restated after the mode's. */
  rules?: ReadonlyArray<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }>;
}

/** A plugin as 2.1.4's `plugin.list` states it: built-ins by `id`, packages
 *  by `source.target` (there is no `id`). */
export type FakePlugin = Pick<PluginInfo, 'id' | 'source' | 'state'> & { features?: Record<string, true> };

export interface FakeMcpServer {
  name: string;
  /** The status word 2.1.4 reports. */
  status: 'connected' | 'pending' | 'disabled' | 'failed' | 'needs_auth';
  error?: string;
}

export interface FakeSignIn {
  attemptID: string;
  url: string;
  instructions?: string;
  mode?: string;
  created?: number;
  expires?: number;
  status: 'pending' | 'complete' | 'failed' | 'expired';
  message?: string;
}

export interface FakeServerOptions {
  /** Events the stream yields once it opens. */
  events?: FakeEvent[];
  /** Keep the stream open after `events`, as a real server does (default
   *  true). A test that only needs the rest of the session to finish sets
   *  it false, and the stream closes cleanly at the end of the script. */
  holdStream?: boolean;
  /** Providers the server knows: the first are usable, `usable: false`
   *  ones are only describable through `provider.get`. */
  providers?: Array<{ info: ProviderInfo; models?: ModelInfo[]; usable?: boolean }>;
  /** The server's `OPENCODE_CONFIG_CONTENT`, as the driver hands it over:
   *  its `providers` become usable providers with models. */
  config?: { providers?: Record<string, FakeProviderConfig> };
  /** `provider.list` answers empty for this many calls first. */
  providerRegistration?: number;
  /** Integrations that are no model provider (web search, for one). */
  integrations?: string[];
  /** Providers whose `provider.get` fails, as a request can. */
  providerGetFails?: Set<string>;
  /** Per-provider delay before `provider.get` answers, for answer order. */
  providerGetDelayMs?: Record<string, number>;
  /** Agent rows `agent.list` answers with. A function sees the call number,
   *  for OpenCode's built-ins-then-directory-agents order. */
  agents?: FakeAgentRow[] | ((call: number) => FakeAgentRow[]);
  /** The config file's `plugins` entries (as the manager reads them). */
  pluginConfig?: Array<string | { package?: string; options?: Record<string, unknown> }>;
  /** Package plugins the server loaded (or failed to load). */
  plugins?: FakePlugin[];
  /** The config file's MCP servers, served through `config.get`. */
  mcpConfig?: Record<string, { type: 'local'; command: string[]; environment?: Record<string, string>; disabled?: boolean } | { type: 'remote'; url: string; headers?: Record<string, string>; disabled?: boolean }>;
  /** Servers in the running inventory (defaults to `mcpConfig`, connected). */
  mcpServers?: FakeMcpServer[];
  /** Integrations `integration.list` answers with. Defaults to the provider
   *  ids plus `integrations`. */
  integrationRows?: IntegrationInfo[];
  credentials?: CredentialEntry[];
  /** Sign-ins the server knows, by attempt id (`oauth.status` is stateful). */
  signIns?: FakeSignIn[];
  /** The id `session.create` gives a new session. */
  sessionId?: string;
  /** The session `session.get` answers, or one `session.create` made. A
   *  resumed id the fake does not know is `SessionNotFoundError`. */
  session?: Partial<SessionInfo>;
  /** The version `server.info` reports. */
  version?: string;
  /** Make `server.info` fail, as a server that cannot answer. */
  serverInfoError?: Error;
  /** Per-method replacement, applied over the stateful fake (the old
   *  `clientWith`'s `over`). */
  over?: Record<string, unknown>;
}

export interface FakeProviderConfig {
  name?: string;
  package?: string;
  settings?: { baseURL?: string; [key: string]: unknown };
  models?: Record<string, FakeModelConfig>;
}

export interface FakeModelConfig {
  name?: string;
  family?: string;
  limit?: { context?: number; output?: number };
  capabilities?: { tools?: boolean; input?: string[]; output?: string[]; temperature?: boolean; reasoning?: unknown };
  cost?: ModelInfo['cost'] | Record<string, unknown>;
}

export interface FakeOpenCodeServer {
  client: OpenCodeClient;
  /** The state the methods read and write. */
  state: {
    providers: Map<string, ProviderInfo>;
    models: Map<string, ModelInfo>;
    createdSessions: Map<string, SessionInfo>;
    plugins: FakePlugin[];
    mcpConfig: Record<string, unknown>;
    mcp: Map<string, FakeMcpServer>;
    integrations: IntegrationInfo[];
    credentials: CredentialEntry[];
    signIns: Map<string, FakeSignIn>;
    events: FakeEvent[];
  };
  /** Queue an event for the open stream. */
  push(event: FakeEvent): void;
  /** End the stream cleanly, as a client abort does. */
  endStream(): void;
  /** Fail the stream, as a server killed under it does. */
  failStream(error: unknown): void;
  /** Change a sign-in's status, which `oauth.status` then keeps reporting. */
  setSignIn(attemptID: string, status: FakeSignIn['status'], message?: string): void;
}

/** The agents a stock 2.1.4 server lists, in its own order. */
export const OPENCODE_AGENTS: FakeAgentRow[] = [
  { id: 'build', name: 'Build', mode: 'primary', hidden: false, rules: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'read', resource: '*.env', effect: 'ask' }] },
  { id: 'plan', name: 'Plan', mode: 'primary', hidden: false, rules: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'edit', resource: '*', effect: 'deny' }, { action: 'edit', resource: '/plans/*', effect: 'allow' }] },
  { id: 'general', name: 'General', mode: 'subagent', hidden: false },
  { id: 'explore', name: 'Explore', mode: 'subagent', hidden: false },
  { id: 'compaction', name: 'Compaction', mode: 'primary', hidden: true },
  { id: 'title', name: 'Title', mode: 'primary', hidden: true },
  { id: 'summary', name: 'Summary', mode: 'primary', hidden: true },
];

/** The same list plus a directory's own `review` agent. */
export const OPENCODE_AGENTS_WITH_REVIEW: FakeAgentRow[] = [
  ...OPENCODE_AGENTS,
  { id: 'review', name: 'review', mode: 'primary', hidden: false, description: 'Reviews code', color: '#E5C07B' },
];

/** An integration as 2.1.4's `integration.list` states one: no `tinyfish`
 *  provider, methods without ids for a plain key. */
const INTEGRATIONS: IntegrationInfo[] = [
  {
    id: 'nano-gpt',
    name: 'NanoGPT',
    methods: [{ type: 'key' }, { type: 'env', names: ['NANO_GPT_API_KEY'] }],
    connections: [{ type: 'credential', id: 'cred_1', label: 'work', method: 'key' }],
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    methods: [
      { type: 'env', names: ['GITHUB_TOKEN'] },
      {
        id: 'device',
        type: 'oauth',
        label: 'Login with GitHub Copilot',
        form: [
          { key: 'deploymentType', title: 'Deployment', required: true, type: 'string', options: [{ value: 'github.com', label: 'GitHub.com' }] },
          { key: 'enterpriseUrl', title: 'Enterprise URL', required: true, type: 'string', when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }] },
          { key: 'server', hidden: true, type: 'string', default: 'https://x' },
        ],
      },
    ],
    connections: [{ type: 'env', name: 'GITHUB_TOKEN' }],
  },
  { id: 'openai', name: 'OpenAI', methods: [{ type: 'key' }, { id: 'chatgpt', type: 'oauth', label: 'Sign in with ChatGPT' }], connections: [] },
];

const DEFAULT_ACCESS = { input: ['text'], output: ['text'] } as const;

/** The model a provider's config entry names, as `model.list` reports it. */
function modelFromConfig(providerID: string, modelID: string, entry: FakeModelConfig): ModelInfo {
  const reasoning = entry.capabilities?.reasoning as { effort?: string[]; toggle?: boolean } | undefined;
  const variants = (reasoning?.effort ?? []).map((id) => ({ id })) as ModelInfo['variants'];
  const cost = Array.isArray(entry.cost) ? entry.cost : entry.cost ? [entry.cost] : [];
  return {
    id: modelID,
    modelID,
    providerID,
    name: entry.name ?? modelID,
    ...(entry.family ? { family: entry.family } : {}),
    capabilities: {
      tools: entry.capabilities?.tools ?? true,
      input: [...(entry.capabilities?.input ?? DEFAULT_ACCESS.input)],
      output: [...(entry.capabilities?.output ?? DEFAULT_ACCESS.output)],
      ...(entry.capabilities?.temperature !== undefined ? { temperature: entry.capabilities.temperature } : {}),
    },
    variants,
    cost,
    limit: { context: entry.limit?.context ?? 0, output: entry.limit?.output ?? 0 },
    status: 'active',
    enabled: true,
  } as ModelInfo;
}

/** A provider as the server describes it: config providers are usable and
 *  carry their config's endpoint. A config entry naming a provider the
 *  server already knows keeps that provider's endpoint (and package) and
 *  overrides only what the entry states. */
function providerFromConfig(id: string, entry: FakeProviderConfig, base: ProviderInfo | undefined): ProviderInfo {
  return {
    ...(base ?? {}),
    id,
    name: entry.name ?? base?.name ?? id,
    activation: 'enabled',
    package: entry.package ?? base?.package ?? '@opencode/ai/providers/openai-compatible',
    settings: { ...(base?.settings ?? {}), ...(entry.settings ?? {}) },
  } as ProviderInfo;
}

export function fakeOpenCode(options: FakeServerOptions = {}): FakeOpenCodeServer {
  const at = { location: { directory: '/tmp' } };
  const events: FakeEvent[] = [];
  let ended = false;
  let failure: unknown;
  const waiters: Array<() => void> = [];
  const wake = () => waiters.splice(0).forEach((waiter) => waiter());

  const providers = new Map<string, ProviderInfo>();
  const models = new Map<string, ModelInfo>();
  const usable = new Set<string>();
  for (const entry of options.providers ?? []) {
    providers.set(entry.info.id, entry.info);
    if (entry.usable !== false) usable.add(entry.info.id);
    for (const model of entry.models ?? []) models.set(`${model.providerID}/${model.modelID}`, model);
  }
  for (const [id, entry] of Object.entries(options.config?.providers ?? {})) {
    const provider = providerFromConfig(id, entry, providers.get(id));
    providers.set(id, provider);
    usable.add(id);
    for (const [modelID, model] of Object.entries(entry.models ?? {})) {
      const listed = modelFromConfig(id, modelID, model);
      models.set(`${id}/${modelID}`, listed);
    }
  }

  const pluginConfig = options.pluginConfig ?? [];
  const pluginSpec = (entry: (typeof pluginConfig)[number]) => (typeof entry === 'string' ? entry : entry.package);
  const plugins: FakePlugin[] =
    options.plugins ??
    [
      { id: 'opencode.config.mcp', source: { type: 'builtin' }, state: { status: 'active' } },
      { id: 'opencode.plan', source: { type: 'builtin' }, state: { status: 'active' } },
      // A config package the server loaded is in the inventory under its
      // source target; a `-name` entry is switched off and not loaded.
      ...pluginConfig.flatMap((entry): FakePlugin[] => {
        const spec = pluginSpec(entry);
        if (!spec || spec.startsWith('-')) return [];
        return [{ source: { type: 'package', target: spec }, state: { status: 'active' } }];
      }),
    ];

  const mcpConfig = options.mcpConfig ?? {};
  const mcp = new Map<string, FakeMcpServer>(
    options.mcpServers
      ? options.mcpServers.map((server) => [server.name, { ...server }] as const)
      : Object.entries(mcpConfig).map(([name, entry]) => [name, { name, status: entry.disabled ? 'disabled' : 'connected' }] as const),
  );

  const integrationRows = options.integrationRows ?? [
    ...INTEGRATIONS,
    ...[...providers.keys()].filter((id) => !INTEGRATIONS.some((i) => i.id === id)).map((id) => ({ id, name: id, methods: [], connections: [] })),
    ...(options.integrations ?? []).map((id) => ({ id, name: id, methods: [], connections: [] })),
  ];
  const integrations = integrationRows.map((row) => ({ ...row, methods: [...row.methods], connections: [...row.connections] }));

  const credentials: CredentialEntry[] = (options.credentials ?? []).map((credential) => ({ ...credential }));
  const signInTemplates = options.signIns ?? [];
  let signInTemplate = 0;
  const signIns = new Map<string, FakeSignIn>(signInTemplates.map((attempt) => [attempt.attemptID, { ...attempt }]));

  const createdSessions = new Map<string, SessionInfo>();
  if (options.session?.id) createdSessions.set(options.session.id, options.session as SessionInfo);

  const agents = (call: number): FakeAgentRow[] =>
    typeof options.agents === 'function' ? options.agents(call) : options.agents ?? OPENCODE_AGENTS_WITH_REVIEW;
  let agentListCalls = 0;

  const agentInfo = (row: FakeAgentRow): AgentInfo =>
    ({
      id: row.id,
      name: row.name,
      mode: row.mode,
      hidden: row.hidden,
      ...(row.description ? { description: row.description } : {}),
      ...(row.color ? { color: row.color } : {}),
      request: {},
      permissions: row.rules ?? [],
    }) as unknown as AgentInfo;

  let providerListCalls = 0;
  const registration = options.providerRegistration ?? 0;

  const client = {
    server: {
      info: vi.fn(async () => {
        if (options.serverInfoError) throw options.serverInfoError;
        return { version: options.version ?? '2.1.4' };
      }),
    },
    location: { get: vi.fn(async () => ({ directory: '/tmp' })), reload: vi.fn(async () => undefined) },
    agent: {
      list: vi.fn(async () => {
        const rows = agents(agentListCalls++);
        return { ...at, data: rows.map(agentInfo) };
      }),
      get: vi.fn(async ({ agentID }: { agentID: string }): Promise<AgentGetOutput> => {
        const row = agents(0).find((a) => a.id === agentID);
        if (!row) throw Object.assign(new Error(`no agent ${agentID}`), { name: 'AgentNotFoundError' });
        return { ...at, data: agentInfo(row) };
      }),
    },
    plugin: {
      list: vi.fn(async () => ({ ...at, data: plugins })),
      check: vi.fn(async ({ target }: { target?: string }) => {
        if (!target || !plugins.some((p) => p.source.type === 'package' && p.source.target === target)) {
          throw Object.assign(new Error(`Plugin package is not in the current server inventory: ${target ?? ''}`), { name: 'InvalidRequestError' });
        }
        return { ...at, data: plugins };
      }),
      update: vi.fn(async ({ targets }: { targets: ReadonlyArray<string> }) => {
        const missing = targets.find((target) => !plugins.some((p) => p.source.type === 'package' && p.source.target === target));
        if (missing) {
          throw Object.assign(new Error(`Plugin packages are not in the current server inventory: ${missing}`), { name: 'InvalidRequestError' });
        }
      }),
    },
    session: {
      create: vi.fn(async (input: Record<string, unknown> = {}) => {
        const id = (input.id as string | undefined) ?? options.sessionId ?? 'ses_1';
        const session = {
          id,
          projectID: 'p',
          ...(input.model ? { model: input.model } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.permissions ? { permissions: input.permissions } : {}),
          ...(input.title ? { title: input.title } : {}),
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
          ...(input.location ? { location: input.location } : at),
          ...options.session,
        } as unknown as SessionInfo;
        createdSessions.set(id, session);
        return session;
      }),
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => {
        const session = createdSessions.get(sessionID);
        if (!session) throw Object.assign(new Error(`Session not found: ${sessionID}`), { name: 'SessionNotFoundError' });
        return session;
      }),
      remove: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      switchAgent: vi.fn(async () => undefined),
      switchModel: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      prompt: vi.fn(async () => ({})),
      command: vi.fn(async () => undefined),
      compact: vi.fn(async () => ({})),
      diff: vi.fn(async () => []),
      revert: { stage: vi.fn(async () => ({})), clear: vi.fn(async () => undefined), commit: vi.fn(async () => undefined) },
      form: { reply: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
    },
    shell: {
      list: vi.fn(async () => ({ ...at, data: [] })),
      create: vi.fn(async () => ({ ...at, data: { id: 'sh_1' } })),
      get: vi.fn(async () => ({ ...at, data: { id: 'sh_1' } })),
      output: vi.fn(async () => ({ ...at, data: { output: '', cursor: 0, size: 0, truncated: false } })),
      remove: vi.fn(async () => undefined),
    },
    permission: { reply: vi.fn(async () => undefined) },
    message: { list: vi.fn(async () => ({ data: [], cursor: {} })) },
    command: { list: vi.fn(async () => ({ ...at, data: [] })) },
    mcp: {
      list: vi.fn(async () => ({
        ...at,
        data: [...mcp.values()].sort((a, b) => a.name.localeCompare(b.name)).map((server) => ({
          name: server.name,
          status: server.status === 'failed' || server.status === 'needs_auth' ? { status: server.status, error: server.error ?? 'failed' } : { status: server.status },
        })) as McpServer[],
      })),
      add: vi.fn(async ({ server, config }: { server: string; config: Record<string, unknown> }) => {
        // 2.1.4 keeps an added server in the running inventory only: it is
        // not written to the config document or the file.
        mcp.set(server, { name: server, status: 'connected' });
      }),
      remove: vi.fn(async ({ server }: { server: string }) => {
        if (!mcp.has(server)) throw Object.assign(new Error(`MCP server not found: ${server}`), { name: 'McpServerNotFoundError' });
        // Removing does not rewrite the config file; a restart brings a
        // config-file server back.
        mcp.delete(server);
      }),
      connect: vi.fn(async ({ server }: { server: string }) => {
        const found = mcp.get(server);
        if (!found) throw Object.assign(new Error(`MCP server not found: ${server}`), { name: 'McpServerNotFoundError' });
        found.status = 'connected';
      }),
      disconnect: vi.fn(async ({ server }: { server: string }) => {
        const found = mcp.get(server);
        if (!found) throw Object.assign(new Error(`MCP server not found: ${server}`), { name: 'McpServerNotFoundError' });
        found.status = 'disabled';
      }),
    },
    config: {
      get: vi.fn(async () => [
        {
          type: 'document',
          path: '/tmp/opencode/opencode.json',
          info: {
            ...(Object.keys(mcpConfig).length > 0 ? { mcp: { servers: mcpConfig } } : {}),
            ...(pluginConfig.length > 0 ? { plugins: pluginConfig } : {}),
          },
        },
        { type: 'directory', path: '/tmp/opencode', info: {} },
      ]),
      shells: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
    },
    provider: {
      list: vi.fn(async () => {
        if (providerListCalls++ < registration) return { ...at, data: [] };
        return { ...at, data: [...providers.values()].filter((provider) => usable.has(provider.id)) };
      }),
      get: vi.fn(async ({ providerID }: { providerID: string }) => {
        if (options.providerGetFails?.has(providerID)) throw new Error(`fetch failed for ${providerID}`);
        const delay = options.providerGetDelayMs?.[providerID];
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const provider = providers.get(providerID);
        if (!provider) throw Object.assign(new Error(`Provider not found: ${providerID}`), { name: 'ProviderNotFoundError' });
        return { ...at, data: provider };
      }),
    },
    model: {
      list: vi.fn(async () => ({ ...at, data: [...models.values()].filter((model) => usable.has(model.providerID)) })),
      default: vi.fn(async () => ({ ...at, data: null })),
    },
    integration: {
      list: vi.fn(async () => ({ ...at, data: integrations.map((row) => ({ ...row, methods: [...row.methods], connections: [...row.connections] })) })),
      get: vi.fn(async ({ integrationID }: { integrationID: string }) => {
        const row = integrations.find((integration) => integration.id === integrationID);
        if (!row) throw Object.assign(new Error(`Integration not found: ${integrationID}`), { name: 'IntegrationNotFoundError' });
        return { ...at, data: { ...row, methods: [...row.methods], connections: [...row.connections] } };
      }),
      connect: {
        key: vi.fn(async ({ integrationID, key, label }: { integrationID: string; key: string; label?: string }) => {
          const row = integrations.find((integration) => integration.id === integrationID);
          if (!row) throw Object.assign(new Error(`Integration not found: ${integrationID}`), { name: 'IntegrationNotFoundError' });
          // One active credential per integration.
          for (const credential of credentials) if (credential.integrationID === integrationID) credential.active = false;
          const credential = {
            id: `cred_${credentials.length + 1}`,
            integrationID,
            label: label ?? integrationID,
            active: true,
            value: { type: 'key', key },
          } as CredentialEntry;
          credentials.push(credential);
          row.connections.push({ type: 'credential', id: credential.id, label: credential.label, method: 'key' });
        }),
        external: vi.fn(async () => undefined),
      },
      oauth: {
        connect: vi.fn(async ({ integrationID, methodID }: { integrationID: string; methodID?: string }) => {
          // A scripted attempt (the test's own URL and id) is used first, as
          // the server would hand back the one it started.
          const template = signInTemplates[signInTemplate];
          if (template) signInTemplate++;
          const id = template?.attemptID ?? `con_${signIns.size + 1}`;
          const attempt: FakeSignIn = {
            ...(template ?? {}),
            attemptID: id,
            url: template?.url ?? 'https://github.com/login/device?user_code=ABCD',
            instructions: template?.instructions ?? 'Enter code: ABCD',
            mode: template?.mode ?? 'auto',
            created: template?.created ?? 0,
            expires: template?.expires ?? 10_000,
            status: template?.status ?? 'pending',
          };
          signIns.set(id, attempt);
          return { ...at, data: { attemptID: id, url: attempt.url, instructions: attempt.instructions, mode: attempt.mode, time: { created: attempt.created!, expires: attempt.expires! } } };
        }),
        status: vi.fn(async ({ attemptID }: { attemptID: string }) => {
          const attempt = signIns.get(attemptID);
          if (!attempt) throw Object.assign(new Error(`OAuth attempt not found: ${attemptID}`), { name: 'IntegrationAttemptNotFoundError' });
          return {
            ...at,
            data: {
              status: attempt.status,
              ...(attempt.status === 'failed' ? { message: attempt.message ?? 'sign-in failed' } : {}),
              time: { created: attempt.created ?? 0, expires: attempt.expires ?? 10_000 },
            },
          };
        }),
        complete: vi.fn(async ({ attemptID }: { attemptID: string }) => {
          const attempt = signIns.get(attemptID);
          if (attempt) attempt.status = 'complete';
        }),
        cancel: vi.fn(async ({ attemptID }: { attemptID: string }) => {
          signIns.delete(attemptID);
        }),
      },
      command: {
        connect: vi.fn(async () => ({ ...at, data: { attemptID: 'cmd_1', time: { created: 0, expires: 10_000 } } })),
        status: vi.fn(async () => ({ ...at, data: { status: 'pending', time: { created: 0, expires: 10_000 } } })),
        cancel: vi.fn(async () => undefined),
      },
    },
    credential: {
      list: vi.fn(async () => credentials.map((credential) => ({ ...credential }))),
      create: vi.fn(async (input: Record<string, unknown>) => {
        const credential = { id: `cred_${credentials.length + 1}`, active: false, ...input } as CredentialEntry;
        credentials.push(credential);
        return credential;
      }),
      update: vi.fn(async () => undefined),
      activate: vi.fn(async ({ credentialID }: { credentialID: string }) => {
        const target = credentials.find((credential) => credential.id === credentialID);
        if (!target) return; // 2.1.4 answers an unknown id with success (verified).
        for (const credential of credentials) if (credential.integrationID === target.integrationID) credential.active = false;
        target.active = true;
      }),
      remove: vi.fn(async ({ credentialID }: { credentialID: string }) => {
        const index = credentials.findIndex((credential) => credential.id === credentialID);
        if (index < 0) return;
        const [removed] = credentials.splice(index, 1);
        const row = integrations.find((integration) => integration.id === removed!.integrationID);
        if (row) row.connections = row.connections.filter((connection) => connection.type !== 'credential' || connection.id !== credentialID);
        // The server leaves another of that integration active.
        if (removed!.active) {
          const next = credentials.find((credential) => credential.integrationID === removed!.integrationID);
          if (next) next.active = true;
        }
      }),
    },
    event: {
      subscribe: vi.fn((request: { signal?: AbortSignal } | undefined) => stream(request?.signal)),
    },
  } as unknown as OpenCodeClient;

  // A per-method replacement, one level in: `{ session: { get } }` keeps the
  // rest of the session methods the fake already has.
  const withOverrides: Record<string, unknown> = { ...(client as unknown as Record<string, unknown>) };
  for (const [group, value] of Object.entries(options.over ?? {})) {
    const base = withOverrides[group];
    withOverrides[group] =
      value && typeof value === 'object' && !Array.isArray(value) && base && typeof base === 'object'
        ? { ...(base as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value;
  }

  const server: FakeOpenCodeServer = {
    client: withOverrides as unknown as OpenCodeClient,
    state: { providers, models, createdSessions, plugins, mcpConfig, mcp, integrations, credentials, signIns, events },
    push: (event) => {
      events.push(event);
      wake();
    },
    endStream: () => {
      ended = true;
      wake();
    },
    failStream: (error) => {
      failure = error;
      ended = true;
      wake();
    },
    setSignIn: (attemptID, status, message) => {
      const attempt = signIns.get(attemptID);
      if (!attempt) throw new Error(`no sign-in ${attemptID}`);
      attempt.status = status;
      if (message) attempt.message = message;
    },
  };

  async function* stream(signal?: AbortSignal): AsyncGenerator<FakeEvent> {
    const onAbort = () => {
      ended = true;
      wake();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // 2.1.4's first event, and why subscribing before creating a session
      // does not miss it: the request opens on subscribe, not on first read.
      yield { type: 'server.connected', data: {} } as FakeEvent;
      for (const event of options.events ?? []) {
        if (ended) return;
        yield event;
      }
      if (options.holdStream === false) {
        // A test convenience: the script is over, and one macrotask lets the
        // driver's off-stream ask handlers run before the close.
        await new Promise<void>((resolve) => setImmediate(resolve));
        ended = true;
      }
      for (;;) {
        if (events.length > 0) {
          yield events.shift()!;
          continue;
        }
        if (failure !== undefined) throw failure;
        if (ended) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return server;
}
