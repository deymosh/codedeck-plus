/**
 * A driver module: an agent's whole registration with the host — its id, how
 * its driver is built from the environment, and where its runtime comes
 * from. The host keeps a list of modules and knows no agent beyond it:
 * loading, installing and removing agents (on request, or from the command
 * line) all walk that list, so adding an agent is one folder under
 * `drivers/` exporting one module, plus one line in the list.
 */
import type { Driver } from './driver';

/** What the host hands a module to build its driver or install its agent. */
export interface DriverEnv {
  /** The host's environment, with every loaded module's own variables
   *  taken out of it (see `claimEnv`). */
  env: NodeJS.ProcessEnv;
  /** `env` for finding executables: without the links in the agent cache's
   *  `bin/`, so an installed agent is found through its pinned install,
   *  never through a link on PATH. */
  lookupEnv: NodeJS.ProcessEnv;
  /** The environment this module's `claimEnv` answered, else `env`. */
  ownEnv: NodeJS.ProcessEnv;
  /** Where agents installed on demand live. */
  cacheDir: string;
  /** The npm registry they are installed from. */
  registry: string;
  /** A line for the bridge log (stderr). Never pass secrets. */
  log(message: string): void;
}

/** Where an agent's runtime comes from. */
export interface AgentRuntime {
  /** The runtime this machine has of its own — its path, or why none is
   *  needed (a server it connects to, test mode) — or null. CodeDeck never
   *  removes it. */
  find(ctx: DriverEnv): string | null;
  /** The runtime CodeDeck installed, at the version this build pins, when
   *  it is complete; else null. Never downloads. */
  installed(ctx: DriverEnv): string | null;
  /** Install the runtime at the version this build pins; resolves to where
   *  it is. Installing what is already installed is a lookup. */
  install(ctx: DriverEnv): Promise<string>;
  /** Remove what `install` put in the cache. Throws when it cannot. */
  remove(ctx: DriverEnv): void;
}

export interface DriverModule {
  /** The agent's catalog id, and its name in `CODEDECK_AGENT_HOST_DRIVERS`. */
  readonly id: string;
  /** How logs name it. */
  readonly label: string;
  /** Loaded only when named in `CODEDECK_AGENT_HOST_DRIVERS` (test drivers). */
  readonly explicitOnly?: boolean;
  /**
   * Take the variables that are this agent's alone out of the host's
   * environment, which every agent process inherits, and answer the
   * environment this driver runs with (`ownEnv`). Called for every loaded
   * module before any driver is built.
   */
  claimEnv?(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Build the driver. Called only once the runtime is on the machine
   *  (`find`, or `installed` after an install), so a driver that resolves
   *  its pinned runtime finds it without a download. */
  create(ctx: DriverEnv): Driver | Promise<Driver>;
  /** Absent: the agent needs nothing installed. */
  readonly runtime?: AgentRuntime;
  /** Installed on a machine that has none of it, unless the user removed it
   *  there: the agent a fresh bridge is useful with. */
  readonly installByDefault?: boolean;
}
