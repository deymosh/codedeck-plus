/**
 * The ACP process pool: which process an environment's sessions share, and
 * when a change to the configuration a process loads needs a new one.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcpRuntime,
  type AcpProcessEvents,
  type AcpProcessSpec,
  type SpawnFn,
} from '../runtime';
import { FakeAgent } from './fakeAgent';

/** A runtime over scripted ACP agents; each spawn gets its own fake. */
class TestRuntime extends AcpRuntime<undefined, AcpProcessEvents> {
  readonly agents: FakeAgent[];
  /** The directory each spawn was started in. */
  readonly cwds: Array<string | undefined>;

  constructor(
    version: () => number,
    private readonly dir: string = mkdtempSync(path.join(tmpdir(), 'codedeck-acp-')),
  ) {
    const agents: FakeAgent[] = [];
    const cwds: Array<string | undefined> = [];
    super({
      log: () => {},
      tag: 'test',
      label: 'Test agent',
      configVersion: version,
      idleCloseMs: 0,
      spawnFn: ((_command: string, _args: string[], opts: { cwd?: string }) => {
        cwds.push(opts.cwd);
        const agent = new FakeAgent();
        agents.push(agent);
        return agent.child;
      }) as unknown as SpawnFn,
    });
    this.agents = agents;
    this.cwds = cwds;
  }

  entryPoint(): Promise<string> {
    return Promise.resolve('/fake/agent');
  }

  protected spec(_entry: string, env: Record<string, string>): AcpProcessSpec<undefined> {
    return { command: process.execPath, args: [], env, cwd: this.dir, handle: undefined };
  }
}

describe('AcpRuntime process start', () => {
  it('starts a process in the directory its spec names, creating it on a fresh machine', async () => {
    // An agent reads files from the directory it starts in (a `.env`, a
    // workspace settings file): left to inherit the host's, it would read
    // whatever project the host happens to run in. The agent's own state
    // directory may not exist yet, and a spawn into a missing directory fails.
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'codedeck-acp-')), 'not', 'yet');
    const runtime = new TestRuntime(() => 0, dir);
    const process_ = await runtime.acquire({ A: '1' }, { ended: () => {} });
    expect(runtime.cwds).toEqual([dir]);
    expect(existsSync(dir)).toBe(true);
    process_.release();
    await runtime.close();
  });
});

describe('AcpRuntime process reuse', () => {
  it('serves the same environment from one process while its config is unchanged', async () => {
    const runtime = new TestRuntime(() => 0);
    const events: AcpProcessEvents = { ended: () => {} };
    const first = await runtime.acquire({ A: '1' }, events);
    const second = await runtime.acquire({ A: '1' }, events);
    expect(second).toBe(first);
    expect(runtime.agents).toHaveLength(1);
    first.release();
    second.release();
    await runtime.close();
  });

  it('gives a new session a process at the current config version, and leaves older sessions theirs', async () => {
    let version = 0;
    const runtime = new TestRuntime(() => version);
    const events: AcpProcessEvents = { ended: () => {} };
    const old = await runtime.acquire({ A: '1' }, events);
    expect(old.configVersion).toBe(0);

    // A change to the configuration a process loads (MCP servers, say) must
    // reach the next session, even while an older one is still running.
    version = 1;
    const fresh = await runtime.acquire({ A: '1' }, events);
    expect(fresh).not.toBe(old);
    expect(fresh.configVersion).toBe(1);
    expect(runtime.agents).toHaveLength(2);
    // The running session keeps the process it started on.
    expect(old.alive).toBe(true);

    old.release();
    fresh.release();
    await runtime.close();
  });

  it('closes a superseded process at shutdown even while its session still runs', async () => {
    let version = 0;
    const runtime = new TestRuntime(() => version);
    const events: AcpProcessEvents = { ended: () => {} };
    const old = await runtime.acquire({ A: '1' }, events);
    version = 1;
    const fresh = await runtime.acquire({ A: '1' }, events);

    // The host shuts down without waiting for sessions to release: both
    // processes must go, not just the one the map still names.
    await runtime.close();
    expect(runtime.agents).toHaveLength(2);
    expect(runtime.agents[0]!.child.killed).toContain('SIGTERM');
    expect(runtime.agents[1]!.child.killed).toContain('SIGTERM');
    expect(old.alive).toBe(false);
    expect(fresh.alive).toBe(false);
  });
});
