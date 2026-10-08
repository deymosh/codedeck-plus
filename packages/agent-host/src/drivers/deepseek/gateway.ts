/**
 * A gateway the harness is pointed at, end to end.
 *
 * An operator who sets `DEEPSEEK_BASE_URL` is saying "run sessions on this
 * endpoint". The harness takes that endpoint from the environment (its
 * DeepSeek route reads exactly that variable), but its *model catalog* is its
 * own, fixed list of DeepSeek model names — so a gateway with its own models
 * would be sent a name it does not know, and the phone would offer models the
 * gateway cannot serve. What the gateway serves is the one thing only the
 * gateway can say, and it says it at `/models` (the OpenAI-shaped list every
 * gateway exposes), on the same root the harness itself appends `/v1` to and
 * then posts `/messages` to.
 *
 * So this module asks the gateway for that list and writes it into the
 * harness's own profile, as the deployment's catalog for the native route:
 * a patch row over the `llm-deepseek` entry, which is how the harness
 * documents its catalog as replaceable. From the next harness start, the
 * phone offers exactly what the gateway serves and a session can select any
 * of it. No gateway configured (or one that does not answer) means no row at
 * all: the harness's own catalog stands, and nothing is guessed.
 */
import * as path from 'node:path';
import { dump } from 'js-yaml';
import type { HttpGet } from '../../sdk/net';
import { ProfileLayer, type LayerBlock } from './profileLayer';

/** Our block in the profile's patch layer. */
const BLOCK: LayerBlock = {
  begin: "# --- CodeDeck+ gateway catalog: written from the gateway's own model list; everything outside this block is yours ---",
  end: '# --- end CodeDeck+ gateway catalog ---',
};

/** The entry that mounts the native DeepSeek adapter; its config carries the
 *  endpoint and the catalog. */
const PROVIDER_ROW = 'llm-deepseek';
/** The entries naming the provider and model a session starts on. They have
 *  to move with the catalog: the harness always offers the model it is on,
 *  so a default the gateway does not serve would appear as one nobody can
 *  run. `acp` is the profile's own selection (what a new session starts
 *  with); `agent-default-model` is the agent module's. */
const SESSION_MODEL_ROW = 'acp';
const DEFAULT_MODEL_ROW = 'agent-default-model';
/** The provider the native route is registered under. */
const NATIVE_PROVIDER = 'deepseek-official';

/** How many of a gateway's models are kept: a catalog is for a phone screen. */
const MAX_MODELS = 200;

/** One model, as a catalog entry. */
export interface GatewayModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface GatewayCatalog {
  /** The endpoint as the harness should read it. */
  baseUrl: string;
  models: GatewayModel[];
  /** The model sessions start on: the gateway's own first entry, in the
   *  order it lists them. */
  defaultModel: string;
}

/**
 * The list a gateway serves, or `undefined` when it could not be read (an
 * unreachable endpoint, a refusal, an answer that is not a model list). The
 * base URL is normalised the way the harness normalises it, so the same
 * variable points at the same endpoint for both.
 */
export async function fetchGatewayCatalog(
  baseUrl: string,
  key: string | undefined,
  httpGet: HttpGet,
  log: (message: string) => void,
): Promise<GatewayCatalog | undefined> {
  const url = gatewayModelsUrl(baseUrl);
  let body: unknown;
  try {
    const response = await httpGet(url, key ? { authorization: `Bearer ${key}` } : {});
    if (response.status < 200 || response.status >= 300) {
      log(`[deepseek] the gateway at ${baseUrl} answered ${response.status} for its model list`);
      return undefined;
    }
    body = readJson(response);
  } catch (error) {
    log(`[deepseek] could not read the gateway's model list from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const models = parseModels(body);
  if (models.length === 0) {
    log(`[deepseek] the gateway at ${baseUrl} listed no models; leaving the harness's own catalog in place`);
    return undefined;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), models, defaultModel: models[0]!.id };
}

/** The harness's own rule for where a provider's list of models lives: the
 *  root ends in `/v1` (the endpoint `/messages` is posted to lives beside
 *  it). Mirrored here so one setting configures both. */
export function gatewayModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const rooted = new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`;
  return `${rooted}/models`;
}

/** The model ids in a gateway's answer: the OpenAI-shaped `data` array, a
 *  bare array, or a `models` array. Anything else yields nothing. */
export function parseModels(body: unknown): GatewayModel[] {
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null
      ? ((body as { data?: unknown }).data ?? (body as { models?: unknown }).models)
      : undefined;
  if (!Array.isArray(list)) return [];
  const models: GatewayModel[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const id =
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null
          ? (entry as { id?: unknown; name?: unknown }).id
          : undefined;
    if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) continue;
    seen.add(id);
    const context = typeof entry === 'object' && entry !== null ? contextWindowOf(entry as Record<string, unknown>) : undefined;
    const name = typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : undefined;
    models.push({ id, ...(name && name !== id ? { name } : {}), ...(context !== undefined ? { contextWindow: context } : {}) });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/** A model's context size, when the gateway states one (OpenAI-compatible
 *  gateways spell it several ways). */
function contextWindowOf(entry: Record<string, unknown>): number | undefined {
  for (const field of ['context_window', 'context_length', 'contextWindow', 'max_input_tokens']) {
    const value = entry[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

function readJson(response: Awaited<ReturnType<HttpGet>>): unknown {
  return JSON.parse(response.text ?? '') as unknown;
}

/**
 * The patch rows for a gateway's catalog: the catalog itself, and the model
 * a session starts on.
 *
 * Never the endpoint. The profile is shared by every harness process, and
 * the route takes a `baseURL` in its config over `DEEPSEEK_BASE_URL` in the
 * environment — so an endpoint written here would also be where a session
 * bound to a provider profile sent that profile's token, whatever its own
 * environment named. The operator's process finds the gateway in the
 * environment it already has.
 */
export function renderCatalogLayer(catalog: GatewayCatalog): string {
  const models = catalog.models.map((model) => ({
    id: model.id,
    ...(model.name !== undefined ? { name: model.name } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
  }));
  const selection = { provider: NATIVE_PROVIDER, model: catalog.defaultModel };
  const rows = [
    { id: PROVIDER_ROW, config: { models } },
    { id: SESSION_MODEL_ROW, config: selection },
    { id: DEFAULT_MODEL_ROW, config: selection },
  ];
  return dump(rows, { lineWidth: -1, noRefs: true, quotingType: "'" }).trimEnd();
}

export interface GatewaySyncOptions {
  /** The profile directory (`$DSH_HOME/profiles/acp`). */
  profileDir: string;
  log: (message: string) => void;
  httpGet?: HttpGet;
}

/**
 * Write the gateway's catalog into the harness profile (or take our row out
 * when no gateway is configured), and answer whether the layer changed.
 */
export async function syncGatewayCatalog(
  options: GatewaySyncOptions,
  baseUrl: string | undefined,
  key: string | undefined,
): Promise<boolean> {
  const layer = new ProfileLayer(path.join(options.profileDir, 'cordis.patch.yml'), options.log);
  if (!baseUrl || !options.httpGet) return layer.set(BLOCK, undefined);
  const catalog = await fetchGatewayCatalog(baseUrl, key, options.httpGet, options.log);
  if (!catalog) return false;
  const changed = await layer.set(BLOCK, renderCatalogLayer(catalog));
  if (changed) {
    options.log(`[deepseek] ${catalog.models.length} models from ${catalog.baseUrl} now make up the harness's catalog`);
  }
  return changed;
}
