/**
 * OpenCode's saved permission rules: listed project by project (an
 * unscoped list answers only for the server's own directory), and removed
 * by id — only the ones OpenCode still has.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OpenCodeClient } from '@opencode/client';
import { OpenCodePermissionRules } from '../permissionRules';

interface Saved {
  id: string;
  projectID: string;
  action: string;
  resource: string;
  time: { created: number; updated: number };
}

function clientWith(saved: Saved[], projects = [{ id: 'p1', canonical: '/w/app' }, { id: 'p2', canonical: '/w/api' }]) {
  const store = [...saved];
  const client = {
    project: { list: vi.fn(async () => projects) },
    permission: {
      saved: {
        list: vi.fn(async (input?: { projectID?: string }) => store.filter((s) => s.projectID === input?.projectID)),
        remove: vi.fn(async ({ id }: { id: string }) => {
          const at = store.findIndex((s) => s.id === id);
          if (at >= 0) store.splice(at, 1);
        }),
      },
    },
  };
  return client;
}

const rule = (id: string, projectID: string, created: number, resource = 'git status *'): Saved => ({
  id,
  projectID,
  action: 'shell',
  resource,
  time: { created, updated: created },
});

describe('OpenCode saved permission rules', () => {
  it("lists every project's rules, each project's newest first", async () => {
    const client = clientWith([rule('a', 'p1', 1), rule('b', 'p1', 2), rule('c', 'p2', 3, 'src/**')]);
    const rules = await new OpenCodePermissionRules(async () => client as unknown as OpenCodeClient).list();
    expect(rules).toEqual([
      { id: 'c', project: '/w/api', tool: 'shell', pattern: 'src/**', createdAt: 3 },
      { id: 'b', project: '/w/app', tool: 'shell', pattern: 'git status *', createdAt: 2 },
      { id: 'a', project: '/w/app', tool: 'shell', pattern: 'git status *', createdAt: 1 },
    ]);
    // Asked per project, never unscoped.
    expect(client.permission.saved.list.mock.calls.map(([input]) => input)).toEqual([{ projectID: 'p1' }, { projectID: 'p2' }]);
  });

  it("leaves out a project whose rules cannot be read, and lists the others'", async () => {
    const client = clientWith([rule('a', 'p1', 1), rule('c', 'p2', 3)]);
    client.permission.saved.list.mockImplementationOnce(async () => {
      throw new Error('database is locked');
    });
    const logs: string[] = [];
    const rules = await new OpenCodePermissionRules(async () => client as unknown as OpenCodeClient, (m) => logs.push(m)).list();
    expect(rules.map((r) => r.id)).toEqual(['c']);
    expect(logs[0]).toMatch(/\/w\/app: database is locked/);
  });

  it('removes the rules it still has and answers the list after', async () => {
    const client = clientWith([rule('a', 'p1', 1), rule('b', 'p2', 2)]);
    const rules = await new OpenCodePermissionRules(async () => client as unknown as OpenCodeClient).remove(['a', 'gone']);
    expect(rules.map((r) => r.id)).toEqual(['b']);
    expect(client.permission.saved.remove).toHaveBeenCalledTimes(1);
    expect(client.permission.saved.remove).toHaveBeenCalledWith({ id: 'a' });
  });

  it("says why when OpenCode refuses, in its own words", async () => {
    const client = clientWith([rule('a', 'p1', 1)]);
    client.permission.saved.remove.mockRejectedValueOnce(new Error('database is locked'));
    const rules = new OpenCodePermissionRules(async () => client as unknown as OpenCodeClient);
    await expect(rules.remove(['a'])).rejects.toThrow(/could not remove the rule: database is locked/);
    // A failure does not wedge the next request.
    expect((await rules.list()).map((r) => r.id)).toEqual(['a']);
  });
});
