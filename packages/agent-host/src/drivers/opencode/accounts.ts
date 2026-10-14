/**
 * OpenCode's provider accounts, connected through its own API — so a key or
 * a sign-in takes effect on the running server, with no restart and no
 * session cut (a provider profile, by contrast, rides the server's config).
 *
 * OpenCode calls them integrations: one per provider it knows (about 230),
 * each with the ways to connect it — a key, an OAuth sign-in, a variable of
 * the environment — and the connections it has. Verified live against
 * 2.0.28:
 *
 *  - `connect.key` makes the provider's models appear at once.
 *  - A sign-in is an attempt with a link and instructions. A device sign-in
 *    (GitHub Copilot, OpenCode Console, xAI) shows a code to enter on any
 *    device, and the server polls the provider itself. Others send the
 *    browser back to a listener on the server's loopback
 *    (`redirect_uri=http://127.0.0.1:<port>/…`), which a phone cannot
 *    reach: the user pastes the address their browser failed to open, and
 *    this driver opens it on the machine — only when it is that attempt's
 *    own address, so nothing else on the machine can be reached this way.
 *  - The OAuth methods register lazily: `oauth.connect` before anything
 *    listed the integrations fails ("OAuth method not found"), so a sign-in
 *    lists them first.
 *  - Nothing reports a sign-in's progress, so it is polled here, locally.
 *  - `credential.list()` returns the secret itself; only its `active` flag
 *    is read here, and nothing of it is passed on.
 */
import type { OpenCodeClient } from '@opencode/client';
import type { AccountChangeResult, AccountManager, SignInState } from '../../sdk/driver';
import type { AccountChange, AccountConnection, AccountField, AccountMethod, AgentAccount, SignInStatus } from '../../sdk/types';

/** How often a sign-in is asked about while it waits on the user. */
const POLL_MS = 2_000;
/** Past its expiry, how long a sign-in is still asked about before it is
 *  given up as expired. */
const EXPIRY_GRACE_MS = 5_000;
/** The method id a key method is named by: OpenCode gives key methods none,
 *  and an integration has one at most. */
const KEY_METHOD = 'key';

type Integration = Awaited<ReturnType<OpenCodeClient['integration']['list']>>['data'][number];
type Method = Integration['methods'][number];
type Field = NonNullable<Extract<Method, { type: 'oauth' }>['form']>[number];
type Answer = string | number | boolean | ReadonlyArray<string>;

/** A sign-in being watched. */
interface Watched {
  integrationID: string;
  /** Where the provider sends the browser back to, for a paste-back
   *  sign-in: the only address `finish` may open. */
  callback?: { origin: string; pathname: string };
  timer: NodeJS.Timeout;
  expiresAt: number;
  ended: (end: SignInState) => void;
}

export interface OpenCodeAccountsOptions {
  log?: (message: string) => void;
  pollMs?: number;
  /** Opens a pasted sign-in address on this machine (tests pass their own). */
  open?: (url: string) => Promise<void>;
  now?: () => number;
}

export class OpenCodeAccounts implements AccountManager {
  private readonly watched = new Map<string, Watched>();
  private readonly log: (message: string) => void;
  private readonly pollMs: number;
  private readonly open: (url: string) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly client: () => Promise<OpenCodeClient>,
    options: OpenCodeAccountsOptions = {},
  ) {
    this.log = options.log ?? (() => {});
    this.pollMs = options.pollMs ?? POLL_MS;
    this.open = options.open ?? openOnLoopback;
    this.now = options.now ?? Date.now;
  }

  async list(all: boolean): Promise<AgentAccount[]> {
    const client = await this.client();
    const [integrations, credentials] = await Promise.all([
      client.integration.list().then((r) => r.data),
      client.credential.list(),
    ]);
    // Only whether each is the active one: the entries carry the secret.
    const active = new Set(credentials.filter((c) => c.active).map((c) => c.id));
    return integrations
      .map((integration) => toAccount(integration, active))
      .filter((account) => all || (account.connections?.length ?? 0) > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async change(account: string, change: AccountChange, ended: (end: SignInState) => void): Promise<AccountChangeResult> {
    const client = await this.client();
    try {
      switch (change.kind) {
        case 'key': {
          const method = await this.method(client, account, KEY_METHOD);
          await client.integration.connect.key({
            integrationID: account,
            key: change.key,
            ...answerOf(method, change.answers),
            ...(change.label ? { label: change.label } : {}),
          });
          return { accounts: await this.list(false) };
        }
        case 'activate':
          await client.credential.activate({ credentialID: change.connection });
          return { accounts: await this.list(false) };
        case 'remove':
          await client.credential.remove({ credentialID: change.connection });
          return { accounts: await this.list(false) };
        case 'sign-in':
          return { signIn: await this.signIn(client, account, change.method, change.answers ?? {}, change.label ?? undefined, ended) };
        case 'finish':
          return { signIn: await this.finish(account, change.attempt, change.callbackUrl) };
        case 'cancel':
          return { signIn: await this.cancel(client, account, change.attempt) };
      }
    } catch (err) {
      throw new Error(reason(err));
    }
  }

  /** Stop watching every sign-in (the driver is shutting down). */
  close(): void {
    for (const w of this.watched.values()) clearTimeout(w.timer);
    this.watched.clear();
  }

  private async method(client: OpenCodeClient, integrationID: string, methodID: string): Promise<Method> {
    const integration = (await client.integration.list()).data.find((i) => i.id === integrationID);
    if (!integration) throw new Error(`OpenCode knows no provider '${integrationID}'.`);
    const method = integration.methods.find((m) => methodIdOf(m) === methodID);
    if (!method) throw new Error(`${integration.name} cannot be connected that way.`);
    return method;
  }

  private async signIn(
    client: OpenCodeClient,
    integrationID: string,
    methodID: string,
    answers: Record<string, string>,
    label: string | undefined,
    ended: (end: SignInState) => void,
  ): Promise<SignInState> {
    // Listing first also registers the OAuth methods (see the header).
    const method = await this.method(client, integrationID, methodID);
    if (method.type !== 'oauth') throw new Error('That is not a sign-in.');
    const { data: attempt } = await client.integration.oauth.connect({
      integrationID,
      methodID,
      ...answerOf(method, answers),
      ...(label ? { label } : {}),
    });
    const callback = loopbackCallback(attempt.url);
    const watched: Watched = {
      integrationID,
      ...(callback ? { callback } : {}),
      timer: undefined as unknown as NodeJS.Timeout,
      expiresAt: attempt.time.expires,
      ended,
    };
    this.watched.set(attempt.attemptID, watched);
    this.watch(client, attempt.attemptID);
    return {
      status: 'started',
      attemptId: attempt.attemptID,
      attempt: {
        attemptId: attempt.attemptID,
        url: attempt.url,
        instructions: attempt.instructions,
        expiresAt: attempt.time.expires,
        ...(callback ? { pasteBack: true } : {}),
      },
    };
  }

  /** Open the address the browser was sent back to, on this machine. The
   *  sign-in's end then comes as it would for any other. */
  private async finish(integrationID: string, attemptID: string, pasted: string): Promise<SignInState> {
    const watched = this.watched.get(attemptID);
    if (!watched || watched.integrationID !== integrationID) throw new Error('That sign-in is over — start it again.');
    if (!watched.callback) throw new Error('This sign-in finishes on its own; there is nothing to paste.');
    let url: URL;
    try {
      url = new URL(pasted.trim());
    } catch {
      throw new Error('That is not an address.');
    }
    if (url.origin !== watched.callback.origin || url.pathname !== watched.callback.pathname) {
      throw new Error("That is not this sign-in's address — paste the one the browser could not open after you signed in.");
    }
    await this.open(url.toString());
    return { status: 'started', attemptId: attemptID };
  }

  private async cancel(client: OpenCodeClient, integrationID: string, attemptID: string): Promise<SignInState> {
    const watched = this.watched.get(attemptID);
    if (watched) {
      clearTimeout(watched.timer);
      this.watched.delete(attemptID);
    }
    await client.integration.oauth.cancel({ integrationID, attemptID }).catch((err: unknown) => {
      // One that already ended has nothing left to cancel.
      this.log(`[opencode] cancelling sign-in ${attemptID}: ${reason(err)}`);
    });
    return { status: 'cancelled', attemptId: attemptID };
  }

  /** Ask about a sign-in until it ends, then say so once. */
  private watch(client: OpenCodeClient, attemptID: string): void {
    const watched = this.watched.get(attemptID);
    if (!watched) return;
    watched.timer = setTimeout(() => {
      void (async () => {
        if (this.watched.get(attemptID) !== watched) return;
        let status: SignInStatus = 'started';
        let error: string | undefined;
        try {
          const { data } = await client.integration.oauth.status({ integrationID: watched.integrationID, attemptID });
          if (data.status === 'complete') status = 'complete';
          else if (data.status === 'expired') status = 'expired';
          else if (data.status === 'failed') {
            status = 'failed';
            error = 'message' in data && typeof data.message === 'string' ? data.message : undefined;
          }
        } catch (err) {
          // A transient failure is asked again; a sign-in OpenCode forgot
          // (it keeps an ended one a minute) runs out below.
          this.log(`[opencode] sign-in ${attemptID}: ${reason(err)}`);
        }
        if (status === 'started' && this.now() > watched.expiresAt + EXPIRY_GRACE_MS) status = 'expired';
        if (this.watched.get(attemptID) !== watched) return;
        if (status === 'started') {
          this.watch(client, attemptID);
          return;
        }
        this.watched.delete(attemptID);
        watched.ended({ status, attemptId: attemptID, ...(error ? { error } : {}) });
      })();
    }, this.pollMs);
    watched.timer.unref?.();
  }
}

/** One integration as a phone sees it: the ways to connect it from a phone
 *  (a key, a sign-in), and its connections without their secrets. */
export function toAccount(integration: Integration, active: ReadonlySet<string>): AgentAccount {
  const methods: AccountMethod[] = [];
  for (const m of integration.methods) {
    if (m.type !== 'key' && m.type !== 'oauth') continue;
    const fields = fieldsOf(m.form);
    // A method asking something a phone cannot answer is left out.
    if (fields === null) continue;
    methods.push({
      id: methodIdOf(m),
      kind: m.type === 'key' ? 'key' : 'sign-in',
      ...(m.label ? { label: m.label } : {}),
      ...(fields.length > 0 ? { fields } : {}),
    });
  }
  const connections: AccountConnection[] = integration.connections.map((c) =>
    c.type === 'credential'
      ? { id: c.id, label: c.label, kind: c.method === 'oauth' ? 'sign-in' : c.method, active: active.has(c.id), removable: true }
      : { id: c.name, label: c.name, kind: 'env' },
  );
  return {
    id: integration.id,
    name: integration.name,
    ...(methods.length > 0 ? { methods } : {}),
    ...(connections.length > 0 ? { connections } : {}),
  };
}

function methodIdOf(m: Method): string {
  return 'id' in m && typeof m.id === 'string' ? m.id : m.type === 'key' ? KEY_METHOD : m.type;
}

/** A method's questions, or null when one is required and cannot be asked
 *  as text (a multi-select, a file). Hidden ones keep their defaults. */
function fieldsOf(form: ReadonlyArray<Field> | undefined): AccountField[] | null {
  const out: AccountField[] = [];
  for (const f of form ?? []) {
    const field = f as Field & {
      key: string;
      title?: string;
      description?: string;
      required?: boolean;
      hidden?: boolean;
      type: string;
      options?: Array<{ value: string; label?: string; description?: string }>;
      placeholder?: string;
      default?: unknown;
      when?: Array<{ key: string; op: 'eq' | 'neq'; value: unknown }>;
    };
    if (field.hidden) continue;
    const options =
      field.type === 'boolean'
        ? [
            { id: 'true', label: 'Yes' },
            { id: 'false', label: 'No' },
          ]
        : (field.options ?? []).map((o) => ({ id: o.value, label: o.label ?? o.value, ...(o.description ? { description: o.description } : {}) }));
    if (!['string', 'number', 'integer', 'boolean'].includes(field.type)) {
      if (field.required) return null;
      continue;
    }
    out.push({
      key: field.key,
      title: field.title ?? field.key,
      ...(field.description ? { description: field.description } : {}),
      ...(field.required ? { required: true } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      ...(field.default !== undefined && field.default !== null ? { default: String(field.default) } : {}),
      ...(field.when && field.when.length > 0
        ? { when: field.when.map((w) => ({ key: w.key, value: String(w.value), ...(w.op === 'neq' ? { not: true } : {}) })) }
        : {}),
    });
  }
  return out;
}

/** The phone's text answers as the method's form types them. */
function answerOf(method: Method, answers: Record<string, string> | undefined): { answer?: Record<string, Answer> } {
  const form = ('form' in method ? method.form : undefined) as ReadonlyArray<{ key: string; type: string }> | undefined;
  const out: Record<string, Answer> = {};
  for (const [key, text] of Object.entries(answers ?? {})) {
    const type = form?.find((f) => f.key === key)?.type;
    if (type === 'boolean') out[key] = text === 'true';
    else if (type === 'number' || type === 'integer') out[key] = Number(text);
    else out[key] = text;
  }
  return Object.keys(out).length > 0 ? { answer: out } : {};
}

/** Where a sign-in's provider sends the browser back to, when that is this
 *  machine's loopback: such a sign-in is finished by pasting it back. */
export function loopbackCallback(url: string): { origin: string; pathname: string } | undefined {
  let redirect: URL;
  try {
    const raw = new URL(url).searchParams.get('redirect_uri');
    if (!raw) return undefined;
    redirect = new URL(raw);
  } catch {
    return undefined;
  }
  const host = redirect.hostname.replace(/^\[|\]$/g, '');
  if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) return undefined;
  return { origin: redirect.origin, pathname: redirect.pathname };
}

/** Open a sign-in's loopback address on this machine. Loopback never leaves
 *  the machine, so it is not traffic a proxy would carry. What it answers
 *  does not matter: the sign-in's own status says how it went. */
async function openOnLoopback(url: string): Promise<void> {
  try {
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`The machine could not open that address: ${reason(err)}`);
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
