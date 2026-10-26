/**
 * Reading an agent's release, for the catalog: from the manifest of the
 * package it was installed from when there is one (no process), else from
 * its binary's `--version`.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

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
    execFile(binary, ['--version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : parseVersion(String(stdout)));
    });
  });
}
