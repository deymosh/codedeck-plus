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
 *  - each profile is the provider `codedeck-<profile id>`, named after the
 *    profile, so its models are `codedeck-<id>/<model>` and the phone shows
 *    them under the profile's name;
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
import type { ProviderBinding } from '../../sdk/types';

/** What a profile's provider id starts with: no OpenCode provider (models.dev
 *  catalog or the operator's) is named so. */
export const PROFILE_PROVIDER_PREFIX = 'codedeck-';
/** The user name OpenCode's server expects with its password. */
const SERVER_USERNAME = 'opencode';

/** The OpenCode provider id of a profile. */
export function profileProviderId(profile: ProviderBinding): string {
  return `${PROFILE_PROVIDER_PREFIX}${profile.id}`;
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
        models: Object.fromEntries(profile.models.map((m) => [m.id, m.label ? { name: m.label } : {}])),
      },
    ]),
  );
  return { ...base, provider: { ...own, ...added } };
}

/** What the server is started with to serve `profiles`, and how its client
 *  signs in. */
export interface ServerSetup {
  env: Record<string, string>;
  headers: Record<string, string>;
}

/** The environment and credentials of a server for `profiles`. `baseEnv`
 *  is the host's own environment. */
export function serverSetup(profiles: ProviderBinding[], baseEnv: NodeJS.ProcessEnv): ServerSetup {
  const password = randomBytes(24).toString('hex');
  const env: Record<string, string> = {
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
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
