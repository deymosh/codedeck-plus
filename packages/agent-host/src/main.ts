/**
 * The agent host process: the bridge spawns `node main.js`, writes driver
 * protocol frames to its stdin and reads them from its stdout, one per line.
 * Everything else — logs from the host, the drivers or the SDKs — goes to
 * stderr, which the bridge copies into its own log.
 *
 * Configuration is the environment the bridge passes down:
 *   CODEDECK_AGENT_HOST_DRIVERS   comma-separated drivers to load
 *                                 (default `claude-code,opencode`; `fake` for tests)
 *   CODEDECK_CLAUDE_PATH          the `claude` executable
 *   CODEDECK_TEST_MODE=1          Claude Code sessions answer canned /test-* commands
 *   CODEDECK_OPENCODE_SERVER_URL  an OpenCode server to use
 *   CODEDECK_OPENCODE_AUTO_START=1, CODEDECK_OPENCODE_PATH, CODEDECK_OPENCODE_PORT
 *                                 spawn and manage an OpenCode server instead
 *   CODEDECK_AGENT_CACHE          where agent binaries installed on demand live
 *                                 (the bridge passes `<home>/agents`)
 *   CODEDECK_NPM_REGISTRY         an npm mirror to install them from
 */
import * as readline from 'node:readline';
import pkg from '../package.json';
import { agentCacheDir, installBinary, registryUrl } from './agentInstall';
import type { Driver } from './driver';
import { ClaudeDriver } from './drivers/claude/driver';
import { RealSdkFacade, resolveClaudeExecutable } from './drivers/claude/facade';
import { bundledClaudeExecutable, claudeBinary } from './drivers/claude/install';
import { TestModeSdkFacade } from './drivers/claude/testModeFacade';
import { FakeDriver } from './drivers/fake';
import { OpenCodeDriver } from './drivers/opencode/driver';
import { openCodeBinary } from './drivers/opencode/install';
import { AgentHost, type HostIo } from './host';
import { httpPost } from './net';

// stdout carries protocol frames only; a stray console.log from any library
// would corrupt the stream, so every console method writes to stderr.
for (const method of ['log', 'info', 'debug', 'warn'] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

process.on('uncaughtException', (err) => log(`[agent-host] uncaught exception: ${err instanceof Error ? err.stack : String(err)}`));
process.on('unhandledRejection', (err) => log(`[agent-host] unhandled rejection: ${err instanceof Error ? err.stack : String(err)}`));

async function loadDrivers(env: NodeJS.ProcessEnv): Promise<Driver[]> {
  const names = (env.CODEDECK_AGENT_HOST_DRIVERS ?? 'claude-code,opencode')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  const drivers: Driver[] = [];
  for (const name of names) {
    switch (name) {
      case 'claude-code': {
        const testMode = env.CODEDECK_TEST_MODE === '1';
        const claudePath = testMode ? null : (resolveClaudeExecutable(env.CODEDECK_CLAUDE_PATH) ?? bundledClaudeExecutable());
        drivers.push(
          new ClaudeDriver({
            facade: testMode ? new TestModeSdkFacade() : new RealSdkFacade(),
            ...(claudePath ? { claudePath } : {}),
            // Nothing on the machine: the driver installs it in the
            // background, so the agent is listed right away and the first
            // session waits for it.
            ...(!testMode && !claudePath
              ? { installClaude: () => installBinary(claudeBinary(), { cacheDir: agentCacheDir(env), registry: registryUrl(env), log }) }
              : {}),
            httpPost,
          }),
        );
        break;
      }
      case 'opencode': {
        const port = env.CODEDECK_OPENCODE_PORT ? Number(env.CODEDECK_OPENCODE_PORT) : undefined;
        drivers.push(
          await OpenCodeDriver.create({
            ...(env.CODEDECK_OPENCODE_SERVER_URL ? { serverUrl: env.CODEDECK_OPENCODE_SERVER_URL } : {}),
            autoStart: env.CODEDECK_OPENCODE_AUTO_START === '1' || env.CODEDECK_OPENCODE_AUTO_START === 'true',
            ...(env.CODEDECK_OPENCODE_PATH ? { binaryPath: env.CODEDECK_OPENCODE_PATH } : {}),
            installOpenCode: () => installBinary(openCodeBinary(), { cacheDir: agentCacheDir(env), registry: registryUrl(env), log }),
            ...(port !== undefined && Number.isInteger(port) ? { port } : {}),
            log,
          }),
        );
        break;
      }
      case 'fake':
        drivers.push(new FakeDriver());
        break;
      default:
        log(`[agent-host] unknown driver '${name}' — skipped`);
    }
  }
  return drivers;
}

async function main(): Promise<void> {
  const io: HostIo = {
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    log,
  };
  const host = new AgentHost(await loadDrivers(process.env), io, pkg.version);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Lines are handled concurrently: a slow request (a model list, a mode
  // switch) must not hold up the replies that unblock a waiting agent.
  lines.on('line', (line) => void host.handleLine(line));
  lines.on('close', () => {
    // stdin closed: the bridge is gone or restarting us. Stop every agent.
    void host.shutdown().finally(() => process.exit(0));
  });
}

void main();
