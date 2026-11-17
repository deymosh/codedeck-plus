// The bridge's web page: a client that drives the bridge's sessions, signed
// in by a paired phone. Plain DOM, no dependencies: everything it loads is
// served by the bridge itself (its CSP allows nothing else). Text from the
// bridge — transcripts above all, which hold whatever a tool read — is always
// set as text, never as HTML.
//
// The browser holds a key of its own: a WebCrypto ECDSA P-256 key made at
// sign-in, whose private half cannot be exported. Every frame it sends on
// its stream is signed with it (protocol::web is the spec), so the cookie
// alone is worth nothing to whoever copies it.
"use strict";

const PROTOCOL_VERSION = 12;
const SIGNING_CONTEXT = "codedeck-web-v1";
// The page renews its presence (a signed frame) this often: it keeps the
// stream from going idle and the browser's sign-in from lapsing while open.
const PRESENCE_MS = 5 * 60 * 1000;

const views = ["loading", "signed-out", "pending", "dashboard"];
const tabs = ["sessions", "overview", "usage", "browsers", "devices", "settings"];
let pollTimer = null;
let expiresAt = 0;
let me = null;

const $ = (id) => document.getElementById(id);

function show(view) {
  for (const v of views) $(v).hidden = v !== view;
  $("sign-out").hidden = view !== "dashboard";
  $("link").hidden = view !== "dashboard";
}

async function api(path, method = "GET", payload = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: method === "POST" ? { "Content-Type": "application/json" } : {},
    body: method === "POST" ? JSON.stringify(payload) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function button(label, onClick, cls = "quiet") {
  const b = el("button", { class: cls, type: "button" }, label);
  b.addEventListener("click", onClick);
  return b;
}

function schedule(fn, ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(fn, ms);
}

// --- the browser's key ---------------------------------------------------

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

function keyStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("codedeck", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("keys", mode);
      const request = fn(tx.objectStore("keys"));
      tx.oncomplete = () => resolve(request && request.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** The key pair this browser signed in with, or null. */
const loadKey = () => keyStore("readonly", (s) => s.get("pair")).catch(() => null);
const dropKey = () => keyStore("readwrite", (s) => s.delete("pair")).catch(() => {});

/** A fresh key for a new sign-in: its private half can sign, never leave. */
async function newKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  await keyStore("readwrite", (s) => s.put(pair, "pair"));
  return pair;
}

async function keyId(pair) {
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return hex(await crypto.subtle.digest("SHA-256", raw)).slice(0, 16);
}

// --- sign-in -------------------------------------------------------------

async function refresh() {
  try {
    me = (await api("/api/me")).body;
  } catch {
    schedule(refresh, 3000);
    return;
  }
  if (me.state === "signed-in") return signedIn();
  if (me.state === "pending") return pending(me);
  link.stop();
  show("signed-out");
}

async function start() {
  $("start-error").hidden = true;
  let raw;
  try {
    const pair = await newKey();
    raw = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
  } catch {
    $("start-error").textContent = "This browser cannot make a signing key here (it needs WebCrypto and IndexedDB on this page).";
    $("start-error").hidden = false;
    return;
  }
  const { status, body } = await api("/api/sign-in", "POST", { key: raw });
  if (status === 429) {
    $("start-error").textContent = "Too many sign-in attempts from here. Wait a minute and try again.";
    $("start-error").hidden = false;
    return;
  }
  if (status !== 200) {
    $("start-error").textContent = "The bridge did not start a sign-in.";
    $("start-error").hidden = false;
    return;
  }
  pending(body);
}

function pending(state) {
  show("pending");
  if ($("code").textContent !== state.code) {
    $("code").textContent = state.code;
    $("qr").src = "/api/sign-in/qr.svg?code=" + encodeURIComponent(state.code);
  }
  expiresAt = Date.now() + state.expiresInMs;
  tickExpiry();
  // Waiting for the phone: ask again until the browser is in or the code lapses.
  schedule(refresh, 2000);
}

function tickExpiry() {
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  $("expires").textContent = left > 0 ? `The code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more.` : "The code lapsed.";
  if (left === 0) show("signed-out");
}
setInterval(() => { if (!$("pending").hidden) tickExpiry(); }, 1000);

/** Signed in: the key this browser holds must be the one the bridge let in. */
async function signedIn() {
  const pair = await loadKey();
  if (!pair || (await keyId(pair)) !== me.id) {
    // The key is gone (site data cleared) or another: this sign-in can sign
    // nothing, so it ends here and a new one starts.
    await signOut();
    return;
  }
  show("dashboard");
  render();
  link.start(pair);
}

async function signOut() {
  link.stop();
  await api("/api/sign-out", "POST").catch(() => {});
  await dropKey();
  me = null;
  show("signed-out");
}

// --- the stream ----------------------------------------------------------

/** The signed stream: one WebSocket, every frame signed by the browser's key. */
const link = {
  ws: null,
  pair: null,
  id: null,
  challenge: null,
  seq: 0,
  ready: false,
  stopped: true,
  retry: 1000,
  waiting: new Map(),
  presenceTimer: null,
  // The frames being signed and sent, one after another.
  queue: Promise.resolve(),

  async start(pair) {
    this.pair = pair;
    this.id = await keyId(pair);
    this.stopped = false;
    if (!this.ws) this.connect();
  },

  stop() {
    this.stopped = true;
    clearInterval(this.presenceTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
    this.ready = false;
    status();
  },

  connect() {
    const ws = new WebSocket(`wss://${location.host}/api/stream`);
    this.ws = ws;
    this.ready = false;
    this.seq = 0;
    status();
    ws.onmessage = (event) => this.receive(event.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      clearInterval(this.presenceTimer);
      for (const [, w] of this.waiting) w.resolve({ accepted: false, message: "The connection dropped: it may not have arrived." });
      this.waiting.clear();
      status();
      if (this.stopped) return;
      // A closed stream may be a lapsed sign-in: ask before dialling again.
      setTimeout(() => refresh(), this.retry);
      this.retry = Math.min(this.retry * 2, 30000);
    };
  },

  async sign(seq, body) {
    const input = `${SIGNING_CONTEXT}\n${me.machine}\n${this.id}\n${this.challenge}\n${seq}\n${body}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.pair.privateKey, new TextEncoder().encode(input));
    return b64url(sig);
  },

  async receive(text) {
    let frame;
    try { frame = JSON.parse(text); } catch { return; }
    const [label, ...rest] = frame;
    if (label === "CHALLENGE") {
      this.challenge = rest[0];
      this.ws.send(JSON.stringify(["HELLO", await this.sign(0, "")]));
    } else if (label === "READY") {
      this.ready = true;
      this.retry = 1000;
      status();
      onConnected();
      clearInterval(this.presenceTimer);
      this.presenceTimer = setInterval(() => sendPresence(), PRESENCE_MS);
    } else if (label === "CLOSED") {
      const reason = rest[0];
      if (reason === "expired" || reason === "signed-out" || reason === "bad-signature") {
        this.stop();
        await dropKey();
        refresh();
      }
    } else if (label === "OK" || label === "REPLY") {
      const w = this.waiting.get(rest[0]);
      if (!w) return;
      this.waiting.delete(rest[0]);
      w.resolve(label === "OK" ? { accepted: rest[1], message: rest[2] } : rest[1]);
    } else if (label === "MSG") {
      onMessage(rest[0]);
    }
  },

  /**
   * Send a signed frame; resolves with its answer (`OK` or `REPLY`). Frames
   * are signed and sent one at a time, in `seq` order: signing is async, and
   * a frame whose `seq` does not grow closes the stream.
   */
  send(label, body) {
    const ws = this.ws;
    const turn = this.queue.then(async () => {
      if (!this.ready || this.ws !== ws) return label === "CMD" ? { accepted: false, message: "Not connected." } : { status: 0, body: {} };
      const seq = ++this.seq;
      const sig = await this.sign(seq, body);
      if (this.ws !== ws) return label === "CMD" ? { accepted: false, message: "Not connected." } : { status: 0, body: {} };
      const answer = new Promise((resolve) => this.waiting.set(seq, { resolve }));
      ws.send(JSON.stringify([label, seq, body, sig]));
      return { answer };
    });
    this.queue = turn.catch(() => {});
    return turn.then((r) => (r && r.answer ? r.answer : r));
  },

  /** A command, as the phone would send it. */
  command(msg) {
    return this.send("CMD", JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
  },

  /** A page request: `{status, body}`. */
  page(request) {
    return this.send("PAGE", JSON.stringify(request));
  },
};

function status() {
  const live = link.ready;
  $("link").className = `state ${live ? "ok" : "busy"}`;
  $("link").textContent = live ? "live" : "connecting";
}

// --- what the bridge sends ----------------------------------------------

let heartbeat = null;
let heartbeatRev = 0;
const transcripts = new Map();
let selected = null;
let browserList = null;

function transcript(sessionId) {
  let t = transcripts.get(sessionId);
  if (!t) {
    t = { entries: new Map(), live: new Map(), syncId: null, acks: [], ackTimer: null, sent: [] };
    transcripts.set(sessionId, t);
  }
  return t;
}

function onConnected() {
  // A creation whose answer the dropped connection lost is not waited for.
  if (pendingCreate) {
    pendingCreate = null;
    renderNewSession();
  }
  sendPresence();
  if (selected) syncSession(selected);
  if (currentTab() === "browsers") link.command({ type: "web-browsers-request" });
}

function onMessage(msg) {
  switch (msg.type) {
    case "sessions":
      if (msg.rev != null && msg.rev <= heartbeatRev) return;
      if (msg.rev != null) heartbeatRev = msg.rev;
      heartbeat = msg;
      for (const id of msg.removedSessions || []) transcripts.delete(id);
      render();
      return;
    case "output": {
      if (!transcripts.has(msg.sessionId)) return;
      const t = transcript(msg.sessionId);
      msg.entries.forEach((entry, i) => t.entries.set(msg.seq + i, entry));
      for (const entry of msg.entries) {
        if (entry.part) t.live.delete(entry.part);
        if (entry.entryType === "turn_complete") t.live.clear();
      }
      if (msg.sessionId === selected) redrawTranscript();
      return;
    }
    case "partial": {
      if (msg.sessionId !== selected) return;
      const t = transcript(msg.sessionId);
      const row = t.live.get(msg.key);
      if (msg.offset === 0) t.live.set(msg.key, { entryType: msg.entryType, text: msg.text, subagent: msg.subagent });
      else if (row && !row.broken && row.text.length === msg.offset) row.text += msg.text;
      else if (row) row.broken = true;
      drawLive();
      return;
    }
    case "sync-begin":
      transcript(msg.sessionId).syncId = msg.syncId;
      return;
    case "sync-chunk": {
      const t = transcript(msg.sessionId);
      for (const { seq, entry } of msg.entries) t.entries.set(seq, entry);
      // Acks for chunks that arrive together go out as one command — each
      // under the sync its chunks came in.
      if (t.ackSync !== msg.syncId) flushAcks(t);
      t.ackSync = msg.syncId;
      t.acks.push(msg.range);
      clearTimeout(t.ackTimer);
      t.ackTimer = setTimeout(() => flushAcks(t), 50);
      if (msg.sessionId === selected) redrawTranscript();
      return;
    }
    case "session-pending":
      // The answer to this page's own create-session (replies go to the
      // asking browser alone): the id the session will have.
      if (pendingCreate === "?") pendingCreate = msg.pendingId;
      return;
    case "session-ready":
      if (pendingCreate === msg.pendingId) {
        pendingCreate = null;
        location.hash = `#sessions/${msg.session.id}`;
      }
      return;
    case "session-failed":
      if (pendingCreate === msg.pendingId) {
        pendingCreate = null;
        notify(`The session did not start: ${msg.reason || "the agent failed"}.`);
        renderNewSession();
      }
      return;
    case "input-failed":
      notify(msg.reason === "no-session" ? "The bridge knows no such session." : "The session is not running.");
      return;
    case "option-confirmed": {
      const s = (heartbeat?.sessions || []).find((x) => x.id === msg.sessionId);
      if (s) s[msg.option] = msg.value;
      if (msg.sessionId === selected) renderSessionHead();
      return;
    }
    case "web-browsers":
      browserList = msg.browsers;
      if (currentTab() === "browsers") renderBrowsers();
      return;
    default:
  }
}

function flushAcks(t) {
  clearTimeout(t.ackTimer);
  const ranges = t.acks.splice(0);
  if (ranges.length) link.command({ type: "sync-ack", syncId: t.ackSync, ranges });
}

let toastTimer = null;
function notify(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 6000);
}

function sendPresence() {
  link.command({ type: "presence", away: document.hidden, watching: document.hidden ? null : selected });
}
document.addEventListener("visibilitychange", () => { if (link.ready) sendPresence(); });

/** The seqs a transcript holds, as `[first, last]` runs. */
function haveRanges(t) {
  const seqs = [...t.entries.keys()].sort((a, b) => a - b);
  const ranges = [];
  for (const s of seqs) {
    const last = ranges[ranges.length - 1];
    if (last && s === last[1] + 1) last[1] = s;
    else ranges.push([s, s]);
  }
  return ranges;
}

function syncSession(sessionId) {
  link.command({ type: "sync-request", sessionId, haveRanges: haveRanges(transcript(sessionId)) });
}

// --- the frame -----------------------------------------------------------

function relative(iso) {
  const at = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

// A session's state as the heartbeat names it, as a word and a colour.
const STATES = {
  idle: ["idle", "ok"],
  running: ["running", "busy"],
  waiting_permission: ["waiting for a permission", "busy"],
  waiting_question: ["waiting for an answer", "busy"],
  offline: ["offline", ""],
};

function stateOf(session) {
  const [label, tone] = STATES[session.state || "idle"] ?? [session.state, ""];
  return el("span", { class: `state ${tone}` }, label);
}

function installOf(agent) {
  const install = agent.install || {};
  switch (install.state) {
    case "ready": return el("span", { class: "state ok" }, "ready");
    case "installing": return el("span", { class: "state busy" }, "installing");
    case "failed": return el("span", { class: "state bad", title: install.reason || "" }, "install failed");
    case "not_installed": return el("span", { class: "state" }, "not installed");
    default: return el("span", { class: "state" }, install.state || "unknown");
  }
}

function credentialOf(c) {
  const tone = c.present ? (c.valid === false ? "bad" : "ok") : "";
  const what = c.present ? (c.valid === false ? "invalid" : c.fromEnv ? "set (environment)" : "set") : "not set";
  return el("span", { class: `state ${tone}` }, `${c.label}: ${what}`);
}

function facts(target, rows) {
  target.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

/** The open tab, and for `sessions` the session in it. */
function route() {
  const [tab, id] = location.hash.slice(1).split("/");
  let session = null;
  try { session = id ? decodeURIComponent(id) : null; } catch { session = null; }
  return { tab: tabs.includes(tab) ? tab : "sessions", id: session };
}
const currentTab = () => route().tab;
const agentName = (id) => (heartbeat?.agents || []).find((a) => a.id === id)?.displayName || id;

/** The frame and the open tab, from the latest heartbeat. */
function render() {
  if ($("dashboard").hidden) return;
  const hb = heartbeat || {};
  $("machine").textContent = hb.machine || "";
  document.title = `${hb.machine || "Bridge"} · CodeDeck+`;
  const { tab, id } = route();
  for (const tabLink of document.querySelectorAll("[data-tab]")) tabLink.classList.toggle("on", tabLink.dataset.tab === tab);
  for (const pane of document.querySelectorAll("[data-pane]")) pane.hidden = pane.dataset.pane !== tab;
  $("dashboard").classList.toggle("wide", tab === "sessions");
  if (me?.by) {
    const lapse = me.lapses ? ` Stays signed in until ${new Date(me.lapses).toLocaleDateString()} while used.` : "";
    $("signed-in-as").textContent = `Signed in by ${me.by.slice(0, 16)}… ${relative(me.since)}.${lapse}`;
  }
  const watching = tab === "sessions" ? id : null;
  if (watching !== selected) {
    selected = watching;
    if (link.ready) sendPresence();
    if (selected) {
      transcript(selected);
      if (link.ready) syncSession(selected);
    }
    transcriptKey = null;
  }
  if (!heartbeat) return;
  if (tab === "sessions") sessionsPane();
  else if (tab === "usage") usage(hb);
  else if (tab === "browsers") renderBrowsers();
  else if (tab === "devices") devices();
  else if (tab === "settings") settings();
  else overview(hb);
}

// --- sessions ------------------------------------------------------------

let pendingCreate = null;

function sortedSessions() {
  return [...(heartbeat?.sessions || [])].sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
}

function sessionsPane() {
  const sessions = sortedSessions();
  $("session-list").replaceChildren(...sessions.map((s) => el("a", { class: `session-item${s.id === selected ? " on" : ""}`, href: `#sessions/${encodeURIComponent(s.id)}` },
    el("span", { class: "session-title" }, s.title || s.slug),
    el("span", { class: "session-meta" }, stateOf(s), el("span", { class: "dim small" }, `${agentName(s.agent)} · ${s.project || s.cwd}`)),
  )));
  $("no-sessions").hidden = sessions.length > 0;
  const session = sessions.find((s) => s.id === selected);
  $("session-view").hidden = !session;
  $("new-session").hidden = !!session;
  if (session) {
    renderSessionHead();
    redrawTranscript();
  } else {
    renderNewSession();
  }
}

function renderNewSession() {
  const agents = (heartbeat?.agents || []).filter((a) => (a.install?.state || "ready") !== "failed");
  const agentSelect = $("new-agent");
  if (agentSelect.options.length !== agents.length) {
    agentSelect.replaceChildren(...agents.map((a) => el("option", { value: a.id }, a.displayName)));
  }
  const folders = heartbeat?.folders || [];
  const folderSelect = $("new-folder");
  const wanted = ["", ...folders];
  if (JSON.stringify([...folderSelect.options].map((o) => o.value)) !== JSON.stringify(wanted)) {
    folderSelect.replaceChildren(el("option", { value: "" }, "The workspace itself"), ...folders.map((f) => el("option", { value: f }, f)));
  }
  $("new-start").disabled = !!pendingCreate || !agents.length;
  $("new-start").textContent = pendingCreate ? "Starting…" : "Start";
}

$("new-session").addEventListener("submit", async (event) => {
  event.preventDefault();
  const msg = { type: "create-session", agent: $("new-agent").value };
  if ($("new-folder").value) msg.cwd = $("new-folder").value;
  const answer = await link.command(msg);
  if (!answer.accepted) return notify(answer.message || "The bridge did not take it.");
  // The bridge names the session after the pending id it answers with.
  pendingCreate = "?";
  renderNewSession();
});

/** The session's header: its name, state and options. */
function renderSessionHead() {
  const session = (heartbeat?.sessions || []).find((s) => s.id === selected);
  if (!session) return;
  const agent = (heartbeat.agents || []).find((a) => a.id === session.agent);
  $("session-name").textContent = session.title || session.slug;
  const meta = [agentName(session.agent), session.model, session.project || session.cwd].filter(Boolean).join(" · ");
  $("session-meta").replaceChildren(stateOf(session), el("span", { class: "dim small" }, meta));
  const modes = agent?.modes || [];
  const mode = $("session-mode");
  mode.hidden = modes.length === 0;
  mode.replaceChildren(...modes.map((m) => el("option", { value: m.id, selected: m.id === (session.mode || agent.defaultMode) }, m.label)));
  const busy = session.state && session.state !== "idle" && session.state !== "offline";
  $("interrupt").hidden = !busy || agent?.supports?.interrupt === false;
}

$("session-mode").addEventListener("change", async () => {
  const answer = await link.command({ type: "set-option", sessionId: selected, option: "mode", value: $("session-mode").value });
  if (!answer.accepted) notify(answer.message || "The bridge did not take it.");
});
$("interrupt").addEventListener("click", () => link.command({ type: "interrupt", sessionId: selected }));
$("close-session").addEventListener("click", async () => {
  if (!confirm("End this session? Its agent stops; the transcript stays on the bridge until it is pruned.")) return;
  await link.command({ type: "close-session", sessionId: selected });
  location.hash = "#sessions";
});

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("input").value;
  if (!text.trim() || !selected) return;
  const inputId = crypto.randomUUID();
  $("input").value = "";
  const answer = await link.command({ type: "input", sessionId: selected, text, inputId });
  if (!answer.accepted) {
    $("input").value = text;
    notify(answer.message || "It did not reach the bridge.");
  }
});
$("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

// --- the transcript ------------------------------------------------------

let transcriptKey = null;
let redrawQueued = false;

function redrawTranscript() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    drawTranscript();
  });
}

function atBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function drawTranscript() {
  if (!selected) return;
  const t = transcript(selected);
  const scroller = $("transcript");
  const stick = transcriptKey !== selected || atBottom(scroller);
  const seqs = [...t.entries.keys()].sort((a, b) => a - b);
  const entries = seqs.map((s) => t.entries.get(s));
  // What a card became, and each call's result and diff, by id.
  const resolved = new Map();
  const results = new Map();
  const diffs = new Map();
  for (const e of entries) {
    if (e.entryType === "resolved") resolved.set(e.requestId, e.summary);
    if (e.entryType === "tool_result") results.set(e.callId, e);
    if (e.entryType === "diff" && e.callId) diffs.set(e.callId, e);
  }
  const rows = [];
  for (const e of entries) {
    const row = entryRow(e, { resolved, results, diffs, session: selected });
    if (row) rows.push(e.subagent ? el("div", { class: "sub" }, el("span", { class: "sub-label" }, e.subagent.label || "sub-agent"), row) : row);
  }
  $("entries").replaceChildren(...rows);
  $("transcript-empty").hidden = rows.length > 0;
  drawLive();
  if (stick) scroller.scrollTop = scroller.scrollHeight;
  transcriptKey = selected;
}

function drawLive() {
  const t = selected && transcripts.get(selected);
  const scroller = $("transcript");
  const stick = atBottom(scroller);
  $("live").replaceChildren(...(t ? [...t.live.values()] : []).map((row) =>
    row.entryType === "thinking"
      ? el("div", { class: "thinking live" }, row.text)
      : el("div", { class: "msg from-agent live" }, markdown(row.text))));
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

/** Light markdown, built as elements: fences, paragraphs, `code`, **bold**. */
function markdown(text) {
  const out = document.createDocumentFragment();
  const parts = String(text).split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.append(el("pre", { class: "code-block" }, el("code", {}, part.replace(/\n$/, ""))));
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = el("p", {});
      for (const piece of para.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
        if (/^`[^`]+`$/.test(piece)) p.append(el("code", {}, piece.slice(1, -1)));
        else if (/^\*\*[^*]+\*\*$/.test(piece)) p.append(el("strong", {}, piece.slice(2, -2)));
        else if (piece) p.append(piece);
      }
      out.append(p);
    }
  });
  return out;
}

const KIND_WORDS = {
  read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Search", execute: "Run",
  think: "Think", fetch: "Fetch", switch_mode: "Mode", agent: "Agent", other: "Tool",
};

function diffView(d) {
  return el("pre", { class: "diff" },
    el("div", { class: "diff-path" }, d.path),
    ...(d.lines || []).map((l) => el("div", { class: `diff-${l.type}` }, (l.type === "add" ? "+" : l.type === "del" ? "-" : " ") + l.text)),
    d.truncated ? el("div", { class: "dim" }, "…") : null);
}

function entryRow(e, ctx) {
  switch (e.entryType) {
    case "text":
      return el("div", { class: `msg from-${e.role}` }, e.role === "user" ? e.text : markdown(e.text));
    case "thinking":
      return e.redacted ? el("div", { class: "thinking" }, "Reasoning withheld by the provider.")
        : el("details", { class: "thinking" }, el("summary", {}, "Thinking"), el("div", {}, e.text));
    case "plan":
      return el("div", { class: "block" }, el("div", { class: "block-head" }, "Plan"), markdown(e.text));
    case "tool_call": {
      const result = ctx.results.get(e.callId);
      const diff = ctx.diffs.get(e.callId);
      const tone = result ? (result.isError ? "bad" : "ok") : "busy";
      return el("details", { class: "tool" },
        el("summary", {}, el("span", { class: `state ${tone}` }, KIND_WORDS[e.kind] || e.toolName), " ", el("span", { class: "tool-title" }, e.title || e.toolName)),
        e.input ? el("pre", { class: "tool-io" }, e.input) : null,
        diff ? diffView(diff) : null,
        result?.text ? el("pre", { class: `tool-io${result.isError ? " error" : ""}` }, result.text) : null);
    }
    case "tool_result":
      return null;
    case "diff":
      return e.callId ? null : diffView(e);
    case "todos":
      return el("div", { class: "block" }, el("div", { class: "block-head" }, "To do"),
        el("ul", { class: "todos" }, ...e.items.map((i) => el("li", { class: `todo ${i.status}` }, i.status === "in_progress" && i.activeText ? i.activeText : i.text))));
    case "background_task":
      return el("div", { class: "line" }, el("span", { class: `state ${e.status === "running" ? "busy" : e.status === "failed" ? "bad" : "ok"}` }, e.status), ` ${e.title}`, e.summary ? el("span", { class: "dim" }, ` — ${e.summary}`) : null);
    case "permission_request":
      return permissionCard(e, ctx);
    case "question":
      return questionCard(e, ctx);
    case "plan_approval":
      return planCard(e, ctx);
    case "resolved":
    case "turn_complete":
      return null;
    case "notice":
      return el("div", { class: "line dim" }, e.text || e.kind);
    case "status":
      return el("div", { class: "line dim" }, e.text);
    case "error":
      return el("div", { class: "line error" }, e.text);
    default:
      return null;
  }
}

/** A card's answer, sent; the card waits for its `resolved` entry. */
const answered = new Set();

async function answer(ctx, requestId, msg) {
  answered.add(requestId);
  redrawTranscript();
  const result = await link.command({ sessionId: ctx.session, requestId, ...msg });
  if (!result.accepted) {
    answered.delete(requestId);
    redrawTranscript();
    notify(result.message || "The answer did not reach the bridge.");
  }
}

function cardFrame(title, ctx, requestId, ...body) {
  const summary = ctx.resolved.get(requestId);
  return el("div", { class: `card-entry${summary != null ? " done" : ""}` },
    el("div", { class: "block-head" }, title),
    ...body.filter(() => summary == null),
    summary != null ? el("div", { class: "dim" }, summary) : answered.has(requestId) ? el("div", { class: "dim" }, "Sent…") : null);
}

function permissionCard(e, ctx) {
  const open = !ctx.resolved.has(e.requestId) && !answered.has(e.requestId);
  return cardFrame("Permission", ctx, e.requestId,
    el("div", {}, el("strong", {}, e.title || e.toolName)),
    e.description ? el("div", { class: "dim" }, e.description) : null,
    e.reason ? el("div", { class: "dim small" }, e.reason) : null,
    (e.locations || []).length ? el("div", { class: "mono small" }, e.locations.join("\n")) : null,
    open ? el("div", { class: "card-actions" }, ...(e.options || []).map((o) =>
      button(o.label, () => answer(ctx, e.requestId, { type: "permission-response", optionId: o.id }), o.kind.startsWith("allow") ? "primary small-btn" : "quiet small-btn"))) : null);
}

function questionCard(e, ctx) {
  const key = `${e.requestId}#${e.index}`;
  const open = !ctx.resolved.has(e.requestId) && !answered.has(key);
  const choices = (e.options || []).map((o, i) => el("label", { class: "choice" },
    el("input", { type: e.multiSelect ? "checkbox" : "radio", name: key, value: String(i) }),
    el("span", {}, o.label, o.description ? el("span", { class: "dim small" }, ` — ${o.description}`) : null)));
  const other = el("input", { type: "text", class: "other", placeholder: "Or answer in your own words" });
  const send = button("Answer", () => {
    if (other.value.trim()) return answerQuestion(ctx, e, key, { kind: "text", text: other.value.trim() });
    const selectedOptions = choices.map((c, i) => (c.querySelector("input").checked ? i : -1)).filter((i) => i >= 0);
    if (selectedOptions.length) answerQuestion(ctx, e, key, { kind: "options", selected: selectedOptions });
  }, "primary small-btn");
  const count = e.count > 1 ? ` ${e.index + 1} of ${e.count}` : "";
  return cardFrame(`Question${count}`, ctx, e.requestId,
    e.header ? el("div", { class: "dim small" }, e.header) : null,
    el("div", {}, el("strong", {}, e.question)),
    open ? el("div", { class: "choices" }, ...choices, other, el("div", { class: "card-actions" }, send)) : answered.has(key) ? el("div", { class: "dim" }, "Sent…") : null);
}

function answerQuestion(ctx, e, key, value) {
  answered.add(key);
  redrawTranscript();
  link.command({ type: "question-response", sessionId: ctx.session, requestId: e.requestId, index: e.index, answer: value }).then((r) => {
    if (!r.accepted) {
      answered.delete(key);
      redrawTranscript();
      notify(r.message || "The answer did not reach the bridge.");
    }
  });
}

function planCard(e, ctx) {
  const open = !ctx.resolved.has(e.requestId) && !answered.has(e.requestId);
  const feedback = e.revise ? el("textarea", { rows: "2", placeholder: "What to change (optional)" }) : null;
  return cardFrame("Plan approval", ctx, e.requestId,
    open ? feedback : null,
    open ? el("div", { class: "card-actions" }, ...(e.options || []).map((o) => button(o.label, () => {
      const msg = { type: "plan-response", optionId: o.id };
      if (o.id === e.revise && feedback.value.trim()) msg.feedback = feedback.value.trim();
      answer(ctx, e.requestId, msg);
    }, o.id === e.revise ? "quiet small-btn" : "primary small-btn"))) : null);
}

// --- the other tabs ------------------------------------------------------

function overview(hb) {
  facts($("bridge-facts"), [
    ["Machine", hb.machine || "—"],
    ["Runs as", hb.host || "—"],
    ["Identity", el("span", { class: "mono" }, me?.machine || "—")],
    ["Capabilities", el("span", { class: "chips" }, ...(hb.capabilities || []).map((c) => el("span", { class: "chip" }, c)))],
    ["Workspace", (hb.roots || []).join(", ") || "—"],
    ...((hb.credentials || []).length ? [["Credentials", el("span", { class: "chips" }, ...hb.credentials.map(credentialOf))]] : []),
  ]);

  const direct = hb.direct;
  facts($("direct-facts"), direct ? [
    ["Phones dial", el("span", { class: "mono" }, (direct.endpoints || []).join("\n") || "no address advertised")],
    ["Certificate", el("span", { class: "mono" }, (direct.certSha256 || "—").replace(/(..)(?!$)/g, "$1:"))],
  ] : [["Status", "off"]]);

  $("agents").replaceChildren(...(hb.agents || []).map((agent) => el("div", { class: "agent" },
    el("div", { class: "agent-head" }, el("span", { class: "agent-name" }, agent.displayName), installOf(agent)),
    el("div", { class: "creds" }, ...(agent.credentials || []).map(credentialOf)),
  )));
}

/** How many of `values` there are of each, most first. */
function tally(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function usage(hb) {
  const sessions = hb.sessions || [];
  const byAgent = tally(sessions.map((s) => s.agent));
  $("usage-empty").hidden = byAgent.length > 0;
  $("usage-agents").replaceChildren(...byAgent.map(([agent, count]) => {
    const own = sessions.filter((s) => s.agent === agent);
    const running = own.filter((s) => s.state === "running").length;
    const waiting = own.filter((s) => s.state === "waiting_permission" || s.state === "waiting_question").length;
    const lines = own.reduce((sum, s) => sum + (s.lineCount || 0), 0);
    const models = tally(own.map((s) => s.model));
    return el("div", { class: "agent" },
      el("div", { class: "agent-head" }, el("span", { class: "agent-name" }, agentName(agent)), el("span", { class: "dim small" }, `${count} session${count === 1 ? "" : "s"}`)),
      el("dl", { class: "facts small" },
        el("dt", {}, "Now"), el("dd", {}, running || waiting ? [running && `${running} running`, waiting && `${waiting} waiting`].filter(Boolean).join(" · ") : "idle"),
        el("dt", {}, "Transcripts"), el("dd", {}, `${lines.toLocaleString()} lines`),
        ...(models.length ? [el("dt", {}, "Models"), el("dd", {}, el("span", { class: "chips" }, ...models.map(([m, n]) => el("span", { class: "chip" }, n > 1 ? `${m} ×${n}` : m))))] : []),
      ),
    );
  }));

  const measured = sessions.filter((s) => typeof s.contextPercentage === "number")
    .sort((a, b) => b.contextPercentage - a.contextPercentage);
  $("usage-context-empty").hidden = measured.length > 0;
  $("usage-context").replaceChildren(...measured.map((s) => {
    const pct = Math.max(0, Math.min(100, s.contextPercentage));
    const tone = pct >= 90 ? "bad" : pct >= 70 ? "busy" : "";
    const size = s.contextWindow ? ` of ${Math.round(s.contextWindow / 1000)}k` : "";
    // Through the CSSOM: the page's CSP refuses a style attribute.
    const fill = el("div", { class: `meter-fill ${tone}` });
    fill.style.width = `${pct}%`;
    return el("div", { class: "meter" },
      el("div", { class: "meter-head" },
        el("span", { class: "meter-title", title: s.title || s.slug }, s.title || s.slug),
        el("span", { class: "dim small" }, `${agentName(s.agent)} · ${Math.round(pct)}%${size}`)),
      el("div", { class: "meter-track" }, fill),
    );
  }));
}

/** "Firefox on Windows" from a User-Agent, or the string itself. */
function browserName(agent) {
  if (!agent) return "A browser";
  const name = /Edg\//.test(agent) ? "Edge" : /OPR\//.test(agent) ? "Opera" : /Firefox\//.test(agent) ? "Firefox"
    : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : null;
  const os = /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Windows/.test(agent) ? "Windows"
    : /Mac OS X/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : null;
  return name ? (os ? `${name} on ${os}` : name) : agent;
}

let browsersAsked = false;

function renderBrowsers() {
  if (browserList === null || !browsersAsked) {
    browsersAsked = true;
    if (link.ready) link.command({ type: "web-browsers-request" });
    if (browserList === null) return;
  }
  $("browsers").replaceChildren(...browserList.map((b) => {
    const current = b.id === me?.id;
    const out = button("Sign out", async () => {
      if (!confirm(current ? "Sign this browser out?" : `Sign out ${browserName(b.agent)} at ${b.peer}?`)) return;
      if (current) return signOut();
      const answer = await link.command({ type: "web-browser-sign-out", id: b.id });
      $("browsers-error").hidden = answer.accepted;
      $("browsers-error").textContent = "The bridge did not sign it out.";
    }, "quiet danger");
    return el("div", { class: "row" },
      el("div", { class: "row-main" },
        el("div", { class: "row-title" }, browserName(b.agent), current ? el("span", { class: "chip" }, "this browser") : null),
        el("div", { class: "dim small" }, `${b.peer} · signed in ${relative(b.sinceMs)} · seen ${relative(b.lastSeenMs)} · until ${new Date(b.expiresMs).toLocaleDateString()} · by ${b.by.slice(0, 16)}…`)),
      out);
  }));
}

let devicesShown = false;

async function devices() {
  if (devicesShown) return;
  devicesShown = true;
  const { status, body } = await link.page({ type: "devices" });
  if (status !== 200) {
    devicesShown = false;
    return;
  }
  const list = body.devices || [];
  $("no-devices").hidden = list.length > 0;
  const now = Date.now();
  $("devices").replaceChildren(...list.map((d) => {
    const present = d.clients.filter((c) => c.presentUntilMs > now).length;
    const clients = d.clients.length;
    const lapse = Math.max(0, ...d.clients.map((c) => c.expiresAt * 1000));
    return el("div", { class: "row" },
      el("div", { class: "row-main" },
        el("div", { class: "row-title" }, d.label || "A phone", present ? el("span", { class: "state ok" }, "here now") : null),
        el("div", { class: "dim small mono" }, d.npub),
        el("div", { class: "dim small" },
          `Paired ${relative(d.pairedAt)} · ${clients} ${clients === 1 ? "copy of the app" : "copies of the app"}`
          + (lapse ? ` · keys valid until ${new Date(lapse).toLocaleDateString()}` : ""))));
  }));
}

// What each setting is called on the page, and how it is edited.
const SETTINGS = {
  machineName: { label: "Machine name", kind: "text" },
  relays: { label: "Relays", kind: "list", hint: "One per line: wss://, or ws:// only to an .onion address." },
  "direct.endpoints": { label: "Direct link addresses", kind: "list", hint: "Where phones dial the bridge, in order. One per line." },
  transcriptKeepLast: { label: "Transcripts kept", kind: "number", hint: "The newest this many; empty keeps them all." },
};
const FIXED_LABELS = {
  workspaceRoots: "Workspace", torProxyUrl: "Tor proxy", nodePath: "Node", agentHostPath: "Agent host",
  testMode: "Test mode", "direct.listen": "Direct link listens on", "direct.onionListen": "Onion listener",
};
// The form is built once per visit to the tab, so a heartbeat does not wipe
// what is being typed.
let settingsShown = false;

function shownValue(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join("\n") : "—";
  return String(v);
}

async function settings() {
  if (settingsShown) return;
  settingsShown = true;
  const { status, body } = await link.page({ type: "config" });
  if (status !== 200) {
    settingsShown = false;
    return;
  }
  const fields = body.fields || [];
  const editable = fields.filter((f) => f.editable && SETTINGS[f.key]);
  $("settings-fields").replaceChildren(...editable.map((f) => {
    const spec = SETTINGS[f.key];
    let input;
    if (spec.kind === "list") {
      input = el("textarea", { rows: "3", spellcheck: "false", class: "mono" });
      input.value = (f.value || []).join("\n");
    } else {
      input = el("input", { type: spec.kind === "number" ? "number" : "text", min: "0" });
      input.value = f.value ?? "";
    }
    input.dataset.key = f.key;
    input.dataset.kind = spec.kind;
    if (f.overridden) input.disabled = true;
    const note = f.overridden ? "Set by a flag or an environment variable, which wins over the file." : spec.hint;
    return el("label", { class: "field" }, el("span", { class: "field-label" }, spec.label), input,
      note ? el("span", { class: "dim small" }, note) : null);
  }));
  $("settings-fixed").replaceChildren(...fields.filter((f) => !f.editable).flatMap((f) => [
    el("dt", {}, FIXED_LABELS[f.key] || f.key), el("dd", { class: "mono" }, shownValue(f.value)),
  ]));
}

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const set = {};
  for (const input of $("settings-fields").querySelectorAll("[data-key]")) {
    if (input.disabled) continue;
    const { key, kind } = input.dataset;
    if (kind === "list") {
      set[key] = input.value.split("\n").map((line) => line.trim()).filter(Boolean);
    } else if (kind === "number") {
      set[key] = input.value === "" ? null : Number(input.value);
    } else {
      set[key] = input.value.trim();
    }
  }
  const result = $("settings-result");
  const answer = await link.page({ type: "config-set", set });
  if (answer.status === 200) {
    result.className = "small ok";
    result.textContent = "Saved. Restart the bridge to apply it.";
  } else {
    result.className = "small error";
    const body = answer.body || {};
    result.textContent = body.error ? `${SETTINGS[body.key]?.label || body.key}: ${body.error}` : "The bridge did not save it.";
  }
});

window.addEventListener("hashchange", () => {
  settingsShown = false;
  devicesShown = false;
  browsersAsked = false;
  render();
});

$("start").addEventListener("click", start);
$("sign-out").addEventListener("click", () => signOut());
refresh();
