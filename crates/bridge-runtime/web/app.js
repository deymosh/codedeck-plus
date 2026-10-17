// The bridge's web page. Plain DOM, no dependencies: everything it loads is
// served by the bridge itself (its CSP allows nothing else). Text from the
// bridge is always set as text, never as HTML.
"use strict";

const views = ["loading", "signed-out", "pending", "dashboard"];
const tabs = ["overview", "usage", "browsers", "devices", "settings"];
let pollTimer = null;
let expiresAt = 0;
// The latest status, so switching tabs renders at once instead of waiting
// for the next poll.
let lastStatus = null;

const $ = (id) => document.getElementById(id);

function show(view) {
  for (const v of views) $(v).hidden = v !== view;
  $("sign-out").hidden = view !== "dashboard";
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
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function schedule(fn, ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(fn, ms);
}

async function refresh() {
  let me;
  try {
    me = (await api("/api/me")).body;
  } catch {
    schedule(refresh, 3000);
    return;
  }
  if (me.state === "signed-in") return dashboard();
  if (me.state === "pending") return pending(me);
  show("signed-out");
}

async function start() {
  $("start-error").hidden = true;
  const { status, body } = await api("/api/sign-in", "POST");
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

function pending(me) {
  show("pending");
  if ($("code").textContent !== me.code) {
    $("code").textContent = me.code;
    $("qr").src = "/api/sign-in/qr.svg?code=" + encodeURIComponent(me.code);
  }
  expiresAt = Date.now() + me.expiresInMs;
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

function currentTab() {
  const tab = location.hash.slice(1);
  return tabs.includes(tab) ? tab : "overview";
}

async function dashboard() {
  const { status, body } = await api("/api/status");
  if (status === 401) return refresh();
  if (status !== 200) return schedule(dashboard, 5000);
  lastStatus = body;
  show("dashboard");
  render();
  schedule(dashboard, 5000);
}

/** The dashboard's frame and the open tab, from the latest status. */
function render() {
  const body = lastStatus;
  if (!body) return;
  const hb = body.heartbeat || {};
  $("machine").textContent = hb.machine || "";
  document.title = `${hb.machine || "Bridge"} · CodeDeck+`;
  const tab = currentTab();
  for (const link of document.querySelectorAll("[data-tab]")) link.classList.toggle("on", link.dataset.tab === tab);
  for (const pane of document.querySelectorAll("[data-pane]")) pane.hidden = pane.dataset.pane !== tab;
  $("signed-in-as").textContent = `Signed in by ${body.signedInBy.slice(0, 16)}… ${relative(body.signedInSince)}.`;
  if (tab === "usage") usage(hb);
  else if (tab === "browsers") browsers();
  else if (tab === "devices") devices();
  else if (tab === "settings") settings();
  else overview(body, hb);
}

function overview(body, hb) {

  facts($("bridge-facts"), [
    ["Machine", hb.machine || "—"],
    ["Runs as", hb.host || "—"],
    ["Identity", el("span", { class: "mono" }, body.machine)],
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

  const sessions = [...(hb.sessions || [])].sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  const agentName = Object.fromEntries((hb.agents || []).map((a) => [a.id, a.displayName]));
  $("session-count").textContent = sessions.length ? String(sessions.length) : "";
  $("no-sessions").hidden = sessions.length > 0;
  $("sessions").replaceChildren(...sessions.map((s) => el("tr", {},
    el("td", { class: "title", title: s.title || s.slug }, s.title || s.slug),
    el("td", {}, agentName[s.agent] || s.agent),
    el("td", {}, stateOf(s)),
    el("td", { class: "folder", title: s.cwd }, s.project || s.cwd),
    el("td", { class: "when" }, relative(s.lastActivity)),
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
  const agentName = Object.fromEntries((hb.agents || []).map((a) => [a.id, a.displayName]));
  const byAgent = tally(sessions.map((s) => s.agent));
  $("usage-empty").hidden = byAgent.length > 0;
  $("usage-agents").replaceChildren(...byAgent.map(([agent, count]) => {
    const own = sessions.filter((s) => s.agent === agent);
    const running = own.filter((s) => s.state === "running").length;
    const waiting = own.filter((s) => s.state === "waiting_permission" || s.state === "waiting_question").length;
    const lines = own.reduce((sum, s) => sum + (s.lineCount || 0), 0);
    const models = tally(own.map((s) => s.model));
    return el("div", { class: "agent" },
      el("div", { class: "agent-head" }, el("span", { class: "agent-name" }, agentName[agent] || agent), el("span", { class: "dim small" }, `${count} session${count === 1 ? "" : "s"}`)),
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
        el("span", { class: "dim small" }, `${agentName[s.agent] || s.agent} · ${Math.round(pct)}%${size}`)),
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

async function browsers() {
  const { status, body } = await api("/api/browsers");
  if (status !== 200) return;
  $("browsers").replaceChildren(...(body.browsers || []).map((b) => {
    const out = el("button", { class: "quiet danger", type: "button" }, "Sign out");
    out.addEventListener("click", async () => {
      if (!confirm(b.current ? "Sign this browser out?" : `Sign out ${browserName(b.agent)} at ${b.peer}?`)) return;
      const answer = await api("/api/browsers/sign-out", "POST", { id: b.id });
      $("browsers-error").hidden = answer.status === 200;
      $("browsers-error").textContent = "The bridge did not sign it out.";
      if (b.current && answer.status === 200) return refresh();
      browsers();
    });
    return el("div", { class: "row" },
      el("div", { class: "row-main" },
        el("div", { class: "row-title" }, browserName(b.agent), b.current ? el("span", { class: "chip" }, "this browser") : null),
        el("div", { class: "dim small" }, `${b.peer} · signed in ${relative(b.sinceMs)} · seen ${relative(b.lastSeenMs)} · by ${b.by.slice(0, 16)}…`)),
      out);
  }));
}

async function devices() {
  const { status, body } = await api("/api/devices");
  if (status !== 200) return;
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
  relayRegisterToken: { label: "Relay admin token", kind: "secret", needs: "relayRegisterEndpoint" },
  blossomRegisterToken: { label: "Blossom admin token", kind: "secret", needs: "blossomRegisterEndpoint" },
};
const FIXED_LABELS = {
  workspaceRoots: "Workspace", torProxyUrl: "Tor proxy", nodePath: "Node", agentHostPath: "Agent host",
  testMode: "Test mode", "direct.listen": "Direct link listens on", "direct.onionListen": "Onion listener",
  relayRegisterEndpoint: "Relay admin endpoint", blossomRegisterEndpoint: "Blossom admin endpoint",
};
// The form is built once per visit to the tab, so a poll does not wipe what
// is being typed.
let settingsShown = false;

function shownValue(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join("\n") : "—";
  return String(v);
}

async function settings() {
  if (settingsShown) return;
  const { status, body } = await api("/api/config");
  if (status !== 200) return;
  settingsShown = true;
  const fields = body.fields || [];
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  // A token is offered only beside its endpoint: one without the other does nothing.
  const editable = fields.filter((f) => f.editable && SETTINGS[f.key]
    && (!SETTINGS[f.key].needs || (byKey[SETTINGS[f.key].needs] && byKey[SETTINGS[f.key].needs].value)));
  $("settings-fields").replaceChildren(...editable.map((f) => {
    const spec = SETTINGS[f.key];
    let input;
    if (spec.kind === "list") {
      input = el("textarea", { rows: "3", spellcheck: "false", class: "mono" });
      input.value = (f.value || []).join("\n");
    } else if (spec.kind === "secret") {
      input = el("input", { type: "password", placeholder: f.set ? "Set — type to replace" : "Not set" });
    } else {
      input = el("input", { type: spec.kind === "number" ? "number" : "text", min: "0" });
      input.value = f.value ?? "";
    }
    input.dataset.key = f.key;
    input.dataset.kind = spec.kind;
    if (f.overridden) input.disabled = true;
    const note = f.overridden ? "Set by a flag or an environment variable, which wins over the file." : spec.hint;
    const clear = spec.kind === "secret" && f.set && !f.overridden
      ? el("label", { class: "check small dim" }, el("input", { type: "checkbox", "data-clear": f.key }), " Clear it")
      : null;
    return el("label", { class: "field" }, el("span", { class: "field-label" }, spec.label), input,
      note ? el("span", { class: "dim small" }, note) : null, clear);
  }));
  $("settings-fixed").replaceChildren(...fields.filter((f) => !f.editable).flatMap((f) => [
    el("dt", {}, FIXED_LABELS[f.key] || f.key), el("dd", { class: "mono" }, shownValue(f.value)),
  ]));
}

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const set = {};
  const secrets = {};
  for (const input of $("settings-fields").querySelectorAll("[data-key]")) {
    if (input.disabled) continue;
    const { key, kind } = input.dataset;
    if (kind === "secret") {
      if (input.value) secrets[key] = input.value;
    } else if (kind === "list") {
      set[key] = input.value.split("\n").map((line) => line.trim()).filter(Boolean);
    } else if (kind === "number") {
      set[key] = input.value === "" ? null : Number(input.value);
    } else {
      set[key] = input.value.trim();
    }
  }
  for (const box of $("settings-fields").querySelectorAll("[data-clear]")) if (box.checked) secrets[box.dataset.clear] = null;
  const result = $("settings-result");
  const answer = await api("/api/config", "POST", { set, secrets });
  if (answer.status === 200) {
    result.className = "small ok";
    result.textContent = "Saved. Restart the bridge to apply it.";
    for (const input of $("settings-fields").querySelectorAll("input[type=password]")) input.value = "";
  } else {
    result.className = "small error";
    result.textContent = answer.body.error ? `${SETTINGS[answer.body.key]?.label || answer.body.key}: ${answer.body.error}` : "The bridge did not save it.";
  }
});

window.addEventListener("hashchange", () => {
  settingsShown = false;
  render();
});

$("start").addEventListener("click", start);
$("sign-out").addEventListener("click", async () => {
  await api("/api/sign-out", "POST");
  show("signed-out");
});
refresh();
