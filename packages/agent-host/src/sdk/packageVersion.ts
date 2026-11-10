/**
 * The release of an agent's npm package, read from the entry point it runs.
 */
import { readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';

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
