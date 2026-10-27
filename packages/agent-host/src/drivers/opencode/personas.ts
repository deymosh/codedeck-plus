/**
 * OpenCode's agents as the phone's personas: which of them a session can run
 * as, how they are ordered, and how a call waits for a just-booted
 * directory's own agents to load rather than answering with the built-ins
 * alone.
 */
import type { AgentInfo as OpenCodeAgent, OpenCodeClient } from '@opencode/client';
import type { Persona } from '../../sdk/types';
import { BUILD_AGENT, PLAN_AGENT } from './modes';

/** The agents OpenCode ships with. A directory's own agents load a moment
 *  after it is booted, so a list holding only these may still be missing
 *  them. */
const BUILTIN_AGENTS = new Set(['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary']);
/** How long after a directory was booted its own agents are still loading. */
export const PERSONA_LOAD_MS = 1_000;
/** How often a list or a lookup is retried while they load. */
export const PERSONA_POLL_MS = 100;
/** How long a session waits for the persona it was asked for. */
export const PERSONA_WAIT_MS = 2_000;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether an agent OpenCode knows is one a session can run as. `plan` is
 *  this driver's own Plan mode agent, and a subagent or a hidden one is not
 *  a configuration a session is run as. */
export function isPersona(agent: OpenCodeAgent): boolean {
  return agent.mode !== 'subagent' && !agent.hidden && agent.id !== PLAN_AGENT;
}

/** OpenCode's agents as the phone's persona list: the selectable ones,
 *  `build` first, then OpenCode's own order. */
export function toPersonas(agents: readonly OpenCodeAgent[]): Persona[] {
  const selectable = agents.filter(isPersona).map((agent) => ({
    id: agent.id,
    label: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.color ? { color: agent.color } : {}),
  }));
  const build = selectable.filter((p) => p.id === BUILD_AGENT);
  return [...build, ...selectable.filter((p) => p.id !== BUILD_AGENT)];
}

/**
 * The selectable agents OpenCode lists for `location` (its own directory
 * when none is named, which is the built-ins plus the global agents). A
 * just-booted directory lists its built-ins at once and its own agents a
 * moment later, so while only the built-ins are there this keeps asking —
 * until `waitUntil`, past which a call never waits.
 */
export async function listSelectablePersonas(
  client: OpenCodeClient,
  location: { directory: string } | undefined,
  waitUntil: number,
): Promise<Persona[]> {
  const listed = async (): Promise<OpenCodeAgent[]> => {
    try {
      return (await client.agent.list(location ? { location } : undefined)).data;
    } catch {
      return [];
    }
  };
  let agents = await listed();
  while (Date.now() < waitUntil && agents.every((a) => BUILTIN_AGENTS.has(a.id))) {
    await delay(PERSONA_POLL_MS);
    agents = await listed();
  }
  return toPersonas(agents);
}

