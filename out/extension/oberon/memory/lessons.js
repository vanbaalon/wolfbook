'use strict';
/**
 * Cross-run LESSONS channel (Stage 3, plan §Stage 3 item 1).
 *
 * The gap this closes: before this module, NOTHING a run learned re-entered a
 * later run's prompt. Postmortems, skill gaps and the grimoire were all
 * write-only surfaces (audit finding 2026-08-01: "no cross-run lessons memory").
 *
 * Source: the `lessons` array of the fairy's own self-postmortem — transferable
 * one-liners the agent already produces at zero extra LLM cost. Storage: a
 * bounded, deduplicated section INSIDE the grimoire file (the plan is explicit:
 * one canonical memory surface, no parallel lessons.md that can drift).
 *
 * The curated layer above this is the tricks pack (fairy/tricks.js): lessons are
 * RAW observations, promoted by hand into signature-matched tricks when they
 * recur. Keeping both is deliberate — this file must never write tricks.
 *
 * vscode-free; unit-tested headlessly.
 */

const fsp  = require('fs/promises');
const path = require('path');

const SECTION_HEADER = '## Lessons (cross-run, newest first)';
const MAX_LESSONS    = 14;     // bounded — the prompt excerpt must stay cheap
const MAX_LESSON_LEN = 240;

/** Normalise for dedup: case/punctuation/whitespace-insensitive key. */
function lessonKey(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
}

/**
 * Two lessons are "the same" when one is a prefix of the other — the model
 * re-states the same insight at different lengths across runs, and exact-key
 * dedup would let the lessons section fill with near-duplicates.
 */
function sameLesson(a, b) {
    if (a === b) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= 40 && long.startsWith(short);
}

/**
 * A lesson is only useful if it transfers. Reject the task-specific residue the
 * model sometimes emits despite the prompt (probe ids, "this run", bare symbol
 * chatter) — a bad lesson is worse than no lesson: it misleads every later run.
 */
function isTransferable(text) {
    const t = String(text || '').trim();
    if (t.length < 20 || t.length > MAX_LESSON_LEN) return false;
    if (/\bp\d{3}\b/i.test(t)) return false;                       // probe id
    if (/\bstep_[a-z0-9_]+/i.test(t)) return false;                // step id
    if (/\bthis (run|task|session|probe|chain)\b/i.test(t)) return false;
    if (/\b(goldResult|goldBethe|goldSingle)\b/.test(t)) return false;  // contract symbols
    return true;
}

function parseSection(text) {
    const idx = text.indexOf(SECTION_HEADER);
    if (idx < 0) return { before: text, lessons: [], after: '' };
    const rest  = text.slice(idx + SECTION_HEADER.length);
    const endRel = rest.search(/\n## /);
    const body  = endRel < 0 ? rest : rest.slice(0, endRel);
    const after = endRel < 0 ? '' : rest.slice(endRel);
    const lessons = [];
    for (const line of body.split('\n')) {
        const m = line.match(/^-\s+(.*?)\s*(?:_\(([^)]*)\)_)?\s*$/);
        if (m && m[1].trim()) lessons.push({ text: m[1].trim(), provenance: m[2] || '' });
    }
    return { before: text.slice(0, idx), lessons, after };
}

function renderSection(lessons) {
    const lines = [SECTION_HEADER, ''];
    for (const l of lessons) {
        lines.push(`- ${l.text}${l.provenance ? ` _(${l.provenance})_` : ''}`);
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * Merge new lessons into the grimoire's lessons section.
 *
 * @param {string} grimoirePath
 * @param {string[]} lessons     raw lesson strings from a self-postmortem
 * @param {string} provenance    e.g. "QG_TS09_abc123"
 * @returns {Promise<{added: number, total: number}>}
 */
async function recordLessons(grimoirePath, lessons, provenance) {
    const fresh = (Array.isArray(lessons) ? lessons : [])
        .map(s => String(s || '').trim())
        .filter(isTransferable);
    if (!fresh.length || !grimoirePath) return { added: 0, total: 0 };

    let text = '';
    try { text = await fsp.readFile(grimoirePath, 'utf8'); } catch (_) { text = ''; }
    const { before, lessons: existing, after } = parseSection(text);

    const seen = existing.map(l => lessonKey(l.text));
    const added = [];
    for (const t of fresh) {
        const k = lessonKey(t);
        if (seen.some(s2 => sameLesson(s2, k))) continue;
        seen.push(k);
        added.push({ text: t, provenance: provenance || '' });
    }
    if (!added.length) return { added: 0, total: existing.length };

    // Newest first, bounded.
    const merged = [...added, ...existing].slice(0, MAX_LESSONS);
    const section = renderSection(merged);
    const next = parseSection(text).before === text && !text.includes(SECTION_HEADER)
        ? (text.trimEnd() + '\n\n' + section)     // section did not exist yet
        : (before.trimEnd() + '\n\n' + section + after);
    await fsp.mkdir(path.dirname(grimoirePath), { recursive: true }).catch(() => {});
    await fsp.writeFile(grimoirePath, next, 'utf8');
    return { added: added.length, total: merged.length };
}

/**
 * Bounded excerpt for injection into a run's FIRST user message (cache-stable
 * position — never mid-history, which would break the provider prompt cache).
 */
async function lessonsExcerpt(grimoirePath, { limit = 8, maxChars = 1200 } = {}) {
    if (!grimoirePath) return '';
    let text = '';
    try { text = await fsp.readFile(grimoirePath, 'utf8'); } catch (_) { return ''; }
    const { lessons } = parseSection(text);
    if (!lessons.length) return '';
    const head = lessons.slice(0, limit);
    let out = 'LESSONS FROM PREVIOUS RUNS (hard-won; apply where relevant, ignore where not):\n';
    for (const l of head) {
        const line = `- ${l.text}\n`;
        if (out.length + line.length > maxChars) break;
        out += line;
    }
    return out.trimEnd();
}

module.exports = { recordLessons, lessonsExcerpt, isTransferable, lessonKey, sameLesson, SECTION_HEADER, MAX_LESSONS };
