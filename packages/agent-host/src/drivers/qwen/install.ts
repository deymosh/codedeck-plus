/**
 * Where Qwen Code comes from when the machine has none: `@qwen-code/qwen-code`
 * and its dependency closure, installed on demand (agentInstall
 * .installPackageTree) at the version and sha512 pnpm-lock.yaml pins
 * (src/generated/qwenPackages.ts). The release archives and the default image
 * ship no part of it — a driver that finds nothing on the machine downloads
 * the tree the first time it needs it.
 *
 * The published package is one bundle with no runtime dependencies of its own;
 * the pins carry its optional native packages too (a PTY, the clipboard,
 * image handling), which the tree installer skips where the platform does not
 * match. `cli-entry.js` is the CLI's entry point, run with the host's own
 * node — the same way the `qwen` bin script runs it.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { installedPackageTree, installPackageTree, type InstallOptions } from '../../install/agentInstall';
import { QWEN_PACKAGES } from '../../generated/qwenPackages';
import { isFile } from '../../sdk/executable';

/** The npm package Qwen Code ships as. */
export const QWEN_PACKAGE = '@qwen-code/qwen-code';
/** Its CLI, relative to the installed package directory. */
const QWEN_ENTRY = 'cli-entry.js';
/** How the driver refers to it in progress lines and errors. */
export const QWEN_LABEL = 'Qwen Code';

/** The CLI entry point of a tree the installer has laid down. */
export function qwenEntryPoint(treeRoot: string): string {
  return path.join(treeRoot, QWEN_ENTRY);
}

/** The CLI entry point of the pinned tree when it is installed, else null. */
export function installedQwenTree(cacheDir: string): string | null {
  const root = installedPackageTree(QWEN_PACKAGE, QWEN_PACKAGES, cacheDir);
  return root ? qwenEntryPoint(root) : null;
}

/** Install (or find) the Qwen Code tree and return its CLI entry point. */
export async function installQwenTree(options: InstallOptions): Promise<string> {
  return qwenEntryPoint(await installPackageTree(QWEN_PACKAGE, QWEN_PACKAGES, { ...options, label: QWEN_LABEL }));
}

/** The CLI of the package when it is installed beside the host — a dev
 *  checkout or the image, where pnpm-lock.yaml pins it as a devDependency —
 *  else null. Resolved from the package's own manifest, since its `bin` names
 *  `cli-entry.js` while its `main` is `cli.js`. */
export function bundledQwenExecutable(): string | null {
  try {
    const manifest = createRequire(import.meta.url).resolve(`${QWEN_PACKAGE}/package.json`);
    const entry = path.join(path.dirname(manifest), QWEN_ENTRY);
    return isFile(entry) ? entry : null;
  } catch {
    return null;
  }
}
