/**
 * The DeepSeek Harness: its CLI over ACP — the operator's own
 * (CODEDECK_DEEPSEEK_PATH), else the pinned package tree installed on
 * demand — with its state under CODEDECK_DEEPSEEK_HOME.
 */
import type { DriverEnv, DriverModule } from '../../sdk/module';
import { isFile } from '../../sdk/executable';
import { httpGet, providerHttp } from '../../sdk/net';
import { DeepSeekDriver } from './driver';
import { takeDeepSeekEnv } from './env';
import { removePackageTree } from '../../install/agentInstall';
import { DSH_PACKAGE, installDshTree, installedDshTree } from './install';
import { DeepSeekRuntime, dshHomeDir } from './runtime';

const explicitPath = (ctx: DriverEnv): string | undefined => ctx.env.CODEDECK_DEEPSEEK_PATH?.trim() || undefined;

export const deepSeekModule: DriverModule = {
  id: 'deepseek-harness',
  label: 'DeepSeek Harness',
  // The harness's endpoint and key are its driver's alone.
  claimEnv: takeDeepSeekEnv,
  create(ctx) {
    const home = dshHomeDir(ctx.lookupEnv);
    const dshPath = explicitPath(ctx);
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
        log: ctx.log,
      }),
      home,
      baseEnv: ctx.ownEnv,
      httpGet,
      providerHttp,
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
    installed: (ctx) => installedDshTree(ctx.cacheDir),
    install: (ctx) => installDshTree({ cacheDir: ctx.cacheDir, registry: ctx.registry, log: ctx.log }),
    remove: (ctx) => removePackageTree(DSH_PACKAGE, ctx.cacheDir),
  },
};
