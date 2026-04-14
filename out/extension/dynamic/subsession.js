'use strict';
// dynamic/subsession.js — Dialog[] subsession (⌥⇧↵), Dynamic[] poll loop, and helpers.
// Extracted from controller.js. Functions receive `self` (= WolframNotebookKernel) as first arg.

const vscode       = require('vscode');
const path         = require('path');
const fs           = require('fs');
const { scrollLog, dynLog } = require('../utils/dev-logger');
const _output      = require('../output/renderer');

// Split string s at top-level commas (depth-0), respecting nested brackets and strings.
// Used to separate Dynamic[expr, LiveTime->t, LiveEvaluations->n] arguments.
function splitAtTopLevelCommas(s) {
const parts = [];
let depth = 0, inStr = false, start = 0;
for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; }
    else if (ch === '"') { inStr = true; }
    else if (ch === '<' && i + 1 < s.length && s[i + 1] === '|') { depth++; i++; }
    else if (ch === '|' && i + 1 < s.length && s[i + 1] === '>') { depth--; i++; }
    else if ('[({'.includes(ch)) depth++;
    else if ('])}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; }
}
parts.push(s.slice(start).trim());
return parts;
}

// Split cell code into top-level WL expressions, bracket-depth aware.
// Returns [{text, slotIndex, isDynamic, dynInner}].
function splitTopLevelExprs(code) {
const exprs = [];
let depth = 0, inStr = false, start = 0;
for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
    } else if (ch === '"') {
        inStr = true;
    } else if (ch === '<' && i + 1 < code.length && code[i + 1] === '|') {
        depth++; i++; // <| Association open
    } else if (ch === '|' && i + 1 < code.length && code[i + 1] === '>') {
        depth--; i++; // |> Association close
    } else if ('[({'.includes(ch)) {
        depth++;
    } else if ('])}'.includes(ch)) {
        depth--;
    } else if (ch === '\n' && depth === 0) {
        const text = code.slice(start, i).trim();
        if (text) exprs.push(text);
        start = i + 1;
    }
}
const last = code.slice(start).trim();
if (last) exprs.push(last);
let outputIdx = 0;
return exprs.map((text, idx) => {
    const isDynamic = text.startsWith('Dynamic[') && text.endsWith(']');
    // Pure comments ( (* ... *) on their own line ) produce no kernel output
    // and must NOT advance the output-slot counter. If they did, the slotIndex
    // assigned to a following Dynamic[...] would be 1 instead of 0, causing
    // _putAllOutputs to write the rendered value to a phantom second output
    // while the placeholder at index 0 stays forever.
    const isComment = text.startsWith('(*') && text.endsWith('*)');
    const slotIndex = outputIdx;
    if (!isComment) outputIdx++;
    let dynInner = null, dynLiveTime = null, dynLiveEvals = null, dynLiveCells = null;
    if (isDynamic) {
        const fullInner = text.slice('Dynamic['.length, -1);
        const parts = splitAtTopLevelCommas(fullInner);
        dynInner = parts[0];
        for (let k = 1; k < parts.length; k++) {
            const ltm = parts[k].match(/^LiveTime\s*->\s*([0-9]*\.?[0-9]+)/);
            const lev = parts[k].match(/^LiveEvaluations\s*->\s*([0-9]+)/);
            const lce = parts[k].match(/^LiveCells\s*->\s*([0-9]+)/);
            if (ltm) dynLiveTime  = parseFloat(ltm[1]);
            if (lev) dynLiveEvals = parseInt(lev[1], 10);
            if (lce) dynLiveCells = parseInt(lce[1], 10);
        }
    }
    return { text, slotIndex, isDynamic, dynInner, dynLiveTime, dynLiveEvals, dynLiveCells };
});
}

// Render a WExpr as a plain InputForm string (for Dialog: Out display)
function wexprToInputForm(expr) {
if (!expr || typeof expr !== 'object') return String(expr);
if (expr.error) return '(error: ' + String(expr.error) + ')';
if (expr.type === 'integer' || expr.type === 'real' || expr.type === 'biginteger') return String(expr.value);
if (expr.type === 'string')
    return '"' + String(expr.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
if (expr.type === 'symbol') return String(expr.value);
if (expr.type === 'function') {
    const head = String(expr.head || '?');
    const args = (expr.args || []).map(a => wexprToInputForm(a)).join(', ');
    return head + '[' + args + ']';
}
return JSON.stringify(expr);
}

// ⌥⇧↵ — evaluate the active cell inside a Dialog[] subsession on the
// live running kernel, write the result to that cell's output with a
// "Dialog: Out" label, then exit the dialog so the main eval resumes.
//
// Flow:
//   1. Interrupt the kernel → Wolfram interrupt handler opens Dialog[].
//   2. Poll until session.isDialogOpen (max 5 s).
//   3. dialogEval(cellCode) → WExpr result; Print[] lines collected via
//      onDialogPrint on the in-flight checkoutExecutionQueue evaluate().
//   4. exitDialog() → main evaluation resumes.
//   5. Write result + print lines to the cell's output.
async function openDialogSubsession(self) {
    if (!self.session || self.kernelStatusString !== 'resolved') {
        vscode.window.showWarningMessage('No kernel running — start the kernel first.');
        return;
    }
    if (self.session.isDialogOpen) {
        vscode.window.showWarningMessage('A dialog subsession is already open.');
        return;
    }
    // Resolve the active cell first — needed for both idle and busy paths.
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) { vscode.window.showWarningMessage('No active notebook editor.'); return; }
    const sel = editor.selections;
    if (!sel || sel.length === 0) { vscode.window.showWarningMessage('No cell selected.'); return; }
    const cell = editor.notebook.cellAt(sel[0].start);
    if (!cell || cell.kind !== vscode.NotebookCellKind.Code) {
        vscode.window.showWarningMessage('Select a code cell to evaluate in the dialog (select a code cell first).');
        return;
    }
    const cellCode = cell.document.getText().trim();
    if (!cellCode) { vscode.window.showWarningMessage('Cell is empty.'); return; }

    const busy = self.executionQueue.queue.length > 0 && self.executionQueue.queue[0].started;

    // ---- Idle kernel: queue cell through the normal execution pipeline ----
    // The full rendering machinery (SVG graphics, LaTeX, format buttons, etc.)
    // applies exactly as with Shift+Enter.  The only visible difference is the
    // amber "subsession" badge placed next to each Out[...]=  label.
    if (!busy) {
        self._subsessionCellUris.add(cell.document.uri.toString());
        const execution = self._controller.createNotebookCellExecution(cell);
        self.executionQueue.push(execution);
        self.checkoutExecutionQueue();
        return;
    }

    // ---- Busy kernel: evaluate via subAuto() ----
    // subAuto routes through Dialog[] inline eval when busy — no interrupt needed.
    // Notebook image directory so the subkernel can save SVG files there.
    const _subNbPath = cell.notebook.uri.fsPath;
    const _subNbBase = path.basename(_subNbPath, path.extname(_subNbPath));
    const _subImgDir = path.join(path.dirname(_subNbPath), 'img', _subNbBase);
    const _subImgRel = 'img/' + _subNbBase;
    try { fs.mkdirSync(_subImgDir, { recursive: true }); } catch (_) {}

    const _dlgFormat = self._resolveFormat(cell);
    const _dlgScale  = Number(self.config.get('imageScale') || 0.8);

    // Create a VS Code execution for this cell so it shows the running spinner.
    const execution = self._controller.createNotebookCellExecution(cell);
    execution.start(Date.now());
    await execution.replaceOutput([new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
            '<div style="color:#e8a020;font-size:11px;font-style:italic;">⏳ Subsession: evaluating…</div>',
            'x-application/wolfram-language-html'
        )
    ])]);

    // Single subAuto call: evaluate cellCode AND render inline via VsCodeRenderExpr.
    // No .mx file export/import, no separate subkernel — same pattern as evaluateSelection.
    const _subImgDirWL = _subImgDir.replace(/\\/g, '/');
    const _dlgSentExpr =
        'Block[{wbSS$v},' +
        'VsCodeSetImgDir["' + _subImgDirWL + '","' + _subImgRel + '"];' +
        'wbSS$v=ToExpression["' + self.escapeWL(cellCode) + '"];' +
        'VsCodeRenderExpr[wbSS$v,"' + _dlgFormat + '",' + _dlgScale + ']' +
        ']';
    scrollLog('[subsession-subAuto] cellCode:', cellCode);
    scrollLog('[subsession-subAuto] sent to subAuto:', _dlgSentExpr.slice(0, 200));
    let _renderHtmlDirect = null;
    let _dlgEvalError = null;
    try {
        const _dlgWexpr = await Promise.race([
            self.session.subAuto(_dlgSentExpr),
            new Promise((_, rej) => setTimeout(() => rej(new Error('subsession-subAuto timeout (15s)')), 15000))
        ]);
        scrollLog('[subsession-subAuto] result type:', _dlgWexpr?.type, '| len:', String(_dlgWexpr?.value ?? '').length);
        if (_dlgWexpr?.error) {
            _dlgEvalError = _dlgWexpr.error;
        } else if (_dlgWexpr?.type === 'string' && _dlgWexpr.value) {
            _renderHtmlDirect = _dlgWexpr.value;
        } else {
            _dlgEvalError = 'subAuto returned: ' + JSON.stringify(_dlgWexpr);
        }
    } catch (_err) {
        _dlgEvalError = _err.message;
        scrollLog('[subsession-subAuto] subAuto threw:', _dlgEvalError);
    }

    // Post-process rendered HTML (WLLatex box expansion, image URI fix)
    if (_renderHtmlDirect) {
        if (self._processWLLatexBoxes) _renderHtmlDirect = self._processWLLatexBoxes(_renderHtmlDirect);
        if (self._fixImageUris)        _renderHtmlDirect = self._fixImageUris(_renderHtmlDirect);
    }

    // Render via inline subAuto — full VsCodeRenderExpr pipeline on the main kernel.
    const _subsBadge =
        '<span style="font-size:9px;color:#e8a020;background:rgba(232,160,32,0.12);' +
        'border:1px solid rgba(232,160,32,0.35);border-radius:3px;padding:1px 5px;' +
        'margin-right:6px;font-style:italic;">subsession</span>';

    const parts = [];

    if (_dlgEvalError || _renderHtmlDirect === null) {
        const _errMsg = _dlgEvalError || 'dialog eval returned no result';
        parts.push(
            '<div style="display:flex;align-items:baseline;gap:4px;padding:3px 0">' +
            _subsBadge +
            '<span style="font-size:10px;color:#e8a020;margin-right:8px;">Out=</span>' +
            '<span style="color:#f44747;font-family:Consolas,monospace;font-size:13px;">' +
            self.escapeHtml(_errMsg) + '</span></div>'
        );
    } else {
        const _headerLabel =
            _subsBadge +
            '<span style="font-size:10px;color:#888;margin-right:8px;">Out=</span>';
        const _headerRow =
            '<div class="wl-output-header" style="display:flex;align-items:center;' +
            'gap:6px;width:100%;min-height:22px;" data-session-epoch="' + self._sessionEpoch + '">' +
            _headerLabel + '</div>';
        parts.push(
            '<div class="wl-output-block">' + _headerRow +
            '<div class="wl-output-content">' + _renderHtmlDirect + '</div></div>'
        );
    }

    await execution.replaceOutput([new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
            '<div data-session-epoch="' + self._sessionEpoch + '">' + parts.join('') + '</div>',
            'x-application/wolfram-language-html'
        )
    ])]);
    execution.end(true, Date.now());
}

// -----------------------------------------------------------------------

// Dynamic cell loop:
//   ONE loop per cell. Each cycle mirrors exactly ⌥⇧↵:
//     1. Wait until kernel is busy.
//     2. Interrupt once → wait for Dialog[].
//     3. dialogEval each Dynamic slot sequentially (same dialog session).
//     4. exitDialog() → kernel resumes.
//     5. Render each exported slot via subkernel → update all outputs at once.
//     6. Wait 500ms, repeat.
function startDynamicCell(self, cell, dynExprs, imgDir, imgRel, ownedExec) {
    const epoch   = self._sessionEpoch;
    const cellUri = cell.document.uri.toString();

    if (!self._dynamicWidgets) self._dynamicWidgets = new Map();
    const prev = self._dynamicWidgets.get(cellUri);
    if (prev) { if (prev.cancel) prev.cancel(); else prev.active = false; }
    let _cancelResolve;
    const _cancelPromise = new Promise(resolve => { _cancelResolve = resolve; });
    const state = { active: true };
    state._cancelPromise = _cancelPromise;
    state.cancel = () => { state.active = false; _cancelResolve(); };
    self._dynamicWidgets.set(cellUri, state);

    // earlyStart: true when started inline (before execution.end() of the owner cell).
    // refreshSnapshots: called after execution.end() to update snapOutputs with the
    // full set of cell outputs (Print[] results + static sub-expression outputs).
    state.earlyStart = !!(ownedExec);
    state.refreshSnapshots = (newOutputs) => {
        // Replace contents of snapOutputs array in-place (keeps same reference).
        const src = newOutputs || Array.from(cell.outputs);
        snapOutputs.length = 0;
        for (const o of src) snapOutputs.push(o);
    };

    // Snapshot of all cell outputs (preserves static-slot outputs across updates).
    if (!self._dynCells) self._dynCells = new Map();
    const snapOutputs = Array.from(cell.outputs);
    self._dynCells.set(cellUri, { cell, outputs: snapOutputs });

    const _applyDynamicOutputs = async (outputs) => {
        try {
            const exe = self._controller.createNotebookCellExecution(cell);
            exe.start(Date.now());
            await exe.replaceOutput(outputs);
            exe.end(true, Date.now());
        } catch (_) {
            // Fallback: workspace edit (no spinner but less reliable)
            try {
                const edit = new vscode.WorkspaceEdit();
                edit.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellOutputs(cell.index, outputs)]);
                await vscode.workspace.applyEdit(edit);
            } catch (_2) {}
        }
    };

    scrollLog('[dyn] cell loop start | slots:', dynExprs.map(d => d.slotIndex).join(','), '| epoch:', epoch);

    // Expiry limits: take the most restrictive value across all Dynamic slots.
    const liveTimeSec   = dynExprs.reduce((m, d) => (d.dynLiveTime  != null && d.dynLiveTime  < m) ? d.dynLiveTime  : m, Infinity);
    // LiveEvaluations: counts individual sub-expression dispatches (not cell-level).
    const liveEvalLimit = dynExprs.reduce((m, d) => (d.dynLiveEvals != null && d.dynLiveEvals < m) ? d.dynLiveEvals : m, Infinity);
    // LiveCells: counts cell-level dispatches (one per Shift+Enter).
    const liveCellLimit = dynExprs.reduce((m, d) => (d.dynLiveCells != null && d.dynLiveCells < m) ? d.dynLiveCells : m, Infinity);
    const _liveStartTime    = Date.now();
    const _epochAtStart     = self._dispatchEpoch;
    // For early-start widgets (ownedExec != null) the Dynamic's own cell has already
    // incremented _cellEpoch — offset by -1 so LiveCells->1 counts the own cell as
    // dispatch #1 and expires at the end of that cell.
    // For normal (non-early-start) widgets the own cell is not counted; dispatches
    // start from the NEXT cell (matching LiveCells->2 in test S).
    // _cellEpoch now increments at the END of each cell (after all outputs committed).
    // At widget-start time it has NOT yet incremented for the current cell even in
    // early-start mode, so no offset is needed for ownedExec.
    const _cellEpochAtStart = self._cellEpoch || 0;

    // _badgeExtra: small counter appended to the live/paused badge text.
    // e.g. ' · 3 evals' or ' · 2 cells · 8s'. Updated before each _putAllOutputs call.
    let _badgeExtra = '';
    // Latest dispatch counts — kept in outer scope so _badge(status, de) can build
    // per-slot badge extras without needing them passed through call chains.
    let _latestEvalsSince = 0, _latestCellsSince = 0;
    const _updateBadgeExtra = (evalsSince, cellsSince) => {
        _latestEvalsSince = evalsSince;
        _latestCellsSince = cellsSince;
        const _evLeft   = isFinite(liveEvalLimit) ? Math.max(0, liveEvalLimit - evalsSince) : null;
        const _cellLeft = isFinite(liveCellLimit) ? Math.max(0, liveCellLimit - cellsSince)  : null;
        const _secLeft  = isFinite(liveTimeSec)   ? Math.max(0, Math.round(liveTimeSec - (Date.now() - _liveStartTime) / 1000)) : null;
        const _parts = [];
        if (_evLeft   !== null) _parts.push(_evLeft   + ' eval'  + (_evLeft   === 1 ? '' : 's'));
        if (_cellLeft !== null) _parts.push(_cellLeft + ' cell'  + (_cellLeft === 1 ? '' : 's'));
        if (_secLeft  !== null) _parts.push(_secLeft  + 's');
        _badgeExtra = _parts.length ? ' · ' + _parts.join(' · ') : '';
    };
    // Set initial counter for the pre-loop 'waiting' display (0 dispatches consumed yet).
    _updateBadgeExtra(0, 0);

    // _isExpired: legacy flag (kept for safety).
    // _slotExpired[i]: true once slot i's output has been blanked and loop should skip it.
    // _slotTimeExpiredPending[i]: LiveTime deadline passed for slot i but kernel still busy;
    //   _putAllOutputs shows ⊘ badge for that slot while waiting for idle.
    let _isExpired = false;
    const _slotExpired            = new Array(dynExprs.length).fill(false);
    const _slotTimeExpiredPending = new Array(dynExprs.length).fill(false);
    const _markExpired = () => { _isExpired = true; };

    // _badge(status, de): build the badge HTML for one Dynamic slot.
    // When `de` is provided its own LiveXxx limits are shown (per-slot badge).
    // Falls back to the shared _badgeExtra when de is null/undefined.
    const _badge = (status, de) => {
        let badgeExtra = _badgeExtra; // shared fallback
        if (de) {
            // Compute badge extra using only the limits that belong to this specific slot.
            const _parts = [];
            if (de.dynLiveEvals != null) {
                const left = Math.max(0, de.dynLiveEvals - _latestEvalsSince);
                _parts.push(left + ' eval' + (left === 1 ? '' : 's'));
            }
            if (de.dynLiveCells != null) {
                const left = Math.max(0, de.dynLiveCells - _latestCellsSince);
                _parts.push(left + ' cell' + (left === 1 ? '' : 's'));
            }
            if (de.dynLiveTime != null) {
                const left = Math.max(0, Math.round(de.dynLiveTime - (Date.now() - _liveStartTime) / 1000));
                _parts.push(left + 's');
            }
            badgeExtra = _parts.length ? ' · ' + _parts.join(' · ') : '';
        }
        const color = status === 'live'    ? '#c678dd'
                    : status === 'paused'  ? '#888'
                    : status === 'expired' ? '#e06c75'
                    : '#e8a020';
        const bg    = status === 'live'    ? 'rgba(198,120,221,0.12)'
                    : status === 'paused'  ? 'rgba(128,128,128,0.10)'
                    : status === 'expired' ? 'rgba(224,108,117,0.12)'
                    : 'rgba(232,160,32,0.12)';
        const bd    = status === 'live'    ? 'rgba(198,120,221,0.35)'
                    : status === 'paused'  ? 'rgba(128,128,128,0.25)'
                    : status === 'expired' ? 'rgba(224,108,117,0.35)'
                    : 'rgba(232,160,32,0.35)';
        const label = status === 'live'    ? '⟳ Dynamic' + badgeExtra
                    : status === 'paused'  ? '⏸ Dynamic' + badgeExtra
                    : status === 'expired' ? '⊘ Dynamic' + badgeExtra
                    : '⏳ Dynamic' + badgeExtra;
        return '<span style="font-size:9px;color:' + color + ';background:' + bg + ';' +
               'border:1px solid ' + bd + ';border-radius:3px;padding:1px 6px;' +
               'margin-right:6px;font-style:italic;">' + label + '</span>';
    };

    // Update all Dynamic slot outputs in one notebook edit.
    // htmlBySlot: { slotIndex: htmlString } — slots absent from the map keep their current output.
    const _putAllOutputs = async (htmlBySlot, status) => {
        // Guard: if the session epoch changed (kernel restarted), do not write
        // stale output over the cleared cells.
        if (self._sessionEpoch !== epoch) return;
        try {
            const t = Date.now();
            // Early-start mode: the main execution is still open so
            // createNotebookCellExecution would fail.  Instead, update just the
            // Dynamic slot in-place via the owned execution's replaceOutputItems.
            if (ownedExec && ownedExec.active) {
                for (let _i = 0; _i < dynExprs.length; _i++) {
                    const de = dynExprs[_i];
                    if (_slotExpired[_i]) continue; // already cleared — leave blank
                    if (de.slotIndex >= snapOutputs.length) continue;
                    const _slotStatus = _slotTimeExpiredPending[_i] ? 'expired' : status;
                    const html = htmlBySlot[de.slotIndex] || null;
                    const body = html
                        ? '<div class="wl-output-content">' + html + '</div>'
                        : '';
                    const newItem = vscode.NotebookCellOutputItem.text(
                        '<div data-dynamic="1" data-epoch="' + epoch + '">'
                        + '<div style="display:flex;align-items:center;padding:2px 0 4px;">'
                        + _badge(_slotStatus, de) + '</div>' + body + '</div>',
                        'x-application/wolfram-language-html'
                    );
                    // TODO-1g: expose Dynamic current value to Copilot as text/plain
                    const _dynPlainEarly = html
                        ? (_output.extractPlainText(html, 'Dynamic[' + de.dynInner + '] =', false, cell.document.getText()) || ('(* Dynamic[' + de.dynInner + '] *)'))
                        : ('(* Dynamic[' + de.dynInner + '] *)');
                    const newPlainItem = vscode.NotebookCellOutputItem.text(_dynPlainEarly, 'text/plain');
                    try {
                        await ownedExec.exec.replaceOutputItems([newItem, newPlainItem], snapOutputs[de.slotIndex]);
                    } catch (_roe) { /* execution may have ended — silently ignore */ }
                }
                return;
            }
            const snap = snapOutputs.slice();
            for (let i = 0; i < dynExprs.length; i++) {
                const de = dynExprs[i];
                if (_slotExpired[i]) {
                    // Slot already cleared — write an explicit empty-string item so
                    // renderOutputItem fires and sets innerHTML='' on the stale container.
                    // (NotebookCellOutput([]) has zero items → renderOutputItem is never
                    // called → old HTML stays visible until the file is re-opened.)
                    if (de.slotIndex < snap.length) snap[de.slotIndex] = new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text('', 'x-application/wolfram-language-html')
                    ]);
                    continue;
                }
                const _slotStatus = _slotTimeExpiredPending[i] ? 'expired' : status;
                const html = htmlBySlot[de.slotIndex] || null;
                const body = html
                    ? '<div class="wl-output-content">' + html + '</div>'
                    : '';
                // TODO-1g: expose Dynamic current value to Copilot as text/plain
                const _dynPlain = html
                    ? (_output.extractPlainText(html, 'Dynamic[' + de.dynInner + '] =', false, cell.document.getText()) || ('(* Dynamic[' + de.dynInner + '] *)'))
                    : ('(* Dynamic[' + de.dynInner + '] *)');
                const out = new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(
                        '<div data-dynamic="1" data-epoch="' + epoch + '">'
                        + '<div style="display:flex;align-items:center;padding:2px 0 4px;">'
                        + _badge(_slotStatus, de) + '</div>' + body + '</div>',
                        'x-application/wolfram-language-html'
                    ),
                    vscode.NotebookCellOutputItem.text(_dynPlain, 'text/plain')
                ]);
                if (de.slotIndex < snap.length) snap[de.slotIndex] = out;
                else { while (snap.length < de.slotIndex) snap.push(new vscode.NotebookCellOutput([])); snap.push(out); }
            }
            for (let i = 0; i < snap.length; i++) snapOutputs[i] = snap[i];
            if (self._dynCells && self._dynCells.has(cellUri))
                self._dynCells.get(cellUri).outputs = snap;
            await _applyDynamicOutputs(snap);
        } catch (e) { scrollLog('[dyn] _putAllOutputs error:', e.message); }
    };

    // _clearOneSlot(slotIdx): blank ONE Dynamic slot output without touching other slots.
    // Reads cell.outputs fresh to pick up Print/static outputs written since the last
    // _putAllOutputs, syncs snapOutputs, then replaces only the expired slot with empty.
    const _clearOneSlot = async (slotIdx) => {
        if (self._sessionEpoch !== epoch) return;
        if (ownedExec && ownedExec.active) {
            // Early-start: owned execution is still open — use replaceOutputItems to blank
            // this slot in-place so the output visually clears even before execution.end().
            if (slotIdx < snapOutputs.length) {
                try {
                    await ownedExec.exec.replaceOutputItems(
                        [vscode.NotebookCellOutputItem.text('', 'x-application/wolfram-language-html')],
                        snapOutputs[slotIdx]
                    );
                } catch (_) {}
            }
            return;
        }
        try {
            const _live = Array.from(cell.outputs);
            while (snapOutputs.length > _live.length) snapOutputs.pop();
            for (let _ii = 0; _ii < _live.length; _ii++) snapOutputs[_ii] = _live[_ii];
            const snap = snapOutputs.slice();
            // Use an empty-string item (not zero-item output) so renderOutputItem fires
            // and clears innerHTML on the stale container immediately.
            if (slotIdx < snap.length) snap[slotIdx] = new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text('', 'x-application/wolfram-language-html')
            ]);
            for (let _ii = 0; _ii < snap.length; _ii++) snapOutputs[_ii] = snap[_ii];
            if (self._dynCells?.has(cellUri)) self._dynCells.get(cellUri).outputs = snap;
            await _applyDynamicOutputs(snap);
        } catch (_) {}
    };

    // Show the badge immediately, but do not render a grey waiting body.
    // The first subAuto() attempt starts almost immediately.
    _putAllOutputs({}, 'paused');

    // ---- Register Dynamic expressions with C++ registry ----
    // Dynamic slot updates use subAuto() which auto-routes:
    //   idle  → subWhenIdle (immediate)
    //   busy  → inline dialog evaluation driven by the C++ timer thread
    // C++ registry also provides live-watch (__watch__) and eval-selection
    // (__evalsel__) piggyback via getDynamicResults().
    if (self.session?.registerDynamic) {
        for (const de of dynExprs)
            try { self.session.unregisterDynamic(cellUri + ':' + de.slotIndex); } catch (_) {}
        for (const de of dynExprs) {
            const escaped = de.dynInner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            self.session.registerDynamic(cellUri + ':' + de.slotIndex,
                'VsCodeDynExportValue["' + escaped + '"]');
        }
        // Busy-path Dynamic polling is driven by the C++ timer thread.
        try { self.session.setDynamicInterval(150); } catch (_) {}
    }

    const runLoop = async () => {
        let cycle = 0;
        const htmlBySlot     = {};
        const lastHtmlBySlot = {};
        let _lastBadgeTickTime   = 0;
        let _lastWatchExpr       = null;  // tracks registered watch expr to re-register on change
        while (true) {
            cycle++;
            if (!state.active || self._sessionEpoch !== epoch) {
                scrollLog('[dyn] cell loop exit | cycle:', cycle);
                // Only clean up C++ registry, timer, and cell output if this
                // widget is still the active one. A re-execution replaces the
                // map entry before cancel fires, so the old loop must not
                // unregister slots or clear output that the new loop owns.
                const _isStillOwner = self._dynamicWidgets.get(cellUri) === state;
                if (_isStillOwner) {
                    if (self.session?.unregisterDynamic) {
                        for (const de of dynExprs)
                            try { self.session.unregisterDynamic(cellUri + ':' + de.slotIndex); } catch (_) {}
                        if (_lastWatchExpr !== null)
                            try { self.session.unregisterDynamic('__watch__'); } catch (_) {}
                        if (self._evalSelectionCallback)
                            try { self.session.unregisterDynamic('__evalsel__'); } catch (_) {}
                    }
                    self._dynamicWidgets.delete(cellUri);
                    if (self._dynamicWidgets.size === 0) {
                        try { self.session?.setDynAutoMode?.(false); } catch (_) {}
                        try { self.session?.setDynamicInterval?.(0); } catch (_) {}
                    }
                    // Clear cell output so stale Dynamic content doesn't linger
                    // after kernel restart — don't rely on launchKernel timing.
                    try { await _applyDynamicOutputs([]); } catch (_) {}
                }
                return;
            }

            // LiveTime / LiveEvaluations / LiveCells expiry checks.
            // LiveEvaluations: sub-expression dispatch count since widget start.
            // LiveCells: cell-level dispatch count since widget start.
            const _evalsSinceStart = (self._dispatchEpoch - _epochAtStart + 0x1000000) & 0xFFFFFF;
            const _cellsSinceStart = ((self._cellEpoch || 0) - _cellEpochAtStart + 0x1000000) & 0xFFFFFF;
            // Update badge counter so next _putAllOutputs reflects current remaining counts.
            _updateBadgeExtra(_evalsSinceStart, _cellsSinceStart);

            // Busy = any evaluation is queued (started or pending) AND we are not in abort.
            // Check queue.length only (not queue[0].started) so sub() calls stop as soon
            // as a new cell is queued — before executionQueue.start() is called — preventing
            // concurrent sub()+evaluate() collisions on the WSTP link.
            // NOTE: computed BEFORE the LiveTime check so we can wait for !busy before clearing.
            const busy = !self._abortPending && self.executionQueue.queue.length > 0;

            // LiveTime expiry: once the wall-clock deadline passes, mark expired and show
            // the red ⊘ badge (once). If the kernel is still busy, wait for it to finish
            // before clearing the output — so the user sees the expiry state, not a void.
            // --- Per-slot expiry ---
            // LiveTime: once the deadline passes show ⊘ badge for that slot only;
            //   clear it when the kernel becomes idle (!busy).
            // LiveEvals / LiveCells: clear the slot as soon as the Nth dispatch finishes.
            for (let _si = 0; _si < dynExprs.length; _si++) {
                if (_slotExpired[_si]) continue;
                const _de = dynExprs[_si];
                if (_de.dynLiveTime != null && (Date.now() - _liveStartTime) / 1000 >= _de.dynLiveTime) {
                    if (!_slotTimeExpiredPending[_si]) {
                        scrollLog('[dyn] slot', _si, 'LiveTime expired | liveTime:', _de.dynLiveTime);
                        _slotTimeExpiredPending[_si] = true;
                        // Re-render with ⊘ badge for this slot only; other slots unaffected.
                        await _putAllOutputs(htmlBySlot, 'live');
                    }
                    if (!busy) {
                        _slotExpired[_si] = true;
                        await _clearOneSlot(_de.slotIndex);
                    }
                }
                if (!busy) {
                    if (_de.dynLiveEvals != null && _evalsSinceStart >= _de.dynLiveEvals) {
                        scrollLog('[dyn] slot', _si, 'LiveEvaluations expired | limit:', _de.dynLiveEvals);
                        _slotExpired[_si] = true;
                        await _clearOneSlot(_de.slotIndex);
                    } else if (_de.dynLiveCells != null && _cellsSinceStart >= _de.dynLiveCells) {
                        scrollLog('[dyn] slot', _si, 'LiveCells expired | limit:', _de.dynLiveCells);
                        _slotExpired[_si] = true;
                        await _clearOneSlot(_de.slotIndex);
                    }
                }
            }
            // Exit the widget loop only when every slot has expired.
            if (_slotExpired.every(v => v)) {
                scrollLog('[dyn] all slots expired — cell loop exit | cellUri:', cellUri);
                if (self.session?.unregisterDynamic) {
                    for (const de of dynExprs)
                        try { self.session.unregisterDynamic(cellUri + ':' + de.slotIndex); } catch (_) {}
                    if (_lastWatchExpr !== null)
                        try { self.session.unregisterDynamic('__watch__'); } catch (_) {}
                    if (self._evalSelectionCallback)
                        try { self.session.unregisterDynamic('__evalsel__'); } catch (_) {}
                }
                if (self._dynamicWidgets.get(cellUri) === state) {
                    self._dynamicWidgets.delete(cellUri);
                    if (self._dynamicWidgets.size === 0) {
                        try { self.session?.setDynAutoMode?.(false); } catch (_) {}
                        try { self.session?.setDynamicInterval?.(0); } catch (_) {}
                    }
                }
                return;
            }

            scrollLog('[dyn] cycle', cycle, '| busy:', busy, '| dispatched:', self._evalDispatched, '| evalsSince:', _evalsSinceStart);

            // LiveEvaluations / LiveCells limit: stop updating once hit.
            if (!busy) {
                if (isFinite(liveEvalLimit) && _evalsSinceStart >= liveEvalLimit) {
                    if (!_isExpired) {
                        scrollLog('[dyn] LiveEvaluations limit reached, showing expired badge');
                        _markExpired();
                        await _putAllOutputs(htmlBySlot, 'expired');
                    }
                    await new Promise(r => setTimeout(r, 300)); continue;
                }
                if (isFinite(liveCellLimit) && _cellsSinceStart >= liveCellLimit) {
                    if (!_isExpired) {
                        scrollLog('[dyn] LiveCells limit reached, showing expired badge');
                        _markExpired();
                        await _putAllOutputs(htmlBySlot, 'expired');
                    }
                    await new Promise(r => setTimeout(r, 300)); continue;
                }
            }

            // ---- Unified subAuto() path ----
            // Poll Dynamic values via subAuto() which auto-routes:
            //   idle  → subWhenIdle (immediate)
            //   busy  → Dialog[] inline eval driven by the C++ timer thread
            // Dynamic values update continuously, even during busy evals.
            // Also skip while isAborting — subAuto() enqueues into autoExprQueue_,
            // which can still delay abort completion if requests keep piling up.
            // With pending entries each cycle takes up to ~5.5s, chaining across
            // the full 17s abort-retry window and preventing abort from resolving.
            //
            // _subAutoLock: serialize subAuto calls across all Dynamic loops.
            // Multiple concurrent idle-path subAuto calls right after a Dialog-
            // heavy evaluation (Do[...;Pause,...]) can leave stale RETURNPKTs
            // on the WSTP link and wedge the C++ session.  The lock tracks the
            // *actual* C++ promise (not the Promise.race timeout) so a timed-out
            // but still-pending C++ call keeps the lock held.
            //
            // _setupRunning: skip subAuto while checkout setup is in progress
            // (syntax check + VsCodeSetImgDir).  Those sub()/evaluate() calls
            // share the WSTP link and overlapping them with an idle-path subAuto
            // desynchronises the packet stream.
            const _setupRunning = self.executionQueue.queue.length > 0
                && self.executionQueue.queue[0].started && !self._evalDispatched;
            // Keep only a short cooldown after the main eval ends so the first
            // idle-path subAuto refresh appears quickly while the link settles.
            const _postEvalCooldown = self._evalEndedAt
                && (Date.now() - self._evalEndedAt) < 400;
            if (!self._abortPending && !self.isAborting
                    && !self._subAutoLock && !_setupRunning && !_postEvalCooldown
                    && (Date.now() - (self._dynLastIdleRender || 0)) > 250) {
                self._dynLastIdleRender = Date.now();
                const scale = Number(self.config?.get?.('imageScale') ?? 0.8) || 0.8;
                let _anyChanged = false;
                for (const de of dynExprs) {
                    if (!state.active || self._sessionEpoch !== epoch) break;
                    if (_slotExpired[dynExprs.indexOf(de)]) continue;
                    const escaped = de.dynInner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    // Single-hop Dynamic update: evaluate + render in one subAuto call.
                    // Avoids temp-file export/import and avoids subkernel render roundtrip.
                    const expr =
                        'Module[{dynVal=TimeConstrained[Quiet[Check[ToExpression["' + escaped + '"],$Failed]],4,$Failed]},' +
                        'If[!MatchQ[dynVal,Except[$Failed|$Aborted|HoldComplete[___]]],"",VsCodeRenderExpr[dynVal,"Auto",' + scale + ']]' +
                        ']';
                    dynLog('DYN-SUB | cycle', cycle, '| slot', de.slotIndex);
                    self.writeDebugLog(`[DYN] subAuto start | cycle ${cycle} | slot ${de.slotIndex} | expr: ${expr.slice(0, 60)}`);
                    const _cppPromise = self.session.subAuto(expr);
                    self._subAutoLock = _cppPromise;
                    _cppPromise.finally(() => {
                        if (self._subAutoLock === _cppPromise) self._subAutoLock = null;
                    });
                    try {
                        const res = await Promise.race([
                            _cppPromise,
                            new Promise((_, rej) => setTimeout(() => rej(new Error('dyn-sub timeout')), 8000)),
                            state._cancelPromise
                        ]);
                        self.writeDebugLog(`[DYN] subAuto done | cycle ${cycle} | slot ${de.slotIndex} | type: ${res?.type}`);
                        if (!state.active) break;
                        const htmlStr = res?.value;
                        if (typeof htmlStr === 'string' && htmlStr.length > 0) {
                            dynLog('DYN-RENDER-OK | cycle', cycle, '| slot', de.slotIndex,
                                   '| htmlLen:', htmlStr.length,
                                   '| changed:', htmlStr !== lastHtmlBySlot[de.slotIndex]);
                            if (htmlStr !== lastHtmlBySlot[de.slotIndex]) {
                                lastHtmlBySlot[de.slotIndex] = htmlStr;
                                htmlBySlot[de.slotIndex] = self._processWLLatexBoxes(self._fixImageUris(htmlStr));
                                _anyChanged = true;
                            }
                        } else {
                            dynLog('DYN-RENDER-EMPTY | cycle', cycle, '| slot', de.slotIndex);
                        }
                    } catch (_subErr) {
                        dynLog('DYN-SUB-ERR | cycle', cycle, '| slot', de.slotIndex, '|', _subErr.message);
                        self.writeDebugLog(`[DYN] subAuto ERROR | cycle ${cycle} | slot ${de.slotIndex} | ${_subErr.message}`);
                    }
                }
                if (_anyChanged) {
                    _lastBadgeTickTime = Date.now();
                    await _putAllOutputs(htmlBySlot, 'live');
                }
            }

            // Live-watch: register via C++ registry when expression changes.
            const _curWatchExpr = self._liveWatchExpr || null;
            if (_curWatchExpr !== _lastWatchExpr) {
                _lastWatchExpr = _curWatchExpr;
                if (_curWatchExpr) {
                    try { self.session?.registerDynamic?.('__watch__', _curWatchExpr); } catch (_) {}
                    dynLog('LIVE-WATCH-REG | cycle', cycle, '| registered new expr');
                } else {
                    try { self.session?.unregisterDynamic?.('__watch__'); } catch (_) {}
                    dynLog('LIVE-WATCH-UNREG | cycle', cycle);
                }
            }

            // Eval-selection one-shot: register in C++ registry when set.
            if (self._evalSelectionExpr) {
                const _esExpr = self._evalSelectionExpr;
                self._evalSelectionExpr = null;
                try { self.session?.registerDynamic?.('__evalsel__', _esExpr); } catch (_) {}
                dynLog('EVAL-SEL-REG | cycle', cycle, '| registered one-shot');
            }

            // Poll C++ results buffer for live-watch / eval-selection results.
            const results = self.session?.getDynamicResults?.();
            if (results && Object.keys(results).length > 0) {
                for (const [id, dynResult] of Object.entries(results)) {
                    if (id === '__watch__') {
                        if (!dynResult.error && self._liveWatchCallback) {
                            dynLog('LIVE-WATCH | cycle', cycle, '| delivering result');
                            try { self._liveWatchCallback({ type: 'string', value: dynResult.value }); } catch (_) {}
                        }
                        continue;
                    }
                    if (id === '__evalsel__') {
                        const _esCb = self._evalSelectionCallback;
                        self._evalSelectionCallback = null;
                        try { self.session?.unregisterDynamic?.('__evalsel__'); } catch (_) {}
                        if (_esCb) {
                            dynLog('EVAL-SEL | cycle', cycle, '| delivering result');
                            try { _esCb({ type: dynResult.error ? 'error' : 'string', value: dynResult.value }); } catch (_) {}
                        }
                        continue;
                    }
                    // Ignore Dynamic slot results from C++ registry — we use subAuto() now.
                }
            }

            // LiveTime countdown tick: refresh badge every ~1 s.
            const _anyLiveTimeActive = dynExprs.some((de, _i) => de.dynLiveTime != null && !_slotExpired[_i]);
            if (_anyLiveTimeActive && (Date.now() - _lastBadgeTickTime) >= 950) {
                _lastBadgeTickTime = Date.now();
                await _putAllOutputs(htmlBySlot, 'live');
            }
            if (state.active) await new Promise(r => setTimeout(r, 150));
        }
    };


    setTimeout(() => runLoop().catch(e => {
        scrollLog('[dyn] runLoop error:', e.message);
        state.active = false;
        // Only clean up if this widget is still the active one for the cell.
        const _isOwner = self._dynamicWidgets.get(cellUri) === state;
        if (_isOwner) {
            self._dynamicWidgets.delete(cellUri);
            if (self.session?.unregisterDynamic) {
                for (const de of dynExprs)
                    try { self.session.unregisterDynamic(cellUri + ':' + de.slotIndex); } catch (_) {}
                try { self.session.unregisterDynamic('__watch__'); } catch (_) {}
                try { self.session.unregisterDynamic('__evalsel__'); } catch (_) {}
            }
            if (self._dynamicWidgets.size === 0) {
                try { self.session?.setDynAutoMode?.(false); } catch (_) {}
                try { self.session?.setDynamicInterval?.(0); } catch (_) {}
            }
            try { _applyDynamicOutputs([]).catch(() => {}); } catch (_) {}
        }
    }), 50);
}

module.exports = {
    openDialogSubsession,
    splitTopLevelExprs,
    splitAtTopLevelCommas,
    startDynamicCell,
    wexprToInputForm,
};
