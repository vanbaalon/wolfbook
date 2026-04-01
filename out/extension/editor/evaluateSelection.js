'use strict';
/**
 * evaluateSelection.js — Evaluate Selection (Cmd+Shift+E)
 *
 * Evaluates the currently selected text in the editor, works both when
 * the kernel is idle and when it is busy (using subAuto → Dialog[]
 * mechanism, same as live-watch — no interrupt, running cell preserved).
 *
 * The result is rendered via VsCodeRenderExpr on the subkernel and
 * displayed inside the Watch panel's "EVAL SELECTION" section.
 */
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const { scrollLog } = require('../utils/dev-logger');

// Format options presented to the user
const FORMAT_OPTIONS = [
    { label: '$(symbol-string) LaTeX',           value: 'WLLatex',   description: 'LaTeX rendered with KaTeX (BTL)' },
    { label: '$(code) Source (InputForm)',        value: 'WLLatexSrc',description: 'Raw LaTeX / InputForm source' },
    { label: '$(file-media) SVG',                value: 'SVGSrc',    description: 'SVG image' },
    { label: '$(file-media) SVG (transparent)',   value: 'SVGT',      description: 'SVG text (non-rasterized)' },
];

let _currentFormat = 'WLLatex';
let _statusBarItem = null;
let _watchPanel    = null;   // WatchPanelProvider instance (set by register())
let _inFlight      = false;

// ── Status bar ──────────────────────────────────────────────────────────

function _createStatusBar(context) {
    _statusBarItem = vscode.window.createStatusBarItem(
        'wolfbook-eval-selection-format',
        vscode.StatusBarAlignment.Right,
        99
    );
    _statusBarItem.command = 'wolfbook.evaluateSelectionFormat';
    _updateStatusBar();
    context.subscriptions.push(_statusBarItem);

    // Only show when a wolfram notebook is active
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => _updateStatusBarVisibility()));
    context.subscriptions.push(vscode.window.onDidChangeActiveNotebookEditor(() => _updateStatusBarVisibility()));
    _updateStatusBarVisibility();
}

function _updateStatusBar() {
    const opt = FORMAT_OPTIONS.find(o => o.value === _currentFormat) || FORMAT_OPTIONS[0];
    _statusBarItem.text = '⚡ ' + opt.value;
    _statusBarItem.tooltip = 'Eval-Selection format: ' + opt.description + '\nClick to change';
}

function _updateStatusBarVisibility() {
    const nbEditor = vscode.window.activeNotebookEditor;
    if (nbEditor && nbEditor.notebook.notebookType === 'extended-wolfram-notebook') {
        _statusBarItem.show();
    } else {
        _statusBarItem.hide();
    }
}

// ── Format picker command ───────────────────────────────────────────────

async function _pickFormat() {
    const picked = await vscode.window.showQuickPick(
        FORMAT_OPTIONS.map(o => ({ ...o, picked: o.value === _currentFormat })),
        { title: 'Evaluate Selection — Output Format', placeHolder: 'Pick render format' }
    );
    if (picked) {
        _currentFormat = picked.value;
        _updateStatusBar();
        scrollLog('[eval-sel] format set:', _currentFormat);
    }
}

// ── Core evaluation logic ───────────────────────────────────────────────

async function evaluateSelection(getController) {
    // Get selected text
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage('No active editor.'); return; }
    const sel = editor.selection;
    if (sel.isEmpty) { vscode.window.showInformationMessage('Select code to evaluate.'); return; }
    const expr = editor.document.getText(sel).trim();
    if (!expr) { vscode.window.showInformationMessage('Selection is empty.'); return; }

    const ctrl = getController();
    if (!ctrl?.session) { vscode.window.showWarningMessage('No kernel. Launch the kernel first.'); return; }

    // Block during an active debug session — kernel is paused in Dialog[]
    if (ctrl._active) {
        vscode.window.showInformationMessage('Evaluate Selection is disabled during a debug session.');
        return;
    }

    if (_inFlight) {
        scrollLog('[eval-sel] skip — already in flight');
        vscode.window.showInformationMessage('Evaluation already in progress.');
        return;
    }
    _inFlight = true;

    // Save editor focus so we can restore it after showing the result.
    // This lets Ctrl+Shift+E be pressed multiple times in a row without
    // having to click back into the cell each time.
    const _savedTextEditor = vscode.window.activeTextEditor;
    const _savedSelection  = _savedTextEditor?.selection;
    const _savedViewColumn = _savedTextEditor?.viewColumn;

    // Reveal the watch panel so user sees the result
    vscode.commands.executeCommand('wolfbook.watchPanel.focus');
    _watchPanel.evalSelSpinner(expr);
    scrollLog('[eval-sel] start | expr:', expr.slice(0, 100), '| format:', _currentFormat);

    try {
        // A cell is considered busy if it is actively dispatched to the kernel
        // (_evalDispatched=true while the cell code is running) OR if cells are
        // queued waiting.  Using queue.length alone misses the currently-running cell.
        const kernelBusy = !!(ctrl._evalDispatched || (ctrl.executionQueue?.queue?.length > 0 && !ctrl._abortPending));
        const dynActive  = !!(ctrl._dynamicWidgets?.size > 0);

        let evalResult = null;

        if (kernelBusy) {
            // ── Busy path: interrupt → Dialog → export to .mx ──
            scrollLog('[eval-sel] busy path | dynActive:', dynActive);
            evalResult = await _evalViaBusyPath(ctrl, expr, dynActive);
            // If the busy path failed (e.g. interrupt aborted the cell instead
            // of opening a Dialog because onDialogBegin callbacks are not
            // attached), fall back to the idle path now that the kernel is free.
            if (!evalResult && !ctrl._evalDispatched) {
                scrollLog('[eval-sel] busy path returned null, kernel now idle — fallback to idle path');
                evalResult = await _evalViaIdlePath(ctrl, expr);
            }
        } else {
            // ── Idle path: normal evaluate → export to .mx ──
            scrollLog('[eval-sel] idle path');
            evalResult = await _evalViaIdlePath(ctrl, expr);
        }

        if (!evalResult) {
            _watchPanel.evalSelError('Evaluation returned no result.', expr);
            return;
        }

        // ── Large result: main kernel detected it; skip the subkernel renderer ──
        if (evalResult.large) {
            // evalResult.val = "EVALSEL:LARGE:/path/to/file.txt:leafCount:byteCount"
            const body       = evalResult.val.slice('EVALSEL:LARGE:'.length);
            const lastColon2 = body.lastIndexOf(':');
            const byteCount  = parseInt(body.slice(lastColon2 + 1)) || 0;
            const lastColon1 = body.lastIndexOf(':', lastColon2 - 1);
            const leafCount  = parseInt(body.slice(lastColon1 + 1, lastColon2)) || 0;
            const txtPath    = body.slice(0, lastColon1);
            const notebookDir = vscode.window.activeNotebookEditor
                ? path.dirname(vscode.window.activeNotebookEditor.notebook.uri.fsPath)
                : null;
            const skel =
                '<div style="color:var(--vscode-descriptionForeground);font-size:0.9em;' +
                'padding:6px 8px;background:var(--vscode-editorWidget-background,' +
                'rgba(0,0,0,0.1));border-radius:3px;">' +
                '&#9888; Result too large to display inline (' + leafCount + '\u202felements, ' +
                Math.round(byteCount / 1024) + '\u202fKB).<br>' +
                'Use the \u29c9 button above to open as InputForm text.' +
                '</div>';
            scrollLog('[eval-sel] large result | leafCount:', leafCount, '| byteCount:', byteCount, '| saved to:', txtPath);
            _watchPanel.evalSelUpdate(skel, expr, _currentFormat, notebookDir, txtPath);
            return;
        }

        // ── Render via subkernel ──
        const { html, notebookDir, openFilePath } = await _renderResult(ctrl, evalResult.val, expr, evalResult.txt);
        if (html) {
            _watchPanel.evalSelUpdate(html, expr, _currentFormat, notebookDir, openFilePath);
        } else {
            _watchPanel.evalSelError('Render returned no HTML.', expr);
        }
    } catch (err) {
        scrollLog('[eval-sel] ERROR:', err.message);
        _watchPanel.evalSelError(err.message, expr);
    } finally {
        _inFlight = false;
        // Restore focus and selection to the cell editor so Ctrl+Shift+E can be
        // pressed again immediately with the same selection still active.
        if (_savedTextEditor && _savedSelection) {
            try {
                await vscode.window.showTextDocument(_savedTextEditor.document, {
                    viewColumn: _savedViewColumn,
                    preserveFocus: false,
                    selection: _savedSelection,
                });
            } catch (_) {}
        }
    }
}

async function _evalViaIdlePath(ctrl, expr) {
    // Evaluate expr directly (no ToExpression — avoids escaping issues with
    // multiline code, quotes, backslashes etc.), export result to .mx.
    // Size check happens here on the main kernel so we never involve the subkernel
    // for large expressions (the subkernel renders via HTML, so a sentinel string
    // returned from it would be rendered as HTML text, not returned raw).
    const tmpMx  = path.join(require('os').tmpdir(), 'wl_evalsel_' + Date.now() + '.mx');
    const tmpTxt = tmpMx.replace(/\.mx$/, '.txt');
    const mxPath  = tmpMx.replace(/\\/g, '/');
    const txtPath = tmpTxt.replace(/\\/g, '/');
    const LEAF_LIMIT = 50000;
    const BYTE_LIMIT = 200000;
    // Always export InputForm text — even for small results — so the ⧉ button
    // always opens a readable .txt file rather than HTML.
    const wlExpr =
        'Block[{wbEvalSel$,wbBC$,wbLC$},' +
        'wbEvalSel$=(' + expr + ');' +
        'wbBC$=ByteCount[wbEvalSel$];wbLC$=LeafCount[wbEvalSel$];' +
        'Export["' + txtPath + '",ToString[wbEvalSel$,InputForm],"Text"];' +
        'If[wbBC$>' + BYTE_LIMIT + '||wbLC$>' + LEAF_LIMIT + ',' +
        '"EVALSEL:LARGE:' + txtPath + ':"<>ToString[wbLC$]<>":"<>ToString[wbBC$],' +
        'Export["' + mxPath + '",wbEvalSel$];' +
        '"EVALSEL:FILE:' + mxPath + '"' +
        ']]';

    scrollLog('[eval-sel] idle evaluate:', wlExpr.slice(0, 200));
    const result = await ctrl.session.evaluate(wlExpr, { interactive: false });
    const val = result?.result?.value;
    scrollLog('[eval-sel] idle result:', String(val).slice(0, 100));

    if (typeof val === 'string' && val.startsWith('EVALSEL:LARGE:')) return { large: true, val };
    if (typeof val === 'string' && val.startsWith('EVALSEL:FILE:'))  return { large: false, val: tmpMx, txt: tmpTxt };
    return null;
}

async function _evalViaBusyPath(ctrl, expr, dynActive) {
    const tmpMx  = path.join(require('os').tmpdir(), 'wl_evalsel_' + Date.now() + '.mx');
    const tmpTxt = tmpMx.replace(/\.mx$/, '.txt');
    const mxPath  = tmpMx.replace(/\\/g, '/');
    const txtPath = tmpTxt.replace(/\\/g, '/');
    const LEAF_LIMIT = 50000;
    const BYTE_LIMIT = 200000;
    const dlgExpr =
        'Block[{wbEvalSel$,wbBC$,wbLC$},' +
        'wbEvalSel$=(' + expr + ');' +
        'wbBC$=ByteCount[wbEvalSel$];wbLC$=LeafCount[wbEvalSel$];' +
        'Export["' + txtPath + '",ToString[wbEvalSel$,InputForm],"Text"];' +
        'If[wbBC$>' + BYTE_LIMIT + '||wbLC$>' + LEAF_LIMIT + ',' +
        '"EVALSEL:LARGE:' + txtPath + ':"<>ToString[wbLC$]<>":"<>ToString[wbBC$],' +
        'Export["' + mxPath + '",wbEvalSel$];' +
        '"EVALSEL:FILE:' + mxPath + '"' +
        ']]';

    if (dynActive) {
        // Piggyback on Dynamic loop by registering a one-shot callback
        return await _evalViaDynamicPiggyback(ctrl, dlgExpr, tmpMx, tmpTxt);
    } else {
        // Use subAuto — evaluates in the main kernel context via Dialog[],
        // same mechanism as live-watch.  The C++ timer thread handles the
        // interrupt properly (menuPktPending=true) so the running cell is
        // NOT aborted.
        return await _evalViaSubAuto(ctrl, dlgExpr, tmpMx, tmpTxt);
    }
}

function _evalViaDynamicPiggyback(ctrl, dlgExpr, tmpFile, tmpTxt) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ctrl._evalSelectionCallback = null;
            ctrl._evalSelectionExpr = null;
            reject(new Error('Dynamic piggyback timed out (15s)'));
        }, 15000);

        ctrl._evalSelectionExpr = dlgExpr;
        ctrl._evalSelectionCallback = (raw) => {
            clearTimeout(timeout);
            ctrl._evalSelectionCallback = null;
            ctrl._evalSelectionExpr = null;
            scrollLog('[eval-sel] piggyback result type:', raw?.type, '| val:', String(raw?.value ?? '').slice(0, 80));
            if (raw && typeof raw.value === 'string') {
                if (raw.value.startsWith('EVALSEL:LARGE:')) resolve({ large: true, val: raw.value });
                else if (raw.value.startsWith('EVALSEL:FILE:')) resolve({ large: false, val: tmpFile, txt: tmpTxt });
                else resolve(null);
            } else {
                resolve(null);
            }
        };
        scrollLog('[eval-sel] registered piggyback callback, waiting for Dynamic loop...');
    });
}

async function _evalViaSubAuto(ctrl, dlgExpr, tmpFile, tmpTxt) {
    scrollLog('[eval-sel] subAuto path — queuing for main-kernel eval via Dialog');
    try {
        const raw = await Promise.race([
            ctrl.session.subAuto(dlgExpr),
            new Promise((_, rej) => setTimeout(() => rej(new Error('subAuto timeout (15s)')), 15000)),
        ]);
        scrollLog('[eval-sel] subAuto result:', raw?.type, String(raw?.value ?? raw?.error ?? '').slice(0, 80));
        if (raw && typeof raw.value === 'string') {
            if (raw.value.startsWith('EVALSEL:LARGE:')) return { large: true, val: raw.value };
            if (raw.value.startsWith('EVALSEL:FILE:'))  return { large: false, val: tmpFile, txt: tmpTxt };
        }
        if (raw?.error) {
            scrollLog('[eval-sel] subAuto error:', raw.error);
        }
        return null;
    } catch (err) {
        scrollLog('[eval-sel] subAuto failed:', err.message);
        return null;
    }
}

async function _renderResult(ctrl, tmpFile, expr, txtFile) {
    // Get notebook path for image directory
    const nbEditor = vscode.window.activeNotebookEditor;
    let imgDir, imgRel, notebookDir;
    if (nbEditor) {
        const nbPath = nbEditor.notebook.uri.fsPath;
        const nbBase = path.basename(nbPath, path.extname(nbPath));
        notebookDir = path.dirname(nbPath);
        imgDir = path.join(notebookDir, 'img', nbBase);
        imgRel = 'img/' + nbBase;
    } else {
        notebookDir = null;
        imgDir = path.join(require('os').tmpdir(), 'wolfbook_evalsel_img');
        imgRel = imgDir;
    }
    try { fs.mkdirSync(imgDir, { recursive: true }); } catch (_) {}

    const format = _currentFormat;
    const scale  = Number(ctrl.config?.get('imageScale') || 0.8);

    scrollLog('[eval-sel] render | format:', format, '| scale:', scale, '| tmpFile:', tmpFile);

    const subKern = await ctrl._ensureSubKernel(imgDir, imgRel);

    const _tmpPathWL = tmpFile.replace(/\\/g, '/');
    const renderExpr = 'VsCodeRenderExpr[Import["' + _tmpPathWL + '"],"' + format + '",' + scale + ']';
    scrollLog('[eval-sel] subkernel eval:', renderExpr.slice(0, 120));

    const renderResult = await subKern.evaluate(renderExpr, { interactive: false });

    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch (_) {}

    // SVG is compact XML and renders fast in webviews; raise the limit for it.
    // MathML for large expressions (Range[500] etc.) is verbose and causes sluggishness.
    const HTML_SIZE_LIMIT = (format === 'SVG' || format === 'svg') ? 500_000 : 60_000;

    if (renderResult?.result?.type === 'string' && renderResult.result.value) {
        let html = renderResult.result.value;

        if (ctrl._processWLLatexBoxes) {
            // Use the watch panel's own width (side panel is narrower than the notebook).
            // Convert raw px → C++ em using the same calibrated coefficient as the notebook.
            // Fall back to 30em (~420px) if the panel hasn't reported its width yet.
            const panelWidthPx = (_watchPanel && _watchPanel.getWidthPx) ? _watchPanel.getWidthPx() : 0;
            const effectiveWidth = panelWidthPx > 0
                ? (ctrl.pxToPageWidthEm ? ctrl.pxToPageWidthEm(panelWidthPx) : Math.round(panelWidthPx / 14))
                : 30;
            html = ctrl._processWLLatexBoxes(html, undefined, effectiveWidth, 'watch-panel');
        }
        if (ctrl._fixImageUris)        html = ctrl._fixImageUris(html);
        scrollLog('[eval-sel] render OK | html length:', html.length);

        // Large HTML: the rendered output is too big for the sidebar; skip it and
        // link the InputForm .txt file instead (already written by the main kernel).
        if (html.length > HTML_SIZE_LIMIT) {
            const skel = '<div style="color:var(--vscode-descriptionForeground);font-size:0.9em;' +
                'padding:6px 8px;background:var(--vscode-editorWidget-background,' +
                'rgba(0,0,0,0.1));border-radius:3px;">' +
                '&#9888; Result too large to display inline (' + Math.round(html.length / 1024) + '\u202fKB of HTML).<br>' +
                'Use the \u29c9 button above to open as InputForm text.' +
                '</div>';
            scrollLog('[eval-sel] large HTML | txt file:', txtFile);
            return { html: skel, notebookDir, openFilePath: txtFile || null };
        }

        return { html, notebookDir, openFilePath: txtFile || null };
    }
    scrollLog('[eval-sel] render returned no string:', JSON.stringify(renderResult?.result)?.slice(0, 200));
    return { html: null, notebookDir, openFilePath: txtFile || null };
}

// ── WL syntax validation ────────────────────────────────────────────────

/** Lightweight client-side WL syntax check: balanced brackets, no unclosed strings.
 *  Returns null on success, or an error description string on failure. */
function _validateWLSyntax(expr) {
    let i = 0;
    const n = expr.length;
    const stack = [];
    while (i < n) {
        const c = expr[i];
        // Skip string literals (handle \\ escapes)
        if (c === '"') {
            i++;
            while (i < n) {
                if (expr[i] === '\\') { i += 2; continue; }
                if (expr[i] === '"') { i++; break; }
                i++;
            }
            continue;
        }
        // Skip WL comments (* ... *)
        if (c === '(' && i + 1 < n && expr[i + 1] === '*') {
            let depth = 1; i += 2;
            while (i < n - 1 && depth > 0) {
                if (expr[i] === '(' && expr[i + 1] === '*') { depth++; i += 2; continue; }
                if (expr[i] === '*' && expr[i + 1] === ')') { depth--; i += 2; continue; }
                i++;
            }
            continue;
        }
        if (c === '[' || c === '(' || c === '{') {
            stack.push(c);
        } else if (c === ']' || c === ')' || c === '}') {
            const open = { ']': '[', ')': '(', '}': '{' }[c];
            if (stack.length === 0 || stack[stack.length - 1] !== open) {
                return 'unmatched closing "' + c + '"';
            }
            stack.pop();
        }
        i++;
    }
    if (stack.length > 0) return 'unclosed "' + stack[stack.length - 1] + '"';
    return null;
}

// ── Add Selection to Watch ───────────────────────────────────────────────

function addSelectionToWatch() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const sel = editor.selection;
    if (sel.isEmpty) { vscode.window.showInformationMessage('Select an expression to add to watch.'); return; }
    const expr = editor.document.getText(sel).trim();
    if (!expr) { vscode.window.showInformationMessage('Selection is empty.'); return; }
    const syntaxErr = _validateWLSyntax(expr);
    if (syntaxErr) {
        vscode.window.showErrorMessage('Cannot add to watch — invalid WL syntax: ' + syntaxErr + '.');
        return;
    }
    if (!_watchPanel) { vscode.window.showWarningMessage('Watch panel not available.'); return; }
    const added = _watchPanel.addWatchExternal(expr);
    if (added) {
        vscode.commands.executeCommand('wolfbook.watchPanel.focus');
        const label = expr.length > 60 ? expr.slice(0, 60) + '\u2026' : expr;
        vscode.window.showInformationMessage('\u2795 "' + label + '" added to watch.');
        scrollLog('[add-to-watch] added:', expr);
    } else {
        vscode.window.showInformationMessage('"' + expr.slice(0, 60) + '" is already in the watch list.');
    }
}

// ── Public registration ─────────────────────────────────────────────────

/**
 * docLookup — evaluate `symbolName::usage` through the same idle-path +
 * subkernel render pipeline as eval-sel (so user-defined and package symbols
 * work), rendered with WLLatex (BTL) and displayed in the Watch panel's
 * eval-sel section.  Falls back to rawMarkdown when the kernel is unavailable.
 */
async function docLookup(ctrl, symbolName, watchPanel, fallbackMd) {
    if (!ctrl?.session) {
        if (fallbackMd) watchPanel.showHoverDoc(fallbackMd, symbolName);
        return;
    }

    // Evaluate Information[symbolName] directly — same as a normal input cell.
    // Information returns InformationData[<|...|>] which has FormatValues producing
    // the full InterpretationBox. VsCodeRenderExpr/BTL on the subkernel handles it
    // perfectly without any additional wrapper.
    const expr = 'Information[' + symbolName + ']';
    watchPanel.evalSelSpinner(expr);

    // Force WLLatex format for doc rendering regardless of user's current setting
    const savedFormat = _currentFormat;
    _currentFormat = 'WLLatex';
    try {
        const evalResult = await _evalViaIdlePath(ctrl, expr);
        if (!evalResult) { watchPanel.evalSelError('No result from kernel.', expr); return; }

        const { html, notebookDir, openFilePath } = await _renderResult(ctrl, evalResult.val, expr, evalResult.txt);
        if (html) {
            const docUrl = 'https://reference.wolfram.com/language/ref/' + encodeURIComponent(symbolName) + '.html';
            const htmlWithLink = html +
                '<div style="margin-top:8px;font-size:0.82em;opacity:0.7">' +
                '<a href="' + docUrl + '" style="color:var(--vscode-textLink-foreground);text-decoration:none">' +
                '&#128366; Wolfram Documentation</a></div>';
            watchPanel.evalSelUpdate(htmlWithLink, expr, 'WLLatex', notebookDir, openFilePath);
        } else {
            watchPanel.evalSelError('Render returned no HTML.', expr);
        }
    } catch (err) {
        scrollLog('[doc-lookup] ERROR:', err.message);
        watchPanel.evalSelError(err.message, expr);
    } finally {
        _currentFormat = savedFormat;
    }
}

function register(context, getController, watchPanel) {
    _watchPanel = watchPanel;
    _createStatusBar(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('wolfbook.evaluateSelection', () => evaluateSelection(getController))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('wolfbook.evaluateSelectionFormat', () => _pickFormat())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('wolfbook.addSelectionToWatch', () => addSelectionToWatch())
    );

    scrollLog('[eval-sel] registered');
}

module.exports = { register, docLookup };
