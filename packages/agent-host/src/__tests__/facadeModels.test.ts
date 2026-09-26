/**
 * firstSupportedModels (CDX-022): the model-list aggregation policy behind
 * RealSdkFacade.supportedModels(). The device bug: after a bridge restart the
 * first handle in insertion order is a resume-on-boot query; when that resume
 * is dead its control request rejects ("No conversation found with session
 * ID …") or never settles, and the old first-handle-wins loop then returned []
 * (or hung the models-request handler) forever — with live sessions sitting
 * right behind it in the set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  firstSupportedModels,
  type ModelsQueryHandle,
  type SdkModelDescriptor,
} from '../drivers/claude/facade';

const OPUS: SdkModelDescriptor[] = [{ id: 'claude-opus-4-8', label: 'Opus' }];

function live(models: SdkModelDescriptor[]): ModelsQueryHandle {
  return { isEnded: false, queryModels: async () => models };
}

function rejecting(message: string): ModelsQueryHandle {
  return { isEnded: false, queryModels: () => Promise.reject(new Error(message)) };
}

function hanging(): ModelsQueryHandle {
  return { isEnded: false, queryModels: () => new Promise<never>(() => {}) };
}

function ended(): ModelsQueryHandle {
  return {
    isEnded: true,
    queryModels: async () => { throw new Error('must never be asked'); },
  };
}

describe('firstSupportedModels (CDX-022)', () => {
  it('returns the first non-empty list', async () => {
    expect(await firstSupportedModels([live(OPUS), live([{ id: 'other' }])])).toEqual(OPUS);
  });

  it('skips ended handles without querying them', async () => {
    expect(await firstSupportedModels([ended(), live(OPUS)])).toEqual(OPUS);
  });

  it('a dead first handle (rejecting control request) falls through to the live one', async () => {
    // The exact device scenario: resume-on-boot handle is first and rejects.
    const logs: string[] = [];
    const models = await firstSupportedModels(
      [rejecting('No conversation found with session ID: dead-resume'), live(OPUS)],
      50,
      (m) => logs.push(m),
    );
    expect(models).toEqual(OPUS);
    expect(logs.some((l) => l.includes('No conversation found'))).toBe(true);
  });

  it('a hanging first handle times out and falls through to the live one', async () => {
    const models = await firstSupportedModels([hanging(), live(OPUS)], 20);
    expect(models).toEqual(OPUS);
  });

  it('an empty-answering handle falls through to a non-empty one', async () => {
    expect(await firstSupportedModels([live([]), live(OPUS)])).toEqual(OPUS);
  });

  it('returns [] when no handle answers with models', async () => {
    expect(await firstSupportedModels([], 20)).toEqual([]);
    expect(await firstSupportedModels([ended(), rejecting('dead'), live([])], 20)).toEqual([]);
  });
});

// --- CDX-062: buildQueryOptions fallbackModel tri-state ---

import {
  buildQueryOptions,
  DEFAULT_MODEL,
  fetchGatewayModels,
  isProviderBoundSession,
  modelSupports1mContext,
  type SdkSessionOptions,
} from '../drivers/claude/facade';

function baseOpts(over: Partial<SdkSessionOptions> = {}): SdkSessionOptions {
  return {
    sessionId: 's1',
    cwd: '/work',
    permissionMode: 'default',
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    ...over,
  };
}

describe('buildQueryOptions (CDX-062 fallbackModel tri-state)', () => {
  it('undefined → the option is OMITTED entirely (no automatic silent degrade)', () => {
    const options = buildQueryOptions(baseOpts());
    expect('fallbackModel' in options).toBe(false);
  });

  it('null → the option is OMITTED entirely (custom providers have no such model)', () => {
    const options = buildQueryOptions(baseOpts({ fallbackModel: null }));
    expect('fallbackModel' in options).toBe(false);
  });

  it('a string → used as given', () => {
    const options = buildQueryOptions(baseOpts({ fallbackModel: 'claude-haiku-4-5' }));
    expect(options.fallbackModel).toBe('claude-haiku-4-5');
  });

  it('without a caller env, keeps the inherited environment and adds the turn-state flag', () => {
    process.env.CODEDECK_TEST_INHERITED = 'kept';
    try {
      const options = buildQueryOptions(baseOpts());
      expect(options.env?.CODEDECK_TEST_INHERITED).toBe('kept');
      expect(options.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
    } finally {
      delete process.env.CODEDECK_TEST_INHERITED;
    }
  });

  it('carries env/model/resume through unchanged', () => {
    const env = { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-x' };
    const options = buildQueryOptions(baseOpts({ model: 'kimi-k3', env, fallbackModel: null }));
    expect(options.model).toBe('kimi-k3');
    // The caller's env, plus the flag that makes the CLI report turn state.
    expect(options.env).toEqual({ ...env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
    // create path uses sessionId; resume path replaces it.
    expect((options as { sessionId?: string }).sessionId).toBe('s1');
    const resumed = buildQueryOptions(baseOpts({ resume: 'sdk-old' }));
    expect((resumed as { resume?: string }).resume).toBe('sdk-old');
    expect((resumed as { sessionId?: string }).sessionId).toBeUndefined();
  });
});

describe('isProviderBoundSession (CDX-071)', () => {
  // The pre-fix test was `!!opts.env?.ANTHROPIC_BASE_URL`. ANTHROPIC_BASE_URL in
  // the BRIDGE OPERATOR'S own shell is a documented Claude Code setup (LLM
  // gateway), and every session inherits the operator's env whenever any
  // credential is stored — so on such a machine EVERY plain Anthropic session
  // was flagged provider-bound, filtered out of firstSupportedModels, and the
  // phone showed an empty model list: CDX-022's symptom, reintroduced.
  const GATEWAY_ENV = {
    PATH: '/bin',
    ANTHROPIC_BASE_URL: 'https://gateway.corp/v1',
    ANTHROPIC_AUTH_TOKEN: 'sk-gateway-token',
  };

  it('a PLAIN Anthropic session on a gateway-configured machine is NOT provider-bound', () => {
    expect(isProviderBoundSession(baseOpts({ env: GATEWAY_ENV }))).toBe(false);
  });

  it('the machine model list survives a gateway-configured operator shell', async () => {
    // RealSdkFacade.supportedModels() filters on this flag, so the pre-fix
    // reading emptied the list on such a machine. Same filter, same order.
    const handles = [
      { ...live(OPUS), customProvider: isProviderBoundSession(baseOpts({ env: GATEWAY_ENV })) },
      { ...live([{ id: 'kimi-k3' }]), customProvider: isProviderBoundSession(baseOpts({ providerId: 'kimi', env: GATEWAY_ENV })) },
    ];
    expect(await firstSupportedModels(handles.filter((h) => !h.customProvider))).toEqual(OPUS);
    // Pre-fix, BOTH handles were flagged and the phone got nothing.
    expect(handles.map((h) => h.customProvider)).toEqual([false, true]);
  });

  it('an inherited ANTHROPIC_BASE_URL alone never flags a session', () => {
    for (const env of [
      GATEWAY_ENV,
      { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' },
      { ANTHROPIC_BASE_URL: '' },
    ]) {
      expect(isProviderBoundSession(baseOpts({ env }))).toBe(false);
    }
  });

  it('an explicit providerId flags it — with or without env', () => {
    expect(isProviderBoundSession(baseOpts({ providerId: 'kimi' }))).toBe(true);
    expect(isProviderBoundSession(baseOpts({ providerId: 'kimi', env: GATEWAY_ENV }))).toBe(true);
    // Even with no env at all: the binding is the signal, not the plumbing.
    expect(isProviderBoundSession({ providerId: 'kimi' })).toBe(true);
  });

  it('fallbackModel: null is the other half of the same explicit contract', () => {
    // The runner passes it for exactly the provider-bound case; it is a caller
    // option, not ambient env, so the guard cannot regress before providerId
    // is threaded through.
    expect(isProviderBoundSession({ fallbackModel: null })).toBe(true);
    expect(isProviderBoundSession({ fallbackModel: 'claude-sonnet-4-6' })).toBe(false);
    expect(isProviderBoundSession({})).toBe(false);
  });

  it('providerId is declarative only — it never reaches the SDK query options', () => {
    const options = buildQueryOptions(baseOpts({ providerId: 'kimi' }));
    expect('providerId' in options).toBe(false);
  });
});

// --- CDX-076: never spawn under a session id the CLI already holds ---

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeProjectDirs, sdkConversationExists } from '../drivers/claude/facade';

/**
 * Measured on the real Claude CLI 2.1.220 (run-sheet check 43, 2026-08-09), via
 * the same SDK the bridge uses:
 *  - spawn with `sessionId: U` and NO turn → `<U>.jsonl` absent, project dir
 *    not even created; re-spawning `sessionId: U` then succeeds and a turn runs
 *    (this is CDX-056's recovery, and it works);
 *  - after one turn `<U>.jsonl` exists, and a fresh spawn with `sessionId: U`
 *    dies at startup: `Error: Session ID U is already in use.` (exit 1);
 *  - the check is per-cwd — the same id spawns fine in another project dir;
 *  - `resume: U + forkSession + sessionId: U` is accepted (the binary's only
 *    sanctioned reuse), and omitting `sessionId` entirely makes the CLI mint
 *    its own id, which `init.session_id` then reports.
 * These tests hold the facade to that measured contract.
 */
describe('buildQueryOptions (CDX-076 session-id collision)', () => {
  it('claims our own id while it is free — the unchanged common case', () => {
    const seen: Array<[string, string]> = [];
    const options = buildQueryOptions(baseOpts(), undefined, (id, cwd) => {
      seen.push([id, cwd]);
      return false;
    });
    expect((options as { sessionId?: string }).sessionId).toBe('s1');
    expect('resume' in options).toBe(false);
    expect(seen).toEqual([['s1', '/work']]);
  });

  it('sends NO id at all once the CLI holds a conversation for it', () => {
    // Pre-fix this spawn carried `--session-id s1` into a guaranteed
    // `Error: Session ID s1 is already in use.` — fatal, and the runner's two
    // restarts re-ran the exact same doomed argv before the session died.
    const options = buildQueryOptions(baseOpts(), undefined, () => true);
    expect('sessionId' in options).toBe(false);
    expect('resume' in options).toBe(false);
    // Everything else about the spawn is untouched — same cwd, so the fresh
    // conversation lands in the same workspace.
    expect(options.cwd).toBe('/work');
  });

  it('a resume never consults the predicate and never carries sessionId', () => {
    let called = 0;
    const options = buildQueryOptions(baseOpts({ resume: 'sdk-old' }), undefined, () => {
      called++;
      return true;
    });
    expect((options as { resume?: string }).resume).toBe('sdk-old');
    expect('sessionId' in options).toBe(false);
    expect(called).toBe(0);
  });

  it('the config dir comes from the SESSION env when there is one (CDX-071 strips CLAUDE_*)', () => {
    // A provider-bound session's env is a full replacement for the subprocess
    // AND has every CLAUDE_ var dropped, so the CLI it spawns uses the default
    // ~/.claude even when the bridge operator's own shell sets CLAUDE_CONFIG_DIR.
    // Reading process.env there would probe the wrong tree.
    const seenEnv: Array<Record<string, string | undefined> | undefined> = [];
    const env = { PATH: '/bin' };
    buildQueryOptions(baseOpts({ env }), undefined, (_id, _cwd, e) => {
      seenEnv.push(e);
      return false;
    });
    expect(seenEnv).toEqual([env]);
    // No session env ⇒ the subprocess inherits ours ⇒ the predicate's default.
    const seenPlain: Array<Record<string, string | undefined> | undefined> = [];
    buildQueryOptions(baseOpts(), undefined, (_id, _cwd, e) => {
      seenPlain.push(e);
      return false;
    });
    expect(seenPlain).toEqual([undefined]);
  });
});

describe('claudeProjectDirs / sdkConversationExists (CDX-076)', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdx076-'));
  });
  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('reproduces the CLI slug: every non-alphanumeric becomes a dash', () => {
    // Verified against a live tree: cwd
    // /tmp/claude-1000/-home-jeroen-.../scratchpad/cdx076a produced
    // -tmp-claude-1000--home-jeroen-...-scratchpad-cdx076a (note the double
    // dash where the path had `/-`).
    expect(claudeProjectDirs('/tmp/a/-b_c.d', { CLAUDE_CONFIG_DIR: configDir })).toEqual([
      path.join(configDir, 'projects', '-tmp-a--b-c-d'),
    ]);
  });

  it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset or blank', () => {
    for (const env of [{}, { CLAUDE_CONFIG_DIR: '   ' }]) {
      expect(claudeProjectDirs('/work', env)).toEqual([
        path.join(os.homedir(), '.claude', 'projects', '-work'),
      ]);
    }
  });

  it('an over-long cwd degrades to a prefix scan, never to a confident "free"', () => {
    // Over 200 slug chars the CLI appends a Bun hash we cannot compute, so the
    // exact name is unknowable. Guessing "no conversation" there is the one
    // answer that reintroduces the fatal spawn.
    const cwd = `/${'x'.repeat(300)}`;
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const root = path.join(configDir, 'projects');
    const real = path.join(root, `${slug.slice(0, 200)}-9f3ab1`);
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(path.join(root, 'unrelated'), { recursive: true });
    expect(claudeProjectDirs(cwd, { CLAUDE_CONFIG_DIR: configDir })).toEqual([real]);

    fs.writeFileSync(path.join(real, 'sess-1.jsonl'), '{}\n');
    expect(sdkConversationExists('sess-1', cwd, { CLAUDE_CONFIG_DIR: configDir })).toBe(true);
    expect(sdkConversationExists('sess-2', cwd, { CLAUDE_CONFIG_DIR: configDir })).toBe(false);
  });

  it('an unreadable projects root reports NO match rather than inventing one', () => {
    // Nothing there ⇒ nothing is taken; the id is genuinely free.
    const cwd = `/${'y'.repeat(300)}`;
    expect(claudeProjectDirs(cwd, { CLAUDE_CONFIG_DIR: configDir })).toEqual([]);
    expect(sdkConversationExists('sess-1', cwd, { CLAUDE_CONFIG_DIR: configDir })).toBe(false);
  });

  it('the conversation file is per-cwd, exactly as the CLI checks it', () => {
    const root = path.join(configDir, 'projects');
    fs.mkdirSync(path.join(root, '-work-a'), { recursive: true });
    fs.writeFileSync(path.join(root, '-work-a', 'u1.jsonl'), '{}\n');
    expect(sdkConversationExists('u1', '/work/a', { CLAUDE_CONFIG_DIR: configDir })).toBe(true);
    // Same id, different workspace — the CLI spawns this happily (measured).
    expect(sdkConversationExists('u1', '/work/b', { CLAUDE_CONFIG_DIR: configDir })).toBe(false);
  });

  it('a turn-less session leaves no file, so CDX-056 keeps its own id', () => {
    // The measured shape of check 43 step (b): the project directory does not
    // even exist until the first turn. This is why CDX-056's fresh respawn
    // works on a real CLI.
    expect(sdkConversationExists('never-ran', '/work/c', { CLAUDE_CONFIG_DIR: configDir })).toBe(false);
    const options = buildQueryOptions(
      baseOpts({ sessionId: 'never-ran', cwd: '/work/c' }),
      undefined,
      (id, cwd) => sdkConversationExists(id, cwd, { CLAUDE_CONFIG_DIR: configDir }),
    );
    expect((options as { sessionId?: string }).sessionId).toBe('never-ran');
  });
});

describe('modelSupports1mContext', () => {
  it('matches sonnet and opus, case-insensitively, prefix or not', () => {
    expect(modelSupports1mContext('claude-sonnet-4-6')).toBe(true);
    expect(modelSupports1mContext('claude-opus-5')).toBe(true);
    // Real router shape (claude-code-router): "<provider>/<model>".
    expect(modelSupports1mContext('Claude Code API/claude-sonnet-5')).toBe(true);
    expect(modelSupports1mContext('CLAUDE-OPUS-4-6')).toBe(true);
  });

  it('does not match haiku or an absent model', () => {
    expect(modelSupports1mContext('claude-haiku-4-5-20251001')).toBe(false);
    expect(modelSupports1mContext(undefined)).toBe(false);
  });

  it('matches glm-5.3 and glm-5.3-flash (Z.ai\'s own 1M-tier docs), not glm-4.7-flash', () => {
    // Real gateway shape (claude-code-router fronting Z.ai): "<provider>/<model>".
    expect(modelSupports1mContext('Z.ai (Global) - Coding Plan/glm-5.3')).toBe(true);
    expect(modelSupports1mContext('Z.ai (Global) - Coding Plan/glm-5.3-flash')).toBe(true);
    expect(modelSupports1mContext('Z.ai (Global) - Coding Plan/glm-4.7-flash')).toBe(false);
  });
});

describe('buildQueryOptions (1M-context beta)', () => {
  // Verified against a real test gateway (ANTHROPIC_BASE_URL → a router) with
  // the actual SDK: `betas` alone left modelUsage[model].contextWindow at
  // 200000 for a native-1M model — exactly this bug. Sending the model with
  // a `[1m]` suffix reported the full 1000000 and completed normally, for
  // both a native-1M model and a legacy one. Both mechanisms are asserted
  // below; the suffix is the one that actually works behind a gateway.
  it('always adds the beta AND the [1m] model-id suffix for a model that supports it — no toggle', () => {
    const options = buildQueryOptions(baseOpts({ model: 'claude-sonnet-5' }));
    expect(options.betas).toEqual(['context-1m-2025-08-07']);
    expect(options.model).toBe('claude-sonnet-5[1m]');
  });

  it('does not double-suffix a model id that already carries the marker', () => {
    const options = buildQueryOptions(baseOpts({ model: 'claude-opus-5[1m]' }));
    expect(options.model).toBe('claude-opus-5[1m]');
  });

  it('omits both for a model that does not support it — model id is untouched', () => {
    const options = buildQueryOptions(baseOpts({ model: 'claude-haiku-4-5-20251001' }));
    expect(options.betas).toBeUndefined();
    expect(options.model).toBe('claude-haiku-4-5-20251001');
  });

  it('gates on DEFAULT_MODEL when the phone left model unset, independent of fallbackModel', () => {
    const options = buildQueryOptions(baseOpts());
    expect(modelSupports1mContext(DEFAULT_MODEL)).toBe(true);
    expect(options.betas).toEqual(['context-1m-2025-08-07']);
    // The assumed model is now sent explicitly (suffixed) too — before this
    // fix Options.model was omitted entirely for a "Default model" session,
    // leaving the CLI to pick its own default with no 1M signal at all.
    expect(options.model).toBe(`${DEFAULT_MODEL}[1m]`);
    // Confirms the two concerns are decoupled: no fallbackModel is sent...
    expect('fallbackModel' in options).toBe(false);
    // ...yet the beta is still requested for this "Default model" session.
  });

  it('omits both for a provider-bound session (fallbackModel: null, no resolvable model)', () => {
    const options = buildQueryOptions(baseOpts({ fallbackModel: null }));
    expect(options.betas).toBeUndefined();
    expect('model' in options).toBe(false);
  });
});

describe('fetchGatewayModels', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('returns [] and never calls fetch when ANTHROPIC_BASE_URL or a token is missing', async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    let called = false;
    global.fetch = (async () => {
      called = true;
      throw new Error('must not be called');
    }) as unknown as typeof fetch;

    expect(await fetchGatewayModels()).toEqual([]);
    expect(called).toBe(false);
  });

  it('sends a Bearer auth header and maps a router-prefixed model list, falling back to the id tail for the label', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://router.example:3458/';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-123';
    delete process.env.ANTHROPIC_API_KEY;

    const calls: [string, RequestInit | undefined][] = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return {
        ok: true,
        json: async () => ({
          // Real shape from a claude-code-router instance: some entries
          // carry display_name, some don't.
          data: [
            { id: 'Claude Code API/claude-sonnet-5', object: 'model', display_name: 'Claude Sonnet 5' },
            { id: 'Z.ai (Global) - Coding Plan/glm-5.2', object: 'model' },
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const models = await fetchGatewayModels();

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe('http://router.example:3458/v1/models'); // trailing slash on the base URL stripped
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    expect(models).toEqual([
      { id: 'Claude Code API/claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'Z.ai (Global) - Coding Plan/glm-5.2', label: 'glm-5.2' },
    ]);
  });

  it('prefers CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_API_KEY when both are set', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://router.example';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
    process.env.ANTHROPIC_API_KEY = 'api-key';
    let authHeader: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string>).Authorization;
      return { ok: true, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;

    await fetchGatewayModels();
    expect(authHeader).toBe('Bearer oauth-token');
  });

  it('returns [] on a non-ok response rather than throwing', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://router.example';
    process.env.ANTHROPIC_API_KEY = 'k';
    global.fetch = (async () => ({ ok: false, status: 401, statusText: 'Unauthorized' })) as unknown as typeof fetch;

    expect(await fetchGatewayModels()).toEqual([]);
  });

  it('returns [] on a network error rather than throwing', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://router.example';
    process.env.ANTHROPIC_API_KEY = 'k';
    global.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    expect(await fetchGatewayModels()).toEqual([]);
  });

  it('returns [] when the response has no "data" array', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://router.example';
    process.env.ANTHROPIC_API_KEY = 'k';
    global.fetch = (async () => ({ ok: true, json: async () => ({ unexpected: 'shape' }) })) as unknown as typeof fetch;

    expect(await fetchGatewayModels()).toEqual([]);
  });
});
