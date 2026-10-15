/**
 * Reading a session's ACP config options: the choices a select option
 * offers, whether the agent sends them flat or grouped.
 */
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

/** One choice of a session config option. */
export interface Choice {
  /** The agent's own selector value (what `set_config_option` takes). */
  value: string;
  label: string;
  /** Who serves it, as a person reads it, when the option says. */
  provider?: string;
  description?: string;
}

/**
 * The choices of a select option. ACP lets an agent send them as one flat
 * list or grouped — an agent groups its models by provider (one group per
 * configured provider, named after it) while its other options come flat.
 */
export function selectChoices(option: SessionConfigOption | undefined): Choice[] {
  if (!option || option.type !== 'select') return [];
  const choices: Choice[] = [];
  for (const entry of option.options) {
    if (!isGroup(entry)) {
      choices.push({ value: entry.value, label: entry.name, ...(entry.description ? { description: entry.description } : {}) });
      continue;
    }
    for (const inner of entry.options) {
      choices.push({
        value: inner.value,
        label: inner.name,
        provider: entry.name,
        ...(inner.description ? { description: inner.description } : {}),
      });
    }
  }
  return choices;
}

/** ACP sends a select option's values either as one flat list or as groups;
 *  only a group entry carries values of its own. */
function isGroup(entry: {
  value?: unknown;
  options?: unknown;
}): entry is { name: string; group?: string; options: Array<{ value: string; name: string; description?: string | null }> } {
  return Array.isArray(entry.options);
}
