# Agent candidates

Which coding agents to add next, how each would be integrated, and two
related decisions: whether CodeDeck+ should ship an agent of its own, and
whether agents should be installed one at a time instead of all at host
start. Researched 2026-10-07; versions and licences are as published on that
date and should be re-checked before an agent is implemented.

Today the host runs three drivers: Claude Code (Agent SDK), OpenCode (its
server SDK) and the DeepSeek Harness (Agent Client Protocol, ACP).

## How agents can be integrated

An agent is worth adding only if it exposes a structured, two-way surface: a
remote needs tool approvals, questions and plan reviews routed to the phone,
and a scraped TUI or a one-shot `-p` run cannot carry them. Three surfaces
qualify:

| Surface | What it is | Who has it |
| --- | --- | --- |
| Native SDK / server | the agent's own embedding API | Claude Code, OpenCode, Codex (`codex app-server`), Pi (SDK and `--mode rpc`) |
| ACP | JSON-RPC 2.0 on stdio, one schema for every agent (permission asks, plans, config options, slash commands) | ~40 agents in the [ACP registry](https://agentclientprotocol.com/get-started/registry), including Gemini CLI, Copilot, Cursor, Antigravity, Kimi, Qwen Code, goose, Mistral Vibe |
| Headless print mode | one prompt, streamed JSON out | everyone — **not enough** for a remote |

ACP is the decisive finding: the DeepSeek driver already speaks it, so a
generic ACP driver (the DeepSeek driver's ACP client and session logic, minus
what is DeepSeek-specific) makes each further ACP agent a small driver of
catalog data, install pins and an env/credential mapping. The registry's
`registry.json` also states each agent's distribution — an npm package, or a
per-platform archive URL, most with a sha256 — which is exactly what the
pinned on-demand installer needs.

## Recommendation

### Tier 1 — add next, each with its own driver

**OpenAI Codex CLI.** Apache-2.0, Rust. The most used agent after Claude Code;
included in every ChatGPT plan, from Free up. Integrate through
`codex app-server` (bidirectional JSON-RPC: threads, turns, streamed items,
command/patch approvals, diffs) rather than the TypeScript SDK, which wraps
`codex exec` and cannot route approvals. Ships as `@openai/codex` with
per-platform binary packages (`@openai/codex-linux-x64`, …), so it installs
exactly like Claude Code and OpenCode: one binary, pinned by pnpm-lock.yaml.
Credentials: `OPENAI_API_KEY`, or a ChatGPT sign-in (device-code flow, which
the phone would have to relay — check before committing to it).

**Pi** (`@earendil-works/pi-coding-agent`, MIT). ~113k stars, Pi 1.0 shipped
2026-10-01; multi-provider (Anthropic, OpenAI, Google, OpenRouter, local).
Needs Node ≥ 22.19 (the bridge ships 24). Two surfaces: an in-process SDK and
`pi --mode rpc` (JSONL on stdio, with extension UI requests for confirms and
selects). **It never asks before a tool call by default**, so the driver must
install a gate (an extension hooking tool calls) that routes each call to
`requestPermission` — without it a phone remote would run arbitrary commands
unasked. A pure-JS package with ~23 dependencies: installs as a package tree,
like the DeepSeek Harness. Prefer the RPC mode: it keeps the agent out of the
host's process and is the same surface Oh My Pi speaks (below).

**GitHub Copilot CLI** (`@github/copilot`, proprietary). Reaches everyone who
has Copilot through an employer or the free tier. Speaks ACP
(`copilot --acp`); per-platform binary packages, musl included — the
single-binary install. The first agent on the generic ACP driver.

### Tier 2 — on the generic ACP driver, after Tier 1

| Agent | Why | Distribution | Note |
| --- | --- | --- | --- |
| Gemini CLI | API-key and Gemini Enterprise users | npm `@google/gemini-cli`, one bundle | Google stopped serving free, AI Pro and AI Ultra accounts on 2026-06-18; consumer users moved to Antigravity |
| Google Antigravity (`agy`) | Gemini CLI's successor for consumer plans | per-platform zip from dl.google.com (`agy-acp-server`), proprietary | registry gives no sha256 — pin a hash ourselves per release |
| Cursor CLI | Cursor subscribers | per-platform tarball, proprietary | no sha256 in the registry; same pinning caveat |
| Kimi CLI, Qwen Code, Mistral Vibe, goose | strong open-weight model users | GitHub release archives with sha256 (Qwen: npm) | each mostly catalog + credential mapping |

### Not now

- **Oh My Pi** (`@oh-my-pi/pi-coding-agent`, MIT, ~34k stars). A Pi fork with
  LSP, debugger and many more tools, but it requires **Bun ≥ 1.3.14** and
  pulls OpenTelemetry and Puppeteer. Bun itself is on npm as per-platform
  binaries, so it could be installed pinned like any agent binary; and since
  OMP keeps Pi's `--mode rpc`, a Pi driver built on RPC can host it as a
  second catalog entry with a different runtime. Revisit once the Pi driver
  is in.
- **Aider** — Python, no ACP and no structured approvals.
- **Claude Agent via ACP, codex-acp** — adapters for agents with a better
  native surface; we use the native one.
- **Amp, Devin, Factory Droid, Augment, Junie** — closed, subscription-bound,
  or only reachable through third-party wrappers.
- **Grok Build** — xAI disabled it after it uploaded whole repositories
  unasked; not something to put behind a remote.

## An agent of our own?

**No new harness.** A competitive harness is the tools, prompts, compaction,
provider plumbing and their constant tuning — what the agents above are paid
or crowd-funded to maintain. What CodeDeck+ could add on top is narrow: a
default that suits a phone (concise replies, plan-first, every tool call
asked). That is a *profile*, not an agent: if wanted, ship it as a "CodeDeck"
catalog entry that runs Pi with our extensions (permission gate, question
and plan-review tools, a short system prompt). Decide after the Pi driver
exists, when it costs one extension package rather than a project.

## Installing agents on demand

Today every driver the host is told to load (`CODEDECK_AGENT_HOST_DRIVERS`,
default all three) starts installing its runtime when the host starts.
With three agents that is acceptable; with eight it is gigabytes downloaded
for agents the user never opens, on a machine that may be a small VPS.

Proposal:

1. The catalog lists every agent this build knows, each with an install
   state: `not_installed`, `installing`, `ready`, `failed` (with reason).
   `unavailableReason` already covers part of this; the state becomes a
   first-class catalog field — a phone-wire change, so it starts in
   `crates/protocol` with a fixture, then `crates/agent-protocol`.
2. New requests `install_agent` / `uninstall_agent` (phone → bridge → host).
   Installing runs the same pinned installer; uninstalling removes the
   agent's `<cache>/<package>@<version>` directory. The bridge persists the
   installed set in its state and passes it to the host on spawn.
3. The phone's agent picker shows not-installed agents with an Install
   action and progress; a session can only start on a `ready` agent.
4. A fresh bridge installs nothing; an agent already on the machine (found
   on PATH or bundled beside the host, `BUNDLE_AGENTS=1`) is `ready` without
   a download. `codedeck-bridge agents install <id>` does the same from a
   shell, and the warm-up mode takes the same list.

Do this before the Tier 1 agents land, so each new agent costs nothing until
someone chooses it.

## Order

1. Release candidate of what is merged.
2. Install on demand (above).
3. Extract the generic ACP driver from the DeepSeek driver.
4. Codex (native), Pi (RPC, with the permission gate), Copilot (ACP).
5. Tier 2 on the ACP driver, as users ask for them.
