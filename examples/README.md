# Examples

Runnable scripts against the built package (`npm run build` first). Each
example imports from `../dist/`; a consuming app would instead import from
`@jxburros/ai-handler` / `@jxburros/ai-handler/agent`.

| File | Shows |
|---|---|
| `ollama.mjs` | Streaming chat against a local Ollama server |
| `llamacpp.mjs` | Non-streaming chat against a local llama.cpp server (`modelOptional` quirk) |
| `agent-prompt-json.mjs` | `toolMode: 'promptJson'` — the universal tool-calling fallback for small/local models |
| `agent-native-tools.mjs` | `toolMode` left unset — `auto` resolves to native tool-calling for a hosted provider |
| `agent-approval-gate.mjs` | An `ApprovalGate` allowing, denying, and rewriting a side-effecting tool call |
| `telemetry.mjs` | The `TelemetrySink` seam — one redacted `CallRecord` per call |
| `model-picker.mjs` | Model-agnostic picker: server-side connection allowlist, `listModels()` with per-connection fallback, defaults to local Ollama (no key needed) |

## Running

```bash
npm run build

# Local runtimes (no key needed)
node examples/ollama.mjs            # requires `ollama pull llama3.2` running locally
node examples/llamacpp.mjs          # requires llama-server on :8080
node examples/agent-prompt-json.mjs # requires Ollama, as above
node examples/model-picker.mjs      # requires Ollama, as above; set OPENAI_API_KEY etc. to also list hosted connections

# Hosted (requires OPENAI_API_KEY)
OPENAI_API_KEY=sk-... node examples/agent-native-tools.mjs
OPENAI_API_KEY=sk-... node examples/agent-approval-gate.mjs
OPENAI_API_KEY=sk-... node examples/telemetry.mjs
```

None of these run in CI — they hit real local or hosted endpoints, same as
`tests/live-smoke.test.ts`.
