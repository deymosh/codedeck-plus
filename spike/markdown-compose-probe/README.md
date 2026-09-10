# F0 · probe 4 — Markdown / transcript parity in Compose

> **THROWAWAY.** Delete once the verdict is folded into the plan (or an ADR).

## Verdict: **CONDITIONAL GO** — parity is reachable but **not trivial**

| Question | Answer |
|---|---|
| Can we screenshot-test Compose transcript rendering off-device (the F3 fidelity guardrail)? | ✅ **Yes.** Paparazzi runs in Docker on the JVM (no emulator), `:ui:recordPaparazziDebug` → golden PNGs. This is the tooling F3 should adopt. |
| Do the **bespoke** rows (diff card, tool group, cards) port to Compose with matching fidelity? | ✅ **Yes.** `DiffCard` / `ToolGroup` goldens match CodeDeck's near-black monochrome (`+` green / `-` red / dim filename, monospace) — near-verbatim ports of `DiffRow.tsx` etc. |
| Does a Compose-native **Markdown renderer** drop in for parity with `react-markdown` + `remark-gfm` + `rehype-highlight`? | ⚠️ **No — it needs real integration work** (details below). |

## Evidence

`artifacts/*.png` (from `ui/src/test/snapshots/images/`):

| golden | result |
|---|---|
| `diff_card` | ✅ faithful — filename dim, `-` red, `+` green, context gray, monospace, near-black card |
| `tool_group` | ✅ faithful — "N actions" + bullet list on a near-black card |
| `user_message` | ✅ plain white text |
| `assistant_markdown_gfm_and_code` | ❌ **blank** — the `mikepenz` `Markdown(content=…)` composable rendered nothing in a static Paparazzi snapshot |

## The Markdown-renderer findings (the "not trivial" part)

Using `com.mikepenz:multiplatform-markdown-renderer` 0.35 (the leading
Compose-native option):

1. **Async parse vs screenshot tests.** `Markdown(content = …)` parses the
   source asynchronously; Paparazzi's static `snapshot {}` captures the
   pre-parse (empty) frame → blank golden. The fix is `rememberMarkdownState(…,
   immediate = true)` / a synchronous parse path — see #2.
2. **Version alignment.** Switching to `rememberMarkdownState(immediate = true)`
   threw `NoSuchMethodError` at runtime — the `-android` / `-m3` / `-code`
   artifacts drift apart transitively. All mikepenz modules must be pinned to
   one exact version (and probably a newer one than 0.35 for `immediate`).
3. **Colour plumbing.** Text colour no longer comes from `markdownColor(text=…)`
   (deprecated) — it comes from `markdownTypography(...)` per-slot `TextStyle`s
   and/or `LocalContentColor`. For CodeDeck's dark-only theme every slot needs
   an explicit white/gray `TextStyle`; the defaults render dark-on-dark.
4. **Syntax highlighting is a separate module** (`-code`, backed by
   `dev.snipme:highlights`) covering ~a dozen languages with coarser tokens
   than highlight.js's ~190 grammars. Exact colour-per-token parity with the
   current hand-written hljs theme (`rows.module.css` `:global(.hljs*)`) will
   **not** be free — it's the single biggest fidelity gap. Options: accept
   coarser highlighting, theme `highlights` to approximate, or parse in
   Rust/`syntect` in `client-core` and emit spans (plan already notes this).
5. GFM tables / task lists / nested lists / blockquotes **are** supported by the
   renderer — once #1–#3 are solved they should render; not verified here
   because of #1.

## Recommendation for F3

- Adopt **Paparazzi** (proven here) as the transcript-fidelity guardrail.
- **First F3 task is a transcript-screen spike**: pin a single mikepenz version,
  wire synchronous parse + the full dark `markdownTypography`, capture goldens
  for the whole corpus, and diff against a **reference capture from the running
  React app** (`apps/mobile` on `pnpm dev` in a browser at a fixed width).
- Budget explicit effort for syntax-highlight parity — treat it as its own
  decision, not a checkbox.

## Reproduce

`./spike/markdown-compose-probe/run.sh` (Docker only; reuses the
`codedeck-bgprobe-build` image for JDK + Android cmdline-tools).

## Delete criteria

Once this verdict is recorded in the plan (or an ADR), `rm -rf spike/markdown-compose-probe/`.
