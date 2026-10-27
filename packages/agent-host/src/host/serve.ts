/**
 * What the host process is made of: its two output streams and the host
 * built from the environment the bridge passes down. Kept out of main.ts so
 * both can be exercised without spawning the process.
 *
 * stdout carries protocol frames only, one per line. Every console method a
 * driver or an SDK calls writes to stderr instead, which the bridge copies
 * into its log — a stray console.log on stdout would corrupt the stream the
 * bridge parses.
 */
import { format } from 'node:util';
import pkg from '../../package.json';
import { agentCacheDir, registryUrl, withoutAgentBin } from '../install/agentInstall';
import { Agents, type BaseEnv } from './agents';
import { AgentHost, type HostIo } from './host';
import { selectModules } from './modules';

/** Where the host writes: protocol frames, and diagnostics. */
export interface HostStreams {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

/**
 * The host's output streams, with every console method sent to stderr. A
 * driver that logs the way libraries do must not be able to write a line
 * the bridge would try to parse as a frame.
 */
export function wire({ out, err }: HostStreams = { out: process.stdout, err: process.stderr }): HostIo {
  for (const method of ['log', 'info', 'debug', 'warn'] as const) {
    console[method] = (...args: unknown[]) => {
      err.write(`${format(...args)}\n`);
    };
  }
  return {
    write: (line) => {
      out.write(`${line}\n`);
    },
    log: (message) => {
      err.write(`${message}\n`);
    },
  };
}

/** What every module is handed, from the host's environment. */
export function driverEnv(env: NodeJS.ProcessEnv, log: (message: string) => void): BaseEnv {
  const cacheDir = agentCacheDir(env);
  return { env, lookupEnv: withoutAgentBin(env, cacheDir), cacheDir, registry: registryUrl(env), log };
}

/** Load the drivers the environment selects, and build the host over them. */
export async function startHost(io: HostIo, env: NodeJS.ProcessEnv = process.env): Promise<AgentHost> {
  const agents = await Agents.load(selectModules(env, io.log), driverEnv(env, io.log));
  return new AgentHost(agents, io, pkg.version);
}
