/**
 * Where Pi's runtime comes from when the machine has none:
 * `@earendil-works/pi-coding-agent` and its whole dependency closure,
 * installed on demand (agentInstall.installPackageTree) at the version and
 * sha512 pnpm-lock.yaml pins (src/generated/piPackages.ts). The release
 * archives and the default image ship no part of it — a driver that finds
 * nothing on the machine downloads the tree the first time it needs it.
 *
 * Pi is a pure-JS CLI: nothing runs until every package of that closure sits
 * in one `node_modules`, which is what the tree installer reproduces.
 * `dist/bundle/cli.js` is the CLI's entry point, run with the host's own
 * `node` — the same file the package's `bin` names.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { installedPackageTree, installPackageTree, type InstallOptions } from '../../install/agentInstall';
import { PI_PACKAGES } from '../../generated/piPackages';
import { isFile } from '../../sdk/executable';

/** The npm package Pi ships as. */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
/** Its CLI, relative to the installed package directory. */
const PI_ENTRY = 'dist/bundle/cli.js';
/** How the driver refers to it in progress lines and errors. */
export const PI_LABEL = 'Pi';

/** The CLI entry point of a tree the installer has laid down. */
export function piEntryPoint(treeRoot: string): string {
  return path.join(treeRoot, ...PI_ENTRY.split('/'));
}

/** The CLI entry point of the pinned tree when it is installed, else null. */
export function installedPiTree(cacheDir: string): string | null {
  const root = installedPackageTree(PI_PACKAGE, PI_PACKAGES, cacheDir);
  return root ? piEntryPoint(root) : null;
}

/** Install (or find) the Pi tree and return its CLI entry point. */
export async function installPiTree(options: InstallOptions): Promise<string> {
  return piEntryPoint(await installPackageTree(PI_PACKAGE, PI_PACKAGES, { ...options, label: PI_LABEL }));
}

/** The CLI of the package when it is installed beside the host — a dev
 *  checkout, where pnpm-lock.yaml pins it as a devDependency — else null. Found by walking up from this module to a `node_modules` that
 *  holds it; the package's `exports` map names neither the manifest nor the
 *  bundle its `bin` entry runs, so neither `require.resolve` nor a subpath
 *  import can reach them. */
export function bundledPiExecutable(): string | null {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const entry = path.join(dir, 'node_modules', ...PI_PACKAGE.split('/'), ...PI_ENTRY.split('/'));
    if (isFile(entry)) return entry;
    if (path.dirname(dir) === dir) return null;
  }
}
