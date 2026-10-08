/**
 * The model catalog of the endpoint the harness is pointed at.
 *
 * An operator who sets `DEEPSEEK_BASE_URL` is saying "run sessions on this
 * endpoint" — another provider's API, or a gateway in front of several. The
 * harness takes that endpoint from the environment (its DeepSeek route reads
 * exactly that variable), but its *model catalog* is its own, fixed list of
 * DeepSeek model names — so an endpoint with other models would be sent a
 * name it does not know, and the phone would offer models it cannot serve.
 * What the endpoint serves is the one thing only it can say, at its
 * `/v1/models` (`sdk/providerModels`), on the same root the harness itself
 * appends `/v1` to and then posts `/messages` to.
 *
 * So this module asks the endpoint for that list and writes it into the
 * harness's own profile, as the deployment's catalog for the native route:
 * a patch row over the `llm-deepseek` entry, which is how the harness
 * documents its catalog as replaceable. From the next harness start, the
 * phone offers exactly what the endpoint serves and a session can select any
 * of it. No endpoint configured (or one that does not answer) means no row
 * at all: the harness's own catalog stands, and nothing is guessed.
 */
import * as path from 'node:path';
import { dump } from 'js-yaml';
import type { HttpGet } from '../../sdk/net';
import { fetchProviderModels, type EndpointModel } from '../../sdk/providerModels';
import { ProfileLayer, type LayerBlock } from './profileLayer';

/** Our block in the profile's patch layer. Its marker text is what finds the
 *  block again in a profile written by an earlier version, so it stays as
 *  it was first written. */
const BLOCK: LayerBlock = {
  begin: "# --- CodeDeck+ gateway catalog: written from the gateway's own model list; everything outside this block is yours ---",
  end: '# --- end CodeDeck+ gateway catalog ---',
};

/** The entry that mounts the native DeepSeek adapter; its config carries the
 *  endpoint and the catalog. */
const PROVIDER_ROW = 'llm-deepseek';
/** The entries naming the provider and model a session starts on. They have
 *  to move with the catalog: the harness always offers the model it is on,
 *  so a default the endpoint does not serve would appear as one nobody can
 *  run. `acp` is the profile's own selection (what a new session starts
 *  with); `agent-default-model` is the agent module's. */
const SESSION_MODEL_ROW = 'acp';
const DEFAULT_MODEL_ROW = 'agent-default-model';
/** The provider the native route is registered under. */
const NATIVE_PROVIDER = 'deepseek-official';

export interface EndpointCatalog {
  /** The endpoint as the harness should read it. */
  baseUrl: string;
  models: EndpointModel[];
  /** The model sessions start on: the endpoint's own first entry, in the
   *  order it lists them. */
  defaultModel: string;
}

/**
 * The catalog the endpoint serves, or `undefined` when it could not be read
 * (see `fetchProviderModels`).
 */
export async function fetchEndpointCatalog(
  baseUrl: string,
  key: string | undefined,
  httpGet: HttpGet,
  log: (message: string) => void,
): Promise<EndpointCatalog | undefined> {
  const models = await fetchProviderModels(baseUrl, { ...(key ? { token: key } : {}), httpGet, log, tag: '[deepseek]' });
  if (!models) {
    log(`[deepseek] leaving the harness's own catalog in place`);
    return undefined;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), models, defaultModel: models[0]!.id };
}

/**
 * The patch rows for an endpoint's catalog: the catalog itself, and the
 * model a session starts on.
 *
 * Never the endpoint. The profile is shared by every harness process, and
 * the route takes a `baseURL` in its config over `DEEPSEEK_BASE_URL` in the
 * environment — so an endpoint written here would also be where a session
 * bound to a provider profile sent that profile's token, whatever its own
 * environment named. The operator's process finds the endpoint in the
 * environment it already has.
 */
export function renderCatalogLayer(catalog: EndpointCatalog): string {
  const models = catalog.models.map((model) => ({
    id: model.id,
    ...(model.label !== undefined ? { name: model.label } : {}),
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

export interface CatalogSyncOptions {
  /** The profile directory (`$DSH_HOME/profiles/acp`). */
  profileDir: string;
  log: (message: string) => void;
  httpGet?: HttpGet;
}

/**
 * Write the endpoint's catalog into the harness profile (or take our row
 * out when no endpoint is configured), and answer whether the layer changed.
 */
export async function syncEndpointCatalog(
  options: CatalogSyncOptions,
  baseUrl: string | undefined,
  key: string | undefined,
): Promise<boolean> {
  const layer = new ProfileLayer(path.join(options.profileDir, 'cordis.patch.yml'), options.log);
  if (!baseUrl || !options.httpGet) return layer.set(BLOCK, undefined);
  const catalog = await fetchEndpointCatalog(baseUrl, key, options.httpGet, options.log);
  if (!catalog) return false;
  const changed = await layer.set(BLOCK, renderCatalogLayer(catalog));
  if (changed) {
    options.log(`[deepseek] ${catalog.models.length} models from ${catalog.baseUrl} now make up the harness's catalog`);
  }
  return changed;
}
