# Steel Mill Chat

A simple industrial-themed chatbot demo powered by `@jxburros/ai-nugget`.

## Run

```bash
npm install
npm run demo:steel-chat
```

Then open `http://localhost:3210`.

## Connections

- `ollama` is always available by default and uses `OLLAMA_MODEL` or `llama3.2`.
- `openai`, `anthropic`, and `google` appear automatically when their API-key env vars are set.

## Quirky bits

- `Forge Mode` turns the assistant into a slightly more theatrical mill operator.
- `Spark Me` drops in a random metal-flavored prompt starter when you want inspiration.
