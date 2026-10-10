/**
 * contextBreakdown — the SDK's context-usage answer as the parts of the
 * window and the lists behind them.
 */
import { describe, expect, it } from 'vitest';
import { contextBreakdown, MAX_CONTEXT_ITEMS } from '../context';

/** The shape `getContextUsage()` answers with (trimmed to what is read). */
const answer = (over: Record<string, unknown> = {}) => ({
  categories: [
    { name: 'Messages', tokens: 211_600, color: 'blue', kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'grey', kind: 'buffer' },
    { name: 'Free space', tokens: 692_700.4, color: 'grey', kind: 'free' },
    { name: 'MCP tools', tokens: 22_900, color: 'grey', isDeferred: true },
  ],
  totalTokens: 274_300,
  maxTokens: 1_000_000,
  percentage: 27,
  mcpTools: [
    { name: 'add_repo', serverName: 'remote', tokens: 1_300 },
    { name: 'archive', serverName: 'remote', tokens: 197 },
  ],
  memoryFiles: [{ path: '/home/me/.claude/CLAUDE.md', type: 'User', tokens: 5_100 }],
  agents: [],
  ...over,
});

describe('contextBreakdown', () => {
  it('keeps the parts in order, with what each is against the window', () => {
    expect(contextBreakdown(answer())).toEqual({
      usedTokens: 274_300,
      windowTokens: 1_000_000,
      categories: [
        { name: 'Messages', tokens: 211_600, kind: 'used' },
        { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
        { name: 'Free space', tokens: 692_700, kind: 'free' },
        { name: 'MCP tools', tokens: 22_900, kind: 'deferred' },
      ],
      groups: [
        { name: 'MCP tools', tokens: 1_497, items: [{ name: 'remote · add_repo', tokens: 1_300 }, { name: 'remote · archive', tokens: 197 }] },
        { name: 'Memory files', tokens: 5_100, items: [{ name: '/home/me/.claude/CLAUDE.md', tokens: 5_100 }] },
      ],
    });
  });

  it('lists skills by name, and leaves out what it cannot read', () => {
    const got = contextBreakdown(answer({
      categories: [{ name: 'Skills', tokens: 'many' }, { tokens: 3 }, { name: 'Messages', tokens: 10, kind: 'used' }],
      mcpTools: 'none',
      skills: { totalSkills: 2, tokens: 9, skillFrontmatter: [{ name: 'deploy', tokens: 9 }, { name: '', tokens: 1 }] },
    }));
    expect(got?.categories).toEqual([{ name: 'Messages', tokens: 10, kind: 'used' }]);
    expect(got?.groups).toEqual([
      { name: 'Memory files', tokens: 5_100, items: [{ name: '/home/me/.claude/CLAUDE.md', tokens: 5_100 }] },
      { name: 'Skills', tokens: 9, items: [{ name: 'deploy', tokens: 9 }] },
    ]);
  });

  it('caps a long list, though its total counts every item', () => {
    const tools = Array.from({ length: MAX_CONTEXT_ITEMS + 5 }, (_, i) => ({ name: `t${i}`, serverName: 's', tokens: 2 }));
    const mcp = contextBreakdown(answer({ mcpTools: tools }))?.groups?.[0];
    expect(mcp?.items).toHaveLength(MAX_CONTEXT_ITEMS);
    expect(mcp?.tokens).toBe((MAX_CONTEXT_ITEMS + 5) * 2);
  });

  it('is nothing without a window size', () => {
    expect(contextBreakdown(answer({ maxTokens: 0 }))).toBeUndefined();
    expect(contextBreakdown(null)).toBeUndefined();
    expect(contextBreakdown('x')).toBeUndefined();
  });
});
