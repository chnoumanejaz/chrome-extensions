/**
 * The only module that loads the vendored Anthropic SDK, so the rest of the
 * extension (and the Node unit tests) never pay for it.
 */
import Anthropic from "../vendor/anthropic-sdk.js";

export { Anthropic };

/**
 * The key is the user's own and never leaves their browser except to call the
 * API, so running the SDK in an extension page is acceptable here.
 */
export function createClaudeClient(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

/** Turns SDK errors into a message a user can act on (most specific first). */
export function describeClaudeError(error) {
  if (error instanceof Anthropic.AuthenticationError) return "Your Claude API key was rejected. Check it in Settings → AI triage.";
  if (error instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use that model or feature.";
  if (error instanceof Anthropic.NotFoundError) return "The selected model isn't available to your API key. Pick another model in Settings.";
  if (error instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API. Wait a moment and try again.";
  if (error instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API. Check your connection.";
  if (error instanceof Anthropic.APIError) return `Claude API error${error.status ? ` (${error.status})` : ""}: ${error.message}`;
  return error?.message || String(error);
}
