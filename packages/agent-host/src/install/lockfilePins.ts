/**
 * The exact version and sha512 of every package pnpm-lock.yaml pins for the
 * agents the host runs — the packages a driver may download on demand
 * instead of the release archives shipping them (see agentInstall.ts).
 *
 * Two shapes are generated:
 *
 *  - platform packages: the lockfile entries that declare `os` or `cpu`
 *    (a CLI's per-platform binary). Collected wholesale, whatever the
 *    platform — the driver picks its own entry at run time.
 *  - a package tree: the full dependency closure of one root package (the
 *    DeepSeek Harness runtime, a pure-JS CLI whose ~90 packages must all be
 *    present for it to boot). Each entry names the node_modules/ spot it
 *    occupies, so a package the closure needs at two versions still
 *    resolves the way pnpm resolved it (one variant at the root, the other
 *    nested under its consumer). Platform-gated entries (a wasm fallback, a
 *    darwin-only binary) stay in the pins with their gates; the installer
 *    skips the ones that do not match the machine it runs on.
 *
 * The results are checked in as src/generated/*.ts so the built host carries
 * the pins without the lockfile; a test regenerates them and fails on drift.
 */
import { load } from 'js-yaml';

export interface PackagePin {
  version: string;
  integrity: string;
}

/** One package of an installable dependency tree, at the spot it must be
 *  laid down for Node to resolve it the way pnpm resolved the lockfile. */
export interface TreePackageEntry {
  name: string;
  version: string;
  integrity: string;
  /** Install path under the tree's node_modules/, `/`-separated. A package
   *  the closure needs at two versions lives once at the root (the variant
   *  required paths reach) and nested under each parent that needs the
   *  other — Node then resolves each consumer's version, as pnpm did. */
  dest: string;
  /** Reached only through optionalDependencies: skipped when its platform
   *  gates do not match, and not fatal when it cannot be fetched. */
  optional?: boolean;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

interface LockfileEntry {
  version?: string;
  resolution?: { integrity?: unknown };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
}

interface Lockfile {
  importers?: Record<string, { dependencies?: Record<string, { version?: unknown }>; devDependencies?: Record<string, { version?: unknown }> }>;
  packages?: Record<string, LockfileEntry>;
  snapshots?: Record<string, LockfileEntry>;
}

/** Parse pnpm-lock.yaml (format 9). Throws on anything but a document. */
function parseLockfile(lockfile: string): Lockfile {
  const doc = load(lockfile);
  if (!doc || typeof doc !== 'object') throw new Error('pnpm-lock.yaml is not a YAML document');
  return doc as Lockfile;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items = value.filter((v): v is string => typeof v === 'string');
  return items.length === value.length ? items : undefined;
}

/** `name@version`, possibly with pnpm's trailing `(peer@…)…` resolution
 *  suffix — never part of the identity we resolve by. */
function stripPeerSuffix(id: string): string {
  const cut = id.indexOf('(');
  return cut < 0 ? id : id.slice(0, cut);
}

/** A lockfile key `name@spec` split at the last `@` (a scoped name carries
 *  its own; the spec never does). */
function splitKey(key: string): { name: string; spec: string } {
  const at = key.lastIndexOf('@');
  if (at <= 0) throw new Error(`pnpm-lock.yaml entry '${key}' is not name@spec`);
  return { name: key.slice(0, at), spec: key.slice(at + 1) };
}

/** Read the pins out of a pnpm-lock.yaml (lockfile format 9): exactly the
 *  entries that declare `os` or `cpu`. Two versions of one name is an error
 *  — a driver could not tell them apart. */
export function platformPackages(lockfile: string): Record<string, PackagePin> {
  const packages = parseLockfile(lockfile).packages ?? {};
  const pins: Record<string, PackagePin> = {};
  for (const [key, entry] of Object.entries(packages)) {
    if (!entry.os && !entry.cpu) continue;
    const { name, spec } = splitKey(stripPeerSuffix(key));
    const integrity = typeof entry.resolution?.integrity === 'string' ? entry.resolution.integrity : undefined;
    if (!integrity) continue;
    const version = entry.version ?? spec;
    const previous = pins[name];
    if (previous && previous.version !== version) {
      throw new Error(`pnpm-lock.yaml holds two versions of ${name} (${previous.version}, ${version})`);
    }
    pins[name] = { version, integrity };
  }
  return pins;
}

/**
 * The dependency closure of `root` as pinned for one importer, every entry
 * at its exact resolved version and sha512 with the node_modules/ spot it
 * must occupy. Walks the `snapshots:` graph (where format 9 records resolved
 * dependency versions, with peer-suffix ids) and falls back to a package's
 * own entry when it has no snapshot.
 *
 * A name the closure needs at two versions is laid out the way npm itself
 * does it: one variant at the root (preferring a variant required paths
 * reach, so it is never skippable while something needs it), the others
 * nested under each parent that requires them. Fails loudly on anything it
 * cannot place: a snapshot id ambiguous across peer contexts, a dependency
 * with no pinned entry, or a pathological graph.
 */
export function packageTree(lockfile: string, importer: string, root: string): TreePackageEntry[] {
  const doc = parseLockfile(lockfile);
  const packages = doc.packages ?? {};
  const snapshots = doc.snapshots ?? {};

  const rootDep = doc.importers?.[importer]?.devDependencies?.[root] ?? doc.importers?.[importer]?.dependencies?.[root];
  const rootVersion = typeof rootDep?.version === 'string' ? stripPeerSuffix(rootDep.version) : undefined;
  if (!rootVersion) throw new Error(`pnpm-lock.yaml does not pin ${root} for the ${importer} importer`);

  /** The lockfile's view of one resolved package: its metadata entry plus
   *  the dependency graph format 9 records in `snapshots:` once any peer is
   *  involved (a package's own entry otherwise). */
  const resolve = (name: string, spec: string): LockfileEntry => {
    const key = `${name}@${spec}`;
    const entry = packages[key];
    if (!entry || typeof entry.resolution?.integrity !== 'string') {
      throw new Error(`pnpm-lock.yaml has no pinned entry for ${key}`);
    }
    // Two snapshots of one base key mean two peer contexts resolved it
    // differently; a flat tree serves one, so refuse to guess.
    const variants = Object.keys(snapshots).filter((k) => k === key || k.startsWith(`${key}(`));
    if (variants.length > 1) {
      throw new Error(`pnpm-lock.yaml holds ${variants.length} peer resolutions of ${key}; the tree installer serves one`);
    }
    return variants.length === 1 ? snapshots[variants[0]!]! : entry;
  };

  /** Walk the graph from the root, recording for every node key
   *  (`name@spec`) the parent nodes an edge into it comes from. With
   *  optional edges followed: every consumer (that is where a nested
   *  variant lives). Without them: the required-edge parents, whose absence
   *  for a reached node marks the package optional. */
  const walk = (withOptional: boolean): Map<string, Set<string>> => {
    const parents = new Map<string, Set<string>>();
    const visited = new Set<string>();
    const stack: Array<[string, string]> = [[root, rootVersion]];
    while (stack.length > 0) {
      const [name, spec] = stack.pop()!;
      const key = `${name}@${spec}`;
      if (!parents.has(key)) parents.set(key, new Set());
      if (visited.has(key)) continue;
      visited.add(key);
      const graph = resolve(name, spec);
      const edges = withOptional ? { ...graph.dependencies, ...graph.optionalDependencies } : graph.dependencies;
      for (const [dep, id] of Object.entries(edges ?? {})) {
        const depSpec = stripPeerSuffix(id);
        const depKey = `${dep}@${depSpec}`;
        let set = parents.get(depKey);
        if (!set) {
          set = new Set();
          parents.set(depKey, set);
        }
        set.add(key);
        stack.push([dep, depSpec]);
      }
    }
    return parents;
  };

  const reachable = walk(true);
  const requiredParents = walk(false);

  /** The one spec of each name that sits at the root of node_modules: a
   *  variant required paths reach when there is one (never skippable while
   *  something needs it), else the first sorted — deterministic either way. */
  const flatSpec = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const key of reachable.keys()) {
    const at = key.lastIndexOf('@');
    const name = key.slice(0, at);
    byName.set(name, [...(byName.get(name) ?? []), key.slice(at + 1)]);
  }
  for (const [name, specs] of byName) {
    const sorted = [...specs].sort();
    flatSpec.set(name, sorted.find((spec) => requiredParents.has(`${name}@${spec}`)) ?? sorted[0]!);
  }

  /** Every install path a node occupies: the root slot for the flat variant,
   *  else nested under each parent — itself at every path the parent takes. */
  const locations = (key: string, seen = new Set<string>()): string[] => {
    if (seen.has(key)) throw new Error(`pnpm-lock.yaml has a dependency cycle through ${key}`);
    seen.add(key);
    const at = key.lastIndexOf('@');
    const name = key.slice(0, at);
    if (flatSpec.get(name) === key.slice(at + 1)) return [`node_modules/${name}`];
    const spots: string[] = [];
    for (const parent of reachable.get(key) ?? []) {
      for (const spot of locations(parent, new Set(seen))) spots.push(`${spot}/node_modules/${name}`);
    }
    return [...new Set(spots)];
  };

  const entries: TreePackageEntry[] = [];
  for (const key of reachable.keys()) {
    const at = key.lastIndexOf('@');
    const name = key.slice(0, at);
    const spec = key.slice(at + 1);
    const meta = packages[key]!;
    const os = stringArray(meta.os);
    const cpu = stringArray(meta.cpu);
    const libc = stringArray(meta.libc);
    for (const dest of locations(key)) {
      entries.push({
        name,
        version: meta.version ?? spec,
        integrity: meta.resolution!.integrity as string,
        dest,
        ...(key !== `${root}@${rootVersion}` && !requiredParents.has(key) ? { optional: true } : {}),
        ...(os ? { os } : {}),
        ...(cpu ? { cpu } : {}),
        ...(libc ? { libc } : {}),
      });
    }
  }
  if (entries.length > 2000) {
    throw new Error(`the closure of ${root} places ${entries.length} packages; refusing a tree this pathological`);
  }
  return entries.sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0));
}

/** The generated module's source for `pins`. */
export function renderPlatformPackages(pins: Record<string, PackagePin>): string {
  const rows = Object.keys(pins)
    .sort()
    .map((name) => {
      const pin = pins[name]!;
      return `  ${JSON.stringify(name)}: { version: ${JSON.stringify(pin.version)}, integrity: ${JSON.stringify(pin.integrity)} },`;
    });
  return [
    '// Generated from pnpm-lock.yaml by src/install/lockfilePins.ts — do not edit.',
    "// Regenerate with this package's `gen:platform-packages` script.",
    "import type { PackagePin } from '../install/lockfilePins';",
    '',
    'export const PLATFORM_PACKAGES: Readonly<Record<string, PackagePin>> = {',
    ...rows,
    '};',
    '',
  ].join('\n');
}

/** The generated module's source for the DeepSeek Harness runtime tree. */
export function renderDshPackages(entries: TreePackageEntry[]): string {
  const rows = entries.map((entry) => {
    const fields = [
      `name: ${JSON.stringify(entry.name)}`,
      `version: ${JSON.stringify(entry.version)}`,
      `integrity: ${JSON.stringify(entry.integrity)}`,
      `dest: ${JSON.stringify(entry.dest)}`,
      ...(entry.optional ? ['optional: true'] : []),
      ...(entry.os ? [`os: ${JSON.stringify(entry.os)}`] : []),
      ...(entry.cpu ? [`cpu: ${JSON.stringify(entry.cpu)}`] : []),
      ...(entry.libc ? [`libc: ${JSON.stringify(entry.libc)}`] : []),
    ];
    return `  { ${fields.join(', ')} },`;
  });
  return [
    '// Generated from pnpm-lock.yaml by src/install/lockfilePins.ts — do not edit.',
    "// Regenerate with this package's `gen:platform-packages` script.",
    "import type { TreePackageEntry } from '../install/lockfilePins';",
    '',
    'export const DSH_PACKAGES: readonly TreePackageEntry[] = [',
    ...rows,
    '];',
    '',
  ].join('\n');
}
