/**
 * Which language server checks a file, and from which project root.
 *
 * Only a server already on the machine is used — the project's own first
 * (its `node_modules`, its virtualenv), then `PATH` — and nothing is ever
 * installed: a file whose server is not there gets no diagnostics. Each
 * entry was run against the real server (see ./client.ts for what each one
 * sends): typescript-language-server 6.1 with TypeScript 5.9, TypeScript
 * 7.0's own `tsc --lsp`, Pyright and basedpyright, rust-analyzer 1.99.
 */
import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

export type Language = 'typescript' | 'rust' | 'python';

/** How to start one server. */
export interface ServerCommand {
  /** The server's own name, which the model reads in front of what it says. */
  name: string;
  command: string;
  args: string[];
  /** A Windows `.cmd`/`.bat` shim (npm's), which only a shell can start. */
  shell?: boolean;
}

/** The server for one file: what to start, where, and the file's LSP language. */
export interface ServerChoice {
  language: Language;
  languageId: string;
  root: string;
  server: ServerCommand;
}

/** What the lookup reads of the machine; the real one is `machine()`. */
export interface Machine {
  isFile(file: string): boolean;
  readText(file: string): string | undefined;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** The Node that runs Pi, which also runs a server that is a Node script. */
  execPath: string;
}

export function machine(env: Record<string, string | undefined> = process.env): Machine {
  return {
    isFile: (file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    },
    readText: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    env,
    platform: process.platform,
    execPath: process.execPath,
  };
}

const LANGUAGES: Record<string, [Language, string]> = {
  '.ts': ['typescript', 'typescript'],
  '.mts': ['typescript', 'typescript'],
  '.cts': ['typescript', 'typescript'],
  '.tsx': ['typescript', 'typescriptreact'],
  '.js': ['typescript', 'javascript'],
  '.mjs': ['typescript', 'javascript'],
  '.cjs': ['typescript', 'javascript'],
  '.jsx': ['typescript', 'javascriptreact'],
  '.rs': ['rust', 'rust'],
  '.py': ['python', 'python'],
  '.pyi': ['python', 'python'],
};

/** The files that make a directory a project's root, nearest first wins. */
const ROOT_MARKERS: Record<Language, string[]> = {
  typescript: ['tsconfig.json', 'jsconfig.json', 'package.json'],
  rust: ['Cargo.toml'],
  python: ['pyproject.toml', 'setup.py', 'setup.cfg', 'pyrightconfig.json', 'requirements.txt'],
};

/** A directory and every one above it, nearest first. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let current = dir; ; ) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/** The nearest directory holding one of the language's markers; the file's
 *  own directory when none does (a server still checks a lone file). */
export function projectRoot(file: string, language: Language, m: Machine): string {
  const dir = path.dirname(file);
  for (const candidate of ancestors(dir)) {
    if (ROOT_MARKERS[language].some((marker) => m.isFile(path.join(candidate, marker)))) return candidate;
  }
  return dir;
}

/** An executable on `PATH`. On Windows that means a PATHEXT extension —
 *  npm's extensionless shim there is a shell script Windows cannot run. */
export function findOnPath(name: string, m: Machine): ServerCommand | undefined {
  // Windows spells it `Path` as often as `PATH`; a copied environment no
  // longer looks it up without case.
  const pathKey = Object.keys(m.env).find((key) => key.toLowerCase() === 'path');
  const pathValue = (pathKey ? m.env[pathKey] : undefined) ?? '';
  const windows = m.platform === 'win32';
  const extensions = windows ? (m.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of pathValue.split(windows ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of extensions) {
      const file = path.join(dir, name + ext.toLowerCase());
      if (m.isFile(file)) return { name, command: file, args: [], ...(/\.(cmd|bat)$/i.test(file) ? { shell: true } : {}) };
    }
  }
  return undefined;
}

/** The directory of a Node package as Node would find it from `dir`. */
function nodePackage(dir: string, name: string, m: Machine): string | undefined {
  for (const candidate of ancestors(dir)) {
    const pkg = path.join(candidate, 'node_modules', name);
    if (m.isFile(path.join(pkg, 'package.json'))) return pkg;
  }
  return undefined;
}

/** A Node package's executable, run by Pi's own Node: no shim, so no shell
 *  on Windows either. */
function nodeBin(pkg: string, bin: string, m: Machine): string | undefined {
  try {
    const manifest = JSON.parse(m.readText(path.join(pkg, 'package.json')) ?? 'null') as { bin?: unknown } | null;
    const field = manifest?.bin;
    const relative = typeof field === 'string' ? field : typeof field === 'object' && field !== null ? (field as Record<string, unknown>)[bin] : undefined;
    if (typeof relative !== 'string') return undefined;
    const script = path.join(pkg, relative);
    return m.isFile(script) ? script : undefined;
  } catch {
    return undefined;
  }
}

function nodeServer(dir: string, pkgName: string, bin: string, args: string[], m: Machine): ServerCommand | undefined {
  const pkg = nodePackage(dir, pkgName, m);
  const script = pkg ? nodeBin(pkg, bin, m) : undefined;
  return script ? { name: bin, command: m.execPath, args: [script, ...args] } : undefined;
}

function withArgs(found: ServerCommand | undefined, args: string[]): ServerCommand | undefined {
  return found ? { ...found, args } : undefined;
}

/**
 * TypeScript and JavaScript. The project's TypeScript decides: up to 6.x it
 * ships `tsserver.js`, which typescript-language-server drives (and refuses
 * a TypeScript without it); 7.x is a native compiler that is its own server
 * (`tsc --lsp --stdio`) and has no tsserver at all. With no TypeScript in the
 * project, a typescript-language-server on PATH may still find one of its
 * own.
 */
function typescriptServer(root: string, m: Machine): ServerCommand | undefined {
  const tls = (): ServerCommand | undefined =>
    nodeServer(root, 'typescript-language-server', 'typescript-language-server', ['--stdio'], m) ??
    withArgs(findOnPath('typescript-language-server', m), ['--stdio']);
  const typescript = nodePackage(root, 'typescript', m);
  if (!typescript) return tls();
  if (m.isFile(path.join(typescript, 'lib', 'tsserver.js'))) return tls();
  const tsc = nodeBin(typescript, 'tsc', m);
  return tsc ? { name: 'tsc --lsp', command: m.execPath, args: [tsc, '--lsp', '--stdio'] } : undefined;
}

/** Pyright's two builds, the project's virtualenv first, then an npm install
 *  in the project, then PATH. */
function pythonServer(root: string, m: Machine): ServerCommand | undefined {
  const names = ['basedpyright-langserver', 'pyright-langserver'];
  const windows = m.platform === 'win32';
  for (const venv of ['.venv', 'venv']) {
    for (const name of names) {
      const file = path.join(root, venv, windows ? 'Scripts' : 'bin', windows ? `${name}.exe` : name);
      if (m.isFile(file)) return { name, command: file, args: ['--stdio'] };
    }
  }
  return (
    nodeServer(root, 'basedpyright', 'basedpyright-langserver', ['--stdio'], m) ??
    nodeServer(root, 'pyright', 'pyright-langserver', ['--stdio'], m) ??
    withArgs(findOnPath(names[0]!, m), ['--stdio']) ??
    withArgs(findOnPath(names[1]!, m), ['--stdio'])
  );
}

/** The server that checks `file`, or `undefined` when its language has none
 *  on this machine (or none at all). */
export function serverFor(file: string, m: Machine): ServerChoice | undefined {
  const known = LANGUAGES[path.extname(file).toLowerCase()];
  if (!known) return undefined;
  const [language, languageId] = known;
  const root = projectRoot(file, language, m);
  const server =
    language === 'typescript' ? typescriptServer(root, m) : language === 'python' ? pythonServer(root, m) : findOnPath('rust-analyzer', m);
  return server ? { language, languageId, root, server } : undefined;
}
