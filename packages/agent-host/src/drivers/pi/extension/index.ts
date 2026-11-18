/**
 * The CodeDeck Pi extension: the module Pi loads, with `-e`, into every
 * session the driver starts.
 *
 * It is bundled on its own (bundle.mjs) and carried inside the agent host as
 * text, which the driver writes into Pi's home before a session starts
 * (../extension.ts). It runs inside Pi's process, so it may import only what
 * Pi provides to extensions — Pi maps `@earendil-works/*` and `typebox` to
 * its own copies, which the bundle leaves external — and Node's built-ins.
 * Nothing of the host exists there.
 *
 * A sub-agent's Pi (task.ts) loads it too, in a smaller form: the gate and
 * the provider profile, and `web_fetch` and the diagnostics of its file
 * changes for a general sub-agent — nothing
 * that talks to the user (questions, plans, the checklist), starts work that
 * outlives it (background shells), or writes the project's notes.
 */
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { getPowerShellConfig, getShellConfig, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAsk } from './ask';
import { killTree, registerBackground } from './background';
import { registerDiagnostics } from './lsp/diagnostics';
import type { CatalogModel } from './catalog';
import { installGate } from './gate';
import { registerMemory } from './memory';
import { registerPlanMode } from './plan';
import { PI_ENTRY_TYPE } from './protocol';
import { registerProfile } from './provider';
import { installShellCheck } from './shells';
import { registerTask, SUBAGENT_ENV } from './task';
import { registerTodo } from './todo';
import { registerWebFetch } from './webFetch';

/** Every chat model of the running Pi's own catalog. A catalog that cannot
 *  be read describes nothing: profile models then run at the fallbacks. */
function builtinCatalog(): CatalogModel[] {
  try {
    return getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider));
  } catch {
    return [];
  }
}

export default function codedeckPi(pi: ExtensionAPI): void {
  registerProfile(pi, process.env, builtinCatalog);
  installGate(pi);
  installShellCheck(pi, () => {
    try {
      getShellConfig();
      return true;
    } catch {
      return false;
    }
  });

  const subagent = process.env[SUBAGENT_ENV];
  if (subagent) {
    if (subagent === 'general') {
      registerWebFetch(pi);
      registerDiagnostics(pi, { kill: killTree });
    }
    return;
  }

  registerDiagnostics(pi, { kill: killTree });
  registerTodo(pi);
  registerAsk(pi);
  registerPlanMode(pi);
  registerWebFetch(pi);
  registerTask(pi, process.env);
  registerBackground(pi, {
    shells: { bash: () => getShellConfig(), powershell: () => getPowerShellConfig() },
    active: () => pi.getActiveTools(),
    report: (event) => pi.appendEntry(PI_ENTRY_TYPE, event),
  });
  // The notes live in Pi's home, which the driver always names; without it
  // there is nowhere that is the machine's own to keep them.
  const home = process.env.PI_CODING_AGENT_DIR;
  if (home) registerMemory(pi, { home, env: process.env });
}
