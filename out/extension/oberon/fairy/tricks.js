'use strict';
/**
 * Oberon Fairy — local Wolfram-Language tricks (Tricks v1.0, Phase 1).
 *
 * Design: SkilXiv.org/Docs/20-tricks-v1.0.md. Phase 1 is LOCAL-ONLY:
 * a bundled seed pack (tricks.seed.json, mined from the 2026-08 gold-run
 * failure telemetry) merged with an optional user-editable file at
 * <workspace>/.oberon/tricks/tricks.local.json (same record shape; same id
 * overrides seed).
 *
 * Two delivery tiers (wired in core/fairy.js):
 *  - Tier A: renderPrefixPack() — top-priority tricks as a compact block in
 *    the run's system prompt (stable prefix → cache-cheap prevention).
 *  - Tier B: matchTricks() — DETERMINISTIC signature match against a failed
 *    probe's kernel messages / error / code / harness kind; the 1–2 matching
 *    tricks ride back with the failure payload. Zero LLM cost, exactly timed.
 *
 * Trick record: { id, title (≤80), body (≤500), example?, signatures: [
 *   {kind: 'message'|'regex'|'code'|'harness', value} ], priority (0–100),
 *   tags?, tierA? } — tierA:true marks prefix-pack membership.
 *
 * vscode-free; unit-tested headlessly (tests/tricks.test.js).
 */

const fs   = require('fs');
const path = require('path');

const MAX_MATCHES_PER_FAILURE = 2;
const MAX_SHOWS_PER_TRICK     = 2;
const REGEX_TIME_GUARD_LEN    = 4000;   // only match regexes against capped text

let _seedCache = null;

function loadSeedPack() {
    if (_seedCache) return _seedCache;
    try {
        _seedCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'tricks.seed.json'), 'utf8'));
    } catch (_) { _seedCache = []; }
    return _seedCache;
}

/**
 * Load the effective trick list: seed pack + optional local overrides.
 * @param {string|null} localPath  e.g. <workspace>/.oberon/tricks/tricks.local.json
 */
function loadTricks(localPath) {
    const byId = new Map();
    for (const t of loadSeedPack()) if (validTrick(t)) byId.set(t.id, t);
    if (localPath) {
        try {
            const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
            for (const t of (Array.isArray(local) ? local : [])) {
                if (validTrick(t)) byId.set(t.id, t);   // local wins on id collision
                else if (t && t.id && t.disabled) byId.delete(t.id);   // {id, disabled:true} removes a seed trick
            }
        } catch (_) { /* absent or malformed local file — seed only */ }
    }
    return [...byId.values()];
}

function validTrick(t) {
    return t && typeof t.id === 'string' && t.id
        && typeof t.title === 'string' && t.title.length <= 120
        && typeof t.body === 'string' && t.body.length <= 700
        && !t.disabled;
}

/**
 * Deterministically match tricks against a failure.
 * @param {object[]} tricks
 * @param {{ messages?: string, error?: string, code?: string, kind?: string }} failure
 * @returns {object[]} up to MAX_MATCHES_PER_FAILURE tricks, highest priority first
 */
function matchTricks(tricks, failure) {
    const msgText = String(failure.messages || '') + ' ' + String(failure.error || '');
    const msgCapped = msgText.slice(0, REGEX_TIME_GUARD_LEN);
    const code = String(failure.code || '').slice(0, REGEX_TIME_GUARD_LEN);
    const kind = String(failure.kind || '');

    const hits = [];
    for (const t of tricks) {
        const sigs = Array.isArray(t.signatures) ? t.signatures : [];
        let hit = false;
        for (const s of sigs) {
            if (!s || typeof s.value !== 'string') continue;
            try {
                if (s.kind === 'message' && msgText.includes(s.value)) hit = true;
                else if (s.kind === 'harness' && kind === s.value) hit = true;
                else if (s.kind === 'code' && code.includes(s.value)) hit = true;
                else if (s.kind === 'regex') {
                    const re = new RegExp(s.value, 'i');
                    if (re.test(msgCapped) || re.test(code)) hit = true;
                }
            } catch (_) { /* bad regex — skip signature */ }
            if (hit) break;
        }
        if (hit) hits.push(t);
    }
    hits.sort((a, b) => (b.priority || 50) - (a.priority || 50));
    return hits.slice(0, MAX_MATCHES_PER_FAILURE);
}

/** Render a matched trick for injection next to the failure payload. */
function renderTrick(t) {
    let s = `[WL trick — ${t.title}]: ${t.body}`;
    if (t.example) s += `\n  e.g. ${t.example}`;
    return s;
}

/**
 * Tier A: compact prevention block for the system prompt (stable prefix).
 * Includes tricks marked tierA:true, ordered by priority, within maxChars.
 */
function renderPrefixPack(tricks, { maxChars = 6000 } = {}) {
    const tierA = tricks.filter(t => t.tierA).sort((a, b) => (b.priority || 50) - (a.priority || 50));
    if (!tierA.length) return '';
    const lines = ['', '## Wolfram gotchas (hard-won — respect these)', ''];
    let used = lines.join('\n').length;
    for (const t of tierA) {
        const line = `- **${t.title}**: ${t.body}`;
        if (used + line.length > maxChars) break;
        lines.push(line);
        used += line.length + 1;
    }
    return lines.join('\n');
}

/** Extract WL message names (Foo::bar) from message text. */
function extractMessageNames(text) {
    const names = String(text || '').match(/[A-Za-z$][A-Za-z0-9$`]*::[a-z0-9]+/g) || [];
    return [...new Set(names)].filter(n => !n.startsWith('General::stop'));
}

/**
 * The trick-growth loop: failures NO trick matched are appended to a local
 * JSONL ledger. `summarizeUnmatched` aggregates it — recurring names are the
 * next tricks to author (by hand today; by the Phase-2 distiller later).
 */
function recordUnmatched(filePath, names, sample) {
    if (!filePath || !names.length) return;
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const line = JSON.stringify({ ts: new Date().toISOString(), names, sample: String(sample || '').slice(0, 200) });
        fs.appendFileSync(filePath, line + '\n', 'utf8');
    } catch (_) { /* best-effort */ }
}

function summarizeUnmatched(filePath, { top = 15 } = {}) {
    let lines = [];
    try { lines = fs.readFileSync(filePath, 'utf8').trim().split('\n'); } catch (_) { return []; }
    const counts = Object.create(null);
    const samples = Object.create(null);
    for (const l of lines) {
        try {
            const r = JSON.parse(l);
            for (const n of (r.names || [])) {
                counts[n] = (counts[n] || 0) + 1;
                if (!samples[n]) samples[n] = r.sample || '';
            }
        } catch (_) {}
    }
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1]).slice(0, top)
        .map(([name, count]) => ({ name, count, sample: samples[name] }));
}

/**
 * Tricks Phase 2 (Stage A4, 2026-08-04): turn the unmatched ledger into
 * reviewable CANDIDATE tricks.
 *
 * Phase 1 recorded unmatched failure signatures; promoting them was entirely
 * manual (all 27 seed tricks were hand-authored from postmortems). This ranks
 * the ledger, drops signatures an existing trick already covers, and emits
 * ready-to-edit stubs for `tricks.local.json`.
 *
 * Deliberately NOT auto-installed: a trick is prompt-level advice shown at the
 * worst moment of a run — a wrong one costs more than a missing one. The stub
 * carries `disabled: true` so a human must read, fix the body, and enable it.
 *
 * @returns {Array<{name, count, sample, stub}>}
 */
function proposeTricksFromUnmatched(filePath, tricks, { top = 10, minCount = 2 } = {}) {
    const summary = summarizeUnmatched(filePath, { top: 40 });
    const out = [];
    for (const row of summary) {
        if (row.count < minCount) continue;
        // Skip anything an existing trick already matches on the message name.
        const covered = matchTricks(tricks || [], { messages: row.name + ' ' + (row.sample || '') }).length > 0;
        if (covered) continue;
        const slug = String(row.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        out.push({
            name:   row.name,
            count:  row.count,
            sample: row.sample,
            stub: {
                id:    `wolfram/${slug}`,
                title: `TODO: one-line rule for ${row.name}`,
                body:  `TODO: what causes ${row.name}, and the concrete fix. Observed ${row.count}× ` +
                       `across runs. Sample: ${String(row.sample || '').slice(0, 160)}`,
                signatures: [{ kind: 'message', value: row.name }],
                priority: 60,
                tierA: false,
                disabled: true,   // review, fix the body, then flip to enable
            },
        });
        if (out.length >= top) break;
    }
    return out;
}

module.exports = {
    loadTricks, matchTricks, renderTrick, renderPrefixPack,
    extractMessageNames, recordUnmatched, summarizeUnmatched,
    proposeTricksFromUnmatched,
    MAX_MATCHES_PER_FAILURE, MAX_SHOWS_PER_TRICK,
};
