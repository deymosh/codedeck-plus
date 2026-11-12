import { describe, expect, it } from 'vitest';

import { downloadUrl, parseRelease, platformKey, PLATFORMS } from '../release.js';

const manifest = () => ({
  version: 'v1.4.0',
  repository: 'deymosh/codedeck-plus',
  assets: Object.fromEntries(
    PLATFORMS.map((key) => [key, { name: `codedeck-bridge-v1.4.0-${key}.${key.startsWith('windows') ? 'zip' : 'tar.xz'}`, sha256: 'a'.repeat(64) }]),
  ),
});

describe('the release manifest', () => {
  it('names the archive to download for each platform a release builds', () => {
    const release = parseRelease(manifest())!;
    const key = platformKey('linux', 'x64')!;
    expect(downloadUrl(release, release.assets[key]!)).toBe(
      'https://github.com/deymosh/codedeck-plus/releases/download/v1.4.0/codedeck-bridge-v1.4.0-linux-x86_64.tar.xz',
    );
    expect(platformKey('win32', 'arm64'), 'Windows on Arm runs the x86_64 build').toBe('windows-x86_64');
    expect(platformKey('darwin', 'x64'), 'no release builds macOS on Intel').toBeUndefined();
  });

  it('is refused whole when any part is malformed', () => {
    const broken = [
      null,
      { ...manifest(), version: '1.4.0' },
      { ...manifest(), repository: 'not a repo' },
      { ...manifest(), assets: { 'linux-x86_64': manifest().assets['linux-x86_64'] } },
    ];
    const tamper = (key: string, asset: object) => {
      const m = manifest();
      m.assets[key] = asset as never;
      return m;
    };
    broken.push(tamper('macos-aarch64', { name: 'x.tar.xz', sha256: 'A'.repeat(64) }));
    broken.push(tamper('windows-x86_64', { name: '../escape.zip', sha256: 'a'.repeat(64) }));
    for (const raw of broken) expect(parseRelease(raw), JSON.stringify(raw)).toBeUndefined();
  });
});
