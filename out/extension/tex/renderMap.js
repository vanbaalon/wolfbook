// renderMap.js — the Continuous Render Map.
//
// Pure: no vscode, no child_process. Takes a CompileGeneration record plus the
// source model and answers where things are, in both directions.
//
// EVERY ANSWER CARRIES AN HONESTY FLAG. That is not decoration; it is the whole
// design. Stage 0 measured what this map can and cannot know:
//
//   PAGE-LEVEL IS ESSENTIALLY FREE AND ESSENTIALLY PERFECT. 100% page
//     agreement with the synctex CLI across 15 papers; T1 page-correctness
//     100% for equations and figures, 97% tables, 86% paragraphs — on any
//     project, with no instrumentation.
//   SHAPE IS NOT. Median IoU against real box geometry is 0.23 for equations.
//     Anything needing a tight box (Render Lens clipping, object-precise
//     inverse click) needs the LuaTeX tier, which is opt-in.
//   ONLY 31-71% OF SOURCE LINES CARRY ANY RECORD. The rest are blank lines,
//     comments, and lines whose material TeX attributed to a neighbour. The
//     `synctex` CLI hides this by searching outward silently; we search too,
//     and say `probably-current` instead of `fresh`.
//
// FLAGS
//   fresh              the generation's snapshot matches the current source
//                      AND the record was found on the exact line asked for
//   probably-current   the generation is current but the record came from a
//                      neighbouring line, or the range was translated through
//                      edits made since the compile
//   stale              the source has changed since this generation was built
//   unmapped           no record exists, at any tier, for this object

const {
    synctexBoxToRectSp, spToBp, iou, rectUnion, containment,
} = require('./texGeometry');
const {
    parseSynctex, tagForPath, locate, lineCoverage, boxesAtPoint,
} = require('./synctexParse');

const FLAG = {
    FRESH: 'fresh',
    PROBABLY_CURRENT: 'probably-current',
    STALE: 'stale',
    UNMAPPED: 'unmapped',
};

/** A SyncTeX record that cannot be real geometry — the CLI emits these too. */
function saneBox(b, pageSp) {
    if (!pageSp) return b.W > 0 || b.H > 0;
    const { widthSp, heightSp } = pageSp;
    return b.W <= widthSp * 1.01 && (b.H + b.D) <= heightSp * 1.01 &&
        b.h >= -widthSp * 0.01 && b.h + b.W <= widthSp * 1.01;
}

class RenderMap {
    /**
     * @param {object} o
     * @param {object} o.generation  a CompileGeneration record
     * @param {object} [o.model]     the texModel for the root file
     * @param {{widthBp,heightBp}} [o.pageSize]
     */
    constructor(o = {}) {
        this.generation = o.generation || null;
        this.model = o.model || null;
        this.pageSize = o.pageSize || { widthBp: 595.276, heightBp: 841.89 };
        this.doc = null;
        this.warnings = [];
        this._tagCache = new Map();
        this._editShift = new Map();   // file -> sorted [{fromLine, delta}]

        const p = this.generation && this.generation.synctexPath;
        if (o.synctexDoc) {
            // HANDED THE PREVIOUS GENERATION'S PARSE, because the .synctex.gz
            // bytes are identical (livePolicy.synctexUnchanged). Gunzipping and
            // parsing a real paper's file is pure waste when it did not move.
            //
            // The overlay remap below is SKIPPED for a reused doc: it was
            // applied when that doc was first built, and identical bytes imply
            // the same overlay state — saving a buffer changes which paths
            // SyncTeX records, which changes the bytes, which changes the hash.
            // Running it twice would map an already-mapped path again.
            this.doc = o.synctexDoc;
            this._reusedDoc = true;
        } else if (p) {
            try { this.doc = parseSynctex(p); }
            catch (e) { this.warnings.push(`synctex unreadable: ${e.message}`); }
        }
        // A live compile reads unsaved buffers out of a private overlay tree,
        // so SyncTeX records those paths. Everything downstream — the model,
        // the editor, the user — knows only the real project paths, so the
        // overlay prefix is mapped away here, once, at the boundary.
        const od = this.generation && this.generation.overlayDir;
        const pd = this.generation && this.generation.projectDir;
        if (this.doc && !this._reusedDoc && od && pd) {
            for (const [tag, f] of this.doc.inputs) {
                if (f.startsWith(od)) this.doc.inputs.set(tag, pd + f.slice(od.length));
            }
        }
        this.pageCount = this.doc ? this.doc.pages.size
            : (this.generation ? this.generation.pageCount : null);
    }

    get available() { return !!this.doc; }

    get pageSizeSp() {
        return {
            widthSp: this.pageSize.widthBp / spToBp(1),
            heightSp: this.pageSize.heightBp / spToBp(1),
        };
    }

    _tag(file) {
        if (this._tagCache.has(file)) return this._tagCache.get(file);
        const t = this.doc ? tagForPath(this.doc, file) : null;
        this._tagCache.set(file, t);
        return t;
    }

    /**
     * Record that the source moved since the compile, so ranges can be
     * translated rather than simply going stale. `delta` lines were inserted
     * (positive) or removed (negative) at `fromLine`.
     *
     * This is what buys `probably-current`: between compiles the map is not
     * wrong, it is displaced by a known amount, and saying so is far more
     * useful than refusing to answer.
     */
    noteEdit(file, fromLine, delta) {
        if (!delta) return;
        const list = this._editShift.get(file) || [];
        list.push({ fromLine, delta });
        list.sort((a, b) => a.fromLine - b.fromLine);
        this._editShift.set(file, list);
    }

    clearEdits(file) {
        if (file) this._editShift.delete(file); else this._editShift.clear();
    }

    get displaced() {
        for (const l of this._editShift.values()) if (l.length) return true;
        return false;
    }

    /** A CURRENT line -> the line it had when this generation was compiled. */
    _toGenerationLine(file, line) {
        const list = this._editShift.get(file);
        if (!list || !list.length) return { line, shifted: false };
        let shift = 0;
        for (const e of list) if (e.fromLine <= line) shift += e.delta;
        return { line: line - shift, shifted: shift !== 0 };
    }

    /** A generation line -> where it is in the CURRENT source. */
    _toCurrentLine(file, line) {
        const list = this._editShift.get(file);
        if (!list || !list.length) return line;
        let shift = 0;
        for (const e of list) if (e.fromLine <= line) shift += e.delta;
        return line + shift;
    }

    _baseFlag() {
        if (!this.generation) return FLAG.UNMAPPED;
        if (this.generation.stale) return FLAG.STALE;
        return this.displaced ? FLAG.PROBABLY_CURRENT : FLAG.FRESH;
    }

    /**
     * SOURCE -> RENDER. A source line range becomes boxes, per page.
     * @returns {{flag, pages:number[], page:number|null, boxes:object[],
     *            exact:boolean, matchedLine:number|null, reason?:string}}
     */
    sourceToRender(file, startLine, endLine = startLine) {
        if (!this.doc) {
            return { flag: FLAG.UNMAPPED, pages: [], page: null, boxes: [], exact: false, matchedLine: null,
                reason: this.generation ? 'no synctex for this generation' : 'never compiled' };
        }
        const tag = this._tag(file);
        if (tag == null) {
            return { flag: FLAG.UNMAPPED, pages: [], page: null, boxes: [], exact: false, matchedLine: null,
                reason: 'this file is not in the compiled document' };
        }
        const a = this._toGenerationLine(file, startLine);
        const b = this._toGenerationLine(file, endLine);
        const hit = locate(this.doc, tag, a.line, b.line);
        if (!hit) {
            return { flag: FLAG.UNMAPPED, pages: [], page: null, boxes: [], exact: false, matchedLine: null,
                reason: 'no SyncTeX record on or near these lines' };
        }

        const pageSp = this.pageSizeSp;
        const boxes = hit.boxes
            .filter(x => saneBox(x, pageSp))
            .map(x => this._toRect(x));

        let flag = this._baseFlag();
        // Two independent reasons to soften `fresh`: the record came from a
        // neighbouring line, or we translated the range through an edit.
        if (flag === FLAG.FRESH && (!hit.exact || a.shifted || b.shifted)) flag = FLAG.PROBABLY_CURRENT;

        return {
            flag,
            pages: hit.pages,
            page: hit.page,
            boxes,
            exact: hit.exact && !a.shifted && !b.shifted,
            matchedLine: hit.exact ? startLine : this._toCurrentLine(file, hit.matchedLine),
        };
    }

    _toRect(b) {
        const r = synctexBoxToRectSp(b);
        return {
            page: b.page,
            kind: b.type,
            line: b.line,
            xBp: spToBp(r.x),
            yTopBp: spToBp(r.yTop),
            wBp: spToBp(r.w),
            hBp: spToBp(r.h),
        };
    }

    /** Which page is this object on? The question the gutter asks. */
    pageForObject(obj) {
        const r = this.sourceToRender(
            obj.sourceRange.file, obj.sourceRange.startLine, obj.sourceRange.endLine);
        return { page: r.page, pages: r.pages, flag: r.flag, reason: r.reason };
    }

    /**
     * The box(es) an object occupies, one union per page.
     *
     * Deliberately a LIST, not a box: a paragraph spanning a page break is not
     * one rectangle, and every tier scores paragraphs worst (T3c 0.7%). An API
     * that returns a single box makes that case unrepresentable.
     */
    objectRenderBoxes(obj) {
        const r = this.sourceToRender(
            obj.sourceRange.file, obj.sourceRange.startLine, obj.sourceRange.endLine);
        if (!r.boxes.length) return { flag: r.flag, rects: [], reason: r.reason };
        const byPage = new Map();
        for (const b of r.boxes) {
            const cur = byPage.get(b.page) || [];
            cur.push({ x: b.xBp, y: b.yTopBp, w: b.wBp, h: b.hBp });
            byPage.set(b.page, cur);
        }
        const rects = [...byPage.entries()]
            .map(([page, rs]) => ({ page, ...rectUnion(rs) }))
            .sort((a, b) => a.page - b.page);
        return { flag: r.flag, rects, exact: r.exact };
    }

    /**
     * RENDER -> SOURCE. A point on a page becomes the tightest source object.
     *
     * The pipeline the plan describes: SyncTeX candidates -> tightest box ->
     * the semantic object whose range contains that line. Returning the object
     * rather than "approximately line 183" is the entire point.
     */
    renderToSource(page, xBp, yTopBp, opts = {}) {
        if (!this.doc) return { flag: FLAG.UNMAPPED, reason: 'never compiled' };
        const hSp = xBp / spToBp(1);
        const vSp = yTopBp / spToBp(1);
        const hits = boxesAtPoint(this.doc, page, hSp, vSp)
            .filter(b => saneBox(b, this.pageSizeSp));
        if (!hits.length) return { flag: FLAG.UNMAPPED, reason: 'nothing at that point on this page' };

        // Tightest first (boxesAtPoint already sorts by area), then widen until
        // a record names a file we know.
        //
        // TIGHTEST IS NOT ALWAYS RIGHT. `\[` puts a zero-width record on the
        // line ABOVE the display, so a click on the last words of a paragraph
        // resolved to the equation below it. When the caller can check a
        // candidate against something it knows independently — the word the
        // PDF's own text layer reports under the pointer — that evidence beats
        // the box hierarchy. With no `accept`, behaviour is unchanged.
        const accept = typeof opts.accept === 'function' ? opts.accept : null;
        let fallback = null;
        for (const b of hits) {
            const file = this.doc.inputs.get(b.tag);
            if (!file) continue;
            const currentLine = this._toCurrentLine(file, b.line);
            const object = this.model ? this._objectAt(file, currentLine) : null;
            const answer = {
                flag: this._baseFlag(),
                file,
                line: currentLine,
                generationLine: b.line,
                box: this._toRect(b),
                object: object || undefined,
                candidates: hits.length,
                reason: object
                    ? (object.approximate
                        ? `no object contains line ${currentLine}; nearest is ${object.linesAway} line(s) away`
                        : undefined)
                    : 'mapped to a line, but this file has no objects',
            };
            if (!fallback) fallback = answer;
            if (!accept) return answer;
            let ok = false;
            try { ok = !!accept(file, currentLine); } catch (_) { ok = false; }
            if (ok) return { ...answer, corroborated: true };
        }
        // Nothing corroborated: the tightest box is still the best guess, and
        // saying so beats refusing to answer.
        if (fallback) return fallback;
        return { flag: FLAG.UNMAPPED, reason: 'records at that point name no known file' };
    }

    /**
     * The object a source line belongs to — exactly if one contains it, else
     * the nearest one, said so.
     *
     * Not every line is inside an object: prose that the paragraph scanner did
     * not claim (it splits on blank lines, and papers do not always oblige)
     * leaves gaps. Returning null there means a click in the middle of a page
     * yields nothing at all, which is worse than "you landed 2 lines below
     * eq:one". The `approximate` flag is what keeps that honest.
     */
    _objectAt(file, line) {
        if (!this.model) return null;
        const usable = this.model.objects.filter(o =>
            o.sourceRange.file === file &&
            o.kind !== 'label' && o.kind !== 'ref' && o.kind !== 'cite' && o.kind !== 'include');
        if (!usable.length) return null;

        const shape = (o, extra) => ({
            objectId: o.objectId, stableKey: o.stableKey, kind: o.kind,
            envName: o.envName, label: o.label,
            startLine: o.sourceRange.startLine, endLine: o.sourceRange.endLine,
            ...extra,
        });

        const containing = usable.filter(o =>
            o.sourceRange.startLine <= line && o.sourceRange.endLine >= line);
        if (containing.length) {
            // Tightest containing object wins — an equation over its section.
            containing.sort((a, b) =>
                (a.sourceRange.endLine - a.sourceRange.startLine) -
                (b.sourceRange.endLine - b.sourceRange.startLine));
            return shape(containing[0]);
        }

        let best = null; let bestD = Infinity;
        for (const o of usable) {
            if (o.kind === 'section-heading') continue;   // too coarse to be "nearest"
            const d = line < o.sourceRange.startLine
                ? o.sourceRange.startLine - line
                : line - o.sourceRange.endLine;
            if (d < bestD) { bestD = d; best = o; }
        }
        if (!best || bestD > 5) {
            // Fall back to the section, which always contains something.
            const sec = usable.filter(o => o.kind === 'section-heading' &&
                o.sourceRange.startLine <= line).pop();
            return sec ? shape(sec, { approximate: true, linesAway: line - sec.sourceRange.startLine }) : null;
        }
        return shape(best, { approximate: true, linesAway: bestD });
    }

    /**
     * How full is a page, and with what? Drives the `p.4 ▰▰▰▰▱` gutter chip and
     * the Stage 6 page budget.
     */
    pageOccupancy(page) {
        if (!this.doc) return { flag: FLAG.UNMAPPED, page, fill: 0, bars: 0 };
        const sheet = this.doc.pages.get(page);
        if (!sheet) return { flag: FLAG.UNMAPPED, page, fill: 0, bars: 0 };
        const pageSp = this.pageSizeSp;

        // VERTICAL COVERAGE, not summed ink area.
        //
        // MEASURED: `char` records (`x` in the format) carry a position and no
        // dimensions at all, so summing "ink area" over them gives exactly
        // zero — every page on an 89-page paper reported 0% full. And summing
        // BOX areas instead double-counts wildly, because boxes nest: the
        // outer vbox already covers everything inside it.
        //
        // What the `p.4 ▰▰▰▰▱` chip actually means is "how much of the column
        // has lines on it", so merge the y-intervals of the typeset rows and
        // measure against the text block. Nesting becomes harmless: an
        // interval already covered adds nothing.
        const rows = [];
        for (const b of sheet.boxes) {
            if (b.type !== 'hbox' && b.type !== 'rule' && b.type !== 'void_hbox') continue;
            if (!saneBox(b, pageSp)) continue;
            const r = synctexBoxToRectSp(b);
            if (r.w <= 0 || r.h <= 0) continue;
            rows.push([r.yTop, r.yTop + r.h]);
        }
        rows.sort((a, b) => a[0] - b[0]);
        let covered = 0; let curA = null; let curB = null;
        for (const [a, b] of rows) {
            if (curA === null) { curA = a; curB = b; continue; }
            if (a <= curB) { if (b > curB) curB = b; continue; }
            covered += curB - curA; curA = a; curB = b;
        }
        if (curA !== null) covered += curB - curA;

        const denom = this._textHeightSp();
        const fill = denom > 0 ? Math.min(1, covered / denom) : 0;

        return {
            flag: this._baseFlag(),
            page,
            fill,
            bars: Math.max(0, Math.min(5, Math.round(fill * 5))),
            coveredBp: spToBp(covered),
            textHeightBp: spToBp(denom),
            rows: rows.length,
            records: sheet.records,
        };
    }

    /**
     * The height of the text block, derived from the document rather than
     * guessed.
     *
     * MEASURED: the largest vbox on a page is the whole shipout box — 780 bp on
     * a 792 bp page — so normalising against it means a completely full page
     * reads about 83% and the gutter chip never fills. TeX's text height is
     * what the FULLEST page actually used, so take the tallest occupied column
     * in the document and normalise against that. Computed once and cached;
     * it is a property of the class file, not of any page.
     */
    _textHeightSp() {
        if (this._textH != null) return this._textH;
        const pageSp = this.pageSizeSp;
        let tallest = 0;
        for (const sheet of this.doc.pages.values()) {
            let lo = Infinity; let hi = -Infinity;
            for (const b of sheet.boxes) {
                if (b.type !== 'hbox' && b.type !== 'rule' && b.type !== 'void_hbox') continue;
                if (!saneBox(b, pageSp)) continue;
                const r = synctexBoxToRectSp(b);
                if (r.w <= 0 || r.h <= 0) continue;
                if (r.yTop < lo) lo = r.yTop;
                if (r.yTop + r.h > hi) hi = r.yTop + r.h;
            }
            if (hi > lo && hi - lo > tallest) tallest = hi - lo;
        }
        this._textH = tallest > 0 ? tallest : pageSp.heightSp;
        return this._textH;
    }


    /**
     * The typeset ROWS a source line produced — the honest answer for prose.
     *
     * MEASURED on draft.tex line 3086, one long source line that wraps into
     * three typeset lines: SyncTeX emits 98 records for it, of which the
     * `char`, `math` and `kern` ones are POINTS — height 0, and width 0 for
     * chars. Only their x is meaningful. So "the tightest box" picks a
     * zero-area kern and the highlight becomes a 4 bp tick under an arbitrary
     * word, which is exactly what it looked like in use.
     *
     * Grouping those points by baseline recovers the real structure: rows at
     * y = 503, 518 and 533, spanning x = 105..512, 114..512 and 111..248 —
     * the three lines as they appear on the page.
     *
     * @returns {{page, yBaseline, x, w, xs:number[]}[]} one entry per typeset
     *   row, `xs` being the sorted glyph-run positions for column refinement.
     */
    /**
     * REPAIR THE LINE ATTRIBUTION OF THE ODD RECORD, PER PRINTED ROW.
     *
     * MEASURED on a hard-wrapped paragraph (`check-occurrence.mjs`, and the
     * dump that produced it): the FIRST record of every continuation row of a
     * paragraph is attributed not to the source line whose word it marks, but
     * to the line the paragraph ENDS on — the `\par`. In a four-line paragraph
     * ending at line 8 the rows begin
     *
     *     L8@77.8:c  L5@100.5:c  L5@137.1:c  …        (row 2)
     *     L8@92.0:c  L6@95.7:k   L6@113.4:c  …        (row 3)
     *
     * where 77.8 and 92.0 are the first WORDS of those rows, and they belong to
     * lines 5 and 6. Two user-visible bugs came straight out of this: clicking
     * the first word of a row jumped to `\end{document}`, and — because
     * `lineRows` then started the row AFTER that word — the occurrence count
     * for a repeated word was one short, so clicking the second one selected
     * the first. The same shape produces stray single kerns mid-row.
     *
     * THE RULE, and why it is safe: within one printed row the source lines can
     * only go FORWARDS. A run of records carrying a line NUMBER GREATER than
     * the run that follows it cannot be right. Only SINGLETON runs are repaired
     * — a real word contributes at least two records (its character record and
     * the interword kern after it), so a line that genuinely owns part of a row
     * is never a singleton — and only within one file.
     *
     * @returns {Map<object,{tag:number,line:number}>} corrections by record
     */
    _rowRepairs(page) {
        if (!this._repairByPage) this._repairByPage = new Map();
        const cached = this._repairByPage.get(page);
        if (cached) return cached;
        const fixes = new Map();
        const pg = this.doc && this.doc.pages.get(page);
        if (!pg) { this._repairByPage.set(page, fixes); return fixes; }
        const pageSp = this.pageSizeSp;

        const rows = new Map();
        for (const b of pg.boxes) {
            if (b.type !== 'char' && b.type !== 'math' && b.type !== 'kern') continue;
            if (!saneBox(b, pageSp)) continue;
            if (!rows.has(b.v)) rows.set(b.v, []);
            rows.get(b.v).push(b);
        }
        for (const list of rows.values()) {
            list.sort((a, b) => a.h - b.h);
            const runs = [];
            for (const b of list) {
                const last = runs[runs.length - 1];
                if (last && last.tag === b.tag && last.line === b.line) last.items.push(b);
                else runs.push({ tag: b.tag, line: b.line, items: [b] });
            }
            for (let i = 0; i < runs.length; i++) {
                const r = runs[i];
                if (r.items.length >= 2) continue;
                let prv = null; let nxt = null;
                for (let j = i - 1; j >= 0; j--) if (runs[j].items.length >= 2) { prv = runs[j]; break; }
                for (let j = i + 1; j < runs.length; j++) if (runs[j].items.length >= 2) { nxt = runs[j]; break; }
                let adopt = null;
                if (nxt && r.tag === nxt.tag && r.line > nxt.line) adopt = nxt;
                else if (prv && r.tag === prv.tag && r.line < prv.line) adopt = prv;
                if (adopt) for (const b of r.items) fixes.set(b, { tag: adopt.tag, line: adopt.line });
            }
        }
        this._repairByPage.set(page, fixes);
        return fixes;
    }

    /** The record's source line, after the per-row repair above. */
    _boxLine(b) {
        const fix = this._rowRepairs(b.page).get(b);
        return fix ? fix.line : b.line;
    }

    /** The record's file tag, after the per-row repair above. */
    _boxTag(b) {
        const fix = this._rowRepairs(b.page).get(b);
        return fix ? fix.tag : b.tag;
    }

    /**
     * The source line whose TYPESET ROW contains a point.
     *
     * `renderToSource` walks the box hierarchy, which is right for objects and
     * wrong for text: a paragraph's characters are recorded as POINTS with no
     * dimensions, so they are not boxes at all and a click on prose resolves to
     * whatever vbox happens to enclose it — in practice the display equation
     * below, because `\[` plants a zero-width record on the paragraph's own
     * last baseline.
     *
     * So this asks the other question: of every character actually printed on
     * this page, which row does the click land on, and which source line put
     * the ink nearest the pointer? That is what a reader means by "this word".
     *
     * IT ANSWERS FOR A POINT THAT IS MERELY NEAR, and says how near.
     *
     * Only the rows whose band CONTAINED the point used to count, and the gaps
     * between bands are not small: `\abovedisplayskip`, `\parskip`, and the
     * space around a float are all several points of nothing. A click a few
     * points below the last line of a paragraph therefore matched no row at
     * all, and the caller fell back to the box hierarchy — which answers with
     * the display equation below, the exact complaint "slightly away from the
     * word and it selects the equation". So the nearest row wins instead, with
     * `dy` reported so the caller can decide how much slack it will allow.
     *
     * Vertical distance dominates: a click sitting inside an equation's band
     * but well to the right of its ink must not be captured by the prose line
     * above, whose ink happens to reach further across. Hence dy * 6 + dx.
     *
     * @returns {{file:string,line:number,dx:number,dy:number,lead:number}|null}
     */
    /** The object a line belongs to, exactly or nearest — see `_objectAt`. */
    objectAtLine(file, line) { return this._objectAt(file, line); }

    lineAtPoint(page, xBp, yTopBp) {
        if (!this.doc) return null;
        const pg = this.doc.pages.get(page);
        if (!pg) return null;
        const hSp = xBp / spToBp(1);
        const vSp = yTopBp / spToBp(1);
        const lead = this._leadingSp();
        const pageSp = this.pageSizeSp;
        // How far outside a row's own band a point may sit and still be that
        // row's. Beyond one and a half lines it is genuinely somewhere else.
        const reach = lead * 1.5;

        let best = null;
        for (const b of pg.boxes) {
            if (b.type !== 'char' && b.type !== 'math' && b.type !== 'kern') continue;
            if (!saneBox(b, pageSp)) continue;
            // The row is the band around the baseline: ink above, descenders
            // below, in the same 0.78/0.22 split lineRows uses.
            const top = b.v - lead * 0.78;
            const bottom = b.v + lead * 0.22;
            const dy = vSp < top ? top - vSp : (vSp > bottom ? vSp - bottom : 0);
            if (dy > reach) continue;
            const left = b.h;
            const right = b.h + (b.W > 0 ? b.W : 0);
            const dx = hSp < left ? left - hSp : (hSp > right ? hSp - right : 0);
            const score = dy * 6 + dx;
            if (!best || score < best.score) {
                best = { tag: this._boxTag(b), line: this._boxLine(b), dx, dy, score };
            }
        }
        if (!best) return null;
        const file = this.doc.inputs.get(best.tag);
        if (!file) return null;
        return {
            file,
            line: this._toCurrentLine(file, best.line),
            dx: spToBp(best.dx),
            dy: spToBp(best.dy),
            lead: spToBp(lead),
        };
    }

    lineRows(file, line) {
        if (!this.doc) return [];
        const tag = this._tag(file);
        if (tag == null) return [];
        const g = this._toGenerationLine(file, line);
        const pageSp = this.pageSizeSp;

        const byRow = new Map();
        for (const page of this.doc.pages.values()) {
            for (const b of page.boxes) {
                if (b.type !== 'char' && b.type !== 'math' && b.type !== 'kern') continue;
                if (!saneBox(b, pageSp)) continue;
                // The repaired attribution, or a row starts one word late — see
                // `_rowRepairs`. That missing first word is what made a repeated
                // word resolve to the occurrence before the one clicked.
                if (this._boxTag(b) !== tag || this._boxLine(b) !== g.line) continue;
                // Baselines are exact, so a plain key groups a row reliably.
                const key = `${b.page}|${b.v}`;
                if (!byRow.has(key)) byRow.set(key, { page: b.page, v: b.v, xs: [] });
                const row = byRow.get(key);
                row.xs.push(b.h);
                if (b.W > 0) row.xs.push(b.h + b.W);
            }
        }
        const lead = this._leadingSp();

        // Merge baselines closer together than half a line: a subscript sits on
        // its own baseline a few points below the body one, and reporting it as
        // a separate row puts a second highlight over part of the same line.
        const ordered = [...byRow.values()].filter(r => r.xs.length)
            .sort((a, b) => a.page - b.page || a.v - b.v);
        const merged = [];
        for (const r of ordered) {
            const prev = merged[merged.length - 1];
            if (prev && prev.page === r.page && Math.abs(r.v - prev.v) < lead * 0.5) {
                prev.xs.push(...r.xs);
                continue;
            }
            merged.push({ page: r.page, v: r.v, xs: [...r.xs] });
        }

        return merged
            .map(r => {
                const lo = Math.min(...r.xs);
                const hi = Math.max(...r.xs);
                return {
                    page: r.page,
                    yBaselineBp: spToBp(r.v),
                    // A text row's ink sits above its baseline, with descenders
                    // below. 0.78/0.22 of the leading matches what the page
                    // looks like without needing font metrics.
                    x: spToBp(lo),
                    y: spToBp(r.v - lead * 0.78),
                    w: spToBp(hi - lo),
                    h: spToBp(lead),
                    xs: r.xs.slice().sort((a, b2) => a - b2).map(spToBp),
                };
            })
            // A ROW WITH NO WIDTH IS NOT A ROW.
            //
            // `\[` emits a zero-width record sitting on the PRECEDING line's
            // baseline. Painting an equation's lines therefore drew a band
            // across the prose paragraph above it, and locating a click
            // preferred that phantom over the real text. It marks where the
            // display begins; it is not ink, and nothing should point at it.
            .filter(r => r.w > 0.5)
            .sort((a, b) => a.page - b.page || a.y - b.y);
    }

    /**
     * Leading (baseline-to-baseline distance), taken from the document rather
     * than assumed: the median gap between consecutive text baselines. A
     * hardcoded 12 pt would be wrong for every class that is not 10 pt.
     */
    _leadingSp() {
        if (this._lead != null) return this._lead;
        // THE MODE, NOT THE MEDIAN — AND ONLY BETWEEN BODY-TEXT ROWS.
        //
        // Subscripts and superscripts sit on their own baselines a few points
        // from the body one, and there are enough of them on a physics paper to
        // drag the MEDIAN down: 6.3 bp on draft.tex where the true leading is
        // 15. A histogram was supposed to fix that by finding the commonest gap
        // — but on a paper that is mostly equations the commonest gap IS the
        // maths one. Measured on the reference paper (89 displays): the mode
        // came out 4.5 bp against a true 13.6, every row rect became a third of
        // its real height, and clicks on a subscript fell outside their own
        // row. That is what made a click on the α of `\theta_\alpha` resolve to
        // the first α on the line.
        //
        // Body text is distinguishable from maths by WIDTH: a text line runs
        // most of the way across the measure, while a numerator or a subscript
        // is a few points wide. So the histogram is built from the gaps between
        // WIDE baselines only, and the maths offsets stop being candidates at
        // all rather than merely being outvoted.
        const hist = new Map();
        let seen = 0;
        for (const page of this.doc.pages.values()) {
            // Ink extent per baseline.
            const extent = new Map();
            for (const b of page.boxes) {
                if (b.type !== 'char') continue;
                const cur = extent.get(b.v);
                const right = b.h + (b.W > 0 ? b.W : 0);
                if (!cur) { extent.set(b.v, { x0: b.h, x1: right }); continue; }
                if (b.h < cur.x0) cur.x0 = b.h;
                if (right > cur.x1) cur.x1 = right;
            }
            if (!extent.size) continue;
            let widest = 0;
            for (const e of extent.values()) widest = Math.max(widest, e.x1 - e.x0);
            const vs = [...extent.entries()]
                .filter(([, e]) => (e.x1 - e.x0) >= widest * 0.35)
                .map(([v]) => v)
                .sort((a, b) => a - b);
            for (let i = 1; i < vs.length; i++) {
                const d = vs[i] - vs[i - 1];
                if (d <= 0) continue;
                const bp = d * spToBp(1);
                if (bp < 4 || bp > 40) continue;            // not a text line
                const key = Math.round(bp * 2) / 2;         // half-point bins
                hist.set(key, (hist.get(key) || 0) + 1);
                seen++;
            }
            if (seen > 8000) break;
        }
        // AND THE SMALLEST GAP THAT IS COMMON, not simply the commonest.
        //
        // The gaps between wide rows are of two kinds: consecutive lines of a
        // paragraph, which is the leading, and the space around a display,
        // which is larger and varies. On a paper with many equations the second
        // kind can be the more numerous — measured at 28.5 bp on a fixture of
        // twelve displays — and the leading is then outvoted by a quantity that
        // is not a leading at all. A leading is the SMALL common gap: the
        // displays add space, they never remove it.
        let bestN = 0;
        for (const n of hist.values()) if (n > bestN) bestN = n;
        let best = 0;
        for (const [bp, n] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
            if (n >= bestN * 0.25) { best = bp; break; }
        }
        this._lead = (best || 12) / spToBp(1);
        return this._lead;
    }

    /** Which lines of `file` landed on `page` — the page-marker source. */
    linesOnPage(page, file) {
        if (!this.doc) return [];
        const tag = this._tag(file);
        if (tag == null) return [];
        const sheet = this.doc.pages.get(page);
        if (!sheet) return [];
        const lines = new Set();
        for (const b of sheet.boxes) if (b.tag === tag) lines.add(this._toCurrentLine(file, b.line));
        return [...lines].sort((a, b) => a - b);
    }

    /**
     * The FIRST source line of each page — "PAGE 4 BEGINS (APPROX.)".
     * Approximate by construction: TeX breaks pages mid-paragraph, and the
     * first record on a page belongs to a line that started on the one before.
     */
    pageBreaks(file) {
        if (!this.doc) return [];
        const tag = this._tag(file);
        if (tag == null) return [];
        const out = [];
        for (const page of [...this.doc.pages.keys()].sort((a, b) => a - b)) {
            const lines = this.linesOnPage(page, file);
            if (!lines.length) continue;
            out.push({ page, firstLine: lines[0], lastLine: lines[lines.length - 1] });
        }
        return out;
    }

    /** Coverage census — how much of a file SyncTeX knows anything about. */
    coverage(file, totalLines) {
        const tag = this._tag(file);
        if (tag == null || !this.doc) return { covered: 0, total: totalLines, fraction: 0 };
        const c = lineCoverage(this.doc, tag, totalLines);
        return { covered: c.covered, total: c.total, fraction: c.fraction };
    }

    /**
     * Compare two generations: what moved, and did it move for a content
     * reason or only a layout one? The seed of Stage 7's render diff.
     */
    compare(prev) {
        if (!prev || !prev.doc || !this.doc) {
            return { available: false, reason: 'need two generations with synctex' };
        }
        const pageDelta = this.doc.pages.size - prev.doc.pages.size;
        const moved = [];
        if (this.model) {
            for (const o of this.model.objects) {
                if (o.kind === 'label' || o.kind === 'ref' || o.kind === 'cite') continue;
                const a = prev.pageForObject(o);
                const b = this.pageForObject(o);
                if (a.page != null && b.page != null && a.page !== b.page) {
                    moved.push({
                        objectId: o.objectId, stableKey: o.stableKey, kind: o.kind,
                        label: o.label, from: a.page, to: b.page,
                    });
                }
            }
        }
        return {
            available: true,
            fromGeneration: prev.generation && prev.generation.generation,
            toGeneration: this.generation && this.generation.generation,
            pagesBefore: prev.doc.pages.size,
            pagesAfter: this.doc.pages.size,
            pageDelta,
            moved,
            contentChanged: prev.generation && this.generation
                ? prev.generation.sourceSnapshotHash !== this.generation.sourceSnapshotHash
                : null,
            layoutOnly: prev.generation && this.generation
                ? (prev.generation.sourceSnapshotHash === this.generation.sourceSnapshotHash &&
                   prev.generation.pdfHash !== this.generation.pdfHash)
                : null,
        };
    }
}

module.exports = { RenderMap, FLAG };
