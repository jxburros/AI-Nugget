# ai-handler

`ai-handler` is a small, dependency-free TypeScript nugget for talking to AI model providers through one pipeline:

policy -> key resolution -> hooks -> concurrency/retry -> provider adapter -> redacted telemetry.

It is intentionally not a router, prompt library, memory system, or secrets vault. Apps choose models, own prompts, store secrets, and decide what policy to enforce.

## What Is Implemented

- Message-based public contracts in `src/types.ts`.
- Typed `AIError` classification in `src/errors.ts`.
- Timeout/abort merging plus SSE and NDJSON readers in `src/transport.ts`.
- Defensive JSON extraction and schema guard helpers in `src/json.ts`.
- Token estimation with explicit `estimated` usage.
- Env/literal/memory key sources and key-ref parsing.
- Default redactor with common secret patterns plus resolved-key substring redaction.
- Neutral governance helpers: `blocklistPolicy`, `allowlistPolicy`, `composePolicies`.
- Provider profile table and a single `adapterFor()`.
- `AIHandler` pipeline with retries, concurrency limit, minimum interval, hooks, redacted telemetry, `chat`, `stream`, `listModels`, and `testConnection`.
- A minimal `ai-handler/agent` loop with tool schemas, validation, approval gates, budgets, cancellation, and prompt-JSON fallback support.

The protocol engines are practical first implementations for OpenAI-compatible, Anthropic, Google Gemini, and Ollama chat calls. The fixture-heavy contract suite described in the design documents should be expanded before adopting this package across all portfolio repos.

## Commands

```bash
npm install
npm test
npm run build
npm run build:nugget
```

`npm run build:nugget` writes a vendorable `nugget/` folder stamped with version and a content hash.
