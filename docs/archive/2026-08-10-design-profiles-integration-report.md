# AI Nugget — Design Profiles Integration Report

**Source of evidence:** Design Profiles (`design-profile-builder.html`,
[jxburros/Design-Profiles#2](https://github.com/jxburros/Design-Profiles/pull/2))
**Date:** 2026-08-10
**Author:** Claude
**Nugget version:** `@jxburros/ai-nugget@0.6.0` (latest published), consumed
directly from `registry.npmjs.org` via `esm.sh` — no local install, no build
step.

> **Consumer shape note:** unlike other reports in this archive, Design
> Profiles is a single static HTML file with no build tool. This is the
> nugget's first known browser-CDN consumer, as opposed to a bundled app or
> Node server — so some of the friction below is specific to that shape.

---

## TL;DR (verdict)

Replacing a hand-rolled, Anthropic-only `fetch` + tool-loop with the agent
layer (`AIHandler`, `runAgent`, `defineTool`) was close to a 1:1 swap, and it
is what made the AI Assistant panel model-agnostic (Anthropic, OpenAI, Google,
OpenRouter, Groq, Ollama, or any OpenAI-compatible endpoint) with no
provider-specific branching in app code. `toolMode: 'auto'` in particular did
real work: the same `update_design_profile` tool now works whether the model
has native function-calling or not.

The one real gap: **the nugget has no documented story for a build-free
browser consumer.** `docs/distribution.md` covers npm install, GitHub
Packages, and vendoring `nugget/` — all build-tool-shaped. Picking `esm.sh`
and its exact import URLs was an unassisted judgment call, not a documented
path, and a different integrator could reasonably have picked a CDN that
handles the package's conditional exports differently.

## What went well

- **The provider-agnostic call shape mapped directly onto the existing
  single-provider integration.** Same mental model (send messages, get a tool
  call, apply it, feed a result back), but the nugget now owns the
  provider-specific wire differences instead of the app.
- **`toolMode: 'auto'` removed a whole category of app-side decisions.** The
  old code assumed Anthropic's native `tool_use` blocks; the nugget resolves
  native-vs-prompt-JSON tool-calling per provider from
  `profileFor(provider).capabilities.nativeTools`, so no per-provider tool
  wire-format code was needed in the app.
- **The skills (`use-ai-nugget`, `build-agent-loop`) covered essentially all
  the API knowledge needed** without reading `src/agent/loop.ts` directly —
  their example code (define a tool, run the loop, check `stopReason`) mapped
  straight onto what got written.
- **Typed, honest `stopReason`s** (`finished`/`max_steps`/`budget`/`deadline`/
  `error`) meant real failures could be surfaced to the end user for free,
  with no extra design work.
- **npm-first publishing is what made a build-free single-file app a
  realistic target at all.** Confirmed directly against the npm registry API
  that `0.6.0` is published with exactly the `.` and `./agent` export paths
  the app imports — no vendoring or GitHub Packages auth needed for a public,
  client-side consumer.
- **`literalKeySource()` fit the "user pastes their own key into the
  browser" case cleanly**, with no env-var assumptions to route around —
  unlike a lot of provider SDKs that assume a server context by default.

## Friction points

1. **No documented browser/CDN consumption path.** This is the main finding.
   `docs/distribution.md`'s three paths (npm install, GitHub Packages,
   vendored `nugget/`) all assume a build step or a repo-local copy step.
   None of them is "import this by URL in a `<script type="module">` with no
   tooling at all." The exports map (`.` / `./agent`) is CDN-friendly in
   principle, but nothing in the docs confirms *which* CDNs resolve it
   correctly or recommends one. **Suggestion:** a short recipe in
   `docs/distribution.md` (or a runnable `examples/browser-cdn/`) with the
   exact import URLs for `.` and `./agent`, and a note on which CDNs are
   known-good against the package's conditional exports.
2. **Porting an existing tool schema required a manual rewrite.**
   `defineTool`'s `parameters` field is plain JSON Schema, which is more
   standard than Anthropic's `input_schema` wrapper the app used before — a
   welcome change, but a reminder that migrating an existing single-provider
   tool integration isn't zero-effort even when the target API is otherwise a
   clean fit.
3. **`runAgent`'s `AsyncIterable & { result }` return shape has a documented-in-source-only gotcha.** The `result` promise only resolves once the
   generator has been driven to completion; a caller that awaits
   `agent.result` without ever iterating the agent would hang indefinitely.
   The skill's example code iterates first, so a careful reader won't hit
   this, but the contract itself is easy to get subtly wrong (confirmed while
   writing a test double that matched the real generator's resolve-inside-the-
   generator behavior). A one-line callout in the `build-agent-loop` skill or
   `docs/agent-loop.md` would close the gap.
4. **Could not verify the real CDN import end-to-end from this environment.**
   Not a nugget defect — this authoring sandbox's outbound proxy allow-lists
   `registry.npmjs.org` directly but rejects `esm.sh`/`unpkg.com`/
   `cdn.jsdelivr.net`. Verification instead combined (a) confirming the exact
   published exports against the live npm registry API, and (b) a local test
   double matching the `runAgent`/`defineTool` contract read from source, run
   through the actual `design-profile-builder.html` in headless Chromium.
   That covers app-side logic (provider switching, tool execution, state
   updates, persistence) but not the real provider adapters running through a
   CDN-served copy of the package in an actual browser — that step is still
   open and worth a manual check outside this environment.

## Difficulty: low-to-moderate

Most effort went into reading (the skills, `providers.md`, and
`src/agent/loop.ts`/`tools.ts` to pin down the exact `runAgent`/`defineTool`
contracts) rather than fighting the API. Once the mental model was clear, the
actual code swap — a connection builder keyed off a provider dropdown,
`defineTool` wrapping the app's existing update function, `runAgent`
replacing a hand-rolled `while` loop over raw Anthropic responses — was
mechanical. The only real added cost was the missing browser-CDN guidance,
which turned one step (pick an import URL) into an unassisted research task
instead of a documented, copy-pasteable pattern.
