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
