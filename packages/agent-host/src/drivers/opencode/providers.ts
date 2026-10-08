/**
 * Provider profiles as OpenCode providers.
 *
 * A profile adds a provider to OpenCode — beside OpenCode Zen and whatever
 * the operator configured, which all stay. OpenCode takes a provider only
 * from its config, so the profiles reach the server this driver starts as
 * config handed over in its environment, on top of the operator's files
 * (which are never written). Each profile is placed one of two ways, by
 * what OpenCode's catalog knows (catalog.ts):
 *
 *  - an endpoint the catalog knows (DeepSeek's API, OpenRouter's…) signs in
 *    to that provider, as `/connect` would: the catalog's models, prices
 *    and limits, under the name the user gave the profile, plus any model
 *    the endpoint lists that the catalog does not;
 *  - any other endpoint (a gateway, a local server) is an OpenAI-compatible
 *    provider of its own, its id the profile's name in lower case (`CCR` is
 *    `ccr`, its models `ccr/<model>`), its models what the endpoint listed,
 *    each filled in from the catalog where it knows the model.
 *
 * A profile is left out, with the reason, rather than shadow a provider
 * OpenCode already has: one it is already signed in to, or one whose id the
 * profile's name would take, or another profile's. Each token sits in the
 * server's environment only, referenced from the config; the server answers
 * only with a password made for it, since its API reads its config — the
 * tokens included — back to anyone on loopback who asks.
 *
 * The server reads its config when it starts, so a changed profile list
 * means a new server (see the driver).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Provider } from '@opencode-ai/sdk/v2/client';
import { providerApiRoot } from '../../sdk/providerModels';
import type { ProviderBinding, ProviderModel, RefusedProvider } from '../../sdk/types';
import { type Catalog, catalogModel, EMPTY_CATALOG, knownProviderAt, profileModelConfig, providerIdOf } from './catalog';

/** The user name OpenCode's server expects with its password. */
const SERVER_USERNAME = 'opencode';

/** Where a profile sits among OpenCode's providers. */
export interface Placement {
  profile: ProviderBinding;
  /** Its OpenCode provider id: the catalog's for a provider OpenCode knows,
   *  else its name's. */
  providerId: string;
  /** The catalog provider it signs in to, when OpenCode knows its endpoint. */
  known?: Provider;
}

/** What profiles already are in a running server, so they are not taken
 *  for OpenCode's own providers. */
export interface Served {
  /** Every provider id profiles took. */
  ids: ReadonlySet<string>;
  /** Those that are a profile's own provider, not one of the catalog's. */
  own: ReadonlySet<string>;
}

export const NOTHING_SERVED: Served = { ids: new Set(), own: new Set() };

/** The provider id a profile of its own takes: its name's, or its id's
 *  when the name has no letter or digit. */
export function profileProviderId(profile: ProviderBinding): string {
  return providerIdOf(profile.label) || providerIdOf(profile.id) || 'provider';
}

/**
 * Where each of `profiles` goes, in order, against what OpenCode has
 * (`catalog`) and what earlier profiles took (`served`, not OpenCode's own);
 * a profile that would shadow a provider is refused with the reason.
 */
export function placeProfiles(
  profiles: ProviderBinding[],
  catalog: Catalog,
  served: Served = NOTHING_SERVED,
): { placed: Placement[]; refused: RefusedProvider[] } {
  const placed: Placement[] = [];
  const refused: RefusedProvider[] = [];
  const taken = new Map<string, ProviderBinding>();
  for (const profile of profiles) {
    const known = knownProviderAt(catalog, profile.baseUrl, served.own);
    const providerId = known?.id ?? profileProviderId(profile);
    const earlier = taken.get(providerId);
    const theirs = !served.ids.has(providerId);
    let reason: string | undefined;
    if (earlier) {
      reason = known
        ? `The provider profile '${earlier.label}' already signs OpenCode in to ${known.name}.`
        : `The provider profile '${earlier.label}' already goes by '${providerId}' in OpenCode. Give this one another name.`;
    } else if (known && theirs && catalog.connected.has(providerId)) {
      reason = `OpenCode already uses ${known.name} with a key of its own; this profile would replace it.`;
    } else if (!known && theirs && catalog.providers.has(providerId)) {
      reason = `OpenCode already has a provider called '${providerId}'. Give this profile another name.`;
    }
    if (reason) {
      refused.push({ id: profile.id, reason });
      continue;
    }
    taken.set(providerId, profile);
    placed.push({ profile, providerId, ...(known ? { known } : {}) });
  }
  return { placed, refused };
}

/** What `placed` makes of a running server's providers. */
export function servedBy(placed: Placement[]): Served {
  return {
    ids: new Set(placed.map((p) => p.providerId)),
    own: new Set(placed.filter((p) => !p.known).map((p) => p.providerId)),
  };
}

/** The variable profile `index`'s token reaches the server in. */
function tokenVariable(index: number): string {
  return `CODEDECK_PROVIDER_KEY_${index}`;
}

/** One placed profile's provider entry. */
function providerEntry(placement: Placement, index: number, catalog: Catalog, served: Served): Record<string, unknown> {
  const { profile, known } = placement;
  const apiKey = `{env:${tokenVariable(index)}}`;
  if (known) {
    // The catalog's models stand; the endpoint's others join them.
    const extra = profile.models.filter((m) => !known.models[m.id]);
    return {
      name: profile.label || known.name,
      options: { apiKey },
      ...(extra.length > 0 ? { models: Object.fromEntries(extra.map((m) => [m.id, profileModelConfig(m, undefined)])) } : {}),
    };
  }
  return {
    npm: '@ai-sdk/openai-compatible',
    name: profile.label || profile.id,
    options: { baseURL: providerApiRoot(profile.baseUrl), apiKey },
    models: Object.fromEntries(profile.models.map((m) => [m.id, profileModelConfig(m, catalogModel(catalog, m, served.own))])),
  };
}

/** The provider entries for `placed`, on top of `base` (an operator's own
 *  `OPENCODE_CONFIG_CONTENT`, whose providers stay). */
export function providersConfig(
  placed: Placement[],
  catalog: Catalog = EMPTY_CATALOG,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const own = (base.provider ?? {}) as Record<string, unknown>;
  const served = servedBy(placed);
  const added = Object.fromEntries(placed.map((p, index) => [p.providerId, providerEntry(p, index, catalog, served)]));
  return { ...base, provider: { ...own, ...added } };
}

/** The group a profile model is listed under: the profile, and the
 *  provider a gateway routes the model to when the endpoint names one. */
export function profileModelGroup(profile: string, model: ProviderModel | undefined): string {
  return model?.provider ? `${profile} · ${model.provider}` : profile;
}

/** What the server is started with to serve the profiles, and how its
 *  client signs in. */
export interface ServerSetup {
  env: Record<string, string>;
  headers: Record<string, string>;
}

/** The environment and credentials of a server for `placed` — and, for
 *  every model, web search. `baseEnv` is the host's own environment. */
export function serverSetup(placed: Placement[], catalog: Catalog, baseEnv: NodeJS.ProcessEnv): ServerSetup {
  const password = randomBytes(24).toString('hex');
  const env: Record<string, string> = {
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
    // OpenCode offers its web search only on its own providers unless this
    // is set; with it, every model can search (Exa's keyless endpoint,
    // still behind the `websearch` permission).
    OPENCODE_ENABLE_EXA: '1',
  };
  if (placed.length > 0) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(providersConfig(placed, catalog, operatorConfig(baseEnv)));
    placed.forEach(({ profile }, index) => {
      env[tokenVariable(index)] = profile.authToken;
    });
  }
  const headers = { authorization: `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString('base64')}` };
  return { env, headers };
}

/** The config the operator handed OpenCode in the environment, if any. */
function operatorConfig(baseEnv: NodeJS.ProcessEnv): Record<string, unknown> {
  const raw = baseEnv.OPENCODE_CONFIG_CONTENT;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What makes two placements need different servers: everything their
 *  config is built from. Hashed, so the tokens are not kept around in it. */
export function providersFingerprint(placed: Placement[]): string {
  const parts = placed.map(({ profile: p, providerId }) => [providerId, p.id, p.label, p.baseUrl, p.authToken, p.models]);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
