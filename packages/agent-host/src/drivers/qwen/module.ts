/**
 * Qwen Code: its CLI over ACP (`qwen --acp`) — the operator's own
 * (CODEDECK_QWEN_PATH), else the pinned package tree installed on demand —
 * with its state under `$QWEN_HOME` (CODEDECK_QWEN_HOME, else a `qwen`
 * directory beside the installed agent binaries).
 */
import type { DriverEnv, DriverModule } from '../../sdk/module';
import { isFile } from '../../sdk/executable';
import { providerHttp } from '../../sdk/net';
import { removePackageTree } from '../../install/agentInstall';
import { QwenDriver } from './driver';
import { QWEN_PACKAGE, installQwenTree, installedQwenTree } from './install';
import { QwenRuntime, qwenHomeDir } from './runtime';

const explicitPath = (ctx: DriverEnv): string | undefined => ctx.env.CODEDECK_QWEN_PATH?.trim() || undefined;

export const qwenModule: DriverModule = {
  id: 'qwen-code',
  label: 'Qwen Code',
  create(ctx) {
    const home = qwenHomeDir(ctx.lookupEnv);
    const qwenPath = explicitPath(ctx);
    const driver = QwenDriver.create({
      runtime: new QwenRuntime({
        // An explicit path is the operator's own CLI; without one the pinned
        // tree is installed on demand, at the version and sha512
        // pnpm-lock.yaml holds.
        ...(qwenPath ? { qwenPath } : {}),
        home,
        cacheDir: ctx.cacheDir,
        registry: ctx.registry,
        installQwen: installQwenTree,
        log: ctx.log,
      }),
      home,
      baseEnv: ctx.ownEnv,
      providerHttp,
      log: ctx.log,
    });
    if (qwenPath && !isFile(qwenPath)) {
      driver.setUnavailable(`CODEDECK_QWEN_PATH points at ${qwenPath}, which is not a file.`);
    }
    return driver;
  },
  runtime: {
    find: (ctx) => {
      const qwenPath = explicitPath(ctx);
      return qwenPath ? `the CLI at ${qwenPath}` : null;
    },
    installed: (ctx) => installedQwenTree(ctx.cacheDir),
    install: (ctx) => installQwenTree({ cacheDir: ctx.cacheDir, registry: ctx.registry, log: ctx.log }),
    remove: (ctx) => removePackageTree(QWEN_PACKAGE, ctx.cacheDir),
  },
};
