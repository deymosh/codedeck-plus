/**
 * The permission rules OpenCode saved from "always" replies.
 *
 * Answering a permission ask with `always` makes OpenCode save a rule for the
 * session's PROJECT (keyed by its directory) in its own database: the tool
 * (its `action`, e.g. `shell`) and the pattern it offered with the ask (its
 * `save` list, e.g. `echo *` for `echo hi > f`). Every later session in that
 * project runs matching calls without asking — the saved rule wins over the
 * ask-everything rule this driver states on each session — and it survives a
 * server restart. It lasts until it is removed. (Verified live against
 * OpenCode 2.0.28.)
 *
 * The rules are listed per project: `permission.saved.list` without a
 * project answers only for the server's own directory, so each project the
 * server knows is asked in turn. A project whose rules cannot be read is
 * left out (and logged) rather than failing the whole list: the others'
 * rules can still be seen and revoked.
 */
import type { OpenCodeClient } from '@opencode/client';
import type { PermissionRuleManager } from '../../sdk/driver';
import type { PermissionRule } from '../../sdk/types';

export class OpenCodePermissionRules implements PermissionRuleManager {
  /** One change at a time: a removal reads the list, then writes it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: () => Promise<OpenCodeClient>,
    private readonly log: (message: string) => void = () => {},
  ) {}

  list(): Promise<PermissionRule[]> {
    return this.serial(async () => this.rules(await this.client()));
  }

  /** Only rules OpenCode still has are removed: one already gone (revoked
   *  from another phone) is already what was asked for. */
  remove(ids: string[]): Promise<PermissionRule[]> {
    return this.serial(async () => {
      const client = await this.client();
      const present = new Set((await this.rules(client)).map((rule) => rule.id));
      for (const id of ids) {
        if (!present.has(id)) continue;
        try {
          await client.permission.saved.remove({ id });
        } catch (err) {
          throw new Error(`OpenCode could not remove the rule: ${reason(err)}`);
        }
      }
      return this.rules(client);
    });
  }

  /** Every project's rules, a project's newest first, projects by path. */
  private async rules(client: OpenCodeClient): Promise<PermissionRule[]> {
    let projects: Awaited<ReturnType<OpenCodeClient['project']['list']>>;
    try {
      projects = await client.project.list();
    } catch (err) {
      throw new Error(`OpenCode could not list its projects: ${reason(err)}`);
    }
    const perProject = await Promise.all(
      projects.map(async (project) => {
        try {
          const saved = await client.permission.saved.list({ projectID: project.id });
          return saved.map(
            (rule): PermissionRule => ({
              id: rule.id,
              project: project.canonical,
              tool: rule.action,
              pattern: rule.resource,
              createdAt: rule.time.created,
            }),
          );
        } catch (err) {
          this.log(`[opencode] could not read the saved permission rules of ${project.canonical}: ${reason(err)}`);
          return [];
        }
      }),
    );
    return perProject
      .flat()
      .sort((a, b) => a.project.localeCompare(b.project) || b.createdAt - a.createdAt);
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
