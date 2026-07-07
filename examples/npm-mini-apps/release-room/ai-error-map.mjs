// Canonical AIError.kind -> HTTP response mapping. See README "Error handling
// matrix" in the AI Nugget package for the full table and rationale. Copy this
// file as-is into any small server app that calls AIHandler directly.

const STATUS_BY_KIND = {
  invalid_request: 400,
  context_length: 413,
  auth: 502,
  key_unavailable: 500,
  policy_blocked: 403,
  rate_limit: 429,
  timeout: 504,
  canceled: 499,
  invalid_response: 502,
  network: 502,
  server: 502,
  tool_error: 500,
  budget_exceeded: 429,
};

const MESSAGE_BY_KIND = {
  invalid_request: 'That request was invalid.',
  context_length: 'Your input is too long. Please shorten it and try again.',
  auth: 'The AI service is not configured correctly.',
  key_unavailable: 'The AI service is not configured correctly.',
  policy_blocked: 'This request was blocked by policy.',
  rate_limit: 'The AI service is busy. Please try again shortly.',
  timeout: 'The request took too long. Please try again.',
  canceled: 'The request was canceled.',
  invalid_response: "The AI response wasn't in the expected format. Please try again.",
  network: 'The AI service is temporarily unavailable.',
  server: 'The AI service is temporarily unavailable.',
};

export function statusForError(kind) {
  return STATUS_BY_KIND[kind] ?? 500;
}

export function messageForError(kind) {
  return MESSAGE_BY_KIND[kind] ?? 'Something went wrong.';
}
