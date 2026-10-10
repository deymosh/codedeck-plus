/**
 * contextBreakdown — what fills a Claude Code session's context window, from
 * the SDK's `getContextUsage()` answer (the data behind Claude Code's own
 * `/context` view): the parts of the window, then the lists behind some of
 * them, item by item.
 *
 * The facade hands the answer over as `unknown`, so this module is
 * defensive: a part or an item that does not carry the expected shape is
 * left out, and an answer with no window size yields nothing.
 */
import type { ContextBreakdown, ContextCategory, ContextGroup, ContextItem, ContextKind } from '../../sdk/types';

/** Most items one list carries: a large MCP setup has hundreds of tools,
 *  and the whole answer travels in one message. */
export const MAX_CONTEXT_ITEMS = 200;

const KINDS: readonly ContextKind[] = ['used', 'free', 'buffer', 'deferred'];

type Raw = Record<string, unknown>;

const records = (v: unknown): Raw[] =>
  Array.isArray(v) ? v.filter((x): x is Raw => typeof x === 'object' && x !== null) : [];

/** A token count as the wire carries it: a whole, non-negative number. */
function tokensOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 0xffff_ffff) : undefined;
}

function category(raw: Raw): ContextCategory | undefined {
  const tokens = tokensOf(raw.tokens);
  if (typeof raw.name !== 'string' || raw.name === '' || tokens === undefined) return undefined;
  const kind = KINDS.find((k) => k === raw.kind) ?? (raw.isDeferred === true ? 'deferred' : 'used');
  return { name: raw.name, tokens, kind };
}

/** A list of the answer's items as a group, when it has any. */
function group(name: string, raw: Raw[], label: (item: Raw) => unknown): ContextGroup | undefined {
  const items: ContextItem[] = [];
  let total = 0;
  for (const entry of raw) {
    const itemName = label(entry);
    const tokens = tokensOf(entry.tokens);
    if (typeof itemName !== 'string' || itemName === '' || tokens === undefined) continue;
    total += tokens;
    if (items.length < MAX_CONTEXT_ITEMS) items.push({ name: itemName, tokens });
  }
  return items.length > 0 ? { name, tokens: Math.min(total, 0xffff_ffff), items } : undefined;
}

export function contextBreakdown(res: unknown): ContextBreakdown | undefined {
  if (typeof res !== 'object' || res === null) return undefined;
  const raw = res as Raw;
  const windowTokens = tokensOf(raw.maxTokens);
  const usedTokens = tokensOf(raw.totalTokens);
  if (!windowTokens || usedTokens === undefined) return undefined;
  const categories = records(raw.categories).flatMap((c) => category(c) ?? []);
  const skills = typeof raw.skills === 'object' && raw.skills !== null ? (raw.skills as Raw).skillFrontmatter : undefined;
  const groups = [
    group('MCP tools', records(raw.mcpTools), (t) =>
      typeof t.serverName === 'string' && t.serverName !== '' ? `${t.serverName} · ${String(t.name)}` : t.name,
    ),
    group('Memory files', records(raw.memoryFiles), (f) => f.path),
    group('Skills', records(skills), (s) => s.name),
    group('Custom agents', records(raw.agents), (a) => a.agentType),
  ].flatMap((g) => g ?? []);
  return { usedTokens, windowTokens, categories, ...(groups.length > 0 ? { groups } : {}) };
}
