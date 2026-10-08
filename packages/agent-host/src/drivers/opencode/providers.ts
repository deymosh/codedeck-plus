/**
 * Provider profiles as OpenCode providers.
 *
 * A profile adds a provider to OpenCode — beside OpenCode Zen and whatever
 * the operator configured, which all stay: an OpenAI-compatible endpoint,
 * its token and its models. OpenCode takes a custom provider only from its
 * config, so the profiles reach the server this driver starts as config
 * handed over in its environment, on top of the operator's files (which are
 * never written):
 *
 *  - each profile is a provider named as the user named the profile, its
 *    id that name in lower case (`CCR` is `ccr`, its models `ccr/<model>`);
 *    a profile whose id one of OpenCode's own providers already has, or an
 *    earlier profile, is left out with the reason rather than shadow it;
 *  - each token sits in the server's environment only, referenced from the
 *    config, never in a file;
 *  - the server answers only with a password made for it, since its API
 *    reads its config — the tokens included — back to anyone on loopback
 *    who asks.
 *
 * The server reads its config when it starts, so a changed profile list
 * means a new server (see the driver).
 */
import { createHash, randomBytes } from 'node:crypto';
import { providerApiRoot } from '../../sdk/providerModels';
import type { ProviderBinding, ProviderModel, RefusedProvider } from '../../sdk/types';

/** The user name OpenCode's server expects with its password. */
const SERVER_USERNAME = 'opencode';

/** `name` as an OpenCode provider id: lower case, each run of anything but
 *  letters and digits one `-` (a `/` would split its model ids). */
function providerIdOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The OpenCode provider id of a profile: its name's, or its id's when the
 *  name has no letter or digit. */
export function profileProviderId(profile: ProviderBinding): string {
  return providerIdOf(profile.label) || providerIdOf(profile.id) || 'provider';
}

/** Which of `profiles` OpenCode can take, in order: one whose provider id
 *  is `taken` by a provider OpenCode already has, or by an earlier profile,
 *  is refused with the reason. */
export function admitProfiles(
  profiles: ProviderBinding[],
  taken: ReadonlySet<string>,
): { admitted: ProviderBinding[]; refused: RefusedProvider[] } {
  const admitted: ProviderBinding[] = [];
  const refused: RefusedProvider[] = [];
  const used = new Map<string, ProviderBinding>();
  for (const profile of profiles) {
    const id = profileProviderId(profile);
    const earlier = used.get(id);
    if (taken.has(id)) {
      refused.push({ id: profile.id, reason: `OpenCode already has a provider called '${id}'. Give this profile another name.` });
    } else if (earlier) {
      refused.push({ id: profile.id, reason: `The provider profile '${earlier.label}' already goes by '${id}' in OpenCode. Give this one another name.` });
    } else {
      used.set(id, profile);
      admitted.push(profile);
    }
  }
  return { admitted, refused };
}

/** The variable profile `index`'s token reaches the server in. */
function tokenVariable(index: number): string {
  return `CODEDECK_PROVIDER_KEY_${index}`;
}

/** The provider entries for `profiles`, on top of `base` (an operator's own
 *  `OPENCODE_CONFIG_CONTENT`, whose providers stay). */
export function providersConfig(profiles: ProviderBinding[], base: Record<string, unknown> = {}): Record<string, unknown> {
  const own = (base.provider ?? {}) as Record<string, unknown>;
  const added = Object.fromEntries(
    profiles.map((profile, index) => [
      profileProviderId(profile),
      {
        npm: '@ai-sdk/openai-compatible',
        name: profile.label || profile.id,
        options: { baseURL: providerApiRoot(profile.baseUrl), apiKey: `{env:${tokenVariable(index)}}` },
        models: Object.fromEntries(profile.models.map((m) => [m.id, modelConfig(m)])),
      },
    ]),
  );
  return { ...base, provider: { ...own, ...added } };
}

/** A profile model as OpenCode's config holds it: named without the
 *  upstream provider its group already shows. A known context window
 *  lets OpenCode compact before the model overflows; the output size is
 *  never listed by endpoints, so it stays 0, OpenCode's own "unknown". */
function modelConfig(model: ProviderModel): Record<string, unknown> {
  const name = model.label ?? (model.provider && model.id.startsWith(`${model.provider}/`) ? model.id.slice(model.provider.length + 1) : undefined);
  return {
    ...(name ? { name } : {}),
    ...(model.contextWindow ? { limit: { context: model.contextWindow, output: 0 } } : {}),
  };
}

/** The group a profile model is listed under: the profile, and the
 *  provider a gateway routes the model to when the endpoint names one. */
export function profileModelGroup(profile: string, model: ProviderModel | undefined): string {
  return model?.provider ? `${profile} · ${model.provider}` : profile;
}

/** What the server is started with to serve `profiles`, and how its client
 *  signs in. */
export interface ServerSetup {
  env: Record<string, string>;
  headers: Record<string, string>;
}

/** The environment and credentials of a server for `profiles` — and, for
 *  every model, web search. `baseEnv` is the host's own environment. */
export function serverSetup(profiles: ProviderBinding[], baseEnv: NodeJS.ProcessEnv): ServerSetup {
  const password = randomBytes(24).toString('hex');
  const env: Record<string, string> = {
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
    // OpenCode offers its web search only on its own providers unless this
    // is set; with it, every model can search (Exa's keyless endpoint,
    // still behind the `websearch` permission).
    OPENCODE_ENABLE_EXA: '1',
  };
  if (profiles.length > 0) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(providersConfig(profiles, operatorConfig(baseEnv)));
    profiles.forEach((profile, index) => {
      env[tokenVariable(index)] = profile.authToken;
    });
  }
  const headers = { authorization: `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString('base64')}` };
  return { env, headers };
}

/** The config the operator handed OpenCode in the environment, if any. */
function operatorConfig(baseEnv: NodeJS.ProcessEnv): Record<string, unknown> {
  const raw = baseEnv.OPENCODE_CONFIG_CONTENT;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What makes two profile lists need different servers: everything their
 *  config is built from. Hashed, so the tokens are not kept around in it. */
export function providersFingerprint(profiles: ProviderBinding[]): string {
  const parts = profiles.map((p) => [p.id, p.label, p.baseUrl, p.authToken, p.models]);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
