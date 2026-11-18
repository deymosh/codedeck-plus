/**
 * Pi's provider accounts — an API key or a subscription sign-in per
 * provider — managed with Pi's own code (authHelper.ts), so they land where
 * `/login` puts them (`auth.json` in Pi's home) and every Pi started after
 * the change can use them, inside CodeDeck or in a terminal on that home.
 *
 * What Pi offers is read from the installed Pi, never from a table here:
 * its providers, the key and sign-in methods each has (verified against
 * 1.5.2: 43 providers, nine of them with a subscription sign-in), and where
 * each one's access comes from now (stored, or the machine's environment).
 *
 * A key is Pi's own key login with its one `secret` prompt answered. A
 * sign-in is Pi's OAuth login, which tells the user where to go — a page to
 * open (`auth_url`) or a code to enter on any device (`device_code`) — and,
 * for a page, asks for the address the browser lands on (`manual_code`),
 * since the provider sends it back to a listener on this machine a phone
 * cannot reach.
 *
 * Pi asks a login's other questions as it goes (Cloudflare's account ID, how
 * to sign in to Anthropic, a GitHub Enterprise domain), while a phone needs
 * them on the form before it starts. So the listing finds them by running
 * each login cut off from the network (authHelper's askedBy), offers them as
 * the method's fields keyed by Pi's own question, and a login answers Pi's
 * prompts from the phone's answers (questionsOf, answersFor). A question the
 * listing did not find is refused with Pi's own words: only Pi's
 * interactive `/login` can hold that conversation.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import type { AccountChangeResult, AccountManager, SignInState } from '../../sdk/driver';
import { redactSecrets } from '../../sdk/redact';
import type { AccountChange, AccountConnection, AccountField, AccountMethod, AgentAccount } from '../../sdk/types';
import { installPiAuthHelper } from './authHelper';
import { PiLineDecoder, type PiRecord, type PiSpawn } from './rpc';

/** The method ids an account offers, one of each kind at most. */
export const PI_KEY_METHOD = 'key';
export const PI_SIGN_IN_METHOD = 'sign-in';

/** How long a sign-in that names no lifetime of its own waits for the user. */
const SIGN_IN_LIFETIME_MS = 10 * 60_000;
/** How long one list, key or removal may take: a local process that loads
 *  Pi's bundle and reads one file. */
const OPERATION_TIMEOUT_MS = 60_000;

/** A provider as the helper lists it. */
interface HelperProvider {
  id: string;
  name: string;
  /** The key method's name ("Anthropic API key"), when a key can be entered. */
  key?: string;
  /** The sign-in's name ("Anthropic (Claude Pro/Max)"), when there is one. */
  signIn?: string;
  status?: { configured?: boolean; source?: string; label?: string };
  /** What the key login asks, when the listing looked (authHelper's askedBy). */
  keyPaths?: LoginPath[];
  /** What the sign-in asks, likewise. */
  signInPaths?: LoginPath[];
}

/** One way through a login: the questions met, and how it ended. */
interface LoginPath {
  prompts: Array<{ type: string; message: string; placeholder?: string; options?: Array<{ id: string; label: string }>; choice?: string }>;
  /** `done`, `user` (handed to the user), `offline` (would go online), `failed`. */
  end: string;
}

/** What a login asks the phone, and the choices it makes itself. */
export interface LoginQuestions {
  /** Keyed by Pi's own question, which is what its prompt says. */
  fields: AccountField[];
  /** A choice with one way that works from a phone: answered without asking. */
  auto: Record<string, string>;
}

/** One helper process: an operation sent, its records read back. */
class HelperRun {
  private readonly child: ChildProcess;
  readonly finished: Promise<void>;
  private exited = false;

  constructor(
    command: { command: string; args: string[]; cwd: string; env: Record<string, string> },
    spawnFn: PiSpawn,
    onRecord: (record: PiRecord) => void,
  ) {
    this.child = spawnFn(command.command, command.args, { cwd: command.cwd, env: command.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = new PiLineDecoder(onRecord, () => {});
    let stderr = '';
    this.child.stdout?.on('data', (chunk: Buffer) => lines.push(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });
    this.child.stdin?.on('error', () => {});
    this.finished = new Promise<void>((resolve, reject) => {
      this.child.on('error', (error: Error) => {
        this.exited = true;
        reject(error);
      });
      this.child.on('close', (code) => {
        this.exited = true;
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').pop() || `the Pi account helper exited (${code ?? 'killed'})`));
      });
    });
    this.finished.catch(() => {});
  }

  send(record: Record<string, unknown>): void {
    if (this.exited) return;
    this.child.stdin?.write(`${JSON.stringify(record)}\n`);
  }

  kill(): void {
    if (this.exited) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** A sign-in waiting on the user. */
interface Attempt {
  account: string;
  run: HelperRun;
  /** The `manual_code` prompt Pi is waiting on, when it asked. */
  pastePrompt?: string;
  /** An address pasted before Pi asked for it. */
  pasted?: string;
  timer: NodeJS.Timeout;
  ended: (end: SignInState) => void;
}

export interface PiAccountsOptions {
  /** Pi's state root (`PI_CODING_AGENT_DIR`). */
  home: string;
  /** The CLI entry point (`dist/bundle/cli.js`); the bundle's `index.js`
   *  beside it is what the helper loads. */
  entryPoint: () => Promise<string>;
  /** The helper's environment (secret-free apart from what the machine's
   *  own environment holds, which is how environment keys are seen). */
  env: () => Record<string, string>;
  /** Called after a change, so the model list is read again. */
  changed: () => void;
  spawnFn?: PiSpawn;
  now?: () => number;
}

export class PiAccounts implements AccountManager {
  private readonly attempts = new Map<string, Attempt>();
  /** What each helper said went wrong, read once it exits. */
  private readonly errors = new WeakMap<HelperRun, () => string | undefined>();
  private readonly spawnFn: PiSpawn;
  private readonly now: () => number;

  constructor(private readonly options: PiAccountsOptions) {
    this.spawnFn = options.spawnFn ?? ((command, args, opts) => spawn(command, args, opts));
    this.now = options.now ?? Date.now;
  }

  async list(all: boolean): Promise<AgentAccount[]> {
    // Every provider is for connecting one, so it comes with its questions.
    const listed = await this.listing(all ? { questions: true } : {});
    const providers = Array.isArray(listed?.providers) ? (listed.providers as HelperProvider[]) : [];
    const stored = new Map<string, string>();
    for (const raw of Array.isArray(listed?.credentials) ? listed.credentials : []) {
      const credential = raw as { providerId?: unknown; type?: unknown };
      if (typeof credential.providerId === 'string' && typeof credential.type === 'string') {
        stored.set(credential.providerId, credential.type);
      }
    }
    return providers
      .map((provider) => toAccount(provider, stored.get(provider.id)))
      .filter((account) => all || (account.connections?.length ?? 0) > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async change(account: string, change: AccountChange, ended: (end: SignInState) => void): Promise<AccountChangeResult> {
    try {
      switch (change.kind) {
        case 'key':
          await this.storeKey(account, change.key, await this.answers(account, 'key', change.answers));
          this.options.changed();
          return { accounts: await this.list(false) };
        case 'remove':
          if (change.connection !== account) {
            throw new Error("That access comes from the machine's own environment or Pi's configuration; only the machine can change it.");
          }
          await this.once({ op: 'logout', provider: account });
          this.options.changed();
          return { accounts: await this.list(false) };
        case 'activate':
          // Pi keeps one stored access per provider: it is the active one.
          return { accounts: await this.list(false) };
        case 'sign-in':
          return { signIn: await this.signIn(account, await this.answers(account, 'sign-in', change.answers), ended) };
        case 'finish':
          return { signIn: this.finish(account, change.attempt, change.callbackUrl) };
        case 'cancel':
          return { signIn: this.cancel(change.attempt) };
      }
    } catch (error) {
      // Pi's refusal may quote what it was given; a pasted address carries a
      // one-time code. Neither travels back in the error.
      const secrets = change.kind === 'key' ? [change.key] : change.kind === 'finish' ? [change.callbackUrl] : [];
      throw new Error(redactSecrets(reason(error), secrets));
    }
  }

  /** Stop every sign-in still waiting (the driver is shutting down). */
  close(): void {
    for (const attempt of this.attempts.values()) {
      clearTimeout(attempt.timer);
      attempt.run.kill();
    }
    this.attempts.clear();
  }

  /** Pi's listing, read from one helper run. */
  private async listing(request: { provider?: string; questions?: boolean }): Promise<PiRecord | undefined> {
    let listed: PiRecord | undefined;
    await this.once({ op: 'list', ...request }, (record) => {
      if (record.type === 'list') listed = record;
    });
    return listed;
  }

  /**
   * What to tell Pi when its login for `account` asks: the questions it asks
   * that way, read again from the installed Pi, answered from the phone's
   * answers (or their defaults) and Pi's one workable choice.
   */
  private async answers(account: string, kind: 'key' | 'sign-in', given: Record<string, string> | undefined): Promise<Map<string, string>> {
    const listed = await this.listing({ provider: account, questions: true });
    const provider = (Array.isArray(listed?.providers) ? (listed.providers as HelperProvider[]) : []).find((p) => p.id === account);
    if (!provider) throw new Error(`Pi has no provider "${account}".`);
    const questions = questionsOf(kind, kind === 'key' ? provider.keyPaths : provider.signInPaths);
    if (!questions) {
      throw new Error(
        kind === 'key'
          ? `Pi's key login for ${provider.name} needs more than a phone can give; run Pi's own /login on the machine.`
          : `Pi's sign-in for ${provider.name} cannot be finished from a phone; run Pi's own /login on the machine.`,
      );
    }
    return answersFor(questions, given ?? {});
  }

  private async storeKey(account: string, key: string, answers: Map<string, string>): Promise<void> {
    let refused: string | undefined;
    let answered = false;
    const given = new Set<string>();
    const run = await this.start({ op: 'login', provider: account, method: 'api_key' }, (record) => {
      if (record.type !== 'prompt') return;
      const prompt = record.prompt as { type?: string; message?: string } | undefined;
      if (prompt?.type === 'secret' && !answered) {
        answered = true;
        run.send({ op: 'answer', id: record.id, value: key });
        return;
      }
      const answer = answerOnce(answers, given, prompt);
      if (answer !== undefined) {
        run.send({ op: 'answer', id: record.id, value: answer });
        return;
      }
      refused = prompt?.message ?? 'a question';
      run.send({ op: 'cancel' });
    }, OPERATION_TIMEOUT_MS);
    const failure = await this.outcome(run);
    if (refused !== undefined) {
      throw new Error(`Pi also asks "${refused}" for this provider, which only Pi's own /login can answer.`);
    }
    if (failure !== undefined) throw new Error(failure);
  }

  private async signIn(account: string, answers: Map<string, string>, ended: (end: SignInState) => void): Promise<SignInState> {
    const attemptId = randomUUID();
    let begun = false;
    const given = new Set<string>();
    let settle!: { resolve(state: SignInState): void; reject(error: Error): void };
    const first = new Promise<SignInState>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const run: HelperRun = await this.start({ op: 'login', provider: account, method: 'oauth' }, (record) => {
      if (record.type === 'notify' && !begun) {
        const started = startedAttempt(attemptId, record.event, this.now());
        if (!started) return;
        begun = true;
        const timer = setTimeout(() => this.end(attemptId, { status: 'expired', attemptId }), started.expiresAt - this.now());
        timer.unref?.();
        this.attempts.set(attemptId, { account, run, timer, ended });
        settle.resolve({ status: 'started', attemptId, attempt: started });
        return;
      }
      if (record.type !== 'prompt') return;
      const prompt = record.prompt as { type?: string; message?: string } | undefined;
      const id = String(record.id);
      const attempt = this.attempts.get(attemptId);
      if (prompt?.type === 'manual_code' && attempt) {
        if (attempt.pasted !== undefined) {
          run.send({ op: 'answer', id, value: attempt.pasted });
          attempt.pasted = undefined;
        } else {
          attempt.pastePrompt = id;
        }
        return;
      }
      const answer = answerOnce(answers, given, prompt);
      if (answer !== undefined) {
        run.send({ op: 'answer', id, value: answer });
        return;
      }
      // A choice or a field this flow cannot put to the phone.
      run.send({ op: 'cancel' });
      const why = `Pi asks "${prompt?.message ?? 'a question'}" for this sign-in, which only Pi's own /login can answer.`;
      if (begun) this.end(attemptId, { status: 'failed', attemptId, error: why });
      else settle.reject(new Error(why));
    });
    void this.outcome(run).then((failure) => {
      if (failure === undefined) this.options.changed();
      if (!begun) {
        // Over before it asked the user anything: a provider that needed
        // nothing more, or a failure to start.
        if (failure === undefined) settle.resolve({ status: 'complete', attemptId });
        else settle.reject(new Error(failure));
        return;
      }
      this.end(attemptId, failure === undefined ? { status: 'complete', attemptId } : { status: 'failed', attemptId, error: failure });
    });
    return first;
  }

  private finish(account: string, attemptId: string, pasted: string): SignInState {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.account !== account) throw new Error('That sign-in is over — start it again.');
    const value = pasted.trim();
    if (value === '') throw new Error('Paste the address the browser landed on.');
    if (attempt.pastePrompt !== undefined) {
      attempt.run.send({ op: 'answer', id: attempt.pastePrompt, value });
      attempt.pastePrompt = undefined;
    } else {
      attempt.pasted = value;
    }
    return { status: 'started', attemptId };
  }

  private cancel(attemptId: string): SignInState {
    const attempt = this.attempts.get(attemptId);
    if (attempt) {
      // Forgotten first, so its end is not reported a second time.
      this.attempts.delete(attemptId);
      clearTimeout(attempt.timer);
      attempt.run.send({ op: 'cancel' });
      attempt.run.kill();
    }
    return { status: 'cancelled', attemptId };
  }

  /** Report a sign-in's end once, and stop its helper. */
  private end(attemptId: string, state: SignInState): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return;
    this.attempts.delete(attemptId);
    clearTimeout(attempt.timer);
    attempt.run.kill();
    attempt.ended(state);
  }

  /** Run one operation to its end; rejects with the helper's reason. */
  private async once(record: Record<string, unknown>, onRecord: (record: PiRecord) => void = () => {}): Promise<void> {
    const run = await this.start(record, onRecord, OPERATION_TIMEOUT_MS);
    const failure = await this.outcome(run);
    if (failure !== undefined) throw new Error(failure);
  }

  /** Start one helper on `record`. A one-shot operation is given a time
   *  limit; a sign-in waits on the user, and its own expiry ends it. */
  private async start(record: Record<string, unknown>, onRecord: (record: PiRecord) => void, timeoutMs?: number): Promise<HelperRun> {
    const entry = await this.options.entryPoint();
    if (!/\.[cm]?js$/i.test(entry)) {
      throw new Error("Accounts need Pi's own package; CODEDECK_PI_PATH names an executable instead.");
    }
    const bundle = path.join(path.dirname(entry), 'index.js');
    const helper = installPiAuthHelper(this.options.home);
    let errorText: string | undefined;
    const run = new HelperRun(
      { command: process.execPath, args: [helper, pathToFileURL(bundle).href], cwd: this.options.home, env: this.options.env() },
      this.spawnFn,
      (line) => {
        if (line.type === 'error') errorText = typeof line.message === 'string' ? line.message : 'Pi refused the change';
        onRecord(line);
      },
    );
    this.errors.set(run, () => errorText);
    if (timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        errorText ??= `Pi did not finish within ${Math.round(timeoutMs / 1000)}s`;
        run.kill();
      }, timeoutMs);
      timer.unref?.();
      void run.finished.finally(() => clearTimeout(timer)).catch(() => {});
    }
    run.send(record);
    return run;
  }

  /** Undefined when the operation finished, else why it did not. */
  private async outcome(run: HelperRun): Promise<string | undefined> {
    try {
      await run.finished;
      return this.errors.get(run)?.();
    } catch (error) {
      // Not logged: the helper's stderr may quote the key it was given, and
      // only the caller knows the secrets to redact before anything leaves.
      return this.errors.get(run)?.() ?? reason(error);
    }
  }
}

/** One provider as a phone sees it: the ways to connect it, and where its
 *  access comes from now — never the secret itself. */
export function toAccount(provider: HelperProvider, storedType: string | undefined): AgentAccount {
  const methods: AccountMethod[] = [];
  const method = (id: string, kind: 'key' | 'sign-in', label: string, paths: LoginPath[] | undefined): void => {
    // A way Pi offers that cannot work from a phone is not offered there.
    const questions = questionsOf(kind, paths);
    if (!questions) return;
    methods.push({ id, kind, label, ...(questions.fields.length > 0 ? { fields: questions.fields } : {}) });
  };
  if (provider.key) method(PI_KEY_METHOD, 'key', provider.key, provider.keyPaths);
  if (provider.signIn) method(PI_SIGN_IN_METHOD, 'sign-in', provider.signIn, provider.signInPaths);
  const connections: AccountConnection[] = [];
  const status = provider.status;
  if (status?.configured) {
    if (status.source === 'stored') {
      const signedIn = storedType === 'oauth';
      connections.push({
        id: provider.id,
        label: signedIn ? (provider.signIn ?? 'Signed in') : (provider.key ?? 'API key'),
        kind: signedIn ? 'sign-in' : 'key',
        active: true,
        removable: true,
      });
    } else {
      // The environment, `models.json` or a key command: the machine's own
      // setup, which only the machine can change.
      connections.push({ id: `${status.source ?? 'config'}:${provider.id}`, label: status.label ?? describeSource(status.source), kind: 'env' });
    }
  }
  return {
    id: provider.id,
    name: provider.name,
    ...(methods.length > 0 ? { methods } : {}),
    ...(connections.length > 0 ? { connections } : {}),
  };
}

/**
 * The questions a login asks, from the ways through it the listing found;
 * null when no way works from a phone. A key login works when it asks for
 * exactly one secret — the key the phone sends — and finishes without
 * sending the user anywhere; a sign-in works when it asks no secret and
 * ends by sending the user to a page or a code (or going online to get
 * one). A choice is asked only among the options that lead somewhere that
 * works, and not at all when only one does; a question that follows a
 * choice is asked only when that choice is made. Unknown paths (the listing
 * did not look) ask nothing.
 */
export function questionsOf(kind: 'key' | 'sign-in', paths: LoginPath[] | undefined): LoginQuestions | null {
  if (paths === undefined) return { fields: [], auto: {} };
  const works = (path: LoginPath): boolean => {
    const secrets = path.prompts.filter((p) => p.type === 'secret').length;
    if (path.prompts.some((p) => p.type !== 'secret' && p.type !== 'text' && p.type !== 'select')) return false;
    return kind === 'key'
      ? secrets === 1 && (path.end === 'done' || path.end === 'offline')
      : secrets === 0 && (path.end === 'user' || path.end === 'offline');
  };
  const kept = paths.filter(works);
  if (kept.length === 0) return null;

  // Each choice's options that lead to a working path.
  const options = new Map<string, Set<string>>();
  for (const path of kept) {
    for (const p of path.prompts) {
      if (p.type === 'select' && p.choice !== undefined) {
        options.set(p.message, (options.get(p.message) ?? new Set()).add(p.choice));
      }
    }
  }
  const auto: Record<string, string> = {};
  for (const [message, ids] of options) if (ids.size === 1) auto[message] = [...ids][0]!;

  // The choices a path made that the phone is asked for, up to a point.
  const choicesBefore = (path: LoginPath, index: number): Array<{ key: string; value: string }> =>
    path.prompts
      .slice(0, index)
      .filter((p) => p.type === 'select' && p.choice !== undefined && auto[p.message] === undefined)
      .map((p) => ({ key: p.message, value: p.choice! }));
  const holds = (path: LoginPath, when: Array<{ key: string; value: string }>): boolean =>
    when.every((c) => path.prompts.some((p) => p.type === 'select' && p.message === c.key && p.choice === c.value));

  const fields: AccountField[] = [];
  const seen = new Set<string>();
  for (const path of kept) {
    for (const p of path.prompts) {
      if (p.type === 'secret' || auto[p.message] !== undefined || seen.has(p.message)) continue;
      seen.add(p.message);
      const asking = kept.filter((k) => k.prompts.some((q) => q.message === p.message));
      // What every path that asks it chose first: the condition to ask it on.
      let when = choicesBefore(asking[0]!, asking[0]!.prompts.findIndex((q) => q.message === p.message));
      for (const other of asking.slice(1)) {
        const before = choicesBefore(other, other.prompts.findIndex((q) => q.message === p.message));
        when = when.filter((c) => before.some((b) => b.key === c.key && b.value === c.value));
      }
      // The phone shows a question when all its conditions hold; a question
      // asked on some other mix of choices cannot be put that way.
      if (kept.some((k) => holds(k, when) !== asking.includes(k))) return null;
      const field: AccountField = { key: p.message, title: titleOf(p.message) };
      if (p.type === 'select') {
        const ids = options.get(p.message)!;
        field.options = (p.options ?? []).filter((o) => ids.has(o.id)).map((o) => ({ id: o.id, label: o.label }));
        field.required = true;
        field.default = field.options[0]?.id ?? null;
      } else {
        // Pi stores a key login's answers as they are, and checks a
        // sign-in's with the provider, which says what a blank one means
        // (GitHub's: github.com).
        if (kind === 'key') field.required = true;
        if (p.placeholder) field.placeholder = p.placeholder;
      }
      if (when.length > 0) field.when = when;
      fields.push(field);
    }
  }
  return { fields, auto };
}

/** Pi's answers for a login: its own choices, and the phone's answers to the
 *  questions asked on them. Throws on a missing or impossible answer. */
export function answersFor(questions: LoginQuestions, given: Record<string, string>): Map<string, string> {
  const answers = new Map(Object.entries(questions.auto));
  const effective = (field: AccountField): string => (given[field.key] ?? field.default ?? '').trim();
  const values = new Map(questions.fields.map((f) => [f.key, effective(f)]));
  for (const field of questions.fields) {
    const asked = (field.when ?? []).every((c) => ((values.get(c.key) ?? '') === c.value) !== (c.not ?? false));
    if (!asked) continue;
    const value = values.get(field.key) ?? '';
    if (field.options && field.options.length > 0 && !field.options.some((o) => o.id === value)) {
      throw new Error(`Choose one of the ${field.title} options.`);
    }
    if (field.required && value === '') throw new Error(`${field.title} is needed.`);
    answers.set(field.key, value);
  }
  return answers;
}

/** The answer to a prompt Pi asks, once: a login that asks the same question
 *  again did not take the answer, and gets no second one. */
function answerOnce(answers: Map<string, string>, given: Set<string>, prompt: { type?: string; message?: string } | undefined): string | undefined {
  const message = prompt?.message;
  if (message === undefined || prompt?.type === 'secret' || given.has(message)) return undefined;
  const answer = answers.get(message);
  if (answer !== undefined) given.add(message);
  return answer;
}

/** A question as a field's title: "Enter Cloudflare account ID" → "Cloudflare account ID". */
function titleOf(message: string): string {
  const bare = message.replace(/^(enter|select)\s+/i, '').replace(/:\s*$/, '').trim();
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function describeSource(source: string | undefined): string {
  switch (source) {
    case 'environment':
      return 'An environment variable';
    case 'models_json_key':
    case 'models_json_command':
      return "Pi's models.json";
    default:
      return "Pi's own configuration";
  }
}

/** The attempt a sign-in's first event describes, or null for an event that
 *  says nothing the user must act on (progress, information). */
export function startedAttempt(
  attemptId: string,
  event: unknown,
  now: number,
): { attemptId: string; url: string; instructions: string; expiresAt: number; pasteBack?: boolean } | null {
  const e = event as { type?: string; url?: string; instructions?: string; userCode?: string; verificationUri?: string; expiresInSeconds?: number };
  if (e?.type === 'auth_url' && typeof e.url === 'string') {
    return {
      attemptId,
      url: e.url,
      instructions:
        e.instructions ??
        'Sign in in the browser. When it then fails to open a page, paste that page\'s address here.',
      expiresAt: now + SIGN_IN_LIFETIME_MS,
      pasteBack: true,
    };
  }
  if (e?.type === 'device_code' && typeof e.verificationUri === 'string' && typeof e.userCode === 'string') {
    const lifetime = typeof e.expiresInSeconds === 'number' && e.expiresInSeconds > 0 ? e.expiresInSeconds * 1000 : SIGN_IN_LIFETIME_MS;
    return { attemptId, url: e.verificationUri, instructions: `Enter the code ${e.userCode}`, expiresAt: now + lifetime };
  }
  return null;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
