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
const { wlNameToUTF, CODE_TO_NAME } = require('../namedchars');
const { decodeWolframOctal } = require('../utils/encoding');
const configCompat = require('../config-compat');
const { scrollLog } = require('../utils/dev-logger');

/** Decode WSTP \:XXXX hex escapes (e.g. \:03B1 → α) */
function decodeWolframHex(s) {
    return s.replace(/\\:([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

let _decorType  = null;    // current TextEditorDecorationType (color-specific)
let _colorCfg   = null;    // color string the current _decorType was created with
let _symbols    = [];      // cached Names["Global`*"] list from last execution

// ── Config helpers ──────────────────────────────────────────────────────────

function _getColor() {
    const v = (configCompat.getSetting('editor.globalSymbolColor', '') || '').trim();
    // Empty string means "use default"; set to 'off' or 'none' to explicitly disable.
    if (!v || v === 'auto') {
        const kind = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind;
        // ColorThemeKind: Light=1, Dark=2, HighContrast=3, HighContrastLight=4
        const isDark = kind === 2 || kind === 3;
        return isDark ? '#7eb3d4' : '#333333';
    }
    if (v === 'off' || v === 'none') return '';
    return v;
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

// ── Named-char helpers ────────────────────────────────────────────────────────

/**
 * For a UTF symbol name containing non-ASCII chars (e.g. "α"), return the
 * regex pattern string that matches the WL \[Name] form (e.g. \\\[Alpha\]).
 * Returns null for all-ASCII names.
 */
function _symToWLPattern(sym) {
    if (!/[^\x00-\x7F]/.test(sym)) return null;
    // Build the literal WL text first, e.g. "α" → '\[Alpha]'
    let wlLiteral = '';
    for (const ch of sym) {
        const cp = ch.codePointAt(0);
        if (cp > 0x7F) {
            const name = CODE_TO_NAME[cp];
            if (!name) return null; // unknown non-ASCII, no \[Name] form
            wlLiteral += '\\[' + name + ']';
        } else {
            wlLiteral += ch;
        }
    }
    // Regex-escape the literal so it can be used in new RegExp()
    return wlLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Comment range detection ─────────────────────────────────────────────────

/**
 * Returns an array of [start, end] byte-index pairs for all WL comment spans.
 * Handles nesting: (* outer (* inner *) outer *) is a single range.
 */
function _commentRanges(text) {
    const ranges = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    while (i < text.length - 1) {
        if (text[i] === '(' && text[i + 1] === '*') {
            if (depth === 0) start = i;
            depth++;
            i += 2;
        } else if (text[i] === '*' && text[i + 1] === ')' && depth > 0) {
            depth--;
            if (depth === 0) ranges.push([start, i + 2]);
            i += 2;
        } else {
            i++;
        }
    }
    return ranges;
}

/**
 * Returns [start, end) ranges for all WL string literals, honouring \" escapes.
 * Skips over comment spans so a " inside (* ... *) doesn't open a string.
 */
function _stringRanges(text, commentSpans) {
    const ranges = [];
    let i = 0;
    while (i < text.length) {
        // Skip comment regions — their " must not open a string
        const inCmt = commentSpans.find(([s, e]) => i >= s && i < e);
        if (inCmt) { i = inCmt[1]; continue; }
        if (text[i] === '"') {
            const start = i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\' && i + 1 < text.length) i++; // skip escaped char
                i++;
            }
            if (i < text.length) i++; // consume closing "
            ranges.push([start, i]);
        } else {
            i++;
        }
    }
    return ranges;
}

function _inSpan(idx, ranges) {
    for (const [s, e] of ranges) if (idx >= s && idx < e) return true;
    return false;
}

function _inComment(idx, ranges) {
    return _inSpan(idx, ranges);
}

// ── Decoration application ──────────────────────────────────────────────────

function _applyToEditor(editor, decor) {
    if (!editor || editor.document.languageId !== 'wolfram') return;
    if (!decor || _symbols.length === 0) {
        if (decor) editor.setDecorations(decor, []);
        return;
    }
    try {
        const text         = editor.document.getText();
        const commentSpans = _commentRanges(text);
        const stringSpans  = _stringRanges(text, commentSpans);
        const ranges = [];
        // WL identifiers: letters (incl. Unicode \u0080+), digits, $ and _.
        // Use custom word-boundary lookaround so Greek letters are matched correctly.
        const boundary = '(?<![A-Za-z\\u0080-\\uFFFF0-9$_])';
        const boundaryR = '(?![A-Za-z\\u0080-\\uFFFF0-9$_])';
        for (const sym of _symbols) {
            if (!sym) continue;
            const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const wlPat   = _symToWLPattern(sym);
            // Match both the UTF form (e.g. α) and the unconverted \[Name] form
            const pattern = wlPat ? `(?:${escaped}|${wlPat})` : escaped;
            const re = new RegExp(boundary + pattern + boundaryR, 'g');
            let m;
            while ((m = re.exec(text)) !== null) {
                if (_inComment(m.index, commentSpans)) continue;  // skip inside (* ... *)
                if (_inSpan(m.index, stringSpans))  continue;      // skip inside "..."
                const start = editor.document.positionAt(m.index);
                const end   = editor.document.positionAt(m.index + m[0].length);
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
    scrollLog('[global-symbols] updateAll | color:', JSON.stringify(color), '| symbols cached:', _symbols.length);
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

    if (!ctrl?.session?.subWhenIdle) { scrollLog('[global-symbols] updateAll: no session.subWhenIdle'); return; }

    try {
        // subWhenIdle() runs only when the kernel is fully idle — safe for background queries,
        // never races with evaluate() or Dynamic widget sub() calls.
        // Include symbols that have any definition: OwnValues (variables),
        // DownValues (functions), SubValues, or UpValues.
        // Use ToExpression[..., HoldComplete] to avoid premature evaluation of symbols.
        const result = await ctrl.session.subWhenIdle(
            '"GLOBALNAMES:"<>StringRiffle[StringReplace[Select[Names["Global`*"],Function[nm,ToExpression["ValueQ[Global`"<>nm<>"]||DownValues[Global`"<>nm<>"]=!={}||SubValues[Global`"<>nm<>"]=!={}||UpValues[Global`"<>nm<>"]=!={}"]]],"Global`"->""],","]'
        );
        // result is WExpr: { type: "string", value: "GLOBALNAMES:x,y,..." }
        if (result && result.type === 'string' && typeof result.value === 'string'
                && result.value.startsWith('GLOBALNAMES:')) {
            const raw = result.value.slice('GLOBALNAMES:'.length);
            // Decode all WSTP escape forms: \:XXXX hex, \NNN octal, \[Name]
            const decoded = raw ? wlNameToUTF(decodeWolframOctal(decodeWolframHex(raw))) : '';
            _symbols = decoded ? decoded.split(',').filter(Boolean) : [];
            scrollLog('[global-symbols] symbols updated, count:', _symbols.length, '| sample:', _symbols.slice(0, 5));
        } else {
            scrollLog('[global-symbols] unexpected result — type:', result?.type, '| value prefix:', typeof result?.value === 'string' ? result.value.slice(0, 80) : result?.value);
        }
    } catch (err) {
        scrollLog('[global-symbols] sub() error:', err?.message || err);
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
            if (configCompat.affectsSetting(e, 'editor.globalSymbolColor')) {
                if (_decorType) { _decorType.dispose(); _decorType = null; _colorCfg = null; }
                _applyToAllEditors();
            }
        }),

        // Re-apply with correct color when VS Code theme changes (dark ↔ light).
        vscode.window.onDidChangeActiveColorTheme(() => {
            if (_decorType) { _decorType.dispose(); _decorType = null; _colorCfg = null; }
            _applyToAllEditors();
        }),

        // Cleanup on deactivation.
        { dispose() { if (_decorType) { _decorType.dispose(); _decorType = null; } } }
    );
}

module.exports = { register, updateAll };
