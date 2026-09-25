import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformPackages, renderPlatformPackages } from '../lockfilePins';

const LOCKFILE = `lockfileVersion: '9.0'

importers:

  packages/x:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: 1.0.0

packages:

  '@scope/tool-linux-x64@2.0.0':
    resolution: {integrity: sha512-linux}
    cpu: [x64]
    os: [linux]

  '@scope/tool-linux-x64-musl@2.0.0':
    resolution: {integrity: sha512-musl}
    cpu: [x64]
    os: [linux]
    libc: [musl]

  foo@1.0.0:
    resolution: {integrity: sha512-foo}

  plain-bin@3.1.0:
    resolution: {integrity: sha512-plain}
    os: [win32]
    hasBin: true

snapshots:

  foo@1.0.0: {}
`;

describe('platformPackages', () => {
  it('pins exactly the entries that declare os or cpu', () => {
    expect(platformPackages(LOCKFILE)).toEqual({
      '@scope/tool-linux-x64': { version: '2.0.0', integrity: 'sha512-linux' },
      '@scope/tool-linux-x64-musl': { version: '2.0.0', integrity: 'sha512-musl' },
      'plain-bin': { version: '3.1.0', integrity: 'sha512-plain' },
    });
  });

  it('refuses a package locked at two versions', () => {
    const twice = LOCKFILE.replace(
      'snapshots:',
      "  '@scope/tool-linux-x64@2.1.0':\n    resolution: {integrity: sha512-other}\n    os: [linux]\n\nsnapshots:",
    );
    expect(() => platformPackages(twice)).toThrow(/two versions of @scope\/tool-linux-x64/);
  });
});

describe('src/generated/platformPackages.ts', () => {
  // `vitest run -u` (the gen:platform-packages script) rewrites it; a plain
  // run fails when it no longer matches the lockfile.
  it('matches pnpm-lock.yaml', async () => {
    const lockfile = fs.readFileSync(path.resolve(__dirname, '../../../../pnpm-lock.yaml'), 'utf8');
    await expect(renderPlatformPackages(platformPackages(lockfile))).toMatchFileSnapshot('../generated/platformPackages.ts');
  });
});
