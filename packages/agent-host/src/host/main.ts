/**
 * The agent host process: the bridge spawns `node main.js`, writes driver
 * protocol frames to its stdin and reads them from its stdout, one per line.
 * Everything else — logs from the host, the drivers or the SDKs — goes to
 * stderr, which the bridge copies into its own log.
 *
 * `node main.js list | install <id>… | remove <id>…` runs one command on the
 * agents instead of serving (commands.ts).
 *
 * Configuration is the environment the bridge passes down:
 *   CODEDECK_AGENT_HOST_DRIVERS   comma-separated drivers to load
 *                                 (default `claude-code,opencode,deepseek-harness`;
 *                                 `fake` for tests)
 *   CODEDECK_CLAUDE_PATH          the `claude` executable
 *   CODEDECK_TEST_MODE=1          Claude Code sessions answer canned /test-* commands
 *   CODEDECK_OPENCODE_SERVER_URL  an OpenCode server to use; unset = the
 *                                 driver starts and manages its own, with
 *   CODEDECK_OPENCODE_PATH, CODEDECK_OPENCODE_PORT
 *   CODEDECK_DEEPSEEK_PATH        the DeepSeek Harness CLI to run (its
 *                                 `lib/bin.js`, or an executable of your own);
 *                                 unset = the runtime this build pins
 *   CODEDECK_DEEPSEEK_HOME        `$DSH_HOME`, the harness's state root
 *                                 (the bridge passes `<home>/dsh`)
 *   CODEDECK_AGENT_CACHE          where the agents CodeDeck installs live (the
 *                                 bridge passes `<home>/agents`; `bin/` in it
 *                                 links each binary under a stable name)
 *   CODEDECK_NPM_REGISTRY         an npm mirror to install them from
 */
import * as readline from 'node:readline';
import pkg from '../../package.json';
import { agentCacheDir, registryUrl, withoutAgentBin } from '../install/agentInstall';
import { Agents } from './agents';
import { runCommand } from './commands';
import { AgentHost, type HostIo } from './host';
import { selectModules } from './modules';

// stdout carries protocol frames only; a stray console.log from any library
// would corrupt the stream, so every console method writes to stderr.
for (const method of ['log', 'info', 'debug', 'warn'] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}

const log = (message: string): void => {
  process.stderr.write(`${message}
`);
};

process.on('uncaughtException', (err) => log(`[agent-host] uncaught exception: ${err instanceof Error ? err.stack : String(err)}`));
process.on('unhandledRejection', (err) => log(`[agent-host] unhandled rejection: ${err instanceof Error ? err.stack : String(err)}`));

/** What every module is handed, from the host's environment. */
function driverEnv(env: NodeJS.ProcessEnv) {
  const cacheDir = agentCacheDir(env);
  return { env, lookupEnv: withoutAgentBin(env, cacheDir), cacheDir, registry: registryUrl(env), log };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    // One command, then exit without ever reading stdin.
    process.exitCode = await runCommand(args, driverEnv(process.env), (line) => process.stdout.write(`${line}\n`));
    return;
  }
  const io: HostIo = {
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    log,
  };
  const agents = await Agents.load(selectModules(process.env, log), driverEnv(process.env));
  const host = new AgentHost(agents, io, pkg.version);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Lines are handled concurrently: a slow request (a model list, a mode
  // switch) must not hold up the replies that unblock a waiting agent.
  lines.on('line', (line) => void host.handleLine(line));
  lines.on('close', () => {
    // stdin closed: the bridge is gone or restarting us. Stop every agent.
    void host.shutdown().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  log(`[agent-host] could not start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
