# DeepSeek Harness backend

CodeDeck+ runs sessions on any agent its agent host has a driver for: Claude
Code, [OpenCode](https://opencode.ai), and the
[DeepSeek Harness](https://www.deepseek.com/en/harness/) (`dsh`). A phone picks
the agent per session from the "New session" sheet, which lists what the
bridge advertises in its heartbeat. The DeepSeek Harness is on by default and
needs one thing: a DeepSeek API key (set from the phone, or exported on the
bridge).

The driver (`packages/agent-host/src/drivers/deepseek/`) drives the harness's
`acp` profile — `dsh --profile acp` — which is the only interface it exposes
that has everything a remote client needs: prompts, cancellation, one-shot
permission asks, and a model/reasoning choice that can change mid-session.
Its `sdk` profile has none of the last three and `headless` is one-shot.

## Getting it running

Nothing to install by hand. The harness is a Node program — a few hundred MB
of npm packages, with no single binary to ship — so the agent host installs
it on demand, exactly like the other agents' binaries: at the version and
sha512 this build pins in `pnpm-lock.yaml`, into `<home>/agents/`, from the
npm registry (or `CODEDECK_NPM_REGISTRY`). The download starts as the bridge
starts; a first session waits for it. An operator who already has a harness
can point the bridge at it instead:

```bash
codedeck-bridge run --deepseek-path /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
# or: CODEDECK_DEEPSEEK_PATH=… codedeck-bridge run
# or in config.json: { "deepseekPath": "…" }
```

The path is the harness's CLI entry point (`…/@deepseek-ai/dsh/lib/bin.js`) or
an executable of your own; the host runs a `.js` entry point with its own
`node`.

The key is a **DeepSeek API key**: set it from the phone (Agents → DeepSeek
Harness → credential), or export `DEEPSEEK_API_KEY` on the bridge — an
exported key wins over a stored one and the phone cannot clear it. The key is
verified against `https://api.deepseek.com/models` when you save it (a
refusal means the key is not accepted; a network error means nothing was
claimed either way).

## Its own home

The harness keeps everything under `$DSH_HOME`: its profiles (the `acp`
profile's configuration), the sessions a bridge can resume, and its
credentials. CodeDeck+ sets it to `<home>/dsh` (`/data/dsh` in the container
image), following the bridge's home so a bridge that moves its data directory
does not leave an agent's conversations behind. `CODEDECK_DEEPSEEK_HOME`
overrides it. It is shared by every session, whatever provider profile a
session is bound to.

## Models and reasoning

The model list and the reasoning levels come from the harness itself, read
from a short-lived probe session when the phone asks for models; nothing is
hardcoded here, so a deployment that replaces the harness's model catalog
sees its own models in the phone. Two things follow from the harness's own
shape:

- A model's value is the harness's own opaque selector (it names a provider
  and a model together), not a friendly id. The phone shows the model's
  label; what it stores and sends back is that value. A session started with
  a model the running catalog does not have is refused, with the reason.
- The reasoning levels are `off`, `low`, `high` and `max` (the DeepSeek
  route's own), and a model without reasoning support has none — a session
  started with a level such a model does not have reports that rather than
  refusing to start.

The session header shows the model the harness actually resolved, and how
full the context is (the harness reports its own usage).

## Gateways and other providers

Two ways to run sessions somewhere other than DeepSeek's own API, and both end
up at the same place: the harness's DeepSeek route pointed at that endpoint,
with `DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY`.

**The bridge's own endpoint** (every session that does not name a profile of
its own). Set both in the bridge's environment — for the container, `.env`:

```bash
DEEPSEEK_BASE_URL=http://gateway.example:3458   # a DeepSeek-compatible relay or router
DEEPSEEK_API_KEY=…                           # travelled as a compose secret, not an env var
```

Then the endpoint's *own* model list becomes the harness's catalog: as the
host starts, CodeDeck asks it for its models (`<root>/v1/models`, on the same
root the harness itself posts `/messages` to) and writes that list into the
harness's profile, where the harness documents its catalog as replaceable. So
the phone offers exactly what the gateway serves — for a router whose ids name
their channel (`Z.ai (Global) - Coding Plan/glm-5.3-flash`), the channel is
shown as the model's provider, the way Claude Code's gateway models are. The
model a session starts on moves with the list, since the harness always
offers the model it is on: a DeepSeek default the gateway does not serve would
otherwise appear there as a model nobody can run.

The key is checked against that same list when you save it (a refusal is shown
as rejected; an endpoint that cannot be reached claims nothing). An endpoint
that does not answer leaves the harness's own catalog alone — its three
DeepSeek models — and nothing is guessed; clearing `DEEPSEEK_BASE_URL` takes
CodeDeck's row back out again.

**A provider profile on the phone** (one session). Same idea, per session: the
profile's endpoint and token reach that session's harness instead of the
operator's, and the profile's models are what the phone offers. Pick this when
one bridge should run, say, a native session and a gateway session side by
side — a session's provider binding applies to its whole process, so the two
do not mix.

Both go through the same rules as the other agents: the base URL must be
`https://` (plain `http://` only to localhost, 127.0.0.1 or `[::1]`), a token
is required, and the harness's whole `DEEPSEEK_*` namespace is dropped from
the environment of a bound session — an operator's native key must not be
billed for a session bound somewhere else. `DSH_HOME` survives: where the
harness keeps its state is not routing.

One limit of the harness's own design: a session bound to an endpoint is
reached through its DeepSeek route, so that endpoint has to speak that API.
A gateway of another shape (OpenAI-completions, Anthropic messages) is
configured in the harness's own profile — dsh's configuration to write, not
this driver's.

## Commands and questions

Two things the harness does in this profile that its automation surface does
not carry, and that CodeDeck brings to the phone with one small plugin of its
own (`codedeck-dsh-bridge`, mounted by a row in the profile's patch layer):

**Slash commands.** The harness has `/compact`, `/goal`, `/feedback`, `/plan`,
`/permission`, and whatever its plugins add. ACP carries no command list and
no way to invoke one, and the harness keeps commands for its own UI modules, so
a typed `/name` would otherwise be prompt text that reaches the model. The
plugin holds the command registry and answers two questions over a local
socket: what this session can run, and "run this line". The phone lists what it
says, and a typed `/name` runs there instead of being sent to the model — the
command's own words come back as the agent's answer (`/plan` answers "Plan mode
on", `/goal set X` answers with the goal it now holds).

**Questions.** The harness's model can put a decision to the user — its
`ask_user_question` tool, that tool's timed form, and the plan review
`exit_plan_mode` presents all ask through one service — and that service's
answerer is a panel in the harness's own apps. Without one the ask fails with
"no user-questions answerer configured", which is what a plain setup does. The
plugin composes an answerer instead: the ask is pushed to the host as a marker
line on the harness's stderr (the one stream that is not ACP's), the phone
shows it as the very card the other agents' ask uses, and the answer goes back
the way the harness takes one — the labels of the chosen options, or the text
the user typed. Each question carries its own id, so a batch of them comes
back matched to what was asked.

A plan review arrives as the same exchange Claude Code's is, because it is the
same one: the plan as a plan of its own, and the choice as the approval card,
wearing the harness's own labels (approve, or keep planning). The labels are
the verdict — the harness's tool looks for the one its intent declared — so a
plan the user did not approve goes back to the model to revise, with their
feedback arriving as their next message, exactly as it does for the other
agent.

The socket is a file in the bridge's home (`/data/codedeck/dsh-bridge.sock`, a
named pipe on Windows, named after the home). Nothing else about the profile
changes, and the plugin is harmless if the harness moves under it: a list that
cannot be read means the phone offers no commands, an unanswerable question
reads as one the user did not answer, and a slash line is ordinary text again —
a session never fails over either. Two things it does not do: a command that
takes attachments gets none (this bridge sends the line alone), and the rows of
the calls that ask the user — the question tool's and the plan review's — are
hidden in the transcript, since the card is the exchange (the plan review's row
would be the plan again, as raw arguments).

## MCP servers

The harness reads its MCP servers from the `acp` profile's own patch layer,
`<home>/dsh/profiles/acp/cordis.patch.yml` — the file the harness documents as
the user's. This driver owns one delimited block of it (the MCP screen writes
there); everything around the block, comments included, is preserved. A
server is a `dsh-mcp-client` row reaching it over **stdio** or **streamable
HTTP** (no SSE), and switching one off leaves its row in place with a disable
row after it, so it can be switched back on.

The servers are attached when the harness starts, which is why a session
shows them but cannot switch one: change the list on the MCP screen and the
next harness process uses it (the session screen says `pending` for a server
the running harness has not loaded). Failures are the harness's own — it logs
them on stderr, which is where the session screen's `failed` status and its
message come from; a server that cannot start does not stop the session.

## Plugins

A plugin is an npm package installed into the profile and mounted as a patch
layer. The harness's own CLI does the work — `dsh plugin --profile acp add
<package>`, which runs pnpm in the profile directory — so its pnpm, its lock
and its version-compatibility gate are the ones that apply, and a refusal is
whatever it printed. That means **pnpm must be on the agent host's `PATH`**
for install, uninstall and update to work; listing and switching need nothing.

- Installing a package that declares a `dsh.bundle` adds it to the profile's
  layer list: that is what "enabled" means here. A package that declares none
  is installed as a plain dependency (the harness says so itself) and stays
  switched off.
- Switching a plugin off takes it out of the layer list without uninstalling
  it. The profile's own composition — the shared core and the ACP application
  — is not switchable.
- There are no marketplaces: a plugin is an npm package name, optionally with
  a version.

## What this does not have

The automation profile carries none of these, and the driver says so in the
catalog the phone reads:

- **No modes.** The harness has none, so `ask` and `YOLO` are this driver's
  own: send every permission to the phone, or allow everything. Asked
  permissions offer Allow and Deny only — the harness has no "always allow"
  to choose.
- **No background tasks**, and no attachments on a command or a question.
- **No subscription usage** to ask for (the context meter still works).
- **No diff blocks.** The harness reports a tool result as text, so a file
  change is reconstructed from the call's own arguments — what an `edit`
  replaced, what a `write` wrote. A change made by a shell command shows as
  its output, not as a card.
- **No image prompts from the phone** (the harness advertises them per model;
  CodeDeck+ sends text).

## Offline and container notes

- The container image installs the harness into `/data/agents` on first use,
  like the other agents. Build with `CODEDECK_BUNDLE_AGENTS=1` (see
  [`BRIDGE.md`](BRIDGE.md)) and the image carries it instead, from the same
  installer and so at the same pinned version.
- `CODEDECK_AGENT_HOST_WARM=1` runs that install and exits, for a host that
  should fetch everything before it serves anything.
- The harness's runtime is large (some 600 packages): a minute or two on a
  normal connection, and several on a bind mount from a Windows host (Docker
  Desktop's `/data` is far slower than a container's own filesystem, and can
  refuse a rename for a moment — the installer waits and retries).
- A container recreated with an existing `/data` volume keeps whatever agents
  that volume already has; the bundled copy reaches a *new* volume.
