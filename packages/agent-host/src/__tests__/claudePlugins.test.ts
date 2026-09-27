/**
 * ClaudePlugins against a scripted `claude` CLI, answering in the shapes the
 * real CLI (2.1.283) prints.
 */
import { describe, expect, it } from 'vitest';
import { ClaudePlugins, failureMessage, type CliResult } from '../drivers/claude/plugins';

const INSTALLED = [{
  id: 'commit-commands@claude-plugins-official',
  version: 'fa59bc903774',
  scope: 'user',
  enabled: false,
  installPath: '/cfg/plugins/cache/claude-plugins-official/commit-commands/fa59bc903774',
  installedAt: '2026-09-27T22:39:26.644Z',
}];
const AVAILABLE = [{
  pluginId: 'agentforce-adlc@claude-plugins-official',
  name: 'agentforce-adlc',
  description: 'Agentforce Agent Development Life Cycle — author, discover, scaffold, deploy, test, and optimize .agent files',
  marketplaceName: 'claude-plugins-official',
  source: { source: 'url', url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git' },
  installCount: 1490,
}];
const MARKETPLACES = [
  { name: 'anthropic-agent-skills', source: 'git', url: 'https://github.com/anthropics/skills.git', installLocation: '/cfg/x' },
  { name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official', installLocation: '/cfg/y' },
];

const ok = (value: unknown): CliResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

/** A CLI that answers the list commands, and `answer` for anything else. */
function cli(answer: (args: string[]) => CliResult = () => ok({ outcome: 'ok' })) {
  const calls: string[][] = [];
  const run = async (args: string[], _timeoutMs?: number): Promise<CliResult> => {
    calls.push(args);
    const cmd = args.join(' ');
    if (cmd === 'plugin list --available --json') return ok({ installed: INSTALLED, available: AVAILABLE });
    if (cmd === 'plugin list --json') return ok(INSTALLED);
    if (cmd === 'plugin marketplace list --json') return ok(MARKETPLACES);
    return answer(args);
  };
  return { calls, run };
}

const describePlugin = (installPath: string) => (installPath.includes('commit-commands') ? 'Git commit workflows' : undefined);

describe('Claude plugins', () => {
  it('lists what is installed, the marketplaces, and on request what they offer', async () => {
    const { run } = cli();
    const plugins = new ClaudePlugins(run, async () => {}, describePlugin);
    const state = await plugins.list(true);
    expect(state).toEqual({
      installed: [{
        id: 'commit-commands@claude-plugins-official', name: 'commit-commands', marketplace: 'claude-plugins-official',
        version: 'fa59bc903774', description: 'Git commit workflows', enabled: false,
      }],
      marketplaces: [
        { name: 'anthropic-agent-skills', source: 'https://github.com/anthropics/skills.git' },
        { name: 'claude-plugins-official', source: 'anthropics/claude-plugins-official' },
      ],
      toggles: true,
      available: [{
        id: 'agentforce-adlc@claude-plugins-official', name: 'agentforce-adlc', marketplace: 'claude-plugins-official',
        description: AVAILABLE[0]!.description, installCount: 1490,
      }],
    });
    expect((await plugins.list(false)).available).toBeUndefined();
  });

  it('a change runs the CLI, tells the sessions, and answers the new state', async () => {
    const { calls, run } = cli();
    let reloads = 0;
    const plugins = new ClaudePlugins(run, async () => void reloads++, describePlugin);
    const state = await plugins.act('enable', 'commit-commands@claude-plugins-official');
    expect(calls[0]).toEqual(['plugin', 'enable', 'commit-commands@claude-plugins-official', '--json']);
    expect(reloads).toBe(1);
    expect(state.installed).toHaveLength(1);
    expect(state.available).toBeUndefined();

    await plugins.act('add-marketplace', 'me/skills');
    expect(calls).toContainEqual(['plugin', 'marketplace', 'add', 'me/skills']);
  });

  it("a refused change rejects with the CLI's reason and tells no session", async () => {
    const failed: CliResult = {
      code: 1,
      stdout: '{"command":"install","outcome":"failed","plugin":"nope@claude-plugins-official","message":"Plugin \\"nope\\" not found in marketplace \\"claude-plugins-official\\"","failureCode":"not_found"}\n',
      stderr: '✘ Failed to install plugin "nope@claude-plugins-official": Plugin "nope" not found',
    };
    let reloads = 0;
    const plugins = new ClaudePlugins(cli(() => failed).run, async () => void reloads++);
    await expect(plugins.act('install', 'nope@claude-plugins-official')).rejects.toThrow('Plugin "nope" not found in marketplace "claude-plugins-official"');
    expect(reloads).toBe(0);

    const plain: CliResult = { code: 1, stdout: 'Cloning…\n', stderr: '✘ Failed to add marketplace: repository not found\n' };
    expect(failureMessage(plain)).toBe('Failed to add marketplace: repository not found');
  });

  it('never runs a target that would read as an option, and runs one change at a time', async () => {
    let running = 0;
    let installing = false;
    let collided = false;
    const { calls, run } = cli();
    const slow = async (args: string[], t: number): Promise<CliResult> => {
      const install = args[1] === 'install';
      if (installing || (install && running > 0)) collided = true;
      running++;
      installing ||= install;
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (install) installing = false;
      return run(args, t);
    };
    const plugins = new ClaudePlugins(slow, async () => {});
    await expect(plugins.act('uninstall', '--prune')).rejects.toThrow(/not a plugin/);
    expect(calls).toEqual([]);
    await Promise.all([plugins.act('install', 'a@m'), plugins.list(true), plugins.act('install', 'b@m')]);
    expect(collided).toBe(false);
    expect(calls.filter((c) => c[1] === 'install').map((c) => c[2])).toEqual(['a@m', 'b@m']);
  });
});
