// texCompare.js — hunks, placed on the rendered pages.
//
// Pure: no vscode, no fs, never throws. Everything it needs from the render map
// arrives as injected functions, so the headless suites can drive it with a
// fake map and the module never pulls vscode into the require cache.
//
// THE HARD PART IS NOT THE DIFF, IT IS SAYING WHERE A CHANGE IS.
//
// Measured on the reference paper this session: 71% of display-equation source
// lines carry NO SyncTeX record at all, so "map the hunk's lines to rows" fails
// for most equation edits. And an insertion — text that exists only in the
// other version — has no position in the current render BY CONSTRUCTION; there
// is nothing on the page to point at.
//
// Silently dropping those would make the feature quietly lie: the reader would
// see three marks, believe that is everything, and miss the fourth change. So
// placement is one explicit five-valued answer, every hunk gets one, and the
// ones that cannot be drawn are still counted and listed.

const { diffLines, refineHunk, splitLines } = require('./texDiff');
const { sha256 } = require('./texModel');

/** How confidently a hunk was placed on the page. Ordered, best first. */
const WHERE = {
    ROWS: 'rows',        // the lines' own typeset rows — exact
    OBJECT: 'object',    // the enclosing object's rows — the right thing, not the right lines
    GAP: 'gap',          // an insertion: a caret between two rows, never a wash
    PAGE: 'page',        // the page is known and nothing finer is
    NONE: 'none',        // listed, not drawn
};

const keyOf = (o) => (o ? (o.stableKey || `${o.kind}:${o.startLine}-${o.endLine}`) : '');
const label = (o) => (o.label ? `${o.kind} ${o.label}` : (o.envName || o.kind));

function safeRows(map, line) {
    if (line < 1) return [];
    try {
        const r = map.rowsFor(line);
        return Array.isArray(r) ? r.filter(x => x && x.w > 0) : [];
    } catch (_) { return []; }
}
function safeCall(map, name, ...args) {
    if (typeof map[name] !== 'function') return null;
    try { return map[name](...args); } catch (_) { return null; }
}

/**
 * Where a hunk should be marked.
 *
 * `map` is the injected view of the render map:
 *   rowsFor(line)             -> [{page,x,y,w,h}]
 *   objectAtLine(line)        -> {kind,startLine,endLine,stableKey,label,approximate} | null
 *   objectRects(obj)          -> [{page,x,y,w,h}]
 *   locate(startLine,endLine) -> {page, exact, matchedLine} | null
 *
 * @returns {{where:string, rects:Array, page:number|null,
 *            confidence:'exact'|'near'|'object'|'page'|'unknown', why:string}}
 */
function placeHunk(map, hunk) {
    const nowhere = (why) => ({ where: WHERE.NONE, rects: [], page: null, confidence: 'unknown', why });
    if (!map || typeof map.rowsFor !== 'function') return nowhere('no render map');

    const { aStart, aEnd } = hunk;

    // AN INSERTION HAS NO POSITION OF ITS OWN. It is not that we failed to find
    // one — there is nothing on the page yet. Point at the seam instead: below
    // the line before it, or above the line after.
    if (aEnd === aStart) {
        const before = safeRows(map, aStart - 1);
        const after = safeRows(map, aStart);
        const b = before.length ? before[before.length - 1] : null;
        const a = after.length ? after[0] : null;
        if (!b && !a) return nowhere('nothing rendered around the insertion point');
        const anchor = (b && a && b.page === a.page) ? { ...b, y: b.y + b.h } : (b || a);
        return {
            where: WHERE.GAP,
            rects: [{ page: anchor.page, x: anchor.x, y: anchor.y, w: anchor.w, h: 0, caret: true }],
            page: anchor.page,
            confidence: 'near',
            why: 'inserted text has no position in this render; marked at the seam',
        };
    }

    // THE LINES' OWN ROWS, when they have any.
    const rects = [];
    let withRows = 0;
    for (let n = aStart; n < aEnd; n++) {
        const rows = safeRows(map, n);
        if (rows.length) withRows++;
        for (const r of rows) rects.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h });
    }
    const lines = aEnd - aStart;
    if (rects.length && withRows === lines) {
        return { where: WHERE.ROWS, rects, page: rects[0].page, confidence: 'exact', why: '' };
    }
    if (rects.length) {
        return {
            where: WHERE.ROWS, rects, page: rects[0].page, confidence: 'near',
            why: `${withRows} of ${lines} lines are placed; the rest carry no record`,
        };
    }

    // NO ROWS AT ALL — the 71% case. Fall back to the enclosing OBJECT, which is
    // the honest answer: the right thing, not the right lines.
    const obj = safeCall(map, 'objectAtLine', aStart);
    if (obj && !obj.approximate) {
        const orects = safeCall(map, 'objectRects', obj) || [];
        if (orects.length) {
            return {
                where: WHERE.OBJECT, rects: orects, page: orects[0].page, confidence: 'object',
                why: `these lines carry no record; showing ${label(obj)}`,
            };
        }
    }

    // A PAGE, AND NOTHING FINER. `locate` searches outward, so check it did not
    // land in someone ELSE's object — a borrowed box painted confidently over
    // the paragraph above an equation is worse than drawing nothing at all.
    const hit = safeCall(map, 'locate', aStart, aEnd - 1);
    if (hit && hit.page != null) {
        if (hit.exact === false && Number.isFinite(hit.matchedLine)) {
            const there = safeCall(map, 'objectAtLine', hit.matchedLine);
            if (keyOf(there) !== keyOf(obj)) {
                return nowhere('the nearest record belongs to a different object');
            }
        }
        return {
            where: WHERE.PAGE, rects: [], page: hit.page, confidence: 'page',
            why: `on page ${hit.page}; no finer position is recorded`,
        };
    }
    return nowhere('nothing on any page maps to these lines');
}

function lineStarts(text) {
    const out = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
    return out;
}
function offsetOfLine(starts, line, text) {
    if (line <= 1) return 0;
    if (line - 1 < starts.length) return starts[line - 1];
    return text.length;
}

/**
 * The whole comparison: what differs, what it is called, and where it is.
 *
 * SCOPE NOTE. A hunk is named by the object it lands in **in our document**
 * (`objectAtLine`). Naming a their-side-only object — "this whole equation is
 * new" — wants `texModel.reconcile` across the two versions, which is a real
 * step and is deliberately not taken yet: reconcile MUTATES the model it is
 * given, and the live model's objectIds are what `paper_applyEdit`'s guard
 * checks against.
 *
 * @param {object} o
 * @param {string} o.ourText     the current document
 * @param {string} o.theirText   the other version
 * @param {object} o.map         the injected render-map view (see placeHunk)
 * @param {number} [o.limit]     cap the hunks reported (an old revision can
 *                               produce hundreds, and posting all their text is
 *                               slow and useless)
 */
/**
 * Join changes that a reader would call ONE change.
 *
 * diffLines splits at every identical line, which is right for a diff and
 * wrong for a worklist: a six-line equation with edits on lines 2, 4 and 5
 * arrives as THREE items, all of them named "display-equation eq:…", all on the
 * same page, and every one of them has to be approved separately. Reported as
 * "many small items which are in the same place".
 *
 * Two hunks become one when either holds:
 *
 *   - they are inside the SAME addressable object. An equation is one thing to
 *     agree to; nobody keeps half of one.
 *   - nothing separates them at all. `gap` defaults to ZERO, and that is a
 *     measured decision rather than caution: at 1, a document the agent
 *     rewrote on every other line — every hunk with a single paired line
 *     between it and the next — collapses into ONE item covering the paper,
 *     which is a worse answer than the many-small-items it was meant to fix.
 *
 * The lines between two merged hunks are identical on both sides — that is why
 * the diff paired them — so the union's slice of OURS and of THEIRS both carry
 * them unchanged, and the merged hunk's text is still exactly what to keep or
 * put back. The kind is recomputed from the union rather than carried over: an
 * `add` merged across context is a `change`.
 */
function coalesceHunks(hunks, objectAt, gap) {
    if (!hunks.length) return hunks;
    const keyAt = (line) => {
        const o = objectAt(line);
        return o ? keyOf(o) : '';
    };
    const out = [hunks[0]];
    for (let i = 1; i < hunks.length; i++) {
        const cur = hunks[i];
        const prev = out[out.length - 1];
        const between = cur.aStart - prev.aEnd;         // identical lines in ours
        const sameObject = (() => {
            const a = keyAt(prev.aStart);
            return !!a && a === keyAt(cur.aStart);
        })();
        if (between <= gap || sameObject) {
            prev.aStart = Math.min(prev.aStart, cur.aStart);
            prev.aEnd = Math.max(prev.aEnd, cur.aEnd);
            prev.bStart = Math.min(prev.bStart, cur.bStart);
            prev.bEnd = Math.max(prev.bEnd, cur.bEnd);
            prev.kind = prev.aEnd === prev.aStart ? 'add'
                : (prev.bEnd === prev.bStart ? 'del' : 'change');
            continue;
        }
        out.push(cur);
    }
    return out;
}

function buildComparison(o = {}) {
    const ourText = String(o.ourText == null ? '' : o.ourText);
    const theirText = String(o.theirText == null ? '' : o.theirText);
    const map = o.map || {};
    const limit = Number.isFinite(o.limit) ? o.limit : 200;

    const A = splitLines(ourText);
    const B = splitLines(theirText);
    // One item per THING CHANGED, not one per run of changed lines.
    const all = coalesceHunks(
        diffLines(A, B),
        (line) => safeCall(map, 'objectAtLine', line),
        Number.isFinite(o.coalesceGap) ? o.coalesceGap : 0);
    const starts = lineStarts(ourText);

    const hunks = [];
    const idSeen = new Map();
    for (const h of all.slice(0, limit)) {
        const ours = A.slice(h.aStart - 1, h.aEnd - 1).join('\n');
        const theirs = B.slice(h.bStart - 1, h.bEnd - 1).join('\n');
        const obj = safeCall(map, 'objectAtLine', h.aStart);
        const placement = placeHunk(map, h);
        const words = (h.kind === 'change') ? refineHunk(ours, theirs) : null;
        const startOffset = offsetOfLine(starts, h.aStart, ourText);
        const endOffset = h.aEnd > h.aStart
            ? Math.max(startOffset, offsetOfLine(starts, h.aEnd, ourText) - 1)
            : startOffset;
        // CONTENT-DERIVED, so a hunk keeps its identity when the lines around it
        // move — a line number would not survive one accept, nor an edit
        // somewhere above.
        //
        // ONLY the content. The enclosing object was in this hash at first, and
        // that quietly broke the property it exists for: insert three lines
        // above a change and the object at that line differs, so the "stable"
        // id changed and the reader's place in the list was lost. Two identical
        // changes in different places are told apart by an occurrence suffix
        // instead, which depends on their ORDER rather than their surroundings.
        const base = sha256(`${h.kind} ${ours} ${theirs}`).slice(0, 12);
        const nth = (idSeen.get(base) || 0) + 1;
        idSeen.set(base, nth);
        hunks.push({
            id: nth === 1 ? base : `${base}~${nth}`,
            kind: h.kind,
            ourRange: { startLine: h.aStart, endLine: h.aEnd },
            theirRange: { startLine: h.bStart, endLine: h.bEnd },
            ourText: ours,
            theirText: theirs,
            object: obj
                ? { stableKey: obj.stableKey, kind: obj.kind, label: obj.label, name: label(obj) }
                : null,
            changedWords: words ? words.aRanges.length : 0,
            anchor: { startOffset, endOffset, beforeHash: sha256(ours) },
            ...placement,
        });
    }

    const seen = (w) => hunks.filter(h => h.where === w).length;
    return {
        hunks,
        summary: {
            total: all.length,
            shown: hunks.length,
            truncated: Math.max(0, all.length - hunks.length),
            added: hunks.filter(h => h.kind === 'add').length,
            removed: hunks.filter(h => h.kind === 'del').length,
            changed: hunks.filter(h => h.kind === 'change').length,
            onPage: seen(WHERE.ROWS),
            approximate: seen(WHERE.OBJECT) + seen(WHERE.GAP) + seen(WHERE.PAGE),
            unplaced: seen(WHERE.NONE),
        },
    };
}

/** A one-line census, which is the whole honesty story of the feature. */
function describeSummary(s) {
    if (!s || !s.total) return 'no differences';
    const bits = [`${s.total} change${s.total === 1 ? '' : 's'}`];
    if (s.onPage) bits.push(`${s.onPage} on the page`);
    if (s.approximate) bits.push(`${s.approximate} approximate`);
    if (s.unplaced) bits.push(`${s.unplaced} not locatable`);
    if (s.truncated) bits.push(`${s.truncated} not shown`);
    return bits.join(' · ');
}

module.exports = { buildComparison, coalesceHunks, placeHunk, describeSummary, WHERE };
