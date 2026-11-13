import type { KnownProvider } from './adapters/profiles.js';

export type { KnownProvider };

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * One piece of multimodal message content. `text` parts carry `text`; every
 * other kind carries its bytes as base64 (`dataBase64`, or the legacy
 * `imageBase64` for images) or a provider-reachable `url`, plus a `mimeType`.
 * Each engine maps the kinds its protocol supports and fails with a typed
 * `invalid_request` for the rest — a part is never silently dropped.
 */
export interface ContentPart {
  type: 'text' | 'image' | 'audio' | 'video' | 'file';
  text?: string;
  /** Base64 image bytes (kept for compatibility; `dataBase64` works for images too). */
  imageBase64?: string;
  /** Base64 bytes for image, audio, video or file parts (no `data:` prefix). */
  dataBase64?: string;
  /** A URL the provider can fetch itself (https, a provider file URI, or a `data:` URL). */
  url?: string;
  mimeType?: string;
  /** File name for `file` parts (several providers require one for documents). */
  filename?: string;
}

/** Non-text output a model returned in-band with a chat response (generated image, speech). */
export interface MediaOutput {
  type: 'image' | 'audio' | 'file';
  mimeType: string;
  /** Base64 bytes, when the provider returned them inline. */
  dataBase64?: string;
  /** A provider-hosted URL, when the provider returned a link instead of bytes. */
  url?: string;
  /** Transcript or caption the provider attached (e.g. spoken audio's text). */
  transcript?: string;
}

/** Opaque provider response content, for replay within the same model/tool workflow.
 * Keep it unmodified; never include it in telemetry or display it as answer text. */
export interface ProviderState {
  provider: string;
  model: string;
  protocol?: Connection['protocol'];
  content: Record<string, unknown>[];
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  providerState?: ProviderState;
  toolCalls?: ToolCall[];        // role: 'assistant'
  toolCallId?: string;           // role: 'tool' — answers a specific call
  name?: string;                 // role: 'tool' — the tool's name (Gemini keys
                                 // function responses by name, not id)
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  raw?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: object;
}

/**
 * How hard a reasoning-capable model should think before answering. The nugget
 * maps one vocabulary onto each provider's own knob (see `docs/providers.md`,
 * "Reasoning effort"): OpenAI `reasoning_effort`, Anthropic `thinking`
 * (`budget_tokens` tiers), Google `generationConfig.thinkingConfig.thinkingBudget`,
 * Ollama `think`. `'none'` disables reasoning where the provider allows it;
 * `'xhigh'` and `'max'` reach the deepest tiers of providers that have them
 * (OpenAI GPT-5.2+, Claude adaptive effort, Meta Muse, Kimi K3) and are sent
 * as-is, so a provider without them answers with an honest 400.
 * Unset means the provider's own default — the nugget never sends the knob
 * unasked, because non-reasoning models reject it.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /**
   * Reasoning effort for thinking-capable models — see {@link ReasoningEffort}.
   * A provider-native value in `providerOptions` (e.g. `reasoning_effort`,
   * `thinking`, `thinkingConfig`, `think`) wins over this on collision.
   */
  reasoningEffort?: ReasoningEffort;
  responseFormat?: { type: 'text' } | { type: 'json'; schema?: object };
  tools?: ToolSchema[];
  toolChoice?: 'auto' | 'none' | { name: string };
  stopSequences?: string[];
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  /**
   * Provider-native request fields the nugget does not model as first-class
   * options — an escape hatch so a caller can reach a capability without waiting
   * for a library release. Merged into the outgoing provider request body:
   * shallow at the top level, and one level deep into the provider's own nested
   * option container (Ollama `options`, Google `generationConfig`). Examples:
   * `{ options: { num_ctx: 8192 }, keep_alive: '30m' }` (Ollama),
   * `{ reasoning_effort: 'high' }` (OpenAI), `{ thinking: { type: 'enabled' } }`
   * (Anthropic), `{ safetySettings: [...] }` (Google). Values here win over the
   * nugget's own fields on a key collision, so use with care.
   */
  providerOptions?: Record<string, unknown>;
  /**
   * Portable prompt-cache controls. `key` groups requests that share a prefix
   * (OpenAI-family `prompt_cache_key`); `retention: 'extended'` asks for the
   * provider's longer cache lifetime (Anthropic `ttl: '1h'`, OpenAI 24h/12h).
   * Anthropic turns on automatic caching whenever this is set. Providers with
   * no request-level control emit a `prompt_cache_unsupported` context event.
   */
  promptCache?: { key?: string; retention?: 'default' | 'extended' };
  /**
   * Remote MCP servers the *provider* connects to and calls on the model's
   * behalf (Anthropic MCP connector, Responses `mcp` tools). Tokens enter
   * through `KeySource` like API keys; `GovernancePolicy.checkMcpServer` can
   * allow or deny each URL. Other engines fail with `invalid_request`.
   */
  mcpServers?: McpServer[];
}

/** A provider-hosted MCP server connection — see {@link ChatRequest.mcpServers}. */
export interface McpServer {
  /** Unique label for this server within the request. */
  name: string;
  /** Public `https://` URL of the MCP server (Streamable HTTP or SSE). */
  url: string;
  /** OAuth/bearer token for the server, resolved through the handler's `KeySource`. */
  authorization?: KeyRef;
  /** Restrict which of the server's tools the model may call. */
  allowedTools?: string[];
  /** Responses only: whether the provider pauses for approval before each call (provider default: `always`). */
  requireApproval?: 'always' | 'never';
}

/** Rate-limit state reported by a provider's response headers, normalized. */
export interface RateLimitInfo {
  /** Requests remaining in the current window. */
  remainingRequests?: number;
  /** Tokens remaining in the current window. */
  remainingTokens?: number;
  limitRequests?: number;
  limitTokens?: number;
  /** Milliseconds until the exhausted (or soonest) quota resets. */
  resetMs?: number;
  /** IETF `RateLimit` / `RateLimit-Policy` entries, when the provider sends them. */
  policies?: Array<{ name: string; remaining: number; resetSeconds?: number; quota?: number; windowSeconds?: number; unit?: string }>;
}

export interface Connection {
  id: string;
  /**
   * A provider with a profile in the table, or any other string — an unknown
   * key with a `baseUrl` resolves through the `openai-compat` escape hatch.
   * The union is there for autocomplete and typo-catching; the `string & {}`
   * arm keeps the escape hatch open.
   */
  provider: KnownProvider | (string & {});
  baseUrl?: string;
  /** Select the wire protocol explicitly; existing connections keep their default. */
  protocol?: 'chat-completions' | 'responses' | 'converse';
  /** Cloud endpoint coordinates. An explicit baseUrl takes precedence. */
  cloud?: { region?: string; project?: string; location?: string; accountId?: string; workspace?: string; bedrockEndpoint?: 'runtime' | 'mantle' };
  /** Override the profile's key header (e.g. Azure Entra bearer tokens). */
  auth?: 'bearer' | 'api-key-header';
  keyRef?: KeyRef;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /**
   * Idle timeout for streaming calls: aborts the stream only if no bytes arrive
   * for this many milliseconds, resetting on every chunk. Distinct from
   * `timeoutMs`, which bounds the total call lifetime. Set this (and a generous
   * `timeoutMs`) for long local generations that stream slowly but healthily.
   */
  idleTimeoutMs?: number;
}

export type KeyRef =
  | { kind: 'none' }
  | { kind: 'env'; name: string }
  | { kind: 'literal'; value: string }
  | { kind: 'stored'; ref: string }
  | { kind: 'brokered'; ref: string };

export interface KeySource {
  resolve(ref: KeyRef): Promise<
    | { ok: true; apiKey: string | null; authorize?: RequestAuthorizer }
    | { ok: false; reason: 'missing' | 'locked' | 'denied' }
  >;
}

/** Optional SDK-backed signing seam (e.g. AWS SigV4). Credentials stay in KeySource.
 * Called for each HTTP attempt with the final URL/body and a bounded signal.
 * Return a signed Request; preserve its URL, method, body and signal. */
export type RequestAuthorizer = (request: Request) => Promise<Request>;

export interface ResolvedConnection extends Connection {
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
  /** Internal transport bound by the handler; never exposed to hooks. */
  fetch?: typeof fetch;
}

export interface Usage {
  /** All prompt tokens, including any read from or written to a prompt cache. */
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt tokens served from the provider's cache (a subset of `inputTokens`). */
  cachedInputTokens?: number;
  /** Prompt tokens written to the provider's cache on this call (a subset of `inputTokens`). */
  cacheWriteTokens?: number;
  estimated: boolean;
}

export interface ChatResult {
  text: string;
  /** Provider rate-limit headers from the final attempt, normalized. */
  rateLimit?: RateLimitInfo;
  /** Images/audio the model generated in-band (Gemini image output, chat audio, Responses image generation). */
  media?: MediaOutput[];
  providerState?: ProviderState;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'length' | 'tool' | 'content_filter' | 'error' | 'canceled';
  usage: Usage;
  timing: { firstTokenMs: number | null; totalMs: number };
  model: string;
  source: ModelSource;
  raw?: unknown;
}

export interface ModelSource {
  provider: string;
  connectionId: string;
  baseUrl?: string;
}

export interface EmbedRequest {
  model: string;
  /** One string, or a batch of strings embedded in a single call. */
  input: string | string[];
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  /** Provider-native passthrough, same contract as {@link ChatRequest.providerOptions}. */
  providerOptions?: Record<string, unknown>;
}

export interface EmbedResult {
  /** One vector per input, in input order. */
  embeddings: number[][];
  model: string;
  usage: Usage;
  source: ModelSource;
  raw?: unknown;
}

export function modelRef(source: ModelSource, model: string): string {
  return `${source.provider}/${model}`;
}

export type AIErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'invalid_request'
  | 'invalid_response'
  /** 404/410 — endpoint, deployment, or model not found (wrong baseUrl/model, or a misrouted edge). */
  | 'not_found'
  | 'context_length'
  | 'canceled'
  | 'policy_blocked'
  | 'key_unavailable'
  | 'tool_error'
  | 'budget_exceeded';

export type StreamEvent =
  | { type: 'start'; callId: string; provider: string; model: string }
  | { type: 'delta'; text: string }
  // Reasoning/thinking tokens surfaced as their own channel so callers can show
  // or discard them without them polluting `delta` (the user-facing answer).
  // Emitted from Anthropic `thinking_delta` and OpenAI-compat `reasoning`/
  // `reasoning_content` deltas; providers that don't stream reasoning never emit it.
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  // In-band generated media is reported as `{ type: 'context', kind: 'media',
  // data: MediaOutput }` as it arrives, and collected on `ChatResult.media`.
  | { type: 'context'; kind: string; data: unknown }
  | { type: 'retry'; attempt: number; reason: AIErrorKind; delayMs: number }
  | { type: 'done'; result: ChatResult }
  | { type: 'error'; error: import('./errors.js').AIError };

export interface ProviderAdapter {
  readonly provider: string;
  chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult>;
  stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent>;
  listModels?(conn: ResolvedConnection): Promise<ModelInfo[]>;
  health?(conn: ResolvedConnection): Promise<{ ok: boolean; detail?: string }>;
  embed?(conn: ResolvedConnection, req: EmbedRequest): Promise<EmbedResult>;
}

export interface ModelInfo {
  id: string;
  source: ModelSource;
  contextWindow?: number;
  capabilities?: string[];
}

export interface GovernancePolicy {
  checkModel(provider: string, model: string): { allowed: true } | { allowed: false; reason: string };
  /**
   * Optional: decide whether a request may hand the provider this remote MCP
   * server (see {@link ChatRequest.mcpServers}). Omitted means allowed, like
   * every other library default — configure it if MCP servers come from users.
   */
  checkMcpServer?(provider: string, server: { name: string; url: string }): { allowed: true } | { allowed: false; reason: string };
}

export interface Redactor {
  redact(text: string): string;
}

export interface TelemetrySink {
  record(r: CallRecord): void | Promise<void>;
}

export interface CallInfo {
  callId: string;
  connection: Connection;
  provider: string;
  model: string;
  metadata?: Record<string, unknown>;
  /**
   * The fully resolved connection for this call — base URL defaulted from the
   * provider profile and auth headers applied. Present whenever `beforeCall`
   * runs after resolution (chat/stream and probes), letting a hook validate the
   * *effective* endpoint (e.g. a request-time SSRF/DNS-rebinding re-check on the
   * resolved `baseUrl`) without duplicating profile logic. The resolved
   * `apiKey` is intentionally not exposed here.
   */
  resolved?: Omit<ResolvedConnection, 'apiKey'>;
}

export interface CallRecord {
  callId: string;
  connectionId: string;
  provider: string;
  model: string;
  startedAt: number;
  timing: ChatResult['timing'];
  usage: Usage;
  finishReason: ChatResult['finishReason'];
  error?: { kind: AIErrorKind; status?: number; message: string };
  attempts: number;
  metadata?: Record<string, unknown>;
  promptChars: number;
  responseChars: number;
  /** Provider rate-limit headers from the last attempt (success or failure). */
  rateLimit?: RateLimitInfo;
  /**
   * Estimated cost of this call in USD, computed by the optional `pricing` hook
   * passed to the handler. Undefined when no pricing hook is configured or the
   * hook returns nothing for this provider/model.
   */
  costUsd?: number;
}

/**
 * Minimal [Standard Schema](https://standardschema.dev) validator surface. Any
 * Zod / Valibot / ArkType schema (v1+) satisfies this via its `~standard`
 * property, so `chatParsed` can validate model output against a schema the app
 * already owns — with zero dependency added to this library.
 */
export interface StandardSchemaV1<Output = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    /**
     * [Standard JSON Schema](https://standardschema.dev/json-schema) converter
     * (Zod 4.2+, Valibot, …). When present, the nugget derives provider JSON
     * schemas from the validator itself — no converter dependency.
     */
    readonly jsonSchema?: StandardJSONSchemaConverter;
  };
}

/** The `~standard.jsonSchema` converter from the Standard JSON Schema spec. */
export interface StandardJSONSchemaConverter {
  readonly input: (options: { readonly target: string; readonly libraryOptions?: Record<string, unknown> }) => Record<string, unknown>;
  readonly output: (options: { readonly target: string; readonly libraryOptions?: Record<string, unknown> }) => Record<string, unknown>;
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }> };

/** Output of {@link AIHandler.chatParsed}: the validated value plus the raw chat result. */
export interface ParsedResult<T> {
  data: T;
  result: ChatResult;
}
