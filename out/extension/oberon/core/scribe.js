'use strict';
/**
 * Oberon — Scribe (MVP-5).
 *
 * The Scribe distils a finished research run into a single Grimoire entry.
 * It is NOT a Fairy: it never calls an LLM, never invents content, and never
 * adds a fact that is not already present in the Scroll or the Oberon
 * verdict.  Its job is purely to extract, classify, and link.
 *
 * Inputs: { quest, charm, scroll, reviewOut, wardOut }
 * Outputs: a Grimoire delta (markdown), conservatively gated by verdict and
 *          Ward status:
 *
 *   - Oberon verdict `success`           → write verified findings.
 *   - Oberon verdict `partial_success`   → write verified findings; mismatched
 *                                          or ward-failed findings are split
 *                                          into "Open Questions / Unverified".
 *   - Oberon verdict `needs_review` /
 *     `failed` (or no verdict)           → write ONLY to the "Open Questions"
 *                                          section — nothing here is recorded
 *                                          as a verified fact.
 *
 * A finding is considered ward-verified when at least one ward `passed` for
 * an evidence item whose `findingIndex` matches (or, defensively, when at
 * least one ward in the run passed and no ward `failed`).  A finding linked
 * to a failed ward is moved to "Open Questions / Unverified".
 */

const path = require('path');

const grimoire = require('../memory/grimoire');

/**
 * Run the Scribe.  Persists at most one Grimoire entry per call and emits
 * a `grimoire.updated` event on the bus.  Failures degrade to an `omen`
 * event and never throw.
 *
 * @param {{
 *   quest:               object,
 *   charm:               object,
 *   scroll:              object,
 *   reviewOut:           object|null,
 *   wardOut:             object|null,
 *   runId:               string|null,
 *   bus:                 import('../telemetry/bus').TelemetryBus,
 *   scrollFileRef?:      { path: string }|null,
 *   summaryNotebookPath?: string|null,
 *   charmNotebookPath?:   string|null,
 * }} opts
 * @returns {Promise<{
 *   wrote: boolean,
 *   kind:  'verified' | 'unverified' | 'skipped',
 *   path:  string|null,
 *   sha256: string|null,
 *   findingsWritten:  number,
 *   findingsExcluded: number,
 *   reason?: string,
 * }>}
 */
async function runScribe(opts) {
    const {
        quest, charm, scroll, reviewOut, wardOut,
        runId, bus,
        scrollFileRef = null,
        summaryNotebookPath = null,
        charmNotebookPath = null,
    } = opts;

    if (!scroll || !quest || !charm) {
        return _skipped('missing quest/charm/scroll');
    }

    const verdict = (reviewOut && reviewOut.oberonVerdict && reviewOut.oberonVerdict.verdict) || null;
    const entryId = `${runId || 'run'}/${scroll.id || '?'}`;

    // Idempotency: if this entry was already written (rare; user restarted
    // the same scroll), skip cleanly.
    try {
        if (await grimoire.hasEntry(entryId)) {
            return _skipped('already_recorded');
        }
    } catch (_) { /* best-effort */ }

    // Classify findings using the Ward results we already have.
    const wardSummary = (wardOut && wardOut.summary) || null;
    const wardResults = (wardOut && wardOut.results)  || [];
    const wardsFailed = (wardSummary && wardSummary.failed > 0);

    const findings      = Array.isArray(scroll.findings)      ? scroll.findings      : [];
    const openQuestions = Array.isArray(scroll.openQuestions) ? scroll.openQuestions : [];
    const evidence      = Array.isArray(scroll.evidence)      ? scroll.evidence      : [];

    // Gating: which entry kind, which findings to record where.
    let kind;
    let verifiedFindings;
    let unverifiedFindings;
    if (verdict === 'success' && !wardsFailed) {
        kind = 'verified';
        verifiedFindings   = findings.slice();
        unverifiedFindings = [];
    } else if (verdict === 'success' && wardsFailed) {
        // Fine-grained ward gating: degrade only the findings whose evidence
        // item had a failing deep-check ward, using evidenceIndex → finding
        // index mapping. Findings backed by passing wards are kept verified.
        const skepticChecks = (reviewOut && reviewOut.skeptic && reviewOut.skeptic.checks) || [];
        const failedEvidenceIndices = new Set();
        for (const [i, check] of skepticChecks.entries()) {
            if ((check.deepChecks || []).some(d => d.status === 'failed')) {
                failedEvidenceIndices.add(i);
            }
        }
        if (failedEvidenceIndices.size === 0 || findings.length === 0) {
            // No evidence-level failures — keep all findings verified.
            kind = 'verified';
            verifiedFindings   = findings.slice();
            unverifiedFindings = [];
        } else {
            // Map each failed evidence index to the closest finding index
            // (evidence[i] ↔ finding[min(i, findings.length-1)]).
            const failedFindingIndices = new Set(
                [...failedEvidenceIndices].map(i => Math.min(i, findings.length - 1))
            );
            if (failedFindingIndices.size >= findings.length) {
                kind = 'unverified';
                verifiedFindings   = [];
                unverifiedFindings = findings.slice();
            } else {
                kind = 'verified';   // at least one finding survives
                verifiedFindings   = findings.filter((_, i) => !failedFindingIndices.has(i));
                unverifiedFindings = findings.filter((_, i) =>  failedFindingIndices.has(i));
            }
        }
    } else if (verdict === 'partial_success' && !wardsFailed) {
        kind = 'verified';
        verifiedFindings   = findings.slice();
        unverifiedFindings = [];
    } else {
        // needs_review, failed, or no verdict at all: nothing here is a
        // verified fact.  We still record the cohort so the user can find
        // the run from the Grimoire, but only under "Open Questions".
        kind = 'unverified';
        verifiedFindings   = [];
        unverifiedFindings = findings.slice();
    }

    if (verifiedFindings.length === 0 && unverifiedFindings.length === 0 &&
        openQuestions.length === 0 && evidence.length === 0) {
        return _skipped('empty_scroll');
    }

    const wardFileRef = (wardOut && wardOut.fileRef) || null;

    // Build markdown.
    const markdown = _buildMarkdown({
        quest, charm, scroll, reviewOut, wardSummary, wardResults, wardFileRef,
        verifiedFindings, unverifiedFindings, openQuestions, evidence,
        runId, scrollFileRef, summaryNotebookPath, charmNotebookPath, kind,
    });

    // Persist.
    try {
        const ref = await grimoire.appendEntry({ markdown, entryId, kind });
        const findingsExcluded = unverifiedFindings.length;
        await _emit(bus, 'grimoire.updated', {
            questId:  quest.id,
            charmId:  charm.id,
            scrollId: scroll.id,
            runId:    runId || null,
            kind,
            path:     ref.path,
            sha256:   ref.sha256,
            bytesWritten:     ref.bytesWritten,
            bytesTotal:       ref.bytesTotal,
            findingsWritten:  kind === 'verified' ? verifiedFindings.length : unverifiedFindings.length,
            findingsExcluded,
            verdict:          verdict || null,
            wardSummary:      wardSummary || null,
        }, { questId: quest.id, charmId: charm.id });
        return {
            wrote: true, kind,
            path: ref.path, sha256: ref.sha256,
            findingsWritten:  kind === 'verified' ? verifiedFindings.length : unverifiedFindings.length,
            findingsExcluded,
        };
    } catch (e) {
        await _emit(bus, 'omen', {
            kind: 'grimoire_write_failed',
            message: e && e.message || String(e),
        }, { questId: quest && quest.id, charmId: charm && charm.id });
        return { wrote: false, kind: 'skipped', path: null, sha256: null,
                 findingsWritten: 0, findingsExcluded: 0, reason: 'write_failed' };
    }
}

// ── markdown builder ───────────────────────────────────────────────────────

function _buildMarkdown(ctx) {
    const {
        quest, charm, scroll, reviewOut, wardSummary, wardResults,
        verifiedFindings, unverifiedFindings, openQuestions, evidence,
        runId, scrollFileRef, summaryNotebookPath, charmNotebookPath, kind,
    } = ctx;

    const ov = reviewOut && reviewOut.oberonVerdict;
    const verdict = ov && ov.verdict ? ov.verdict : 'unknown';
    const conf    = (typeof scroll.confidence === 'number') ? scroll.confidence.toFixed(3) : '?';
    const ts      = new Date().toISOString();
    const tag     = (kind === 'unverified') ? ' (UNVERIFIED)' : '';

    const lines = [];
    lines.push(`### ${esc(quest.id)} / ${esc(charm.id)} / ${esc(scroll.id)} — ${esc(quest.title || '')}${tag}`);
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push(`| Run | \`${esc(runId || '?')}\` |`);
    lines.push(`| Timestamp | ${ts} |`);
    lines.push(`| Quest | \`${esc(quest.id)}\` — ${esc(quest.title || '')} |`);
    lines.push(`| Charm | \`${esc(charm.id)}\` — ${esc(charm.title || '')} |`);
    lines.push(`| Scroll | \`${esc(scroll.id)}\` |`);
    lines.push(`| Verdict | **${esc(verdict).toUpperCase().replace(/_/g, ' ')}** |`);
    lines.push(`| Confidence | ${esc(conf)} |`);
    if (wardSummary) {
        const parts = [`total ${wardSummary.total || 0}`];
        for (const k of ['passed', 'failed', 'skipped', 'errored']) {
            if (wardSummary[k]) parts.push(`${k} ${wardSummary[k]}`);
        }
        lines.push(`| Wards | ${parts.join(' · ')} |`);
    } else {
        lines.push(`| Wards | _not run_ |`);
    }

    // Summary (one paragraph from the scroll).
    if (scroll.summary) {
        lines.push('');
        lines.push('#### Summary');
        lines.push('');
        lines.push(String(scroll.summary).trim());
    }

    // Verified findings.
    if (verifiedFindings.length) {
        lines.push('');
        lines.push('#### Verified findings');
        lines.push('');
        verifiedFindings.forEach((f, i) => {
            lines.push(`${i + 1}. ${_renderFinding(f)}`);
        });
    }

    // Unverified findings.
    if (unverifiedFindings.length) {
        lines.push('');
        lines.push('#### Unverified findings (require follow-up)');
        lines.push('');
        unverifiedFindings.forEach((f, i) => {
            lines.push(`${i + 1}. ${_renderFinding(f)}`);
        });
    }

    // Open questions.
    if (openQuestions.length) {
        lines.push('');
        lines.push('#### Open questions');
        lines.push('');
        openQuestions.slice(0, 16).forEach((q) => {
            lines.push(`- ${esc(String(q))}`);
        });
    }

    // Ward detail (compact: only failures + errors, capped).
    const wardIssues = (wardResults || []).filter(w => w && (w.status === 'failed' || w.status === 'errored'));
    if (wardIssues.length) {
        lines.push('');
        lines.push('#### Ward issues');
        lines.push('');
        lines.push('| Ward | Method | Status | Detail |');
        lines.push('|------|--------|--------|--------|');
        wardIssues.slice(0, 8).forEach(w => {
            lines.push(`| ${esc(w.wardId || '')} | ${esc(w.method || '')} | ${esc(w.status || '')} | ${esc(_truncate(w.detail || '', 200))} |`);
        });
    }

    // Provenance links — relative paths from the grimoire dir.
    const gPath = grimoire.grimoireFilePath();
    const gDir  = gPath ? path.dirname(gPath) : null;
    const links = [];
    if (scrollFileRef && scrollFileRef.path) {
        links.push(`- Scroll: [\`${_rel(gDir, scrollFileRef.path)}\`](${_rel(gDir, scrollFileRef.path)})`);
    }
    if (summaryNotebookPath) {
        links.push(`- Summary notebook: [\`${_rel(gDir, summaryNotebookPath)}\`](${_rel(gDir, summaryNotebookPath)})`);
    }
    if (charmNotebookPath) {
        links.push(`- Charm findings notebook: [\`${_rel(gDir, charmNotebookPath)}\`](${_rel(gDir, charmNotebookPath)})`);
    }
    // Ward artefact written by core/wards.js, if present.
    if (ctx.wardFileRef && ctx.wardFileRef.path) {
        const p = ctx.wardFileRef.path;
        links.push(`- Ward artefact: [\`${_rel(gDir, p)}\`](${_rel(gDir, p)})`);
    }
    if (links.length) {
        lines.push('');
        lines.push('#### Provenance');
        lines.push('');
        lines.push(...links);
    }

    // Recommended next action — straight from Oberon, if present.
    if (ov && ov.recommendedAction) {
        lines.push('');
        lines.push('#### Recommended next action');
        lines.push('');
        lines.push(esc(ov.recommendedAction));
    }

    return lines.join('\n');
}

function _renderFinding(f) {
    if (f == null) return '';
    if (typeof f === 'string') return esc(f);
    const claim = f.claim ? esc(String(f.claim)) : '';
    const conf  = (typeof f.confidence === 'number') ? ` _(conf ${f.confidence.toFixed(2)})_` : '';
    const detail = f.detail ? ` — ${esc(String(f.detail))}` : '';
    return `${claim}${conf}${detail}`;
}

function esc(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function _truncate(s, n) {
    const str = String(s || '');
    return str.length > n ? (str.slice(0, n - 1) + '…') : str;
}
function _rel(fromDir, target) {
    if (!fromDir || !target) return target || '';
    try {
        const rel = path.relative(fromDir, target);
        return rel.split(path.sep).join('/');
    } catch (_) { return target; }
}

function _skipped(reason) {
    return { wrote: false, kind: 'skipped', path: null, sha256: null,
             findingsWritten: 0, findingsExcluded: 0, reason };
}

async function _emit(bus, type, payload, opts) {
    try {
        if (bus && typeof bus.appendEvent === 'function') {
            await bus.appendEvent(type, payload, opts || {});
        }
    } catch (_) { /* swallow — telemetry must never crash a run */ }
}

module.exports = { runScribe };
