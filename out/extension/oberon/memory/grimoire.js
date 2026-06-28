'use strict';
/**
 * Oberon — Grimoire persistence (MVP-5).
 *
 * The Grimoire is a single human-readable, agent-readable, *committed*
 * markdown file at:
 *
 *   <workspace>/grimoire/canonical_state.md
 *
 * It is append-only, audit-friendly, and never rewritten in place: each
 * accepted research run adds one delimited section.  A second section,
 * "Open Questions / Unverified", is appended for partial / rejected runs
 * (and for findings whose Wards failed within an otherwise-accepted run)
 * so we never silently lose user-facing material.
 *
 * Design choices:
 *   - Single-file first: easier to commit, diff, and review.  We can split
 *     by topic later without breaking callers (the public API stays the
 *     same: write a delta, get a fileRef).
 *   - Hash the FILE after the append (not just the delta) so consumers can
 *     spot tampering / accidental external edits across runs.
 *   - Best-effort writes: the caller is expected to wrap us in try/catch
 *     and degrade to an `omen` event on failure (the research flow must
 *     never crash because the Grimoire was unwritable).
 */

const path  = require('path');
const fs    = require('fs');
const fsp   = require('fs/promises');
const crypto = require('crypto');
const { exec } = require('child_process');
const util  = require('util');
const execAsync = util.promisify(exec);

const project  = require('./project');
const settings = require('../config/settings');

const FILE_NAME = 'canonical_state.md';

const FILE_HEADER = [
    '# Oberon Grimoire',
    '',
    'Canonical state — accepted findings, open questions, and verification trail.',
    'Append-only; do not edit historical entries in place.  Each entry is delimited',
    'by `<!-- @grimoire:entry … -->` markers so future tooling can parse the file',
    'without ambiguity.',
    '',
    '---',
    '',
].join('\n');

const OPEN_SECTION_HEADER = [
    '## Open Questions / Unverified',
    '',
    '_Findings that could not be verified (Skeptic disputed, Wards failed, or the',
    'Oberon verdict was below `accept`).  Track here until they are resolved._',
    '',
].join('\n');

/** @returns {string|null} */
function grimoireFilePath() {
    const dir = project.grimoireDir();
    return dir ? path.join(dir, FILE_NAME) : null;
}

/**
 * Ensure the grimoire file exists with the standard header.  Returns the
 * absolute path or null when no workspace is open.
 */
async function ensureGrimoireFile() {
    const dir = project.grimoireDir();
    if (!dir) return null;
    await fsp.mkdir(dir, { recursive: true });
    const fp = path.join(dir, FILE_NAME);
    try {
        await fsp.access(fp, fs.constants.F_OK);
    } catch (_) {
        await fsp.writeFile(fp, FILE_HEADER, 'utf8');
    }
    return fp;
}

/**
 * Append one block of markdown to the Grimoire.
 *
 * The caller is responsible for the markdown content — this module only
 * handles the file existence guarantee, the delimiter envelope, and the
 * file-level sha256 returned for telemetry.
 *
 * @param {{
 *   markdown:  string,            // pre-rendered markdown body (no leading newline required)
 *   entryId:   string,            // stable id (e.g. runId or `${runId}/${scrollId}`)
 *   kind?:     'verified' | 'unverified',
 * }} opts
 * @returns {Promise<{ path: string, sha256: string, bytesWritten: number, bytesTotal: number }>}
 */
async function appendEntry({ markdown, entryId, kind = 'verified' }) {
    const fp = await ensureGrimoireFile();
    if (!fp) throw new Error('no workspace folder — Grimoire path unavailable');

    const ts = new Date().toISOString();
    const k  = (kind === 'unverified') ? 'unverified' : 'verified';

    // For unverified entries, append under the "Open Questions / Unverified"
    // section.  We make sure the section header exists exactly once.
    if (k === 'unverified') {
        const existing = await fsp.readFile(fp, 'utf8');
        if (!existing.includes('## Open Questions / Unverified')) {
            await fsp.appendFile(fp, '\n' + OPEN_SECTION_HEADER, 'utf8');
        }
    }

    const open  = `<!-- @grimoire:entry id="${entryId}" kind="${k}" ts="${ts}" -->`;
    const close = `<!-- @grimoire:entry:end id="${entryId}" -->`;
    const body  = `\n${open}\n${markdown.trim()}\n${close}\n`;

    await fsp.appendFile(fp, body, 'utf8');
    const stat = await fsp.stat(fp);
    const buf  = await fsp.readFile(fp);
    const sha256 = 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');

    // ── Optional git auto-commit ────────────────────────────────────────
    // Gated by `wolfbook.oberon.git.autoCommitGrimoire` (default true).
    // Non-fatal: silently skipped when the workspace is not a git repository.
    if (settings.git().autoCommitGrimoire) {
        try {
            const cwd        = path.dirname(fp);
            const msg        = `oberon: ${entryId} — ${k}`;
            await execAsync(`git add "${fp}"`, { cwd });
            await execAsync(`git commit -m "${msg.replace(/"/g, "'")}"`, { cwd });
        } catch (_) {
            // git not available or not a repo — ignore.
        }
    }

    return { path: fp, sha256, bytesWritten: Buffer.byteLength(body, 'utf8'), bytesTotal: stat.size };
}

/**
 * Cheap scan: returns true when the Grimoire file already contains an entry
 * with the given entryId.  Used to keep repeated runs idempotent — callers
 * should skip re-writing the same scroll's entry on a second pass.
 *
 * @param {string} entryId
 * @returns {Promise<boolean>}
 */
async function hasEntry(entryId) {
    const fp = grimoireFilePath();
    if (!fp) return false;
    try {
        const text = await fsp.readFile(fp, 'utf8');
        const needle = `<!-- @grimoire:entry id="${entryId}"`;
        return text.includes(needle);
    } catch (_) {
        return false;
    }
}

/**
 * Stage-4 S4.5/4.6 — return a compact markdown snippet of the most recent
 * `limit` Grimoire entries (verified + unverified, newest first) capped at
 * `maxChars`. Used by Planner intake and Executive briefs so new Quests
 * inherit canonical context from prior runs.
 *
 * Returns '' when the Grimoire file is missing, empty, or unreadable.
 *
 * @param {{limit?: number, maxChars?: number}} [opts]
 * @returns {Promise<string>}
 */
async function recentEntriesSummary(opts = {}) {
    const limit    = Math.max(1, Math.min(20, opts.limit || 6));
    const maxChars = Math.max(200, Math.min(8000, opts.maxChars || 2400));
    const fp = grimoireFilePath();
    if (!fp) return '';
    let text;
    try { text = await fsp.readFile(fp, 'utf8'); }
    catch (_) { return ''; }
    // Parse delimited entries: open marker to matching close marker.
    const re = /<!--\s*@grimoire:entry\s+id="([^"]+)"\s+kind="([^"]+)"\s+ts="([^"]+)"\s*-->([\s\S]*?)<!--\s*@grimoire:entry:end\s+id="\1"\s*-->/g;
    const entries = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        entries.push({ id: m[1], kind: m[2], ts: m[3], body: m[4].trim() });
    }
    if (entries.length === 0) return '';
    // Newest first.
    entries.reverse();
    const head = entries.slice(0, limit);
    let out = `## Grimoire — last ${head.length} entr${head.length === 1 ? 'y' : 'ies'} (newest first)\n\n`;
    for (const e of head) {
        // Truncate body to keep snippet compact.
        const body = e.body.length > 600 ? e.body.slice(0, 600) + '\n[…truncated]' : e.body;
        out += `### ${e.id} _(${e.kind}, ${e.ts.slice(0, 10)})_\n${body}\n\n`;
        if (out.length > maxChars) {
            out = out.slice(0, maxChars) + '\n[…snippet truncated]';
            break;
        }
    }
    return out;
}

module.exports = {
    grimoireFilePath,
    ensureGrimoireFile,
    appendEntry,
    hasEntry,
    recentEntriesSummary,
    FILE_HEADER,
    OPEN_SECTION_HEADER,
};
