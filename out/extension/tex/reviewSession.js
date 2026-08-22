// reviewSession.js — what the agent changed, waiting for the reader's verdict.
//
// Pure: no vscode, no fs, never throws. The document, the editor and the panel
// all live in tex/reviewUi.js and tex/texViewer.js; this module owns the only
// thing that matters — WHAT IS STILL UNDECIDED — and the text arithmetic of
// deciding it.
//
// THE ONE IDEA: A BASELINE ONLY THE READER MOVES.
//
// The comparison this replaces diffed the document against "the text as it was
// a moment ago", and overwrote that text on every write. So a second agent
// batch silently erased the first from the list, which reads exactly like the
// first having been approved — the reported "previous changes are automatically
// approved and disappear". Here the diff is always
//
//     baseText  ->  the document now
//
// and `baseText` moves only when the reader KEEPS something (it is spliced in)
// or when the reader edits a region nobody is arguing about (below). Every
// pending change from every batch is therefore in one list, and a change leaves
// that list only by an explicit verdict.
//
// WHAT A BATCH IS: bookkeeping, nothing more. Hunk ids are content-derived and
// stable (texCompare), so `firstSeen` can say which arrival first showed a
// change without the grouping having any say in the diff.

const { splitLines, refineHunk } = require('./texDiff');
const { buildComparison, describeSummary } = require('./texCompare');

/** What the reader is being asked about — the agent's verb, not the diff's. */
const VERB = { ADD: 'add', DEL: 'del', CHANGE: 'change' };

/**
 * `diffLines(ours, theirs)` calls a hunk `add` when OURS has nothing there.
 * Ours is the document as it is now and theirs is the agreed baseline, so a
 * hunk with nothing on our side is text the agent REMOVED. Presenting the raw
 * kind would tell the reader the exact opposite of what happened.
 */
function verbOf(h) {
    if (h.ourRange.endLine === h.ourRange.startLine) return VERB.DEL;
    if (h.theirRange.endLine === h.theirRange.startLine) return VERB.ADD;
    return VERB.CHANGE;
}

const linesOf = (text) => splitLines(text);
const joinLines = (arr) => arr.join('\n');

/** The [startLine, endLine) slice of a line array, 1-based, end exclusive. */
function sliceLines(lines, startLine, endLine) {
    return lines.slice(Math.max(0, startLine - 1), Math.max(0, endLine - 1));
}

/** Replace [startLine, endLine) with `withLines`; returns the new text. */
function spliceLines(text, startLine, endLine, withLines) {
    const lines = linesOf(text);
    const head = lines.slice(0, Math.max(0, startLine - 1));
    const tail = lines.slice(Math.max(0, endLine - 1));
    return joinLines([...head, ...withLines, ...tail]);
}

class ReviewSession {
    /**
     * @param {object} o
     * @param {string} o.file      absolute path of the paper being reviewed
     * @param {string} o.baseText  the text the reader last agreed to
     * @param {() => number} [o.now]
     */
    constructor(o = {}) {
        this.file = o.file || '';
        this.baseText = String(o.baseText == null ? '' : o.baseText);
        this.now = typeof o.now === 'function' ? o.now : () => Date.now();
        this.openedAt = this.now();
        // AN ARRIVAL IS AN EPISODE, NOT A WRITE. See noteBatch.
        this.groupWindowMs = Number.isFinite(o.groupWindowMs) ? o.groupWindowMs : 60000;
        this.maxEpisodeMs = Number.isFinite(o.maxEpisodeMs) ? o.maxEpisodeMs : 10 * 60000;

        this.batches = [];              // {id, at, source, note, seen}
        this._batchSeq = 0;
        this._current = null;           // the batch new hunks belong to
        this.firstSeen = new Map();     // hunkId -> batchId
        this.edited = new Set();        // hunkIds the reader has since typed inside
        this.decided = [];              // {id, verb, name, action, at} — recent history
        this.hunks = [];
        this.summary = {};
        this._lastText = null;          // the document text of the last update
    }

    get pendingCount() { return this.hunks.length; }
    get isEmpty() { return this.hunks.length === 0; }

    /**
     * A new arrival. Hunks first seen after this belong to it.
     *
     * ONE EPISODE, NOT ONE WRITE. An agent working on a paper does not write
     * once: it rewrites the same paragraph twice, fixes the equation under it,
     * comes back to the sentence it started with. Each of those was its own
     * arrival, so the list filled with one-change groups — several of them
     * describing the same part of the paper — and a change that was rewritten
     * hopped from the group it was in to a new one. Reported as: *the model
     * may change the same part several times; those should be merged when they
     * are close together in time.*
     *
     * So consecutive writes from the same source join the arrival already
     * open, as long as the last one was less than `groupWindowMs` ago. The
     * episode is capped (`maxEpisodeMs`) so a slow trickle of writes cannot
     * roll one group forward for ever — an hour of work is not one arrival.
     *
     * A batch that has already been announced stays announced, which is the
     * point: an episode interrupts once, not once per write.
     */
    noteBatch(o = {}) {
        const at = o.at || this.now();
        const source = o.source || 'disk';
        const last = this.batches[this.batches.length - 1];
        if (last && this.groupWindowMs > 0 && last.source === source &&
            at - last.lastAt <= this.groupWindowMs && at - last.at <= this.maxEpisodeMs) {
            last.lastAt = at;
            last.writes += 1;
            if (o.note && !last.note) last.note = o.note;
            this._current = last.id;
            return last.id;
        }
        const id = `b${++this._batchSeq}`;
        this.batches.push({
            id, at, lastAt: at, writes: 1,
            source,
            note: o.note || '',
            seen: false,
        });
        this._current = id;
        return id;
    }

    /** Mark a batch as one the reader has been shown, so it is not re-announced. */
    markSeen(batchId) {
        const b = this.batches.find(x => x.id === batchId);
        if (b) b.seen = true;
    }
    get unseenBatches() { return this.batches.filter(b => !b.seen && this._hunksOf(b.id).length); }

    _hunksOf(batchId) { return this.hunks.filter(h => this.firstSeen.get(h.id) === batchId); }

    /**
     * Re-diff the baseline against the document as it is now.
     *
     * A NEW ID OVER AN OLD PLACE IS THE READER'S OWN TYPING. Ids are derived
     * from content, so editing inside a pending change produces a hunk with a
     * new id covering the same region — which would otherwise look like a
     * change that arrived from nowhere, in no batch. It inherits the batch of
     * the hunk it replaced and is flagged: Keep still means something there,
     * Undo would throw away the reader's own words and is refused.
     *
     * @param {object} o
     * @param {string} o.currentText
     * @param {object} [o.map]   the injected render-map view (see texCompare)
     */
    update(o = {}) {
        const currentText = String(o.currentText == null ? '' : o.currentText);
        const previous = this.hunks;
        let built;
        try {
            built = buildComparison({ ourText: currentText, theirText: this.baseText, map: o.map || {} });
        } catch (_) {
            return { hunks: this.hunks, summary: this.summary, census: describeSummary(this.summary) };
        }
        const hunks = built.hunks.map(h => ({ ...h, verb: verbOf(h) }));

        const overlaps = (a, b) =>
            a.startLine < Math.max(b.endLine, b.startLine + 1) &&
            b.startLine < Math.max(a.endLine, a.startLine + 1);

        for (const h of hunks) {
            if (this.firstSeen.has(h.id)) continue;
            const stood = previous.find(p => !hunks.some(x => x.id === p.id) &&
                overlaps(p.ourRange, h.ourRange));
            // "YOU EDITED THIS" MEANS THE READER TYPED HERE — NOTHING ELSE.
            //
            // It used to be inferred from "a hunk stood here and the text has
            // moved since", which is ALSO what a second agent write over the
            // same region looks like: the old content-derived id disappears and
            // a new one covers the same lines. Reported — a change the agent
            // had just made was labelled as the reader's, and Undo was withheld
            // for it. The only honest source is `noteReaderEdit`, which is
            // called for the reader's keystrokes and for nothing else; a flag
            // set there follows its content onto whatever id it becomes.
            if (stood && this.edited.has(stood.id)) {
                this.edited.add(h.id);
                this.firstSeen.set(h.id, this.firstSeen.get(stood.id) || this._current);
            } else {
                // Rewritten again by the agent: it belongs to the arrival that
                // rewrote it, not to the one it replaced.
                this.firstSeen.set(h.id, this._current);
            }
        }
        this.hunks = hunks;
        this.summary = built.summary;
        this._lastText = currentText;
        return { hunks, summary: built.summary, census: describeSummary(built.summary) };
    }

    /**
     * THE READER'S OWN EDIT IS NOT A CHANGE TO REVIEW.
     *
     * Outside the pending hunks the baseline and the document hold the same
     * text, so an edit landing there can be applied to BOTH — the diff is then
     * unchanged and the list does not grow a row for the reader's own typing.
     * An edit that lands INSIDE a pending hunk cannot be mirrored (there is no
     * matching text to put it in); that hunk is flagged instead, and the next
     * update carries the flag onto whatever id the new content produces.
     *
     * @param {{offset:number, length:number, text:string}} change
     *        offsets into the document as it was BEFORE the change
     * @returns {boolean} true when the baseline was advanced
     */
    noteReaderEdit(change) {
        if (!change || this._lastText == null) return false;
        const at = Number(change.offset) || 0;
        const len = Math.max(0, Number(change.length) || 0);
        const text = String(change.text == null ? '' : change.text);

        // Where every pending hunk sits in the document, as offsets.
        const doc = this._lastText;
        const starts = lineStarts(doc);
        let delta = 0;                 // baseline offset = document offset - delta
        let inside = null;
        for (const h of this.hunks) {
            const oFrom = offsetOfLine(starts, h.ourRange.startLine, doc);
            const oTo = offsetOfLine(starts, h.ourRange.endLine, doc);
            if (at + len > oFrom && at < oTo) { inside = h; break; }
            if (oTo <= at) {
                const ours = oTo - oFrom;
                const theirs = joinLines(sliceLines(linesOf(this.baseText),
                    h.theirRange.startLine, h.theirRange.endLine)).length +
                    (h.theirRange.endLine > h.theirRange.startLine ? 1 : 0);
                delta += ours - theirs;
            }
        }
        if (inside) { this.edited.add(inside.id); return false; }

        const bAt = at - delta;
        if (bAt < 0 || bAt + len > this.baseText.length) return false;
        // The same characters must be there, or this is not a common region.
        if (this.baseText.slice(bAt, bAt + len) !== doc.slice(at, at + len)) return false;
        this.baseText = this.baseText.slice(0, bAt) + text + this.baseText.slice(bAt + len);
        return true;
    }

    // ------------------------------------------------------------ verdicts --

    /** Keep one change: it becomes part of the agreed text. */
    keep(id) {
        const h = this.hunks.find(x => x.id === id);
        if (!h) return { ok: false, reason: 'that change is no longer in the list' };
        if (this._lastText == null) return { ok: false, reason: 'nothing has been compared yet' };
        const ours = sliceLines(linesOf(this._lastText), h.ourRange.startLine, h.ourRange.endLine);
        this.baseText = spliceLines(this.baseText, h.theirRange.startLine, h.theirRange.endLine, ours);
        this._decide(h, 'kept');
        return { ok: true, baseText: this.baseText };
    }

    keepAll() {
        const ids = this.hunks.map(h => h.id);
        if (this._lastText == null) return { ok: false, reason: 'nothing has been compared yet' };
        for (const h of this.hunks) this._decide(h, 'kept');
        this.baseText = this._lastText;
        return { ok: true, baseText: this.baseText, kept: ids };
    }

    keepBatch(batchId) {
        const mine = this._hunksOf(batchId);
        // Bottom-up: splicing changes the line numbers of everything below it.
        const ordered = mine.slice().sort((a, b) => b.theirRange.startLine - a.theirRange.startLine);
        for (const h of ordered) this.keep(h.id);
        return { ok: true, baseText: this.baseText, kept: mine.map(h => h.id) };
    }

    /**
     * Undo one change: the caller applies the returned whole-line edit to the
     * document, which is what makes it a single step on the editor's undo
     * stack. The baseline does not move — that text was never agreed to.
     */
    undo(id) {
        const h = this.hunks.find(x => x.id === id);
        if (!h) return { ok: false, reason: 'that change is no longer in the list' };
        if (this.edited.has(id)) {
            return { ok: false, reason: 'you have edited inside this change since it arrived — undoing it would throw your own words away' };
        }
        return { ok: true, edits: [this._undoEdit(h)] };
    }

    undoAll() {
        const doable = this.hunks.filter(h => !this.edited.has(h.id));
        // Bottom-up, so each edit's line numbers are still true when it lands.
        const edits = doable.slice()
            .sort((a, b) => b.ourRange.startLine - a.ourRange.startLine)
            .map(h => this._undoEdit(h));
        for (const h of doable) this._decide(h, 'undone');
        return {
            ok: true, edits,
            undone: doable.map(h => h.id),
            refused: this.hunks.filter(h => this.edited.has(h.id)).map(h => h.id),
        };
    }

    /** Record the verdict for the history strip; the diff itself drops the hunk. */
    _decide(h, action) {
        this.decided.unshift({
            id: h.id, verb: h.verb, action, at: this.now(),
            name: h.object ? h.object.name : null,
            startLine: h.ourRange.startLine,
        });
        if (this.decided.length > 40) this.decided.length = 40;
        if (action === 'undone') this.edited.delete(h.id);
    }

    /** The whole-line replacement that puts the baseline's text back. */
    _undoEdit(h) {
        const theirs = sliceLines(linesOf(this.baseText), h.theirRange.startLine, h.theirRange.endLine);
        return { startLine: h.ourRange.startLine, endLine: h.ourRange.endLine, lines: theirs };
    }

    /** Mark a hunk decided after the caller applied its undo edit. */
    noteUndone(id) {
        const h = this.hunks.find(x => x.id === id);
        if (h) this._decide(h, 'undone');
    }

    // ------------------------------------------------------------- payload --

    /** Everything the panel draws, in one message — the shape _postDiff uses. */
    payload(o = {}) {
        const byBatch = new Map();
        for (const h of this.hunks) {
            const b = this.firstSeen.get(h.id) || 'b0';
            if (!byBatch.has(b)) byBatch.set(b, []);
            byBatch.get(b).push(h);
        }
        const groups = [...byBatch.entries()].map(([id, hs]) => {
            const b = this.batches.find(x => x.id === id) ||
                { id, at: this.openedAt, lastAt: this.openedAt, writes: 1, source: 'unknown' };
            return {
                id, at: b.at, lastAt: b.lastAt || b.at, writes: b.writes || 1,
                source: b.source, note: b.note,
                count: hs.length,
                hunks: hs.map(h => ({
                    id: h.id,
                    verb: h.verb,
                    where: h.where, confidence: h.confidence, why: h.why,
                    page: h.page, rects: h.rects,
                    name: h.object ? h.object.name : null,
                    startLine: h.ourRange.startLine,
                    endLine: h.ourRange.endLine,
                    lines: Math.max(h.ourRange.endLine - h.ourRange.startLine,
                        h.theirRange.endLine - h.theirRange.startLine),
                    changedWords: h.changedWords,
                    editedByYou: this.edited.has(h.id),
                    ourText: h.ourText.slice(0, 4000),
                    theirText: h.theirText.slice(0, 4000),
                    // WHICH WORDS DIFFER, so the panel can show the change
                    // itself rather than two blocks of LaTeX to compare by eye.
                    // Computed here, from the same refineHunk the census
                    // counts with — the webview never grows a second differ.
                    words: wordRangesOf(h),
                })),
            };
        }).sort((a, b) => b.lastAt - a.lastAt);

        return {
            file: this.file,
            pending: this.hunks.length,
            census: describeSummary(this.summary),
            summary: this.summary,
            groups,
            decided: this.decided.slice(0, 12),
            ...o,
        };
    }
}

/** The differing words on each side of a change, for the panel's diff pane. */
function wordRangesOf(h) {
    if (h.verb !== VERB.CHANGE) return null;
    if ((h.ourText || '').length > 8000 || (h.theirText || '').length > 8000) return null;
    try {
        const { aRanges, bRanges } = refineHunk(h.ourText, h.theirText);
        return { ours: aRanges, theirs: bRanges };
    } catch (_) { return null; }
}

// --- offsets, kept local so nothing here needs texCompare's private helpers --
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

module.exports = { ReviewSession, VERB, verbOf, spliceLines, sliceLines };
