/**
 * Qwen Code's `settings.json`, and the provider profiles that become its
 * OpenAI-compatible model providers.
 *
 * Qwen Code has no provider API of its own: a model comes from a provider
 * entry in its settings, and the entry names the environment variable its key
 * is read from. That is exactly the shape a CodeDeck provider profile has, so
 * every profile becomes one `modelProviders.openai` entry per model, whose
 * `envKey` names a CodeDeck-owned variable (`CODEDECK_QWEN_KEY_<n>`) that only
 * the session's own process environment carries. The token therefore never
 * touches the file — `settings.json` is readable by anything on the machine,
 * and a key written there would be a key leaked.
 *
 * Everything the driver does not manage is preserved: the operator's other
 * settings, and their own `openai` providers (recognised by an `envKey` that
 * is not one of ours), so pointing `CODEDECK_QWEN_HOME` at a home in use does
 * not wipe it. The three switches the driver does own — the selected auth
 * type, the default model, self-update and the usage ping — are written every
 * time, because a Qwen Code with none of them either refuses `session/new`
 * with `authRequired` or spends its boot checking for a newer release.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { providerApiRoot } from '../../sdk/providerModels';
import type { ProviderBinding } from '../../sdk/types';

/** The environment-name namespace the per-profile tokens travel in. The
 *  value is the profile's token; the name is referenced from `settings.json`
 *  and put in the session process's environment by the driver. */
export const QWEN_KEY_ENV_PREFIX = 'CODEDECK_QWEN_KEY_';

/** The variable profile `index`'s token reaches Qwen Code in. */
export function qwenKeyEnvName(index: number): string {
  return `${QWEN_KEY_ENV_PREFIX}${index}`;
}

/** One `modelProviders.openai` entry, as Qwen Code reads it. */
export interface QwenProviderEntry {
  /** The model id; Qwen Code shows it as `<id>(openai)` and selects it by
   *  that value. */
  id: string;
  name: string;
  envKey: string;
  baseUrl: string;
}

/** Whether an entry is one this driver wrote (so a rewrite replaces it
 *  rather than piling a second copy beside it). */
function isOurs(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { envKey?: unknown }).envKey === 'string' &&
    (entry as { envKey: string }).envKey.startsWith(QWEN_KEY_ENV_PREFIX)
  );
}

/**
 * The entries `providers` become, in order. One per (profile, model), its
 * `envKey` the profile's own variable, its `baseUrl` the profile's versioned
 * API root (`/v1` appended unless it already ends there) — the URL Qwen
 * Code's OpenAI client posts chat completions to.
 */
export function qwenProviderEntries(providers: ProviderBinding[]): QwenProviderEntry[] {
  const entries: QwenProviderEntry[] = [];
  providers.forEach((profile, index) => {
    const envKey = qwenKeyEnvName(index);
    let baseUrl: string;
    try {
      baseUrl = providerApiRoot(profile.baseUrl);
    } catch {
      // A base URL that is not a URL is the bridge's to refuse; nothing this
      // driver can do with it.
      return;
    }
    for (const model of profile.models) {
      entries.push({ id: model.id, name: model.label ?? model.id, envKey, baseUrl });
    }
  });
  return entries;
}

/**
 * A short fingerprint of what the settings file will hold. The ACP runtime
 * keys its process pool by the environment a session passes, and a process
 * reads `settings.json` as it boots — so this rides in that environment, and a
 * changed provider list becomes a different environment, which is what makes
 * the next session start a process that has read it. It carries no secret: the
 * entries and the default model, never a token.
 */
export function qwenSettingsKey(providers: ProviderBinding[]): string {
  const shape = { entries: qwenProviderEntries(providers), model: qwenDefaultModel(providers) ?? null };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

/** The default model Qwen Code starts on: the first profile's default, else
 *  its first model. Undefined when no profile offers a model. */
export function qwenDefaultModel(providers: ProviderBinding[]): string | undefined {
  for (const profile of providers) {
    const wanted = profile.defaultModel;
    if (wanted && profile.models.some((model) => model.id === wanted)) return wanted;
    if (profile.models[0]) return profile.models[0].id;
  }
  return undefined;
}

/**
 * `settings.json` as the driver writes it: the provider entries, the auth
 * type that makes them usable without a login, the default model, and the
 * two switches. Everything else in `existing` survives — the operator's own
 * providers among it.
 */
export function mergeQwenSettings(
  existing: Record<string, unknown>,
  providers: ProviderBinding[],
): Record<string, unknown> {
  const modelProviders = record(existing.modelProviders);
  const openai = Array.isArray(modelProviders.openai) ? modelProviders.openai : [];
  const kept = openai.filter((entry) => !isOurs(entry));
  const defaultModel = qwenDefaultModel(providers);
  return {
    ...existing,
    modelProviders: { ...modelProviders, openai: [...kept, ...qwenProviderEntries(providers)] },
    security: { ...record(existing.security), auth: { ...record(record(existing.security).auth), selectedType: 'openai' } },
    ...(defaultModel !== undefined ? { model: { ...record(existing.model), name: defaultModel } } : {}),
    general: { ...record(existing.general), enableAutoUpdate: false },
    privacy: { ...record(existing.privacy), usageStatisticsEnabled: false },
  };
}

/** The environment the session's process carries: the profile tokens, under
 *  the names `settings.json` refers to. The returned object carries SECRETS —
 *  never log it. */
export function qwenProviderEnv(providers: ProviderBinding[]): Record<string, string> {
  const env: Record<string, string> = {};
  providers.forEach((profile, index) => {
    if (profile.authToken) env[qwenKeyEnvName(index)] = profile.authToken;
  });
  return env;
}

/**
 * Write `settings.json` under `home`, from the profiles and whatever is
 * already there. Best effort reading: a missing or unreadable file is an
 * empty settings object, and a file that is not JSON is replaced (a broken
 * settings file would make every session fail to start anyway).
 */
export async function writeQwenSettings(
  home: string,
  providers: ProviderBinding[],
  log: (message: string) => void,
): Promise<void> {
  // The home is CodeDeck's own directory: a fresh machine has none yet, and
  // Qwen Code reads settings.json as it boots rather than creating it.
  await mkdir(home, { recursive: true });
  const file = path.join(home, 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    existing = record(parsed);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      log(`[qwen] ${file} could not be read (${error instanceof Error ? error.message : String(error)}) — writing a fresh one`);
    }
  }
  // Written beside the file and renamed over it: a Qwen Code process that
  // boots meanwhile reads the old settings or the new ones, never half of
  // either.
  const staged = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(staged, `${JSON.stringify(mergeQwenSettings(existing, providers), null, 2)}\n`, 'utf8');
    await rename(staged, file);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
