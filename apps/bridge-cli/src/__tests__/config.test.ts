/**
 * Config precedence (CDB-036): flags > CODEDECK_* env > config.json > defaults.
 * Every test pins `env` explicitly so the real environment never leaks in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_RELAYS, FALLBACK_RELAY, PRIMARY_RELAY } from '@codedeck/protocol';
import { loadCliConfig, resolveHomeDir } from '../config';

let home: string;

beforeEach(() => {
  home = path.join(os.tmpdir(), `codedeck-cli-config-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function writeConfig(json: unknown): void {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(json));
}

describe('resolveHomeDir', () => {
  it('defaults to ~/.codedeck, env overrides, flag overrides env', () => {
    expect(resolveHomeDir({}, {})).toBe(path.join(os.homedir(), '.codedeck'));
    expect(resolveHomeDir({}, { CODEDECK_HOME: '/tmp/env-home' })).toBe('/tmp/env-home');
    expect(resolveHomeDir({ home: '/tmp/flag-home' }, { CODEDECK_HOME: '/tmp/env-home' }))
      .toBe('/tmp/flag-home');
  });
});

describe('loadCliConfig', () => {
  it('applies defaults with no flags/env/file', () => {
    const { config, configFileExists } = loadCliConfig({ home }, {});
    expect(configFileExists).toBe(false);
    expect(config.host).toBe('cli');
    expect(config.machineName).toBe(`${os.hostname()} (cli)`);
    expect(config.relays).toEqual([...DEFAULT_RELAYS]);
    expect(config.workspaceRoots).toEqual([process.cwd()]);
    expect(config.claudePath).toBeUndefined();
    // CDX-042: a clean install must reach more than one LIVE relay — the
    // undeployed primary does not count towards redundancy.
    expect(config.relays).toContain(FALLBACK_RELAY);
    expect(config.relays.filter((r) => r !== PRIMARY_RELAY).length).toBeGreaterThanOrEqual(2);
  });

  it('reads the config file', () => {
    writeConfig({
      machineName: 'file-machine',
      relays: ['wss://file.relay'],
      workspaceRoots: ['/tmp/file-root'],
      claudePath: '/opt/claude',
      relayRegisterEndpoint: 'https://file.example/register',
      relayRegisterToken: 'file-token',
    });
    const { config, configFileExists } = loadCliConfig({ home }, {});
    expect(configFileExists).toBe(true);
    expect(config.machineName).toBe('file-machine');
    expect(config.relays).toEqual(['wss://file.relay']);
    expect(config.workspaceRoots).toEqual(['/tmp/file-root']);
    expect(config.claudePath).toBe('/opt/claude');
    expect(config.relayRegisterEndpoint).toBe('https://file.example/register');
    expect(config.relayRegisterToken).toBe('file-token');
  });

  it('env overrides the config file (relays comma-separated)', () => {
    writeConfig({ machineName: 'file-machine', relays: ['wss://file.relay'] });
    const { config } = loadCliConfig({ home }, {
      CODEDECK_MACHINE_NAME: 'env-machine',
      CODEDECK_RELAYS: 'wss://env-a.relay, wss://env-b.relay',
      CODEDECK_WORKSPACE_ROOTS: '/tmp/env-root-1,/tmp/env-root-2',
      CODEDECK_CLAUDE_PATH: '/env/claude',
    });
    expect(config.machineName).toBe('env-machine');
    expect(config.relays).toEqual(['wss://env-a.relay', 'wss://env-b.relay']);
    expect(config.workspaceRoots).toEqual(['/tmp/env-root-1', '/tmp/env-root-2']);
    expect(config.claudePath).toBe('/env/claude');
  });

  it('flags override env (repeatable --relay/--workspace)', () => {
    writeConfig({ machineName: 'file-machine' });
    const { config } = loadCliConfig(
      {
        home,
        machineName: 'flag-machine',
        relays: ['wss://flag.relay'],
        workspaces: ['/tmp/flag-root'],
        claudePath: '/flag/claude',
      },
      {
        CODEDECK_MACHINE_NAME: 'env-machine',
        CODEDECK_RELAYS: 'wss://env.relay',
        CODEDECK_WORKSPACE_ROOTS: '/tmp/env-root',
        CODEDECK_CLAUDE_PATH: '/env/claude',
      },
    );
    expect(config.machineName).toBe('flag-machine');
    expect(config.relays).toEqual(['wss://flag.relay']);
    expect(config.workspaceRoots).toEqual(['/tmp/flag-root']);
    expect(config.claudePath).toBe('/flag/claude');
  });

  it('workspace roots are resolved to absolute paths', () => {
    const { config } = loadCliConfig({ home, workspaces: ['rel/dir'] }, {});
    expect(config.workspaceRoots).toEqual([path.resolve('rel/dir')]);
  });

  it('host is "service" under --service or systemd INVOCATION_ID, and the default machineName follows', () => {
    expect(loadCliConfig({ home, service: true }, {}).config.host).toBe('service');
    const underSystemd = loadCliConfig({ home }, { INVOCATION_ID: 'abc123' });
    expect(underSystemd.config.host).toBe('service');
    expect(underSystemd.config.machineName).toBe(`${os.hostname()} (service)`);
  });

  it('rejects a corrupt config file with an actionable error', () => {
    writeFileSync(path.join(home, 'config.json'), '{not json');
    expect(() => loadCliConfig({ home }, {})).toThrow(/invalid JSON in .*config\.json/);
  });
});
