'use strict';
/**
 * Oberon — Cell-level Critic.
 *
 * New architecture: instead of re-running items from the Scroll's evidence
 * array, the Critic walks the charm's findings notebook cell by cell,
 * re-evaluates each code cell in sequence (maintaining kernel state), uses
 * a fast LLM call to analyse each (markdown, code) pair, and inserts a
 * short markdown annotation cell directly into the notebook after each
 * code cell.  A conclusion cell is appended at the end.
 *
 * Return value is intentionally compatible with the old `runSkeptic` so
 * `reviewLoop.js` and `buildOberonVerdict` require no changes.
 *
 * Annotation cells are tagged with `{ oberon_critic: true }` in their
 * metadata so they can be identified and cleared on subsequent runs.
 *
 * Fallback
 * --------
 * If the VS Code API is unavailable, the charm notebook path is missing,
 * or the notebook cannot be opened, the function returns a `needs_review`
 * result so the pipeline continues gracefully.
 */

const { getAdapter }     = require('../providers');
const { computeCost }    = require('../providers/cost');
const roles              = require('../config/roles');
const wolframShim        = require('./wolframShim');
const { makeSpanId }     = require('../telemetry/bus');
const { CELL_CRITIC_SYSTEM_PROMPT } = require('../agents/cellCritic.prompt');

const CELL_RERUN_TIMEOUT_S       = 30;
const NOTEBOOK_ANALYSIS_MAX_TOKENS = 1500;  // whole-notebook response
const MAX_CODE_CHARS_PER_CELL    = 600;
const MAX_OUTPUT_CHARS_PER_CELL  = 300;
const MAX_MD_CHARS               = 300;
const MAX_CELLS_ANALYSED         = 25;  // cap re-run count for huge notebooks
const ANALYSIS_RETRIES           = 2;   // retry attempts for the single LLM call
const RETRY_DELAY_MS             = 1500;
const CRITIC_META_KEY            = 'oberon_critic';

// ── helpers ───────────────────────────────────────────────────────────────

function _getVscode() {
    try { return require('vscode'); } catch (_) { return null; }
}

function _isCriticCell(cell) {
    return !!(cell && cell.metadata && cell.metadata[CRITIC_META_KEY]);
}

/** Extract plain-text output from a VS Code NotebookCell's outputs array. */
function _cellOutputText(cell) {
    if (!cell || !Array.isArray(cell.outputs)) return '';
    const decoder = new TextDecoder();
    const parts = [];
    for (const out of cell.outputs) {
        if (!Array.isArray(out.items)) continue;
        // Prefer text/plain; fall back to first item
        const item = out.items.find(i => i.mime === 'text/plain') || out.items[0];
        if (item && item.data) {
            try { parts.push(decoder.decode(item.data)); } catch (_) {}
        }
    }
    return parts.join('\n').trim();
}

/**
 * Find the last Markup cell immediately preceding `cellIndex`
 * in the snapshot, ignoring any critic annotation cells.
 * @param {object[]} snapshot  plain cell objects { kind, source, metadata }
 * @param {number}   cellIndex
 * @returns {string}
 */
function _precedingMarkdown(snapshot, cellIndex) {
    for (let j = cellIndex - 1; j >= 0; j--) {
        if (snapshot[j].meta[CRITIC_META_KEY]) continue;
        if (snapshot[j].kind !== 1) break;
        return snapshot[j].source;
    }
    return '';
}

/** Build the annotation markdown text for one cell's analysis result. */
function _annotationMarkdown(analysis, rerunOk, rerunError) {
    if (!rerunOk) {
        const errStr = String(rerunError || 'unknown error').slice(0, 200);
        return `> ⚡ **Critic:** Re-evaluation failed — _${errStr}_. Output not verified.`;
    }

    const { status, summary, issues } = analysis;
    const icon   = status === 'ok' ? '✓' : status === 'warning' ? '⚠' : '✗';
    const label  = status === 'ok' ? 'OK' : status === 'warning' ? 'Warning' : '**Issue found**';
    const lines  = [`> ${icon} **Critic — ${label}:** ${summary || ''}`];
    if (Array.isArray(issues) && issues.length > 0) {
        for (const issue of issues) {
            lines.push(`> - ${issue}`);
        }
    }
    return lines.join('\n');
}

/** Insert a single Markup annotation cell into the live notebook. */
async function _insertAnnotation(doc, vscode, atIndex, markdown) {
    try {
        const cellData = new vscode.NotebookCellData(
            vscode.NotebookCellKind.Markup, markdown, 'markdown');
        cellData.metadata = { [CRITIC_META_KEY]: true };
        const edit = new vscode.WorkspaceEdit();
        edit.set(doc.uri, [vscode.NotebookEdit.insertCells(atIndex, [cellData])]);
        await vscode.workspace.applyEdit(edit);
    } catch (_) {}
}

/** Remove all existing critic annotation cells from the live notebook. */
async function _clearCriticCells(doc, vscode) {
    const toDelete = [];
    for (let i = 0; i < doc.cellCount; i++) {
        if (_isCriticCell(doc.cellAt(i))) toDelete.push(i);
    }
    if (toDelete.length === 0) return;
    // Delete in reverse order so earlier indices stay valid
    const edits = toDelete.slice().reverse()
        .map(i => vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(i, i + 1)));
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, edits);
    await vscode.workspace.applyEdit(edit);
}

/**
 * Single LLM call that reviews the ENTIRE notebook at once.
 * Returns an array of { snapIdx, status, comment } for cells the LLM flags.
 * Returns null if the call fails after all retries (caller should silently skip annotations).
 */
async function _analyseNotebook({ quest, charm, snapshot, rerunResults, signal, bus, spanId }) {
    const role = roles.resolveRole('fairy');
    if (!role.configured) return null;

    // Build full notebook representation for the LLM
    const notebookCells = snapshot.map((cell, i) => {
        if (cell.kind === 1) {  // markdown
            return { cell_number: i + 1, type: 'markdown', content: cell.source.slice(0, MAX_MD_CHARS) };
        }
        const rr = rerunResults.find(r => r.snapIdx === i);
        const entry = { cell_number: i + 1, type: 'code', code: cell.source.slice(0, MAX_CODE_CHARS_PER_CELL) };
        if (rr) {
            entry.rerun_ok = rr.rerunOk;
            if (rr.rerunOk)  entry.output = String(rr.rerunOutput || '').slice(0, MAX_OUTPUT_CHARS_PER_CELL);
            else             entry.error  = String(rr.rerunError  || 'evaluation failed').slice(0, 200);
        }
        return entry;
    });

    // Charm task is the SUBSET of the full quest this charm is responsible for.
    // The Critic MUST evaluate the notebook against the charm's task — NOT
    // against the full quest objective — so it does not penalise this charm
    // for skipping computations that belong to other charms.
    const charmTask    = String(charm.task || charm.brief || charm.description || '').trim();
    const questContext = String((quest && (quest.objective || quest.title)) || '').trim();
    const otherCharmTasks = Array.isArray(quest && quest.subtasks)
        ? quest.subtasks.filter(t => String(t || '').trim() !== charmTask).slice(0, 8)
        : [];

    const payload = {
        charm: {
            id:                charm.id,
            title:             charm.title || '',
            // The ONLY thing this notebook is expected to accomplish.
            objective:         charmTask.slice(0, 1200),
            // Validation checks the Planner already scoped to this charm
            // (the dispatcher filters quest-wide checks per subtask).
            validation_checks: Array.isArray(charm.validationChecks) ? charm.validationChecks : [],
        },
        scope: {
            note: 'This notebook belongs to ONE charm — a single subtask of the larger quest. ' +
                  'Judge ONLY whether the cells fulfil the charm.objective and the listed ' +
                  'validation_checks. Do NOT flag cells for not producing outputs that belong ' +
                  'to other charms; those are handled separately and are listed under ' +
                  'other_charms_for_context only so you know what is OUT OF SCOPE here.',
            full_quest:        questContext.slice(0, 800),
            other_charms_for_context: otherCharmTasks.map(t => String(t).slice(0, 300)),
        },
        notebook: notebookCells,
    };

    const messages = [
        { role: 'system', content: CELL_CRITIC_SYSTEM_PROMPT },
        { role: 'user',   content: JSON.stringify(payload) },
    ];

    const adapter = getAdapter(role.provider);
    for (let attempt = 0; attempt <= ANALYSIS_RETRIES; attempt++) {
        try {
            const t0       = Date.now();
            const response = await adapter.chatComplete({
                model:      role.model,
                messages,
                maxTokens:  NOTEBOOK_ANALYSIS_MAX_TOKENS,
                stream:     false,
                signal,
            });
            const latencyMs = Date.now() - t0;

            // Emit llm.call so the Run Inspector shows the critic's LLM turn
            try {
                const costUSD = (typeof response.costUSD === 'number')
                    ? response.costUSD
                    : computeCost(response.usage, role.pricing);
                await bus.appendEvent('llm.call', {
                    role:     'critic',
                    provider: response.provider || role.provider,
                    model:    response.model    || role.model,
                    usage:    response.usage,
                    costUSD,
                    latencyMs:  response.latencyMs || latencyMs,
                    stopReason: response.stopReason,
                    turnIndex:  attempt,
                    toolCallsRequested: 0,
                    promptMessages: messages,
                    responseText:   response.content,
                }, { spanId, questId: quest.id, charmId: charm.id });
            } catch (_) {}

            const rawText  = String(response && response.content || '').trim();
            let jsonText   = rawText.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
            const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
            if (jsonMatch) jsonText = jsonMatch[0];
            const parsed   = JSON.parse(jsonText);
            const reviews  = Array.isArray(parsed.reviews) ? parsed.reviews : [];
            // Map 1-based cell_number back to 0-based snapshot index
            return reviews
                .filter(r => r && typeof r.cell_number === 'number' &&
                             (r.status === 'warning' || r.status === 'issue'))
                .map(r => ({
                    snapIdx: r.cell_number - 1,
                    status:  r.status,
                    comment: String(r.comment || '').slice(0, 200),
                }));
        } catch (_) {
            if (attempt === ANALYSIS_RETRIES) return null;  // silently skip
            await new Promise(res => setTimeout(res, RETRY_DELAY_MS * (attempt + 1)));
        }
    }
    return null;
}

// ── validation checks (ported from old Skeptic) ───────────────────────────

async function _runValidationChecks({ charm, bus, signal, spanId }) {
    const validations = Array.isArray(charm.validationChecks)
        ? charm.validationChecks.filter(s => typeof s === 'string' && s.trim())
        : [];

    const wardResults = [];
    for (const expr of validations) {
        if (signal && signal.aborted) break;
        let vResult;
        try {
            vResult = await wolframShim.evalOnce({ expression: expr, timeoutSeconds: 20, signal });
        } catch (e) {
            vResult = { ok: false, error: String(e && e.message || e) };
        }
        const valStr    = String(vResult.value || '').trim();
        const isTrue    = valStr === 'True';
        const numVal    = parseFloat(valStr);
        const isNearZero = !isNaN(numVal) && Math.abs(numVal) < 1e-8;
        const passed    = vResult.ok && (isTrue || isNearZero);
        wardResults.push({
            wardId:     `V${wardResults.length + 1}`,
            status:     passed ? 'passed' : (vResult.ok ? 'failed' : 'errored'),
            method:     'validation',
            passed,
            detail:     passed
                ? `Validation passed: ${expr.slice(0, 120)} → ${valStr.slice(0, 80)}`
                : `Validation FAILED: ${expr.slice(0, 120)} → ${(vResult.error || valStr).slice(0, 200)}`,
            expression: expr,
            durationMs: vResult.durationMs || 0,
            error:      vResult.error || null,
        });
        try {
            await bus.appendEvent('ward.result', {
                questId: charm.questId, charmId: charm.id,
                wardId: wardResults[wardResults.length-1].wardId,
                wardType: 'validation',
                status:   wardResults[wardResults.length-1].status,
                method:   'validation',
                passed,
                detail:   wardResults[wardResults.length-1].detail,
                expression: expr,
                durationMs: vResult.durationMs || 0,
                error: vResult.error || null,
            }, { questId: charm.questId, charmId: charm.id });
        } catch (_) {}
    }
    return wardResults;
}

// ── conclusion cell ────────────────────────────────────────────────────────

async function _appendConclusion(doc, vscode, { verdict, verificationLevel, analysisResults, wardResults }) {
    const issues   = analysisResults.filter(r => r.analysis.status === 'issue' || !r.rerunOk);
    const warnings = analysisResults.filter(r => r.analysis.status === 'warning');
    const ok       = analysisResults.filter(r => r.analysis.status === 'ok'   &&  r.rerunOk);
    const failedWards = wardResults.filter(w => w.status === 'failed' || w.status === 'errored');

    const totalIssueCount = issues.length + failedWards.length;
    const verdictLine = verdict === 'accept'
        ? '**Verdict: ACCEPTED** ✓'
        : `**Verdict: NEEDS REVISION** ✗  _(${totalIssueCount} problem${totalIssueCount !== 1 ? 's' : ''}: ${issues.length} cell${issues.length !== 1 ? 's' : ''}, ${failedWards.length} validation${failedWards.length !== 1 ? 's' : ''})_`;

    const rows = [
        `| Cells | OK | Warnings | Issues | Rerun errors |`,
        `|------:|---:|---------:|-------:|:-------------|`,
        `| ${analysisResults.length} | ${ok.length} | ${warnings.length} | ${issues.filter(r => r.analysis.status === 'issue').length} | ${analysisResults.filter(r => !r.rerunOk).length} |`,
    ];

    const issueBullets = issues.map((r, idx) => {
        const num = r.originalIndex + 1;
        if (!r.rerunOk) return `${idx + 1}. **Cell ${num}:** Re-evaluation failed — ${String(r.rerunError || 'unknown').slice(0, 120)}`;
        const issueList = (r.analysis.issues || []).join('; ').slice(0, 300);
        return `${idx + 1}. **Cell ${num}:** ${issueList || r.analysis.summary}`;
    });
    const wardBullets = failedWards.map((w, idx) =>
        `${idx + 1}. **Validation:** ${String(w.detail || '').slice(0, 200)}`);

    const lines = [
        '',
        '---',
        `## Critic Review — ${doc && doc.uri ? require('path').basename(String(doc.uri)) : 'charm'}`,
        '',
        verdictLine,
        '',
        rows.join('\n'),
        '',
    ];
    if (issueBullets.length > 0) {
        lines.push('### Issues requiring revision:');
        lines.push(...issueBullets);
        lines.push('');
    }
    if (wardBullets.length > 0) {
        lines.push('### Validation check failures:');
        lines.push(...wardBullets);
        lines.push('');
    }

    const markdown = lines.join('\n');
    try {
        const cellData = new vscode.NotebookCellData(
            vscode.NotebookCellKind.Markup, markdown, 'markdown');
        cellData.metadata = { [CRITIC_META_KEY]: true };
        const edit = new vscode.WorkspaceEdit();
        edit.set(doc.uri, [vscode.NotebookEdit.insertCells(doc.cellCount, [cellData])]);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
    } catch (_) {}
}

// ── fallback result ───────────────────────────────────────────────────────

function _fallbackResult(spanId, message) {
    return {
        verdict:            'needs_review',
        verificationLevel:  'none',
        objections:         [message || 'Cell critic could not run.'],
        checks:             [],
        wardResults:        [],
        wardSummary:        { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
        summary:            { total: 0, matched: 0, failed: 0, skipped: 0 },
        verificationCounts: {},
        spanId,
        criticNotebookPath: null,
        charmNotebookPath:  null,
    };
}

// ── main export ───────────────────────────────────────────────────────────

/**
 * Run the cell-by-cell Critic on the charm's findings notebook.
 *
 * Signature is compatible with `runSkeptic` so `reviewLoop.js` can call
 * either function without changes.
 *
 * @param {{
 *   quest:             object,
 *   charm:             object,
 *   scroll:            object,
 *   bus:               object,
 *   signal?:           AbortSignal,
 *   charmNotebookPath: string|null,
 *   priorChecks?:      any,   // accepted but ignored (notebook state may have changed)
 * }} args
 */
async function runCellCritic({ quest, charm, scroll, bus, signal, charmNotebookPath }) {
    const spanId  = makeSpanId();
    const vscode  = _getVscode();

    if (!vscode) return _fallbackResult(spanId, 'VS Code API unavailable.');
    if (!charmNotebookPath) return _fallbackResult(spanId, 'No charm notebook path — cannot run cell critic.');

    // ── 1. Open the notebook ──────────────────────────────────────────────
    let doc;
    try {
        doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(charmNotebookPath));
    } catch (e) {
        return _fallbackResult(spanId, `Could not open charm notebook: ${e && e.message || String(e)}`);
    }

    // ── 2. Clear old critic annotations ──────────────────────────────────
    try { await _clearCriticCells(doc, vscode); } catch (_) {}

    // ── 3. Snapshot cells (before any insertions change indices) ─────────
    const snapshot = [];
    for (let i = 0; i < doc.cellCount; i++) {
        const cell = doc.cellAt(i);
        snapshot.push({
            kind:   cell.kind,
            source: cell.document.getText(),
            meta:   cell.metadata || {},
            storedOutput: _cellOutputText(cell),
        });
    }

    // ── 4. Restart kernel for a clean replay ─────────────────────────────
    try {
        await bus.appendEvent('critic.kernel_restart', {
            questId: quest.id, charmId: charm.id,
            reason: 'cell-critic clean replay',
        }, { questId: quest.id, charmId: charm.id });
        await wolframShim.restartKernel();
    } catch (_) {}

    // ── 5. Identify code cells to analyse ────────────────────────────────
    const codeCellIndices = [];
    for (let i = 0; i < snapshot.length; i++) {
        if (snapshot[i].kind === 2 && !snapshot[i].meta[CRITIC_META_KEY]) {
            codeCellIndices.push(i);
        }
    }
    const totalCodeCells = codeCellIndices.length;

    // ── 6A. Walk cells: re-run sequentially (maintains kernel state) ─────
    const rerunResults = [];
    const clearGlobalsSnapIdxs = new Set();  // code cells with ClearGlobals[] after first
    // Per-charm batching: emit ONE summary event at the end instead of one per cell.
    const _rerunSummary = { reran: 0, ok: 0, failed: 0, cellIndices: [] };

    for (let ci = 0; ci < codeCellIndices.length; ci++) {
        if (signal && signal.aborted) break;
        if (ci >= MAX_CELLS_ANALYSED) break;

        const snapIdx = codeCellIndices[ci];
        const code    = snapshot[snapIdx].source;

        // Detect ClearGlobals[] mid-computation (before rerun, so we flag it regardless)
        if (/ClearGlobals\s*\[/.test(code) && ci > 0) {
            clearGlobalsSnapIdxs.add(snapIdx);
        }

        let rerunResult;
        try {
            rerunResult = await wolframShim.evalOnce({
                expression: code, timeoutSeconds: CELL_RERUN_TIMEOUT_S, signal,
            });
        } catch (e) {
            rerunResult = { ok: false, kind: 'exception', value: '', error: String(e && e.message || e), durationMs: 0 };
        }

        _rerunSummary.reran += 1;
        _rerunSummary.cellIndices.push(snapIdx);
        if (rerunResult.ok) _rerunSummary.ok += 1; else _rerunSummary.failed += 1;

        rerunResults.push({
            snapIdx,
            code,
            rerunOk:    !!rerunResult.ok,
            rerunOutput: String(rerunResult.value || ''),
            rerunError:  rerunResult.error || null,
        });
    }

    // Single summary event for the whole replay — keeps Run Inspector clean.
    try {
        await bus.appendEvent('critic.replay_summary', {
            questId: quest.id, charmId: charm.id,
            cellsReran:  _rerunSummary.reran,
            cellsOk:     _rerunSummary.ok,
            cellsFailed: _rerunSummary.failed,
            cellIndices: _rerunSummary.cellIndices,
        }, { questId: quest.id, charmId: charm.id });
    } catch (_) {}

    // ── 6B. Single LLM call: analyse the whole notebook at once ──────────
    // Silently returns null on failure — we skip annotations rather than
    // polluting the notebook with error cells.
    const llmReviews = await _analyseNotebook({ quest, charm, snapshot, rerunResults, signal, bus, spanId });
    // Map snapIdx → review for quick lookup
    const reviewBySnapIdx = new Map((llmReviews || []).map(r => [r.snapIdx, r]));

    // ── 6C. Build analysisResults for ALL re-run code cells ──────────────
    const analysisResults = rerunResults.map(r => {
        const { snapIdx, code, rerunOk, rerunOutput, rerunError } = r;
        let analysis;
        if (clearGlobalsSnapIdxs.has(snapIdx)) {
            analysis = {
                status:  'issue',
                summary: 'ClearGlobals[] called mid-computation — wipes all prior kernel definitions.',
                issues:  ['ClearGlobals[] outside the first code cell erases all definitions; subsequent cells will fail with undefined symbols.'],
            };
        } else if (!rerunOk) {
            analysis = {
                status:  'issue',
                summary: `Re-evaluation failed: ${String(rerunError || 'unknown').slice(0, 120)}`,
                issues:  [String(rerunError || 'unknown error').slice(0, 200)],
            };
        } else {
            const rev = reviewBySnapIdx.get(snapIdx);
            analysis = rev
                ? { status: rev.status, summary: rev.comment, issues: [rev.comment] }
                : { status: 'ok', summary: 'OK', issues: [] };
        }
        return { originalIndex: snapIdx, code, rerunOk, rerunOutput, rerunError, analysis };
    });

    // ── 6D. Insert annotations — ONLY for cells with issues or warnings ───
    // Skip 'ok' cells entirely to keep the notebook clean.
    const toAnnotate = analysisResults
        .filter(r => r.analysis.status !== 'ok')
        .sort((a, b) => a.originalIndex - b.originalIndex);
    let insertOffset = 0;
    for (const r of toAnnotate) {
        const liveInsertAt = r.originalIndex + 1 + insertOffset;
        const annotationMd = r.rerunOk
            ? `> ${r.analysis.status === 'issue' ? '✗' : '⚠'} **Critic — ${r.analysis.status === 'issue' ? '**Issue**' : 'Warning'}:** ${r.analysis.summary || ''}`
            : `> ⚡ **Critic:** Re-evaluation failed — _${String(r.rerunError || 'unknown error').slice(0, 200)}_`;
        await _insertAnnotation(doc, vscode, liveInsertAt, annotationMd);
        insertOffset++;
    }

    // ── 7. Run validation checks (charm-level domain invariants) ─────────
    const wardResults = await _runValidationChecks({ charm: { ...charm, questId: quest.id }, bus, signal, spanId });

    // ── 8. Derive verdict ─────────────────────────────────────────────────
    const cellIssues   = analysisResults.filter(r => r.analysis.status === 'issue' || !r.rerunOk);
    const cellWarnings = analysisResults.filter(r => r.analysis.status === 'warning' && r.rerunOk);
    const failedWards  = wardResults.filter(w => w.status === 'failed' || w.status === 'errored');

    let verdict, verificationLevel;
    if (cellIssues.length > 0 || failedWards.length > 0) {
        verdict            = 'dispute';
        verificationLevel  = analysisResults.length > cellIssues.length ? 'partial' : 'disputed';
    } else if (cellWarnings.length > 0) {
        verdict            = 'accept';
        verificationLevel  = 'heuristic';
    } else if (analysisResults.length > 0) {
        verdict            = 'accept';
        verificationLevel  = wardResults.some(w => w.status === 'passed') ? 'verified' : 'heuristic';
    } else {
        verdict            = 'needs_review';
        verificationLevel  = 'none';
    }

    const objections = [
        ...cellIssues.map(r => {
            const num = r.originalIndex + 1;
            if (!r.rerunOk) return `Cell ${num}: re-evaluation failed — ${String(r.rerunError || 'unknown error').slice(0, 200)}`;
            return `Cell ${num}: ${(r.analysis.issues || []).join('; ') || r.analysis.summary}`.slice(0, 300);
        }),
        ...failedWards.map(w => `Validation (${w.method}): ${String(w.detail || '').slice(0, 240)}`),
    ];

    const wardSummary = {
        total:   wardResults.length,
        passed:  wardResults.filter(w => w.status === 'passed').length,
        failed:  wardResults.filter(w => w.status === 'failed').length,
        skipped: wardResults.filter(w => w.status === 'skipped').length,
        errored: wardResults.filter(w => w.status === 'errored').length,
    };
    const summary = {
        total:   analysisResults.length,
        matched: analysisResults.filter(r => r.rerunOk && r.analysis.status === 'ok').length,
        failed:  cellIssues.length,
        skipped: 0,
    };

    // ── 9. Append conclusion cell ─────────────────────────────────────────
    await _appendConclusion(doc, vscode, { verdict, verificationLevel, analysisResults, wardResults });

    // ── 10. Backward-compat checks array ─────────────────────────────────
    const checks = analysisResults.map(r => ({
        expression:     r.code.replace(/\s+/g, ' ').slice(0, 240),
        match:          r.analysis.status === 'ok' && r.rerunOk ? true
                        : r.analysis.status === 'issue' || !r.rerunOk ? false
                        : null,
        kind:           r.rerunOk ? 'ok' : (r.rerunError ? 'error' : 'skipped'),
        durationMs:     0,
        cached:         false,
        originalOutput: r.analysis.summary ? r.analysis.summary.slice(0, 200) : '',
        recheckOutput:  r.rerunOk ? String(r.rerunOutput || '').slice(0, 200) : '',
        recheckMessages: null,
        error:          r.rerunError || null,
        deepChecks:     [],
    }));

    // ── 11. Emit skeptic.verdict (same schema) ────────────────────────────
    try {
        await bus.appendEvent('skeptic.verdict', {
            questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
            verdict, verificationLevel, objections, summary, wardSummary,
            verificationCounts: { cells: analysisResults.length },
            charmNotebookPath,
            checks,
        }, { spanId, questId: quest.id, charmId: charm.id });
    } catch (_) {}

    return {
        verdict, verificationLevel, objections, checks,
        wardResults, wardSummary, summary,
        verificationCounts: { cells: analysisResults.length },
        spanId,
        criticNotebookPath: charmNotebookPath,  // annotations are inline now
        charmNotebookPath,
    };
}

module.exports = { runCellCritic };
