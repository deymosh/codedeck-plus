/**
 * The source layout's import rules, so a driver stays a folder that can be
 * added or removed on its own:
 * - a driver imports only the driver SDK (`sdk/`), the installer
 *   (`install/`), the generated pins and types (`generated/`) and its own
 *   folder — never the host, never another driver;
 * - the SDK and the installer import no driver and nothing of the host;
 * - outside the drivers, only the module list (`host/modules.ts`) names one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Every relative import of a file, as a path relative to src/. */
function imports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/(?:from|import)\s+['"](\.[^'"]*)['"]/g)].map((m) => m[1]!);
  return specs.map((spec) => path.relative(SRC, path.resolve(path.dirname(file), spec)).split(path.sep).join('/'));
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');
const isTest = (file: string) => rel(file).split('/').includes('__tests__');
const under = (target: string, dir: string) => target === dir || target.startsWith(`${dir}/`);

function violations(files: string[], allowed: (file: string, target: string) => boolean): string[] {
  return files.flatMap((file) => imports(file).filter((t) => !allowed(file, t)).map((t) => `${rel(file)} -> ${t}`));
}

describe('source layout', () => {
  const all = sources(SRC);

  it('a driver imports only the SDK, the installer, generated code and its own folder', () => {
    const drivers = all.filter((f) => rel(f).startsWith('drivers/'));
    const bad = violations(drivers, (file, target) => {
      const own = rel(file).split('/').slice(0, 2).join('/');
      return ['sdk', 'install', 'generated', own].some((dir) => under(target, dir));
    });
    expect(bad).toEqual([]);
  });

  it('the SDK and the installer import no driver and nothing of the host', () => {
    const shared = all.filter((f) => /^(sdk|install)\//.test(rel(f)) && !isTest(f));
    const bad = violations(shared, (_file, target) => !under(target, 'drivers') && !under(target, 'host'));
    expect(bad).toEqual([]);
  });

  it('outside the drivers, only the module list names a driver', () => {
    const rest = all.filter((f) => !rel(f).startsWith('drivers/') && !isTest(f) && rel(f) !== 'host/modules.ts');
    const bad = violations(rest, (_file, target) => !under(target, 'drivers'));
    expect(bad).toEqual([]);
  });

  it('every driver folder registers one module', () => {
    const folders = fs.readdirSync(path.join(SRC, 'drivers'), { withFileTypes: true }).filter((e) => e.isDirectory());
    const list = fs.readFileSync(path.join(SRC, 'host/modules.ts'), 'utf8');
    for (const folder of folders) {
      expect(fs.existsSync(path.join(SRC, 'drivers', folder.name, 'module.ts')), folder.name).toBe(true);
      expect(list, folder.name).toContain(`'../drivers/${folder.name}/module'`);
    }
  });
});
