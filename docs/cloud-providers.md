# Hosted and cloud providers (0.7.5)

All calls below use `AIHandler`, including policy, credentials, cancellation,
retries and redacted telemetry. No provider SDK is a runtime dependency.
The new integrations are **mock-verified in Node and Chromium**, not live-verified.
No paid provider credentials were available for this release's local validation.

## Profiles and endpoint selection

| Profile | Default base URL / required configuration | Implemented operations |
|---|---|---|
| `minimax` | `https://api.minimax.io/v1` | Chat, streaming, tool/reasoning replay |
| `zai` | `https://api.z.ai/api/paas/v4` | Chat, streaming, tool/reasoning replay |
| `dashscope` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (Singapore) | Compatible chat/Responses and embeddings |
| `huggingface` | `https://router.huggingface.co/v1` | Chat, model listing; preserves `organization/model:provider` IDs |
| `deepinfra` | `https://api.deepinfra.com/v1/openai` | Chat, embeddings, model listing |
| `sambanova` | `https://api.sambanova.ai/v1` | Chat, Responses, model listing |
| `nvidia` | Explicit NIM `baseUrl`, including `/v1` | Compatible chat/Responses/embeddings/listing as exposed by the deployed NIM |
| `cloudflare` | `cloud.accountId` or explicit account-scoped `baseUrl` | Chat, embeddings; buffered Responses for supported GPT-OSS models |
| `bedrock` | `cloud.region` or explicit `baseUrl` | Runtime Chat/Responses, optional Mantle/listing; native Converse/ConverseStream |
| `vertex` | `cloud.project` and `cloud.location`, or explicit `baseUrl` | OpenAI-compatible chat on Google Cloud |
| `azure-openai-v1` | Explicit resource URL ending in `/openai/v1` | Chat, Responses, embeddings, model listing where authorized |

The original `azure-openai` profile still uses deployment URLs with `api-version`.
Existing connections keep their wire protocol. Choose `protocol: 'responses'`
or `protocol: 'converse'` explicitly. A profile is not a guarantee that every
model on that service supports every operation. Model IDs remain caller-owned.
NIM keeps conservative local model/tool defaults; use the agent's existing
`nativeTools`/`modelCapabilities` override for a known tool-capable deployment.

An explicit `baseUrl` always wins over generated coordinates. Use it for private
gateways, sovereign cloud partitions, regional endpoints, or alternative plans.
For example, Z.AI's coding-plan endpoint is `https://api.z.ai/api/coding/paas/v4`;
Alibaba's legacy Beijing compatible endpoint is
`https://dashscope.aliyuncs.com/compatible-mode/v1`. Credentials must match the
selected service/region/workspace. The library never reroutes between them. For recommended Alibaba workspace
hosts, supply `cloud: { workspace: 'workspace-id', region: 'ap-southeast-1' }`
(or the region matching your workspace). This constructs
`https://{workspace}.{region}.maas.aliyuncs.com/compatible-mode/v1` for chat or
Responses; legacy shared domains remain supported.

MiniMax, Z.AI, DashScope, Cloudflare and Vertex have no configured lightweight
probe. `testConnection` reports that limitation instead of claiming success;
`listModels` returns an empty list when listing is unavailable. Validate such a
connection with an explicit model call. Bedrock Converse has the same limitation
because model discovery belongs to a separate AWS control-plane API.

## Refreshable cloud tokens

`KeySource.resolve` already runs for each logical call. Supply a broker that
refreshes OAuth/Entra tokens as needed; use provider SDKs in the application,
not the nugget. A cached SDK credential client should handle expiration.

```ts
import { AIHandler, type KeySource, type Connection } from '@jxburros/ai-nugget';

// getAccessToken is supplied by the app's Google/Azure credential client.
const keySource: KeySource = {
  async resolve(ref) {
    if (ref.kind !== 'brokered' || ref.ref !== 'cloud-token') {
      return { ok: false, reason: 'denied' };
    }
    const token = await getAccessToken();
    return token ? { ok: true, apiKey: token } : { ok: false, reason: 'missing' };
  },
};
const handler = new AIHandler({ keySource });
const vertex: Connection = {
  id: 'vertex', provider: 'vertex',
  cloud: { project: 'my-project', location: 'us-central1' },
  keyRef: { kind: 'brokered', ref: 'cloud-token' },
};
const azure: Connection = {
  id: 'azure', provider: 'azure-openai-v1',
  baseUrl: 'https://my-resource.openai.azure.com/openai/v1',
  auth: 'bearer', protocol: 'responses',
  keyRef: { kind: 'brokered', ref: 'cloud-token' },
};
```

`auth: 'bearer'` also works with the legacy Azure profile for Entra credentials.
Use `auth: 'api-key-header'` when the deployment requires that API-key header.
Tokens are resolved once per logical call, not automatically refreshed after a
401; the application credential source must return a valid token initially.

## AWS Bedrock authentication and protocols

For a Bedrock API key, use the normal env/stored/brokered KeySource and bearer
authentication. `protocol` selects different endpoint families:

```ts
const runtime = {
  id: 'bedrock', provider: 'bedrock', cloud: { region: 'us-east-1' },
  protocol: 'responses', keyRef: { kind: 'env', name: 'BEDROCK_API_KEY' },
} satisfies Connection;
// https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses
const mantle = { ...runtime, cloud: { region: 'us-east-1', bedrockEndpoint: 'mantle' } } satisfies Connection;
// https://bedrock-mantle.us-east-1.api.aws/v1/responses

const native = { ...runtime, protocol: 'converse' } satisfies Connection;
// https://bedrock-runtime.us-east-1.amazonaws.com/model/{encoded-model-id}/converse-stream
```

Runtime is the AWS-recommended default for new compatible API applications.
It has no OpenAI-compatible model listing and does not support every Mantle
model/feature (including GPT-OSS Responses). Mantle remains explicitly selectable;
some Mantle models require an `/openai/v1` base URL override instead of `/v1`.
Choose from the model's endpoint-specific documentation; there is no silent fallback.

For IAM/SigV4, return an `authorize` function from `KeySource.resolve`:

```ts
const awsKeys: KeySource = {
  async resolve(ref) {
    if (ref.kind !== 'brokered' || ref.ref !== 'aws') return { ok: false, reason: 'denied' };
    return {
      ok: true, apiKey: null,
      // App-owned SDK signer configured for the endpoint's signing service/region.
      authorize: request => awsSigner.sign(request),
    };
  },
};
```

`awsSigner.sign` denotes the application's Web Request adapter around its chosen
signer (for example aws4fetch, or an adapter for the AWS SDK signer). It is not a
Nugget export. Use the AWS-documented signing service for the selected endpoint.
Refresh temporary IAM credentials in that signer. It receives the **final**
URL/method/body for every HTTP attempt, including retries and probes. Return a
signed Web `Request`, preserving its body and endpoint. Signing is bounded by
the engine's cancellation/timeout signal. Signer exceptions are sanitized;
the signer and resolved credentials are never exposed to `beforeCall` hooks.

`HandlerOptions.fetch` optionally supplies a proxy/custom transport across all
engines. It is invoked after signing; it must preserve the supplied abort signal
and must not rewrite a signed URL or body. The default is global `fetch`.

Native Converse supports text/image input, system messages, function tools,
parallel tool results, usage, and reasoning signatures. Set
`providerOptions: { stream: false }` for buffered `/converse` calls. The streaming
decoder validates frame lengths/CRCs and reports truncated or exception frames
as typed errors. Use `additionalModelRequestFields` for model-specific reasoning
and `outputConfig` for a model-supported JSON schema. The generic knobs fail
explicitly where a portable mapping isn't available. Native InvokeModel, control
plane administration and bidirectional audio are not implemented here.

## Responses and replay

The Responses engine maps messages, function calls/results, output text,
JSON schemas, usage and terminal status. It emits annotations/refusals/native
output as `context` events and stores complete output items in `providerState`.
Pass that state back unchanged on the assistant message; `runAgent` does this
automatically. Reasoning state is scoped to the same provider, model and protocol.
Cloudflare Responses is buffered and restricted by the service to supported
GPT-OSS models; the engine emits a `buffered_response` context event.

The newly added compatible chat profiles preserve assistant reasoning/tool
state too. In particular, MiniMax's inline `<think>` content stays in replay
state even though the default handler removes it from visible answer text.
Use `providerOptions` for model-specific thinking controls (including effort
values beyond the portable vocabulary). No model routing or effort selection
is performed automatically. This does not replace the broader capability work
listed in the audit.

## Official protocol references

- [MiniMax compatibility and replay](https://platform.minimax.io/docs/api-reference/text-openai-api)
- [Z.AI endpoints](https://docs.z.ai/guides/overview/quick-start)
- [Alibaba compatibility](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)
- [Hugging Face routing](https://huggingface.co/docs/inference-providers/index)
- [DeepInfra compatibility](https://docs.deepinfra.com/chat/overview)
- [SambaNova Responses](https://sambanova.ai/blog/build-faster-coding-agents-with-sambanovas-responses-api)
- [NVIDIA NIM APIs](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)
- [Cloudflare compatibility and restrictions](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
- [Bedrock model/API compatibility](https://docs.aws.amazon.com/bedrock/latest/userguide/models-api-compatibility.html)
- [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)
- [Vertex compatible endpoint](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/openai)
- [Azure v1](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)

References reviewed 2026-10-27. Live results must be recorded separately from
these documentation checks and deterministic contract tests.

## Live validation configuration

The Live provider matrix workflow accepts a manual provider, model, base URL,
protocol and repository-secret name. Disable probes for providers without a
listing/health endpoint. Native tools must actually execute and finish in the
smoke test. The scheduled original-provider matrix uses repository variables
`OPENAI_SMOKE_MODEL`, `ANTHROPIC_SMOKE_MODEL`, `GOOGLE_SMOKE_MODEL` and
`OPENROUTER_SMOKE_MODEL`; it skips explicitly when model/key configuration is
missing. This avoids silently testing retired hard-coded model IDs.
