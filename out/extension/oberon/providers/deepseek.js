'use strict';
/**
 * Oberon — DeepSeek adapter.
 *
 * DeepSeek exposes an OpenAI-compatible Chat Completions endpoint.
 *   POST {baseUrl}/v1/chat/completions
 *   Authorization: Bearer <apiKey>
 *
 * The usage block carries:
 *   prompt_tokens, completion_tokens, total_tokens,
 *   prompt_cache_hit_tokens, prompt_cache_miss_tokens
 *
 * DeepSeek does NOT report a separate cache-write count, so
 * cacheWriteTokens is always `null` here (not 0).
 *
 * Networking uses Node 18+ global `fetch`. AbortSignal is honoured.
 */

const { ProviderAdapter, providerError } = require('./provider');
const { computeCost }                    = require('./cost');
const settings                           = require('../config/settings');

const DEFAULT_TIMEOUT_MS = 120_000;

/** Request timeout — configurable via settings (providers.deepseek.timeoutMs);
 *  reasoning models (deepseek-v4-pro) can legitimately take longer than 120s
 *  to first byte on a long planning prompt. */
function requestTimeoutMs() {
    try {
        const v = Number(settings.deepseekTimeoutMs && settings.deepseekTimeoutMs());
        if (Number.isFinite(v) && v >= 10_000) return v;
    } catch (_) {}
    return DEFAULT_TIMEOUT_MS;
}

// Transient-error retry policy for 429/5xx + network blips. Total attempts = 1 + RETRY_BACKOFFS.length.
// Caller signal still aborts immediately between retries.
const RETRY_BACKOFFS = [1000, 3000, 8000];
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryable(e) {
    if (!e) return false;
    if (e.status && RETRYABLE_STATUSES.has(e.status)) return true;
    // Network-layer failures land as providerError with no status. Mid-stream
    // drops ("stream read error: …", SSE stall, socket resets) are transient the
    // same way a pre-flight network error is — the whole request is simply
    // re-issued. Caller aborts are NOT retryable ("request aborted…" messages
    // never match these patterns, and chatComplete checks req.signal first).
    const msg = String(e.message || '');
    if (/network error|stream read error|SSE stream stalled|ECONNRESET|ETIMEDOUT|socket hang ?up|premature close|fetch failed|terminated/i.test(msg)) return true;
    return false;
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        if (signal) {
            const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
            if (signal.aborted) { clearTimeout(t); reject(new Error('aborted')); return; }
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

class DeepSeekAdapter extends ProviderAdapter {
    get name() { return 'deepseek'; }
    get supportsPromptCaching() { return true; }

    /**
     * @param {import('./provider').CompletionRequest} req
     * @param {{pricing?: import('../core/types').RolePricing}} [ctx]
     */
    async chatComplete(req, ctx = {}) {
        let lastErr = null;
        for (let attempt = 0; attempt <= RETRY_BACKOFFS.length; attempt++) {
            try {
                return await this._chatCompleteOnce(req, ctx);
            } catch (e) {
                lastErr = e;
                if (req.signal && req.signal.aborted) throw e;
                if (attempt >= RETRY_BACKOFFS.length) throw e;
                if (!isRetryable(e)) throw e;
                const backoff = (e.retryAfterMs && Number(e.retryAfterMs)) || RETRY_BACKOFFS[attempt];
                try {
                    // eslint-disable-next-line no-console
                    console.warn(`[oberon/deepseek] transient error (${e.status || 'net'}); retry #${attempt+1} after ${backoff}ms`);
                } catch (_) {}
                try { await sleep(backoff, req.signal); }
                catch (_) { throw e; }  // aborted during sleep
            }
        }
        throw lastErr;
    }

    /**
     * @param {import('./provider').CompletionRequest} req
     * @param {{pricing?: import('../core/types').RolePricing, onChunk?: (chunk:{type:string,text:string})=>void}} [ctx]
     */
    async _chatCompleteOnce(req, ctx = {}) {
        // If caller wants streaming reasoning preview, delegate to SSE path.
        if (typeof ctx.onChunk === 'function') {
            return this._chatCompleteStream(req, ctx);
        }

        const apiKey  = settings.deepseekApiKey();
        const baseUrl = (settings.deepseekBaseUrl() || 'https://api.deepseek.com').replace(/\/+$/, '');
        if (!apiKey) throw providerError('deepseek', { message: 'DEEPSEEK_API_KEY not set (settings.providers.deepseek.apiKey or env var).' });

        const body = {
            model:    req.model,
            messages: normaliseMessages(req.messages),
            temperature: req.temperature ?? 0.2,
            stream:   false,
        };
        if (req.maxTokens)      body.max_tokens     = req.maxTokens;
        if (req.responseFormat) body.response_format = { type: req.responseFormat };
        if (Array.isArray(req.tools) && req.tools.length) {
            body.tools = req.tools;
            if (req.toolChoice) body.tool_choice = req.toolChoice;
        }

        // Abort plumbing — combine caller signal with our own timeout.
        const localAbort = new AbortController();
        const onAbort    = () => localAbort.abort();
        if (req.signal) {
            if (req.signal.aborted) localAbort.abort();
            else req.signal.addEventListener('abort', onAbort, { once: true });
        }
        const timeout = setTimeout(() => localAbort.abort(new Error('timeout')), requestTimeoutMs());

        const url = `${baseUrl}/v1/chat/completions`;
        const t0  = Date.now();
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'authorization': `Bearer ${apiKey}`,
                    'accept': 'application/json',
                    'user-agent': 'wolfbook-oberon/0.1 (+vscode)',
                },
                body: JSON.stringify(body),
                signal: localAbort.signal,
            });
        } catch (e) {
            clearTimeout(timeout);
            if (req.signal) req.signal.removeEventListener('abort', onAbort);
            if (e && (e.name === 'AbortError' || (e.message || '').includes('aborted'))) {
                throw providerError('deepseek', { message: 'request aborted', cause: e });
            }
            throw providerError('deepseek', { message: `network error: ${e && e.message || e}`, cause: e });
        }
        clearTimeout(timeout);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);

        const latencyMs = Date.now() - t0;
        const text = await res.text();

        if (!res.ok) {
            let detail = text;
            try { detail = JSON.parse(text); } catch (_) {}
            const status = res.status;
            const retryAfter = Number(res.headers.get('retry-after')) || null;
            throw providerError('deepseek', {
                status,
                retryAfterMs: retryAfter ? retryAfter * 1000 : null,
                message: `HTTP ${status}: ${typeof detail === 'string' ? detail.slice(0, 300) : (detail.error && detail.error.message) || 'request failed'}`,
                cause: detail,
            });
        }

        let json;
        try { json = JSON.parse(text); }
        catch (e) { throw providerError('deepseek', { message: 'non-JSON response', cause: text.slice(0, 300) }); }

        const choice = (json.choices && json.choices[0]) || {};
        const msg    = choice.message || {};
        const content   = String(msg.content || '');
        const reasoning = msg.reasoning_content ? String(msg.reasoning_content) : null;
        const stopReason = choice.finish_reason || null;
        const toolCalls = Array.isArray(msg.tool_calls)
            ? msg.tool_calls.map(tc => ({
                id:        String(tc.id || ''),
                name:      String((tc.function && tc.function.name) || ''),
                arguments: parseToolArgs((tc.function && tc.function.arguments) || ''),
                raw:       tc,
            }))
            : [];

        const raw = json.usage || {};
        const usage = {
            inputTokens:      Number(raw.prompt_tokens     || 0),
            outputTokens:     Number(raw.completion_tokens || 0),
            cacheReadTokens:  (raw.prompt_cache_hit_tokens  != null) ? Number(raw.prompt_cache_hit_tokens)  : null,
            cacheMissTokens:  (raw.prompt_cache_miss_tokens != null) ? Number(raw.prompt_cache_miss_tokens) : null,
            cacheWriteTokens: null, // not reported by DeepSeek
        };

        const costUSD = computeCost(usage, ctx.pricing || null);
        return {
            content,
            reasoning,
            toolCalls,
            usage,
            provider: 'deepseek',
            model:    req.model,
            latencyMs,
            stopReason,
            costUSD,
            raw,
        };
    }

    /**
     * SSE streaming path — used when ctx.onChunk is provided.
     * Parses server-sent events and calls onChunk with incremental reasoning/content
     * deltas. Accumulates the full result and returns it in the standard shape.
     *
     * Tool-call streaming is handled by accumulating function.name and
     * function.arguments across delta chunks (indexed by tool_call slot index).
     */
    async _chatCompleteStream(req, ctx = {}) {
    const apiKey  = settings.deepseekApiKey();
    const baseUrl = (settings.deepseekBaseUrl() || 'https://api.deepseek.com').replace(/\/+$/, '');
    if (!apiKey) throw providerError('deepseek', { message: 'DEEPSEEK_API_KEY not set (settings.providers.deepseek.apiKey or env var).' });

    const body = {
        model:    req.model,
        messages: normaliseMessages(req.messages),
        temperature: req.temperature ?? 0.2,
        stream:   true,
        stream_options: { include_usage: true },
    };
    if (req.maxTokens)      body.max_tokens     = req.maxTokens;
    if (req.responseFormat) body.response_format = { type: req.responseFormat };
    if (Array.isArray(req.tools) && req.tools.length) {
        body.tools = req.tools;
        if (req.toolChoice) body.tool_choice = req.toolChoice;
    }

    const localAbort = new AbortController();
    const onAbort    = () => localAbort.abort();
    if (req.signal) {
        if (req.signal.aborted) localAbort.abort();
        else req.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeout = setTimeout(() => localAbort.abort(new Error('timeout')), requestTimeoutMs());

    const url = `${baseUrl}/v1/chat/completions`;
    const t0  = Date.now();
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': `Bearer ${apiKey}`,
                'accept': 'text/event-stream',
                'user-agent': 'wolfbook-oberon/0.1 (+vscode)',
            },
            body: JSON.stringify(body),
            signal: localAbort.signal,
        });
    } catch (e) {
        clearTimeout(timeout);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
        if (e && (e.name === 'AbortError' || (e.message || '').includes('aborted'))) {
            throw providerError('deepseek', { message: 'request aborted', cause: e });
        }
        throw providerError('deepseek', { message: `network error: ${e && e.message || e}`, cause: e });
    }

    if (!res.ok) {
        clearTimeout(timeout);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
        let detail;
        try { detail = await res.text(); try { detail = JSON.parse(detail); } catch (_) {} }
        catch (_) { detail = 'error reading body'; }
        const status = res.status;
        const retryAfter = Number(res.headers.get('retry-after')) || null;
        throw providerError('deepseek', {
            status,
            retryAfterMs: retryAfter ? retryAfter * 1000 : null,
            message: `HTTP ${status}: ${typeof detail === 'string' ? detail.slice(0, 300) : (detail && detail.error && detail.error.message) || 'request failed'}`,
            cause: detail,
        });
    }

    // Accumulate stream
    let content   = '';
    let reasoning = '';
    let stopReason = null;
    let rawUsage = {};
    // tool_calls accumulator: Map<index, {id, name, argsStr}>
    const tcAcc = new Map();
    const onChunk = ctx.onChunk;

    const decoder = new TextDecoder();
    let buf = '';
    // The overall request timeout has done its job once the server starts
    // responding — disarm it here. A healthy stream can legitimately run far
    // longer than the request timeout (a reasoning model writing a long plan
    // streamed for >120s and was killed mid-flight: "stream read error:
    // timeout", run_2026-07-03T23-38-54). From this point liveness is owned
    // by the stall detector below.
    clearTimeout(timeout);
    // Stage-2 SSE stall detector. A hung stream that keeps the TCP connection
    // alive but stops sending data would otherwise wedge the Fairy
    // indefinitely. We arm a per-chunk timer that aborts the local controller
    // if no SSE bytes arrive for STALL_MS.
    const STALL_MS = 60_000;
    let stallTimer = setTimeout(
        () => localAbort.abort(new Error(`SSE stream stalled (no data for ${STALL_MS}ms)`)),
        STALL_MS,
    );
    const resetStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(
            () => localAbort.abort(new Error(`SSE stream stalled (no data for ${STALL_MS}ms)`)),
            STALL_MS,
        );
    };
    try {
        for await (const bytes of res.body) {
            resetStall();
            buf += decoder.decode(bytes, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl).trimEnd();
                buf = buf.slice(nl + 1);
                if (!line.startsWith('data:')) continue;
                const raw = line.slice(5).trim();
                if (raw === '[DONE]') continue;
                let chunk;
                try { chunk = JSON.parse(raw); } catch (_) { continue; }
                if (chunk.usage) rawUsage = chunk.usage;
                const choice = (chunk.choices && chunk.choices[0]) || {};
                const delta  = choice.delta || {};
                if (choice.finish_reason) stopReason = choice.finish_reason;
                // Reasoning delta
                if (delta.reasoning_content) {
                    reasoning += delta.reasoning_content;
                    try { onChunk({ type: 'reasoning', text: delta.reasoning_content }); } catch (_) {}
                }
                // Content delta
                if (delta.content) {
                    content += delta.content;
                    try { onChunk({ type: 'content', text: delta.content }); } catch (_) {}
                }
                // Tool call deltas
                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index || 0;
                        if (!tcAcc.has(idx)) tcAcc.set(idx, { id: '', name: '', argsStr: '' });
                        const slot = tcAcc.get(idx);
                        if (tc.id)                                         slot.id      += tc.id;
                        if (tc.function && tc.function.name)               slot.name    += tc.function.name;
                        if (tc.function && tc.function.arguments)          slot.argsStr += tc.function.arguments;
                    }
                }
            }
        }
    } catch (e) {
        clearTimeout(timeout);
        clearTimeout(stallTimer);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
        if (e && (e.name === 'AbortError' || (e.message || '').includes('aborted'))) {
            throw providerError('deepseek', { message: 'request aborted during stream', cause: e });
        }
        throw providerError('deepseek', { message: `stream read error: ${e && e.message || e}`, cause: e });
    }
    clearTimeout(timeout);
    clearTimeout(stallTimer);
    if (req.signal) req.signal.removeEventListener('abort', onAbort);
    const latencyMs = Date.now() - t0;

    const toolCalls = [];
    for (const [, slot] of [...tcAcc.entries()].sort((a, b) => a[0] - b[0])) {
        toolCalls.push({
            id:        slot.id,
            name:      slot.name,
            arguments: parseToolArgs(slot.argsStr),
            raw:       slot,
        });
    }

    const usage = {
        inputTokens:      Number(rawUsage.prompt_tokens     || 0),
        outputTokens:     Number(rawUsage.completion_tokens || 0),
        cacheReadTokens:  (rawUsage.prompt_cache_hit_tokens  != null) ? Number(rawUsage.prompt_cache_hit_tokens)  : null,
        cacheMissTokens:  (rawUsage.prompt_cache_miss_tokens != null) ? Number(rawUsage.prompt_cache_miss_tokens) : null,
        cacheWriteTokens: null,
    };

    const costUSD = computeCost(usage, ctx.pricing || null);
    return {
        content,
        reasoning: reasoning || null,
        toolCalls,
        usage,
        provider: 'deepseek',
        model:    req.model,
        latencyMs,
        stopReason,
        costUSD,
        raw: rawUsage,
    };
}
}

/**
 * DeepSeek's Chat Completions accepts an extended message shape when tools
 * are in play: assistant messages may carry `tool_calls`, and tool results
 * are sent as `{ role: 'tool', tool_call_id, content }`. Our internal
 * representation uses the same OpenAI-compatible field names, so this is
 * mostly identity — we just filter to known keys to avoid sending stale
 * properties (e.g. `name` on user messages) that some gateways reject.
 */
function normaliseMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map(m => {
        if (!m || typeof m !== 'object') return m;
        if (m.role === 'tool') {
            return {
                role:         'tool',
                tool_call_id: String(m.tool_call_id || ''),
                content:      typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
            };
        }
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            return {
                role:       'assistant',
                content:    m.content || '',
                tool_calls: m.tool_calls.map(tc => ({
                    id:       String(tc.id || ''),
                    type:     'function',
                    function: {
                        name:      String((tc.function && tc.function.name) || tc.name || ''),
                        arguments: typeof (tc.function && tc.function.arguments) === 'string'
                            ? tc.function.arguments
                            : JSON.stringify((tc.function && tc.function.arguments) || tc.arguments || {}),
                    },
                })),
            };
        }
        return { role: m.role, content: m.content };
    });
}

function parseToolArgs(s) {
    if (typeof s !== 'string') return s || {};
    try { return JSON.parse(s); }
    catch (_) { return { _parseError: true, raw: s.slice(0, 1000) }; }
}

module.exports = { DeepSeekAdapter };
