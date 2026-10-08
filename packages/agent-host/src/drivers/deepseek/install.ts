/**
 * Where the DeepSeek Harness runtime comes from when the machine has none:
 * `@deepseek-ai/dsh` and its whole dependency closure, installed on demand
 * (agentInstall.installPackageTree) at the version and sha512 pnpm-lock.yaml
 * pins (src/generated/dshPackages.ts). The release archives and the default
 * image ship no part of it — a driver that finds nothing on the machine
 * downloads the tree the first time it needs it.
 *
 * The harness is a pure-JS CLI: nothing runs until every package of that
 * closure sits in one `node_modules`, which is what the tree installer
 * reproduces. `lib/bin.js` is the CLI's entry point, run with the host's own
 * `node`.
 */
import * as path from 'node:path';
import { installedPackageTree, installPackageTree, type InstallOptions } from '../../install/agentInstall';
import { DSH_PACKAGES } from '../../generated/dshPackages';

/** The npm package the harness ships as. */
export const DSH_PACKAGE = '@deepseek-ai/dsh';
/** Its CLI, relative to the installed package directory. */
const DSH_ENTRY = 'lib/bin.js';
/** How the driver refers to it in progress lines and errors. */
export const DSH_LABEL = 'DeepSeek Harness';

/** The CLI entry point of a tree the installer has laid down. */
export function dshEntryPoint(treeRoot: string): string {
  return path.join(treeRoot, DSH_ENTRY);
}

/** The CLI entry point of the pinned tree when it is installed, else null. */
export function installedDshTree(cacheDir: string): string | null {
  const root = installedPackageTree(DSH_PACKAGE, DSH_PACKAGES, cacheDir);
  return root ? dshEntryPoint(root) : null;
}

/** Install (or find) the harness tree and return its CLI entry point. */
export async function installDshTree(options: InstallOptions): Promise<string> {
  return dshEntryPoint(await installPackageTree(DSH_PACKAGE, DSH_PACKAGES, { ...options, label: DSH_LABEL }));
}
