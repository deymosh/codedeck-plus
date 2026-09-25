/**
 * Where the `opencode` binary comes from when auto-start is on and none is
 * installed: the per-platform npm package the `opencode-ai` CLI package
 * depends on (`opencode-<os>-<arch>[-baseline][-musl]`, the binary under
 * `bin/`), installed on demand (agentInstall.ts). `opencode-ai` is a dev
 * dependency of the agent host only so that pnpm-lock.yaml pins those
 * packages; keep its version in step with the OpenCode SDK's.
 */
import type { PackagedBinary } from '../../agentInstall';
import { exeName, isMusl } from '../../executable';

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
  return `opencode-${os}-${arch}${baseline}${libc}`;
}

/** The `opencode` binary as an on-demand install. */
export function openCodeBinary(): PackagedBinary {
  return { pkg: openCodePlatformPackage(), file: `bin/${exeName('opencode')}`, label: 'OpenCode' };
}
