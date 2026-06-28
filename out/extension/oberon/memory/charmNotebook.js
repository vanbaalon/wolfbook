'use strict';
/**
 * Oberon — Charm Findings Notebook.
 *
 * Workflow:
 *   1. Write an EMPTY .wb skeleton to disk  ({"cells":[],"metadata":{}})
 *   2. Return the path + cell descriptors.
 *   Caller opens the notebook, inserts cells via VS Code WorkspaceEdit API,
 *   saves, and executes — no raw JSON cells are ever written directly.
 *
 * File location:
 *   <workspace>/quests/<id>_<shortName>/findings/<charmId>_findings.wb
 */

const path = require('path');
const fsp  = require('fs/promises');
const project = require('./project');

// ── helpers ────────────────────────────────────────────────────────────────

/** Escape a string for safe use inside a Wolfram "string" literal. */
function escWl(s) {
    return String(s == null ? '' : s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
}

/** Escape a string for safe use in Markdown (minimal — keep prose readable). */
function escMd(s) {
    return String(s == null ? '' : s)
        .replace(/\|/g, '\\|');
}

/** Generate a short random cell id (used only in the local skeleton — VS Code ignores this). */
function uid() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Prepare the charm findings notebook.
 *
 * Writes an EMPTY `.wb` skeleton to disk so VS Code can open it as a
 * notebook.  The CALLER inserts cells via:
 *   const edit = new vscode.WorkspaceEdit();
 *   edit.set(doc.uri, [vscode.NotebookEdit.insertCells(0, cellDataArray)]);
 *   await vscode.workspace.applyEdit(edit);
 *
 * @param {{ quest: object, charm: object, scroll: object, reviewOut: object|null }} opts
 * @returns {Promise<{ path: string, cells: Array<{kind:number, languageId:string, value:string}> } | null>}
 */
async function prepareCharmNotebook({ quest, charm, scroll, reviewOut }) {
    const root = project.getWorkspaceRoot();
    if (!root) return null;

    const dir    = path.join(root, 'quests', `${quest.id}_${quest.shortName}`, 'findings');
    const nbPath = path.join(dir, `${charm.id}_findings.wb`);

    await fsp.mkdir(dir, { recursive: true });

    // Write EMPTY skeleton — cells will be added by the caller via WorkspaceEdit.
    const skeleton = {
        cells: [],
        metadata: {
            oberon: {
                questId:     quest.id,
                charmId:     charm.id,
                scrollId:    scroll.id,
                generatedAt: new Date().toISOString(),
            },
        },
    };
    await fsp.writeFile(nbPath, JSON.stringify(skeleton, null, 2) + '\n', 'utf8');

    // Build cell descriptors (kind matches vscode.NotebookCellKind: 1=Markup, 2=Code).
    const cells = _buildCellDescriptors({ quest, charm, scroll, reviewOut });

    return { path: nbPath, cells };
}

/** @private */
function _buildCellDescriptors({ quest, charm, scroll, reviewOut }) {
    const cells = [];
    const date = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
    const conf  = typeof scroll.confidence === 'number' ? scroll.confidence.toFixed(3) : '?';

    // ── Cell 1: Title + metadata ─────────────────────────────────────────
    const titleMd = [
        `# Findings: ${charm.title || charm.id}`,
        '',
        `| Field | Value |`,
        `|-------|-------|`,
        `| Quest | \`${quest.id}\` — ${escMd(quest.title || quest.description || '')} |`,
        `| Charm | \`${charm.id}\` |`,
        `| Scroll | \`${scroll.id}\` |`,
        `| Date | ${date} |`,
        `| Confidence | **${conf}** |`,
    ];
    const ov = reviewOut && reviewOut.oberonVerdict;
    if (ov && ov.verdict) {
        titleMd.push(`| Oberon Verdict | **${String(ov.verdict).toUpperCase().replace(/_/g, ' ')}** |`);
    }
    cells.push({ kind: 1, languageId: 'markdown', value: titleMd.join('\n') });

    // ── Cell 1b: Charm mission statement ────────────────────────────────
    // Shown at the top so both users and the Critic know the objective.
    const taskText = String(charm.task || charm.brief || charm.description || '').trim();
    if (taskText) {
        const missionLines = ['## Mission\n'];
        missionLines.push(taskText.slice(0, 2000));
        const checks = Array.isArray(charm.validationChecks) ? charm.validationChecks : [];
        if (checks.length > 0) {
            missionLines.push('\n**Validation checks:**');
            checks.forEach((c, i) => missionLines.push(`${i + 1}. \`${String(c).slice(0, 200)}\``));
        }
        cells.push({ kind: 1, languageId: 'markdown', value: missionLines.join('\n') });
    }
    const findings = Array.isArray(scroll.findings) ? scroll.findings : [];
    const openQs   = Array.isArray(scroll.openQuestions) ? scroll.openQuestions : [];

    const findingsList = findings
        .map(f => {
            const claim = typeof f === 'string' ? f : (f.claim || '');
            const fc    = typeof f === 'object' && typeof f.confidence === 'number'
                ? f.confidence.toFixed(3) : conf;
            return `    <|"claim" -> "${escWl(claim)}", "confidence" -> ${fc}|>`;
        })
        .join(',\n');

    const openQsList = openQs
        .map(q => `    "${escWl(String(q))}"`)
        .join(',\n');

    const dataCell = [
        `(* Charm findings — structured for programmatic access *)`,
        `charmFindings = <|`,
        `  "questId"    -> "${escWl(quest.id)}",`,
        `  "charmId"    -> "${escWl(charm.id)}",`,
        `  "scrollId"   -> "${escWl(scroll.id)}",`,
        `  "confidence" -> ${conf},`,
        `  "findings"   -> {`,
        findingsList || '    (* none *)',
        `  },`,
        `  "openQuestions" -> {`,
        openQsList || '    (* none *)',
        `  }`,
        `|>`,
    ].join('\n');
    cells.push({ kind: 2, languageId: 'wolfram', value: dataCell });

    // ── Cell 3: Summary ──────────────────────────────────────────────────
    if (scroll.summary) {
        cells.push({ kind: 1, languageId: 'markdown',
            value: `## Summary\n\n${scroll.summary}` });
    }

    // ── Cell 4: Findings list ────────────────────────────────────────────
    if (findings.length > 0) {
        const lines = [`## Key Findings\n`];
        findings.forEach((f, i) => {
            const claim = typeof f === 'string' ? f : (f.claim || '');
            const fc    = typeof f === 'object' && typeof f.confidence === 'number'
                ? ` *(conf: ${f.confidence.toFixed(2)})*` : '';
            lines.push(`${i + 1}. ${escMd(claim)}${fc}`);
        });
        cells.push({ kind: 1, languageId: 'markdown', value: lines.join('\n') });
    }

    // ── Cells 5+: Evidence expressions ──────────────────────────────────
    const evidence = Array.isArray(scroll.evidence) ? scroll.evidence : [];
    const validEv  = evidence.filter(e => e && typeof e.expression === 'string' && e.expression.trim().length > 0);
    if (validEv.length > 0) {
        cells.push({ kind: 1, languageId: 'markdown',
            value: `## Evidence\n\nEach block re-evaluates against the current kernel when run.` });
        for (const ev of validEv.slice(0, 10)) {  // cap at 10 evidence items
            const label = escWl(ev.label || ev.expression.slice(0, 60));
            cells.push({ kind: 2, languageId: 'wolfram', value: [
                `(* Evidence: ${label.replace(/\*\)/g, '* )')} *)`,
                `Quiet[Check[`,
                `  ${ev.expression.trim()}`,
                `, $Failed, {General::stop, General::shdw}]]`,
            ].join('\n') });
        }
    }

    // ── Cell N: Open Questions ───────────────────────────────────────────
    if (openQs.length > 0) {
        const lines = [`## Open Questions\n`];
        openQs.forEach((q, i) => lines.push(`${i + 1}. ${String(q)}`));
        cells.push({ kind: 1, languageId: 'markdown', value: lines.join('\n') });
    }

    // ── Cell N+1: Skeptic + Oberon verdict summary ───────────────────────
    if (reviewOut) {
        const verdictLines = [`## Review Verdict\n`];
        const sk = reviewOut.skeptic;
        if (sk && sk.verdict) {
            verdictLines.push(`**Skeptic:** ${sk.verdict}`);
            const sum = sk.summary || {};
            verdictLines.push(`- Matched ${sum.matched || 0}/${sum.total || 0} checks`);
            if (sum.failed)  verdictLines.push(`- Failed: ${sum.failed}`);
            if (sum.skipped) verdictLines.push(`- Skipped: ${sum.skipped}`);
            if (Array.isArray(sk.objections) && sk.objections.length > 0) {
                verdictLines.push(`\n**Objections:**`);
                sk.objections.slice(0, 5).forEach(o => verdictLines.push(`- ${escMd(String(o).slice(0, 300))}`));
            }
            verdictLines.push('');
        }
        if (ov && ov.verdict) {
            verdictLines.push(`**Oberon Verdict:** ${ov.verdict.toUpperCase().replace(/_/g, ' ')}`);
            if (ov.narrative)       verdictLines.push(`\n${ov.narrative}`);
            if (ov.mainEvidence)    verdictLines.push(`\n**Main evidence:** ${escMd(String(ov.mainEvidence).slice(0, 400))}`);
            if (ov.recommendedAction) verdictLines.push(`\n**Next:** ${escMd(String(ov.recommendedAction).slice(0, 300))}`);
        }
        if (verdictLines.length > 1) {
            cells.push({ kind: 1, languageId: 'markdown', value: verdictLines.join('\n') });
        }
    }

    return cells;
}

/**
 * Compute the charm findings notebook path without any side-effects.
 * Useful for checking if the file already exists before deciding whether
 * to write a fresh skeleton or append to existing content.
 *
 * @param {{ quest: object, charm: object }} opts
 * @returns {string | null}
 */
function getCharmNotebookPath({ quest, charm }) {
    const root = project.getWorkspaceRoot();
    if (!root) return null;
    const dir = path.join(root, 'quests', `${quest.id}_${quest.shortName}`, 'findings');
    return path.join(dir, `${charm.id}_findings.wb`);
}

/**
 * Build ONLY the "findings + verdict" trailer cells for append mode.
 *
 * Called by `populateResearchNotebooks` when the charm notebook was already
 * populated live by the Fairy (via `notebookWriter`) and the post-run step
 * needs to append only the Skeptic review and Oberon verdict — NOT the full
 * cell set (which would duplicate evidence cells the Fairy already wrote).
 *
 * @param {{ quest: object, charm: object, scroll: object, reviewOut: object|null }} opts
 * @returns {Array<{kind:number, languageId:string, value:string}>}
 */
function buildCharmTrailerCells({ quest, charm, scroll, reviewOut }) {
    const cells    = [];
    const findings = Array.isArray(scroll.findings) ? scroll.findings : [];
    const openQs   = Array.isArray(scroll.openQuestions) ? scroll.openQuestions : [];
    const conf     = typeof scroll.confidence === 'number' ? scroll.confidence.toFixed(3) : '?';

    // Section separator
    cells.push({ kind: 1, languageId: 'markdown',
        value: `\n---\n## Findings & Verdict (post-run)\n\n` +
               `_Scroll \`${scroll.id}\` — confidence ${conf}_` });

    // Summary
    if (scroll.summary) {
        cells.push({ kind: 1, languageId: 'markdown',
            value: `## Summary\n\n${scroll.summary}` });
    }

    // Key Findings
    if (findings.length > 0) {
        const lines = ['## Key Findings\n'];
        findings.forEach((f, i) => {
            const claim = typeof f === 'string' ? f : (f.claim || '');
            const fc    = typeof f === 'object' && typeof f.confidence === 'number'
                ? ` *(conf: ${f.confidence.toFixed(2)})*` : '';
            lines.push(`${i + 1}. ${escMd(claim)}${fc}`);
        });
        cells.push({ kind: 1, languageId: 'markdown', value: lines.join('\n') });
    }

    // Open Questions
    if (openQs.length > 0) {
        const lines = ['## Open Questions\n'];
        openQs.forEach((q, i) => lines.push(`${i + 1}. ${String(q)}`));
        cells.push({ kind: 1, languageId: 'markdown', value: lines.join('\n') });
    }

    // Review verdict
    const ov = reviewOut && reviewOut.oberonVerdict;
    if (reviewOut) {
        const verdictLines = ['## Review Verdict\n'];
        const sk = reviewOut.skeptic;
        if (sk && sk.verdict) {
            verdictLines.push(`**Skeptic:** ${sk.verdict}`);
            const sum = sk.summary || {};
            verdictLines.push(`- Matched ${sum.matched || 0}/${sum.total || 0} checks`);
            if (sum.failed)  verdictLines.push(`- Failed: ${sum.failed}`);
            if (sum.skipped) verdictLines.push(`- Skipped: ${sum.skipped}`);
            if (Array.isArray(sk.objections) && sk.objections.length > 0) {
                verdictLines.push(`\n**Objections:**`);
                sk.objections.slice(0, 5).forEach(o =>
                    verdictLines.push(`- ${escMd(String(o).slice(0, 300))}`));
            }
            verdictLines.push('');
        }
        if (ov && ov.verdict) {
            verdictLines.push(`**Oberon Verdict:** ${ov.verdict.toUpperCase().replace(/_/g, ' ')}`);
            if (ov.narrative)         verdictLines.push(`\n${ov.narrative}`);
            if (ov.mainEvidence)      verdictLines.push(`\n**Main evidence:** ${escMd(String(ov.mainEvidence).slice(0, 400))}`);
            if (ov.recommendedAction) verdictLines.push(`\n**Next:** ${escMd(String(ov.recommendedAction).slice(0, 300))}`);
        }
        if (verdictLines.length > 1) {
            cells.push({ kind: 1, languageId: 'markdown', value: verdictLines.join('\n') });
        }
    }

    return cells;
}

module.exports = { prepareCharmNotebook, buildCharmTrailerCells, getCharmNotebookPath };
