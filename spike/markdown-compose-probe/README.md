# F0 · probe 4 — Markdown / transcript parity in Compose

> **THROWAWAY.** Delete once the verdict is folded into the plan (or an ADR).

## Verdict: **GO — with a scoped renderer decision required in F3**

Compose transcript rendering can reach parity, but a Markdown renderer is **not
a library drop-in** for CodeDeck's corpus: tables, task-list checkboxes and
syntax highlighting all need explicit work, and there is a real
Kotlin/AGP/Paparazzi/Compose/renderer version matrix to lock.

| Question | Answer |
|---|---|
| Screenshot-test Compose rendering off-device (the F3 fidelity guardrail)? | ✅ **Yes** — Paparazzi runs in Docker on the JVM (no emulator); `:ui:recordPaparazziDebug` → golden PNGs. |
| Do the **bespoke** rows (diff card, tool group, cards) port with matching fidelity? | ✅ **Yes** — `diff_card` / `tool_group` goldens match the near-black monochrome (`+` green / `-` red / dim mono). Near-verbatim ports of `DiffRow.tsx` etc. |
| Does a Compose Markdown renderer cover the corpus out of the box? | ⚠️ **Partly** — see the table below. |

## What the Markdown renderer (mikepenz 0.27, synchronous) does / doesn't

`artifacts/probe_ParityTest_assistant_markdown_gfm_and_code.png`:

| feature | result |
|---|---|
| headings, paragraphs | ✅ render, white on black |
| ordered / unordered / **nested** lists | ✅ |
| inline code | ✅ monospace on `#0D0D0D` |
| **5 fenced code blocks** (bash / ts / rust / json / diff) | ✅ render as monospace blocks |
| **GFM table** | ❌ renders as **stacked plain lines**, not a grid — even with `GFMFlavourDescriptor()`. Needs a custom `markdownComponents(table = …)` or a newer renderer version. |
| **task-list checkboxes** (`- [x]` / `- [ ]`) | ❌ render as plain `•` bullets |
| **syntax highlighting** | ❌ absent (monochrome). Needs the `-code` module (version-locked) or Rust/`syntect` spans emitted from `client-core`. |
| blockquote | ⚠️ not visibly distinct from a paragraph |
| link | renders inline, styling minimal |

## The version treadmill (must be locked for F3)

- `Markdown(content = …)` in mikepenz **≥ ~0.30 parses asynchronously** →
  Paparazzi's static snapshot catches the empty frame (blank golden). Needs a
  synchronous path.
- The synchronous `Markdown(content)` exists in **0.27**, but 0.27 predates
  built-in table rendering.
- **0.39.x requires Kotlin 2.2** (`kotlin-stdlib 2.3`); this probe is on Kotlin
  2.0.21 (Paparazzi 1.3.5 / AGP 8.7.3 constraint) → 0.39 fails to compile
  (`incompatible metadata version 2.2.0`).
- Intermediate versions drift the `-android` / `-m3` / `-code` modules apart
  transitively → runtime `NoSuchMethodError` unless every module is pinned.
- Colour: text colour comes from `markdownTypography(...)` per-slot `TextStyle`s
  and `LocalContentColor` (via a `Surface`), **not** `markdownColor(text=…)`
  (deprecated). The dark-only theme needs every slot set explicitly.

## Recommendation for F3

1. Adopt **Paparazzi** (proven here) as the transcript-fidelity guardrail.
2. **First F3 task = a transcript-screen spike**: lock one
   Kotlin/AGP/Paparazzi/Compose/renderer version set; get tables + task lists +
   blockquotes rendering (custom components if needed); capture goldens for the
   whole corpus; diff against a **reference capture from the running React app**
   (`apps/mobile` on `pnpm dev`, fixed width).
3. **Syntax highlighting is its own decision** — accept coarse `highlights`,
   theme it toward the current hljs palette, or emit spans from Rust
   (`syntect`/`tree-sitter`) in `client-core`. Budget explicit effort; it is the
   single biggest fidelity gap.
4. This widens the F3/F4 UI scope but does **not** threaten stopping at F2b — the
   work is bounded and known.

## Reproduce

`./spike/markdown-compose-probe/run.sh` (Docker only; reuses the
`codedeck-bgprobe-build` image for JDK + Android cmdline-tools).

## Delete criteria

Once this verdict is recorded in the plan (or an ADR), `rm -rf spike/markdown-compose-probe/`.
