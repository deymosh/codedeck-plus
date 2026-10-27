/**
 * OpenCode's global config files, read and edited the way OpenCode itself
 * does (verified against the 2.1.4 binary):
 *
 * - They are `config.json`, `opencode.json` and `opencode.jsonc` in its
 *   config directory, read in that order, a later file overriding an earlier
 *   one.
 * - Each is JSONC: comments and trailing commas are fine. OpenCode's own
 *   tools create and edit them (`opencode mcp add --global` writes to the
 *   first of `opencode.json` / `opencode.jsonc` that exists, else creates
 *   `opencode.json`), so a machine may well have an `opencode.jsonc` its
 *   owner never wrote.
 *
 * An edit here changes only the values it names and keeps everything else in
 * the file — comments, order, formatting — as OpenCode's own edits do.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
// The ESM build: the package's default (UMD) entry loads its parts with a
// runtime `require` the bundle cannot follow, so the bundled host would
// fail to start.
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser/lib/esm/main.js';

/** The files OpenCode reads its global config from, in its order. */
export function openCodeGlobalConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
  return ['config.json', 'opencode.json', 'opencode.jsonc'].map((f) => path.join(base, 'opencode', f));
}

/** One global config file as read. */
export interface GlobalConfig {
  path: string;
  config: Record<string, unknown>;
}

/** Parse a config file's text; why not, when it is not a JSONC object. */
function parseConfig(file: string, text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !config || typeof config !== 'object' || Array.isArray(config)) {
    const why = errors.length > 0 ? printParseErrorCode(errors[0]!.error) : 'not an object';
    throw new Error(`${file} is not a valid OpenCode config (${why}); fix it by hand.`);
  }
  return config as Record<string, unknown>;
}

/** `file`'s config, or undefined when there is no such file. A file that
 *  does not parse is an error: editing it would guess at what it means. */
export async function readGlobalConfig(file: string): Promise<GlobalConfig | undefined> {
  if (!existsSync(file)) return undefined;
  return { path: file, config: parseConfig(file, await readFile(file, 'utf8')) };
}

/** Every global config file that exists and parses, in OpenCode's order. A
 *  broken one is left out of what is listed, as nothing it says applies. */
export async function readGlobalConfigs(files: readonly string[]): Promise<GlobalConfig[]> {
  const out: GlobalConfig[] = [];
  for (const file of files) {
    const read = await readGlobalConfig(file).catch(() => undefined);
    if (read) out.push(read);
  }
  return out;
}

/** Where a new entry goes: the file OpenCode's own `--global` edits use. */
export function newEntryFile(files: readonly string[]): string {
  const own = files.filter((f) => ['opencode.json', 'opencode.jsonc'].includes(path.basename(f)));
  return own.find((f) => existsSync(f)) ?? own[0] ?? files[0]!;
}

/** One value to set (or, `undefined`, to remove) at a path in the file. */
export interface ConfigEdit {
  path: (string | number)[];
  value: unknown;
}

/** Apply `edits` to `file` (creating it when there is none), changing only
 *  the values they name. */
export async function editGlobalConfig(file: string, edits: readonly ConfigEdit[]): Promise<void> {
  let text = existsSync(file) ? await readFile(file, 'utf8') : '{}\n';
  parseConfig(file, text);
  for (const edit of edits) {
    text = applyEdits(text, modify(text, edit.path, edit.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text.endsWith('\n') ? text : `${text}\n`);
}
