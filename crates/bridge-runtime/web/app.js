// The bridge's web page. Plain DOM, no dependencies: everything it loads is
// served by the bridge itself (its CSP allows nothing else). Text from the
// bridge is always set as text, never as HTML.
"use strict";

const views = ["loading", "signed-out", "pending", "dashboard"];
const tabs = ["overview", "usage"];
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
  $("no-sign-in").hidden = !body.noSignIn;
  const hb = body.heartbeat || {};
  $("machine").textContent = hb.machine || "";
  document.title = `${hb.machine || "Bridge"} · CodeDeck+`;
  const tab = currentTab();
  for (const link of document.querySelectorAll("[data-tab]")) link.classList.toggle("on", link.dataset.tab === tab);
  for (const pane of document.querySelectorAll("[data-pane]")) pane.hidden = pane.dataset.pane !== tab;
  $("signed-in-as").textContent = `Signed in by ${body.signedInBy.slice(0, 16)}… ${relative(body.signedInSince)}.`;
  if (tab === "usage") usage(hb);
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
        el("span", { class: "dim small" }, `${agentName[s.agent] || s.agent} · ${Math.round(pct)}%${window}`)),
      el("div", { class: "meter-track" }, fill),
    );
  }));
}

window.addEventListener("hashchange", render);

$("start").addEventListener("click", start);
$("sign-out").addEventListener("click", async () => {
  await api("/api/sign-out", "POST");
  show("signed-out");
});
refresh();
