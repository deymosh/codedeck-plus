import { describe, expect, it } from 'vitest';
import { parseVersion } from '../version';

describe('parseVersion', () => {
  it('finds the release in what a binary prints', () => {
    expect(parseVersion('2.1.283 (Claude Code)\n')).toBe('2.1.283');
    expect(parseVersion('opencode 2.0.28')).toBe('2.0.28');
    expect(parseVersion('0.2.0-rc.2')).toBe('0.2.0-rc.2');
  });

  it('finds none in text without one', () => {
    expect(parseVersion('command not found')).toBeUndefined();
  });
});
