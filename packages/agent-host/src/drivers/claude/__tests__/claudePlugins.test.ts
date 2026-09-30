/**
 * ClaudePlugins against a scripted `claude` CLI, answering in the shapes the
 * real CLI (2.1.283) prints.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { actionArgs, ClaudePlugins, failureMessage, hookPluginOf, updateMessage, type CliResult } from '../plugins';

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

  it('an update reports the versions, and a marketplace change brings the catalog', async () => {
    expect(actionArgs('update', 'commit-commands@claude-plugins-official')).toEqual([
      'plugin',
      'update',
      'commit-commands@claude-plugins-official',
      '--json',
    ]);

    const { run } = cli(() =>
      ok({ command: 'update', outcome: 'ok', updateOutcome: 'up_to_date', oldVersion: '0.2.0', newVersion: '0.2.0' }),
    );
    const plugins = new ClaudePlugins(run, async () => {});
    const state = await plugins.act('update', 'commit-commands@claude-plugins-official');
    expect(state.message).toBe('Already at the latest version (0.2.0).');
    expect(state.available).toBeUndefined();

    const shaOld = 'fa59bc903774aaaa000000000000000000000001';
    const shaNew = 'fa59bc903779bbbb000000000000000000000002';
    const moved = cli(() => ok({ command: 'update', outcome: 'ok', updateOutcome: 'updated', oldVersion: shaOld, newVersion: shaNew }));
    const plugins2 = new ClaudePlugins(moved.run, async () => {});
    const state2 = await plugins2.act('update', 'commit-commands@claude-plugins-official');
    expect(state2.message).toBe('Updated from fa59bc903774 to fa59bc903779.');

    const catalog = cli();
    const plugins3 = new ClaudePlugins(catalog.run, async () => {});
    const state3 = await plugins3.act('update-marketplace', 'claude-plugins-official');
    expect(catalog.calls).toContainEqual(['plugin', 'marketplace', 'update', 'claude-plugins-official']);
    expect(state3.available).toBeDefined();
    expect(state3.message).toBeUndefined();
  });

  it('an update without versions falls back to the CLI message, or says nothing', () => {
    expect(updateMessage({ command: 'update', outcome: 'ok', message: 'Done.' })).toBe('Done.');
    expect(updateMessage({ command: 'update', outcome: 'ok' })).toBeUndefined();
    expect(updateMessage(undefined)).toBeUndefined();
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

describe('hookPluginOf', () => {
  const guard = { hooks: { PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: 'guard' }] }] } };
  const files = (map: Record<string, unknown>) => (file: string) => map[path.normalize(file)];
  const at = (...parts: string[]) => path.normalize(path.join(...parts));
  const routing = { name: 'ccr-subagent-routing', path: at('/plugins', 'routing') };
  const lint = { name: 'lint', path: at('/plugins', 'lint') };

  it('names the one plugin whose hooks file matches the tool', () => {
    const read = files({ [at(routing.path, 'hooks', 'hooks.json')]: guard });
    expect(hookPluginOf('Agent', [lint, routing], [], read)).toBe('ccr-subagent-routing');
    expect(hookPluginOf('Bash', [lint, routing], [], read)).toBeUndefined();
  });

  it('reads the hooks a manifest names or inlines', () => {
    const read = files({
      [at(routing.path, '.claude-plugin', 'plugin.json')]: { hooks: './config/guard.json' },
      [at(routing.path, 'config', 'guard.json')]: guard,
      [at(lint.path, '.claude-plugin', 'plugin.json')]: { hooks: { PreToolUse: [{ matcher: 'Bash' }] } },
    });
    expect(hookPluginOf('Task', [lint, routing], [], read)).toBe('ccr-subagent-routing');
    expect(hookPluginOf('Bash', [lint, routing], [], read)).toBe('lint');
  });

  it('names no plugin when two could have asked, or a settings file holds a matching hook too', () => {
    const everything = { hooks: { PreToolUse: [{ hooks: [] }] } };
    const read = files({
      [at(routing.path, 'hooks', 'hooks.json')]: guard,
      [at(lint.path, 'hooks', 'hooks.json')]: everything,
      [at('/home', 'settings.json')]: { hooks: { PreToolUse: [{ matcher: 'Agent' }] } },
    });
    expect(hookPluginOf('Agent', [lint, routing], [], read)).toBeUndefined();
    expect(hookPluginOf('Agent', [routing], [at('/home', 'settings.json')], read)).toBeUndefined();
    expect(hookPluginOf('Agent', [routing], [at('/missing.json')], read)).toBe('ccr-subagent-routing');
  });
});
