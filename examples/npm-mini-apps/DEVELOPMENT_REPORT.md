# Development report: AI Nugget npm mini-app examples

## Scope and evidence

This report records what was encountered while creating the three example applications in this directory:

- `prompt-mirror`
- `release-room`
- `story-choice`

It separates **AI Nugget observations**, **example-app shortcomings**, and **authoring-environment limitations**. It does not claim that a live model request succeeded: the authoring environment could not resolve npm or GitHub over DNS, so no `npm install` or provider-backed request could be run there.

## What worked cleanly

- The package has a compact entry point: `AIHandler` plus `envKeySource` are enough to establish a server-side integration.
- The `Connection` shape keeps the security boundary visible. The examples retain provider choice, key references, and API-key resolution on the server instead of accepting them from browser input.
- The provider-neutral call shape allowed all three applications to share an integration while keeping very different product behavior.
- Each example consumes `@jxburros/ai-nugget@^0.3.1` by package name, not a repository-relative `dist` import.

## AI Nugget integration friction

### 1. Repeated connection setup in very small apps

Each app independently creates an `AIHandler`, chooses `envKeySource`, declares a `Connection`, selects a model, and maps an HTTP request into `handler.chat()` input.

**Impact:** this is clear and appropriately explicit for a low-level library, but it is repetitive across several small server apps.

**Possible improvement:** provide either a copyable documentation recipe or a deliberately small optional helper that resolves app-owned `AI_PROVIDER`, `AI_MODEL`, and `AI_KEY_ENV` configuration. It must preserve the important rule that provider and base URL are never client-controlled.

### 2. Structured output still requires application validation

The examples ask the model for JSON, extract the first apparent JSON object with a regular expression, and call `JSON.parse`.

**Impact:** this is minimal but brittle. A model can return prose before JSON, malformed JSON, an array, or a schema-incomplete object. The current result is a generic server failure rather than a useful app-level validation error.

**Possible improvement:** add one canonical end-to-end recipe for JSON mode plus response validation. The recipe should show parse failure handling and schema validation without implying that the library replaces a real schema validator.

### 3. Application-facing error handling is still app work

For a small demo, exposing `error.message` is sufficient. A real app must distinguish missing keys, invalid credentials, unsupported models, provider failures, rate limits, and invalid model output before returning something to the browser.

**Possible improvement:** document a concise error-handling matrix using the library's error classification, with guidance on logging versus user-facing messages.

### 4. Live validation could not be performed during authoring

This was not an AI Nugget failure. The authoring environment had no DNS access to npm or GitHub, preventing a registry installation and real provider request.

**Mitigation now in the repository:** the mini-app workflow runs `npm install` and `npm run verify` for every example. This validates that the published npm package can be resolved and imported in GitHub Actions.

**Remaining gap:** the workflow has no provider credential and does not perform a live model request. It cannot confirm key resolution, model availability, provider response handling, or end-to-end HTTP behavior.

## Example-app shortcomings

These are limitations of the examples, not necessarily AI Nugget itself.

### Prompt Mirror

- Uses the brittle JSON extraction noted above.
- Lacks loading, retry, input-length feedback, and a response-sanitization strategy.
- Is a demo and must not be represented as counseling, diagnosis, or crisis support.

### Release Room

- Renders formatted JSON rather than a polished sprint board.
- Does not validate that exactly three tasks were returned or that duration fields are numeric.
- Has no persistence, editing, reordering, or export.

### Story Choice

- Displays a generated opening turn but does not yet render returned choices as clickable actions, so it is not a complete turn loop.
- Does not visibly show action history or accumulated state.
- Treats model-supplied meter values as trusted rather than validating the expected numeric range.

## CI limitation

The example workflow uses `npm install`, not `npm ci`, because the examples do not yet have committed lockfiles.

**Tradeoff:** it demonstrates that the npm dependency range resolves, but it does not ensure deterministic dependency resolution across time.

**Recommended follow-up:** commit a lockfile per example, or convert the examples into a workspace with one root lockfile, then replace `npm install` with `npm ci` in CI.

## Recommended next steps

1. Confirm the GitHub Actions result for npm installation and import.
2. Turn the raw JSON example outputs into complete small interfaces, especially the Story Choice action loop.
3. Add an optional credential-gated live smoke test for local or protected CI use; keep it disabled for forks and never expose provider keys.
4. Add a canonical JSON-output-and-validation recipe to the documentation.
5. Decide whether an optional environment-connection helper is warranted, or whether documentation is enough.

## Bottom line

AI Nugget was suitable for the core server-side provider call in all three examples. The main friction was the normal surrounding application work: connection configuration, structured-output validation, HTTP-level error presentation, and end-to-end testing with real credentials. These examples are integration demonstrations, not production templates, until the listed example-level gaps are addressed.
