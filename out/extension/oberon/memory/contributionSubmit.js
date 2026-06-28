'use strict';
/**
 * Oberon — Stage 2 contribution submit handler.
 *
 * Turns an approved local candidate into a PRIVATE draft on SkilXiv, authenticated
 * as the user. Enforces the Stage 2 invariants:
 *   - authenticated as the user; the token lives in the editor's secret storage and
 *     is never written to prompts, logs, skills, or the bundle;
 *   - idempotent — a stable key per candidate prevents duplicate drafts on retry;
 *   - on failure the local candidate is preserved and can be resubmitted;
 *   - a near-duplicate match switches the offer to "acknowledge usage" instead.
 *
 * This module is UI-agnostic (no vscode import beyond the secrets handle passed in),
 * so it is unit-testable with a fake secrets store + fake client.
 */

const fsp     = require('fs/promises');
const path    = require('path');
const project = require('./project');
const { SkilXivClient } = require('../fairy/skilxivClient');
const settings = require('../config/settings');

const SECRET_KEY = 'wolfbook.skilxiv.apiToken';

// ── Token (secret storage) ────────────────────────────────────────────────────

async function getToken(secrets) {
    try { return (await secrets.get(SECRET_KEY)) || ''; } catch (_) { return ''; }
}
async function setToken(secrets, token) {
    await secrets.store(SECRET_KEY, String(token || ''));
}
async function clearToken(secrets) {
    try { await secrets.delete(SECRET_KEY); } catch (_) {}
}
async function isSignedIn(secrets) {
    return !!(await getToken(secrets));
}

// ── Client ─────────────────────────────────────────────────────────────────────

function makeClient(token) {
    const cfg = settings.recall();
    return new SkilXivClient({ baseUrl: cfg.skilxivBaseUrl, apiToken: token });
}

// ── Candidate persistence ──────────────────────────────────────────────────────

function candidateDir(id) {
    const inbox = project.contributionsInboxDir();
    return inbox ? path.join(inbox, id) : null;
}

async function loadCandidate(id) {
    const dir = candidateDir(id);
    if (!dir) return null;
    try {
        const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'candidate.json'), 'utf8'));
        const skillMd  = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => '');
        return { manifest, skillMd, dir };
    } catch (_) { return null; }
}

async function saveManifest(id, manifest) {
    const dir = candidateDir(id);
    if (!dir) return;
    await fsp.writeFile(path.join(dir, 'candidate.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

/** Persist edited SKILL.md (from the review dialog) back to the candidate. */
async function saveSkillMd(id, skillMd) {
    const dir = candidateDir(id);
    if (!dir) return;
    await fsp.writeFile(path.join(dir, 'SKILL.md'), String(skillMd), 'utf8');
}

// ── Near-duplicate pre-check ────────────────────────────────────────────────────

/**
 * Search the registry for an existing skill close to this candidate. If the top
 * result scores above the threshold, return it so the UI can offer "acknowledge
 * usage of X" instead of raising a new-skill draft.
 *
 * @returns {Promise<{ match: object|null }>}
 */
async function nearDuplicateCheck(token, { title, task }) {
    const client = makeClient(token);
    const query  = `${title} ${task}`.trim().slice(0, 300);
    let results = [];
    try {
        const resp = await client.search(query, { limit: 3 });
        results = (resp && (resp.results || resp.skills)) || [];
    } catch (_) { return { match: null }; }
    if (!results.length) return { match: null };
    const top = results[0];
    const score = typeof top.score === 'number' ? top.score
        : typeof top.similarity === 'number' ? top.similarity : 0;
    // Conservative threshold: only treat as a duplicate on a strong match.
    return { match: score >= 0.85 ? top : null };
}

// ── Submit / decline / discard ──────────────────────────────────────────────────

/**
 * Approve and submit a candidate as a private draft.
 * @returns {Promise<{ ok:boolean, draftId?:string, url?:string, error?:string }>}
 */
async function submitCandidate({ id, secrets, agentModel, transcript }) {
    const token = await getToken(secrets);
    if (!token) return { ok: false, error: 'not_signed_in' };

    const loaded = await loadCandidate(id);
    if (!loaded) return { ok: false, error: 'candidate_not_found' };
    const { manifest, skillMd } = loaded;
    if (manifest.status === 'submitted') {
        return { ok: true, draftId: manifest.draftId, url: manifest.draftUrl };
    }

    const client = makeClient(token);
    let resp;
    try {
        resp = await client.createDraft({
            skillMd,
            transcript:     transcript || null,
            agentModel:     agentModel || manifest.generatedWith || null,
            idempotencyKey: manifest.idempotencyKey || id,
        });
    } catch (e) {
        // Preserve the local candidate; allow retry.
        return { ok: false, error: (e && e.message) || String(e) };
    }

    const draftId = resp && (resp.id || resp.draft_id) || null;
    const cfg     = settings.recall();
    const url     = draftId ? `${cfg.skilxivBaseUrl}/account` : null;
    manifest.status   = 'submitted';
    manifest.draftId  = draftId;
    manifest.draftUrl = url;
    manifest.submittedAt = new Date().toISOString();
    await saveManifest(id, manifest);
    return { ok: true, draftId, url };
}

/** Decline a candidate (keep it locally for later). */
async function declineCandidate(id) {
    const loaded = await loadCandidate(id);
    if (!loaded) return { ok: false, error: 'candidate_not_found' };
    loaded.manifest.status = 'declined';
    await saveManifest(id, loaded.manifest);
    return { ok: true };
}

/** Discard a candidate (delete the local bundle). */
async function discardCandidate(id) {
    const dir = candidateDir(id);
    if (!dir) return { ok: false, error: 'no_workspace' };
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: true };
}

module.exports = {
    SECRET_KEY,
    getToken, setToken, clearToken, isSignedIn,
    loadCandidate, saveManifest, saveSkillMd,
    nearDuplicateCheck,
    submitCandidate, declineCandidate, discardCandidate,
};
