'use strict';
// execution/global-symbols.js
// Highlights Global` context symbols (user-defined variables) in all visible
// Wolfram cell editors, mimicking Mathematica's auto-coloring of named symbols.
//
// Each symbol occurrence is decorated with the color configured in
// wolfram.editor.globalSymbolColor.  Leave the setting empty to disable.
//
// The symbol list is refreshed after every cell execution by calling updateAll().
// On editor focus changes the cached list is re-applied without a kernel round-trip.

const vscode = require('vscode');

let _decorType  = null;    // current TextEditorDecorationType (color-specific)
let _colorCfg   = null;    // color string the current _decorType was created with
let _symbols    = [];      // cached Names["Global`*"] list from last execution

// ── Config helpers ──────────────────────────────────────────────────────────

function _getColor() {
    return (vscode.workspace.getConfiguration('wolfram').get('editor.globalSymbolColor') || '').trim();
}

/** Return (or create) the decoration type for the given color string. */
function _ensureDecorType(color) {
    if (!color) {
        if (_decorType) { _decorType.dispose(); _decorType = null; _colorCfg = null; }
        return null;
    }
    if (_decorType && _colorCfg === color) return _decorType;
    if (_decorType) { _decorType.dispose(); _decorType = null; }
    _colorCfg  = color;
    _decorType = vscode.window.createTextEditorDecorationType({ color });
    return _decorType;
}

// ── Decoration application ──────────────────────────────────────────────────

function _applyToEditor(editor, decor) {
    if (!editor || editor.document.languageId !== 'wolfram') return;
    if (!decor || _symbols.length === 0) {
        if (decor) editor.setDecorations(decor, []);
        return;
    }
    try {
        const text   = editor.document.getText();
        const ranges = [];
        // WL identifiers: letters (incl. Unicode \u0080+), digits, $ and _.
        // Use custom word-boundary lookaround so Greek letters are matched correctly.
        const boundary = '(?<![A-Za-z\\u0080-\\uFFFF0-9$_])';
        const boundaryR = '(?![A-Za-z\\u0080-\\uFFFF0-9$_])';
        for (const sym of _symbols) {
            if (!sym) continue;
            const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(boundary + escaped + boundaryR, 'g');
            let m;
            while ((m = re.exec(text)) !== null) {
                const start = editor.document.positionAt(m.index);
                const end   = editor.document.positionAt(m.index + sym.length);
                ranges.push(new vscode.Range(start, end));
            }
        }
        editor.setDecorations(decor, ranges);
    } catch (_) {
        // Editor may have been closed mid-scan — ignore silently.
    }
}

function _applyToAllEditors() {
    const color = _getColor();
    const decor = _ensureDecorType(color);
    for (const editor of vscode.window.visibleTextEditors) {
        _applyToEditor(editor, decor);
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch Names["Global`*"] from the kernel via sub() and re-apply decorations.
 * Called after each cell execution completes.
 * @param {object} ctrl — WolframNotebookKernel controller instance
 */
async function updateAll(ctrl) {
    const color = _getColor();
    console.log('[global-symbols] updateAll | color:', JSON.stringify(color), '| symbols cached:', _symbols.length);
    if (!color) {
        // Feature disabled: clear any stale decorations and bail out.
        if (_decorType) {
            for (const editor of vscode.window.visibleTextEditors) {
                editor.setDecorations(_decorType, []);
            }
        }
        _symbols = [];
        return;
    }

    if (!ctrl?.session?.subWhenIdle) { console.log('[global-symbols] updateAll: no session.subWhenIdle'); return; }

    try {
        // subWhenIdle() runs only when the kernel is fully idle — safe for background queries,
        // never races with evaluate() or Dynamic widget sub() calls.
        // StringReplace strips context prefix defensively — Names[] may return "Global`x" or "x".
        const result = await ctrl.session.subWhenIdle(
            '"GLOBALNAMES:"<>StringRiffle[StringReplace[Names["Global`*"],"Global`"->""],","]'
        );
        console.log('[global-symbols] sub result type:', result?.type, '| value prefix:', typeof result?.value === 'string' ? result.value.slice(0, 80) : result?.value);
        // result is WExpr: { type: "string", value: "GLOBALNAMES:x,y,..." }
        if (result && result.type === 'string' && typeof result.value === 'string'
                && result.value.startsWith('GLOBALNAMES:')) {
            const raw = result.value.slice('GLOBALNAMES:'.length);
            _symbols = raw ? raw.split(',').filter(Boolean) : [];
            console.log('[global-symbols] symbols updated, count:', _symbols.length, '| sample:', _symbols.slice(0, 5));
        } else {
            console.log('[global-symbols] unexpected result, symbols unchanged');
        }
    } catch (err) {
        console.log('[global-symbols] sub() error:', err?.message || err);
    }

    _applyToAllEditors();
}

/**
 * Register event listeners that keep decorations up to date when editors change.
 * Call once from extension.js activate().
 * @param {vscode.ExtensionContext} context
 */
function register(context) {
    context.subscriptions.push(
        // Re-apply to newly focused editor using cached symbol list.
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor || editor.document.languageId !== 'wolfram') return;
            const color = _getColor();
            const decor = _ensureDecorType(color);
            if (decor) _applyToEditor(editor, decor);
        }),

        // Re-apply when new editors become visible (e.g. scrolling a notebook).
        vscode.window.onDidChangeVisibleTextEditors(() => {
            _applyToAllEditors();
        }),

        // Recreate decoration type and re-apply when the color setting changes.
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('wolfram.editor.globalSymbolColor')) {
                if (_decorType) { _decorType.dispose(); _decorType = null; _colorCfg = null; }
                _applyToAllEditors();
            }
        }),

        // Cleanup on deactivation.
        { dispose() { if (_decorType) { _decorType.dispose(); _decorType = null; } } }
    );
}

module.exports = { register, updateAll };
