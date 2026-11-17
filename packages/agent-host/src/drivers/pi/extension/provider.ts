/**
 * The provider profile a bound session runs on, registered with Pi as one of
 * its own providers.
 *
 * The driver passes the profile (no secret) as JSON in `CODEDECK_PI_PROVIDER`
 * and the token in `CODEDECK_PI_PROVIDER_TOKEN` (env.ts). The registration
 * names the token variable, `$CODEDECK_PI_PROVIDER_TOKEN`, and Pi reads it
 * from the environment when it calls the endpoint, so the secret never
 * reaches the extension file or Pi's configuration. The profile's models
 * become selectable as `<provider>/<model>`.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describeModel, type CatalogModel } from './catalog';

/** The variable the profile travels in (env.ts sets it). */
export const PROVIDER_ENV = 'CODEDECK_PI_PROVIDER';
/** The variable the profile's token travels in, named in the registration. */
export const PROVIDER_TOKEN_ENV = 'CODEDECK_PI_PROVIDER_TOKEN';

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
 * Register the bound profile, when there is one. A malformed profile is not
 * a reason to keep Pi from starting: the session then runs Pi's own models
 * and reports what it cannot do. `catalog` is read only when there is a
 * profile to describe.
 */
export function registerProfile(
  pi: Pick<ExtensionAPI, 'registerProvider'>,
  env: Record<string, string | undefined>,
  catalog: () => readonly CatalogModel[] = () => [],
): void {
  const profile = readProfile(env);
  if (!profile) return;
  const known = catalog();
  pi.registerProvider(profile.id, {
    name: profile.label,
    baseUrl: profile.baseUrl,
    api: PROFILE_API,
    apiKey: '$' + PROVIDER_TOKEN_ENV,
    models: profile.models.map((model) => profileModel(model, known)) as never,
  });
}
