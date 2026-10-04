/**
 * The DeepSeek Harness child's environment for one spawn: the bridge's stored
 * credential and the session's provider binding, turned into the variables
 * the harness reads. The returned object carries SECRETS — never log it.
 *
 * The harness takes its endpoint and key from `DEEPSEEK_BASE_URL` and
 * `DEEPSEEK_API_KEY` (its DeepSeek route reads exactly this pair when its own
 * plugin config names no endpoint), so a custom provider — a gateway such as
 * Claude Code Router, a relay — is the same session shape Claude Code's
 * `ANTHROPIC_BASE_URL` is: point the base URL at it and hand it the token.
 * Its protocol then decides what the gateway must speak; the default here is
 * the DeepSeek messages API, which is what a DeepSeek-compatible relay
 * serves.
 */
import { isValidProviderBaseUrl, PROVIDER_BASE_URL_ERROR } from '../../provider';
import type { ProviderBinding, StartSession } from '../../types';

export const DEEPSEEK_API_KEY_CREDENTIAL = 'deepseek_api_key';
/** The key the harness reads. */
export const DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY';
/** The endpoint the harness reads; unset means its own public API. */
export const DEEPSEEK_BASE_URL_ENV = 'DEEPSEEK_BASE_URL';

/**
 * The environment-name namespace a provider-bound session inherits NOTHING
 * from. `DEEPSEEK_BASE_URL` is where a session is routed and
 * `DEEPSEEK_API_KEY` is what it authenticates with; both are replaced by the
 * provider's. A prefix rather than the two names: the harness is a developer
 * preview whose plugin set moves, and a routing or credential variable added
 * under its vendor prefix must be dropped by default rather than silently
 * honoured.
 *
 * `DSH_` is deliberately NOT in this list: those name the harness's own home
 * and profile layout, which a gateway does not change, and dropping
 * `DSH_HOME` would silently move a session's state to `~/.dsh`.
 */
const VENDOR_ENV_PREFIXES = ['DEEPSEEK_'] as const;

/** The base environment for a session bound to a CUSTOM provider: everything
 *  inherited except the harness's own endpoint/credential namespace. */
export function sanitizeDeepSeekBaseEnv(baseEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (VENDOR_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

function inherited(baseEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * The environment for one spawn. Without a provider: the inherited env plus
 * `DEEPSEEK_API_KEY` — the operator's own environment key wins over a stored
 * one — and the bridge-level `env` (e.g. `GITHUB_TOKEN`, stored wins).
 *
 * With a provider: the sanitized base env and the provider's own base URL and
 * token. Throws for an insecure base URL or a missing token — the session is
 * then refused loudly; falling back to the native key would bill the wrong
 * account.
 */
export function buildDeepSeekEnv(
  params: Pick<StartSession, 'credentials' | 'env' | 'provider'>,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const extra = params.env ?? {};
  const provider = params.provider ?? undefined;
  if (provider) return providerEnv(provider, extra, baseEnv);

  const env = inherited(baseEnv);
  const key = baseEnv[DEEPSEEK_API_KEY_ENV] || params.credentials?.[DEEPSEEK_API_KEY_CREDENTIAL];
  if (key) env[DEEPSEEK_API_KEY_ENV] = key;
  Object.assign(env, extra);
  return env;
}

function providerEnv(
  provider: ProviderBinding,
  extra: Record<string, string>,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  // Checked before the token: this decides whether the token may travel on
  // this connection at all. The base URL is not a secret.
  if (!isValidProviderBaseUrl(provider.baseUrl)) {
    throw new Error(
      `provider profile '${provider.id}' has an insecure base URL (${provider.baseUrl}) — ` +
        `${PROVIDER_BASE_URL_ERROR}. Its API token would travel in cleartext, so the session is refused.`,
    );
  }
  if (!provider.authToken) throw new Error(`provider profile '${provider.id}' has no stored auth token`);
  const env = sanitizeDeepSeekBaseEnv(baseEnv);
  env[DEEPSEEK_BASE_URL_ENV] = provider.baseUrl;
  env[DEEPSEEK_API_KEY_ENV] = provider.authToken;
  Object.assign(env, extra);
  return env;
}
