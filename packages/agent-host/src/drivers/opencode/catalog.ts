/**
 * OpenCode's catalog of providers and their models — the models.dev data
 * OpenCode keeps for itself, plus what the operator configured — as its
 * server lists it (`provider.list` for the providers, `model.list` for the
 * models). A provider profile learns two things from it:
 *
 *  - whether its endpoint is a provider OpenCode already knows (DeepSeek,
 *    OpenRouter, Moonshot…), by the base URL the catalog records for it;
 *    such a profile signs in to that provider, the way `/connect` would,
 *    and gets the catalog's models, prices and limits whole;
 *  - what its models are, when the endpoint is a gateway: a routed
 *    `OpenCode Go/deepseek-v4.1-flash` is the catalog's OpenCode Go model,
 *    whose context and output limits, tool calls and image input the
 *    gateway's model list never says. Its prices come along as a reference
 *    only: what the user is billed is the gateway's own arrangement.
 */
import type { ModelInfo, ProviderInfo } from '@opencode/client';
import type { ProviderModel } from '../../sdk/types';

/** `name` as an OpenCode provider id: lower case, each run of anything but
 *  letters and digits one `-` (a `/` would split its model ids). */
export function providerIdOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface Catalog {
  /** Every provider OpenCode knows, by id. */
  providers: ReadonlyMap<string, ProviderInfo>;
  /** Every model OpenCode can run, by `<providerID>/<modelID>` — its own
   *  models.dev record, whether or not the operator has a key for it. */
  models: ReadonlyMap<string, ModelInfo>;
  /** Those it can already use: configured, signed in to, or given a key in
   *  its environment. */
  connected: ReadonlySet<string>;
}

export const EMPTY_CATALOG: Catalog = { providers: new Map(), models: new Map(), connected: new Set() };

/** A base URL as endpoints are compared: lower case, without a trailing
 *  slash or `/v1` (both spellings are common for one endpoint). */
export function endpointKey(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** The base URL a catalog provider is served at, when its record names one. */
function providerEndpoint(provider: ProviderInfo): string | undefined {
  const url = provider.settings?.baseURL;
  return typeof url === 'string' && url.trim() !== '' ? endpointKey(url) : undefined;
}

/** The catalog provider served at `baseUrl`, leaving out the `skip` ids
 *  (the providers profiles themselves became). */
export function knownProviderAt(catalog: Catalog, baseUrl: string, skip: ReadonlySet<string>): ProviderInfo | undefined {
  const key = endpointKey(baseUrl);
  for (const provider of catalog.providers.values()) {
    if (!skip.has(provider.id) && providerEndpoint(provider) === key) return provider;
  }
  return undefined;
}

/** The catalog's record of a profile model: under the provider a gateway
 *  routes it to when the endpoint names one (by name or id), else under the
 *  first provider that lists its id. */
export function catalogModel(catalog: Catalog, model: ProviderModel, skip: ReadonlySet<string>): ModelInfo | undefined {
  const byId = (providerId: string, id: string) => catalog.models.get(`${providerId}/${id}`);
  const upstream = model.provider?.trim();
  if (upstream) {
    const bare = model.id.startsWith(`${upstream}/`) ? model.id.slice(upstream.length + 1) : model.id;
    const wanted = upstream.toLowerCase();
    const slug = providerIdOf(upstream);
    for (const provider of catalog.providers.values()) {
      if (skip.has(provider.id)) continue;
      if (provider.name.toLowerCase() === wanted || provider.id === slug) {
        const found = byId(provider.id, bare);
        if (found) return found;
      }
    }
  }
  for (const provider of catalog.providers.values()) {
    if (skip.has(provider.id)) continue;
    const found = byId(provider.id, model.id);
    if (found) return found;
  }
  return undefined;
}

/**
 * A profile model as OpenCode's config holds it: named without the upstream
 * provider its group already shows, with what the catalog knows of it
 * (`known`) — never its prices. The endpoint's own context window wins over
 * the catalog's; without any, the limits stay unset, OpenCode's "unknown".
 *
 * V2 states what a model can do as `capabilities` and how it can reason as
 * its `variants`; both are copied whole from the catalog record, since a
 * gateway's own model list never describes either.
 */
export function profileModelConfig(model: ProviderModel, known: ModelInfo | undefined): Record<string, unknown> {
  const name =
    model.label ??
    (model.provider && model.id.startsWith(`${model.provider}/`) ? model.id.slice(model.provider.length + 1) : undefined) ??
    known?.name;
  const context = model.contextWindow || known?.limit.context || 0;
  return {
    ...(name ? { name } : {}),
    ...(context > 0 ? { limit: { context, output: known?.limit.output ?? 0 } } : {}),
    ...(known
      ? {
          ...(known.family ? { family: known.family } : {}),
          capabilities: known.capabilities,
          ...(known.variants.length > 0 ? { variants: known.variants } : {}),
          // The catalog's prices ride along as a reference. A gateway's own
          // price is its own (a subscription, a markup, a local model), so
          // this is not what the user is billed — but a session cost figured
          // from the upstream list price is more use on the phone than none,
          // and an endpoint that reports its own cost overrides it.
          ...(known.cost.length > 0 ? { cost: known.cost } : {}),
        }
      : {}),
  };
}
