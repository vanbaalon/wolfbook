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
const {historyLimits,historyBytes,trimHistory}=require('./reviewHistory');
const { buildComparison, describeSummary, placeHunk, WHERE } = require('./texCompare');

/** What the reader is being asked about — the agent's verb, not the diff's. */
const VERB = { ADD: 'add', DEL: 'del', CHANGE: 'change' };

/**
 * `diffLines(ours, theirs)` calls a hunk `add` when OURS has nothing there.
 * Ours is the document as it is now and theirs is the agreed baseline, so a
 * hunk with nothing on our side is text the agent REMOVED. Presenting the raw
 * kind would tell the reader the exact opposite of what happened.
 */
function verbOf(h) {
    if (h.contentKind==='add') return VERB.DEL;
    if (h.contentKind==='del') return VERB.ADD;
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
        this.gitAuthors = new Map();
        this.firstSeen = new Map();     // hunkId -> batchId
        this.edited = new Set();        // hunkIds the reader has since typed inside
        this.decided = [];              // {id, verb, name, action, at} — recent history
        this.hunks = [];
        this.summary = {};
        this._lastText = null;          // the document text of the last update
        // WHICH RENDER THE RECTS DESCRIBE. A placement is true only of the
        // pages it was measured against; carried so the panel can refuse to
        // draw one over a render it does not describe.
        this.generation = null;
        this.feedback = [];
        this.feedbackDraft = '';
        this.arrivals = [];
        Object.assign(this,historyLimits(o));
    }

    serialize() {
        return { file: this.file, baseText: this.baseText, openedAt: this.openedAt,
            batches: this.batches, batchSeq: this._batchSeq, current: this._current,
            gitAuthors:[...this.gitAuthors], firstSeen: [...this.firstSeen], edited: [...this.edited], decided: this.decided,
            lastText: this._lastText, reviewedObservedHash: this.reviewedObservedHash,
            feedback: this.feedback, feedbackDraft: this.feedbackDraft, arrivals: this.arrivals };
    }
    static restore(value, options={}) {
        const s = new ReviewSession({...value,...historyLimits(options)});
        s.openedAt = value.openedAt || s.openedAt;
        s.batches = value.batches || []; s._batchSeq = value.batchSeq || 0; s._current = value.current;
        s.gitAuthors = new Map(value.gitAuthors || []);
        s.firstSeen = new Map(value.firstSeen || []); s.edited = new Set(value.edited || []);
        s.decided = value.decided || []; s.feedback = value.feedback || []; s.arrivals = value.arrivals || [];
        trimHistory(s.arrivals,s);
        s.feedbackDraft = value.feedbackDraft || '';
        s.reviewedObservedHash = value.reviewedObservedHash;
        if (typeof value.lastText === 'string') s.update({ currentText: value.lastText });
        return s;
    }

    recordArrival(o = {}) {
        const text = String(o.text ?? '');
        const previous = this.arrivals[this.arrivals.length - 1];
        if (previous && previous.after === text) return;
        this.arrivals.push({ at: o.at || this.now(), source: o.source || 'external/unknown',
            author: o.author || null, before: this._lastText ?? this.baseText, after: text });
        const entry=this.arrivals[this.arrivals.length-1];entry.historyBytes=historyBytes(entry);
        trimHistory(this.arrivals,this);
    }
    addFeedback(id, comment) {
        const h = this.hunks.find(h => h.id === id);
        if (!h) return false;
        const batch = this.batches.find(b => b.id === this.firstSeen.get(id));
        this.feedback.push({ id, at: this.now(), file: this.file, line: h.ourRange.startLine,
            endLine: h.ourRange.endLine, name: h.object?.name || null, comment: String(comment),
            object: h.object ? {
                stableKey: h.object.stableKey || null,
                kind: h.object.kind || null,
                label: h.object.label || null,
            } : null,
            author: batch?.author || null, before: h.theirText, after: h.ourText });
        this.feedbackDraft += (this.feedbackDraft ? '\n\n' : '') +
            `### ${this.file}:${h.ourRange.startLine} — ${h.object?.name || 'reviewed change'}\n` +
            `${new Date(this.now()).toISOString()} · ${batch?.author?.name || 'external/unknown'}${batch?.author?.sessionId ? ' · ' + batch.author.sessionId : ''}\n` +
            `Change ${id} (line at review time)\n${String(comment)}`;
        return true;
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
        if (last && this.groupWindowMs > 0 && last.source === source && JSON.stringify(last.author || null) === JSON.stringify(o.author || null) &&
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
            author: o.author || null,
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
            const neutral=o.readerChanges && this._lastText!=null &&
                !require('./renderChange').editImpact(currentText,o.readerChanges,this._lastText).renderChanged;
            if (this._lastText!=null && (neutral || currentText===this._lastText && this.baseText===this._lastBaseText)) {
                const lines=linesOf(currentText);
                const starts=lineStarts(currentText);
                const hunks=this.hunks.map(h=> {
                    const ourText=sliceLines(lines,h.ourRange.startLine,h.ourRange.endLine).join('\n');
                    const startOffset=offsetOfLine(starts,h.ourRange.startLine,currentText);
                    const endOffset=h.ourRange.endLine>h.ourRange.startLine ?
                        Math.max(startOffset,offsetOfLine(starts,h.ourRange.endLine,currentText)-1) : startOffset;
                    return {...h,ourText,contextual:false,...placeHunk(o.map || {},{
                        aStart:h.ourRange.startLine,aEnd:h.ourRange.endLine,contentKind:h.contentKind}),
                        anchor:{...h.anchor,startOffset,endOffset,beforeHash:require('./texModel').sha256(ourText)}};
                });
                const count=w=>hunks.filter(h=>h.where===w).length;
                built={hunks,sameContent:false,formatting:[],summary:{...this.summary,
                    onPage:count(WHERE.ROWS),approximate:count(WHERE.OBJECT)+count(WHERE.GAP)+count(WHERE.PAGE),unplaced:count(WHERE.NONE)}};
            } else {
            // A review must include every undecided change. The ad-hoc compare
            // tool's output cap would also hide changes from Keep/Undo and navigation.
            built = buildComparison({ ourText: currentText, theirText: this.baseText, map: o.map || {},
                limit: Number.MAX_SAFE_INTEGER });
            // Follow ignored formatting in the internal baseline, so source
            // offsets still match for the reader's later typing and Keep/Undo.
            // Actual content changes remain undecided; no source file is edited.
            if (built.sameContent) this.baseText=currentText;
            else if (built.formatting.length) {
                const lines=linesOf(currentText);
                for (const h of built.formatting.slice().sort((a,b)=>b.bStart-a.bStart))
                    this.baseText=spliceLines(this.baseText,h.bStart,h.bEnd,
                        sliceLines(lines,h.aStart,h.aEnd));
                built=buildComparison({ourText:currentText,theirText:this.baseText,map:o.map || {},
                    limit:Number.MAX_SAFE_INTEGER});
            }
            }
        } catch (_) {
            return { hunks: this.hunks, summary: this.summary, census: describeSummary(this.summary) };
        }
        // WHICH SECTION EACH CHANGE IS IN, asked of the injected view (the model
        // knows; the render map is not consulted, so this still works on a
        // paper that will not compile). A file with no sectioning commands —
        // or a change above the first heading — simply has none, and the panel
        // gathers those under one heading of its own.
        const sectionOf = (line) => {
            try {
                const f = (o.map || {}).sectionAt;
                const s = typeof f === 'function' ? f(line) : null;
                return s && s.key ? { key: String(s.key), title: String(s.title || ''),
                    // The number LaTeX printed, when the last compile knew one.
                    number: s.number ? String(s.number) : null,
                    // Which file it is in, so clicking the heading in the list
                    // works for a section inside an \input as well as the root.
                    file: s.file ? String(s.file) : null,
                    level: Number(s.level) || 0, startLine: Number(s.startLine) || line } : null;
            } catch (_) { return null; }
        };
        const hunks = built.hunks.map(h => ({
            ...h, verb: verbOf(h), section: sectionOf(h.ourRange.startLine),
        }));

        const overlaps = (a, b) =>
            a.startLine < Math.max(b.endLine, b.startLine + 1) &&
            b.startLine < Math.max(a.endLine, a.startLine + 1);

        for (const h of hunks) {
            if (!this.firstSeen.has(h.id) && this.firstSeen.has(h.previousId)) {
                this.firstSeen.set(h.id,this.firstSeen.get(h.previousId));
                if (this.edited.has(h.previousId)) this.edited.add(h.id);
                if (this.gitAuthors.has(h.previousId)) this.gitAuthors.set(h.id,this.gitAuthors.get(h.previousId));
            }
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
        this._lastBaseText=this.baseText;
        const g = (o.map || {}).generation;
        this.generation = g == null ? null : g;
        this.livePages = (o.map || {}).livePages || null;
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
        if (inside) {
            // A deleted block may leave a whitespace-only replacement line.
            // Spaces typed into that seam are not an edit of the removed text.
            const cosmetic=!require('./renderChange').editImpact(doc.slice(0,at)+text+doc.slice(at+len),
                [{rangeOffset:at,rangeLength:len,text}],doc).renderChanged;
            if (!cosmetic) this.edited.add(inside.id);
            return false;
        }

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
        if (!this.hunks.some(h=>h.id===id)) return {ok:false,reason:'that change is no longer in the list'};
        return this.keepMany([id]);
    }

    keepAll() {
        return this.keepMany(this.hunks.map(h=>h.id));
    }

    /**
     * Keep a named set of changes — a batch, a section, anything the reader
     * pointed at as a group.
     *
     * BOTTOM-UP, ALWAYS: keeping splices text into the baseline, which moves
     * the line numbers of everything below it, so the lowest change has to be
     * dealt with while the ones above it still describe where they are.
     */
    keepMany(ids) {
        if (this._lastText==null) return {ok:false,reason:'nothing has been compared yet'};
        const want = new Set((ids || []).map(String));
        const mine = this.hunks.filter(h => want.has(h.id));
        if (!mine.length) return {ok:true,baseText:this.baseText,kept:[]};
        const ordered = mine.slice().sort((a, b) => b.theirRange.startLine - a.theirRange.startLine);
        if (mine.length && mine.length===this.hunks.length) this.baseText=this._lastText;
        else if (mine.length) {
            const base=linesOf(this.baseText),ours=linesOf(this._lastText);
            for (const h of ordered) base.splice(h.theirRange.startLine-1,
                h.theirRange.endLine-h.theirRange.startLine,...sliceLines(ours,h.ourRange.startLine,h.ourRange.endLine));
            this.baseText=joinLines(base);
        }
        for (const h of ordered) this._decide(h,'kept');
        // Approval changes only the baseline. Current source, word ranges,
        // placements and IDs remain valid; rebase remaining baseline ranges
        // directly instead of tokenizing/diffing the entire paper again.
        this.hunks=this.hunks.filter(h=>!want.has(h.id)).map(h=>{
            const delta=mine.filter(k=>k.theirRange.endLine<=h.theirRange.startLine).reduce((n,k)=>n+
                k.ourRange.endLine-k.ourRange.startLine-(k.theirRange.endLine-k.theirRange.startLine),0);
            return delta ? {...h,theirRange:{startLine:h.theirRange.startLine+delta,endLine:h.theirRange.endLine+delta}} : h;
        });
        this._lastBaseText=this.baseText;
        const count=f=>this.hunks.filter(f).length;
        this.summary={total:this.hunks.length,shown:this.hunks.length,truncated:0,
            added:count(h=>h.kind==='add'),removed:count(h=>h.kind==='del'),changed:count(h=>h.kind==='change'),
            onPage:count(h=>h.where===WHERE.ROWS),approximate:count(h=>[WHERE.OBJECT,WHERE.GAP,WHERE.PAGE].includes(h.where)),
            unplaced:count(h=>h.where===WHERE.NONE)};
        return { ok: true, baseText: this.baseText, kept: mine.map(h => h.id) };
    }

    keepBatch(batchId) {
        return this.keepMany(this._hunksOf(batchId).map(h => h.id));
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
        const wordCache=this._wordRangesCache ||= new Map();
        const live=new Set(this.hunks.map(h=>h.id));
        for(const id of wordCache.keys())if(!live.has(id))wordCache.delete(id);
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
                source: b.source, note: b.note, author: b.author || null,
                count: hs.length,
                hunks: hs.map(h => ({
                    id: h.id,
                    at: b.at, author: this.gitAuthors.get(h.id) || b.author || null, source: this.gitAuthors.has(h.id) ? 'git' : b.source,
                    verb: h.verb,
                    where: h.where, confidence: h.confidence, why: h.why, contextual:!!h.contextual,
                    page: h.page, rects: h.rects,
                    name: h.object ? h.object.name : null,
                    startLine: h.ourRange.startLine,
                    beforeLine: h.theirRange.startLine,
                    endLine: h.ourRange.endLine,
                    section: h.section || null,
                    lines: Math.max(h.ourRange.endLine - h.ourRange.startLine,
                        h.theirRange.endLine - h.theirRange.startLine),
                    changedWords: h.changedWords,
                    editedByYou: this.edited.has(h.id),
                    ourText: h.ourText,
                    theirText: h.theirText,
                    wordContext: h.wordContext,
                    // WHICH WORDS DIFFER, so the panel can show the change
                    // itself rather than two blocks of LaTeX to compare by eye.
                    // Computed here, from the same refineHunk the census
                    // counts with — the webview never grows a second differ.
                    words: wordRangesOf(h,wordCache),
                })),
            };
        }).sort((a, b) => b.lastAt - a.lastAt);

        return {
            file: this.file,
            pending: this.hunks.length,
            generation: this.generation, livePages:this.livePages || null,
            census: describeSummary(this.summary),
            summary: this.summary,
            groups,
            feedback: this.feedback.map(({ before, after, ...item }) => item),
            feedbackDraft: this.feedbackDraft,
            arrivals: this.arrivals.map(a => ({ at: a.at, source: a.source, author: a.author })),
            decided: this.decided.slice(0, 12),
            ...o,
        };
    }
}

/** The differing words on each side of a change, for the panel's diff pane. */
function wordRangesOf(h,cache) {
    if (h.verb !== VERB.CHANGE) return null;
    const context=JSON.stringify(h.wordContext || null),cached=cache?.get(h.id);
    if(cached && cached.ours===h.ourText && cached.theirs===h.theirText && cached.context===context)return cached.words;
    try {
        const { aRanges, bRanges } = refineHunk(h.ourText, h.theirText, h.wordContext);
        const words={ours:aRanges,theirs:bRanges};
        cache?.set(h.id,{ours:h.ourText,theirs:h.theirText,context,words});
        return words;
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
