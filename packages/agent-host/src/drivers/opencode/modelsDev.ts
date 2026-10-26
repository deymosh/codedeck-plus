/**
 * Model records from models.dev, the catalog OpenCode is built on.
 *
 * A running OpenCode server describes only the models of providers it can
 * use, so a gateway's model routed to any other (`OpenCode Go/…` through a
 * gateway, with no OpenCode Go key) has no record there. models.dev has it:
 * its limits, what it takes and can do, how it reasons, its list price.
 * The list is a few megabytes, so it is asked for only when a profile has a
 * model nothing else describes, and at most once a day (the kept catalog
 * holds what it filled in).
 *
 * The source is OpenCode's own: `OPENCODE_MODELS_URL` when the operator
 * points it elsewhere, and nothing at all with `OPENCODE_DISABLE_MODELS_FETCH`.
 */
import type { ModelCost } from '@opencode/client';
import type { HttpGet } from '../../sdk/net';
import type { CatalogModel, Reasoning } from './catalog';

/** Where OpenCode itself reads models.dev from. */
export const MODELS_DEV_URL = 'https://models.opencode.ai';

/** How long a fetched list stands before a profile model it lacks asks again. */
export const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;

/** The list's address for `env`, or none when OpenCode is told not to fetch it. */
export function modelsDevSource(env: NodeJS.ProcessEnv): string | undefined {
  const disabled = env.OPENCODE_DISABLE_MODELS_FETCH;
  if (disabled !== undefined && disabled !== '' && disabled !== '0' && disabled !== 'false') return undefined;
  return `${(env.OPENCODE_MODELS_URL?.trim() || MODELS_DEV_URL).replace(/\/+$/, '')}/api.json`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** models.dev's `reasoning` and `reasoning_options`, as OpenCode's config
 *  states them. */
function reasoningOf(model: Record<string, unknown>): Reasoning | undefined {
  if (typeof model.reasoning !== 'boolean') return undefined;
  if (!model.reasoning) return { supported: false };
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options.filter(isRecord) : [];
  const effort = options.find((o) => o.type === 'effort');
  const budget = options.find((o) => o.type === 'budget_tokens');
  const efforts = effort ? strings(effort.values).filter((v) => v !== 'null' && v !== 'default') : [];
  const min = budget ? num(budget.min) : undefined;
  const max = budget ? num(budget.max) : undefined;
  return {
    supported: true,
    ...(options.some((o) => o.type === 'toggle') ? { toggle: true } : {}),
    ...(efforts.length > 0 ? { effort: efforts } : {}),
    ...(budget ? { budget: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } } : {}),
  };
}

function costOf(raw: unknown): ModelCost[] {
  if (!isRecord(raw)) return [];
  const input = num(raw.input);
  const output = num(raw.output);
  if (input === undefined || output === undefined) return [];
  return [{ input, output, cache: { read: num(raw.cache_read) ?? 0, write: num(raw.cache_write) ?? 0 } }];
}

/** One models.dev model, or none for a record missing what a config needs. */
function modelOf(providerID: string, raw: unknown): CatalogModel | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !isRecord(raw.limit)) return undefined;
  const context = num(raw.limit.context);
  const output = num(raw.limit.output);
  if (context === undefined || output === undefined) return undefined;
  const modalities = isRecord(raw.modalities) ? raw.modalities : {};
  const reasoning = reasoningOf(raw);
  return {
    providerID,
    modelID: raw.id,
    name: raw.name,
    ...(typeof raw.family === 'string' && raw.family !== '' ? { family: raw.family } : {}),
    capabilities: {
      tools: raw.tool_call === true,
      input: strings(modalities.input),
      output: strings(modalities.output),
      ...(typeof raw.temperature === 'boolean' ? { temperature: raw.temperature } : {}),
    },
    ...(reasoning ? { reasoning } : {}),
    cost: costOf(raw.cost),
    limit: { context, output },
  };
}

/** Every model of a models.dev list, by `<providerID>/<modelID>`. Total: a
 *  record it cannot read is left out, a list it cannot read is empty. */
export function parseModelsDev(text: string): Map<string, CatalogModel> {
  const found = new Map<string, CatalogModel>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return found;
  }
  if (!isRecord(parsed)) return found;
  for (const provider of Object.values(parsed)) {
    if (!isRecord(provider) || typeof provider.id !== 'string' || !isRecord(provider.models)) continue;
    for (const raw of Object.values(provider.models)) {
      const model = modelOf(provider.id, raw);
      if (model) found.set(`${model.providerID}/${model.modelID}`, model);
    }
  }
  return found;
}

/** The list at `url`; empty when it cannot be had (it only fills in). */
export async function fetchModelsDev(url: string, get: HttpGet, log: (message: string) => void): Promise<Map<string, CatalogModel>> {
  try {
    const res = await get(url, { accept: 'application/json' });
    if (res.status !== 200 || res.text === undefined) throw new Error(`HTTP ${res.status}`);
    return parseModelsDev(res.text);
  } catch (err) {
    log(`[opencode] could not read models.dev, so gateway models are not filled in: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}
