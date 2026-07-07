# AI Nugget npm mini-apps

Three small, intentionally different apps that consume the **published npm package**, not a relative import from this repository.

Each folder is independent:

- `prompt-mirror` — one thought in, four reflection cards out.
- `release-room` — a release-task dump becomes a three-item sprint.
- `town-radio` — a turn-based interactive fiction bulletin with changing meters.

## Verify the registry package

From any example directory:

```bash
npm install
npm run verify
OPENAI_API_KEY=... npm run dev
```

`npm install` resolves `@jxburros/ai-nugget@^0.3.1` from npm. `npm run verify` checks that Node can import the installed package and that the server source parses. Each server keeps provider credentials in its own process and accepts `AI_PROVIDER`, `AI_MODEL`, and `AI_KEY_ENV` overrides.

## Recipes these apps follow

Each server applies the two integration recipes documented in the root
[`README.md`](../../README.md#recipes):

- **JSON output + validation** — the model reply is parsed with
  `extractJsonWithSchema` plus a small per-app schema built from `json.ts`'s
  `require*` guards, instead of a regex + `JSON.parse`. A reply missing a
  field, wrong-shaped, or wrapped in prose fails with a typed
  `AIError('invalid_response')` instead of a raw parse crash.
- **Error handling matrix** — each app's `ai-error-map.mjs` maps `AIError.kind`
  to an HTTP status and a safe, generic user-facing message, so a missing key
  or a rate limit doesn't leak `error.message` to the browser.

`envConnection()` (added to the library alongside this recipe set) is the
recommended replacement for the hand-rolled `AI_PROVIDER`/`AI_MODEL`/`AI_KEY_ENV`
block at the top of each `server.mjs`. These apps still build that block
manually because they pin `@jxburros/ai-nugget@^0.3.1`, and `envConnection`
ships in the next release — switch once these apps bump their dependency.
