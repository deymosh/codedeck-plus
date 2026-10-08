/**
 * Tool kinds: each agent's tool names, as the phone groups and labels them.
 */
import { describe, expect, it } from 'vitest';
import { toolKindOf } from '../tools';

describe('toolKindOf', () => {
  it("reads every agent's spelling of a tool", () => {
    expect(toolKindOf('Edit')).toBe('edit');
    expect(toolKindOf('apply_patch')).toBe('edit');
    expect(toolKindOf('patch')).toBe('edit');
    expect(toolKindOf('lsp')).toBe('read');
    expect(toolKindOf('websearch')).toBe('fetch');
    expect(toolKindOf('something-new')).toBe('other');
  });
});
