/**
 * OpenCode: its server SDK, against a running server
 * (CODEDECK_OPENCODE_SERVER_URL) or, without one, a server the driver
 * starts and manages (CODEDECK_OPENCODE_PATH, CODEDECK_OPENCODE_PORT) —
 * from the `opencode` on the machine, else the pinned platform package.
 *
 * It is the agent a fresh bridge installs by itself: one coding agent that
 * works with any provider the user brings.
 */
import { installBinary, installedBinary, removeBinary } from '../../install/agentInstall';
import type { DriverEnv, DriverModule } from '../../sdk/module';
import { providerHttp } from '../../sdk/net';
import { OpenCodeDriver } from './driver';
import { openCodeBinary } from './install';
import { resolveOpenCodePath } from './server';

function install(ctx: DriverEnv): Promise<string> {
  return installBinary(openCodeBinary(), { cacheDir: ctx.cacheDir, registry: ctx.registry, log: ctx.log });
}

const serverUrl = (ctx: DriverEnv): string | undefined => ctx.env.CODEDECK_OPENCODE_SERVER_URL?.trim() || undefined;

export const openCodeModule: DriverModule = {
  id: 'opencode',
  label: 'OpenCode',
  installByDefault: true,
  create(ctx) {
    const { env } = ctx;
    const url = serverUrl(ctx);
    const port = env.CODEDECK_OPENCODE_PORT ? Number(env.CODEDECK_OPENCODE_PORT) : undefined;
    return OpenCodeDriver.create({
      ...(url ? { serverUrl: url } : {}),
      autoStart: true,
      ...(env.CODEDECK_OPENCODE_PATH ? { binaryPath: env.CODEDECK_OPENCODE_PATH } : {}),
      installOpenCode: () => install(ctx),
      lookupEnv: ctx.lookupEnv,
      ...(port !== undefined && Number.isInteger(port) ? { port } : {}),
      log: ctx.log,
      providerHttp,
    });
  },
  runtime: {
    find: (ctx) => {
      const url = serverUrl(ctx);
      return url ? `the OpenCode server at ${url}` : resolveOpenCodePath(undefined, ctx.lookupEnv);
    },
    installed: (ctx) => installedBinary(openCodeBinary(), ctx),
    install,
    remove: (ctx) => removeBinary(openCodeBinary(), ctx.cacheDir),
  },
};
