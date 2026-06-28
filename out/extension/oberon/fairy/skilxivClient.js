'use strict';
/**
 * Oberon — minimal SkilXiv REST API client.
 *
 * Uses Node's built-in fetch (Electron / Node 18+).
 * No vscode dependency. No retries — callers are fail-open.
 */

class SkilXivClient {
    /**
     * @param {{ baseUrl?: string, apiToken?: string }} opts
     */
    constructor({ baseUrl = 'https://skilxiv.org', apiToken = '' } = {}) {
        this._base  = (baseUrl || 'https://skilxiv.org').replace(/\/$/, '');
        this._token = apiToken || '';
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

    /**
     * Search SkilXiv for skills matching a natural-language query.
     *
     * @param {string} query
     * @param {{ tags?: string, limit?: number, minTier?: number }} opts
     * @returns {Promise<{ results: object[], count: number }>}
     */
    async search(query, { tags, limit = 5, minTier = 0 } = {}) {
        const qs = new URLSearchParams();
        if (query) qs.set('q', query);
        if (tags)  qs.set('tags', tags);
        qs.set('min_tier', String(minTier));
        qs.set('limit',    String(limit));
        const resp = await fetch(`${this._base}/api/v1/search?${qs}`, {
            headers: this._headers(),
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`SkilXiv search HTTP ${resp.status}: ${body.slice(0, 200)}`);
        }
        return resp.json();
    }

    /**
     * Fetch the full content (body + metadata) of one skill version.
     *
     * @param {string} namespace
     * @param {string} name
     * @param {string} [version]   defaults to latest
     * @returns {Promise<object>}
     */
    async getSkill(namespace, name, version) {
        const path = version && version !== 'latest'
            ? `/api/v1/skills/${namespace}/${name}/versions/${version}`
            : `/api/v1/skills/${namespace}/${name}`;
        const resp = await fetch(`${this._base}${path}`, {
            headers: this._headers(),
        });
        if (!resp.ok) {
            throw new Error(`SkilXiv getSkill HTTP ${resp.status} for @${namespace}/${name}`);
        }
        const data = await resp.json();
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
    async reportUsage({ skill, outcome, eventId, environmentClass, agentReport, sharePublicly }) {
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

module.exports = { SkilXivClient };
