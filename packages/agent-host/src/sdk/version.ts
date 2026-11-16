/**
 * Reading an agent's release, for the catalog: from the manifest of the
 * package it was installed from when there is one (no process), else from
 * its binary's `--version`, or from the npm package an entry point it runs
 * belongs to.
 */
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';

/** The first `MAJOR.MINOR.PATCH[-pre][+build]` in `text`. */
export function parseVersion(text: string): string | undefined {
  return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/.exec(text)?.[0];
}

/** A manifest field (`version` unless named), or undefined when the file or
 *  the field is missing. */
export async function manifestVersion(manifest: string, field = 'version'): Promise<string | undefined> {
  try {
    const value = (JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** What `<binary> --version` prints, as a version; undefined when it fails,
 *  prints none, or takes longer than `timeoutMs`. */
export function binaryVersion(binary: string, timeoutMs = 15_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    // A Windows `.cmd`/`.bat` shim (an npm-installed CLI) runs only through
    // the shell; the path is the operator's own setting, not input.
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
    execFile(shell ? `"${binary}"` : binary, ['--version'], { timeout: timeoutMs, windowsHide: true, shell }, (err, stdout) => {
      resolve(err ? undefined : parseVersion(String(stdout)));
    });
  });
}

/**
 * The `version` of the package named `name` that `entry` belongs to: the
 * nearest `package.json` above it that carries that name. The entry is
 * resolved through symlinks first, since an operator's CLI is usually a link
 * on `PATH` into wherever the package lives (a global install, a source
 * checkout). Undefined when no such manifest is found.
 */
export async function packageVersionOf(entry: string, name: string): Promise<string | undefined> {
  let dir: string;
  try {
    dir = path.dirname(await realpath(entry));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 8; depth++) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (manifest.name === name && typeof manifest.version === 'string') return manifest.version;
    } catch {
      // No manifest here, or not JSON: keep looking further up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
