'use strict';
/**
 * evaluateSelection.js — Evaluate Selection (Cmd+Shift+E)
 *
 * Evaluates the currently selected text in the editor, works both when
 * the kernel is idle and when it is busy (using subAuto → Dialog[]
 * mechanism, same as live-watch — no interrupt, running cell preserved).
 *
 * A single subAuto call sends a WL expression that evaluates the selection
 * AND renders the result inline via VsCodeRenderExpr.  C++ decides whether
 * to use the idle path (EvaluatePacket) or the busy path (Dialog[]).
 * No .mx file export/import, no separate sub-warm render step.
 *
 * The rendered HTML is displayed inside the Watch panel's "EVAL SELECTION" section.
 */
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const { scrollLog } = require('../utils/dev-logger');
const { splitIntoSubexpressions } = require('../utils/wl-parse');

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
let _editorResultDecoration = null;
const _editorResults = new Map();

function _wlResultText(result) {
    if (result?.result?.type === 'abort') return '(aborted)';
    if (result?.result?.type !== 'string') return '(no output)';
    return String(result.result.value || 'Null')
        .replace(/\\:([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 500);
}

async function evaluateEditorExpression(getController) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const sel = editor.selection;
    let parts;
    let baseLine = 0;

    if (!sel.isEmpty) {
        // Selection is the hard evaluation boundary: never include surrounding code.
        baseLine = sel.start.line;
        parts = splitIntoSubexpressions(doc.getText(sel));
    } else {
        // With no selection, evaluate the complete top-level expression under
        // the cursor (which may span several physical lines).
        const all = splitIntoSubexpressions(doc.getText());
        const line = sel.active.line;
        const current = all.find(p => line >= p.startLine && line <= p.endLine);
        parts = current ? [current] : [];
    }
    if (!parts.length || !parts.some(p => p.text.trim())) return;

    const ctrl = getController();
    if (!ctrl) return;
    if (!ctrl.session || ctrl.kernelStatusString !== 'resolved') {
        try { await ctrl.launchKernel(); }
        catch (e) {
            vscode.window.showErrorMessage('Could not start the Wolfram kernel: ' + String(e && e.message || e));
            return;
        }
    }
    if (!ctrl.session || ctrl.kernelStatusString !== 'resolved') {
        vscode.window.showWarningMessage('The Wolfram kernel is not ready.');
        return;
    }

    const decorations = [];
    for (const part of parts) {
        const source = part.text.trim();
        if (!source) continue;
        const wrapped = 'Block[{$wbEditorResult$},$wbEditorResult$=(' + source + ');' +
            'If[StringQ[$wbEditorResult$],$wbEditorResult$,ToString[$wbEditorResult$,InputForm]]]';
        try {
            const result = await ctrl.session.evaluate(wrapped, { interactive: false });
            const endLine = Math.min(doc.lineCount - 1, baseLine + part.endLine);
            const end = doc.lineAt(endLine).range.end;
            decorations.push({
                range: new vscode.Range(end, end),
                renderOptions: { after: { contentText: '    ⟹ ' + _wlResultText(result) } },
                hoverMessage: new vscode.MarkdownString('```wolfram\n' + _wlResultText(result) + '\n```'),
            });
        } catch (e) {
            const endLine = Math.min(doc.lineCount - 1, baseLine + part.endLine);
            const end = doc.lineAt(endLine).range.end;
            decorations.push({
                range: new vscode.Range(end, end),
                renderOptions: { after: { contentText: '    ⟹ error: ' + String(e && e.message || e).slice(0, 300) } },
            });
            break;
        }
    }
    _editorResults.set(doc.uri.toString(), decorations);
    editor.setDecorations(_editorResultDecoration, decorations);
}

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
    const textEditor = vscode.window.activeTextEditor;
    const isWolframFile = textEditor && textEditor.document.languageId === 'wolfram';
    if ((nbEditor && nbEditor.notebook.notebookType === 'extended-wolfram-notebook') || isWolframFile) {
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

async function evaluateSelection(getController, options) {
    options = options || {};
    // Get selected text
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage('No active editor.'); return; }
    const sel = editor.selection;
    const expr = (sel.isEmpty && options.useCurrentLine
        ? editor.document.lineAt(sel.active.line).text
        : editor.document.getText(sel)).trim();
    if (sel.isEmpty && !options.useCurrentLine) {
        vscode.window.showInformationMessage('Select code to evaluate.');
        return;
    }
    if (!expr) { vscode.window.showInformationMessage('Selection is empty.'); return; }

    const ctrl = getController();
    if (options.startKernel && ctrl && (!ctrl.session || ctrl.kernelStatusString !== 'resolved')) {
        try { await ctrl.launchKernel(); }
        catch (e) {
            vscode.window.showErrorMessage('Could not start the Wolfram kernel: ' + String(e && e.message || e));
            return;
        }
    }
    if (!ctrl?.session) { vscode.window.showWarningMessage('No kernel. Launch the kernel first.'); return; }
    if (ctrl.kernelStatusString !== 'resolved') {
        vscode.window.showInformationMessage('The Wolfram kernel is still starting.');
        return;
    }

    // ── Syntax check before sending to kernel ──
    try {
        const syntaxRaw = ctrl._syntaxCheck
            ? ctrl._syntaxCheck(expr)
            : JSON.stringify({ errors: (_validateWLSyntax(expr) ? [{ message: _validateWLSyntax(expr) }] : []) });
        const syntaxJson = JSON.parse(syntaxRaw);
        if (syntaxJson.errors && syntaxJson.errors.length > 0) {
            const msg = syntaxJson.errors[0].message || 'Syntax error';
            scrollLog('[eval-sel] syntax error — rejected:', msg);
            vscode.window.showErrorMessage('Syntax error in selection: ' + msg);
            return;
        }
    } catch (_) { /* non-fatal: proceed if check itself fails */ }

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
    // Capture this before focusing the Watch view. Once focus moves into the
    // sidebar activeNotebookEditor can temporarily be undefined.
    const _savedNotebookEditor = vscode.window.activeNotebookEditor;

    // Update the panel state now, but do not focus it until the shared subAuto
    // channel has been claimed below. Focusing can wake live-watch polling.
    _watchPanel.evalSelSpinner(expr);
    scrollLog('[eval-sel] start | expr:', expr.slice(0, 100), '| format:', _currentFormat);

    try {
        const format = _currentFormat;
        const scale  = Number(ctrl.config?.get('imageScale') || 0.8);

        // Compute imgDir for raster images (SVG/PNG outputs from VsCodeRenderExpr)
        const nbEditor = _savedNotebookEditor;
        let imgDir, imgRel, notebookDir;
        if (nbEditor) {
            const nbPath = nbEditor.notebook.uri.fsPath;
            const nbBase = path.basename(nbPath, path.extname(nbPath));
            notebookDir  = path.dirname(nbPath);
            imgDir  = path.join(notebookDir, 'img', nbBase);
            imgRel  = 'img/' + nbBase;
        } else {
            notebookDir = null;
            imgDir  = path.join(require('os').tmpdir(), 'wolfbook_evalsel_img');
            imgRel  = imgDir;
        }
        try { fs.mkdirSync(imgDir, { recursive: true }); } catch (_) {}

        const imgDirWL  = imgDir.replace(/\\/g, '/');
        const imgRelWL  = imgRel.replace(/\\/g, '/');
        const tmpTxt    = path.join(require('os').tmpdir(), 'wl_evalsel_' + Date.now() + '.txt');
        const txtPathWL = tmpTxt.replace(/\\/g, '/');
        const LEAF_LIMIT = 50000;
        const BYTE_LIMIT = 200000;

        // Single subAuto call — C++ decides idle (EvaluatePacket) vs busy
        // (EnterTextPacket inside Dialog[]) automatically.
        // VsCodeRenderExpr runs on the main kernel inline, returning HTML directly.
        // No .mx file export/import, no separate sub-warm render step.
        // If the expression is a ?pattern Information query, extract the pattern
        // and pass it to VsCodeRenderExpr so it can highlight matches in the grid.
        const _infoPatMatch = expr.trim().match(/^\?(\S+)/);
        const _infoPat = _infoPatMatch ? '"' + _infoPatMatch[1].replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : '""';
        const wlExpr =
            'Block[{wbES$v,wbBC$v,wbLC$v},' +
            'VsCodeSetImgDir["' + imgDirWL + '","' + imgRelWL + '"];' +
            'wbES$v=(' + expr + ');' +
            'wbBC$v=ByteCount[wbES$v];wbLC$v=LeafCount[wbES$v];' +
            'Export["' + txtPathWL + '",ToString[wbES$v,InputForm],"Text"];' +
            'If[wbBC$v>' + BYTE_LIMIT + '||wbLC$v>' + LEAF_LIMIT + ',' +
            '"EVALSEL:LARGE:' + txtPathWL + ':"<>ToString[wbLC$v]<>":"<>ToString[wbBC$v],' +
            'VsCodeRenderExpr[wbES$v,"' + format + '",' + scale + ',' + _infoPat + ']' +
            ']]';

        scrollLog('[eval-sel] subAuto | format:', format, '| expr:', expr.slice(0, 100));
        // subAuto shares one WSTP packet stream with live watch and Dynamic.
        // Overlapping calls can consume one another's RETURNPKT and produce a
        // spurious Symbol[Null] (reported previously as "no result"). Wait for
        // the current owner, then publish our promise before focusing the panel.
        if (ctrl._subAutoLock) {
            try { await ctrl._subAutoLock; } catch (_) {}
        }
        const _cppPromise = ctrl.session.subAuto(wlExpr);
        ctrl._subAutoLock = _cppPromise;
        _cppPromise.finally(() => {
            if (ctrl._subAutoLock === _cppPromise) ctrl._subAutoLock = null;
        }).catch(() => {});
        vscode.commands.executeCommand('wolfbook.watchPanel.focus');
        const raw = await Promise.race([
            _cppPromise,
            new Promise((_, rej) => setTimeout(() => rej(new Error('subAuto timeout (30s)')), 30000)),
        ]);
        scrollLog('[eval-sel] subAuto result:', raw?.type, String(raw?.value ?? raw?.error ?? '').slice(0, 100));

        if (!raw || raw.type !== 'string' || !raw.value) {
            _watchPanel.evalSelError('Evaluation returned no result.', expr);
            return;
        }

        const val = raw.value;

        // ── Large result ──
        if (val.startsWith('EVALSEL:LARGE:')) {
            const body       = val.slice('EVALSEL:LARGE:'.length);
            const lastColon2 = body.lastIndexOf(':');
            const byteCount  = parseInt(body.slice(lastColon2 + 1)) || 0;
            const lastColon1 = body.lastIndexOf(':', lastColon2 - 1);
            const leafCount  = parseInt(body.slice(lastColon1 + 1, lastColon2)) || 0;
            const txtPath    = body.slice(0, lastColon1);
            const skel =
                '<div style="color:var(--vscode-descriptionForeground);font-size:0.9em;' +
                'padding:6px 8px;background:var(--vscode-editorWidget-background,' +
                'rgba(0,0,0,0.1));border-radius:3px;">' +
                '&#9888; Result too large to display inline (' + leafCount + '\u202felements, ' +
                Math.round(byteCount / 1024) + '\u202fKB).<br>' +
                'Use the \u29c9 button above to open as InputForm text.' +
                '</div>';
            scrollLog('[eval-sel] large result | leafCount:', leafCount, '| byteCount:', byteCount);
            _watchPanel.evalSelUpdate(skel, expr, format, notebookDir, txtPath);
            return;
        }

        // ── Rendered HTML ──
        // SVG is compact; raise the HTML size limit for it.
        const HTML_SIZE_LIMIT = (format === 'SVG' || format === 'SVGT') ? 500_000 : 60_000;
        let html = val;

        if (ctrl._processWLLatexBoxes) {
            const panelWidthPx = (_watchPanel && _watchPanel.getWidthPx) ? _watchPanel.getWidthPx() : 0;
            const effectiveWidth = panelWidthPx > 0
                ? (ctrl.pxToPageWidthEm ? ctrl.pxToPageWidthEm(panelWidthPx) : Math.round(panelWidthPx / 14))
                : 30;
            html = ctrl._processWLLatexBoxes(html, undefined, effectiveWidth, 'watch-panel');
        }
        if (ctrl._fixImageUris) html = ctrl._fixImageUris(html);
        scrollLog('[eval-sel] render OK | html length:', html.length);

        if (html.length > HTML_SIZE_LIMIT) {
            const skel = '<div style="color:var(--vscode-descriptionForeground);font-size:0.9em;' +
                'padding:6px 8px;background:var(--vscode-editorWidget-background,' +
                'rgba(0,0,0,0.1));border-radius:3px;">' +
                '&#9888; Result too large to display inline (' + Math.round(html.length / 1024) + '\u202fKB of HTML).<br>' +
                'Use the \u29c9 button above to open as InputForm text.' +
                '</div>';
            scrollLog('[eval-sel] large HTML | txt file:', tmpTxt);
            _watchPanel.evalSelUpdate(skel, expr, format, notebookDir, tmpTxt);
            return;
        }

        _watchPanel.evalSelUpdate(html, expr, format, notebookDir, tmpTxt);
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
    // No kernel, kernel still starting, or paused inside a debug Dialog[]: the
    // subAuto round-trip cannot succeed, so show the LSP markdown instead of
    // failing with a bare "No result from kernel.".
    if (!ctrl?.session || ctrl.kernelStatusString !== 'resolved' || ctrl._active) {
        if (fallbackMd) watchPanel.showHoverDoc(fallbackMd, symbolName);
        else watchPanel.evalSelError('Kernel not ready.', 'Information[' + symbolName + ']');
        return;
    }

    // Evaluate Information[symbolName] directly — same as a normal input cell.
    // Information returns InformationData[<|...|>] which has FormatValues producing
    // the full InterpretationBox. VsCodeRenderExpr/BTL handles it perfectly.
    const expr = 'Information[' + symbolName + ']';
    watchPanel.evalSelSpinner(expr);

    const scale   = Number(ctrl.config?.get('imageScale') || 0.8);
    const tmpTxt  = path.join(require('os').tmpdir(), 'wl_evalsel_' + Date.now() + '.txt');
    const txtPathWL = tmpTxt.replace(/\\/g, '/');
    const LEAF_LIMIT = 50000;
    const BYTE_LIMIT = 200000;

    const wlExpr =
        'Block[{wbES$v,wbBC$v,wbLC$v},' +
        'wbES$v=(' + expr + ');' +
        'wbBC$v=ByteCount[wbES$v];wbLC$v=LeafCount[wbES$v];' +
        'Export["' + txtPathWL + '",ToString[wbES$v,InputForm],"Text"];' +
        'If[wbBC$v>' + BYTE_LIMIT + '||wbLC$v>' + LEAF_LIMIT + ',' +
        '"EVALSEL:LARGE:' + txtPathWL + ':"<>ToString[wbLC$v]<>":"<>ToString[wbBC$v],' +
        'VsCodeRenderExpr[wbES$v,"WLLatex",' + scale + ']' +
        ']]';

    try {
        // subAuto shares one WSTP packet stream with live watch and Dynamic.
        // Overlapping calls consume one another's RETURNPKT and produce a
        // spurious Symbol[Null] — which surfaced here as "No result from
        // kernel.".  Serialise on the same lock evaluateSelection() uses, and
        // bound the wait so a lost packet cannot hang the panel forever.
        if (ctrl._subAutoLock) {
            try { await ctrl._subAutoLock; } catch (_) {}
        }
        const _cppPromise = ctrl.session.subAuto(wlExpr);
        ctrl._subAutoLock = _cppPromise;
        _cppPromise.finally(() => {
            if (ctrl._subAutoLock === _cppPromise) ctrl._subAutoLock = null;
        }).catch(() => {});
        const raw = await Promise.race([
            _cppPromise,
            new Promise((_, rej) => setTimeout(() => rej(new Error('subAuto timeout (30s)')), 30000)),
        ]);
        if (!raw || raw.type !== 'string' || !raw.value) {
            watchPanel.evalSelError('No result from kernel.', expr);
            return;
        }
        let html = raw.value;
        if (html.startsWith('EVALSEL:LARGE:')) {
            watchPanel.evalSelError('Documentation result too large.', expr);
            return;
        }
        if (ctrl._processWLLatexBoxes) {
            const panelWidthPx = (watchPanel && watchPanel.getWidthPx) ? watchPanel.getWidthPx() : 0;
            const effectiveWidth = panelWidthPx > 0
                ? (ctrl.pxToPageWidthEm ? ctrl.pxToPageWidthEm(panelWidthPx) : Math.round(panelWidthPx / 14))
                : 30;
            html = ctrl._processWLLatexBoxes(html, undefined, effectiveWidth, 'watch-panel');
        }
        if (ctrl._fixImageUris) html = ctrl._fixImageUris(html);

        const docUrl = 'https://reference.wolfram.com/language/ref/' + encodeURIComponent(symbolName) + '.html';
        const htmlWithLink = html +
            '<div style="margin-top:8px;font-size:0.82em;opacity:0.7">' +
            '<a href="' + docUrl + '" style="color:var(--vscode-textLink-foreground);text-decoration:none">' +
            '&#128366; Wolfram Documentation</a></div>';
        watchPanel.evalSelUpdate(htmlWithLink, expr, 'WLLatex', null, tmpTxt);
    } catch (err) {
        scrollLog('[doc-lookup] ERROR:', err.message);
        watchPanel.evalSelError(err.message, expr);
    }
}

function register(context, getController, watchPanel) {
    _watchPanel = watchPanel;
    _createStatusBar(context);
    _editorResultDecoration = vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'italic',
            margin: '0 0 0 1.5em',
        },
    });
    context.subscriptions.push(_editorResultDecoration);

    context.subscriptions.push(
        vscode.commands.registerCommand('wolfbook.evaluateSelection', () =>
            evaluateSelection(getController, { startKernel: true }))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('wolfbook.evaluateEditorExpression', () =>
            evaluateEditorExpression(getController))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('wolfbook.evaluateSelectionFormat', () => _pickFormat())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('wolfbook.addSelectionToWatch', () => addSelectionToWatch())
    );
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
        const key = event.document.uri.toString();
        if (!_editorResults.has(key)) return;
        _editorResults.delete(key);
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === key) editor.setDecorations(_editorResultDecoration, []);
        }
    }));
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
            editor.setDecorations(_editorResultDecoration,
                _editorResults.get(editor.document.uri.toString()) || []);
        }
    }));

    scrollLog('[eval-sel] registered');
}

module.exports = { register, docLookup };
