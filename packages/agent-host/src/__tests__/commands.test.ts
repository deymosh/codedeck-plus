import { describe, expect, it } from 'vitest';
import { parseSlashCommand, shortDescription, slashCommand } from '../commands';

describe('slash commands', () => {
  it('a description keeps its first paragraph, cut at a word within the limit', () => {
    expect(shortDescription('Compact the conversation.\n\nLong details.')).toBe('Compact the conversation.');
    const long = shortDescription(`Use this skill whenever ${'you draw a chart '.repeat(20)}`);
    expect(long.length).toBeLessThanOrEqual(201);
    expect(long.endsWith('…')).toBe(true);
    expect(['you', 'draw', 'a', 'chart']).toContain(long.slice(0, -1).split(' ').pop());
  });

  it('empty fields are left out', () => {
    expect(slashCommand('init', '', '  ')).toEqual({ name: 'init' });
    expect(slashCommand('review', 'Review a PR', '<pr>')).toEqual({ name: 'review', description: 'Review a PR', argumentHint: '<pr>' });
  });

  it('only /name, then its arguments, is a command', () => {
    expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', args: '' });
    expect(parseSlashCommand(' /review  12 --fix ')).toEqual({ name: 'review', args: '12 --fix' });
    expect(parseSlashCommand('/commit-commands:commit\nnow')).toEqual({ name: 'commit-commands:commit', args: 'now' });
    expect(parseSlashCommand('/etc/hosts is broken')).toBeNull();
    expect(parseSlashCommand('/ path')).toBeNull();
    expect(parseSlashCommand('please /compact')).toBeNull();
  });
});
