'use strict';
const crypto = require('crypto');
/**
 * Oberon — minimal SkilXiv REST API client.
 *
 * Uses Node's built-in fetch (Electron / Node 18+).
 * No vscode dependency. No retries — callers are fail-open.
 */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

class SkilXivError extends Error {
    constructor(message, { code = 'request_failed', status = null, method = null, path = null } = {}) {
        super(message); this.name = 'SkilXivError';
        this.code = code; this.status = status; this.method = method; this.path = path;
    }
}

function normaliseBaseUrl(value, { allowInsecureLocalhost = false } = {}) {
    let url;
    try { url = new URL(value || 'https://skilxiv.org'); }
    catch (_) { throw new SkilXivError('SkilXiv base URL is invalid.', { code: 'invalid_base_url' }); }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    if (url.protocol !== 'https:' && !(allowInsecureLocalhost && local && url.protocol === 'http:')) {
        throw new SkilXivError('SkilXiv requires HTTPS (HTTP is allowed only for explicitly enabled localhost development).', { code: 'insecure_base_url' });
    }
    if (url.username || url.password || url.search || url.hash) throw new SkilXivError('SkilXiv base URL must not contain credentials, a query, or a fragment.', { code: 'invalid_base_url' });
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
}

function combineSignals(signal, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal && signal.reason);
    if (signal) {
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('SkilXiv request timed out')), Math.max(1, timeoutMs));
    return { signal: controller.signal, cleanup: () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); } };
}

class SkilXivClient {
    /**
     * @param {{ baseUrl?: string, apiToken?: string }} opts
     */
    constructor({ baseUrl = 'https://skilxiv.org', apiToken = '', timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_BYTES, allowInsecureLocalhost = false } = {}) {
        this._base  = normaliseBaseUrl(baseUrl, { allowInsecureLocalhost });
        this._token = apiToken || '';
        this._timeoutMs = timeoutMs;
        this._maxResponseBytes = maxResponseBytes;
        this._capabilities = null;
    }

    /** Discover registry capabilities. Unsupported discovery is represented explicitly. */
    async discover({ signal, refresh = false } = {}) {
        if (this._capabilities && !refresh) return this._capabilities;
        try {
            const data = await this.request('/.well-known/skilxiv.json', { apiPrefix: false, signal });
            this._capabilities = { supported: true, ...data };
        } catch (e) {
            if (e && e.status === 404) this._capabilities = { supported: false, api_version: 'v1', advisories: false, verification_receipts: false };
            else throw e;
        }
        return this._capabilities;
    }

    _headers(extra = {}) {
        const h = {
            'Content-Type': 'application/json',
            'Accept':       'application/json',
            ...extra,
        };
        if (this._token) h['Authorization'] = `Bearer ${this._token}`;
        return h;
    }

    /** Low-level API request used by the consolidated Wolfbook tool. */
    async request(path, { method = 'GET', query, body, headers = {}, accept = 'application/json', signal, timeoutMs, apiPrefix = true } = {}) {
        const qs = new URLSearchParams();
        for (const [key, value] of Object.entries(query || {})) {
            if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
        }
        const suffix = qs.size ? `?${qs}` : '';
        const target = `${this._base}${apiPrefix ? '/api/v1' : ''}${path}${suffix}`;
        const linked = combineSignals(signal, timeoutMs || this._timeoutMs);
        let resp;
        try { resp = await fetch(target, { method, headers: this._headers({ Accept: accept, ...headers }), body: body === undefined ? undefined : JSON.stringify(body), signal: linked.signal }); }
        catch (e) {
            const code = linked.signal.aborted ? 'aborted' : 'network_error';
            throw new SkilXivError(`SkilXiv ${method} ${path} ${code === 'aborted' ? 'was cancelled or timed out' : 'failed'}: ${e.message}`, { code, method, path });
        } finally { linked.cleanup(); }
        const responseHeaders = resp.headers && typeof resp.headers.get === 'function' ? resp.headers : { get: () => '' };
        const declared = Number(responseHeaders.get('content-length') || 0);
        if (declared > this._maxResponseBytes) throw new SkilXivError(`SkilXiv response exceeds ${this._maxResponseBytes} bytes.`, { code: 'response_too_large', status: resp.status, method, path });
        // The json() fallback keeps the transport friendly to lightweight unit-test
        // Response doubles; real fetch Responses always provide text().
        const text = typeof resp.text === 'function' ? await resp.text() : JSON.stringify(await resp.json());
        if (Buffer.byteLength(text, 'utf8') > this._maxResponseBytes) throw new SkilXivError(`SkilXiv response exceeds ${this._maxResponseBytes} bytes.`, { code: 'response_too_large', status: resp.status, method, path });
        const contentType = responseHeaders.get('content-type') || (typeof resp.json === 'function' ? 'application/json' : '');
        let payload = text;
        if (contentType.includes('json')) {
            try { payload = text ? JSON.parse(text) : {}; }
            catch (_) { throw new SkilXivError('SkilXiv returned malformed JSON.', { code: 'invalid_json', status: resp.status, method, path }); }
        }
        if (!resp.ok) {
            const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
            throw new SkilXivError(`SkilXiv ${method} ${path} HTTP ${resp.status}: ${detail.slice(0, 300)}`, { code: 'http_error', status: resp.status, method, path });
        }
        return payload;
    }

    /**
     * Search SkilXiv for skills matching a natural-language query.
     *
     * @param {string} query
     * @param {{ tags?: string, limit?: number, minTier?: number }} opts
     * @returns {Promise<{ results: object[], count: number }>}
     */
    async search(query, { tags, limit = 5, minTier = 0, signal } = {}) {
        return this.request('/search', { query: { q: query, tags, min_tier: minTier, limit }, signal });
    }

    /**
     * Fetch the full content (body + metadata) of one skill version.
     *
     * @param {string} namespace
     * @param {string} name
     * @param {string} [version]   defaults to latest
     * @returns {Promise<object>}
     */
    async getSkill(namespace, name, version, { signal } = {}) {
        const path = version && version !== 'latest'
            ? `/api/v1/skills/${namespace}/${name}/versions/${version}`
            : `/api/v1/skills/${namespace}/${name}`;
        const data = await this.request(path.replace(/^\/api\/v1/, ''), { signal });
        // Normalise `metadata_` (ORM column name) → `metadata`
        if (!data.metadata && data.metadata_) data.metadata = data.metadata_;
        return data;
    }

    /**
     * Submit a minimal usage event (§2 of SKILXIV_FAIRY_STAGE1.md).
     * Idempotent on eventId.
     *
     * @param {{ skill: string, outcome: string, eventId: string, environmentClass?: string }} params
     * @returns {Promise<{ ok: boolean, id: string, duplicate: boolean }>}
     */
    async reportUsage({ skill, outcome, eventId, environmentClass, agentReport, sharePublicly, reasonCode, feedbackNote }) {
        const resp = await fetch(`${this._base}/api/v1/usage`, {
            method:  'POST',
            headers: this._headers(),
            body:    JSON.stringify({
                skill,
                outcome,
                event_id:          eventId,
                environment_class: environmentClass,
                agent_report:      agentReport || null,
                share_publicly:    !!sharePublicly,
                reason_code:       reasonCode || null,
                feedback_note:     feedbackNote || null,
            }),
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`SkilXiv reportUsage HTTP ${resp.status}: ${body.slice(0, 200)}`);
        }
        return resp.json();
    }

    /**
     * Stage 2: submit a private draft (authenticated as the user). Matches the
     * documented contract `POST /api/v1/drafts`. The draft is private until the
     * user explicitly publishes it. An Idempotency-Key prevents duplicate drafts
     * on retry.
     *
     * @param {{
     *   skillMd:           string,   // full SKILL.md document
     *   transcript?:       string,   // optional "how it was figured out"
     *   transcriptPublic?: boolean,
     *   agentModel?:       string|null,
     *   idempotencyKey?:   string,
     * }} draft
     */
    async createDraft({ skillMd, transcript = null, transcriptPublic = false, agentModel = null, idempotencyKey }) {
        const headers = this._headers();
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        const resp = await fetch(`${this._base}/api/v1/drafts`, {
            method:  'POST',
            headers,
            body:    JSON.stringify({
                skill_md:          skillMd,
                transcript,
                transcript_public: !!transcriptPublic,
                agent_model:       agentModel,
            }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`SkilXiv createDraft HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
        return resp.json();
    }

    /**
     * I13: post a SKILL REQUEST — "a skill covering <topic> was needed but does not
     * exist". Fills the registry's demand signal so gaps get authored. Best-effort:
     * callers must tolerate failure (the endpoint may not exist yet — the local
     * `.oberon/skill_gaps.jsonl` ledger is the durable record either way).
     *
     * @param {{ topic: string, context?: string }} req
     */
    async requestSkill({ topic, context = '', runtime = null, category = null, consentToPublish = false }) {
        if (!consentToPublish) throw new Error('Explicit consent is required before publishing a skill request.');
        const resp = await fetch(`${this._base}/api/v1/skill-requests`, {
            method:  'POST',
            headers: this._headers(),
            body:    JSON.stringify({
                topic:        String(topic || '').slice(0, 200),
                context:      String(context || '').slice(0, 800),
                requested_by: 'wolfbook-fairy',
                runtime,
                category,
                consent_to_publish: true,
            }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`SkilXiv requestSkill HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
        return resp.json();
    }

    /** Stage 2: revise a private draft before publishing. PATCH /api/v1/drafts/{id} */
    async updateDraft(id, { skillMd }) {
        const resp = await fetch(`${this._base}/api/v1/drafts/${encodeURIComponent(id)}`, {
            method:  'PATCH',
            headers: this._headers(),
            body:    JSON.stringify({ skill_md: skillMd }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`SkilXiv updateDraft HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
        return resp.json();
    }
}

function hashSkillBody(body) { return `sha256:${crypto.createHash('sha256').update(String(body || ''), 'utf8').digest('hex')}`; }

module.exports = { SkilXivClient, SkilXivError, normaliseBaseUrl, hashSkillBody };
