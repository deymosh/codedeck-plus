import { describe, expect, it } from 'vitest';
import { claudePlatformPackage } from '../drivers/claude/install';
import { openCodePlatformPackage } from '../drivers/opencode/install';
import { PLATFORM_PACKAGES } from '../generated/platformPackages';

/** Every machine a bridge may run on, as Node names it. */
const MACHINES: Array<[NodeJS.Platform, string, boolean]> = [
  ['linux', 'x64', false],
  ['linux', 'x64', true],
  ['linux', 'arm64', false],
  ['linux', 'arm64', true],
  ['darwin', 'x64', false],
  ['darwin', 'arm64', false],
  ['win32', 'x64', false],
  ['win32', 'arm64', false],
];

describe('platform packages', () => {
  it('name the Claude Agent SDK platform packages', () => {
    expect(claudePlatformPackage('linux', 'x64', false)).toBe('@anthropic-ai/claude-agent-sdk-linux-x64');
    expect(claudePlatformPackage('linux', 'arm64', true)).toBe('@anthropic-ai/claude-agent-sdk-linux-arm64-musl');
    expect(claudePlatformPackage('win32', 'x64', false)).toBe('@anthropic-ai/claude-agent-sdk-win32-x64');
  });

  it('name the OpenCode platform packages, baseline on x64', () => {
    expect(openCodePlatformPackage('linux', 'x64', false)).toBe('opencode-linux-x64-baseline');
    expect(openCodePlatformPackage('linux', 'x64', true)).toBe('opencode-linux-x64-baseline-musl');
    expect(openCodePlatformPackage('linux', 'arm64', true)).toBe('opencode-linux-arm64-musl');
    expect(openCodePlatformPackage('darwin', 'arm64', false)).toBe('opencode-darwin-arm64');
    expect(openCodePlatformPackage('win32', 'x64', false)).toBe('opencode-windows-x64-baseline');
  });

  // A name the lockfile does not pin could never be installed.
  it.each(MACHINES)('are pinned for %s %s (musl: %s)', (platform, arch, musl) => {
    expect(PLATFORM_PACKAGES[claudePlatformPackage(platform, arch, musl)]).toBeDefined();
    expect(PLATFORM_PACKAGES[openCodePlatformPackage(platform, arch, musl)]).toBeDefined();
  });
});
