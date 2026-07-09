'use strict';
/**
 * Oberon Director — deterministic evidence digests (no LLM).
 *
 * After a fairy stage finishes, the Director LLM must judge the outcome from
 * evidence, not from the fairy's self-assessment alone. This module reads the
 * on-disk artifacts (clean.wb JSON, scroll, facts.json) and compacts them into
 * a bounded text digest for the ASSESS prompt.
 *
 * READ-ONLY: .wb files are only ever parsed here, never written (writing
 * notebooks goes through the notebook APIs elsewhere).
 */

const path = require('path');
const fsp  = require('fs/promises');

// Output substrings that flag a failed/misbehaving cell.
const ERROR_MARKERS = [
    '$Failed', '$Aborted', 'Throw::nocatch', '::argx', '::argr', '::infy',
    'General::stop', 'Syntax::', 'Set::write', 'Part::partw', 'Power::infy',
];

function _truncate(s, n) {
    s = String(s == null ? '' : s);
    if (s.length <= n) return s;
    return s.slice(0, Math.max(0, n - 15)) + ` …[+${s.length - n} chars]`;
}

/** Extract the text/plain payload(s) of one serialized .wb cell's outputs. */
function _cellOutputText(cell) {
    const outs = Array.isArray(cell && cell.outputs) ? cell.outputs : [];
    const texts = [];
    for (const o of outs) {
        // .wb serializer shapes seen in the wild:
        //   { items: [{ mime, value|data }] }  |  { mime, value }  |  { data: { 'text/plain': ... } }
        const items = Array.isArray(o && o.items) ? o.items : [o];
        for (const it of items) {
            if (!it || typeof it !== 'object') continue;
            const mime = it.mime || '';
            let val = it.value != null ? it.value : it.data;
            if (val == null && it.data && typeof it.data === 'object') {
                val = it.data['text/plain'] != null ? it.data['text/plain'] : it.data['application/vnd.code.notebook.stderr'];
            }
            if (val == null) continue;
            if (Array.isArray(val)) val = val.join('\n');
            if (typeof val !== 'string') { try { val = JSON.stringify(val); } catch (_) { continue; } }
            if (!mime || /text\/plain|stderr|error/.test(mime)) texts.push(val);
        }
    }
    return texts.join('\n').trim();
}

/**
 * Digest a delivered clean.wb (or clean_partial.wb): per-cell code + text
 * output, error cells flagged. Returns '' when the file is missing/unreadable.
 *
 * @param {string|null} nbPath
 * @param {{ maxChars?: number, maxCellChars?: number }} [opts]
 */
async function digestCleanNotebook(nbPath, opts = {}) {
    if (!nbPath) return '';
    const maxChars     = opts.maxChars     || 5000;
    const maxCellChars = opts.maxCellChars || 500;
    let nb;
    try { nb = JSON.parse(await fsp.readFile(nbPath, 'utf8')); }
    catch (_) { return ''; }
    const cells = Array.isArray(nb && nb.cells) ? nb.cells : [];
    const lines = [`NOTEBOOK ${path.basename(nbPath)} — ${cells.length} cells:`];
    let codeIdx = 0;
    for (const cell of cells) {
        // kind 2 = code, 1 = markup (serializer convention).
        if (cell.kind === 1) {
            const head = String(cell.value || '').split('\n')[0].trim();
            if (head) lines.push(`[md] ${_truncate(head, 100)}`);
            continue;
        }
        codeIdx++;
        const code = _truncate(String(cell.value || '').trim(), maxCellChars);
        const out  = _cellOutputText(cell);
        const bad  = out && ERROR_MARKERS.some(m => out.includes(m));
        lines.push(`[c${codeIdx}]${bad ? ' ⚠ERROR' : ''} ${code}`);
        if (out) lines.push(`  → ${_truncate(out, maxCellChars)}`);
        if (lines.join('\n').length > maxChars) {
            lines.push(`… (${cells.length} cells total; digest truncated)`);
            break;
        }
    }
    return lines.join('\n');
}

/** Digest the fairy's scroll: status, summary, findings, open questions, self-checks. */
function digestScroll(scroll, opts = {}) {
    if (!scroll) return 'SCROLL: none produced.';
    const maxChars = opts.maxChars || 3000;
    const fa = scroll.fairyArtifact || {};
    const lines = [
        `SCROLL — status: ${fa.status || 'unknown'}, confidence: ${typeof scroll.confidence === 'number' ? scroll.confidence.toFixed(2) : '?'}`,
        `summary: ${_truncate(scroll.summary || '', 400)}`,
    ];
    const findings = Array.isArray(scroll.findings) ? scroll.findings : [];
    if (findings.length) {
        lines.push('findings:');
        for (const f of findings.slice(0, 12)) {
            lines.push(`- ${_truncate(typeof f === 'string' ? f : (f && f.claim) || JSON.stringify(f), 350)}`);
        }
    }
    const openQs = Array.isArray(scroll.openQuestions) ? scroll.openQuestions : [];
    if (openQs.length) {
        lines.push('open questions:');
        for (const q of openQs.slice(0, 6)) lines.push(`- ${_truncate(q, 250)}`);
    }
    const checks = Array.isArray(scroll.selfChecks) ? scroll.selfChecks : [];
    if (checks.length) {
        const bad = checks.filter(c => c && c.match === false);
        lines.push(`self-verification: ${checks.length - bad.length}/${checks.length} evidence re-evaluations matched` +
            (bad.length ? ` — MISMATCHES: ${bad.slice(0, 3).map(c => c.stepId || '?').join(', ')}` : ''));
    }
    return _truncate(lines.join('\n'), maxChars);
}

/** Digest kernel-verified facts from <charmDir>/facts.json. */
async function digestFacts(charmDir, opts = {}) {
    if (!charmDir) return '';
    const maxChars = opts.maxChars || 2500;
    let facts;
    try { facts = JSON.parse(await fsp.readFile(path.join(charmDir, 'facts.json'), 'utf8')); }
    catch (_) { return ''; }
    if (!Array.isArray(facts) || !facts.length) return '';
    const lines = ['FACTS (kernel-verified key→value):'];
    for (const f of facts.slice(0, 24)) {
        lines.push(`- ${_truncate(f.key, 80)} = ${_truncate(f.value, 300)}` +
            (f.confidence != null ? ` (conf ${f.confidence})` : ''));
        if (lines.join('\n').length > maxChars) { lines.push('- … (truncated)'); break; }
    }
    return lines.join('\n');
}

/**
 * Build the full evidence digest for one finished stage.
 *
 * @param {{ scroll?: object|null, cleanNbPath?: string|null,
 *           partialNbPath?: string|null, charmDir?: string|null,
 *           errorNote?: string|null }} art
 * @param {{ maxChars?: number }} [opts]
 * @returns {Promise<string>}
 */
async function buildStageDigest(art, opts = {}) {
    const maxChars = opts.maxChars || 11000;
    const parts = [];
    if (art.errorNote) parts.push(`RUN ERROR: ${_truncate(art.errorNote, 600)}`);
    parts.push(digestScroll(art.scroll));
    const factsD = await digestFacts(art.charmDir);
    if (factsD) parts.push(factsD);
    const nbPath = art.cleanNbPath || art.partialNbPath || null;
    const nbD = await digestCleanNotebook(nbPath);
    if (nbD) parts.push(nbD);
    else parts.push('NOTEBOOK: no clean.wb produced (run did not reach a verified deliverable).');
    return _truncate(parts.filter(Boolean).join('\n\n'), maxChars);
}

/** Compact one-line-per-stage plan view for the ASSESS prompt. */
function renderPlanView(programme, currentStageId) {
    const stages = (programme.plan && programme.plan.stages) || [];
    return stages.map(s => {
        const mark = s.id === currentStageId ? '▶' : ' ';
        return `${mark} ${s.id} [${s.status}${s.attempt > 1 ? ` a${s.attempt}` : ''}] ${_truncate(s.title, 90)}`;
    }).join('\n') || '(no stages)';
}

/** Compact per-stage summaries for the SYNTHESIS prompt. */
function renderStageSummaries(programme, opts = {}) {
    const maxChars = opts.maxChars || 5000;
    const stages = (programme.plan && programme.plan.stages) || [];
    const lines = [];
    for (const s of stages) {
        lines.push(`${s.id} [${s.status}] ${_truncate(s.title, 100)}`);
        const a = s.assessment;
        if (a) {
            lines.push(`   verdict: ${a.verdict}${a.surprise && a.surprise !== 'none' ? `, surprise: ${a.surprise}` : ''}` +
                (a.reason ? ` — ${_truncate(a.reason, 180)}` : ''));
            for (const iss of (a.issues || []).slice(0, 2)) lines.push(`   issue: ${_truncate(iss, 150)}`);
        }
        if (s.cleanNbPath) lines.push(`   notebook: ${s.cleanNbPath}`);
        if (lines.join('\n').length > maxChars) { lines.push('… (truncated)'); break; }
    }
    return lines.join('\n') || '(no stages executed)';
}

/** Compact literature note (papers + observations) for synthesis/assess prompts. */
function renderLiteratureNote(programme, opts = {}) {
    const maxChars = opts.maxChars || 2500;
    const briefs = programme.literature || [];
    if (!briefs.length) return '';
    const lines = [];
    for (const b of briefs) {
        lines.push(`[${b.id}] Q: ${_truncate(b.question, 200)}`);
        for (const p of (b.papers || []).slice(0, 6)) {
            const ref = p.arxivId ? `arXiv:${p.arxivId}` : (p.doi || p.ref || '');
            lines.push(`  - ${_truncate(p.title, 110)}${p.year ? ` (${p.year})` : ''}${ref ? ` [${ref}]` : ''}` +
                (p.reason ? ` — ${_truncate(p.reason, 140)}` : ''));
        }
        for (const o of (b.observations || []).slice(0, 4)) {
            lines.push(`  · ${_truncate(o.text, 200)}`);
        }
        if (lines.join('\n').length > maxChars) { lines.push('… (truncated)'); break; }
    }
    return lines.join('\n');
}

module.exports = {
    digestCleanNotebook, digestScroll, digestFacts, buildStageDigest,
    renderPlanView, renderStageSummaries, renderLiteratureNote,
    _internals: { _cellOutputText, _truncate, ERROR_MARKERS },
};
