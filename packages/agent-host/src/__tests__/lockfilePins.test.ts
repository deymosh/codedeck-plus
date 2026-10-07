import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageTree, platformPackages, renderDshPackages, renderPlatformPackages } from '../lockfilePins';

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

// A format-9 lockfile in miniature: metadata in `packages:`, resolved graphs
// in `snapshots:` with pnpm's `(peer…)`/`(hash)` id suffixes, the root pinned
// for an importer, and a name the closure needs at two versions (negotiator)
// — the walker must read through all of that and place every entry where
// Node would resolve it.
const TREE_LOCKFILE = `lockfileVersion: '9.0'

importers:

  packages/agent-host:
    dependencies:
      kept:
        specifier: ^1.0.0
        version: 1.0.0
    devDependencies:
      '@deepseek-ai/dsh':
        specifier: 1.0.0
        version: 1.0.0(ab12cd34)

packages:

  '@deepseek-ai/dsh@1.0.0':
    resolution: {integrity: sha512-dsh}
    hasBin: true

  '@deepseek-ai/dsh-base@1.0.0':
    resolution: {integrity: sha512-base}

  commander@15.0.0:
    resolution: {integrity: sha512-commander}
    version: 15.0.0

  negotiator@0.6.4:
    resolution: {integrity: sha512-neg-old}

  negotiator@1.1.0:
    resolution: {integrity: sha512-neg-new}

  wasm-fallback@1.0.0:
    resolution: {integrity: sha512-wasm}

  darwin-only@1.0.0:
    resolution: {integrity: sha512-darwin}
    os: [darwin]

  unrelated@2.0.0:
    resolution: {integrity: sha512-unrelated}

snapshots:

  '@deepseek-ai/dsh@1.0.0(ab12cd34)':
    dependencies:
      '@deepseek-ai/dsh-base': 1.0.0(cd34ef56)
      commander: 15.0.0
      negotiator: 1.1.0
      wasm-fallback: 1.0.0

  '@deepseek-ai/dsh-base@1.0.0(cd34ef56)':
    dependencies:
      commander: 15.0.0
      negotiator: 0.6.4
    optionalDependencies:
      darwin-only: 1.0.0
`;

describe('packageTree', () => {
  it('places the closure, nesting a second version under its consumer', () => {
    expect(packageTree(TREE_LOCKFILE, 'packages/agent-host', '@deepseek-ai/dsh')).toEqual([
      { name: '@deepseek-ai/dsh', version: '1.0.0', integrity: 'sha512-dsh', dest: 'node_modules/@deepseek-ai/dsh' },
      { name: '@deepseek-ai/dsh-base', version: '1.0.0', integrity: 'sha512-base', dest: 'node_modules/@deepseek-ai/dsh-base' },
      { name: 'negotiator', version: '1.1.0', integrity: 'sha512-neg-new', dest: 'node_modules/@deepseek-ai/dsh/node_modules/negotiator' },
      { name: 'commander', version: '15.0.0', integrity: 'sha512-commander', dest: 'node_modules/commander' },
      { name: 'darwin-only', version: '1.0.0', integrity: 'sha512-darwin', dest: 'node_modules/darwin-only', optional: true, os: ['darwin'] },
      { name: 'negotiator', version: '0.6.4', integrity: 'sha512-neg-old', dest: 'node_modules/negotiator' },
      { name: 'wasm-fallback', version: '1.0.0', integrity: 'sha512-wasm', dest: 'node_modules/wasm-fallback' },
    ]);
  });

  it('refuses ambiguous peer resolutions of one package', () => {
    const ambiguous = TREE_LOCKFILE.replace(
      'snapshots:',
      "snapshots:\n\n  '@deepseek-ai/dsh-base@1.0.0(other)':\n    dependencies:\n      commander: 15.0.0",
    );
    expect(() => packageTree(ambiguous, 'packages/agent-host', '@deepseek-ai/dsh')).toThrow(/peer resolutions of @deepseek-ai\/dsh-base@1\.0\.0/);
  });

  it('refuses a dependency with no pinned entry', () => {
    const dangling = TREE_LOCKFILE.replace(
      "  '@deepseek-ai/dsh@1.0.0(ab12cd34)':\n    dependencies:",
      "  '@deepseek-ai/dsh@1.0.0(ab12cd34)':\n    dependencies:\n      ghost: 1.0.0",
    );
    expect(() => packageTree(dangling, 'packages/agent-host', '@deepseek-ai/dsh')).toThrow(/no pinned entry for ghost@1\.0\.0/);
  });

  it('refuses a root the importer does not pin', () => {
    expect(() => packageTree(TREE_LOCKFILE, 'packages/agent-host', 'not-a-dep')).toThrow(/does not pin not-a-dep/);
  });
});

describe('src/generated/dshPackages.ts', () => {
  it('matches pnpm-lock.yaml', async () => {
    const lockfile = fs.readFileSync(path.resolve(__dirname, '../../../../pnpm-lock.yaml'), 'utf8');
    await expect(renderDshPackages(packageTree(lockfile, 'packages/agent-host', '@deepseek-ai/dsh'))).toMatchFileSnapshot(
      '../generated/dshPackages.ts',
    );
  });
});
