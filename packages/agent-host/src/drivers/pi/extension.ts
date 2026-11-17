/**
 * The extension CodeDeck installs into every Pi session: the permission gate,
 * and the provider profile a bound session runs on.
 *
 * Pi loads an extension as a module whose default export is a function that
 * receives Pi's `ExtensionAPI`. The driver serialises the function below with
 * `Function.prototype.toString()` and writes `export default <function>` into
 * Pi's config directory before a session starts (installPiExtension), then
 * passes that file with `-e`. That is what makes this function special: it
 * runs inside Pi's process, where nothing this host defines exists, so it must
 * stay self-contained — no imports, and no reference to any module-scope
 * binding other than types (which are erased). Everything it needs comes from
 * its `pi` argument, its `ctx` argument, or a global.
 *
 * What it does:
 *
 * - `tool_call` — every tool call Pi is about to run is held until the driver
 *   answers. The title carries the call's id (`PI_PERMISSION_PREFIX` + id), so
 *   the driver can build the card from the `tool_execution_start` facts it
 *   already has. Pi's extension UI `select` is the dialog the RPC client
 *   answers with `extension_ui_response`; anything but "allow" blocks the call
 *   with a fixed reason. The driver decides whether to ask at all: `yolo`, a
 *   read-only tool and "allow for this session" are answered "allow" without
 *   a card ever reaching the phone.
 * - a provider profile, when the session is bound to one — registered at
 *   startup with Pi's `openai-completions` API, its token read from the
 *   environment through Pi's `$NAME` interpolation so the secret never reaches
 *   the file on disk. Its models become selectable as `<provider>/<model>`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The prefix the `tool_call` dialog's title carries, before the call's id.
 *  The driver matches on it to tell CodeDeck's gate from another extension's
 *  own dialog. */
export const PI_PERMISSION_PREFIX = 'codedeck-permission:';

/** The `ExtensionAPI` surface this extension uses, typed locally: the module
 *  is serialised, so the real types are not available at run time. */
interface PiExtensionApi {
  registerProvider(id: string, config: Record<string, unknown>): void;
  on(
    event: 'tool_call',
    handler: (event: { toolCallId: string; toolName: string; input: unknown }, ctx: PiExtensionContext) => Promise<unknown>,
  ): void;
}

interface PiExtensionContext {
  ui: { select(title: string, options: string[]): Promise<string | undefined> };
}

/**
 * The extension's body. Keep it self-contained: see the module comment.
 * `PI_PERMISSION_PREFIX` is written out as a literal because the constant is
 * erased with the rest of this module when Pi loads the serialised function.
 */
export function codedeckPiExtension(pi: PiExtensionApi): void {
  const profile = process.env.CODEDECK_PI_PROVIDER;
  if (profile) {
    try {
      // `baseUrl` is already the profile's versioned API root: the driver
      // resolved it (env.ts), so the one rule for it lives in the host.
      const parsed = JSON.parse(profile);
      const baseUrl = String(parsed.baseUrl || '');
      const models = Array.isArray(parsed.models) ? parsed.models : [];
      pi.registerProvider(String(parsed.id || 'codedeck'), {
        name: String(parsed.label || parsed.id || 'CodeDeck provider'),
        baseUrl: baseUrl,
        api: 'openai-completions',
        apiKey: '$CODEDECK_PI_PROVIDER_TOKEN',
        models: models.map(function (model: { id: string; label?: string; contextWindow?: number }) {
          return {
            id: String(model.id),
            name: String(model.label || model.id),
            // A profile carries no reasoning metadata: Pi sends no thinking
            // parameters, and the model clamps every level to off.
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: Number(model.contextWindow) > 0 ? Number(model.contextWindow) : 128000,
            maxTokens: 32768,
          };
        }),
      });
    } catch {
      // A malformed profile is not a reason to keep Pi from starting: the
      // session runs Pi's own models and reports what it cannot do.
    }
  }
  pi.on('tool_call', async function (event, ctx) {
    const choice = await ctx.ui.select('codedeck-permission:' + event.toolCallId, ['allow', 'deny']);
    if (choice !== 'allow') return { block: true, reason: 'Denied by the user' };
    return undefined;
  });
}

/** The extension file's contents: one ESM module with the function above as
 *  its default export. Deterministic, so the driver writes it only when it
 *  changed. */
export function codedeckPiExtensionSource(): string {
  return (
    '// Written by CodeDeck+ — the permission gate and provider registration of\n' +
    '// every Pi session. Regenerated at each session start; do not edit.\n' +
    `export default ${codedeckPiExtension.toString()};\n`
  );
}

/** Where Pi finds the extension: a directory of its own under the state root,
 *  which Pi never scans on its own (only the `-e` path names it). */
export function piExtensionPath(home: string): string {
  return path.join(home, 'codedeck', 'codedeck-pi.js');
}

/** Write the extension file when its contents changed, and return its path. */
export function installPiExtension(home: string): string {
  const file = piExtensionPath(home);
  const source = codedeckPiExtensionSource();
  try {
    if (fs.readFileSync(file, 'utf8') === source) return file;
  } catch {
    // Not there yet: written below.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}
