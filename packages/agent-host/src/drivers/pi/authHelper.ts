/**
 * The helper that manages Pi's accounts with Pi's own code: a short-lived
 * Node process that loads the installed Pi's bundle and drives its
 * `ModelRuntime` — `getProviders`, `login`, `logout` — so a key or a
 * sign-in is stored exactly as Pi's `/login` stores it (`auth.json`, under
 * Pi's own lock, which a running Pi refreshing a token also takes).
 *
 * Like the extension (extension.ts), the function below is serialised and
 * written into Pi's home (installPiAuthHelper), then run with the host's own
 * `node`, so it must stay self-contained: no imports, no reference to module
 * scope. The bundle's file URL is its first argument; the state root comes
 * from `PI_CODING_AGENT_DIR` in its environment.
 *
 * It speaks JSON lines on stdio, one operation per process:
 *
 *   in  {op:"list", provider?, questions?}  out {type:"list", providers:[…], credentials:[…]}
 *   in  {op:"login", provider, method}      out {type:"notify", event} | {type:"prompt", id, prompt}
 *   in  {op:"answer", id, value}               …, then {type:"done"}
 *   in  {op:"cancel"}                       out {type:"error", message} (aborted)
 *   in  {op:"logout", provider}             out {type:"done"}
 *
 * With `questions`, each provider also carries what its logins ask
 * (`keyPaths`, `signInPaths`: see askedBy), found with this process cut off
 * from the network; `provider` limits the list to one.
 *
 * A key reaches it on stdin, never in its arguments or environment, which
 * other processes on the machine can read. Nothing it writes carries a
 * secret: a provider's status says where its key comes from, not what it is.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The installed Pi's bundle, as the helper uses it. */
interface PiBundle {
  ModelRuntime: { create(options: Record<string, unknown>): Promise<any> };
}

/** Node's own modules, as the generated module imports them. */
interface NodeModules {
  fs: typeof import('node:fs');
  os: typeof import('node:os');
  path: typeof import('node:path');
  net: typeof import('node:net');
  tls: typeof import('node:tls');
  http: typeof import('node:http');
  https: typeof import('node:https');
  childProcess: typeof import('node:child_process');
}

/**
 * The helper's body. Keep it self-contained: see the module comment. Pi's
 * bundle and Node's modules are imported by the generated module itself and
 * handed in, rather than with `import()` in here: a transform (vitest's, for
 * one) may rewrite that expression into a helper of its own, which the child
 * does not have.
 */
export async function codedeckPiAuthHelper(pi: PiBundle, node: NodeModules): Promise<void> {
  const write = (record: unknown): void => {
    process.stdout.write(JSON.stringify(record) + '\n');
  };
  const fail = (error: unknown): void => {
    write({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  };
  const waiting = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();
  const controller = new AbortController();
  let started = false;
  let nextPrompt = 0;
  let pending = '';

  /**
   * What each provider's logins ask, found by running them through Pi's own
   * `login` with nothing able to leave the machine: every way out (fetch,
   * sockets, listening, child processes) throws, the answers are
   * placeholders, and whatever a login stores lands in a scratch
   * `auth.json` deleted afterwards. A login is followed down every option of
   * each choice it offers; each path records the questions met on it and
   * how it ended — `done` (returned), `user` (it would now send the user
   * somewhere: a page, a code, a pasted address), `offline` (it would now go
   * online) or `failed`. This process ends after the listing, so nothing it
   * blocks is needed again.
   */
  const askedBy = async (providers: Array<Record<string, unknown>>): Promise<void> => {
    const scratchDir = node.fs.mkdtempSync(node.path.join(node.os.tmpdir(), 'codedeck-pi-questions-'));
    try {
      const scratch = await pi.ModelRuntime.create({
        authPath: scratchDir + '/auth.json',
        modelsPath: String(process.env.PI_CODING_AGENT_DIR || '') + '/models.json',
      });
      const offline = new Error('codedeck: offline');
      const refuse = function (): never {
        throw offline;
      };
      globalThis.fetch = refuse as never;
      node.net.connect = node.net.createConnection = refuse as never;
      node.net.Server.prototype.listen = refuse as never;
      node.tls.connect = refuse as never;
      node.http.request = node.http.get = node.https.request = node.https.get = refuse as never;
      for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        (node.childProcess as Record<string, unknown>)[name] = refuse;
      }
      // A refresh Pi started on its own before the block, or a login left
      // behind once its path ended, may now fail on its own time; one
      // provider's leftovers must not cost the whole listing.
      process.on('unhandledRejection', function () {});
      process.on('uncaughtException', function () {});

      const walk = async (provider: string, method: string, choices: string[]) => {
        const prompts: Array<Record<string, unknown>> = [];
        const controller = new AbortController();
        const handOver = new Error('codedeck: hand over');
        let picked = 0;
        let branch: string[] | undefined;
        let end: string;
        const timer = setTimeout(function () {
          controller.abort();
        }, 5_000);
        const aborted = new Promise(function (_resolve, reject) {
          controller.signal.addEventListener('abort', function () {
            reject(offline);
          });
        });
        aborted.catch(function () {});
        try {
          await Promise.race([
            scratch.login(provider, method, {
              signal: controller.signal,
              // A page or a code is where the user takes over; anything else
              // (a note, a link to read) is not.
              notify: function (event: { type?: string }) {
                if (event && (event.type === 'auth_url' || event.type === 'device_code')) throw handOver;
              },
              prompt: async function (prompt: { type: string; message: string; placeholder?: string; options?: Array<{ id: string; label: string }> }) {
                if (prompt.type === 'manual_code') throw handOver;
                const seen: Record<string, unknown> = { type: prompt.type, message: prompt.message };
                if (prompt.placeholder) seen.placeholder = prompt.placeholder;
                prompts.push(seen);
                if (prompt.type !== 'select') return 'codedeck-placeholder';
                seen.options = (prompt.options || []).map(function (option) {
                  return { id: option.id, label: option.label };
                });
                const choice = choices[picked++];
                if (choice === undefined) {
                  branch = (prompt.options || []).map(function (option) {
                    return option.id;
                  });
                  throw handOver;
                }
                seen.choice = choice;
                return choice;
              },
            }),
            aborted,
          ]);
          end = 'done';
        } catch (error) {
          end = error === handOver ? 'user' : error === offline || controller.signal.aborted ? 'offline' : 'failed';
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
        return { prompts, end, branch };
      };
      const explore = async (provider: string, method: string) => {
        const paths: Array<Record<string, unknown>> = [];
        const pending: string[][] = [[]];
        // A bound on the paths followed: Pi's logins have at most three.
        while (pending.length > 0 && paths.length < 32) {
          const choices = pending.shift()!;
          const found = await walk(provider, method, choices);
          if (found.branch) {
            for (const id of found.branch) pending.push(choices.concat([id]));
            continue;
          }
          paths.push({ prompts: found.prompts, end: found.end });
        }
        return paths;
      };
      for (const provider of providers) {
        const id = String(provider.id);
        if (provider.key !== undefined) provider.keyPaths = await explore(id, 'api_key');
        if (provider.signIn !== undefined) provider.signInPaths = await explore(id, 'oauth');
      }
    } finally {
      node.fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  };

  const run = async (command: Record<string, unknown>): Promise<void> => {
    const dir = String(process.env.PI_CODING_AGENT_DIR || '');
    const runtime = await pi.ModelRuntime.create({
      authPath: dir + '/auth.json',
      modelsPath: dir + '/models.json',
    });
    try {
      if (command.op === 'list') {
        const providers = runtime
          .getProviders()
          .filter(function (provider: { id: string }) {
            return command.provider === undefined || provider.id === command.provider;
          })
          .map(function (provider: {
            id: string;
            name: string;
            auth: { apiKey?: { name: string; login?: unknown }; oauth?: { name: string } };
          }) {
            return {
              id: provider.id,
              name: provider.name,
              ...(provider.auth.apiKey && provider.auth.apiKey.login ? { key: provider.auth.apiKey.name } : {}),
              ...(provider.auth.oauth ? { signIn: provider.auth.oauth.name } : {}),
              status: runtime.getProviderAuthStatus(provider.id),
            };
          });
        const credentials = await runtime.listCredentials();
        if (command.questions === true) await askedBy(providers);
        write({ type: 'list', providers, credentials });
        return;
      }
      if (command.op === 'logout') {
        await runtime.logout(String(command.provider));
        write({ type: 'done' });
        return;
      }
      if (command.op === 'login') {
        await runtime.login(String(command.provider), command.method === 'oauth' ? 'oauth' : 'api_key', {
          signal: controller.signal,
          notify: function (event: unknown) {
            write({ type: 'notify', event });
          },
          prompt: function (prompt: { type: string; message: string; placeholder?: string; options?: unknown }) {
            const id = 'p' + ++nextPrompt;
            write({
              type: 'prompt',
              id,
              prompt: { type: prompt.type, message: prompt.message, placeholder: prompt.placeholder, options: prompt.options },
            });
            return new Promise<string>(function (resolve, reject) {
              waiting.set(id, { resolve, reject });
            });
          },
        });
        write({ type: 'done' });
        return;
      }
      write({ type: 'error', message: 'unknown operation' });
    } finally {
      await runtime.settleCredentialWrites();
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk: string) {
    pending += chunk;
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) return;
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (!line) continue;
      let command: Record<string, unknown>;
      try {
        command = JSON.parse(line);
      } catch {
        continue;
      }
      if (command.op === 'answer') {
        const prompt = waiting.get(String(command.id));
        waiting.delete(String(command.id));
        if (prompt) prompt.resolve(String(command.value ?? ''));
        continue;
      }
      if (command.op === 'cancel') {
        controller.abort();
        for (const prompt of waiting.values()) prompt.reject(new Error('cancelled'));
        waiting.clear();
        continue;
      }
      if (started) continue;
      started = true;
      // Exit once the last line is out: a pipe may still hold it when
      // `process.exit` runs, and Pi's runtime keeps timers alive otherwise.
      const exit = function (code: number): void {
        process.stdout.write('', function () {
          process.exit(code);
        });
      };
      run(command).then(
        function () {
          exit(0);
        },
        function (error: unknown) {
          fail(error);
          exit(1);
        },
      );
    }
  });
  process.stdin.on('end', function () {
    // The driver went away: nothing is left to answer a prompt.
    controller.abort();
    if (!started) process.exit(0);
  });
}

/** The helper file's contents: one ESM module that runs the function. */
export function codedeckPiAuthHelperSource(): string {
  return (
    '// Written by CodeDeck+ — manages Pi accounts with Pi\'s own code. Regenerated\n' +
    '// whenever it changes; do not edit.\n' +
    "import * as fs from 'node:fs';\n" +
    "import * as os from 'node:os';\n" +
    "import * as path from 'node:path';\n" +
    "import net from 'node:net';\n" +
    "import tls from 'node:tls';\n" +
    "import http from 'node:http';\n" +
    "import https from 'node:https';\n" +
    "import childProcess from 'node:child_process';\n" +
    'const pi = await import(process.argv[2]);\n' +
    `const main = ${codedeckPiAuthHelper.toString()};\n` +
    'main(pi, { fs, os, path, net, tls, http, https, childProcess });\n'
  );
}

/** Where the helper lives: beside the extension, under the state root. */
export function piAuthHelperPath(home: string): string {
  return path.join(home, 'codedeck', 'codedeck-auth.mjs');
}

/** Write the helper file when its contents changed, and return its path. */
export function installPiAuthHelper(home: string): string {
  const file = piAuthHelperPath(home);
  const source = codedeckPiAuthHelperSource();
  try {
    if (fs.readFileSync(file, 'utf8') === source) return file;
  } catch {
    // Not there yet: written below.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}
