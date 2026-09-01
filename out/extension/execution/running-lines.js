'use strict';
// running-lines.js — mark the lines of a cell that are running RIGHT NOW.
//
// A cell is not evaluated as one thing. checkout.js splits it into top-level
// sub-expressions (utils/wl-parse) and sends them to the kernel one at a time,
// and each part already carries the line range it came from — so which lines
// are executing at any moment is known and was simply never shown. VS Code's
// own spinner says "this cell"; on a thirty-line cell that is not the question
// a reader is asking, which is "where has it got to".
//
// SUBTLE ON PURPOSE. This paints while the reader is watching a computation
// they are already anxious about; it has to be findable at a glance and then
// stay out of the way. A slow, narrow-band breath does that. Anything with
// contrast enough to notice from across the room would be unbearable at thirty
// seconds. The numbers are all named below — they are the whole design.

const vscode = require('vscode');

// One full breath. Slower than a UI spinner on purpose: this is ambient state,
// not a progress bar, and a fast pulse next to text you are trying to read is
// the definition of distracting.
const CYCLE_MS = 1800;
const STEPS = 6;
// The band. The low end must still be visible as "these lines"; the high end
// must not compete with the syntax colouring on top of it.
const ALPHA_LO = 0.07;
const ALPHA_HI = 0.19;

/**
 * The breath curve: a raised cosine, so the ends ease instead of stepping.
 * Pure — this is the part worth testing.
 * @param {number} step 0..steps-1
 * @returns {number} alpha in [lo, hi]
 */
function pulseAlpha(step, steps = STEPS, lo = ALPHA_LO, hi = ALPHA_HI) {
    if (!(steps > 0)) return lo;
    const phase = ((step % steps) + steps) % steps / steps;      // 0..1
    const wave = (1 - Math.cos(2 * Math.PI * phase)) / 2;        // 0..1..0
    return lo + (hi - lo) * wave;
}

/**
 * The line range to paint, clamped to the document that will receive it.
 *
 * A sub-expression's range comes from the source text as it was when the split
 * ran; the cell can be edited while it runs. Clamping is what keeps a stale
 * range from throwing, and returning null for a range that has fallen entirely
 * off the end is better than painting the last line as though it were running.
 *
 * @param {{startLine:number,endLine:number}} sub
 * @param {number} lineCount
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

/**
 * Should the mark animate?
 *
 * VS Code does not surface the OS's prefers-reduced-motion to extensions, but
 * `workbench.reduceMotion` is the setting a reader who wants less of it will
 * have set. On, the lines are still marked — only the breathing stops, because
 * WHICH lines are running is information and the animation is decoration.
 * @param {string} reduceMotion 'on' | 'off' | 'auto'
 */
function shouldAnimate(reduceMotion) {
    return String(reduceMotion || 'auto') !== 'on';
}

// --- the decoration itself ------------------------------------------------

let _types = null;          // one decoration type per step of the breath
let _timer = null;
let _step = 0;
let _active = null;         // { uri, range } — what is painted, if anything

function _makeTypes() {
    if (_types) return _types;
    _types = [];
    for (let i = 0; i < STEPS; i++) {
        _types.push(vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: `rgba(255, 205, 60, ${pulseAlpha(i).toFixed(3)})`,
            // The ruler mark does NOT pulse: a blinking tick in the scrollbar is
            // exactly the kind of peripheral motion this is trying to avoid, and
            // its job is only to say "the work is over here" on a long cell.
            overviewRulerColor: 'rgba(255, 205, 60, 0.55)',
            overviewRulerLane: vscode.OverviewRulerLane.Center,
        }));
    }
    return _types;
}

function _editorFor(uriString) {
    return (vscode.window.visibleTextEditors || [])
        .find(e => e.document && e.document.uri.toString() === uriString) || null;
}

function _paint() {
    const types = _makeTypes();
    if (!_active) {
        // Nothing running: every editor showing any of these must be cleared,
        // not just the one we last painted — a cell editor can be recreated
        // (scrolled out and back) while a decoration is on it.
        for (const ed of (vscode.window.visibleTextEditors || [])) {
            for (const t of types) { try { ed.setDecorations(t, []); } catch (_) {} }
        }
        return;
    }
    const ed = _editorFor(_active.uri);
    if (!ed) return;                       // cell scrolled out of view; nothing to do
    const r = rangeFor(_active.range, ed.document.lineCount);
    if (!r) { clearRunning(); return; }
    let range;
    try {
        range = [new vscode.Range(r.startLine, 0, r.endLine,
            ed.document.lineAt(r.endLine).text.length)];
    } catch (_) { return; }
    for (let i = 0; i < types.length; i++) {
        try { ed.setDecorations(types[i], i === _step ? range : []); } catch (_) {}
    }
}

function _enabled() {
    try {
        return vscode.workspace.getConfiguration('wolfbook.notebook')
            .get('highlightRunningLines', true) !== false;
    } catch (_) { return true; }
}

function _reduceMotion() {
    try { return vscode.workspace.getConfiguration('workbench').get('reduceMotion', 'auto'); }
    catch (_) { return 'auto'; }
}

/**
 * Mark `sub`'s lines in `cell` as the ones running now.
 * Safe to call repeatedly; each call replaces the previous mark.
 */
function showRunning(cell, sub) {
    if (!cell || !cell.document || !sub) return;
    if (!_enabled()) return;
    const r = rangeFor(sub, cell.document.lineCount);
    if (!r) { clearRunning(); return; }
    _active = { uri: cell.document.uri.toString(), range: r };
    _step = 0;
    _paint();
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (!shouldAnimate(_reduceMotion())) return;         // marked, but still
    _timer = setInterval(() => {
        _step = (_step + 1) % STEPS;
        _paint();
    }, Math.max(60, Math.round(CYCLE_MS / STEPS)));
}

/**
 * Take the mark away.
 *
 * Called from the cell's `finally`, so it runs on success, failure, abort and
 * kernel death alike. A mark left behind would say a computation is running
 * when none is — the worst thing this feature could do, and worse than never
 * having painted it.
 */
function clearRunning() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    _active = null;
    if (_types) _paint();
}

/** Re-apply after a visibility change — a cell scrolled back into view. */
function refresh() { if (_active) _paint(); }

function dispose() {
    clearRunning();
    if (_types) { for (const t of _types) { try { t.dispose(); } catch (_) {} } }
    _types = null;
}

module.exports = {
    showRunning, clearRunning, refresh, dispose,
    // pure, for tests
    pulseAlpha, rangeFor, shouldAnimate,
    CYCLE_MS, STEPS, ALPHA_LO, ALPHA_HI,
};
