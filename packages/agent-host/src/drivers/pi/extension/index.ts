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
 */
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { CatalogModel } from './catalog';
import { registerAsk } from './ask';
import { installGate } from './gate';
import { registerMemory } from './memory';
import { registerPlanMode } from './plan';
import { registerProfile } from './provider';
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
  registerTodo(pi);
  registerAsk(pi);
  registerPlanMode(pi);
  registerWebFetch(pi);
  // The notes live in Pi's home, which the driver always names; without it
  // there is nowhere that is the machine's own to keep them.
  const home = process.env.PI_CODING_AGENT_DIR;
  if (home) registerMemory(pi, { home, env: process.env });
}
