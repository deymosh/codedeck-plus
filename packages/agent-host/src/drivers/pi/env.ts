/**
 * The Pi child's environment for one spawn: the state root it must use, the
 * switches that keep it from phoning home, and — for a session bound to a
 * provider profile — the profile CodeDeck's extension registers with Pi.
 * The returned object carries SECRETS — never log it.
 *
 * Pi reads its endpoint and key from its own `models.json` or `auth.json`
 * under `$PI_CODING_AGENT_DIR`, or from an extension registration. A profile
 * is the second kind: its endpoint, label and models travel as JSON in
 * `CODEDECK_PI_PROVIDER`, while the token travels in its own variable
 * (`CODEDECK_PI_PROVIDER_TOKEN`) and is referenced from the extension by name,
 * so the secret never reaches the file written to disk.
 *
 * The profile's `baseUrl` is the endpoint as the user saved it; Pi's
 * OpenAI-compatible provider needs its versioned API root, so `/v1` is
 * appended unless the URL already ends there — the same rule
 * `providerApiRoot` applies for the other drivers.
 */
import { isValidProviderBaseUrl, PROVIDER_BASE_URL_ERROR } from '../../sdk/provider';
import { providerApiRoot } from '../../sdk/providerModels';
import type { ProviderBinding, StartSession } from '../../sdk/types';
import { PI_AGENT_DIR_ENV } from './runtime';

/** The profile (no secret) the extension registers, when a session is bound
 *  to one. */
export const PI_PROVIDER_ENV = 'CODEDECK_PI_PROVIDER';
/** The profile's auth token, read by the extension through `$`-interpolation. */
export const PI_PROVIDER_TOKEN_ENV = 'CODEDECK_PI_PROVIDER_TOKEN';

/** The provider registration as the extension's JSON variable carries it. */
export interface PiProviderProfile {
  id: string;
  label: string;
  baseUrl: string;
  models: Array<{ id: string; label?: string; contextWindow?: number }>;
}

/** The profile a session is bound to, with the endpoint Pi will call. */
export function toPiProviderProfile(provider: ProviderBinding): PiProviderProfile {
  return {
    id: provider.id,
    label: provider.label || provider.id,
    baseUrl: providerApiRoot(provider.baseUrl),
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.label ? { label: model.label } : {}),
      ...(model.contextWindow !== undefined && model.contextWindow !== null ? { contextWindow: model.contextWindow } : {}),
    })),
  };
}

/**
 * The environment for one spawn. Without a provider: everything inherited,
 * with the stored or inherited Pi credentials untouched (Pi's own provider
 * setup in its home applies) and the bridge-level `env` on top (e.g.
 * `GITHUB_TOKEN`, stored wins). With a provider: the profile's own endpoint
 * and token replace any such variable a session might otherwise inherit, so
 * the session cannot quietly reach another account.
 *
 * `PI_CODING_AGENT_DIR` is always this driver's, set last: a session that
 * moved it would lose the conversation it is resuming. Throws for an
 * insecure provider base URL or a missing token — the session is then
 * refused loudly rather than run against the wrong account.
 */
export function buildPiEnv(
  params: Pick<StartSession, 'provider' | 'env'>,
  home: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  delete env[PI_PROVIDER_ENV];
  delete env[PI_PROVIDER_TOKEN_ENV];

  const provider = params.provider ?? undefined;
  if (provider) {
    // Checked before the token: this decides whether the token may travel on
    // this connection at all. The base URL is not a secret.
    if (!isValidProviderBaseUrl(provider.baseUrl)) {
      throw new Error(
        `provider profile '${provider.id}' has an insecure base URL (${provider.baseUrl}) — ` +
          `${PROVIDER_BASE_URL_ERROR}. Its API token would travel in cleartext, so the session is refused.`,
      );
    }
    if (!provider.authToken) throw new Error(`provider profile '${provider.id}' has no stored auth token`);
    env[PI_PROVIDER_ENV] = JSON.stringify(toPiProviderProfile(provider));
    env[PI_PROVIDER_TOKEN_ENV] = provider.authToken;
  }

  Object.assign(env, params.env ?? {});
  // Last: the state root and the offline switches belong to this driver, not
  // to whatever the bridge or the operator's environment says.
  env[PI_AGENT_DIR_ENV] = home;
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  return env;
}
