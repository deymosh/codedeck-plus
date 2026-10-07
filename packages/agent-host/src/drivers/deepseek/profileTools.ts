/**
 * The model-facing tools an automation profile does not mount by itself.
 *
 * The harness's shared core registers the `user-questions` service and the
 * plan-mode tool that presents a plan through it, but the tool that *asks* —
 * `ask_user_question`, out of `@deepseek-ai/dsh-tool-ask-user` — belongs to the
 * web app's agent presets. A headless profile therefore runs a model that plan
 * mode's own instructions tell to ask the user with a tool it does not have,
 * which is exactly what a model reports when it is asked about its tools.
 * CodeDeck mounts it here, bare, the way the harness's own presets do: one row,
 * resolved out of the harness's own installation.
 *
 * One tool is deliberately left out. `present` (`@deepseek-ai/dsh-tool-present`)
 * declares deliverable files for the web app's files pane; nothing on the phone
 * would show what it declares, so mounting it would give the model a way to
 * report something the user never sees.
 *
 * The row lives in its own block of the profile's patch layer. A harness that
 * changes under it costs the tool and nothing else — an entry that cannot be
 * imported is a warning at boot, not a failure.
 */
import * as path from 'node:path';
import { ProfileLayer, type LayerBlock } from './profileLayer';

/** The question tool, as the harness's own agent presets mount it. */
export const ASK_USER_TOOL = '@deepseek-ai/dsh-tool-ask-user';

/** This block's markers in the profile's patch layer. */
const BLOCK: LayerBlock = {
  begin: "# --- CodeDeck+ tools: the model-facing tools this profile's bundles leave out; everything outside this block is yours ---",
  end: '# --- end CodeDeck+ tools ---',
};

/** Mount them in the profile's own patch layer. */
export async function installProfileTools(profileDir: string, log: (message: string) => void): Promise<void> {
  await new ProfileLayer(path.join(profileDir, 'cordis.patch.yml'), log).set(
    BLOCK,
    ['- insert:', '    - id: tool-ask-user', `      name: '${ASK_USER_TOOL}'`].join('\n'),
  );
}
