'use strict';
/**
 * Oberon — provider interface (documentation + base class).
 *
 * Concrete adapters (deepseek.js, openai.js, anthropic.js, lmapi.js) implement
 * the same async `chatComplete()` shape so the agent loop is provider-agnostic.
 *
 * Adapters MUST:
 *  - never throw on provider errors; convert to a structured rejection object
 *    `{ kind: 'provider_error', message, status?, retryAfterMs?, raw? }`
 *  - honour the AbortSignal in `opts.signal`
 *  - report `usage` with `inputTokens`/`outputTokens` and either a number or
 *    `null` for each cache field (NEVER 0 for "not reported" — `null` means
 *    the provider did not report, which the cost/UI layer renders as `n/a`)
 *
 * @typedef {Object} ChatMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 *
 * @typedef {Object} CompletionRequest
 * @property {ChatMessage[]} messages
 * @property {string} model
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 * @property {'text'|'json_object'} [responseFormat]
 * @property {AbortSignal} [signal]
 *
 * @typedef {Object} TokenUsage
 * @property {number} inputTokens          // prompt_tokens total (display only; use hit+miss for cost)
 * @property {number} outputTokens
 * @property {number|null} cacheReadTokens  // prompt_cache_hit_tokens  (null = not reported)
 * @property {number|null} cacheMissTokens  // prompt_cache_miss_tokens (null = not reported)
 * @property {number|null} cacheWriteTokens // write/store cost (null = not reported)
 *
 * @typedef {Object} CompletionResult
 * @property {string} content                // the assistant's text
 * @property {TokenUsage} usage
 * @property {string} provider               // 'deepseek' | …
 * @property {string} model
 * @property {number} latencyMs
 * @property {string|null} stopReason
 * @property {number|null} costUSD           // null if pricing not provided
 * @property {object} [raw]                  // provider-native usage block (debug)
 */

class ProviderAdapter {
    /** @returns {string} */
    get name() { throw new Error('provider.name not implemented'); }

    /** @returns {boolean} */
    get supportsPromptCaching() { return false; }

    /**
     * @param {CompletionRequest} _req
     * @param {{pricing?: import('../core/types').RolePricing}} [_ctx]
     * @returns {Promise<CompletionResult>}
     */
    async chatComplete(_req, _ctx) { throw new Error('chatComplete not implemented'); }
}

/**
 * Build a normalized provider_error object from an exception or HTTP response.
 * @param {string} provider
 * @param {{message: string, status?: number, retryAfterMs?: number, cause?: any}} info
 */
function providerError(provider, info) {
    const err = new Error(info.message || 'provider error');
    err.kind          = 'provider_error';
    err.provider      = provider;
    err.status        = info.status || null;
    err.retryAfterMs  = info.retryAfterMs || null;
    err.cause         = info.cause;
    return err;
}

module.exports = { ProviderAdapter, providerError };
