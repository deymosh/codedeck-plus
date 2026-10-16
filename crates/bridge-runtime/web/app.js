// The bridge's web page. Plain DOM, no dependencies: everything it loads is
// served by the bridge itself (its CSP allows nothing else). Text from the
// bridge is always set as text, never as HTML.
"use strict";

const views = ["loading", "signed-out", "pending", "dashboard"];
let pollTimer = null;
let expiresAt = 0;

const $ = (id) => document.getElementById(id);

function show(view) {
  for (const v of views) $(v).hidden = v !== view;
  $("sign-out").hidden = view !== "dashboard";
}

async function api(path, method = "GET") {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: method === "POST" ? { "Content-Type": "application/json" } : {},
    body: method === "POST" ? "{}" : undefined,
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

function stateOf(session) {
  const state = session.state || "idle";
  const tone = { running: "busy", waiting: "busy", idle: "ok", error: "bad", offline: "" }[state] ?? "";
  return el("span", { class: `state ${tone}` }, state);
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

async function dashboard() {
  const { status, body } = await api("/api/status");
  if (status === 401) return refresh();
  if (status !== 200) return schedule(dashboard, 5000);
  show("dashboard");
  const hb = body.heartbeat || {};
  $("machine").textContent = hb.machine || "";
  document.title = `${hb.machine || "Bridge"} · CodeDeck+`;

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
  $("signed-in-as").textContent = `Signed in by ${body.signedInBy.slice(0, 16)}… ${relative(body.signedInSince)}.`;
  schedule(dashboard, 5000);
}

$("start").addEventListener("click", start);
$("sign-out").addEventListener("click", async () => {
  await api("/api/sign-out", "POST");
  show("signed-out");
});
refresh();
