/**
 * Pi: its CLI over RPC — the operator's own (CODEDECK_PI_PATH), else the
 * pinned package tree installed on demand — with its state under
 * `$PI_CODING_AGENT_DIR` in CODEDECK_PI_HOME.
 */
import type { DriverEnv, DriverModule } from '../../sdk/module';
import { isFile } from '../../sdk/executable';
import { providerHttp } from '../../sdk/net';
import { removePackageTree } from '../../install/agentInstall';
import { PiDriver } from './driver';
import { PI_PACKAGE, installPiTree, installedPiTree } from './install';
import { PiRuntime, piHomeDir } from './runtime';

const explicitPath = (ctx: DriverEnv): string | undefined => ctx.env.CODEDECK_PI_PATH?.trim() || undefined;

export const piModule: DriverModule = {
  id: 'pi',
  label: 'Pi',
  create(ctx) {
    const home = piHomeDir(ctx.lookupEnv);
    const piPath = explicitPath(ctx);
    const runtime = new PiRuntime({
      // An explicit path is the operator's own CLI; without one the pinned
      // tree is installed on demand, at the version and sha512
      // pnpm-lock.yaml holds.
      ...(piPath ? { piPath } : {}),
      cacheDir: ctx.cacheDir,
      registry: ctx.registry,
      installPi: installPiTree,
      log: ctx.log,
    });
    const driver = new PiDriver({
      runtime,
      home,
      baseEnv: ctx.ownEnv,
      providerHttp,
      log: ctx.log,
    });
    if (piPath && !isFile(piPath)) {
      driver.setUnavailable(`CODEDECK_PI_PATH points at ${piPath}, which is not a file.`);
    }
    return driver;
  },
  runtime: {
    find: (ctx) => {
      const piPath = explicitPath(ctx);
      return piPath ? `the CLI at ${piPath}` : null;
    },
    installed: (ctx) => installedPiTree(ctx.cacheDir),
    install: (ctx) => installPiTree({ cacheDir: ctx.cacheDir, registry: ctx.registry, log: ctx.log }),
    remove: (ctx) => removePackageTree(PI_PACKAGE, ctx.cacheDir),
  },
};
