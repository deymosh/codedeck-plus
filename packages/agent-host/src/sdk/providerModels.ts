/**
 * The models an endpoint serves, read from its `/v1/models`.
 *
 * The endpoint is whatever an agent is pointed at: a provider's own API
 * (DeepSeek, Moonshot, OpenRouter) or a gateway in front of several
 * (claude-code-router, LiteLLM). Both answer the same OpenAI-shaped list,
 * and only the endpoint can say what it serves — so drivers ask it rather
 * than keep model names of their own.
 *
 * A gateway's ids commonly name the upstream before the model
 * (`Z.ai (Global) - Coding Plan/glm-5.3-flash`): that prefix is the
 * gateway's own routing key, needed verbatim on every request, so the id is
 * kept whole and the prefix is reported as the model's `provider` for
 * grouping only. A provider's own vendor-prefixed ids (OpenRouter's
 * `deepseek/deepseek-chat`) read the same way.
 */
import type { HttpGet } from './net';

/** One model an endpoint serves. */
export interface EndpointModel {
  /** What a request names the model by — never rewritten. */
  id: string;
  /** The endpoint's own name for it, without the `provider` prefix; absent
   *  when it gives none (or gives the id again). */
  label?: string;
  /** The part of the id before its first `/`, when there is one. */
  provider?: string;
  /** Input tokens the model accepts, when the endpoint says. */
  contextWindow?: number;
  /** Whether it has the 1M-token window, when the endpoint says so in so
   *  many words (a flag, or the `[1m]` id marker) rather than by size. */
  oneMillionContext?: boolean;
}

/** How many models are kept: the list is for a phone screen. */
export const MAX_ENDPOINT_MODELS = 200;

/**
 * An endpoint's versioned API root: its base URL with `/v1` appended,
 * unless it already ends in `/v1` (both spellings are common, and every
 * agent that takes a base URL accepts one or the other). OpenAI-style
 * clients post to `<root>/chat/completions`.
 */
export function providerApiRoot(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`;
}

/** Where an endpoint lists its models: `<root>/models`. */
export function providerModelsUrl(baseUrl: string): string {
  return `${providerApiRoot(baseUrl)}/models`;
}

/** claude-code-router's id for a model as it lists it to Claude Code:
 *  `anthropic/claude-ccr-h<hex>`, the hex being the router's own
 *  `<provider>/<model>` id in UTF-8. */
const CCR_ENCODED_ID = /^(?:anthropic\/)?claude-ccr-h((?:[0-9a-f]{2})+)$/i;
/** The marker a 1M-context variant's id carries. */
const ONE_MILLION_MARKER = /\[1m\]$/i;

/**
 * The models in an endpoint's answer: the OpenAI-shaped `data` array, a
 * `models` array or a bare array, of objects with an `id` or of plain id
 * strings. Duplicates, blanks and anything that is not a model are
 * dropped; an answer that is not a list yields nothing.
 */
export function parseProviderModels(body: unknown): EndpointModel[] {
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null
      ? ((body as { data?: unknown }).data ?? (body as { models?: unknown }).models)
      : undefined;
  if (!Array.isArray(list)) return [];
  const models: EndpointModel[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const entry = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
    const listed = typeof raw === 'string' ? raw : entry?.id;
    if (typeof listed !== 'string' || listed.trim() === '') continue;
    const marked = ONE_MILLION_MARKER.test(listed);
    const bare = listed.replace(ONE_MILLION_MARKER, '');
    const hex = CCR_ENCODED_ID.exec(bare)?.[1];
    const id = (hex && Buffer.from(hex, 'hex').toString('utf8')) || bare;
    if (seen.has(id)) {
      // The same model listed with and without the 1M marker: one entry,
      // which has the window.
      if (marked) {
        const known = models.find((m) => m.id === id);
        if (known && known.oneMillionContext === undefined) known.oneMillionContext = true;
      }
      continue;
    }
    seen.add(id);
    const slash = id.indexOf('/');
    const provider = slash > 0 && slash < id.length - 1 ? id.slice(0, slash) : undefined;
    const label = entry ? labelOf(entry, id, provider) : undefined;
    const contextWindow = entry ? contextWindowOf(entry) : undefined;
    const flag = entry ? oneMillionFlag(entry) : undefined;
    const oneMillionContext = flag ?? (marked ? true : undefined);
    models.push({
      id,
      ...(label ? { label } : {}),
      ...(provider ? { provider } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(oneMillionContext !== undefined ? { oneMillionContext } : {}),
    });
    if (models.length >= MAX_ENDPOINT_MODELS) break;
  }
  return models;
}

/** The entry's own name (`display_name`, else `name`), without a leading
 *  `<provider>/`; nothing when it only repeats the id. */
function labelOf(entry: Record<string, unknown>, id: string, provider: string | undefined): string | undefined {
  const named = [entry.display_name, entry.name].find((n): n is string => typeof n === 'string' && n.trim() !== '');
  if (!named) return undefined;
  const label = provider && named.startsWith(`${provider}/`) ? named.slice(provider.length + 1) : named;
  return label === id ? undefined : label;
}

/** A model's context size, when the endpoint states one (they spell it
 *  several ways; 0 means "unknown" to some). */
function contextWindowOf(entry: Record<string, unknown>): number | undefined {
  const window = (entry.capabilities as { context_window?: Record<string, unknown> } | undefined)?.context_window;
  for (const value of [
    entry.context_window,
    entry.context_length,
    entry.contextWindow,
    entry.max_input_tokens,
    window?.max_input_tokens,
  ]) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

function oneMillionFlag(entry: Record<string, unknown>): boolean | undefined {
  const window = (entry.capabilities as { context_window?: Record<string, unknown> } | undefined)?.context_window;
  return typeof window?.supports_1m_context === 'boolean' ? window.supports_1m_context : undefined;
}

export interface FetchProviderModelsOptions {
  /** Sent as a Bearer token, when given. */
  token?: string;
  /** Any further request headers. */
  headers?: Record<string, string>;
  httpGet: HttpGet;
  /** Where a failure is reported; `tag` prefixes each line. */
  log: (message: string) => void;
  tag: string;
}

/**
 * The models the endpoint at `baseUrl` serves. Rejects with the reason, in
 * words for a person, when there is no list: not a URL, unreachable,
 * refused, an answer that is not a model list, or an empty one.
 */
export async function readProviderModels(
  baseUrl: string,
  options: Pick<FetchProviderModelsOptions, 'token' | 'headers' | 'httpGet'>,
): Promise<EndpointModel[]> {
  let url: string;
  try {
    url = providerModelsUrl(baseUrl);
  } catch {
    throw new Error(`'${baseUrl}' is not a URL`);
  }
  let response: Awaited<ReturnType<HttpGet>>;
  try {
    response = await options.httpGet(url, {
      ...options.headers,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    });
  } catch (error) {
    throw new Error(`${url} could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`the provider refused the token (HTTP ${response.status})`);
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`${url} answered HTTP ${response.status}`);
  let body: unknown;
  try {
    body = JSON.parse(response.text ?? '') as unknown;
  } catch {
    throw new Error(`${url} did not answer with a model list`);
  }
  const models = parseProviderModels(body);
  if (models.length === 0) throw new Error('it lists no models');
  return models;
}

/**
 * The models the endpoint at `baseUrl` serves, or `undefined` when they
 * could not be read (see `readProviderModels`) — the reason is logged.
 */
export async function fetchProviderModels(
  baseUrl: string,
  options: FetchProviderModelsOptions,
): Promise<EndpointModel[] | undefined> {
  try {
    return await readProviderModels(baseUrl, options);
  } catch (error) {
    options.log(`${options.tag} no model list from ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
