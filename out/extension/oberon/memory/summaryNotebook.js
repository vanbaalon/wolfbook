'use strict';
/**
 * Oberon — Quest Summary Notebook.
 *
 * Creates a human-readable `.wb` summary for the completed Quest:
 *   - Oberon verdict + confidence
 *   - Quest objective
 *   - Key findings (from the final Scroll)
 *   - Clickable links to the charm findings notebooks
 *   - Open questions
 *
 * File location:
 *   <workspace>/quests/<id>_<shortName>/<id>_summary.wb
 *
 * The charm notebook is referenced via a relative markdown link so the user
 * can click through to the detailed verifications without searching.
 */

const path = require('path');
const fsp  = require('fs/promises');
const project = require('./project');

// ── helpers ────────────────────────────────────────────────────────────────

function escMd(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|');
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Prepare the quest summary notebook.
 *
 * Writes an EMPTY `.wb` skeleton to disk.  Caller inserts cells via
 * `vscode.workspace.applyEdit(NotebookEdit.insertCells(…))`.
 *
 * @param {{
 *   quest:             object,
 *   charm:             object,
 *   scroll:            object,
 *   reviewOut:         object|null,
 *   charmNotebookPath: string|null,
 * }} opts
 * @returns {Promise<{ path: string, cells: Array<{kind:number, languageId:string, value:string}> } | null>}
 */
async function prepareSummaryNotebook({ quest, charm, scroll, reviewOut, charmNotebookPath }) {
    const root = project.getWorkspaceRoot();
    if (!root) return null;

    const dir    = path.join(root, 'quests', `${quest.id}_${quest.shortName}`);
    const nbPath = path.join(dir, `${quest.id}_summary.wb`);

    await fsp.mkdir(dir, { recursive: true });

    const skeleton = {
        cells: [],
        metadata: {
            oberon: {
                questId:     quest.id,
                kind:        'summary',
                generatedAt: new Date().toISOString(),
            },
        },
    };
    await fsp.writeFile(nbPath, JSON.stringify(skeleton, null, 2) + '\n', 'utf8');

    const cells = _buildCells({ quest, charm, scroll, reviewOut, charmNotebookPath, dir });
    return { path: nbPath, cells };
}

/** @private */
function _buildCells({ quest, charm, scroll, reviewOut, charmNotebookPath, dir }) {
    const cells = [];
    const date  = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
    const conf  = typeof scroll.confidence === 'number' ? scroll.confidence.toFixed(3) : '?';
    const ov    = reviewOut && reviewOut.oberonVerdict;

    // ── Cell 1: Title + metadata table ───────────────────────────────────
    const verdictLabel = ov && ov.verdict
        ? `**${String(ov.verdict).toUpperCase().replace(/_/g, ' ')}**`
        : '—';

    const titleLines = [
        `# Research Summary: ${escMd(quest.title || quest.id)}`,
        '',
        `| Field | Value |`,
        `|-------|-------|`,
        `| Quest | \`${quest.id}\` |`,
        `| Date | ${date} |`,
        `| Confidence | **${conf}** |`,
        `| Verdict | ${verdictLabel} |`,
    ];
    if (charm && charm.id) {
        titleLines.push(`| Charm | \`${charm.id}\` — ${escMd(charm.title || '')} |`);
    }
    cells.push({ kind: 1, languageId: 'markdown', value: titleLines.join('\n') });

    // ── Cell 2: Objective ────────────────────────────────────────────────
    if (quest.objective) {
        cells.push({ kind: 1, languageId: 'markdown',
            value: `## Objective\n\n${quest.objective}` });
    }

    // ── Cell 3: Summary ──────────────────────────────────────────────────
    if (scroll.summary) {
        cells.push({ kind: 1, languageId: 'markdown',
            value: `## Summary\n\n${scroll.summary}` });
    }

    // ── Cell 4: Oberon narrative (if LLM narration was enabled) ─────────
    if (ov && ov.narrative) {
        cells.push({ kind: 1, languageId: 'markdown',
            value: `## Oberon Assessment\n\n${ov.narrative}` });
    }

    // ── Cell 5: Key findings list ────────────────────────────────────────
    const findings = Array.isArray(scroll.findings) ? scroll.findings : [];
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

    // ── Cell 6: Detailed verifications link ──────────────────────────────
    if (charmNotebookPath) {
        const relPath = path.relative(dir, charmNotebookPath).replace(/\\/g, '/');
        const charmLabel = charm && charm.id
            ? `${charm.id}${charm.title ? ': ' + escMd(charm.title) : ''}`
            : path.basename(charmNotebookPath);
        const lines = [
            '## Detailed Verifications',
            '',
            'The following notebook contains the full evidence, re-evaluatable Wolfram code, self-checks, and the Skeptic/Oberon review.',
            'Open it and **Run All Cells** to independently verify the findings.',
            '',
            `→ [${charmLabel}](./${relPath})`,
        ];
        cells.push({ kind: 1, languageId: 'markdown', value: lines.join('\n') });
    }

    // ── Cell 7: Open questions ───────────────────────────────────────────
    const openQs = Array.isArray(scroll.openQuestions) ? scroll.openQuestions : [];
    if (openQs.length > 0) {
        const lines = ['## Open Questions\n'];
        openQs.forEach((q, i) => lines.push(`${i + 1}. ${String(q)}`));
        cells.push({ kind: 1, languageId: 'markdown', value: lines.join('\n') });
    }

    return cells;
}

module.exports = { prepareSummaryNotebook };
