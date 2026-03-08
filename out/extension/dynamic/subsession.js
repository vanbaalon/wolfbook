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
if (expr.type === 'integer' || expr.type === 'real') return String(expr.value);
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

    // ---- Busy kernel: interrupt and open Dialog[] subsession ----
    // Collect Print[] lines from inside the dialog via onDialogPrint
    const dialogPrintLines = [];
    self._dialogPrintCollector = line => dialogPrintLines.push(line);

    const sent = self.session.interrupt();
    if (!sent) {
        self._dialogPrintCollector = null;
        vscode.window.showWarningMessage('Could not send interrupt to kernel.');
        return;
    }

    // Poll until dialog opens (max 8 s); show status so user knows it's working
    const statusMsg = vscode.window.setStatusBarMessage('⏳ Dialog: waiting for kernel interrupt…');
    const deadline = Date.now() + 8000;
    while (!self.session.isDialogOpen && Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 50));
    }
    statusMsg.dispose();
    if (!self.session.isDialogOpen) {
        self._dialogPrintCollector = null;
        vscode.window.showWarningMessage(
            'Kernel did not open Dialog[] within 8 s. ' +
            'The computation may have finished, or the kernel may be unresponsive. ' +
            'Try again, or restart the kernel.'
        );
        return;
    }
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

    // Step 1: Evaluate cellCode inside the Dialog[], Export to a fixed .mx file,
    // then return the path. No intermediate variables — avoids Module/With issues.
    const _tmpFile = _subImgDir.replace(/\\/g, '/') + '/_subsession_transfer.mx';
    const _dlgSentExpr = '(Export["' + _tmpFile + '", ToExpression["' +
        self.escapeWL(cellCode) + '"]]; "' + _tmpFile + '")';
    scrollLog('[subsession-dlg] cellCode:', cellCode);
    scrollLog('[subsession-dlg] tmp file:', _tmpFile);
    scrollLog('[subsession-dlg] sent to dialogEval:', _dlgSentExpr);
    let _dlgTmpFile = null;
    let _dlgEvalError = null;
    try {
        const _dlgWexpr = await self.session.dialogEval(_dlgSentExpr);
        scrollLog('[subsession-dlg] raw WExpr back:', JSON.stringify(_dlgWexpr));
        // We already know _tmpFile in JS — just check Export didn't return $Failed.
        // Don't use _dlgWexpr.value as path: TEXTPKT wrapping breaks paths with spaces.
        const _rawVal = (_dlgWexpr && _dlgWexpr.value) ? String(_dlgWexpr.value) : '';
        if (_dlgWexpr && (_dlgWexpr.type === 'string' || _dlgWexpr.type === 'symbol') &&
                !_rawVal.includes('Failed') && !_rawVal.includes('$Failed')) {
            _dlgTmpFile = _tmpFile;  // use our JS-computed path directly
            scrollLog('[subsession-dlg] Export succeeded, using JS path:', _dlgTmpFile);
        } else if (_dlgWexpr && _dlgWexpr.error) {
            _dlgEvalError = _dlgWexpr.error;
            scrollLog('[subsession-dlg] WExpr error:', _dlgEvalError);
        } else {
            _dlgEvalError = 'Export returned: ' + JSON.stringify(_dlgWexpr);
            scrollLog('[subsession-dlg] Export failed:', _dlgEvalError);
        }
    } catch (_err) {
        _dlgEvalError = _err.message;
        scrollLog('[subsession-dlg] dialogEval threw:', _dlgEvalError);
    }

    const _dlgPrintLines = [...dialogPrintLines];
    self._dialogPrintCollector = null;

    // Step 2: Exit dialog immediately — main kernel resumes.
    // Subkernel render runs independently after this.
    try { await self.session.exitDialog(); } catch (_) {}
    scrollLog('[subsession-dlg] exitDialog() done');

    // Step 3: Render via the subkernel — full VsCodeRenderExpr pipeline
    // (SVG/PNG graphics, WLLatex, MathML, etc.) identical to normal evaluation.
    const _subsBadge =
        '<span style="font-size:9px;color:#e8a020;background:rgba(232,160,32,0.12);' +
        'border:1px solid rgba(232,160,32,0.35);border-radius:3px;padding:1px 5px;' +
        'margin-right:6px;font-style:italic;">subsession</span>';

    const parts = [];

    if (_dlgPrintLines.length > 0) {
        const printHtml = _dlgPrintLines.map(line => {
            const text = self.decodeWolframOctal(line.replace(/\\012/g, '\n'));
            return '<pre class="vscode-wolfram-print-output">' + self.escapeHtml(text) + '</pre>';
        }).join('');
        parts.push(printHtml);
    }

    if (_dlgEvalError || _dlgTmpFile === null) {
        const _errMsg = _dlgEvalError || 'dialog eval returned no result';
        parts.push(
            '<div style="display:flex;align-items:baseline;gap:4px;padding:3px 0">' +
            _subsBadge +
            '<span style="font-size:10px;color:#e8a020;margin-right:8px;">Out=</span>' +
            '<span style="color:#f44747;font-family:Consolas,monospace;font-size:13px;">' +
            self.escapeHtml(_errMsg) + '</span></div>'
        );
    } else {
        let _renderHtml  = null;
        let _renderError = null;
        try {
            const _subKern = await self._ensureSubKernel(_subImgDir, _subImgRel);
            // Import the .mx file — binary WL expression, no encoding issues.
            const _subExpr = 'VsCodeRenderExpr[Import["' + _dlgTmpFile +
                '"], "' + _dlgFormat + '", ' + _dlgScale + ']';
            scrollLog('[subsession-render] tmp file:', _dlgTmpFile);
            scrollLog('[subsession-render] VsCodeRenderExpr call:', _subExpr);
            const _renderResult = await _subKern.evaluate(_subExpr, { interactive: false });
            scrollLog('[subsession-render] result type:', _renderResult?.result?.type,
                      '| value length:', _renderResult?.result?.value?.length ?? 'n/a',
                      '| messages:', JSON.stringify(_renderResult?.messages ?? []));
            // Clean up temp file regardless of render result.
            try { require('fs').unlinkSync(_dlgTmpFile); } catch (_) {}
            if (_renderResult && _renderResult.result &&
                    _renderResult.result.type === 'string' && _renderResult.result.value) {
                _renderHtml = self._processWLLatexBoxes(
                    self._fixImageUris(_renderResult.result.value)
                );
            } else {
                _renderError = 'subkernel render returned no HTML — result: ' +
                    JSON.stringify(_renderResult?.result);
                scrollLog('[subsession-render] NO HTML:', _renderError);
            }
        } catch (_re) {
            _renderError = _re.message;
            scrollLog('[subsession-render] threw:', _renderError);
        }

        const _headerLabel =
            _subsBadge +
            '<span style="font-size:10px;color:#888;margin-right:8px;">Out=</span>';

        if (_renderHtml) {
            const _headerRow =
                '<div class="wl-output-header" style="display:flex;align-items:center;' +
                'gap:6px;width:100%;min-height:22px;" data-session-epoch="' + self._sessionEpoch + '">' +
                _headerLabel + '</div>';
            parts.push(
                '<div class="wl-output-block">' + _headerRow +
                '<div class="wl-output-content">' + _renderHtml + '</div></div>'
            );
        } else {
            // Subkernel render failed — InputForm text fallback.
            const _errNote = _renderError
                ? '<div style="color:#FFA500;font-size:11px;margin:0 0 2px;">Render failed (' +
                  self.escapeHtml(_renderError) + ') — showing InputForm</div>'
                : '';
            parts.push(
                '<div style="padding:3px 0">' +
                '<div style="display:flex;align-items:baseline;gap:4px;margin-bottom:2px;">' +
                _headerLabel + '</div>' +
                _errNote +
                '<pre class="vscode-wolfram-text-output" style="white-space:pre-wrap;' +
                'overflow-wrap:break-word;margin:0;">' +
                self.escapeHtml('(tmp file: ' + (_dlgTmpFile || 'none') + ')') + '</pre></div>'
            );
        }
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
    if (prev) prev.active = false;
    const state = { active: true };
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

    // Prewarm the render subkernel as soon as the first Dynamic widget is registered
    // so init.wl is already loaded by the time the first Dialog render happens.
    self._prewarmSubKernel();

    // Snapshot of all cell outputs (preserves static-slot outputs across updates).
    if (!self._dynCells) self._dynCells = new Map();
    const snapOutputs = Array.from(cell.outputs);
    self._dynCells.set(cellUri, { cell, outputs: snapOutputs });

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
                    : '⏳ Dynamic' + badgeExtra + ' — start a computation to see live updates';
        return '<span style="font-size:9px;color:' + color + ';background:' + bg + ';' +
               'border:1px solid ' + bd + ';border-radius:3px;padding:1px 6px;' +
               'margin-right:6px;font-style:italic;">' + label + '</span>';
    };

    // Update all Dynamic slot outputs in a single createNotebookCellExecution call.
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
                        : '<div style="color:#888;font-style:italic;font-size:12px;padding:4px 0;">Waiting for computation…</div>';
                    const newItem = vscode.NotebookCellOutputItem.text(
                        '<div data-dynamic="1" data-epoch="' + epoch + '">'
                        + '<div style="display:flex;align-items:center;padding:2px 0 4px;">'
                        + _badge(_slotStatus, de) + '</div>' + body + '</div>',
                        'x-application/wolfram-language-html'
                    );
                    // TODO-1g: expose Dynamic current value to Copilot as text/plain
                    const _dynPlainEarly = html
                        ? (_output.extractPlainText(html, 'Dynamic[' + de.dynInner + '] =', false, cell.document.getText()) || ('(* Dynamic[' + de.dynInner + '] *)'))
                        : ('(* Dynamic[' + de.dynInner + '] — waiting for computation *)');
                    const newPlainItem = vscode.NotebookCellOutputItem.text(_dynPlainEarly, 'text/plain');
                    try {
                        await ownedExec.exec.replaceOutputItems([newItem, newPlainItem], snapOutputs[de.slotIndex]);
                    } catch (_roe) { /* execution may have ended — silently ignore */ }
                }
                return;
            }
            const exe = self._controller.createNotebookCellExecution(cell);
            exe.start(t);
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
                    : '<div style="color:#888;font-style:italic;font-size:12px;padding:4px 0;">Waiting for computation…</div>';
                // TODO-1g: expose Dynamic current value to Copilot as text/plain
                const _dynPlain = html
                    ? (_output.extractPlainText(html, 'Dynamic[' + de.dynInner + '] =', false, cell.document.getText()) || ('(* Dynamic[' + de.dynInner + '] *)'))
                    : ('(* Dynamic[' + de.dynInner + '] — waiting for computation *)');
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
            await exe.replaceOutput(snap);
            exe.end(true, t);
        } catch (e) { scrollLog('[dyn] _putAllOutputs error:', e.message); }
    };

    // _clearOneSlot(slotIdx): blank ONE Dynamic slot output without touching other slots.
    // Reads cell.outputs fresh to pick up Print/static outputs written since the last
    // _putAllOutputs, syncs snapOutputs, then replaces only the expired slot with empty.
    const _clearOneSlot = async (slotIdx) => {
        if (self._sessionEpoch !== epoch) return;
        if (ownedExec && ownedExec.active) return; // can't open a new execution during early-start
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
            const _cExe = self._controller.createNotebookCellExecution(cell);
            _cExe.start(Date.now()); await _cExe.replaceOutput(snap); _cExe.end(true, Date.now());
        } catch (_) {}
    };

    // Show initial waiting badge.
    _putAllOutputs({}, 'waiting');

    const runLoop = async () => {
        let cycle = 0;
        const htmlBySlot     = {}; // last rendered html per slot — shown with 'paused' badge when idle
        const lastHtmlBySlot = {}; // raw htmlStr from subkernel — used to skip unchanged renders
        let lastBusy = false; // track busy→idle transition to avoid repeated executions
        // _lastIdleRenderEpoch: the _dispatchEpoch value at the time of the last idle render.
        // null = never rendered yet (always do the first render).
        // Non-null: skip idle render unless _dispatchEpoch has advanced (meaning a new
        // evaluation has been dispatched — completed OR currently running — since last render).
        let _lastIdleRenderEpoch = null;
        // _lastBadgeTickTime: timestamp of last badge-only refresh (for LiveTime countdown).
        // Used to tick the timer display once per second even when slot content hasn't changed.
        let _lastBadgeTickTime = 0;
        // Safety counter: tracks how many consecutive interrupt cycles got no dialog.
        // When >= 1 we know the kernel is inside Pause[N] or a C++ compute-bound
        // section that ignores WSInterruptMessage.  Sending another interrupt while
        // Pause is about to end causes a WSTP-level deadlock where dialogEval AND
        // exitDialog both hang indefinitely (confirmed in test_pause_interrupt.js P6).
        // We back off and wait for the evaluation to end naturally instead.
        let _consecutiveNoDialog = 0;
        // abort() clears Internal`AddHandler["Interrupt",...] on the kernel side
        // (confirmed by WSTP regression test P5).  After any abort(), we must
        // reinstall the handler before the next interrupt attempt, otherwise
        // interrupt() fires but no Dialog[] opens and all subsequent cycles are dead.
        // _reinstallPromise tracks the in-flight sub() reinstall so we can await it.
        let _handlerNeedsReinstall = false;
        let _reinstallPromise = Promise.resolve();
        // Counts consecutive cycles where isDialogOpen=true in the pre-mutex guard.
        // If a stale dialog is stuck open (e.g. exitDialog resolved for level-2→1 but
        // level 1 was never closed), every cycle spins here forever.  After 10 cycles
        // (~2 s) we force-abort to break the deadlock.
        let _staleDialogCycles = 0;
        while (true) {
            cycle++;
            if (!state.active || self._sessionEpoch !== epoch) {
                scrollLog('[dyn] cell loop exit | cycle:', cycle);
                self._dynamicWidgets.delete(cellUri);
                // Clear cell output immediately so stale Dynamic content doesn't
                // linger after kernel restart — don't rely on launchKernel timing.
                try {
                    const _exitExe = self._controller.createNotebookCellExecution(cell);
                    _exitExe.start(Date.now());
                    await _exitExe.replaceOutput([]);
                    _exitExe.end(true, Date.now());
                } catch (_) {}
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
                self._dynamicWidgets.delete(cellUri);
                return;
            }

            scrollLog('[dyn] cycle', cycle, '| busy:', busy, '| dlgOpen:', self.session?.isDialogOpen, '| dispatched:', self._evalDispatched, '| cND:', _consecutiveNoDialog, '| stale:', _staleDialogCycles, '| evalsSince:', _evalsSinceStart);

            if (!busy) {
                // Recovery: if a dialog was left open after evaluation ended
                // (e.g. exitDialog failed mid-cycle), kernel is frozen — close it.
                if (self.session?.isDialogOpen) {
                    scrollLog('[dyn] idle but dlgOpen=true — acquiring mutex for recovery exitDialog');
                    let _releaseRec;
                    const _prevRec = self._dynDialogMutex;
                    self._dynDialogMutex = new Promise(r => _releaseRec = r);
                    await _prevRec;
                    try {
                        if (self.session?.isDialogOpen) {
                            scrollLog('[dyn] idle recovery: calling closeAllDialogs');
                            self.session.closeAllDialogs?.();
                            await new Promise(r => setTimeout(r, 300));
                        }
                    } finally {
                        _releaseRec();
                    }
                    continue;
                }

                // ---- Idle-eval path ----
                // When nothing is running, evaluate Dynamic slots directly via sub().
                // Serialized via _dynIdleMutex — only ONE cell loop calls sub() at a
                // time: concurrent sub() calls stack on the WSTP link and all time out.
                // Skip if dialog is open (recovery block above handles that).
                // Also skip if no new evaluation has been dispatched since the last
                // idle render — nothing could have changed in the kernel state.
                const _queueEmpty = self.executionQueue.queue.length === 0;
                const _epochUnchanged = _lastIdleRenderEpoch !== null
                    && self._dispatchEpoch === _lastIdleRenderEpoch;
                if (_queueEmpty && !self._abortPending && !self.session.isDialogOpen
                        && !_epochUnchanged
                        && (Date.now() - (self._dynLastIdleRender || 0)) > 1000) {
                    // Acquire global idle mutex.
                    if (!self._dynIdleMutex) self._dynIdleMutex = Promise.resolve();
                    let _releaseIdle;
                    const _prevIdle = self._dynIdleMutex;
                    self._dynIdleMutex = new Promise(r => _releaseIdle = r);
                    await _prevIdle;
                    // Re-check after acquiring — another loop may have just fired.
                    if (!state.active || self._sessionEpoch !== epoch
                            || self.executionQueue.queue.length > 0
                            || self._abortPending || self.session.isDialogOpen
                            || (Date.now() - (self._dynLastIdleRender || 0)) < 800) {
                        _releaseIdle();
                        await new Promise(r => setTimeout(r, 300));
                        continue;
                    }
                    // Pre-flight: always close any stale dialog before sub().
                    self.session.closeAllDialogs?.();
                    self._dynLastIdleRender = Date.now();
                    const scale = Number(self.config?.get?.('imageScale') ?? 0.8) || 0.8;
                    const idlePending = {};
                    try {
                        for (const de of dynExprs) {
                            if (!state.active || self._sessionEpoch !== epoch) break;
                            const escaped = de.dynInner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                            const expr = 'VsCodeDynExportValue["' + escaped + '"]';
                            dynLog('IDLE-SEND | cycle', cycle, '| slot', de.slotIndex);
                            try {
                                const res = await Promise.race([
                                    self.session.sub(expr),
                                    new Promise((_, rej) => setTimeout(() => rej(new Error('idle-sub timeout 3s')), 3000))
                                ]);
                                const _rv = res?.value;
                                if (typeof _rv === 'string' && _rv.startsWith('WLVAL:FILE:')) {
                                    const tmpFile = _rv.slice('WLVAL:FILE:'.length)
                                        .replace(/\\012/g, '').replace(/\\015/g, '')
                                        .replace(/[^a-zA-Z0-9/_.-]/g, '');
                                    idlePending[de.slotIndex] = tmpFile;
                                }
                            } catch(_idleErr) {
                                dynLog('IDLE-SEND-ERR | cycle', cycle, '| slot', de.slotIndex, '|', _idleErr.message);
                            }
                        }
                    } finally { _releaseIdle(); }
                    if (Object.keys(idlePending).length > 0) {
                        let _anyIdleChanged = false;
                        try {
                            const _subKern = await self._ensureSubKernel(imgDir, imgRel);
                            for (const [slotIdxStr, tmpFile] of Object.entries(idlePending)) {
                                const slotIdx = Number(slotIdxStr);
                                const fileEsc = tmpFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                                const renderExpr = 'Module[{dynVal=Import["' + fileEsc + '"]},VsCodeRenderExpr[dynVal,"Auto",' + scale + ']]';
                                try {
                                    const renderRes = await _subKern.sub(renderExpr);
                                    const htmlStr = renderRes?.value;
                                    if (typeof htmlStr === 'string' && htmlStr.length > 0) {
                                        dynLog('IDLE-RENDER-OK | cycle', cycle, '| slot', slotIdx, '| htmlLen:', htmlStr.length,
                                               '| changed:', htmlStr !== lastHtmlBySlot[slotIdx]);
                                        if (htmlStr !== lastHtmlBySlot[slotIdx]) {
                                            lastHtmlBySlot[slotIdx] = htmlStr;
                                            htmlBySlot[slotIdx] = self._processWLLatexBoxes(self._fixImageUris(htmlStr));
                                            _anyIdleChanged = true;
                                        }
                                    }
                                } catch(_) {
                                } finally {
                                    try { require('fs').unlinkSync(tmpFile); } catch(_) {}
                                }
                            }
                        } catch(_subErr) {
                            dynLog('IDLE-SUBKERN-ERR | cycle', cycle, '|', _subErr.message);
                        }
                        // Redraw if value changed, OR if LiveTime is set (need to refresh
                        // the countdown even when the slot value is the same).
                        if (_anyIdleChanged || (isFinite(liveTimeSec) && !_isExpired)) {
                            _lastBadgeTickTime = Date.now();
                            await _putAllOutputs(htmlBySlot, 'live');
                        }
                    }
                    // Record the epoch we just rendered at — suppress further idle
                    // renders until a new evaluation is dispatched.
                    _lastIdleRenderEpoch = self._dispatchEpoch;
                    lastBusy = false;
                    await new Promise(r => setTimeout(r, 800));
                    continue;
                }

                // Only update output once on the busy→idle transition.
                // Do NOT call createNotebookCellExecution every 300ms — VS Code
                // treats each call as a cell execution and spams the output area.
                if (lastBusy) {
                    // Evaluation finished — clear cached values and show "waiting".
                    // Do NOT show last-rendered values with a "paused" badge:
                    // those values belonged to the now-finished computation.
                    for (const k of Object.keys(htmlBySlot)) delete htmlBySlot[k];
                    await _putAllOutputs({}, 'waiting');
                }
                lastBusy = false;
                // LiveTime countdown tick: refresh badge every ~1 s on the idle path
                // so the displayed countdown decreases monotonically even when the
                // slot value hasn't changed (i.e. _anyIdleChanged was false).
                // Use per-slot check: tick if any slot with LiveTime is still active.
                const _anyLiveTimeActive = dynExprs.some((de, _i) => de.dynLiveTime != null && !_slotExpired[_i]);
                if (_anyLiveTimeActive
                        && (Date.now() - _lastBadgeTickTime) >= 950) {
                    _lastBadgeTickTime = Date.now();
                    await _putAllOutputs(htmlBySlot, 'live');
                }
                await new Promise(r => setTimeout(r, 300));
                continue;
            }
            // Reset the no-dialog backoff counter when a fresh busy period begins.
            if (!lastBusy) {
                if (_consecutiveNoDialog > 0) scrollLog('[dyn] cycle', cycle, '| fresh busy period — resetting cND:', _consecutiveNoDialog, '→ 0');
                _consecutiveNoDialog = 0;
            }
            lastBusy = true;
            // If the LiveEvaluations or LiveCells limit has already been reached,
            // do NOT interrupt — let the computation finish undisturbed.
            // The expiry check in the !busy block fires once the queue drains.
            // Show the red ⊘ expired badge once on first entry so the user knows
            // the limit was hit and no more updates are coming.
            if (isFinite(liveEvalLimit) && _evalsSinceStart >= liveEvalLimit) {
                if (!_isExpired) {
                    scrollLog('[dyn] busy-path: LiveEvaluations limit reached, showing expired badge');
                    _markExpired();
                    await _putAllOutputs(htmlBySlot, 'expired');
                }
                await new Promise(r => setTimeout(r, 300)); continue;
            }
            if (isFinite(liveCellLimit) && _cellsSinceStart >= liveCellLimit) {
                if (!_isExpired) {
                    scrollLog('[dyn] busy-path: LiveCells limit reached, showing expired badge');
                    _markExpired();
                    await _putAllOutputs(htmlBySlot, 'expired');
                }
                await new Promise(r => setTimeout(r, 300)); continue;
            }
            // Gate: only send interrupt() once the kernel is actually computing.
            // _evalDispatched is set true after _dynIdleMutex resolves (just before
            // the first session.evaluate() call). Before that, queue[0].started is
            // already true but the kernel is still idle — interrupt() on an idle
            // kernel corrupts the WSTP link ("WSGet out of sequence").
            if (!self._evalDispatched) {
                await new Promise(r => setTimeout(r, 100)); continue;
            }

            // Skip this cycle if the kernel is actively rendering (ExportString/SVG).
            // Sending an interrupt now would abort ExportString mid-call and corrupt
            // the SVG pipeline state. Just wait and retry next cycle.
            if (self._renderingActive) {
                await new Promise(r => setTimeout(r, 150));
                continue;
            }

            // Skip if dialog is already open — don't interrupt, just wait.
            // Fast path: if consecutiveNoDialog >= 1 and a dialog opens, this is
            // the DEFERRED interrupt (sent earlier, fired late after Pause[N] ended).
            // Exit it immediately to let the cell continue — do NOT abort.
            // Watchdog: if this has been true for >= 10 consecutive 200 ms cycles
            // (~2 s) the dialog is stale (exitDialog closed level-2→1 but level-1
            // was never closed, or abort() left residual state).  Force-abort to
            // break the deadlock rather than spinning forever.
            if (self.session.isDialogOpen) {
                if (_consecutiveNoDialog >= 1) {
                    // Deferred-interrupt dialog: we sent an interrupt earlier that
                    // Pause[] didn't open right away — it fired after Pause ended.
                    // Close it cleanly so the cell's next expression can complete.
                    scrollLog('[dyn] cycle', cycle, '| deferred-dialog detected (cND:', _consecutiveNoDialog, ') — calling exitDialog to unblock cell');
                    const _t_dd = Date.now();
                    try {
                        await Promise.race([
                            self.session.exitDialog(),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('deferred-dlg-timeout')), 2000))
                        ]);
                        scrollLog('[dyn] cycle', cycle, '| deferred-dialog exitDialog done | dlgOpen after:', self.session.isDialogOpen, '| dt:', Date.now() - _t_dd, 'ms');
                        if (!self.session.isDialogOpen) _consecutiveNoDialog = 0;
                    } catch (e) {
                        scrollLog('[dyn] cycle', cycle, '| deferred-dialog exitDialog failed:', e.message, '| dlgOpen after:', self.session.isDialogOpen);
                    }
                    await new Promise(r => setTimeout(r, 200));
                    continue;
                }
                scrollLog('[dyn] cycle', cycle, '| pre-mutex dlgOpen=true | staleCount now:', _staleDialogCycles + 1, '| cND:', _consecutiveNoDialog);
                _staleDialogCycles++;
                if (_staleDialogCycles >= 10) {
                    _staleDialogCycles = 0;
                    scrollLog('[dyn] cycle', cycle, '| stale dialog (10 cycles) — force-abort to recover | cND was:', _consecutiveNoDialog);
                    try { self.session.abort(); } catch(_) {}
                    _handlerNeedsReinstall = true;
                    _reinstallPromise = self.session.sub?.(
                        'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]'
                    ).then(() => {
                        _handlerNeedsReinstall = false;
                        scrollLog('[dyn] interrupt handler reinstalled after stale-dialog abort');
                    }).catch(e => {
                        _handlerNeedsReinstall = false;
                        scrollLog('[dyn] stale-dialog reinstall failed:', e.message);
                    }) ?? Promise.resolve();
                    const _tsd = Date.now();
                    while (self.session.isDialogOpen && Date.now() - _tsd < 3000)
                        await new Promise(r => setTimeout(r, 50));
                }
                await new Promise(r => setTimeout(r, 200));
                continue;
            }
            _staleDialogCycles = 0;

            // ---- Global dialog mutex: serialises interrupt+dialogEval+exitDialog ----
            // across ALL concurrent Dynamic cell loops so two loops never send competing
            // interrupts and open nested Dialog[] sessions simultaneously.
            let _releaseDlg;
            const _prevDlg = self._dynDialogMutex;
            self._dynDialogMutex = new Promise(r => _releaseDlg = r);
            // Snapshot the dispatch epoch BEFORE yielding — if the epoch changes while
            // we await the mutex the current evaluation ended (and possibly a new one
            // started) so we must NOT send interrupt() to whoever is running now.
            const _epochBeforeMutex = self._dispatchEpoch;
            await _prevDlg;

            // Re-check after acquiring lock (another loop may have just used the dialog).
            if (!state.active || self._sessionEpoch !== epoch) { _releaseDlg(); continue; }
            // Abort is pending — release immediately so abort can proceed cleanly.
            if (self._abortPending) { scrollLog('[dyn] cycle', cycle, '| abort pending — skip'); _releaseDlg(); continue; }
            // Rendering started while we were waiting on the mutex — release and retry.
            if (self._renderingActive) { _releaseDlg(); await new Promise(r => setTimeout(r, 150)); continue; }
            if (self.session.isDialogOpen) { _releaseDlg(); await new Promise(r => setTimeout(r, 200)); continue; }
            // KEY RACE FIX: the evaluation that was running when we queued for the mutex
            // may have finished and a NEW cell may have started while we were waiting.
            // Re-check _evalDispatched: if it is false, no cell is executing right now —
            // sending interrupt() would hit the idle kernel and corrupt the WSTP link.
            if (!self._evalDispatched) {
                scrollLog('[dyn] cycle', cycle, '| evalDispatched=false after mutex — skip interrupt');
                _releaseDlg();
                await new Promise(r => setTimeout(r, 200));
                continue;
            }
            // Also check epoch: even if dispatched=true, it may belong to a NEW cell
            // (old cell ended, new cell started, epoch bumped). Interrupting the new
            // cell's first expression would be equally wrong.
            if (self._dispatchEpoch !== _epochBeforeMutex) {
                scrollLog('[dyn] cycle', cycle, '| epoch changed while awaiting mutex (',
                          _epochBeforeMutex, '->', self._dispatchEpoch, ') — skip interrupt');
                _releaseDlg();
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            // SAFETY guard: if the previous interrupt was silently swallowed (no
            // dialog opened within 2500ms), do NOT immediately retry.  Retrying while
            // the kernel is inside Pause[N]→completion transition triggers an
            // irrecoverable WSTP deadlock (test_pause_interrupt.js P3/P6).
            // Instead, wait for the eval to finish naturally (the !busy path).
            if (_consecutiveNoDialog >= 1) {
                scrollLog('[dyn] cycle', cycle, '| consecutiveNoDialog:', _consecutiveNoDialog,
                          '— skipping interrupt | epoch:', self._dispatchEpoch, '| evalsSince:', _evalsSinceStart);
                _releaseDlg();
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            // Handler reinstall may be in flight after a previous abort().
            // Wait for it to complete before attempting the next interrupt —
            // otherwise we interrupt with no handler and the dialog never opens.
            if (_handlerNeedsReinstall) {
                _releaseDlg();
                scrollLog('[dyn] cycle', cycle, '| handler reinstall pending — awaiting before next interrupt');
                await _reinstallPromise;
                if (!state.active || self._sessionEpoch !== epoch) continue;
                // One-cycle pause so the kernel can register the new handler.
                await new Promise(r => setTimeout(r, 300));
                continue;
            }

            let gotIdxs = [];
            let pendingValues = {}; // slotIndex → FullForm string (populated inside Dialog[])
            const scale = Number(self.config?.get?.('imageScale') ?? 0.8) || 0.8;
            // Busy-gone watcher: rejects dialogEval immediately when main evaluation
            // finishes mid-cycle so we never hang for the full 8s timeout.
            let _busyWatcher = null;
            let _busyGoneReject = null;
            const _busyGoneProm = new Promise((_, rej) => { _busyGoneReject = rej; });
            try {
            // ---- Single interrupt. Wait up to 2500ms — NO retry interrupt. ----
            // Pre-flight closeAllDialogs: isDialogOpen is often stale. Reset
            // any stale dialog state before the interrupt so the C++ state is clean.
            self.session.closeAllDialogs?.();
            const sent = self.session.interrupt();
            scrollLog('[dyn] cycle', cycle, '| interrupt sent:', sent, '| epoch:', self._dispatchEpoch, '| evalsSince:', _evalsSinceStart);
            if (!sent) { await new Promise(r => setTimeout(r, 500)); continue; }

            const t1 = Date.now();
            while (!self.session.isDialogOpen && Date.now() - t1 < 2500)
                await new Promise(r => setTimeout(r, 25));
            const dlgOpen = self.session.isDialogOpen;
            scrollLog('[dyn] cycle', cycle, '| dlgOpen:', dlgOpen, '| waited:', Date.now() - t1, 'ms');
            if (!dlgOpen) {
                // Dialog never opened — kernel is inside Pause[N] or a compute-bound
                // section that ignores WSInterruptMessage.  Increment backoff counter
                // so the next cycle skips the interrupt entirely and just waits.
                _consecutiveNoDialog++;
                scrollLog('[dyn] cycle', cycle, '| no dialog — consecutiveNoDialog:', _consecutiveNoDialog,
                          '(will skip interrupt next cycle until eval ends)');
                self.session.closeAllDialogs?.();
                await new Promise(r => setTimeout(r, 300)); continue;
            }
            // Dialog opened — reset backoff counter.
            _consecutiveNoDialog = 0;

            // Start watcher now (dialog is confirmed open).
            _busyWatcher = setInterval(() => {
                const _stillBusy = !self._abortPending &&
                    self.executionQueue.queue.length > 0 && self.executionQueue.queue[0].started;
                if (!_stillBusy) { clearInterval(_busyWatcher); _busyWatcher = null; _busyGoneReject(new Error('busy-lost')); }
            }, 150);

            // ---- Evaluate each Dynamic slot: export evaluated value to .mx temp file ----
            // VsCodeDynExportValue["exprString"] evaluates the expression inside Dialog[]
            // (where Do-loop variables like n are visible) and exports the CONCRETE result
            // (e.g. a fully-built Graphics[...]) to a temp .mx file.
            // IMPORTANT: NO CheckAbort wrapper — inside Dialog[] after an interrupt,
            // CheckAbort traps the active abort flag and returns $Failed immediately
            // before any expression is evaluated. The subsession (⌥⇧↵) uses the same
            // approach and is proven correct.
            // After exitDialog(), the file is imported on _subKernel (separate process)
            // and rendered via VsCodeRenderExpr — full SVG/MathML, no context needed.
            for (let i = 0; i < dynExprs.length; i++) {
                const de      = dynExprs[i];
                const escaped = de.dynInner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                const expr    = 'VsCodeDynExportValue["' + escaped + '"]';
                dynLog('SEND | cycle', cycle, '| slot', de.slotIndex, '| expr:', de.dynInner.slice(0, 60));
                try {
                    const res = await Promise.race([
                        self.session.dialogEval(expr),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000)),
                        _busyGoneProm,
                    ]);
                    const _rv = res?.value;
                    dynLog('RECV | cycle', cycle, '| slot', de.slotIndex,
                           '| type:', res?.type, '| len:', String(_rv).length,
                           '| starts:', String(_rv).slice(0, 80));
                    if (res && !res.error && typeof _rv === 'string' && _rv.startsWith('WLVAL:FILE:')) {
                        // WSTP text-mode inserts ' \012>   ' line-continuation into long strings.
                        // Step 1: strip the 4-char WSTP escape literals \012 \015 (else their
                        //         digits '012' survive the path-char filter below).
                        // Step 2: strip all non-path characters (space, >, \, etc.)
                        const tmpFile = _rv.slice('WLVAL:FILE:'.length)
                            .replace(/\\012/g, '').replace(/\\015/g, '')
                            .replace(/[^a-zA-Z0-9/_.-]/g, '');
                        dynLog('WLVAL-FILE | cycle', cycle, '| slot', de.slotIndex,
                               '| cleanPath:', tmpFile);
                        pendingValues[de.slotIndex] = tmpFile;
                        gotIdxs.push(i);
                    } else if (res && !res.error && typeof _rv === 'string' && _rv === 'WLVAL:FAILED') {
                        dynLog('WLVAL-FAILED | cycle', cycle, '| slot', de.slotIndex);
                        // Keep previous output — expression returned $Failed (e.g. n not yet set).
                    } else if (res && !res.error && typeof _rv === 'string' && _rv.length > 0) {
                        dynLog('RAW-FALLBACK | cycle', cycle, '| slot', de.slotIndex,
                               '| raw[0..120]:', _rv.slice(0, 120));
                        const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                        htmlBySlot[de.slotIndex] =
                            '<pre style="margin:0;padding:4px 0;font-size:12px;color:#c00;' +
                            'font-family:monospace;white-space:pre-wrap;">'
                            + '⚠ restart kernel to load VsCodeDynExportValue\n\n'
                            + _esc(_rv.slice(0, 500)) + '</pre>';
                        gotIdxs.push(i);
                    } else {
                        dynLog('NULL/ERR | cycle', cycle, '| slot', de.slotIndex,
                               '| res:', JSON.stringify(res)?.slice(0, 120));
                    }
                } catch (e) {
                    if (e.message === 'busy-lost') {
                        dynLog('BUSY-LOST | cycle', cycle, '| slot', de.slotIndex, '— eval ended mid-dialog, closing dialog');
                    } else {
                        dynLog('THROW | cycle', cycle, '| slot', de.slotIndex, '| err:', e.message);
                        scrollLog('[dyn] cycle', cycle, '| slot', de.slotIndex, '| dialogEval error:', e.message);
                    }
                    break;  // don't try remaining slots
                }
            }

            // ---- Exit dialog — retry up to 5 times if it hangs or only partially closes. ----
            // IMPORTANT: exitDialog() can resolve without timeout AND yet the dialog is
            // still open when the kernel is at Dialog level 2 (nested after a previous
            // abort): exitDialog closes level 2 → level 1, returning successfully, but
            // isDialogOpen is still true.  We must check isDialogOpen after each call
            // and keep retrying until the dialog is genuinely closed.
            let exited = false;
            scrollLog('[dyn] cycle', cycle, '| exitDialog loop start (up to 5 attempts) | dlgOpen:', self.session.isDialogOpen);
            for (let attempt = 0; attempt < 5 && !exited; attempt++) {
                const _t_ed = Date.now();
                try {
                    await Promise.race([
                        self.session.exitDialog(),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('exitDialog timeout')), 2000))
                    ]);
                    // exitDialog resolved — but it may have only closed one level.
                    // Check whether the dialog is genuinely closed now.
                    await new Promise(r => setTimeout(r, 30));
                    if (!self.session.isDialogOpen) {
                        exited = true;
                        scrollLog('[dyn] cycle', cycle, '| exitDialog attempt', attempt + 1, 'succeeded | dt:', Date.now() - _t_ed, 'ms');
                    } else {
                        scrollLog('[dyn] cycle', cycle, '| exitDialog attempt', attempt + 1,
                                  '— resolved but dialog still open (nested level), retrying | dt:', Date.now() - _t_ed, 'ms');
                    }
                } catch (e) {
                    scrollLog('[dyn] cycle', cycle, '| exitDialog attempt', attempt + 1, 'failed:', e.message, '| dt:', Date.now() - _t_ed, 'ms');
                }
            }
            // All exitDialog attempts failed — the kernel is stuck inside Dialog[]
            // (e.g. ExportString/Rasterize is still running). Abort the kernel to
            // forcibly terminate the stuck computation and release the WSTP link.
            if (!exited) {
                dynLog('ABORT | cycle', cycle, '| exitDialog failed 5 times — aborting kernel');
                try { self.session.abort(); } catch(_) {}
                // abort() clears Internal`AddHandler["Interrupt",...] on the kernel.
                // Schedule handler reinstall via sub() — runs after the aborted eval
                // finishes ($Aborted response) and before any queued evaluate() calls.
                _handlerNeedsReinstall = true;
                _reinstallPromise = self.session.sub?.(
                    'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]'
                ).then(() => {
                    _handlerNeedsReinstall = false;
                    scrollLog('[dyn] interrupt handler reinstalled after abort');
                }).catch(e => {
                    _handlerNeedsReinstall = false;
                    scrollLog('[dyn] handler reinstall failed:', e.message);
                }) ?? Promise.resolve();
                // Wait up to 3s for the dialog to close post-abort.
                const _ta = Date.now();
                while (self.session.isDialogOpen && Date.now() - _ta < 3000)
                    await new Promise(r => setTimeout(r, 50));
                dynLog('ABORT-WAIT | cycle', cycle, '| dlgOpen after abort:', self.session.isDialogOpen, '| waited:', Date.now()-_ta, 'ms');
                // If the kernel is still stuck in Dialog[] after abort, we cannot
                // recover without a kernel restart.  Suspend the widget loop until
                // the session epoch changes (i.e. user restarts the kernel).
                if (self.session.isDialogOpen) {
                    dynLog('STUCK | cycle', cycle, '| kernel stuck — suspending widget loop until kernel restart');
                    await _putAllOutputs(htmlBySlot, 'paused');
                    // Spin until epoch changes (kernel restarted) then exit loop.
                    while (self._sessionEpoch === epoch && state.active)
                        await new Promise(r => setTimeout(r, 500));
                    return;  // exit runLoop
                }
            }

            const t2 = Date.now();
            while (self.session.isDialogOpen && Date.now() - t2 < 2000)
                await new Promise(r => setTimeout(r, 30));
            scrollLog('[dyn] cycle', cycle, '| dialog closed after', Date.now() - t2, 'ms | slots:', gotIdxs.length);
            // Last-resort: dialog still open after all exits + 2s wait — abort to prevent
            // the pre-mutex isDialogOpen guard from spinning forever on next cycles.
            if (self.session.isDialogOpen) {
                scrollLog('[dyn] cycle', cycle, '| dialog still open after t2 wait — aborting to prevent spin');
                try { self.session.abort(); } catch(_) {}
                _handlerNeedsReinstall = true;
                _reinstallPromise = self.session.sub?.(
                    'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]'
                ).then(() => {
                    _handlerNeedsReinstall = false;
                    scrollLog('[dyn] interrupt handler reinstalled after t2-abort');
                }).catch(e => {
                    _handlerNeedsReinstall = false;
                    scrollLog('[dyn] t2-abort reinstall failed:', e.message);
                }) ?? Promise.resolve();
                const _t2a = Date.now();
                while (self.session.isDialogOpen && Date.now() - _t2a < 3000)
                    await new Promise(r => setTimeout(r, 50));
            }

            // Brief pause so kernel resumes Do loop before next interrupt.
            await new Promise(r => setTimeout(r, 150));
            } finally {
                if (_busyWatcher) { clearInterval(_busyWatcher); _busyWatcher = null; }
                _releaseDlg();
            }

            if (!state.active || self._sessionEpoch !== epoch) continue;

            // ---- Render pending slot values on _subKernel ----
            // Dialog[] is now closed. pendingValues holds .mx temp file paths.
            // The _subKernel is a separate process — SVG export cannot block the main kernel.
            // This mirrors the subsession (⌥⇧↵) render path exactly.
            let _anyChanged = false;
            if (Object.keys(pendingValues).length > 0) {
                try {
                    const _subKern = await self._ensureSubKernel(imgDir, imgRel);
            for (const [slotIdxStr, tmpFile] of Object.entries(pendingValues)) {
                const slotIdx  = Number(slotIdxStr);
                const fileEsc  = tmpFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                const renderExpr = 'Module[{dynVal=Import["' + fileEsc + '"]},VsCodeRenderExpr[dynVal,"Auto",' + scale + ']]';
                dynLog('RENDER | cycle', cycle, '| slot', slotIdx,
                       '| tmpFile:', tmpFile,
                       '| renderExpr[0..80]:', renderExpr.slice(0, 80));
                try {
                    const renderRes = await _subKern.sub(renderExpr);
                    const htmlStr   = renderRes?.value;
                    if (typeof htmlStr === 'string' && htmlStr.length > 0) {
                        const _changed = htmlStr !== lastHtmlBySlot[slotIdx];
                        dynLog('RENDER-OK | cycle', cycle, '| slot', slotIdx,
                               '| htmlLen:', htmlStr.length,
                               '| changed:', _changed,
                               '| html[0..200]:', _changed ? htmlStr.slice(0, 200) : '(skipped)');
                        if (_changed) {
                            lastHtmlBySlot[slotIdx] = htmlStr;
                            htmlBySlot[slotIdx] = self._processWLLatexBoxes(
                                self._fixImageUris(htmlStr)
                            );
                            _anyChanged = true;
                        }
                            } else {
                                dynLog('RENDER-EMPTY | cycle', cycle, '| slot', slotIdx,
                                       '| res:', JSON.stringify(renderRes)?.slice(0, 80));
                            }
                        } catch (renderErr) {
                            dynLog('RENDER-ERR | cycle', cycle, '| slot', slotIdx, '|', renderErr.message);
                        } finally {
                            // Clean up temp file.
                            try { require('fs').unlinkSync(tmpFile); } catch (_) {}
                        }
                    }
                } catch (subKernErr) {
                    dynLog('SUBKERN-ERR | cycle', cycle, '|', subKernErr.message);
                }
            }

            // Only redraw if at least one slot actually changed this cycle.
            if (_anyChanged) await _putAllOutputs(htmlBySlot, 'live');
            scrollLog('[dyn] cycle', cycle, '| done | sleeping 500ms');
            await new Promise(r => setTimeout(r, 500));
        }
    };

    setTimeout(() => runLoop().catch(e => {
        scrollLog('[dyn] runLoop error:', e.message);
        // --- Safety cleanup: ensure a crash never leaves the kernel in a blocked state ---
        // Mark widget inactive so no further output writes happen.
        state.active = false;
        self._dynamicWidgets.delete(cellUri);
        // Close any Dialog[] the crashed cycle may have left open — a stuck dialog
        // blocks ALL future kernel evaluations until it is closed.
        try { self.session.closeAllDialogs?.(); } catch (_) {}
        // Release the dialog mutex so other widget loops (and new evaluations) can proceed.
        // A leaked mutex would deadlock every subsequent busy-path interrupt attempt.
        self._dynDialogMutex = Promise.resolve();
        // Reset idle mutex too — a leaked sub() hold would block checkoutExecutionQueue.
        self._dynIdleMutex = Promise.resolve();
        // Clear stale Dynamic HTML from the cell so the output area doesn't show
        // a permanently frozen '⟳ Dynamic' badge.
        try {
            const _errExe = self._controller.createNotebookCellExecution(cell);
            _errExe.start(Date.now());
            _errExe.replaceOutput([]).then(() => _errExe.end(true, Date.now())).catch(() => { try { _errExe.end(true, Date.now()); } catch(_){} });
        } catch (_) {}
    }), 250);
}

module.exports = {
    openDialogSubsession,
    splitTopLevelExprs,
    splitAtTopLevelCommas,
    startDynamicCell,
    wexprToInputForm,
};
