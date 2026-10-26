/**
 * The ACP process pool: which process an environment's sessions share, and
 * when a change to the configuration a process loads needs a new one.
 */
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

  constructor(version: () => number) {
    const agents: FakeAgent[] = [];
    super({
      log: () => {},
      tag: 'test',
      label: 'Test agent',
      configVersion: version,
      idleCloseMs: 0,
      spawnFn: (() => {
        const agent = new FakeAgent();
        agents.push(agent);
        return agent.child;
      }) as unknown as SpawnFn,
    });
    this.agents = agents;
  }

  entryPoint(): Promise<string> {
    return Promise.resolve('/fake/agent');
  }

  protected spec(_entry: string, env: Record<string, string>): AcpProcessSpec<undefined> {
    return { command: process.execPath, args: [], env, handle: undefined };
  }
}

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
});
