/**
 * A language server for the CodeDeck Pi extension's diagnostics tests, run
 * as its own process: `node fakeLanguageServer.mjs <mode>`.
 *
 * Each mode does only what the real server was seen doing, run by hand
 * against it (2026-11-18, the frames logged around didOpen/didChange/didSave):
 *
 * - `push`: typescript-language-server 6.1.0 with TypeScript 5.9 — no pull;
 *   a `$/progress` begin/end around its first project load; then one
 *   `publishDiagnostics` per change, WITHOUT a version and with the URI in VS
 *   Code's spelling (`file:///c%3A/…` for `file:///C:/…`).
 * - `push-versioned`: Pyright / basedpyright 1.40 — no pull advertised; a
 *   progress (created with `window/workDoneProgress/create`) around each
 *   analysis, then a push WITH the version; `workspace/configuration`
 *   requests, numbered from 0.
 * - `pull`: TypeScript 7.0's `tsc --lsp` — `diagnosticProvider`, answers
 *   `textDocument/diagnostic` at once, never pushes.
 * - `ra`: rust-analyzer 1.99 — answers a pull, but with an empty list while
 *   its workspace loads under progress; after a save, `cargo check` runs
 *   under the `rust-analyzer/flycheck/0` progress, its results arrive as a
 *   versioned push (worded differently, same code), and then it sends
 *   `workspace/diagnostic/refresh` with no params.
 * - `crash`: rustup's `rust-analyzer` proxy with the component not installed
 *   — prints an error and exits 1.
 * - `silent`: a server that never reports, for the deadline.
 *
 * And faults no real server was seen making, for the client's own guards:
 * `null-frame` sends a frame whose body is `null` before each answer;
 * `mute` never answers `initialize`; `slow-first` is `push-versioned` with
 * no progress and slow pushes: the first after 600 ms, the rest after
 * 1000 ms.
 *
 * Diagnostics come from the document's text: a line holding `ERROR <msg>` is
 * an error at that word, `WARN` a warning, `HINT` a hint, and `ENV <NAME>`
 * an error saying whether NAME is in this process's environment.
 */
const mode = process.argv[2] ?? 'push';
if (mode === 'crash') {
  process.stderr.write("error: Unknown binary 'rust-analyzer' in official toolchain\n");
  process.exit(1);
}

let buffer = Buffer.alloc(0);
let nextId = 0;
let loaded = mode !== 'ra';
let firstLoad = true;
let pushes = 0;
// `null-frame` is `pull` with its fault.
const pulls = mode === 'pull' || mode === 'null-frame';
const docs = new Map();

function send(message) {
  if (mode === 'null-frame') process.stdout.write('Content-Length: 4\r\n\r\nnull');
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
const progress = (token, kind, title) => send({ method: '$/progress', params: { token, value: kind === 'begin' ? { kind, title } : { kind } } });
const later = (ms, fn) => setTimeout(fn, ms);

/** VS Code's spelling of a file URI: lower-case drive, colon encoded. */
function vscodeUri(uri) {
  return uri.replace(/^file:\/\/\/([A-Za-z]):/, (_, drive) => `file:///${drive.toLowerCase()}%3A`);
}

function diagnosticsOf(text, source) {
  const out = [];
  text.split('\n').forEach((line, index) => {
    const match = /\b(ERROR|WARN|HINT|ENV)\s+(\S.*)$/.exec(line);
    if (!match) return;
    const severity = { ERROR: 1, WARN: 2, HINT: 4, ENV: 1 }[match[1]];
    const message = match[1] === 'ENV' ? `${match[2]} is ${process.env[match[2]] === undefined ? 'unset' : 'set'}` : match[2];
    out.push({
      range: { start: { line: index, character: match.index }, end: { line: index, character: line.length } },
      severity,
      message,
      source,
      code: 'E1',
    });
  });
  return out;
}

function changed(uri) {
  const doc = docs.get(uri);
  if (mode === 'push') {
    const token = 'tls-load';
    if (firstLoad) {
      firstLoad = false;
      progress(token, 'begin', 'Initializing JS/TS language features…');
      later(80, () => progress(token, 'end'));
    }
    later(120, () => send({ method: 'textDocument/publishDiagnostics', params: { uri: vscodeUri(uri), diagnostics: diagnosticsOf(doc.text, 'typescript') } }));
  } else if (mode === 'push-versioned' || mode === 'slow-first') {
    const token = `pyright-${++nextId}`;
    const reportsProgress = mode !== 'slow-first';
    if (reportsProgress) {
      send({ id: nextId, method: 'window/workDoneProgress/create', params: { token } });
      progress(token, 'begin', '');
    }
    const version = doc.version;
    const text = doc.text;
    later(mode === 'slow-first' ? (pushes++ === 0 ? 600 : 1000) : 60, () => {
      if (reportsProgress) progress(token, 'end');
      send({ method: 'textDocument/publishDiagnostics', params: { uri: vscodeUri(uri), version, diagnostics: diagnosticsOf(text, 'Pyright') } });
    });
  }
}

function saved(uri) {
  if (mode !== 'ra') return;
  const doc = docs.get(uri);
  const token = 'rust-analyzer/flycheck/0';
  send({ id: ++nextId, method: 'window/workDoneProgress/create', params: { token } });
  progress(token, 'begin', 'cargo check');
  later(150, () => {
    const checked = diagnosticsOf(doc.text, 'rustc').map((d) => ({ ...d, message: `${d.message} (as rustc words it)` }));
    send({ method: 'textDocument/publishDiagnostics', params: { uri, version: doc.version, diagnostics: checked } });
    progress(token, 'end');
    send({ id: ++nextId, method: 'workspace/diagnostic/refresh' });
  });
}

function handle(message) {
  const { id, method, params } = message;
  if (method === undefined) return; // a response to one of ours
  switch (method) {
    case 'initialize': {
      if (mode === 'mute') return;
      const pull = pulls || mode === 'ra';
      send({ id, result: { capabilities: { textDocumentSync: 2, ...(pull ? { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } } : {}) } } });
      return;
    }
    case 'initialized':
      if (mode === 'push-versioned') {
        send({ id: 0, method: 'workspace/configuration', params: { items: [{ section: 'python' }] } });
      }
      return;
    case 'textDocument/didOpen': {
      const { uri, version, text } = params.textDocument;
      docs.set(uri, { version, text });
      if (mode === 'ra' && !loaded) {
        // The workspace loads under progress; until it has, a pull is empty.
        progress('rustAnalyzer/Fetching', 'begin', 'Fetching');
        later(200, () => {
          loaded = true;
          progress('rustAnalyzer/Fetching', 'end');
        });
      }
      changed(uri);
      return;
    }
    case 'textDocument/didChange': {
      const { uri, version } = params.textDocument;
      docs.set(uri, { version, text: params.contentChanges.at(-1).text });
      changed(uri);
      return;
    }
    case 'textDocument/didSave':
      saved(params.textDocument.uri);
      return;
    case 'textDocument/diagnostic': {
      if (!pulls && mode !== 'ra') {
        send({ id, error: { code: -32601, message: 'Unhandled method textDocument/diagnostic' } });
        return;
      }
      const doc = docs.get(params.textDocument.uri);
      const items = doc && loaded ? diagnosticsOf(doc.text, mode === 'ra' ? 'rust-analyzer' : 'ts') : [];
      send({ id, result: { kind: 'full', items } });
      return;
    }
    case 'shutdown':
      send({ id, result: null });
      return;
    case 'exit':
      process.exit(0);
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Unhandled method ${method}` } });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
