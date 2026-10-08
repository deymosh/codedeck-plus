/**
 * OpenCode servers for sessions bound to a provider profile.
 *
 * A profile is an OpenAI-compatible endpoint, its token and its models;
 * OpenCode reaches one as a custom provider in its config. The machine's
 * own server cannot take it: its config is the operator's file, shared by
 * every session, and anything written there (the token included) would stay
 * on disk and reach every other session. So each profile in use gets an
 * OpenCode server of its own, whose config is handed over in the
 * environment when it starts — the operator's config files still load
 * underneath (MCP servers, plugins, agents), with the profile on top:
 *
 *  - the profile's endpoint is the only provider enabled, and it is the
 *    model and small model, so nothing in the session (titles and subagents
 *    included) falls back to the operator's own accounts;
 *  - the token is in the server's environment only, referenced from the
 *    config, never in a file;
 *  - the server answers only with a password made for it, since its API
 *    reads its config — the token included — back to anyone on loopback
 *    who asks.
 *
 * A server lives while sessions run on it and a little after, so a restart
 * or the next session reuses it; a changed profile (a new token, other
 * models) gets a new server, and the old one goes once its sessions end.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { providerApiRoot } from '../../sdk/providerModels';
import type { ProviderBinding } from '../../sdk/types';

/** The provider id a profile has inside its server; a session's model ids
 *  are the profile's own, and its prompts name them under this. */
export const PROFILE_PROVIDER_ID = 'codedeck';
/** The variable the profile's token reaches its server in. */
export const PROFILE_TOKEN_ENV = 'CODEDECK_PROVIDER_API_KEY';
/** The user name OpenCode's server expects with its password. */
const SERVER_USERNAME = 'opencode';
/** How long a server with no session on it is kept for the next one. */
export const PROFILE_SERVER_IDLE_MS = 5 * 60_000;

/** A started server: where it listens, when it exits, how to stop it. */
export interface StartedServer {
  url: string;
  exited: Promise<void>;
  close(): Promise<void>;
}

/** Starts `opencode serve` with `env` added to the host's environment. */
export type StartServer = (env: Record<string, string>) => Promise<StartedServer>;

/** A client of one profile's server, held until `release`. */
export interface ProfileLease {
  client: Promise<OpencodeClient>;
  /** Idempotent. */
  release(): void;
}

/** The config a profile's server starts with, on top of the operator's. */
export function profileConfig(provider: ProviderBinding): Record<string, unknown> {
  const fallback = provider.defaultModel ?? provider.models[0]?.id;
  return {
    enabled_providers: [PROFILE_PROVIDER_ID],
    ...(fallback ? { model: `${PROFILE_PROVIDER_ID}/${fallback}`, small_model: `${PROFILE_PROVIDER_ID}/${fallback}` } : {}),
    provider: {
      [PROFILE_PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: provider.id,
        options: { baseURL: providerApiRoot(provider.baseUrl), apiKey: `{env:${PROFILE_TOKEN_ENV}}` },
        models: Object.fromEntries(provider.models.map((m) => [m.id, m.label ? { name: m.label } : {}])),
      },
    },
  };
}

interface Entry {
  client: Promise<OpencodeClient>;
  server: Promise<StartedServer>;
  leases: number;
  idle?: ReturnType<typeof setTimeout>;
}

export interface ProfileServersOptions {
  start: StartServer;
  log: (message: string) => void;
  idleMs?: number;
  /** Builds the client of a started server (a seam for tests). */
  connect?: (url: string, headers: Record<string, string>) => OpencodeClient;
}

export class ProfileServers {
  private readonly servers = new Map<string, Entry>();
  private closed = false;

  constructor(private readonly options: ProfileServersOptions) {}

  /** A client of the server for `provider`, starting one when none runs. */
  acquire(provider: ProviderBinding): ProfileLease {
    if (this.closed) return { client: Promise.reject(new Error('the agent host is shutting down')), release: () => {} };
    const key = fingerprint(provider);
    let entry = this.servers.get(key);
    if (!entry) entry = this.launch(key, provider);
    clearTimeout(entry.idle);
    entry.idle = undefined;
    entry.leases += 1;
    const held = entry;
    let released = false;
    return {
      client: held.client,
      release: () => {
        if (released) return;
        released = true;
        held.leases -= 1;
        if (held.leases === 0 && this.servers.get(key) === held) {
          held.idle = setTimeout(() => this.retire(key, held), this.options.idleMs ?? PROFILE_SERVER_IDLE_MS);
          held.idle.unref?.();
        }
      },
    };
  }

  /** Stop every server. */
  async closeAll(): Promise<void> {
    this.closed = true;
    const entries = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      entries.map(async (entry) => {
        clearTimeout(entry.idle);
        await entry.server.then((s) => s.close(), () => {});
      }),
    );
  }

  private launch(key: string, provider: ProviderBinding): Entry {
    const password = randomBytes(24).toString('hex');
    const server = this.options.start({
      OPENCODE_CONFIG_CONTENT: JSON.stringify(profileConfig(provider)),
      [PROFILE_TOKEN_ENV]: provider.authToken,
      OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
      OPENCODE_SERVER_PASSWORD: password,
    });
    const headers = { authorization: `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString('base64')}` };
    const connect = this.options.connect ?? ((url, h) => createOpencodeClient({ baseUrl: url, headers: h }));
    const entry: Entry = { server, client: server.then((s) => connect(s.url, headers)), leases: 0 };
    this.servers.set(key, entry);
    server.then(
      (s) => {
        this.options.log(`[opencode] started ${s.url} for provider profile '${provider.id}'`);
        // A server that died is forgotten, so the next session starts another.
        void s.exited.then(() => {
          if (this.servers.get(key) === entry) this.servers.delete(key);
        });
      },
      (error: unknown) => {
        this.options.log(
          `[opencode] the server for provider profile '${provider.id}' failed to start: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (this.servers.get(key) === entry) this.servers.delete(key);
      },
    );
    return entry;
  }

  private retire(key: string, entry: Entry): void {
    if (this.servers.get(key) !== entry || entry.leases > 0) return;
    this.servers.delete(key);
    void entry.server.then((s) => s.close(), () => {});
  }
}

/** What makes two profiles need different servers: everything their
 *  config is built from. Hashed, so the token is not kept as a map key. */
function fingerprint(provider: ProviderBinding): string {
  const parts = [provider.id, provider.baseUrl, provider.authToken, provider.defaultModel ?? '', provider.models];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
