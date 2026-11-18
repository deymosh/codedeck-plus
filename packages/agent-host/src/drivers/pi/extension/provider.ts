/**
 * The provider profile a bound session runs on, registered with Pi as one of
 * its own providers.
 *
 * The driver passes the profile (no secret) as JSON in `CODEDECK_PI_PROVIDER`
 * (env.ts), and the token on a pipe of its own: file descriptor 3, which it
 * writes once and closes as Pi starts. The token is never in Pi's
 * environment, because everything Pi starts inherits that environment — the
 * model's shells, background shells, MCP servers — and on Linux any process
 * of the same user can read Pi's initial environment back from
 * `/proc/<pid>/environ`, even after Pi deleted the variable. A pipe is
 * inherited by nothing: Node passes a child only the stdio it is given.
 *
 * The extension reads the pipe once, as Pi loads it, and registers the token
 * as the provider's key, so it lives in Pi's memory only. The profile's
 * models become selectable as `<provider>/<model>`.
 */
import { closeSync, readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describeModel, type CatalogModel } from './catalog';

/** The variable the profile travels in (env.ts sets it). */
export const PROVIDER_ENV = 'CODEDECK_PI_PROVIDER';
/** The file descriptor the profile's token arrives on, for a Pi started with
 *  a profile: the driver's spawn (rpc.ts) and a sub-agent's (task.ts) put a
 *  pipe there. */
export const PROVIDER_TOKEN_FD = 3;

/**
 * The profile's token, read from its pipe to the end. Only a Pi started with
 * a profile has the pipe, so nothing is read without one. A pipe that is not
 * there or cannot be read gives no token: the session then fails on its
 * first request, saying it has no key, rather than at load.
 */
export function readProviderToken(
  env: Record<string, string | undefined>,
  read: (fd: number) => string = (fd) => {
    try {
      return readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  },
): string | undefined {
  if (!env[PROVIDER_ENV]) return undefined;
  try {
    const token = read(PROVIDER_TOKEN_FD);
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

/**
 * A value Pi takes literally where it reads a configuration value. Pi
 * resolves an API key as a template: `$NAME` is an environment variable and a
 * leading `!` a shell command (its resolve-config-value), so a token holding
 * either would be read as one. `$$` is Pi's literal `$` and `$!` its literal
 * `!`.
 */
export function configLiteral(value: string): string {
  const escaped = value.replace(/\$/g, '$$$$');
  return escaped.startsWith('!') ? `$${escaped}` : escaped;
}

/** Context and output sizes for a model nothing describes. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const FALLBACK_MAX_TOKENS = 32_768;

interface ProfileModel {
  id: string;
  label?: string;
  contextWindow?: number;
}

/** The profile in `CODEDECK_PI_PROVIDER`, or nothing when it is absent or
 *  not one. */
export function readProfile(
  env: Record<string, string | undefined>,
): { id: string; label: string; baseUrl: string; models: ProfileModel[] } | undefined {
  const raw = env[PROVIDER_ENV];
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const profile = parsed as Record<string, unknown>;
  const id = typeof profile.id === 'string' && profile.id !== '' ? profile.id : 'codedeck';
  const models = (Array.isArray(profile.models) ? profile.models : []).flatMap((raw): ProfileModel[] => {
    const model = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
    if (typeof model?.id !== 'string' || model.id === '') return [];
    const window = Number(model.contextWindow);
    return [
      {
        id: model.id,
        ...(typeof model.label === 'string' && model.label !== '' ? { label: model.label } : {}),
        ...(Number.isSafeInteger(window) && window > 0 ? { contextWindow: window } : {}),
      },
    ];
  });
  return {
    id,
    label: typeof profile.label === 'string' && profile.label !== '' ? profile.label : id,
    // Already the profile's versioned API root: the driver resolved it
    // (env.ts), so the one rule for it lives in the host.
    baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl : '',
    models,
  };
}

/** The API a profile is spoken to with: the OpenAI-compatible one every
 *  profile endpoint answers. */
const PROFILE_API = 'openai-completions';

/**
 * One profile model as Pi registers it. The endpoint's own context size wins
 * when its list stated one; everything else comes from what Pi's catalog
 * knows of the model (catalog.ts). A model Pi does not know runs at the
 * fallback sizes, without reasoning: no thinking parameters are sent, so an
 * endpoint that does not take them is never refused for them.
 */
export function profileModel(model: ProfileModel, catalog: readonly CatalogModel[]): Record<string, unknown> {
  const known = describeModel(model.id, catalog);
  const contextWindow = model.contextWindow ?? known?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  return {
    id: model.id,
    name: model.label ?? model.id,
    reasoning: known?.reasoning ?? false,
    ...(known?.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
    input: known?.input && known.input.length > 0 ? known.input : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(known?.maxTokens ?? FALLBACK_MAX_TOKENS, contextWindow),
    // Compatibility switches describe one API's wire; they apply only when
    // Pi's own entry speaks the same API as the profile.
    ...(known?.compat && known.api === PROFILE_API ? { compat: known.compat } : {}),
  };
}

/**
 * Register the bound profile, when there is one, with `token` as its key. A
 * malformed profile is not a reason to keep Pi from starting: the session
 * then runs Pi's own models and reports what it cannot do. Without a token
 * the profile is registered keyless, said once on stderr (the driver logs
 * it), and Pi refuses its requests for want of a key. `catalog` is read only
 * when there is a profile to describe.
 */
export function registerProfile(
  pi: Pick<ExtensionAPI, 'registerProvider'>,
  env: Record<string, string | undefined>,
  token: string | undefined,
  catalog: () => readonly CatalogModel[] = () => [],
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  const profile = readProfile(env);
  if (!profile) return;
  if (token === undefined) {
    warn(`codedeck: no token arrived for the provider profile '${profile.id}' (file descriptor ${PROVIDER_TOKEN_FD})`);
  }
  const known = catalog();
  pi.registerProvider(profile.id, {
    name: profile.label,
    baseUrl: profile.baseUrl,
    api: PROFILE_API,
    ...(token !== undefined ? { apiKey: configLiteral(token) } : {}),
    models: profile.models.map((model) => profileModel(model, known)) as never,
  });
}
