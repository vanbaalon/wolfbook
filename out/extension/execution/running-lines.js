'use strict';
// running-lines.js — say which cell is running, and which of its lines.
//
// A cell is not evaluated as one thing. checkout.js splits it into top-level
// sub-expressions (utils/wl-parse) and sends them to the kernel one at a time,
// and each part already carries the line range it came from — so which lines
// are executing at any moment is known and was simply never shown.
//
// TWO MARKS, ONE FOR EACH QUESTION:
//
//   which CELL is running?  → a gold border around it. VS Code's own spinner
//     answers this too, but it is small and lives in the margin; on a scrolled
//     notebook the border is what you see from across the page.
//   which LINES of it?      → a faint wash on the current sub-expression.
//
// NEITHER MOVES. An earlier version breathed, and it was right that a moving
// mark is easy to find and wrong that you would want one: this paints while a
// reader is watching a computation they are already anxious about, for as long
// as it takes, and anything moving beside text is something you cannot stop
// looking at. Reported as distracting. A static mark is found once and then
// ignored, which is the whole job.

const vscode = require('vscode');

// The wash on the running lines. Deliberately at the bottom of the range where
// a background is still legible as a background — it sits UNDER syntax colours
// that must stay readable, and it has a gold border around the cell already
// telling the eye where to look.
const LINE_ALPHA = 0.09;
const GOLD = '255, 205, 60';
// The cell outline. A HAIRLINE, and translucent: it runs the whole way round a
// cell, so it has far more length to be loud with than the line wash has, and
// at 2px/0.85 it read as a hard yellow frame. One pixel at 0.42 still finds the
// cell from across the page and stops competing with the code inside it.
const BORDER_ALPHA = 0.42;
const BORDER_PX = 1;
// A QUEUED cell — accepted, not started. Dashed, because a broken line is what
// "not yet" looks like without needing a legend, and fainter still: several
// cells can be queued at once and they must read as a group waiting behind the
// one that is running, never as several things happening.
const QUEUED_ALPHA = 0.30;

let _types = null;

/**
 * Which border edges a line of the cell needs, so the four decorations
 * together outline the cell rather than boxing every line.
 * Pure — the part worth testing.
 * @returns {'single'|'top'|'middle'|'bottom'}
 */
function edgeFor(line, firstLine, lastLine) {
    if (firstLine === lastLine) return 'single';
    if (line === firstLine) return 'top';
    if (line === lastLine) return 'bottom';
    return 'middle';
}

/**
 * The line range to paint, clamped to the document that will receive it.
 *
 * A sub-expression's range comes from the source text as it was when the split
 * ran; the cell can be edited while it runs. Clamping is what keeps a stale
 * range from throwing, and returning null for a range that has fallen entirely
 * off the end is better than painting the last line as though it were running.
 *
 * @returns {{startLine:number,endLine:number}|null}
 */
function rangeFor(sub, lineCount) {
    if (!sub || !(lineCount > 0)) return null;
    const a = Number(sub.startLine);
    const b = Number(sub.endLine);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const lo = Math.max(0, Math.min(a, b));
    if (lo > lineCount - 1) return null;                 // wholly past the end
    const hi = Math.min(lineCount - 1, Math.max(a, b));
    return { startLine: lo, endLine: hi };
}

function _makeTypes() {
    if (_types) return _types;
    const border = (widths) => vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderStyle: 'solid',
        borderColor: `rgba(${GOLD}, ${BORDER_ALPHA})`,
        borderWidth: widths,
    });
    const p = `${BORDER_PX}px`;
    const dashed = (widths) => vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderStyle: 'dashed',
        borderColor: `rgba(${GOLD}, ${QUEUED_ALPHA})`,
        borderWidth: widths,
    });
    _types = {
        // The running sub-expression's lines.
        line: vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: `rgba(${GOLD}, ${LINE_ALPHA})`,
            overviewRulerColor: `rgba(${GOLD}, 0.55)`,
            overviewRulerLane: vscode.OverviewRulerLane.Center,
        }),
        // The cell outline, one type per edge case.
        single: border(p),
        top: border(`${p} ${p} 0 ${p}`),
        middle: border(`0 ${p} 0 ${p}`),
        bottom: border(`0 ${p} ${p} ${p}`),
        // The same outline, dashed, for a cell still waiting its turn.
        qSingle: dashed(p),
        qTop: dashed(`${p} ${p} 0 ${p}`),
        qMiddle: dashed(`0 ${p} 0 ${p}`),
        qBottom: dashed(`0 ${p} ${p} ${p}`),
    };
    return _types;
}

function _editorFor(uriString) {
    return (vscode.window.visibleTextEditors || [])
        .find(e => e.document && e.document.uri.toString() === uriString) || null;
}

let _active = null;         // { uri, range } — the running cell and its lines
let _queued = [];           // uri strings of cells accepted but not yet started

const RUN_EDGES = ['single', 'top', 'middle', 'bottom'];
const QUEUE_EDGES = ['qSingle', 'qTop', 'qMiddle', 'qBottom'];
const ALL_KEYS = ['line', ...RUN_EDGES, ...QUEUE_EDGES];

function _clearOn(editor, types) {
    for (const key of ALL_KEYS) {
        try { editor.setDecorations(types[key], []); } catch (_) {}
    }
}

/** Outline one editor's whole document with the given four edge types. */
function _outline(editor, types, keys) {
    const last = Math.max(0, editor.document.lineCount - 1);
    const buckets = { single: [], top: [], middle: [], bottom: [] };
    for (let n = 0; n <= last; n++) {
        let r = null;
        try { r = new vscode.Range(n, 0, n, editor.document.lineAt(n).text.length); }
        catch (_) { continue; }
        buckets[edgeFor(n, 0, last)].push(r);
    }
    const byEdge = { single: keys[0], top: keys[1], middle: keys[2], bottom: keys[3] };
    for (const edge of ['single', 'top', 'middle', 'bottom']) {
        try { editor.setDecorations(types[byEdge[edge]], buckets[edge]); } catch (_) {}
    }
}

function _paint() {
    const types = _makeTypes();
    // Start from a clean slate on every visible editor: a cell can move between
    // states (queued -> running -> done) and between them the OLD mark has to
    // go, or a finished cell keeps a dashed outline for ever.
    for (const ed of (vscode.window.visibleTextEditors || [])) _clearOn(ed, types);

    // Queued cells first, so a cell that is somehow in both lists ends up drawn
    // as RUNNING — the stronger and more specific claim.
    for (const uri of _queued) {
        if (_active && uri === _active.uri) continue;
        const ed = _editorFor(uri);
        if (ed) _outline(ed, types, QUEUE_EDGES);
    }

    if (!_active) return;
    const ed = _editorFor(_active.uri);
    if (!ed) return;                       // cell scrolled out of view
    _outline(ed, types, RUN_EDGES);

    // The lines of the sub-expression running right now.
    const sub = rangeFor(_active.range, ed.document.lineCount);
    const lines = [];
    if (sub) {
        for (let n = sub.startLine; n <= sub.endLine; n++) {
            try { lines.push(new vscode.Range(n, 0, n, ed.document.lineAt(n).text.length)); }
            catch (_) { /* line gone */ }
        }
    }
    try { ed.setDecorations(types.line, lines); } catch (_) {}
}

function _enabled() {
    try {
        return vscode.workspace.getConfiguration('wolfbook.notebook')
            .get('highlightRunningLines', true) !== false;
    } catch (_) { return true; }
}

/**
 * Mark `cell` as running and `sub`'s lines as the part running now.
 * Safe to call repeatedly; each call replaces the previous mark.
 */
function showRunning(cell, sub) {
    if (!cell || !cell.document || !sub) return;
    if (!_enabled()) return;
    const r = rangeFor(sub, cell.document.lineCount);
    if (!r) { clearRunning(); return; }
    _active = { uri: cell.document.uri.toString(), range: r };
    _paint();
}

/**
 * Take both marks away.
 *
 * Called from the cell's `finally`, so it runs on success, failure, abort and
 * kernel death alike. A mark left behind would say a computation is running
 * when none is — the worst thing this could do, and worse than never painting.
 */
function clearRunning() {
    _active = null;
    if (_types) _paint();
}

/**
 * The cells accepted for evaluation but not yet started.
 *
 * Separate from clearRunning on purpose: one cell finishing does not empty the
 * queue, and the queue emptying is not one cell finishing.
 */
function setQueued(cells) {
    if (!_enabled()) { _queued = []; if (_types) _paint(); return; }
    _queued = (cells || [])
        .map(c => { try { return c.document.uri.toString(); } catch (_) { return null; } })
        .filter(Boolean);
    _paint();
}

/** Re-apply after a visibility change — a cell scrolled back into view. */
function refresh() { if (_active || _queued.length) _paint(); }

function dispose() {
    _queued = [];
    clearRunning();
    if (_types) {
        for (const t of Object.values(_types)) { try { t.dispose(); } catch (_) {} }
    }
    _types = null;
}

module.exports = {
    showRunning, clearRunning, setQueued, refresh, dispose,
    // pure, for tests
    rangeFor, edgeFor,
    LINE_ALPHA, BORDER_ALPHA, BORDER_PX, QUEUED_ALPHA, GOLD,
};
