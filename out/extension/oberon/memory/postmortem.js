'use strict';
/**
 * Oberon — Postmortem writer (MVP-5, deterministic).
 *
 * Writes a per-run markdown file under `.oberon/postmortems/<runId>.md`
 * summarising what happened.  This is intentionally *deterministic* (no LLM)
 * so it always runs and never affects cost.  An LLM narrative layer can be
 * added later behind the same setting; until then we ship a reliable
 * non-narrative version.
 *
 * Gated by setting `wolfbook.oberon.postmortem.narrativeEnabled` (default
 * true).  Failures must never break the research flow — callers wrap us
 * in try/catch and degrade to an `omen`.
 */

const path = require('path');
const fsp  = require('fs/promises');

const project  = require('./project');
const settings = require('../config/settings');
const roles    = require('../config/roles');
const { getAdapter } = require('../providers');

const POSTMORTEM_SYSTEM_PROMPT =
    'You are a concise science communicator writing a postmortem for an automated ' +
    'AI research run. Summarise in 2–3 paragraphs: what was attempted, what the ' +
    'worker agent found, how the verifier evaluated it, and what was committed. ' +
    'Be factual and brief; no padding. ' +
    'Use LaTeX notation ($...$) for all mathematical expressions — never raw Unicode symbols (λ, ×, ∞, etc.).';

/**
 * Write the postmortem.  Returns the absolute path on success or null
 * when no workspace folder is open.
 *
 * @param {{
 *   runId:               string,
 *   brief?:              string,
 *   quest?:              object|null,
 *   charm?:              object|null,
 *   scroll?:             object|null,
 *   reviewOut?:          object|null,
 *   wardOut?:            object|null,
 *   grimoireResult?:     object|null,
 *   summaryNotebookPath?: string|null,
 *   charmNotebookPath?:   string|null,
 *   scrollFileRef?:      { path: string }|null,
 *   runSummary?:         object|null,    // RunManager summary snapshot
 * }} opts
 * @returns {Promise<{ path: string } | null>}
 */
async function writePostmortem(opts) {
    const dir = project.postmortemsDir();
    if (!dir) return null;
    await fsp.mkdir(dir, { recursive: true });

    const runId = (opts && opts.runId) || `run-${Date.now()}`;
    const safe  = String(runId).replace(/[^A-Za-z0-9._-]/g, '_');
    const fp    = path.join(dir, `${safe}.md`);
    const md    = _renderMarkdown(opts);
    await fsp.writeFile(fp, md, 'utf8');

    // ── Optional LLM narrative ────────────────────────────────────────────
    // Gated by `wolfbook.oberon.postmortem.narrativeEnabled` (default true).
    // Failures are silently swallowed — the deterministic section is always
    // written first, so the file is never left empty.
    const pmSettings = settings.postmortem && settings.postmortem();
    if (pmSettings && pmSettings.narrativeEnabled) {
        try {
            const narrative = await _generateNarrative(opts);
            if (narrative) {
                await fsp.appendFile(fp, `\n## Narrative\n\n${narrative}\n`, 'utf8');
            }
        } catch (_) {
            // Narrative is optional — never blocks the postmortem.
        }
    }

    return { path: fp };
}

function _renderMarkdown(opts) {
    const o = opts || {};
    const ts = new Date().toISOString();
    const q  = o.quest  || {};
    const c  = o.charm  || {};
    const s  = o.scroll || {};
    const rv = o.reviewOut && o.reviewOut.oberonVerdict;
    const ws = o.wardOut && o.wardOut.summary;
    const gr = o.grimoireResult || {};
    const rs = o.runSummary || {};

    const verdict = rv && rv.verdict
        ? rv.verdict.toUpperCase().replace(/_/g, ' ')
        : 'UNKNOWN';
    const conf    = (typeof s.confidence === 'number') ? s.confidence.toFixed(3) : '?';

    const lines = [];
    lines.push(`# Run postmortem — \`${esc(o.runId)}\``);
    lines.push('');
    lines.push(`_Generated ${ts}._`);
    lines.push('');

    // Header table.
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push(`| Run ID | \`${esc(o.runId)}\` |`);
    if (o.brief)  lines.push(`| Brief | ${esc(_truncate(o.brief, 240))} |`);
    if (q.id)     lines.push(`| Quest | \`${esc(q.id)}\` — ${esc(q.title || '')} |`);
    if (c.id)     lines.push(`| Charm | \`${esc(c.id)}\` — ${esc(c.title || '')} |`);
    if (s.id)     lines.push(`| Scroll | \`${esc(s.id)}\` |`);
    lines.push(`| Verdict | **${verdict}** |`);
    lines.push(`| Confidence | ${esc(conf)} |`);
    if (typeof rs.llmCallCount === 'number')   lines.push(`| LLM calls | ${rs.llmCallCount} |`);
    if (typeof rs.toolCallCount === 'number')  lines.push(`| Tool calls | ${rs.toolCallCount} |`);
    if (typeof rs.totalCostUSD === 'number')   lines.push(`| Total cost | $${rs.totalCostUSD.toFixed(4)} |`);
    if (rs.startedAt && rs.endedAt) {
        try {
            const ms = new Date(rs.endedAt).getTime() - new Date(rs.startedAt).getTime();
            if (ms >= 0) lines.push(`| Wall clock | ${(ms / 1000).toFixed(1)} s |`);
        } catch (_) {}
    }
    if (rs.state) lines.push(`| End state | ${esc(rs.state)} |`);

    // R10: Fairy efficiency metrics (from the fairy.run_metrics event), if supplied.
    const fm = o.fairyMetrics;
    if (fm && typeof fm === 'object') {
        lines.push('');
        lines.push('## Fairy efficiency');
        lines.push('');
        lines.push('| Metric | Value |');
        lines.push('|--------|-------|');
        if (typeof fm.probesOk === 'number')          lines.push(`| Probes ok / failed | ${fm.probesOk} / ${fm.probesFailed || 0} |`);
        if (fm.probeSuccessRate != null)              lines.push(`| Probe success rate | ${(fm.probeSuccessRate * 100).toFixed(0)}% |`);
        if (typeof fm.records === 'number')           lines.push(`| Records | ${fm.records} |`);
        if (fm.recordRate != null)                    lines.push(`| Record rate | ${(fm.recordRate * 100).toFixed(0)}% |`);
        if (typeof fm.noteFacts === 'number')         lines.push(`| Facts noted | ${fm.noteFacts} |`);
        if (typeof fm.amends === 'number')            lines.push(`| Amends | ${fm.amends} |`);
        if (typeof fm.reDerivations === 'number')     lines.push(`| Re-derivations (repeat-abandon) | ${fm.reDerivations} |`);
        if (fm.inspectsPerProbe != null)              lines.push(`| Inspects per probe | ${fm.inspectsPerProbe} |`);
        if (fm.recallSkill)                           lines.push(`| Recalled skill | \`${esc(fm.recallSkill)}\`${fm.recallUsed ? ' — **used**' : ' — not used'} |`);
        else if (typeof fm.recallUsed === 'boolean')  lines.push(`| Recall used | ${fm.recallUsed ? 'yes' : 'no'} |`);
        if (typeof fm.candidateRaised === 'boolean')  lines.push(`| Contribution candidate | ${fm.candidateRaised ? 'raised (pending review)' : 'no'} |`);
    }

    // Wards summary.
    lines.push('');
    lines.push('## Wards');
    lines.push('');
    if (ws) {
        const parts = [`total ${ws.total || 0}`];
        for (const k of ['passed', 'failed', 'skipped', 'errored']) {
            if (ws[k]) parts.push(`${k} ${ws[k]}`);
        }
        lines.push(parts.join(' · '));

        // List failed/errored ward details so failures are debuggable without
        // opening the Run Inspector.
        const wardResults = (o.wardOut && o.wardOut.results) || [];
        const failedWards = wardResults.filter(w => w.status === 'failed' || w.status === 'errored');
        if (failedWards.length > 0) {
            lines.push('');
            for (const w of failedWards) {
                const expr   = w.expression ? `\`${w.expression}\`` : '(no expression)';
                const detail = w.detail ? ` — ${w.detail}` : '';
                const err    = w.error  ? ` [err: ${w.error}]` : '';
                lines.push(`- **${w.wardId}** ${expr}${detail}${err}`);
            }
        }
    } else {
        lines.push('_No wards were run for this scroll._');
    }

    // Grimoire outcome.
    lines.push('');
    lines.push('## Grimoire');
    lines.push('');
    if (gr && gr.wrote) {
        lines.push(`- Wrote **${gr.kind}** entry to \`${esc(gr.path || '?')}\`.`);
        lines.push(`- Findings written: ${gr.findingsWritten || 0}.`);
        if (gr.findingsExcluded) {
            lines.push(`- Findings excluded as unverified: ${gr.findingsExcluded}.`);
        }
        if (gr.sha256) lines.push(`- File sha256: \`${esc(gr.sha256)}\`.`);
    } else if (gr && gr.kind === 'skipped') {
        lines.push(`- Skipped (reason: \`${esc(gr.reason || 'unspecified')}\`).`);
    } else {
        lines.push('_No Grimoire entry was written for this run._');
    }

    // What was skipped.
    const skipReasons = [];
    if (ws && ws.failed)        skipReasons.push(`${ws.failed} ward failure(s)`);
    if (ws && ws.skipped)       skipReasons.push(`${ws.skipped} ward(s) skipped (no applicable method)`);
    if (rv && rv.verdict && rv.verdict !== 'success') skipReasons.push(`verdict was \`${rv.verdict}\``);
    if (skipReasons.length) {
        lines.push('');
        lines.push('## What was not promoted');
        lines.push('');
        for (const r of skipReasons) lines.push(`- ${esc(r)}`);
    }

    // Next action.
    lines.push('');
    lines.push('## Next suggested action');
    lines.push('');
    lines.push(esc(_nextAction({ rv, ws, gr })));

    // Provenance.
    lines.push('');
    lines.push('## Provenance');
    lines.push('');
    if (o.scrollFileRef && o.scrollFileRef.path) lines.push(`- Scroll: \`${esc(o.scrollFileRef.path)}\``);
    if (o.summaryNotebookPath)                   lines.push(`- Summary notebook: \`${esc(o.summaryNotebookPath)}\``);
    if (o.charmNotebookPath)                     lines.push(`- Charm notebook: \`${esc(o.charmNotebookPath)}\``);
    if (gr && gr.path)                           lines.push(`- Grimoire: \`${esc(gr.path)}\``);

    return lines.join('\n') + '\n';
}

function _nextAction({ rv, ws, gr }) {
    if (!rv || !rv.verdict) return 'Review the scroll and re-run with a more specific brief.';
    if (rv.verdict === 'failed')        return 'Re-run with a sharper brief or stronger guidance; the Skeptic rejected the cohort.';
    if (rv.verdict === 'needs_review')  return 'Open the Run Inspector, inspect the Skeptic objections, then revise the brief.';
    if (ws && ws.failed)                return 'Inspect failed Wards in the Run Inspector before promoting findings.';
    if (rv.verdict === 'partial_success') return 'Investigate the unverified findings recorded in the Grimoire under “Open Questions”.';
    if (gr && gr.wrote)                 return 'Commit the Grimoire entry once you have reviewed it.';
    return 'No further action required.';
}

/**
 * Call the postmortem LLM role to generate a 2–3 paragraph narrative.
 * Returns the narrative text or null if unavailable.
 */
async function _generateNarrative(opts) {
    const o       = opts || {};
    const binding = roles.resolveRole('postmortem');
    if (!binding.configured) return null;

    const q  = o.quest  || {};
    const s  = o.scroll || {};
    const rv = o.reviewOut && o.reviewOut.oberonVerdict;

    const findingsSummary = Array.isArray(s.findings) && s.findings.length
        ? s.findings.slice(0, 5).map((f, i) => {
            const claim = typeof f === 'string' ? f : (f.claim || '');
            return `${i + 1}. ${claim.slice(0, 200)}`;
        }).join('\n')
        : '(none recorded)';

    const userMsg = [
        q.title     ? `Quest: ${q.title}`                                    : null,
        q.objective ? `Objective: ${_truncate(q.objective, 400)}`           : null,
        `Verdict: ${(rv && rv.verdict) || 'unknown'}`,
        `Findings (up to 5):\n${findingsSummary}`,
        o.brief     ? `Original brief: ${_truncate(o.brief, 200)}`         : null,
    ].filter(Boolean).join('\n\n');

    const adapter = getAdapter(binding.provider);
    const result  = await adapter.chatComplete({
        model:       binding.model,
        temperature: 0.4,
        maxTokens:   binding.maxTokens || 512,
        messages: [
            { role: 'system', content: POSTMORTEM_SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
        ],
    }, { pricing: binding.pricing });

    const text = result && (result.content || result.text || '');
    return typeof text === 'string' && text.trim() ? text.trim() : null;
}

function esc(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|');
}
function _truncate(s, n) {
    const str = String(s || '');
    return str.length > n ? (str.slice(0, n - 1) + '…') : str;
}

module.exports = { writePostmortem, POSTMORTEM_SYSTEM_PROMPT };
