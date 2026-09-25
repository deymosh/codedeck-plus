/**
 * Where the Claude Code binary comes from when none is installed on the
 * machine. The Agent SDK ships it in a per-platform npm package
 * (`@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]`, the binary at its
 * root). The Docker image and a dev checkout have that package installed;
 * the release archives leave it out and the driver installs it on demand
 * (agentInstall.ts), at the version the SDK itself is locked to.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { PackagedBinary } from '../../agentInstall';
import { exeName, isFile, isMusl } from '../../executable';

/** The SDK's platform package for a machine. */
export function claudePlatformPackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(),
): string {
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}${platform === 'linux' && musl ? '-musl' : ''}`;
}

/** The Claude Code binary as an on-demand install. */
export function claudeBinary(): PackagedBinary {
  return { pkg: claudePlatformPackage(), file: exeName('claude'), label: 'Claude Code' };
}

/** The binary of the SDK's platform package when it is installed beside the
 *  SDK (resolved from the SDK, as the SDK itself does). */
export function bundledClaudeExecutable(): string | null {
  try {
    const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const manifest = createRequire(sdk).resolve(`${claudePlatformPackage()}/package.json`);
    const binary = path.join(path.dirname(manifest), exeName('claude'));
    return isFile(binary) ? binary : null;
  } catch {
    return null;
  }
}
