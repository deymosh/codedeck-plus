/**
 * A driver module: an agent's whole registration with the host — its id, how
 * its driver is built from the environment, and where its runtime comes
 * from. The host keeps a list of modules and knows no agent beyond it:
 * loading, the warm-up mode and installing on demand all walk that list, so
 * adding an agent is one folder under `drivers/` exporting one module, plus
 * one line in the list.
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
  /** The runtime this machine already has — its path, or why none is needed
   *  — or null when it has to be installed. */
  find(ctx: DriverEnv): string | null;
  /** Install the runtime at the version this build pins; resolves to where
   *  it is. Installing what is already installed is a lookup. */
  install(ctx: DriverEnv): Promise<string>;
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
  create(ctx: DriverEnv): Driver | Promise<Driver>;
  /** Absent: the agent needs nothing installed. */
  readonly runtime?: AgentRuntime;
}
