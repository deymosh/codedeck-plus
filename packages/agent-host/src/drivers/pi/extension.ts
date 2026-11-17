/**
 * Where the CodeDeck Pi extension (extension/index.ts) comes from and where
 * Pi finds it.
 *
 * The extension is bundled on its own and carried inside the agent host as
 * text: the build defines `__CODEDECK_PI_EXTENSION__` (build.mjs, through
 * extension/bundle.mjs), and so does the test configuration. Before a session
 * starts, the driver writes that text into a directory of Pi's home that Pi
 * never scans on its own and passes the file with `-e`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export { PI_PERMISSION_PREFIX } from './extension/protocol';

declare const __CODEDECK_PI_EXTENSION__: string | undefined;

/** The bundled extension's text, or nothing when this host was built
 *  without it (a source run outside the build and the tests). */
export function bundledPiExtension(): string | undefined {
  return typeof __CODEDECK_PI_EXTENSION__ === 'string' ? __CODEDECK_PI_EXTENSION__ : undefined;
}

/** Where Pi finds the extension: a directory of its own under the state root,
 *  which Pi never scans on its own (only the `-e` path names it). */
export function piExtensionPath(home: string): string {
  return path.join(home, 'codedeck', 'codedeck-pi.js');
}

/**
 * Write the extension file when its contents changed, and return its path.
 * Throws when this host carries no extension: a Pi session without the gate
 * would run every tool call unasked.
 */
export function installPiExtension(home: string, source: string | undefined): string {
  if (source === undefined) throw new Error('this agent host was built without the CodeDeck Pi extension');
  const file = piExtensionPath(home);
  try {
    if (fs.readFileSync(file, 'utf8') === source) return file;
  } catch {
    // Not there yet: written below.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}
