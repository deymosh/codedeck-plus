/**
 * The part of OpenCode's catalog that places provider profiles, kept on disk
 * between bridge starts.
 *
 * The server reads its provider config only when it starts, and profiles are
 * placed by the server's own catalog (catalog.ts). Without a catalog to hand,
 * a bridge start ran two servers: one to ask, then one with the profiles in
 * its config — and replacing the first ended every session the bridge had
 * just resumed on it. With the catalog the last placement used, the driver
 * places the profiles before any server runs and starts one; the server's
 * own catalog is still read once it is up, and a placement that changes
 * with it restarts the server as before.
 *
 * Only what placement and the profiles' config read is kept: every
 * provider's id, name and endpoint, which of them are connected, and the
 * catalog's records of the profiles' own models — never a key, nor a
 * provider's or a model's other settings.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModelInfo, ProviderInfo } from '@opencode/client';
import { type Catalog, catalogModel } from './catalog';
import type { Placement } from './providers';

/** The catalog records `placed` was configured from, as `catalog` holds
 *  them: a known provider's models (whether the catalog has one decides
 *  what the profile adds), and the record each own provider's model is
 *  filled in from. */
function placedModels(catalog: Catalog, placed: Placement[]): ModelInfo[] {
  const found = new Map<string, ModelInfo>();
  for (const { profile, known } of placed) {
    for (const model of profile.models) {
      const record = known ? catalog.models.get(`${known.id}/${model.id}`) : catalogModel(catalog, model, new Set());
      if (record) found.set(`${record.providerID}/${record.modelID}`, record);
    }
  }
  return [...found.values()];
}

/** What the cache file holds for `catalog` — a catalog without profiles
 *  (`withoutProfiles`) — and the placement made against it. */
export function catalogSnapshot(catalog: Catalog, placed: Placement[]): unknown {
  return {
    providers: [...catalog.providers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      ...(typeof p.settings?.baseURL === 'string' ? { baseURL: p.settings.baseURL } : {}),
    })),
    connected: [...catalog.connected],
    models: placedModels(catalog, placed).map((m) => ({
      providerID: m.providerID,
      modelID: m.modelID,
      name: m.name,
      ...(m.family ? { family: m.family } : {}),
      capabilities: m.capabilities,
      variants: m.variants,
      cost: m.cost,
      limit: m.limit,
    })),
  };
}

/** Keep `catalog` and the placement made against it for the next start.
 *  Best effort: without the file, the next start is simply a slower one.
 *  Written in place, not renamed into it: the agent cache can sit on a
 *  filesystem that refuses to rename a file it has just seen written (see
 *  agentInstall.ts), and a file cut short reads as no cache at all. */
export function writeCatalogCache(file: string, catalog: Catalog, placed: Placement[], log: (message: string) => void): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(catalogSnapshot(catalog, placed)));
  } catch (err) {
    log(`[opencode] could not keep its provider catalog for the next start: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

/** The catalog a cache file holds; undefined for a missing, unreadable or
 *  malformed one, which is a start without a cache. */
export function readCatalogCache(file: string): Catalog | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.providers) || !Array.isArray(parsed.connected) || !Array.isArray(parsed.models)) {
    return undefined;
  }
  const providers = new Map<string, ProviderInfo>();
  for (const p of parsed.providers) {
    if (!isRecord(p) || !isString(p.id) || !isString(p.name) || (p.baseURL !== undefined && !isString(p.baseURL))) return undefined;
    // Only what placement reads: the endpoint it is recognised by.
    providers.set(p.id, { id: p.id, name: p.name, settings: p.baseURL ? { baseURL: p.baseURL } : {} } as ProviderInfo);
  }
  if (!parsed.connected.every(isString)) return undefined;
  const models = new Map<string, ModelInfo>();
  for (const m of parsed.models) {
    if (
      !isRecord(m) ||
      !isString(m.providerID) ||
      !isString(m.modelID) ||
      !isString(m.name) ||
      (m.family !== undefined && !isString(m.family)) ||
      !isRecord(m.capabilities) ||
      !Array.isArray(m.variants) ||
      !Array.isArray(m.cost) ||
      !isRecord(m.limit) ||
      typeof m.limit.context !== 'number' ||
      typeof m.limit.output !== 'number'
    ) {
      return undefined;
    }
    // Only what a profile model's config is filled in from (profileModelConfig).
    models.set(`${m.providerID}/${m.modelID}`, { ...m, id: m.modelID } as unknown as ModelInfo);
  }
  return { providers, models, connected: new Set(parsed.connected) };
}
