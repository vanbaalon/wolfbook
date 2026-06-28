'use strict';
/**
 * Oberon — OpenAI adapter.
 *
 * Uses the standard OpenAI Chat Completions endpoint:
 *   POST {baseUrl}/v1/chat/completions
 *   Authorization: Bearer <apiKey>
 *
 * Configuration (under `wolfbook.oberon.providers.openai`):
 *   apiKey      — explicit key (optional; falls back to env var)
 *   apiKeyEnv   — env var name (default 'OPENAI_API_KEY')
 *   baseUrl     — default 'https://api.openai.com'
 *
 * Usage cache fields (gpt-4o family):
 *   usage.prompt_tokens_details.cached_tokens  → cacheReadTokens
 *   prompt_tokens - cached                     → cacheMissTokens
 *   cacheWriteTokens stays null (OpenAI does not report writes separately).
 *
 * No streaming in this minimal implementation — OpenAI does not emit
 * reasoning_content, so the streaming preview surface adds no value.
 */

const { ProviderAdapter, providerError } = require('./provider');
const { computeCost }                    = require('./cost');
const vscode = (() => { try { return require('vscode'); } catch (_) { return null; } })();

const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_BACKOFFS = [1000, 3000, 8000];
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function cfg(key, fallback) {
    if (!vscode) return fallback;
    try {
        const v = vscode.workspace.getConfiguration('wolfbook.oberon.providers.openai').get(key);
        return (v === undefined || v === null) ? fallback : v;
    } catch (_) { return fallback; }
}
function apiKey() {
    const explicit = String(cfg('apiKey', '') || '').trim();
    if (explicit) return explicit;
    const envName = String(cfg('apiKeyEnv', 'OPENAI_API_KEY') || '').trim();
    if (envName && process.env[envName]) return process.env[envName];
    return '';
}
function baseUrl() {
    return String(cfg('baseUrl', 'https://api.openai.com') || 'https://api.openai.com')
        .replace(/\/+$/, '');
}

function isRetryable(e) {
    if (!e) return false;
    if (e.status && RETRYABLE_STATUSES.has(e.status)) return true;
    return /network error/i.test(String(e.message || ''));
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

class OpenAIAdapter extends ProviderAdapter {
    get name() { return 'openai'; }
    get supportsPromptCaching() { return true; }

    async chatComplete(req, ctx = {}) {
        let lastErr = null;
        for (let attempt = 0; attempt <= RETRY_BACKOFFS.length; attempt++) {
            try { return await this._chatCompleteOnce(req, ctx); }
            catch (e) {
                lastErr = e;
                if (req.signal && req.signal.aborted) throw e;
                if (attempt >= RETRY_BACKOFFS.length) throw e;
                if (!isRetryable(e)) throw e;
                const backoff = (e.retryAfterMs && Number(e.retryAfterMs)) || RETRY_BACKOFFS[attempt];
                try { await sleep(backoff, req.signal); }
                catch (_) { throw e; }
            }
        }
        throw lastErr;
    }

    async _chatCompleteOnce(req, ctx = {}) {
        const key = apiKey();
        if (!key) throw providerError('openai', {
            message: 'OPENAI_API_KEY not set (settings.providers.openai.apiKey or env var).',
        });

        const body = {
            model:    req.model,
            messages: normaliseMessages(req.messages),
            temperature: req.temperature ?? 0.2,
        };
        if (req.maxTokens)      body.max_tokens      = req.maxTokens;
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
        const timeout = setTimeout(() => localAbort.abort(new Error('timeout')), DEFAULT_TIMEOUT_MS);

        const url = `${baseUrl()}/v1/chat/completions`;
        const t0  = Date.now();
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'authorization': `Bearer ${key}`,
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
                throw providerError('openai', { message: 'request aborted', cause: e });
            }
            throw providerError('openai', { message: `network error: ${e && e.message || e}`, cause: e });
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
            throw providerError('openai', {
                status,
                retryAfterMs: retryAfter ? retryAfter * 1000 : null,
                message: `HTTP ${status}: ${typeof detail === 'string' ? detail.slice(0, 300) : (detail.error && detail.error.message) || 'request failed'}`,
                cause: detail,
            });
        }

        let json;
        try { json = JSON.parse(text); }
        catch (e) { throw providerError('openai', { message: 'non-JSON response', cause: text.slice(0, 300) }); }

        const choice = (json.choices && json.choices[0]) || {};
        const msg    = choice.message || {};
        const content    = String(msg.content || '');
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
        const inputTokens  = Number(raw.prompt_tokens     || 0);
        const outputTokens = Number(raw.completion_tokens || 0);
        const cachedRead = (raw.prompt_tokens_details && raw.prompt_tokens_details.cached_tokens != null)
            ? Number(raw.prompt_tokens_details.cached_tokens) : null;
        const usage = {
            inputTokens,
            outputTokens,
            cacheReadTokens:  cachedRead,
            cacheMissTokens:  cachedRead != null ? Math.max(0, inputTokens - cachedRead) : null,
            cacheWriteTokens: null,
        };

        const costUSD = computeCost(usage, ctx.pricing || null);
        return {
            content,
            reasoning: null,
            toolCalls,
            usage,
            provider: 'openai',
            model:    req.model,
            latencyMs,
            stopReason,
            costUSD,
            raw,
        };
    }
}

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

module.exports = { OpenAIAdapter };

