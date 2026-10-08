/**
 * OpenCode's catalog of providers and their models — models.dev, which
 * OpenCode ships and keeps current, plus what the operator configured — as
 * its server lists it (`GET /provider`). A provider profile learns two
 * things from it:
 *
 *  - whether its endpoint is a provider OpenCode already knows (DeepSeek,
 *    OpenRouter, Moonshot…), by the base URL the catalog records for it;
 *    such a profile signs in to that provider, the way `/connect` would,
 *    and gets the catalog's models, prices and limits whole;
 *  - what its models are, when the endpoint is a gateway: a routed
 *    `OpenCode Go/deepseek-v4.1-flash` is the catalog's OpenCode Go model,
 *    whose context and output limits, reasoning (and with it OpenCode's
 *    reasoning levels), tool calls and image input the gateway's model list
 *    never says. Prices are left out: a gateway's are its own (a
 *    subscription, a local model, a markup), not the upstream's list price.
 */
import type { Model, Provider } from '@opencode-ai/sdk/v2/client';
import type { ProviderModel } from '../../sdk/types';

/** `name` as an OpenCode provider id: lower case, each run of anything but
 *  letters and digits one `-` (a `/` would split its model ids). */
export function providerIdOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface Catalog {
  /** Every provider OpenCode knows, by id. */
  providers: ReadonlyMap<string, Provider>;
  /** Those it can already use: configured, signed in to, or given a key in
   *  its environment. */
  connected: ReadonlySet<string>;
}

export const EMPTY_CATALOG: Catalog = { providers: new Map(), connected: new Set() };

/** A base URL as endpoints are compared: lower case, without a trailing
 *  slash or `/v1` (both spellings are common for one endpoint). */
export function endpointKey(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** The base URLs a catalog provider is served at. */
function providerEndpoints(provider: Provider): string[] {
  const urls = Object.values(provider.models).map((m) => m.api?.url);
  const configured = (provider.options as { baseURL?: unknown } | undefined)?.baseURL;
  if (typeof configured === 'string') urls.push(configured);
  return [...new Set(urls.filter((u): u is string => typeof u === 'string' && u.trim() !== '').map(endpointKey))];
}

/** The catalog provider served at `baseUrl`, leaving out the `skip` ids
 *  (the providers profiles themselves became). */
export function knownProviderAt(catalog: Catalog, baseUrl: string, skip: ReadonlySet<string>): Provider | undefined {
  const key = endpointKey(baseUrl);
  for (const provider of catalog.providers.values()) {
    if (!skip.has(provider.id) && providerEndpoints(provider).includes(key)) return provider;
  }
  return undefined;
}

/** The catalog's record of a profile model: under the provider a gateway
 *  routes it to when the endpoint names one (by name or id), else under the
 *  first provider that lists its id. */
export function catalogModel(catalog: Catalog, model: ProviderModel, skip: ReadonlySet<string>): Model | undefined {
  const upstream = model.provider?.trim();
  if (upstream) {
    const bare = model.id.startsWith(`${upstream}/`) ? model.id.slice(upstream.length + 1) : model.id;
    const wanted = upstream.toLowerCase();
    const slug = providerIdOf(upstream);
    for (const provider of catalog.providers.values()) {
      if (skip.has(provider.id)) continue;
      if (provider.name.toLowerCase() === wanted || provider.id === slug) {
        const found = provider.models[bare];
        if (found) return found;
      }
    }
  }
  for (const provider of catalog.providers.values()) {
    if (skip.has(provider.id)) continue;
    const found = provider.models[model.id];
    if (found) return found;
  }
  return undefined;
}

type Modality = 'text' | 'audio' | 'image' | 'video' | 'pdf';

function modalities(flags: Record<Modality, boolean>): Modality[] {
  return (Object.keys(flags) as Modality[]).filter((k) => flags[k]);
}

/**
 * A profile model as OpenCode's config holds it: named without the upstream
 * provider its group already shows, with what the catalog knows of it
 * (`known`) — never its prices. The endpoint's own context window wins over
 * the catalog's; without any, the limits stay unset, OpenCode's "unknown".
 */
export function profileModelConfig(model: ProviderModel, known: Model | undefined): Record<string, unknown> {
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
          reasoning: known.capabilities.reasoning,
          tool_call: known.capabilities.toolcall,
          temperature: known.capabilities.temperature,
          attachment: known.capabilities.attachment,
          modalities: { input: modalities(known.capabilities.input), output: modalities(known.capabilities.output) },
        }
      : {}),
  };
}
