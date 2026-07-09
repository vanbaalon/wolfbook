'use strict';
/**
 * Oberon — Anthropic adapter (Claude Messages API).
 *
 *   POST {baseUrl}/v1/messages
 *   x-api-key: <apiKey>
 *   anthropic-version: 2023-06-01
 *
 * Differences from OpenAI/DeepSeek:
 *  - `system` is a separate top-level field (string OR array of content blocks)
 *  - `tools` use `{ name, description, input_schema }` (no wrapping `function`)
 *  - response `content` is an array of typed blocks; `tool_use` blocks carry
 *    `{ id, name, input }` (already parsed) and `text` blocks carry text.
 *  - tool results sent back as a user message with `tool_result` content blocks
 *    keyed by `tool_use_id`.
 *  - cache control: opt-in `cache_control:{type:'ephemeral'}` on the system
 *    block(s) — we apply it automatically so the system prompt is cached
 *    across consecutive Fairy turns.
 *
 * Configuration (under `wolfbook.oberon.providers.anthropic`):
 *   apiKey    — explicit key (optional)
 *   apiKeyEnv — env var name (default 'ANTHROPIC_API_KEY')
 *   baseUrl   — default 'https://api.anthropic.com'
 */

const { ProviderAdapter, providerError } = require('./provider');
const { computeCost }                    = require('./cost');
const vscode = (() => { try { return require('vscode'); } catch (_) { return null; } })();

const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_BACKOFFS = [1000, 3000, 8000];
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const ANTHROPIC_VERSION = '2023-06-01';

function cfg(key, fallback) {
    if (!vscode) return fallback;
    try {
        const v = vscode.workspace.getConfiguration('wolfbook.oberon.providers.anthropic').get(key);
        return (v === undefined || v === null) ? fallback : v;
    } catch (_) { return fallback; }
}
function apiKey() {
    const explicit = String(cfg('apiKey', '') || '').trim();
    if (explicit) return explicit;
    const envName = String(cfg('apiKeyEnv', 'ANTHROPIC_API_KEY') || '').trim();
    if (envName && process.env[envName]) return process.env[envName];
    return '';
}
function baseUrl() {
    return String(cfg('baseUrl', 'https://api.anthropic.com') || 'https://api.anthropic.com')
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

class AnthropicAdapter extends ProviderAdapter {
    get name() { return 'anthropic'; }
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
        if (!key) throw providerError('anthropic', {
            message: 'ANTHROPIC_API_KEY not set (settings.providers.anthropic.apiKey or env var).',
        });

        const { system, messages } = splitSystemAndConvert(req.messages);

        const body = {
            model:      req.model,
            max_tokens: req.maxTokens || 4096,
            temperature: req.temperature ?? 0.2,
            messages,
        };
        if (system) body.system = system;
        if (Array.isArray(req.tools) && req.tools.length) {
            body.tools = req.tools.map(convertToolSpec);
            if (req.toolChoice === 'auto')      body.tool_choice = { type: 'auto' };
            else if (req.toolChoice === 'required') body.tool_choice = { type: 'any' };
            else if (req.toolChoice === 'none') body.tool_choice = { type: 'none' };
        }
        // Anthropic has no native JSON-mode; ignore responseFormat.

        const localAbort = new AbortController();
        const onAbort    = () => localAbort.abort();
        if (req.signal) {
            if (req.signal.aborted) localAbort.abort();
            else req.signal.addEventListener('abort', onAbort, { once: true });
        }
        const timeout = setTimeout(() => localAbort.abort(new Error('timeout')), DEFAULT_TIMEOUT_MS);

        const url = `${baseUrl()}/v1/messages`;
        const t0  = Date.now();
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': key,
                    'anthropic-version': ANTHROPIC_VERSION,
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
                throw providerError('anthropic', { message: 'request aborted', cause: e });
            }
            throw providerError('anthropic', { message: `network error: ${e && e.message || e}`, cause: e });
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
            throw providerError('anthropic', {
                status,
                retryAfterMs: retryAfter ? retryAfter * 1000 : null,
                message: `HTTP ${status}: ${typeof detail === 'string' ? detail.slice(0, 300) : (detail.error && detail.error.message) || 'request failed'}`,
                cause: detail,
            });
        }

        let json;
        try { json = JSON.parse(text); }
        catch (e) { throw providerError('anthropic', { message: 'non-JSON response', cause: text.slice(0, 300) }); }

        // Extract text + tool_use blocks from content array.
        const blocks = Array.isArray(json.content) ? json.content : [];
        let content = '';
        const toolCalls = [];
        for (const b of blocks) {
            if (!b) continue;
            if (b.type === 'text' && typeof b.text === 'string') content += b.text;
            else if (b.type === 'tool_use') {
                toolCalls.push({
                    id:        String(b.id || ''),
                    name:      String(b.name || ''),
                    arguments: (b.input && typeof b.input === 'object') ? b.input : {},
                    raw:       b,
                });
            }
        }

        const raw = json.usage || {};
        const usage = {
            inputTokens:      Number(raw.input_tokens     || 0),
            outputTokens:     Number(raw.output_tokens    || 0),
            cacheReadTokens:  (raw.cache_read_input_tokens     != null) ? Number(raw.cache_read_input_tokens)     : null,
            cacheMissTokens:  null,
            cacheWriteTokens: (raw.cache_creation_input_tokens != null) ? Number(raw.cache_creation_input_tokens) : null,
        };
        // Derive cacheMissTokens when caching is in play.
        if (usage.cacheReadTokens != null || usage.cacheWriteTokens != null) {
            const rd = usage.cacheReadTokens || 0;
            usage.cacheMissTokens = Math.max(0, usage.inputTokens - rd);
        }

        const costUSD = computeCost(usage, ctx.pricing || null);
        return {
            content,
            reasoning: null,
            toolCalls,
            usage,
            provider: 'anthropic',
            model:    req.model,
            latencyMs,
            stopReason: json.stop_reason || null,
            costUSD,
            raw,
        };
    }
}

/**
 * Extract leading `role:'system'` messages and convert the rest to Anthropic's
 * `{role:'user'|'assistant', content: [blocks]}` shape.
 *
 * `tool` messages (OpenAI shape) become `user` messages with a single
 * `tool_result` block referencing the matching `tool_use_id`.
 *
 * Assistant messages with `tool_calls` become `assistant` messages whose
 * content array contains the original text (if any) followed by `tool_use`
 * blocks for each call.
 *
 * Applies `cache_control: { type: 'ephemeral' }` to the system block(s) so
 * prefix caching is enabled (no-op when the model does not support caching).
 */
function splitSystemAndConvert(messages) {
    if (!Array.isArray(messages)) return { system: null, messages: [] };
    let systemText = '';
    const out = [];
    for (const m of messages) {
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'system') {
            if (typeof m.content === 'string') {
                systemText += (systemText ? '\n\n' : '') + m.content;
            }
            continue;
        }
        if (m.role === 'tool') {
            out.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: String(m.tool_call_id || ''),
                    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
                }],
            });
            continue;
        }
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            const blocks = [];
            if (m.content && String(m.content).trim()) {
                blocks.push({ type: 'text', text: String(m.content) });
            }
            for (const tc of m.tool_calls) {
                let input = {};
                try {
                    const argStr = (tc.function && tc.function.arguments) || '{}';
                    input = typeof argStr === 'string' ? JSON.parse(argStr) : (argStr || {});
                } catch (_) { input = {}; }
                blocks.push({
                    type: 'tool_use',
                    id:   String(tc.id || ''),
                    name: String((tc.function && tc.function.name) || tc.name || ''),
                    input,
                });
            }
            out.push({ role: 'assistant', content: blocks });
            continue;
        }
        // Plain user / assistant text.
        out.push({
            role: m.role,
            content: [{ type: 'text', text: String(m.content || '') }],
        });
    }
    // O1: also mark the LAST content block of the LAST message as a cache
    // breakpoint. With only the system block marked, Anthropic caches just the
    // system prompt; marking the conversation tail makes the ENTIRE history up
    // to the current turn cacheable across consecutive Fairy turns (Anthropic
    // allows up to 4 breakpoints; we use 2).
    if (out.length) {
        const lastMsg = out[out.length - 1];
        if (Array.isArray(lastMsg.content) && lastMsg.content.length) {
            const lastBlock = lastMsg.content[lastMsg.content.length - 1];
            if (lastBlock && typeof lastBlock === 'object') {
                lastBlock.cache_control = { type: 'ephemeral' };
            }
        }
    }
    if (!systemText) return { system: null, messages: out };
    // One ephemeral cache_control marker on the system block enables prefix
    // caching for the (large, stable) Fairy/Skeptic/Executive system prompts.
    const system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
    return { system, messages: out };
}

/**
 * Convert an OpenAI-style tool spec `{type:'function', function:{name,description,parameters}}`
 * to Anthropic's `{name, description, input_schema}`.
 */
function convertToolSpec(spec) {
    if (!spec) return null;
    if (spec.function) {
        return {
            name:         String(spec.function.name || ''),
            description:  String(spec.function.description || ''),
            input_schema: spec.function.parameters || { type: 'object' },
        };
    }
    // Already Anthropic shape.
    return spec;
}

module.exports = { AnthropicAdapter };

