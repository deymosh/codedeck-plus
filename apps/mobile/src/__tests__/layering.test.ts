/**
 * Layering guard: production phone code (src/core, src/platform, src/ui, the
 * entrypoints) must NEVER import @codedeck/core, @codedeck/testkit, or
 * @codedeck/protocol. Bridge engine + testkit are devDependencies for the
 * contract tests only; `core/nativeCoreTypes.ts` (generated from
 * `crates/protocol`/`client-core`/`client-runtime`) is the source of truth for
 * every wire TYPE this app uses, and `core/protocolConstants.ts` mirrors the
 * small amount of RUNTIME behavior (effort/permission-mode validation,
 * capability strings, default relays, the provider-base-url rule) the same
 * way `core/crypto.ts` mirrors `@codedeck/core`'s crypto helpers — so the
 * phone depends on neither package at runtime any more.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionDirs = ['core', 'platform', 'ui']
  .map((d) => path.join(srcDir, d))
  .filter((d) => existsSync(d));

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue; // tests may use the harness packages
      out.push(...tsFilesUnder(full));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('phone core layering', () => {
  it('production phone code imports none of @codedeck/core, @codedeck/testkit, @codedeck/protocol', () => {
    const files = productionDirs.flatMap((dir) => tsFilesUnder(dir));
    for (const name of readdirSync(srcDir)) {
      if (name.endsWith('.ts') || name.endsWith('.tsx')) {
        files.push(path.join(srcDir, name)); // entrypoints: main.tsx etc.
      }
    }
    expect(files.length).toBeGreaterThan(10); // sanity: the scan sees the tree
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} must not import @codedeck/core`).not.toMatch(
        /from\s+['"]@codedeck\/core['"]/,
      );
      expect(source, `${file} must not import @codedeck/testkit`).not.toMatch(
        /from\s+['"]@codedeck\/testkit['"]/,
      );
      expect(source, `${file} must not import @codedeck/protocol`).not.toMatch(
        /from\s+['"]@codedeck\/protocol['"]/,
      );
    }
  });
});
