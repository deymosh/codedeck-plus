/**
 * The DeepSeek Harness: its CLI over ACP — the operator's own
 * (CODEDECK_DEEPSEEK_PATH), else the pinned package tree installed on
 * demand — with its state under CODEDECK_DEEPSEEK_HOME.
 */
import type { DriverEnv, DriverModule } from '../../sdk/module';
import { isFile } from '../../sdk/executable';
import { httpGet } from '../../sdk/net';
import { DeepSeekDriver } from './driver';
import { takeDeepSeekEnv } from './env';
import { installDshTree } from './install';
import { DeepSeekMcp } from './mcp';
import { DeepSeekRuntime, dshHomeDir, dshProfileDir } from './runtime';

const explicitPath = (ctx: DriverEnv): string | undefined => ctx.env.CODEDECK_DEEPSEEK_PATH?.trim() || undefined;

export const deepSeekModule: DriverModule = {
  id: 'deepseek-harness',
  label: 'DeepSeek Harness',
  // The harness's endpoint and key are its driver's alone.
  claimEnv: takeDeepSeekEnv,
  create(ctx) {
    const home = dshHomeDir(ctx.lookupEnv);
    const dshPath = explicitPath(ctx);
    // The MCP servers live in this profile layer, and a harness process is
    // told the layer's version as it starts: the same manager serves both,
    // so a change after a process started is configuration it has not loaded.
    const mcp = new DeepSeekMcp({ profileDir: dshProfileDir(home), log: ctx.log });
    const driver = DeepSeekDriver.create({
      runtime: new DeepSeekRuntime({
        // An explicit path is the operator's own harness; without one the
        // pinned tree is installed on demand, at the version and sha512
        // pnpm-lock.yaml holds.
        ...(dshPath ? { dshPath } : {}),
        home,
        cacheDir: ctx.cacheDir,
        registry: ctx.registry,
        installDsh: installDshTree,
        configVersion: () => mcp.version,
        log: ctx.log,
      }),
      home,
      mcp,
      baseEnv: ctx.ownEnv,
      httpGet,
      log: ctx.log,
    });
    if (dshPath && !isFile(dshPath)) {
      driver.setUnavailable(`CODEDECK_DEEPSEEK_PATH points at ${dshPath}, which is not a file.`);
    }
    return driver;
  },
  runtime: {
    find: (ctx) => {
      const dshPath = explicitPath(ctx);
      return dshPath ? `the CLI at ${dshPath}` : null;
    },
    install: (ctx) => installDshTree({ cacheDir: ctx.cacheDir, registry: ctx.registry, log: ctx.log }),
  },
};
