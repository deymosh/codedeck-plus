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
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installGate } from './gate';
import { registerProfile } from './provider';

export default function codedeckPi(pi: ExtensionAPI): void {
  registerProfile(pi, process.env);
  installGate(pi);
}
