/**
 * The OpenCode driver, over `@opencode/client` — the API OpenCode 2.x
 * servers serve.
 *
 * One `OpenCodeSession` per bridge session: it subscribes to the server's
 * event stream, normalizes it down to stable `OpenCodeEvent`s (adapter.ts
 * translates those into entries), and answers OpenCode's permission asks and
 * its forms (the cards a question becomes) through the bridge.
 *
 * Deliberate limits:
 *  - an "always allow" reply is OpenCode's own `always`: a rule it saves for
 *    the project, which outlives the session and the server — listed and
 *    revoked through `permissionRules` (permissionRules.ts);
 *  - no subscription usage: OpenCode has no equivalent to ask, and a
 *    fabricated number would be worse than none. Context usage is reported
 *    only for models whose provider declares a context limit;
 *  - no effort levels of its own; models are `provider/model` ids, and a
 *    reasoning level rides on the model as a v2 variant.
 *
 * Provider profiles are added to the server this driver starts as
 * providers of their own (providers.ts): their models join the list beside
 * OpenCode Zen and the operator's providers, and a session picks one like
 * any other.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { OpenCode, type OpenCodeClient } from '@opencode/client';
import type { Driver, DriverSession, McpManager, PermissionRuleManager, PluginManager, SessionContext } from '../../sdk/driver';
import type { ProviderHttp } from '../../sdk/net';
import { isValidProviderBaseUrl } from '../../sdk/provider';
import { checkToken, listModels, OPENAI_API } from '../../sdk/providerApi';
import type { EndpointModel } from '../../sdk/providerModels';
import { redactSecrets } from '../../sdk/redact';
import type { AgentInfo, ModelEntry, Persona, ProviderBinding, RefusedProvider, StartSession } from '../../sdk/types';
import { OpenCodeAccounts } from './accounts';
import { type Catalog, type CatalogModel, catalogModel, EMPTY_CATALOG, serverModel, withModels } from './catalog';
import { readCatalogCache, writeCatalogCache } from './catalogCache';
import { formatOpenCodeError, isNotFound, type OpenCodeCatalog, pickDefaultModel, reasoningLevels, splitModelId } from './format';
import { OpenCodeMcp } from './mcp';
import { fetchModelsDev, MODELS_DEV_TTL_MS, modelsDevSource } from './modelsDev';
import { BUILD_AGENT, DEFAULT_MODE, OPENCODE_MODES } from './modes';
import { OpenCodePermissionRules } from './permissionRules';
import { listSelectablePersonas, PERSONA_LOAD_MS } from './personas';
import { OpenCodePlugins } from './plugins';
import { NOTHING_SERVED, type Placement, placeProfiles, profileModelGroup, providersFingerprint, type Served, servedBy, serverSetup, withoutProfiles } from './providers';
import { resolveOpenCodePath, startOpenCodeServer, type OpenCodeServerHandle, type StartOpenCodeServerOptions } from './server';
import { OpenCodeSession } from './session';
import { OPENCODE_STYLE } from './style';

export const OPENCODE_AGENT_ID = 'opencode';

export interface OpenCodeDriverOptions {
  /** An OpenCode server to connect to. Wins over `autoStart`. */
  serverUrl?: string;
  /** Spawn and manage an OpenCode server when no `serverUrl` is given. */
  autoStart?: boolean;
  /** `opencode` executable for auto-start (else resolved from PATH). */
  binaryPath?: string;
  /** Installs `opencode` for auto-start when none is found. */
  installOpenCode?: () => Promise<string>;
  /** The environment to look for an installed `opencode` in (PATH,
   *  CODEDECK_OPENCODE_PATH); the host's own by default. */
  lookupEnv?: NodeJS.ProcessEnv;
  port?: number;
  log: (message: string) => void;
  /** Outbound HTTP to provider profiles' endpoints. */
  providerHttp?: ProviderHttp;
  /** Seams for tests: how the server is started and connected to. */
  startServer?: (options: StartOpenCodeServerOptions) => Promise<OpenCodeServerHandle>;
  connect?: (config: { baseUrl: string; headers?: Record<string, string> }) => OpenCodeClient;
  /** How long a server's first start is given to refresh its model list
   *  (`MODELS_REFRESH_WAIT_MS` by default; 0 does not wait). */
  modelsRefreshWaitMs?: number;
  /** Where the catalog that placed the provider profiles is kept between
   *  starts (catalogCache.ts); none keeps it. */
  catalogCache?: string;
  /** How long a start with a kept catalog waits for the provider profiles
   *  (`FIRST_PROVIDERS_WAIT_MS` by default). */
  firstProvidersWaitMs?: number;
  /** How long a started server is given to register its providers
   *  (`CATALOG_WAIT_MS` by default; 0 does not wait). */
  catalogWaitMs?: number;
}

/** A server registers its providers, from the catalog built into it, a
 *  moment after it says it is listening (0.6-0.9 s): until then it lists
 *  no provider and no model, and describes none. */
export const CATALOG_WAIT_MS = 3_000;

/** Wait for a just-started server to list a provider, at most `waitMs`. A
 *  server that cannot be asked, or a host shutting down, has nothing to wait
 *  for. (One whose config disables every provider never lists one: it costs
 *  the whole wait, once per start.) */
async function catalogRegistered(client: OpenCodeClient, waitMs: number, stopped: () => boolean): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !stopped()) {
    try {
      if ((await client.provider.list()).data.length > 0) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Run `task` over `items`, `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** A start with a kept catalog waits for the bridge's `set-providers`, which
 *  it sends as soon as the host is up, so the server starts once, with the
 *  profiles. Past this it starts without them: a later list restarts it,
 *  as a start without a kept catalog does. */
export const FIRST_PROVIDERS_WAIT_MS = 15_000;

/** A server's first start on a machine answers from the models snapshot
 *  built into it until it has fetched models.dev, a few hundred ms later,
 *  and says so with `models-dev.refreshed`. The snapshot can name retired
 *  models and even default to one (2.0.28's names `opencode/exo-free`), so
 *  a session or a model list asked for in that window would get a model
 *  that no longer runs. Later starts load the list kept from that fetch,
 *  current from the first answer, and send no such event — so only a first
 *  start waits. The wait is capped: with models.dev unreachable no event
 *  comes and the snapshot stays — then it is the best list there is. */
export const MODELS_REFRESH_WAIT_MS = 3_000;

/** Where the server keeps its database, which holds the models.dev list it
 *  fetched: its data directory, XDG's on every platform. No database yet
 *  means a first start. */
export function openCodeDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME?.trim() || path.join(homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'opencode.db');
}

/** Wait for a just-started server's `models-dev.refreshed`, at most
 *  `waitMs`. Not when the fetch is switched off, and not past a stream that
 *  fails: either way there is nothing to wait for. The server loads its
 *  catalog, and fetches models.dev, only once something asks for it, so the
 *  wait asks: nothing else would until the wait is over. */
async function modelsRefreshed(client: OpenCodeClient, env: NodeJS.ProcessEnv, waitMs: number): Promise<void> {
  const disabled = env.OPENCODE_DISABLE_MODELS_FETCH;
  if (waitMs <= 0 || (disabled !== undefined && disabled !== '' && disabled !== '0' && disabled !== 'false')) return;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A stream that could not open, or ended, has nothing more to say; and
  // neither it nor the ask may fail the start, so both are settled here.
  const refreshed = (async () => {
    for await (const event of client.event.subscribe({ signal: abort.signal })) {
      if (event.type === 'models-dev.refreshed') return;
    }
  })().catch(() => {});
  void (async () => client.model.list())().catch(() => {});
  // The deadline races the stream rather than relying on the abort to end
  // it: a pending read is not interrupted by every stream.
  const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)));
  try {
    await Promise.race([refreshed, deadline]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** What of `catalog` models.dev filled in, and when. */
const filled = (catalog: Catalog): Pick<Catalog, 'filledAt'> => (catalog.filledAt !== undefined ? { filledAt: catalog.filledAt } : {});

/** Why OpenCode cannot run, when it is enabled but unusable. */
const NOT_CONFIGURED = 'This bridge has no OpenCode server to use (CODEDECK_OPENCODE_SERVER_URL), and starts none of its own.';

export class OpenCodeDriver implements Driver {
  private clientPromise: Promise<OpenCodeClient> | null = null;
  private server: OpenCodeServerHandle | null = null;
  private unavailable: string | undefined;
  /** The `opencode` the server runs, once found or installed. */
  private bin: string | null = null;
  /** Auto-start with no `opencode` on the machine: it is installed, then
   *  started, in the background; a failed attempt is retried by the next
   *  session. */
  private installs = false;
  private stopped = false;
  /** Where the provider profiles go among the server's providers, and the
   *  catalog that placed them (it fills in their models). */
  private placed: Placement[] = [];
  private catalog: Catalog = EMPTY_CATALOG;
  /** When the server's own directory was first booted, which is when its
   *  global agents started loading. */
  private personasBootedAt?: number;
  /** The placements the running server was started with: their
   *  fingerprint, and the providers they made. */
  private served = providersFingerprint([], EMPTY_CATALOG);
  private serving: Served = NOTHING_SERVED;
  /** Set while the first start waits for the provider profiles: hands them
   *  over and lets the start go on. */
  private firstProviders?: () => void;
  /** The models.dev list, once asked for (modelsDev.ts). */
  private modelsDev?: Promise<Map<string, CatalogModel>>;
  /** Provider changes are applied one at a time, in order. */
  private applying: Promise<void> = Promise.resolve();
  /** Sessions on the running server, ended when it is replaced; ended
   *  ones are dropped. */
  private readonly sessions = new Set<OpenCodeSession>();
  readonly plugins: PluginManager = new OpenCodePlugins(() => this.client());
  readonly mcp: McpManager = new OpenCodeMcp(() => this.client());
  readonly accounts = new OpenCodeAccounts(() => this.client(), { log: (message) => this.options.log(message) });
  readonly permissionRules: PermissionRuleManager = new OpenCodePermissionRules(() => this.client(), (message) => this.options.log(message));

  private constructor(private readonly options: OpenCodeDriverOptions) {}

  /** The driver starts the server, so it decides the server's config. */
  private get manages(): boolean {
    return !this.options.serverUrl && Boolean(this.options.autoStart);
  }

  /** The server's client, starting it again when the last attempt failed. */
  /** The server's own release: the one sessions run on, whether this
   *  driver started it or connected to it. Read only from a server that is
   *  starting or up — never a reason to start (or install) one. */
  async version(): Promise<string | undefined> {
    if (!this.clientPromise) return undefined;
    try {
      const client = await this.clientPromise;
      return (await client.server.info()).version || undefined;
    } catch {
      return undefined;
    }
  }

  private client(): Promise<OpenCodeClient> {
    if (!this.clientPromise && !this.stopped && (this.bin || this.installs)) this.launch();
    return this.clientPromise ?? Promise.reject(new Error(this.unavailable ?? NOT_CONFIGURED));
  }

  /** Connect to (or start) the configured server. Never throws: a driver
   *  that cannot reach OpenCode is still advertised, with the reason. */
  static async create(options: OpenCodeDriverOptions): Promise<OpenCodeDriver> {
    const driver = new OpenCodeDriver(options);
    if (options.serverUrl) {
      if (options.autoStart) options.log('[opencode] both a server URL and auto-start are configured — using the server URL');
      driver.clientPromise = Promise.resolve(driver.connect({ baseUrl: options.serverUrl }));
    } else if (options.autoStart) {
      driver.bin = resolveOpenCodePath(options.binaryPath, options.lookupEnv);
      const kept = options.catalogCache ? readCatalogCache(options.catalogCache) : undefined;
      if (kept) driver.catalog = kept;
      if (!driver.bin && options.installOpenCode) {
        driver.installs = true;
        driver.launch(kept ? () => driver.providersArrived() : undefined);
      } else if (!driver.bin) {
        driver.unavailable =
          'OpenCode auto-start is enabled but the `opencode` executable was not found (set CODEDECK_OPENCODE_PATH).';
      } else if (kept) {
        // Sessions, model lists and the version wait on this start like on
        // any other.
        driver.launch(() => driver.providersArrived());
      } else {
        try {
          const client = await driver.startServer(driver.bin);
          // A server that exited the moment it started is not one to cache:
          // the exit watcher has already cleared it, and the next session
          // starts a new one.
          if (driver.server) driver.clientPromise = Promise.resolve(client);
        } catch (err) {
          // A failed first start is not a reason to report the agent as
          // unavailable: the host refuses every start-session when it is, so
          // the retry this driver relies on would never run. `bin` stays
          // known, and the next session starts a new server.
          options.log(`[opencode] first server start failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      driver.unavailable = NOT_CONFIGURED;
    }
    if (driver.unavailable) options.log(`[opencode] unavailable: ${driver.unavailable}`);
    return driver;
  }

  /** A driver over an existing client (tests). */
  static withClient(client: OpenCodeClient): OpenCodeDriver {
    const driver = new OpenCodeDriver({ log: () => {} });
    driver.clientPromise = Promise.resolve(client);
    return driver;
  }

  private connect(config: { baseUrl: string; headers?: Record<string, string> }): OpenCodeClient {
    return (this.options.connect ?? OpenCode.make)(config);
  }

  /** Start `opencode serve` with the provider profiles it should have, and
   *  connect to it. */
  private async startServer(bin: string): Promise<OpenCodeClient> {
    const placed = this.placed;
    const setup = serverSetup(placed, this.catalog, process.env);
    const start = this.options.startServer ?? startOpenCodeServer;
    const env = { ...process.env, ...setup.env };
    const firstStart = !existsSync(openCodeDatabase(env));
    let server: OpenCodeServerHandle;
    try {
      server = await start({
        command: bin,
        env,
        ...(this.options.port !== undefined ? { port: this.options.port } : {}),
      });
    } catch (err) {
      // A child that dies can print the environment it ran in; the provider
      // tokens and the server's own password are the part that may not
      // travel on to the log or the bridge.
      const reason = err instanceof Error ? err.message : String(err);
      const secrets = [...Object.values(setup.env), ...Object.values(setup.headers)];
      throw new Error(`The OpenCode server failed to start: ${redactSecrets(reason, secrets)}`);
    }
    if (this.stopped) {
      await server.close();
      throw new Error('the agent host is shutting down');
    }
    this.server = server;
    this.watchServer(server);
    this.served = providersFingerprint(placed, this.catalog);
    this.serving = servedBy(placed, this.catalog);
    const added = placed.length > 0 ? `, with ${placed.length} provider profile(s)` : '';
    this.options.log(`[opencode] started ${server.url} (pid ${server.pid ?? '?'})${added}`);
    const client = this.connect({ baseUrl: server.url, headers: setup.headers });
    // Nothing reads the providers or the models before they are there.
    await catalogRegistered(client, this.options.catalogWaitMs ?? CATALOG_WAIT_MS, () => this.stopped);
    // Everything waits on this start (the client promise), so nothing reads
    // the models before they are current.
    if (firstStart) {
      await modelsRefreshed(client, env, this.options.modelsRefreshWaitMs ?? MODELS_REFRESH_WAIT_MS);
      // Shut down meanwhile: the server is closed, and this start is over.
      if (this.stopped) throw new Error('the agent host is shutting down');
    }
    return client;
  }

  /** Watch the server the driver started: a crash must not leave a dead
   *  client cached for the rest of the bridge's life. The next session
   *  starts a new server; the sessions on this one end with a reason the
   *  bridge can resume them from. */
  private watchServer(server: OpenCodeServerHandle): void {
    void server.exited.then(() => {
      // A server replaced for changed provider profiles, or a shutdown, is
      // closed on purpose: its successor (or the host) handles the rest.
      if (this.stopped || this.server !== server) return;
      this.server = null;
      this.clientPromise = null;
      // Deliberately not `unavailable`: the host refuses start-session on
      // that, before the driver can start the new server this exists for.
      this.options.log('[opencode] the server exited; the next session starts a new one');
      const stale = [...this.sessions];
      this.sessions.clear();
      for (const session of stale) session.serverLost('The OpenCode server exited. The conversation can be resumed.');
    });
  }

  /** Find (or install) `opencode`, start its server and connect — sessions
   *  and model lists asked for meanwhile wait on the same promise. `first`
   *  runs before the start (closing the server being replaced). */
  private launch(first?: () => Promise<void>): void {
    const attempt = (async (): Promise<OpenCodeClient> => {
      await first?.();
      if (this.stopped) throw new Error('the agent host is shutting down');
      this.bin ??= await this.options.installOpenCode!();
      return this.startServer(this.bin);
    })();
    this.clientPromise = attempt;
    attempt.then(
      () => {
        if (this.clientPromise === attempt) this.unavailable = undefined;
      },
      (err: unknown) => {
        this.options.log(`[opencode] unavailable: ${err instanceof Error ? err.message : String(err)}`);
        if (this.clientPromise === attempt) this.clientPromise = null;
      },
    );
  }

  /** Wait for the first provider profiles, at most `firstProvidersWaitMs`. */
  private providersArrived(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.firstProviders === arrived) {
          this.options.log('[opencode] no provider profiles arrived; starting the server without them');
        }
        arrived();
      }, this.options.firstProvidersWaitMs ?? FIRST_PROVIDERS_WAIT_MS);
      const arrived = (): void => {
        if (this.firstProviders === arrived) this.firstProviders = undefined;
        clearTimeout(timer);
        resolve();
      };
      this.firstProviders = arrived;
    });
  }

  /** The provider profiles to add to OpenCode's own providers, placed by
   *  its catalog (providers.ts); one that would shadow a provider OpenCode
   *  has is left out, with the reason. The server reads
   *  its config only when it starts, so a changed list restarts it:
   *  sessions on the old one end with an error and the bridge resumes them
   *  on the new one. The first list of a start with a kept catalog
   *  (catalogCache.ts) is placed against that catalog before the server
   *  starts, so the server starts once. */
  async setProviders(providers: ProviderBinding[]): Promise<RefusedProvider[]> {
    if (!this.manages) {
      throw new Error('OpenCode runs on a server this bridge does not start (CODEDECK_OPENCODE_SERVER_URL), so it cannot add provider profiles to it');
    }
    const apply = this.applying.then(() => this.applyProviders(providers));
    this.applying = apply.then(
      () => {},
      () => {},
    );
    return apply;
  }

  private async applyProviders(providers: ProviderBinding[]): Promise<RefusedProvider[]> {
    // A profile the bridge would not let a session use is not added either.
    const usable = providers.filter((p) => isValidProviderBaseUrl(p.baseUrl) && p.authToken !== '' && p.models.length > 0);
    const first = this.firstProviders;
    if (first) {
      // The first start is waiting for these: it starts with them, placed
      // against the kept catalog — filled in first, so that a refresh due
      // now is not a restart later — and is checked against its own below.
      this.catalog = await this.fillIn(usable, this.catalog);
      this.placed = placeProfiles(usable, this.catalog).placed;
      first();
    }
    // A server still being installed or started is waited for: it may have
    // read an older list, and its catalog places the profiles.
    await this.clientPromise?.catch(() => {});
    // What the running server lists, less what the profiles it runs with
    // added: the catalog a server without them would have.
    // The running server's config holds the profiles it was started with;
    // the ones just handed over are the other values a read failure may
    // quote, since the client sees the same config.
    const read = await this.readCatalog([
      ...this.placed.map((p) => p.profile.authToken),
      ...usable.map((p) => p.authToken),
    ]);
    const live = read && withoutProfiles(read, this.serving);
    // It keeps what models.dev filled in, which no server lists. A server
    // that cannot say keeps the catalog it was configured from: a restart
    // would only place the profiles knowing less.
    const known = live ? { ...withModels(live, this.catalog.models), ...filled(this.catalog) } : this.catalog;
    const catalog = await this.fillIn(usable, known, live);
    const { placed, refused } = placeProfiles(usable, catalog);
    this.placed = placed;
    this.catalog = catalog;
    if (live && this.options.catalogCache) writeCatalogCache(this.options.catalogCache, catalog, placed, this.options.log);
    if (this.stopped || !this.server || !this.bin || providersFingerprint(placed, catalog) === this.served) return refused;
    this.options.log('[opencode] restarting the server: its provider profiles changed');
    const old = this.server;
    this.server = null;
    this.launch(() => old.close());
    // A session holds the old server's client: its password stops working
    // and its event stream reconnects for ever to the new server, so it
    // would never end on its own. Ended now, the bridge resumes it on the
    // new server (OpenCode keeps the conversation on disk).
    const stale = [...this.sessions];
    this.sessions.clear();
    for (const session of stale) session.serverReplaced();
    await this.clientPromise;
    return refused;
  }

  /** `catalog` with the models.dev records of the profiles' own models it
   *  does not describe — asked for once per process, and not again for a
   *  day once it has filled a catalog in. */
  private async fillIn(profiles: ProviderBinding[], catalog: Catalog, live?: Catalog): Promise<Catalog> {
    const source = modelsDevSource(process.env);
    const http = this.options.providerHttp;
    if (!source || !http) return catalog;
    if (catalog.filledAt !== undefined && Date.now() - catalog.filledAt < MODELS_DEV_TTL_MS) return catalog;
    const unknown = placeProfiles(profiles, catalog)
      .placed.filter((p) => !p.known)
      .some((p) => p.profile.models.some((m) => !catalogModel(catalog, m, new Set())));
    if (!unknown) return catalog;
    this.modelsDev ??= fetchModelsDev(source, http.get, this.options.log);
    const listed = await this.modelsDev;
    if (listed.size === 0) {
      // Not had: the next list asks again.
      this.modelsDev = undefined;
      return catalog;
    }
    // A fresh list replaces what an earlier one filled in; what the server
    // itself describes stands over both. The day counts whether or not the
    // list had the model: one it lacks is not asked about again until then.
    return { ...catalog, models: new Map([...catalog.models, ...listed, ...(live?.models ?? [])]), filledAt: Date.now() };
  }

  /** The running server's catalog (catalog.ts). None when it cannot say:
   *  with no other to go by, every profile is then a provider of its own,
   *  nothing refused or filled in. */
  private async readCatalog(secrets: readonly string[] = this.placed.map((p) => p.profile.authToken)): Promise<Catalog | undefined> {
    try {
      const client = await this.clientPromise;
      if (!client) return undefined;
      // The providers it can use, and their models; every other provider
      // it knows only by name until asked for it, one at a time.
      const [integrations, available, models] = await Promise.all([client.integration.list(), client.provider.list(), client.model.list()]);
      const providers = new Map(available.data.map((p) => [p.id, p]));
      const others = integrations.data.map((i) => i.id).filter((id) => !providers.has(id));
      await eachLimited(others, 8, async (id) => {
        try {
          const provider = (await client.provider.get({ providerID: id })).data;
          providers.set(provider.id, provider);
        } catch (err) {
          // An integration that is no model provider (a web search) is not
          // found; any other failure leaves the read incomplete, and a
          // provider missing from it would move the profiles placed by it.
          if (!isNotFound(err)) throw err;
        }
      });
      return {
        // By id: the first provider listing a model is the one a profile
        // model is filled in from, so the order may not depend on which
        // answer came back first.
        providers: new Map([...providers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        models: new Map(models.data.map((m) => [`${m.providerID}/${m.modelID}`, serverModel(m)])),
        connected: new Set(available.data.map((p) => p.id)),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.options.log(
        `[opencode] could not read its provider catalog, so profiles are not checked against it: ${redactSecrets(reason, secrets)}`,
      );
      return undefined;
    }
  }

  info(): AgentInfo {
    return {
      id: OPENCODE_AGENT_ID,
      displayName: 'OpenCode',
      modes: OPENCODE_MODES,
      efforts: [],
      defaultMode: DEFAULT_MODE,
      // Every OpenCode session runs as one of its primary agents; `build` is
      // the one it uses when the phone names none.
      defaultPersona: BUILD_AGENT,
      // Usage is the session's cost. Provider profiles add models to the
      // server this driver starts; sessions are never bound to one.
      supports: {
        models: true,
        usage: true,
        providers: false,
        providerModels: this.manages,
        interrupt: true,
        commands: true,
        plugins: true,
        mcp: true,
        tasks: true,
        permissionRules: true,
        // Through the server's own API, so a key or a sign-in reaches a
        // running server without the restart a provider profile costs.
        accounts: true,
        // Its own primary agents: the named configurations a session runs as.
        personas: true,
      },
      credentials: [],
      ...(this.unavailable ? { unavailableReason: this.unavailable } : {}),
      style: OPENCODE_STYLE,
    };
  }

  startSession(params: StartSession, ctx: SessionContext): DriverSession {
    if (params.provider) throw new Error('OpenCode offers provider profiles as models; a session is not bound to one');
    // A start that failed, or a server that exited, leaves `bin` known and
    // the cache empty: the next session tries a new server rather than
    // failing until the bridge restarts.
    if (!this.clientPromise && !this.stopped && (this.bin || this.installs)) this.launch();
    if (!this.clientPromise) throw new Error(this.unavailable ?? NOT_CONFIGURED);
    if (params.mode !== undefined && !OPENCODE_MODES.some((m) => m.id === params.mode)) {
      throw new Error(`OpenCode has no mode '${params.mode}'`);
    }
    if (params.model && !splitModelId(params.model)) {
      throw new Error(`'${params.model}' is not an OpenCode provider/model id — choose one from its model list.`);
    }
    const session = new OpenCodeSession(params, ctx, this.clientPromise, { catalog: () => this.listModels() });
    for (const s of this.sessions) if (s.isEnded) this.sessions.delete(s);
    this.sessions.add(session);
    return session;
  }

  /** A profile is reached as an OpenAI-compatible provider: a session on
   *  it posts chat completions. */
  async checkProvider(provider: ProviderBinding, model: string): Promise<boolean | undefined> {
    return this.options.providerHttp ? checkToken(OPENAI_API, provider, model, this.options.providerHttp.post) : undefined;
  }

  /** The personas of the whole machine: the selectable agents in the
   *  server's own directory, which is its built-ins plus every global
   *  agent. A new session can start as any of them, wherever it runs. */
  async listPersonas(): Promise<Persona[]> {
    if (!this.clientPromise) return [];
    const client = await this.clientPromise;
    // `agent.list` alone does not boot the server's own directory: ask for
    // it first, or only the built-ins answer.
    this.personasBootedAt ??= Date.now();
    await client.location.get().catch(() => undefined);
    return listSelectablePersonas(client, undefined, this.personasBootedAt + PERSONA_LOAD_MS);
  }

  async listProviderModels(baseUrl: string, token: string): Promise<EndpointModel[]> {
    if (!this.options.providerHttp) throw new Error('this host reads no provider endpoints');
    return listModels(OPENAI_API, baseUrl, token, this.options.providerHttp.get);
  }

  /** Best-effort model list from OpenCode's configured providers, and the
   *  default among them (see pickDefaultModel) — empty on any failure. Ids
   *  are `<providerID>/<modelID>`, the shape a session expects. */
  async listModels(): Promise<OpenCodeCatalog> {
    if (!this.clientPromise) return { models: [] };
    try {
      const client = await this.clientPromise;
      const listed = await client.model.list();
      // The default is an extra: a server that cannot name one still lists
      // its models, and a list without a default is worth more than none.
      let fallback: { data?: { providerID: string; modelID: string } | null } | null = null;
      try {
        fallback = await client.model.default();
      } catch {
        fallback = null;
      }
      const models: ModelEntry[] = [];
      const contextLimits: Record<string, number> = {};
      const profiles = new Map(this.placed.map((p) => [p.providerId, p.profile]));
      for (const model of listed.data) {
        if (!model.enabled) continue;
        const id = `${model.providerID}/${model.modelID}`;
        const profile = profiles.get(model.providerID);
        const group = profile
          ? profileModelGroup(profile.label || model.providerID, profile.models.find((m) => m.id === model.modelID))
          : model.providerID;
        const efforts = reasoningLevels(model.variants);
        models.push({ id, label: model.name, provider: group, ...(efforts.length > 0 ? { efforts } : {}) });
        const window = model.limit?.context ?? 0;
        if (window > 0) contextLimits[id] = window;
      }
      const configured = fallback?.data ? `${fallback.data.providerID}/${fallback.data.modelID}` : undefined;
      const defaultModel = pickDefaultModel(configured, listed.data);
      return { models, contextLimits, ...(defaultModel ? { defaultModel } : {}) };
    } catch {
      return { models: [] };
    }
  }

  /** OpenCode deletes a session's subagent sessions with it. */
  async deleteConversation(conversationId: string, cwd: string): Promise<void> {
    const client = await this.client();
    try {
      await client.session.remove({ sessionID: conversationId });
    } catch (err) {
      // A session already gone is the outcome that was wanted.
      if (isNotFound(err)) return;
      throw new Error(`OpenCode could not delete session ${conversationId}: ${formatOpenCodeError(err)}`);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    // A start still waiting for the profiles gives up rather than start.
    this.firstProviders?.();
    this.accounts.close();
    await this.server?.close();
  }
}
