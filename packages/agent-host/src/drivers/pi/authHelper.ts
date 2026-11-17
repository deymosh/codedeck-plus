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
 *   in  {op:"list"}                         out {type:"list", providers:[…], credentials:[…]}
 *   in  {op:"login", provider, method}      out {type:"notify", event} | {type:"prompt", id, prompt}
 *   in  {op:"answer", id, value}               …, then {type:"done"}
 *   in  {op:"cancel"}                       out {type:"error", message} (aborted)
 *   in  {op:"logout", provider}             out {type:"done"}
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

/**
 * The helper's body. Keep it self-contained: see the module comment. Pi's
 * bundle is imported by the generated module itself and handed in, rather
 * than with `import()` in here: a transform (vitest's, for one) may rewrite
 * that expression into a helper of its own, which the child does not have.
 */
export async function codedeckPiAuthHelper(pi: PiBundle): Promise<void> {
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

  const run = async (command: Record<string, unknown>): Promise<void> => {
    const dir = String(process.env.PI_CODING_AGENT_DIR || '');
    const runtime = await pi.ModelRuntime.create({
      authPath: dir + '/auth.json',
      modelsPath: dir + '/models.json',
    });
    try {
      if (command.op === 'list') {
        const providers = runtime.getProviders().map(function (provider: {
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
    'const pi = await import(process.argv[2]);\n' +
    `const main = ${codedeckPiAuthHelper.toString()};\n` +
    'main(pi);\n'
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
