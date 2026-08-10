# AI Nugget — Secret Census Integration Report

**Source of evidence:** Secret Census (`@jxburros/ai-nugget` consumer, browser-only)
**Date:** 2026-08-10
**Author:** Claude
**Nugget version in the field:** `@jxburros/ai-nugget@0.6.0` (vendored `nugget/dist`, not npm — no registry credentials were reachable from the integration environment)
**Consumer PR:** [jxburros/Secret-Census#206](https://github.com/jxburros/Secret-Census/pull/206) (merged)

---

## TL;DR (verdict)

This was a clean migration with no library-side blockers. Secret Census's AI
chat sidebar previously called `@google/genai`, `@anthropic-ai/sdk`, and
`openai` directly, with a hand-rolled response-parsing branch per provider, plus
a fourth hand-rolled `fetch` per provider just to list models in Settings. All
of that collapsed into one `AIHandler.chat()` call, one `AIHandler.listModels()`
call, and a small per-app `Connection` resolver. Net effect: `ChatSidebar.tsx`
lost 92 lines, `Modals.tsx` lost 70, three runtime SDK dependencies were
removed, and the full test suite, typecheck, and production build were
unaffected.

The friction that did surface was entirely **documentation-shaped, not
code-shaped** — every gap below was closed by reading adapter source
(`profiles.ts`, `openaiChat.ts`) rather than hitting a missing capability. That's
a much better failure mode than AI Server Studio's report found (missing
`providerOptions`/tool-capability escape hatches), and it suggests the 0.5.0/0.6.0
gaps that report drove have mostly closed the code-shaped problems. What's left
is smaller: two doc gaps and one API-ergonomics gap in `chatParsed`.

---

## How the two projects fit together

Secret Census is a browser-only Vite app (IndexedDB-backed, no server) with a
"Context-Aware Assistant" chat sidebar that reads/writes the user's world data
(NPCs, locations, items, plot hooks) via structured JSON extraction from model
replies. It treats the nugget purely as the provider-calling seam — model
choice, system prompts, structured-extraction schema, and the entity-resolution
logic that turns extracted JSON into app records are all app-owned, per the
nugget's own scope boundary.

The seam lives in `src/lib/ai-provider.ts` (a single `AIHandler` instance,
`literalKeySource()`, and a `resolveProviderConnection()` mapping the app's
existing provider setting to a `Connection`) and is consumed from
`ChatSidebar.tsx` (`handler.chat()`) and `Modals.tsx` (`handler.listModels()`
for the Settings model picker).

---

## What worked well

- **`result.text` normalization across wire formats.** Google's content
  response, Anthropic's forced-tool JSON (`json_output` tool + `tool_choice`),
  and OpenAI's `response_format` all land in `ChatResult.text`. The old
  per-provider response-parsing branch (Google's `.text`, Anthropic's
  `tool_use` content block, OpenAI's `choices[0].message`) was deleted outright
  — the app's downstream JSON-extraction pipeline never has to know which
  provider answered.
- **The `openai-compat` escape hatch preserved existing behavior exactly.**
  Secret Census's "local" and "custom" providers already pointed a plain
  OpenAI-shaped client at a user-supplied base URL (Ollama, LM Studio, or
  anything else). Mapping both straight to `openai-compat` with that same base
  URL kept every existing user configuration working with no migration step
  and no settings-schema change.
- **Typed `AIError.kind` replaced string-sniffing.** The prior code surfaced
  whatever `error.message` a given SDK happened to throw. Branching on `kind`
  (`rate_limit`, `auth`, `key_unavailable`, `context_length`, `invalid_response`,
  `not_found`, `network`, `timeout`) made a small, honest chat-UI error-message
  table possible instead of guessing what a raw fetch failure meant.
- **`listModels()` collapsed four hand-rolled fetches into one call.** Google's
  `models?key=`, Anthropic's `/v1/models` with `x-api-key`, Ollama's
  `/api/tags` with an OpenAI-compat fallback, and OpenAI's `/v1/models` all
  became `aiHandler.listModels(connection)`.
- **The vendored `nugget/dist` path worked exactly as documented.** No registry
  was reachable from the integration environment (no `GITHUB_TOKEN` for GitHub
  Packages), so the vendored fallback carried the whole integration.
  `VERSION.txt`'s version-plus-content-hash stamp made the copy traceable, and
  `distribution.md`'s guidance to vendor compiled `dist/` rather than
  `nugget/src` (because of bundler `.ts`/`.js` resolution quirks) held up with
  zero adjustment needed in Vite.

---

## The friction catalogue

### FR-1 — `chatParsed` has no seam for an app's own fallback parser (Medium)

`chatParsed`'s contract is: request JSON mode, validate against a Standard
Schema, one corrective retry showing the model its own error, then throw
`invalid_response` if still invalid (`src/handler.ts:289-307`). Secret Census
already had a legacy fallback for models that ignore JSON mode entirely — a
text-block parser for hand-written ```` ```json:create ```` /
```` ```json:update ```` fences. There's no way to tell `chatParsed` "if
still invalid after your retry, hand me the raw text instead of throwing" —
so the integration dropped to the raw `chat()` call and re-implemented the
request/validate loop by hand (`Secret-Census/src/lib/ai-resolve.ts`,
`executeSecureExtraction`), which is close to the exact boilerplate
`chatParsed` exists to remove.

**Suggested fix:** an optional `chatParsed` option, e.g.
`onInvalid?: (text: string, error: AIError) => T | undefined`, called after the
one corrective retry is exhausted, in place of the throw, when supplied.

### FR-2 — No doc guidance for choosing `ollama` vs. `openai-compat` for a local runtime (Low)

The two engines assume different base-URL shapes: `ollama`'s native
`/api/tags` expects a bare host, `openai-compat`'s `/models` expects a
`/v1`-suffixed URL (`src/adapters/profiles.ts:146-180`). An app migrating an
existing "local AI" setting has to know which convention its *already-stored*
endpoint values follow before picking a provider name, and that distinction
currently only lives in `profiles.ts`, not in `providers.md` or `recipes.md`.

**Suggested fix:** a short decision note or table in `providers.md` next to the
local-runtime entries: `ollama` (native API, bare host, `/api/tags`) vs.
`openai-compat` (OpenAI-shaped server, already `/v1`-suffixed).

### FR-3 — OpenAI's non-strict `json_schema` behavior isn't documented where a consumer would look (Low)

`openaiChat.ts`'s `responseFormatFor` always emits
`{ type: 'json_schema', json_schema: { name, schema } }` with no `strict` key
(`src/adapters/engines/openaiChat.ts:172-178`), i.e. always non-strict. Secret
Census's extraction schema deliberately allows a free-form `data` object,
which OpenAI's strict mode rejects — confirming the request would be accepted
meant reading adapter source directly rather than the JSON-mode section of
`recipes.md`.

**Suggested fix:** one line in `recipes.md`'s "JSON output + validation"
section: schemas passed via `responseFormat.schema` are always sent
non-strict; set `additionalProperties: false` in the schema yourself if
provider-side strict validation is wanted.

### FR-4 — A vendored copy carries no breadcrumb back to its origin (Low)

`VERSION.txt` precisely stamps version + content hash, but nothing inside
`nugget/dist` itself says what repo it came from. A future maintainer who
lands in a consumer's `src/vendor/ai-nugget/` without the surrounding commit
message has only a hash to go on.

**Suggested fix:** have `build:nugget` emit a one-line header comment in the
generated `index.js` (or a stub `README.md` next to `VERSION.txt`) naming the
source repository and version, e.g.
`// Vendored from https://github.com/jxburros/AI-Nugget @ 0.6.0 — do not hand-edit.`

### FR-5 — The `AIError.kind` → user-facing-message table is reinvented per consumer (Low)

`recipes.md` already ships an HTTP-status mapping table for server apps
mapping `kind` to a status code and message. A browser chat UI needs the same
mapping shape but without the HTTP layer — Secret Census hand-wrote an
8-entry `Partial<Record<AIError['kind'], string>>` table
(`Secret-Census/src/components/ChatSidebar.tsx`) that any other chat-UI
consumer would likely rewrite close to verbatim.

**Suggested fix:** an optional exported default map (e.g.
`defaultErrorCopy: Partial<Record<AIErrorKind, string>>`) apps can spread and
override, analogous to the existing HTTP-status recipe.

---

## By the numbers

| File | Added | Removed | Net |
|---|---:|---:|---:|
| `src/components/ChatSidebar.tsx` | +37 | −129 | −92 |
| `src/components/Modals.tsx` | +6 | −76 | −70 |
| `package.json` (runtime deps) | +0 | −3 | −3 SDKs (`@google/genai`, `@anthropic-ai/sdk`, `openai`) |

Full unit test suite (47 tests), `tsc --noEmit`, and `vite build` all passed
unchanged after the migration.

---

## Scope note

This reflects one consumption pattern: a browser-only app vendoring the
compiled `dist/` fallback, using `literalKeySource()` for user-supplied keys,
calling `chat()`/`listModels()` directly rather than `chatParsed()` or the
agent-loop module. A Node server consumer via npm, or an app leaning on
`chatParsed` and `/agent`, would likely surface a different set of friction
points.
