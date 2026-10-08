/**
 * The agents this host knows, and where each stands on the machine.
 *
 * An agent whose runtime the machine has — of its own (`find`: on PATH,
 * bundled, configured) or installed by CodeDeck at the pinned version
 * (`installed`) — is ready: its driver is built and it runs sessions. Any
 * other is listed by name only, until someone installs it; nothing is
 * downloaded for an agent nobody chose, except the one module marked
 * `installByDefault`, so a fresh bridge has an agent to run.
 *
 * Removing an agent ends its sessions, stops its driver and deletes what
 * CodeDeck installed of it; one the machine has of its own is never
 * touched. A removal is remembered in the cache (`.removed-<id>`), so the
 * default agent is not installed again behind the user's back; installing
 * it again forgets that.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Driver } from '../sdk/driver';
import type { DriverEnv, DriverModule } from '../sdk/module';
import type { AgentInfo, AgentInstall } from '../sdk/types';

/** What every module is handed, but its own environment. */
export type BaseEnv = Omit<DriverEnv, 'ownEnv'>;

interface Entry {
  module: DriverModule;
  ctx: DriverEnv;
  driver: Driver | null;
  /** The driver runs from what CodeDeck installed, so it can be removed. */
  removable: boolean;
  installing: Promise<void> | null;
  /** Why the last install failed, until the next one starts. */
  failure: string | null;
}

/** Everything off: what a driver supports is known once it is built. */
const NOTHING_SUPPORTED: AgentInfo['supports'] = {
  models: false,
  usage: false,
  providers: false,
  providerModels: false,
  gsd: false,
  interrupt: false,
  commands: false,
  plugins: false,
  mcp: false,
  tasks: false,
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The file that says the user removed agent `id` from this machine. */
function removedMarker(cacheDir: string, id: string): string {
  return path.join(cacheDir, `.removed-${id}`);
}

/** Whether the user removed agent `id` (and did not install it since). */
export function wasRemoved(cacheDir: string, id: string): boolean {
  return fs.existsSync(removedMarker(cacheDir, id));
}

/** Remember that agent `id` was removed, or (`removed` false) forget it.
 *  Best effort: the only cost of a failure is the default agent coming
 *  back, or staying away, on its own. */
export function markRemoved(cacheDir: string, id: string, removed: boolean, log: (message: string) => void): void {
  try {
    if (removed) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(removedMarker(cacheDir, id), '');
    } else {
      fs.rmSync(removedMarker(cacheDir, id), { force: true });
    }
  } catch (err) {
    log(`[agents] could not record whether '${id}' was removed: ${errorText(err)}`);
  }
}

export class Agents {
  /** Told every time an agent's catalog entry changes. */
  onChange: (agent: AgentInfo) => void = () => {};

  private constructor(
    private readonly entries: Map<string, Entry>,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * The modules' agents: a driver for each one the machine has, a name for
   * every other — and the default agent's install begun when it is missing.
   * Every module claims its own variables first, since every agent process
   * inherits the environment left over.
   */
  static async load(modules: readonly DriverModule[], base: BaseEnv): Promise<Agents> {
    const own = modules.map((m) => m.claimEnv?.(base.env) ?? base.env);
    const entries = new Map<string, Entry>();
    for (const [i, module] of modules.entries()) {
      const ctx: DriverEnv = { ...base, ownEnv: own[i]! };
      const entry: Entry = { module, ctx, driver: null, removable: false, installing: null, failure: null };
      const runtime = module.runtime;
      const mine = runtime ? runtime.find(ctx) : 'nothing to install';
      const pinned = !mine && runtime ? runtime.installed(ctx) : null;
      if (mine || pinned) {
        entry.driver = await module.create(ctx);
        entry.removable = !mine;
      }
      entries.set(module.id, entry);
    }
    const agents = new Agents(entries, base.log);
    for (const entry of entries.values()) {
      if (!entry.driver && entry.module.installByDefault && !wasRemoved(base.cacheDir, entry.module.id)) {
        base.log(`[agents] ${entry.module.label} is the default agent and is not on this machine — installing it`);
        agents.begin(entry);
      }
    }
    return agents;
  }

  /** Agents that are all ready, with nothing to install or remove (tests,
   *  and hosts built around drivers directly). */
  static of(drivers: Driver[], log: (message: string) => void = () => {}): Agents {
    const entries = new Map<string, Entry>();
    for (const driver of drivers) {
      const { id, displayName } = driver.info();
      const module: DriverModule = { id, label: displayName, create: () => driver };
      const ctx: DriverEnv = { env: {}, lookupEnv: {}, ownEnv: {}, cacheDir: '', registry: '', log };
      entries.set(id, { module, ctx, driver, removable: false, installing: null, failure: null });
    }
    return new Agents(entries, log);
  }

  /** Every agent's catalog entry, in the modules' order. */
  list(): AgentInfo[] {
    return [...this.entries.values()].map((e) => this.info(e));
  }

  /** The ready drivers. */
  drivers(): Driver[] {
    return [...this.entries.values()].flatMap((e) => (e.driver ? [e.driver] : []));
  }

  /** The driver of a ready agent; throws, saying why, for any other. */
  driver(id: string): Driver {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`no agent '${id}' in this host`);
    if (entry.driver) return entry.driver;
    const { label } = entry.module;
    if (entry.installing) throw new Error(`${label} is still being installed`);
    throw new Error(`${label} is not installed on this machine`);
  }

  /** Begin installing an agent in the background (nothing to do when it is
   *  installed or installing already); `onChange` reports how it goes. */
  install(id: string): void {
    const entry = this.entry(id);
    if (entry.driver || entry.installing) return;
    if (!entry.module.runtime) throw new Error(`${entry.module.label} has nothing to install`);
    markRemoved(entry.ctx.cacheDir, id, false, this.log);
    this.begin(entry);
  }

  /**
   * Remove an agent: `endSessions` ends its sessions once the bridge has
   * been told it is gone, then its driver stops and its files go. A removal
   * of an agent that is not installed (or whose install failed) only keeps
   * the default agent from being installed again.
   */
  async remove(id: string, endSessions: (reason: string) => Promise<void>): Promise<void> {
    const entry = this.entry(id);
    const { module, ctx } = entry;
    if (entry.installing) throw new Error(`${module.label} is still being installed; remove it once that is done`);
    if (entry.driver && !entry.removable) {
      const where = module.runtime?.find(ctx);
      throw new Error(
        where
          ? `${module.label} is on this machine outside CodeDeck (${where}), so CodeDeck cannot remove it`
          : `${module.label} is part of this bridge and cannot be removed`,
      );
    }
    markRemoved(ctx.cacheDir, id, true, this.log);
    const driver = entry.driver;
    entry.driver = null;
    entry.removable = false;
    entry.failure = null;
    this.changed(entry);
    if (!driver) return;
    await endSessions(`${module.label} was removed from this machine.`);
    await driver.shutdown?.().catch(() => {});
    module.runtime!.remove(ctx);
    this.log(`[agents] ${module.label} removed`);
  }

  /** Stop every ready driver. */
  async shutdown(): Promise<void> {
    await Promise.all(this.drivers().map((d) => d.shutdown?.().catch(() => {})));
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`no agent '${id}' in this host`);
    return entry;
  }

  /** Install in the background, telling the bridge how it goes. */
  private begin(entry: Entry): void {
    const { module, ctx } = entry;
    entry.failure = null;
    // Started on the next tick, so it is marked as installing before
    // anything it does (even failing at once) is reported.
    entry.installing = Promise.resolve().then(async () => {
      try {
        await module.runtime!.install(ctx);
        entry.driver = await module.create(ctx);
        entry.removable = !module.runtime!.find(ctx);
        this.log(`[agents] ${module.label} is installed`);
      } catch (err) {
        entry.failure = errorText(err);
        this.log(`[agents] ${module.label} could not be installed: ${entry.failure}`);
      } finally {
        entry.installing = null;
        this.changed(entry);
      }
    });
    this.changed(entry);
  }

  private changed(entry: Entry): void {
    this.onChange(this.info(entry));
  }

  private info(entry: Entry): AgentInfo {
    if (entry.driver) {
      return { ...entry.driver.info(), install: { state: 'ready', ...(entry.removable ? { removable: true } : {}) } };
    }
    const install: AgentInstall = entry.installing
      ? { state: 'installing' }
      : entry.failure
        ? { state: 'failed', reason: entry.failure }
        : { state: 'not_installed' };
    return {
      id: entry.module.id,
      displayName: entry.module.label,
      modes: [],
      efforts: [],
      supports: NOTHING_SUPPORTED,
      credentials: [],
      install,
    };
  }
}
