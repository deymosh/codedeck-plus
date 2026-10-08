/**
 * OpenCode: its server SDK, against a running server
 * (CODEDECK_OPENCODE_SERVER_URL) or one the driver starts and manages
 * (CODEDECK_OPENCODE_AUTO_START=1, with CODEDECK_OPENCODE_PATH and
 * CODEDECK_OPENCODE_PORT) — from the `opencode` on the machine, else the
 * pinned platform package installed on demand.
 */
import { installBinary } from '../../install/agentInstall';
import type { DriverEnv, DriverModule } from '../../sdk/module';
import { providerHttp } from '../../sdk/net';
import { OpenCodeDriver } from './driver';
import { openCodeBinary } from './install';
import { resolveOpenCodePath } from './server';

function install(ctx: DriverEnv): Promise<string> {
  return installBinary(openCodeBinary(), { cacheDir: ctx.cacheDir, registry: ctx.registry, log: ctx.log });
}

export const openCodeModule: DriverModule = {
  id: 'opencode',
  label: 'OpenCode',
  create(ctx) {
    const { env } = ctx;
    const port = env.CODEDECK_OPENCODE_PORT ? Number(env.CODEDECK_OPENCODE_PORT) : undefined;
    return OpenCodeDriver.create({
      ...(env.CODEDECK_OPENCODE_SERVER_URL ? { serverUrl: env.CODEDECK_OPENCODE_SERVER_URL } : {}),
      autoStart: env.CODEDECK_OPENCODE_AUTO_START === '1' || env.CODEDECK_OPENCODE_AUTO_START === 'true',
      ...(env.CODEDECK_OPENCODE_PATH ? { binaryPath: env.CODEDECK_OPENCODE_PATH } : {}),
      installOpenCode: () => install(ctx),
      lookupEnv: ctx.lookupEnv,
      ...(port !== undefined && Number.isInteger(port) ? { port } : {}),
      log: ctx.log,
      providerHttp,
    });
  },
  runtime: {
    find: (ctx) => resolveOpenCodePath(undefined, ctx.lookupEnv),
    install,
  },
};
