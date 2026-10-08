/**
 * Claude Code: the Agent SDK around the `claude` binary — the one on the
 * machine (CODEDECK_CLAUDE_PATH, PATH, or the SDK's own platform package),
 * else the pinned platform package installed on demand.
 * CODEDECK_TEST_MODE=1 swaps the SDK for canned `/test-*` sessions.
 */
import { installBinary } from '../../install/agentInstall';
import type { DriverEnv, DriverModule } from '../../sdk/module';
import { httpPost, providerHttp } from '../../sdk/net';
import { ClaudeDriver } from './driver';
import { RealSdkFacade, resolveClaudeExecutable } from './facade';
import { bundledClaudeExecutable, claudeBinary } from './install';
import { TestModeSdkFacade } from './testModeFacade';

const testMode = (ctx: DriverEnv): boolean => ctx.env.CODEDECK_TEST_MODE === '1';

/** The `claude` this machine has, if any. */
function existing(ctx: DriverEnv): string | null {
  return resolveClaudeExecutable(undefined, ctx.lookupEnv) ?? bundledClaudeExecutable();
}

function install(ctx: DriverEnv): Promise<string> {
  return installBinary(claudeBinary(), { cacheDir: ctx.cacheDir, registry: ctx.registry, log: ctx.log });
}

export const claudeModule: DriverModule = {
  id: 'claude-code',
  label: 'Claude Code',
  create(ctx) {
    const test = testMode(ctx);
    const claudePath = test ? null : existing(ctx);
    return new ClaudeDriver({
      facade: test ? new TestModeSdkFacade() : new RealSdkFacade(),
      ...(claudePath ? { claudePath } : {}),
      // Nothing on the machine: the driver installs it in the background,
      // so the agent is listed right away and the first session waits for it.
      ...(!test && !claudePath ? { installClaude: () => install(ctx) } : {}),
      httpPost,
      providerHttp,
      discoverModels: !test,
      managePlugins: !test,
      manageMcp: !test,
    });
  },
  runtime: {
    find: (ctx) => (testMode(ctx) ? 'test mode' : existing(ctx)),
    install,
  },
};
