# Examples

Runnable, self-contained integrations of `ai-handler`. Each file imports from the
package (`@jxburros/ai-handler` / `@jxburros/ai-handler/agent`) exactly as an app
would; a vendoring app swaps those specifiers for `../nugget/src/index.js` (see
`docs/MIGRATION.md`).

| File | Shows |
|---|---|
| `basic-chat.ts` | Buffered `chat()` and streamed `stream()` against a cloud provider, key from env |
| `streaming-sse-route.ts` | Transcribing the normalized `StreamEvent` iterable into a Node SSE HTTP route |
| `agent-tools.ts` | `runAgent()` with a validated tool, an approval gate, and budgets |
| `local-ollama.ts` | A keyless local provider, `testConnection`, `listModels`, and `toolMode: 'auto'` |
| `governance-telemetry.ts` | Wiring `allowlistPolicy`, a `Redactor`, and a `TelemetrySink` at the seams |

These are illustrative sources, not part of the compiled package (`tsconfig`
compiles only `src/`), so they never enter `dist/` or the drift check.
