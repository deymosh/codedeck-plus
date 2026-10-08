/**
 * Slash commands as the phone's command menu shows them, whatever agent
 * listed them.
 */
import type { SlashCommand } from './types';

/** The longest description sent: a menu row shows a line or two, and some
 *  commands (skills above all) describe themselves in a thousand words. */
const MAX_DESCRIPTION = 200;

/** A description cut to its first paragraph and at most MAX_DESCRIPTION
 *  characters, at a word boundary. */
export function shortDescription(text: string): string {
  const first = text.trim().split(/\n\s*\n|\n/)[0]!.trim();
  if (first.length <= MAX_DESCRIPTION) return first;
  const cut = first.slice(0, MAX_DESCRIPTION);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_DESCRIPTION / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** One command, with empty fields left out and the description shortened. */
export function slashCommand(name: string, description?: string | null, argumentHint?: string | null): SlashCommand {
  const desc = description ? shortDescription(description) : '';
  const hint = argumentHint?.trim() ?? '';
  return { name, ...(desc ? { description: desc } : {}), ...(hint ? { argumentHint: hint } : {}) };
}

/** `/name rest` split into the command name and its arguments; null when the
 *  text is not a slash command (a bare `/`, or a path like `/etc/hosts`). */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1]!, args: (m[2] ?? '').trim() } : null;
}
