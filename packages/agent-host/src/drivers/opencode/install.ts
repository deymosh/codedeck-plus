/**
 * Where the `opencode` binary comes from when auto-start is on and none is
 * installed: the per-platform npm package the `@opencode/cli` package
 * depends on (`@opencode/cli-<os>-<arch>[-baseline][-musl]`, the binary
 * under `bin/`), installed on demand (agentInstall.ts). `@opencode/cli` is
 * a dev dependency of the agent host only so that pnpm-lock.yaml pins those
 * packages; keep its version in step with the OpenCode client's.
 */
import type { PackagedBinary } from '../../install/agentInstall';
import { exeName, isMusl } from '../../sdk/executable';

/** The platform package for a machine. On x64 it is the `baseline` build,
 *  which runs on any x64 CPU (the default one needs AVX2). */
export function openCodePlatformPackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(),
): string {
  const os = platform === 'win32' ? 'windows' : platform;
  const baseline = arch === 'x64' ? '-baseline' : '';
  const libc = platform === 'linux' && musl ? '-musl' : '';
  return `@opencode/cli-${os}-${arch}${baseline}${libc}`;
}

/** The `opencode` binary as an on-demand install. */
export function openCodeBinary(): PackagedBinary {
  return { pkg: openCodePlatformPackage(), file: `bin/${exeName('opencode')}`, label: 'OpenCode' };
}
