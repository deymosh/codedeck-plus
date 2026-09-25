/**
 * The Claude Code subprocess environment for one spawn: the bridge's stored
 * credentials and the session's provider binding, turned into the variables
 * the CLI reads. The returned objects carry SECRETS — never log them.
 */
import type { ProviderBinding, StartSession } from '../../types';

export const ANTHROPIC_API_KEY_CREDENTIAL = 'anthropic_api_key';

/** The message shown when a base URL is refused (the bridge shows the same). */
export const PROVIDER_BASE_URL_ERROR =
  'Base URL must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1])';

/** https anywhere, or http ONLY on loopback — a local model server has no
 *  cert and its traffic never leaves the machine; anything else is a network
 *  hop carrying a bearer token. */
export function isValidProviderBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return url.host !== '';
  if (url.protocol !== 'http:') return false;
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
}

/**
 * The env-name namespaces the Claude Code CLI (and the cloud SDKs it embeds)
 * use to pick an API backend, carry a credential, or override a model. A
 * provider-bound session inherits NOTHING from these — see
 * sanitizeProviderBaseEnv.
 *
 * Prefixes, not names, because names are unbounded: the SDK bundle
 * registers hundreds of distinct vars under these prefixes and every CLI
 * release adds more. A denylist over that namespace is a list we would lose
 * track of on the next upgrade; a prefix drop is the same list inverted, and
 * a NEW routing var added upstream is dropped by default instead of silently
 * honoured.
 */
const VENDOR_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'AWS_',
  'AZURE_',
  'BEDROCK_',
  'CLOUDSDK_',
  'GCLOUD_',
  'GOOGLE_',
  'VERTEX_',
] as const;

/**
 * Routing/credential vars that carry no vendor prefix. `CLOUD_ML_REGION` is
 * the proof that the prefix rule alone is not enough: it is a *Google Cloud*
 * name, and the CLI uses it to choose the backend.
 */
const VENDOR_ENV_EXACT = new Set(['CLOUD_ML_REGION', 'USE_LOCAL_OAUTH', 'USE_STAGING_OAUTH']);

/**
 * The allowlist *inside* the vendor namespace: deliberately tiny, and every
 * entry is location-, shell- or privacy-shaped — never routing, never a
 * credential, never a model id.
 *
 * - CLAUDE_CONFIG_DIR: the operator's CLI config/state root. Dropping it
 *   silently relocates the session to `~/.claude` — a functional break.
 * - CLAUDE_CODE_SHELL / CLAUDE_CODE_GIT_BASH_PATH: which shell the Bash tool
 *   runs. Dropping the Windows one leaves the CLI with no shell at all.
 * - CLAUDE_CODE_TMPDIR: scratch location, often the only writable dir on a
 *   locked-down box.
 * - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: a privacy switch. Dropping it
 *   turns traffic the operator switched OFF back on.
 *
 * Deliberately NOT kept: output-token caps (a Claude-tuned cap is not
 * obviously right at a third-party provider) and the mTLS client
 * certificate vars — a client certificate is an IDENTITY, and offering the
 * operator's to an arbitrary third-party host is exactly the leak this
 * function exists to stop.
 */
const VENDOR_ENV_KEEP = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_SHELL',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_TMPDIR',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]);

/**
 * The base environment for a session bound to a CUSTOM provider —
 * everything inherited EXCEPT the vendor routing/credential namespace.
 *
 * Claude Code's auth precedence puts cloud provider credentials ABOVE
 * `ANTHROPIC_AUTH_TOKEN`, so an operator with `CLAUDE_CODE_USE_BEDROCK=1`
 * exported would otherwise get a "Kimi" session that silently runs on
 * Bedrock and bills their AWS account, and `ANTHROPIC_CUSTOM_HEADERS` (where
 * gateway users keep a gateway credential) would be forwarded as HTTP
 * headers to whatever third-party host the profile names.
 *
 * Everything outside the namespace survives untouched (PATH, HOME, proxies,
 * CA settings, GITHUB_TOKEN, toolchain vars): a session that cannot resolve
 * a hostname or find `git` is not more secure.
 */
export function sanitizeProviderBaseEnv(baseEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (!VENDOR_ENV_KEEP.has(upper)) {
      if (VENDOR_ENV_EXACT.has(upper)) continue;
      if (VENDOR_ENV_PREFIXES.some((p) => upper.startsWith(p))) continue;
    }
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
 * The environment for one spawn, or undefined to inherit the host's own.
 *
 * Without a provider: undefined when nothing is stored (no behavior
 * change); otherwise the inherited env plus `ANTHROPIC_API_KEY` — the
 * operator's own env key wins over a stored one — and the bridge-level
 * `env` (e.g. `GITHUB_TOKEN`, stored wins).
 *
 * With a provider: the sanitized base env, the provider's base URL and
 * token, and its background model under both the current and the
 * deprecated variable name (so neither a CLI upgrade nor a downgrade can
 * send background tasks to a Claude model the provider does not serve).
 * Throws for an insecure base URL or a missing token — the session is then
 * refused loudly; a silent fallback to the Anthropic key would bill the
 * wrong account.
 */
export function buildClaudeEnv(
  params: Pick<StartSession, 'credentials' | 'env' | 'provider'>,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  const extra = params.env ?? {};
  const provider = params.provider ?? undefined;
  if (provider) return providerEnv(provider, extra, baseEnv);

  const storedKey = params.credentials?.[ANTHROPIC_API_KEY_CREDENTIAL];
  if (!storedKey && Object.keys(extra).length === 0) return undefined;
  const env = inherited(baseEnv);
  const apiKey = baseEnv.ANTHROPIC_API_KEY || storedKey;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
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
  const env = sanitizeProviderBaseEnv(baseEnv);
  env.ANTHROPIC_BASE_URL = provider.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = provider.authToken;
  const smallModel = provider.defaultModel ?? provider.models[0]?.id;
  if (smallModel) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel;
    env.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
  }
  Object.assign(env, extra);
  return env;
}
