// glyphAlign.js — ONE many-to-many map between source tokens and rendered glyphs.
//
// Pure: no vscode, no pdf.js, never throws.
//
// WHY THIS EXISTS, MEASURED. Resolution used to work per SOURCE LINE: take the
// line SyncTeX names for a click, and look in it for a token that prints the
// clicked glyph. On the user's own paper that fails almost always:
//
//     lines of display equations with NO SyncTeX rows at all   71.1%
//     rendered glyphs in equations resolving to a source token  8.8%
//     most-missed glyphs        ")" x304  "(" x295  "2" x220  "=" x195
//
// Those are ordinary characters that plainly ARE in the source. They were
// missed because TeX does not attribute an equation's characters to the lines
// that wrote them — a display's glyphs are commonly recorded against one line,
// often its `\end{equation}` — so the search ran in the wrong line and a
// symbol-by-symbol answer was impossible in principle, whatever the symbol
// table contained.
//
// THE FIX IS THE ONE THE DESIGN NOTE ARGUES FOR: SyncTeX is the COARSE ANCHOR
// that picks a semantic object; inside that object, the projected source glyph
// sequence is ALIGNED against the rendered glyph sequence, and the alignment IS
// the map. Forward and inverse then stop being two algorithms that can disagree
// and become two lookups in one table.
//
//     source line/col  ->  source token index  --align->  glyph index  ->  rect
//     click point      ->  glyph index         --align->  token index  ->  range
//
// Every answer carries how it was reached, so a caller can decline rather than
// jump somewhere wrong.

const { visibleProjection, MATH_GLYPH_RE, foldGlyphs } = require('./texWords');
const { LEVEL, roleIndex, comparePaths } = require('./mathStructure');

/** The alignment's own honesty flags, finer than RenderMap's. */
const PRECISION = {
    CHARACTER: 'character',   // this glyph, that token
    TOKEN: 'token',           // a token, chosen without a corroborating glyph
    OBJECT: 'object',         // only the enclosing object is known
};

/**
 * A rendered glyph the PDF cannot name, which must not be read as a character.
 *
 * MEASURED on the user's paper: `\bigl(` and `\bigr)` come back from pdf.js as
 * `\u0000` and `\u0001`. TeX's extensible delimiters live in font slots whose
 * cmap maps to nothing, so the text layer reports the raw code. That single
 * fact is why `(` and `)` were the two most-missed glyphs in the census —
 * 599 misses between them — while being plainly present in the source.
 *
 * They cannot be decoded, but they need not be: an unnameable glyph is made a
 * WILDCARD that pairs with any source token at a reduced score, so the
 * alignment's context decides what it was. A source `(` sitting where the
 * unnameable glyph sits will take it, and one that does not, will not.
 */
const WILD = '\u0000?';

/**
 * What a math-extension font is actually FOR: big operators, radicals and
 * stretchy delimiters. It never draws a letter or a digit.
 *
 * A wildcard therefore is not equally likely to be anything. Without this, the
 * `X` that is really a summation scored the same against the `Z` of `\mathbb Z`
 * as against the `∑` beside it, and the alignment picked the wrong one — the
 * big operator resolved one token off. Scoring an extensible source glyph as
 * highly as an exact match encodes what the font can and cannot be.
 */
const EXTENSIBLE = new Set([
    '∑', '∏', '∐', '∫', '∬', '∭', '∮', '⋃', '⋂', '⋀', '⋁', '⨁', '⨂', '⨆', '⨄',
    '(', ')', '[', ']', '{', '}', '⟨', '⟩', '|', '‖', '⌈', '⌉', '⌊', '⌋',
    '√', '/', '↑', '↓', '⇑', '⇓',
]);

const isUnnameable = (cp) =>
    cp < 0x20 ||                          // control codes: an unmapped slot
    cp === 0xFFFD ||                      // the replacement character
    (cp >= 0xE000 && cp <= 0xF8FF);       // private use: font-specific glyphs

/**
 * The fonts whose reported characters cannot be believed.
 *
 * MEASURED, and this is the `\sum` bug exactly: pdf.js reports the big
 * summation as **"X"**, the integral as **"Z"** and the product as **"Y"** —
 * TeX's math-extension font (CMEX10) has no Unicode mapping, so every glyph
 * comes back as the ASCII letter of the slot it sits in. A source `∑` could
 * never match a rendered `X`, and worse, that `X` could match some unrelated
 * variable elsewhere in the equation.
 *
 * The font cannot be named — pdf.js reports only a generated id, and its
 * `fontFamily` is the CSS generic "sans-serif" — but it can be RECOGNISED:
 * on this paper exactly one font emits unnameable control codes (the stretched
 * delimiters), and it is the same font the false X, Y and Z come from. So a
 * font that emits any unnameable glyph is treated as symbolic throughout, and
 * everything it reports becomes a wildcard for the alignment to place.
 *
 * Judged over the WHOLE document: one equation may show a ∑ and no delimiter,
 * which is not enough evidence on its own.
 */
function symbolicFonts(items) {
    const out = new Set();
    for (const it of items || []) {
        const f = it && it.font;
        if (!f || out.has(f)) continue;
        for (const ch of String(it.str || '')) {
            if (isUnnameable(ch.codePointAt(0))) { out.add(f); break; }
        }
    }
    return out;
}

/** Fold a rendered or projected glyph onto its comparison key. */
function keyOf(ch, symbolicFont) {
    const s = String(ch || '');
    if (!s) return '';
    if (symbolicFont) return WILD;
    const cp = s.codePointAt(0);
    if (isUnnameable(cp)) return WILD;
    // Case matters for symbols and for maths variables alike: Ψ and ψ are
    // different letters, and so are X and x in an equation.
    return foldGlyphs(s);
}

/**
 * The glyphs a span of source will print, in source order, each carrying the
 * source range a click on it should select.
 *
 * Provenance is the CALL, not the expansion: `\bx` prints one x, and the range
 * reported for it is `\bx` — the thing the writer would edit. That is the
 * "user-action provenance" the design note asks for.
 *
 * @param {object} o
 * @param {string[]} o.lines     the whole file, split
 * @param {number} o.startLine   1-based, inclusive
 * @param {number} o.endLine     1-based, inclusive
 * @param {Map} [o.macros]
 * @param {boolean} [o.inMath]
 * @returns {{key:string, ch:string, line:number, startCol:number,
 *            endLine:number, endCol:number}[]}
 */
function sourceTokens(o = {}) {
    const lines = Array.isArray(o.lines) ? o.lines : [];
    const a = Math.max(1, o.startLine || 1);
    const b = Math.min(lines.length, o.endLine || a);
    if (b < a) return [];

    const body = lines.slice(a - 1, b).join('\n');
    // Offset -> (line, col), computed once for the object rather than per token.
    const lineStarts = [0];
    for (let i = 0; i < body.length; i++) if (body[i] === '\n') lineStarts.push(i + 1);
    const at = (off) => {
        let lo = 0; let hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
        }
        return { line: a + lo, col: off - lineStarts[lo] };
    };

    let proj;
    try { proj = visibleProjection(body, { inMath: o.inMath !== false, macros: o.macros }); }
    catch (_) { return []; }

    let roles = null;
    try { roles = roleIndex(body); } catch (_) { roles = null; }

    const out = [];
    const re = MATH_GLYPH_RE();
    let m;
    while ((m = re.exec(proj.text)) !== null) {
        const i = m.index;
        const off = proj.map[i];
        const from = at(off);
        const to = at(proj.end[i] ?? (off + 1));
        const r = roles ? roles.at(off) : null;
        out.push({
            key: keyOf(m[0]), ch: m[0],
            line: from.line, startCol: from.col,
            endLine: to.line, endCol: to.col,
            inMath: !!proj.math[i],
            role: r ? r.role : 'base',
            level: r ? r.level : LEVEL.BASE,
            path: r ? r.path : [off],
            chain: r ? (r.chain || []) : [],
        });
    }

    // CANONICAL ORDER, SO THE PAGE CAN BE PUT INTO THE SAME ONE.
    //
    // `x^{a}_{b}` and `x_{b}^{a}` are one picture written two ways, and the
    // page draws the subscript and the superscript in the same places either
    // way. Putting the source into the order the page uses — base, then its
    // subscript, then its superscript — is what lets a monotone alignment pair
    // them. Reordering costs nothing: every token carries its own source range,
    // so only the SEQUENCE moves.
    //
    // BUT ONLY THE GROUPS MOVE. Sorting everything by source offset also
    // reversed `\dot x`, whose mark is written BEFORE the base and printed
    // AFTER it — measured: the source came out `˙ x` against a rendered `x ˙`,
    // one transposition, and a monotone alignment drops one side of those. So
    // the projection's own order is kept for everything outside a group, and a
    // group is inserted after the last such token that precedes it.
    const firstOf = new Map();
    for (let i = 0; i < out.length; i++) {
        const g = out[i].chain[0];
        if (g && !firstOf.has(g)) firstOf.set(g, i);
    }
    const plainBefore = [];
    let lastPlain = -1;
    for (let i = 0; i < out.length; i++) {
        plainBefore.push(lastPlain);
        if (!out[i].chain.length) lastPlain = i;
    }
    const keyOfToken = (t, i) => {
        if (!t.chain.length) return [i, 0, i];
        const at = plainBefore[firstOf.get(t.chain[0])] ?? -1;
        return [at, 1, ...t.chain.map(c => c.rank), i];
    };
    const keyed = out.map((t, i) => ({ t, key: keyOfToken(t, i) }));
    keyed.sort((a, b) => comparePaths(a.key, b.key));
    return keyed.map(k => k.t);
}

/**
 * The rendered glyphs of an object, in READING order.
 *
 * Reading order is not simply "sorted by x": a fraction puts its numerator
 * above its denominator, and a subscript sits on its own baseline a few points
 * below the body one. So glyphs are grouped into BANDS of nearby baselines —
 * which keeps `x_\alpha` together, as one visual line — and the bands are
 * ordered down the page. Within a band, left to right.
 *
 * That ordering matches source order for the constructs that matter:
 * `\frac{a}{b}` writes the numerator first and prints it higher; an `align`
 * writes its rows in the order they print.
 *
 * @param {{page:number,str:string,x:number,y:number,w:number,h:number,baseline:number}[]} items
 * @param {number} [bandBp] baseline tolerance; a fraction of the leading
 * @returns {{key:string, ch:string, page:number, x:number, y:number, w:number, h:number}[]}
 */
function renderedGlyphs(items, bandBp = 4, symbolFonts = null) {
    const glyphs = [];
    // THE SAME INK, COLLECTED TWICE, IS THE WORST KIND OF NOISE.
    //
    // An object's rows come from every one of its source lines, and those
    // rectangles OVERLAP — TeX records a display against several lines whose
    // rows cover the same glyphs. Measured on one equation of the user's paper
    // the rendered sequence came out as "222R=DDalpha--22ccoossphiphipsixx...",
    // every glyph doubled, which no alignment can recover from. A text item is
    // identified by where it sits, so seeing it again is seeing it again.
    const seen = new Set();
    for (const it of items || []) {
        const str = String(it.str || '');
        if (!str.trim()) continue;
        const id = `${it.page}|${(it.x || 0).toFixed(2)}|${(it.baseline != null ? it.baseline : it.y).toFixed(2)}|${str}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const symbolic = !!(symbolFonts && it.font && symbolFonts.has(it.font));
        // pdf.js reports a run and one width for it; split the run into glyphs
        // and apportion the width. Maths runs are usually one glyph anyway.
        const chars = [...str];
        const marks = [];
        for (let k = 0; k < chars.length; k++) {
            const c = chars[k];
            // An UNNAMEABLE glyph has to be kept, not filtered out. The glyph
            // class is built for characters a reader can name, and a stretched
            // delimiter reports as a control code — dropping it here silently
            // removed the very glyphs the wildcard exists to place, and left
            // the source's own `(` and `)` with nothing to pair with.
            if (symbolic || MATH_GLYPH_RE().test(c) || isUnnameable(c.codePointAt(0))) marks.push(k);
        }
        if (!marks.length) continue;
        const per = (it.w || 0) / Math.max(1, chars.length);
        for (const idx of marks) {
            glyphs.push({
                key: keyOf(chars[idx], symbolic), ch: chars[idx],
                page: it.page, x: (it.x || 0) + idx * per, y: it.y,
                w: Math.max(per, 0.5), h: it.h, font: it.font,
                baseline: it.baseline != null ? it.baseline : (it.y + it.h),
            });
        }
    }
    if (!glyphs.length) return [];

    // READING ORDER IS BY PRINTED ROW, AND A ROW IS A BASELINE PLUS WHAT HANGS
    // OFF IT.
    //
    // Grouping by BASELINE alone put a superscript in a band of its own and —
    // being higher — before everything on its line: one equation's sequence
    // began "2R=D…" where the source says "R…x2". Chaining glyphs whose BOXES
    // overlap fixed that and created a worse problem, because in a display
    // every band touches the next: the prose above overlaps the superscripts,
    // which overlap the body row, which overlaps the subscripts. Measured on
    // the reference paper, a whole equation plus the paragraph above it
    // collapsed into ONE "line", and the widest baseline in it — the prose —
    // was taken for the line's own. Every script then hung off a word of the
    // paragraph and was emitted in a block at the end, so not one of the
    // equation's six α's paired with anything.
    //
    // So: the rows are the baselines that carry the BODY of the line — full
    // size, and wide — and everything else joins the row it is nearest to.
    // `orderLine` then does the within-row work it was always meant to do.
    glyphs.sort((p, q) => p.page - q.page || p.y - q.y || p.x - q.x);
    const tolOf = (list) => Math.max(1, (Math.max(...list.map(g => g.h || 0)) || 10) * 0.25);

    const out = [];
    const byPage = new Map();
    for (const g of glyphs) {
        if (!byPage.has(g.page)) byPage.set(g.page, []);
        byPage.get(g.page).push(g);
    }
    for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
        const pageGlyphs = byPage.get(page);
        const tol = tolOf(pageGlyphs);
        const hMax = Math.max(...pageGlyphs.map(g => g.h || 0)) || 10;

        // Baselines, and how much ink each carries.
        const bands = [];
        for (const g of pageGlyphs.slice().sort((p, q) => p.baseline - q.baseline || p.x - q.x)) {
            const last = bands[bands.length - 1];
            if (last && Math.abs(last.baseline - g.baseline) <= tol) {
                last.items.push(g);
                last.x0 = Math.min(last.x0, g.x);
                last.x1 = Math.max(last.x1, g.x + g.w);
                continue;
            }
            bands.push({ baseline: g.baseline, x0: g.x, x1: g.x + g.w, items: [g] });
        }
        const widest = Math.max(...bands.map(b => b.x1 - b.x0));
        // A ROW is a baseline carrying full-size ink across a good part of the
        // line. A script band is neither; a numerator is full size but narrow.
        // A ROW HAS TO CONTAIN SOMETHING NAMEABLE. A `pmatrix`'s stretched
        // delimiters get a baseline of their own, halfway up the matrix, and
        // they are wide and full-size — so they qualified as a row and then
        // merged with the matrix's first line, which reordered it. Extensible
        // delimiters reach pdf.js as control codes with no character at all;
        // they belong to whatever line they enclose, never to one of their own.
        const rowBands = bands.filter(b => (b.x1 - b.x0) >= widest * 0.3 &&
            b.items.some(g => (g.h || 0) >= hMax * 0.85) &&
            b.items.some(g => !isUnnameable(String(g.ch || '').codePointAt(0) || 0)));
        if (!rowBands.length) { out.push(...orderLine(pageGlyphs)); continue; }

        // A DISPLAY FRACTION'S HALVES ARE FULL-SIZE AND WIDE, SO THEY LOOK
        // EXACTLY LIKE ROWS OF THEIR OWN.
        //
        // In display style `\frac` sets its numerator and denominator in
        // TEXTSTYLE — the same size as the body — so a line carrying several
        // fractions puts full-size, wide ink on three baselines. Each was
        // promoted to a row, each was ordered separately, and the sequence came
        // out as ALL the numerators, then all the bodies, then all the
        // denominators. `orderLine`, which exists to pair a numerator with its
        // denominator, never saw them together.
        //
        // MEASURED on equation (10) of the reference paper — four fractions on
        // one line, reported as "I click on the first m and it selects the last
        // one":
        //
        //     baseline 118.0  h=10.9  w=254 : i m i m u + ˙ u u − u ˙
        //     baseline 125.5  h=10.9  w=323 : u = U + , u ˙ = U − , U = , m = ∈ Z .
        //     baseline 132.5  h=10.9  w=239 : 2 2 2 i
        //
        // The gaps are 7.5 and 7.0 bp while the glyphs are 10.9 tall and the
        // leading is 13.6: the bands OVERLAP, and overlapping bands are one
        // printed line. Successive real lines TILE — they touch without
        // overlapping — which is the same distinction `mergeRows` draws in
        // texViewer, one level up. Source and render were in different orders,
        // so the alignment matched 19 of 35 at confidence 0.54 and every
        // repeated letter resolved to the wrong one of its kind.
        const hs = pageGlyphs.map(g => g.h || 0).filter(h => h > 0).sort((a, b) => a - b);
        const bodyH = hs.length ? hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.6))] : hMax;
        const rowSet = new Set(rowBands);
        const rows = [];
        for (const r of rowBands.slice().sort((a, b) => a.baseline - b.baseline)) {
            const last = rows[rows.length - 1];
            if (last && r.baseline - last.baseline < bodyH) {
                last.items.push(...r.items);
                // The line's own baseline is the one carrying the most ink —
                // the body, not whichever half happened to come first.
                if ((r.x1 - r.x0) > (last.x1 - last.x0)) last.baseline = r.baseline;
                last.x0 = Math.min(last.x0, r.x0);
                last.x1 = Math.max(last.x1, r.x1);
                continue;
            }
            rows.push({ baseline: r.baseline, x0: r.x0, x1: r.x1, items: [...r.items] });
        }

        const buckets = rows.map(r => ({ baseline: r.baseline, items: [...r.items] }));
        for (const b of bands) {
            if (rowSet.has(b)) continue;
            // Delimiters keep their own place in the sequence: they have no
            // source token of their own, and folding them into a text row lets
            // them take a pairing that belongs to a real glyph.
            const allDelims = b.items.every(g => isUnnameable(String(g.ch || '').codePointAt(0) || 0));
            if (allDelims) { buckets.push({ baseline: b.baseline, items: [...b.items] }); continue; }
            let best = 0;
            for (let i = 1; i < buckets.length; i++) {
                if (Math.abs(b.baseline - buckets[i].baseline) <
                    Math.abs(b.baseline - buckets[best].baseline)) best = i;
            }
            buckets[best].items.push(...b.items);
        }
        buckets.sort((a, b) => a.baseline - b.baseline);
        for (const b of buckets) out.push(...orderLine(b.items));
    }
    return out;
}

/**
 * ONE LINE OF MATHS, PUT INTO THE ORDER IT WAS WRITTEN IN.
 *
 * WITHIN a line, "left to right" is not reading order and never was. Measured
 * (`check-math.mjs`): `U_{m,k}^{\pm}` comes out `U m ± k`, because the
 * superscript's x falls between the subscript's two glyphs; and
 * `s+\frac{|m|}{2}+k` comes out `| m 2 |`, because the denominator sits under
 * the middle of the numerator. The source says `U m k ±` and `| m | 2`. A
 * monotone alignment cannot absorb a transposition — it drops one side, and a
 * dropped glyph is a glyph that cannot be clicked. That is exactly the reported
 * bug: the superscript and the denominator resolved to nothing, so a click on
 * them fell back to whatever happened to be nearest.
 *
 * So the line is taken apart the way it was put together. Glyphs are clustered
 * by baseline and horizontal contiguity; clusters that sit OVER each other are
 * paired; and each pair is either a fraction or a pair of scripts.
 *
 * WHICH ONE, DECIDED BY MEASUREMENT RATHER THAN BY SIZE. Size looks like the
 * answer — scripts are set smaller — but it fails on the nested fraction, whose
 * halves are script-sized, and on inline fractions. Alignment does not: a
 * fraction is CENTRED, its narrower half inset over the wider one, while two
 * scripts both START just after the base they hang off. Measured on the corpus:
 * for `U_{m,k}^{\pm}` the two clusters start 1 bp apart and their centres are
 * 3 bp apart; for `\frac{|m|}{2}` the starts are 6 bp apart and the centres
 * 0.5 bp. So whichever of those two distances is the smaller says which
 * construct it is — and that decides the order, because TeX writes a fraction
 * numerator-first and a script subscript-first.
 */
function orderLine(items) {
    if (items.length < 2) return items.slice();

    // THE BODY SIZE, AND WHY IT IS NOT THE TALLEST GLYPH. A stretched delimiter
    // is half again as tall as the type around it, so taking the maximum makes
    // the tolerance too generous and scripts start counting as body text. The
    // upper-median is the size most of the line is set in.
    const hs = items.map(g => g.h || 0).filter(h => h > 0).sort((a, b) => a - b);
    const bodyH = hs.length ? hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.6))] : 10;
    const hMax = Math.max(...items.map(g => g.h || 0)) || bodyH;
    const tol = Math.max(1, bodyH * 0.25);
    // SIZE DECIDES A SCRIPT, NOT THE BASELINE OFFSET ALONE. Measured: the α of
    // `\theta_\alpha` sits 1.7 bp below the body baseline — well inside any
    // sane tolerance — while the α of `x_{\alpha,n}` sits 3.3 bp below. They
    // are the same kind of thing and must be classified the same way, and what
    // they have in common is that both are SET SMALLER.
    const small = (g) => (g.h || 0) < bodyH * 0.85;

    // The line's own baseline: where the body-size ink sits.
    const tally = new Map();
    for (const g of items) {
        if (small(g)) continue;
        const k = Math.round(g.baseline * 2) / 2;
        tally.set(k, (tally.get(k) || 0) + Math.max(1, g.w || 1));
    }
    let main = null; let mainWidth = 0;
    for (const [k, w] of tally) if (w > mainWidth || (w === mainWidth && main != null && k < main)) { main = k; mainWidth = w; }
    if (main == null) main = Math.round((items[0].baseline || 0) * 2) / 2;

    // A fraction's halves are body-size but sit off the line, and neither is
    // the line — detected, not assumed, exactly as before.
    {
        const rivals = new Map();
        for (const g of items) {
            if (small(g) || Math.abs(g.baseline - main) <= tol) continue;
            const k = Math.round(g.baseline * 2) / 2;
            rivals.set(k, (rivals.get(k) || 0) + Math.max(1, g.w || 1));
        }
        for (const w of rivals.values()) if (w >= mainWidth * 0.6) { main = null; break; }
    }

    const levelOf = (g) => {
        if (main != null && !small(g) && Math.abs(g.baseline - main) <= tol) return 'base';
        const above = main != null ? g.baseline < main : g.baseline < (items[0].baseline || 0);
        if (small(g)) return above ? 'sup' : 'sub';
        return above ? 'num' : 'den';
    };
    for (const g of items) {
        g.role = levelOf(g);
        g.level = g.role === 'base' ? 'base' : (g.role === 'sup' || g.role === 'num') ? 'above' : 'below';
    }

    // Clusters: one role, one baseline, contiguous in x.
    const sorted = items.slice().sort((p, q) =>
        p.baseline - q.baseline || p.x - q.x);
    const clusters = [];
    for (const g of sorted) {
        const last = clusters[clusters.length - 1];
        // THE GAP TEST NEEDS BOTH ENDS. Sorted by baseline first, each new
        // baseline starts over at a small x — so a one-sided "close enough on
        // the right" test says every one of them continues the LAST cluster on
        // the line, and its glyphs come out in a block at the far end.
        const gap = last ? g.x - last.x1 : Infinity;
        if (last && last.role === g.role && Math.abs(last.baseline - g.baseline) <= tol &&
            gap <= bodyH && gap >= -bodyH * 0.5) {
            last.items.push(g);
            last.x1 = Math.max(last.x1, g.x + g.w);
            continue;
        }
        clusters.push({ baseline: g.baseline, role: g.role, x0: g.x, x1: g.x + g.w, items: [g], h: g.h || bodyH });
    }
    for (const c of clusters) c.items.sort((p, q) => p.x - q.x);
    if (clusters.length === 1) return clusters[0].items;

    const isBase = (c) => c.role === 'base';

    // Pair the non-base clusters that sit over each other, strongest overlap
    // first: a subscript with its superscript, a numerator with its denominator.
    const cand = [];
    const free = clusters.filter(c => !isBase(c));
    for (let i = 0; i < free.length; i++) {
        for (let j = i + 1; j < free.length; j++) {
            const a = free[i]; const b = free[j];
            if (Math.abs(a.baseline - b.baseline) <= tol) continue;
            const lo = Math.max(a.x0, b.x0); const hi = Math.min(a.x1, b.x1);
            const narrow = Math.max(1, Math.min(a.x1 - a.x0, b.x1 - b.x0));
            const frac = (hi - lo) / narrow;
            if (frac > 0.5) cand.push({ a, b, frac });
        }
    }
    cand.sort((p, q) => q.frac - p.frac);
    const paired = new Set();
    const pairs = [];
    for (const c of cand) {
        if (paired.has(c.a) || paired.has(c.b)) continue;
        paired.add(c.a); paired.add(c.b);
        const upper = c.a.baseline < c.b.baseline ? c.a : c.b;
        const lower = upper === c.a ? c.b : c.a;
        // A fraction is CENTRED, its narrower half inset over the wider one;
        // two scripts both START just after the base they hang off.
        const dStart = Math.abs(upper.x0 - lower.x0);
        const dCentre = Math.abs((upper.x0 + upper.x1) / 2 - (lower.x0 + lower.x1) / 2);
        const isFraction = dCentre <= dStart;
        for (const g of upper.items) { g.level = 'above'; g.role = isFraction ? 'num' : 'sup'; }
        for (const g of lower.items) { g.level = 'below'; g.role = isFraction ? 'den' : 'sub'; }
        pairs.push({ upper, lower, isFraction, x0: Math.min(upper.x0, lower.x0) });
    }

    // What is left: base material, and lone halves — a subscript with no
    // superscript, a numerator whose denominator is a bar and a digit we could
    // not cluster with it.
    const baseClusters = clusters.filter(isBase);
    const loose = clusters.filter(c => !isBase(c) && !paired.has(c));
    const baseGlyphs = [];
    for (const c of baseClusters) baseGlyphs.push(...c.items);
    baseGlyphs.sort((p, q) => p.x - q.x);

    const units = [];
    for (const c of baseClusters) units.push({ kind: 'base', x0: c.x0, glyphs: c.items });
    for (const p of pairs) {
        units.push({
            kind: p.isFraction ? 'fraction' : 'scripts',
            x0: p.x0,
            glyphs: p.isFraction
                ? [...p.upper.items, ...p.lower.items]      // numerator, denominator
                : [...p.lower.items, ...p.upper.items],     // subscript, superscript
        });
    }
    for (const c of loose) units.push({ kind: 'script', x0: c.x0, glyphs: c.items });

    // Every unit hangs off the last base glyph at or before it; scripts follow
    // that glyph immediately, fractions and base material take their place in
    // the left-to-right sequence.
    const anchorOf = (u) => {
        let at = -1;
        for (let i = 0; i < baseGlyphs.length; i++) {
            if (baseGlyphs[i].x <= u.x0 + hMax * 0.3) at = i;
        }
        return at;
    };
    const attached = new Map();
    const top = [];
    for (const u of units) {
        if (u.kind === 'base') { top.push(u); continue; }
        if (u.kind === 'fraction') { top.push(u); continue; }
        const at = anchorOf(u);
        if (at < 0) { top.push(u); continue; }
        const g = baseGlyphs[at];
        if (!attached.has(g)) attached.set(g, []);
        attached.get(g).push(u);
    }
    top.sort((p, q) => p.x0 - q.x0);

    const out = [];
    for (const u of top) {
        for (const g of u.glyphs) {
            out.push(g);
            for (const s of (attached.get(g) || [])) out.push(...s.glyphs);
        }
    }
    return out;
}

/**
 * Align two glyph sequences, tolerating insertions on both sides.
 *
 * Needleman-Wunsch, because both kinds of slip are real and neither is rare:
 * the projection produces glyphs the PDF never prints (both branches of
 * `\texorpdfstring`, a `\phantom`) and the PDF prints glyphs the projection
 * cannot predict (an unknown macro's expansion, an accent, a stretched
 * delimiter). A longest-common-subsequence would handle those too, but scoring
 * lets a near-miss pair up instead of being dropped by both sides.
 *
 * THE SCORER IS PLUGGABLE, and the sequences need not be glyphs. Aligning two
 * versions of a source file is the same problem with a different notion of
 * "these two things correspond", so `tex/texDiff.js` passes its own scorer
 * rather than the project growing a second alignment implementation — the same
 * rule that keeps one copy of the viewer.
 *
 * @param {string[]} srcKeys
 * @param {string[]} renKeys
 * @param {{score?:(a:string,b:string)=>number, gap?:number,
 *          pair?:(a:string,b:string)=>boolean}} [opts]
 *   `score` ranks a pairing, `gap` is the cost of skipping one side, and `pair`
 *   decides whether a diagonal step counts as a correspondence at all.
 * @returns {{srcToRen:Int32Array, renToSrc:Int32Array, matched:number}}
 *   index arrays, -1 where nothing corresponds.
 */
function align(srcKeys, renKeys, opts = {}) {
    const n = srcKeys.length; const m = renKeys.length;
    const srcToRen = new Int32Array(n).fill(-1);
    const renToSrc = new Int32Array(m).fill(-1);
    if (!n || !m) return { srcToRen, renToSrc, matched: 0 };

    const MATCH = 3; const MISMATCH = -2; const WILDCARD = 1;
    const GAP = Number.isFinite(opts.gap) ? opts.gap : -2;
    // WHERE A GLYPH SITS IS PART OF WHAT IT IS.
    //
    // `\frac{x+x}{x+x}` prints four identical x's, and character identity
    // cannot tell them apart — measured, the numerator's x and the
    // denominator's x resolved to the SAME source token. Their LEVEL can:
    // above, below, or on the baseline, agreed between the source's structure
    // and the page's geometry.
    //
    // The penalty is deliberately soft rather than a veto. The page cannot
    // always tell a superscript from a numerator (a display fraction is full
    // size, an inline one is not), so a disagreement has to cost a pairing
    // some score without ever losing it to a gap.
    const srcLv = opts.srcLevels || null;
    const renLv = opts.renLevels || null;
    const SAME_LEVEL = MATCH; const OTHER_LEVEL = 1.2;
    const score = opts.score || ((a, b, i, j) => {
        if (a === b) {
            if (!srcLv || !renLv || i == null || j == null) return MATCH;
            return srcLv[i] === renLv[j] ? SAME_LEVEL : OTHER_LEVEL;
        }
        if (a === WILD || b === WILD) {
            const other = a === WILD ? b : a;
            return EXTENSIBLE.has(other) ? MATCH : WILDCARD;
        }
        return MISMATCH;
    });
    // What counts as a real correspondence on the traceback. The glyph default
    // pairs equal keys and wildcards; a line diff pairs only equal lines.
    const pair = opts.pair || ((a, b) => a === b || a === WILD || b === WILD);
    // One row at a time plus a traceback of 2-bit moves: a 2000x2000 equation
    // would otherwise want 32 MB of Int32 for the score matrix alone.
    const W = m + 1;
    const back = new Uint8Array((n + 1) * W);
    let prev = new Int32Array(W);
    let cur = new Int32Array(W);
    for (let j = 1; j <= m; j++) { prev[j] = j * GAP; back[j] = 2; }
    for (let i = 1; i <= n; i++) {
        cur[0] = i * GAP;
        back[i * W] = 1;
        const sk = srcKeys[i - 1];
        for (let j = 1; j <= m; j++) {
            const diag = prev[j - 1] + score(sk, renKeys[j - 1], i - 1, j - 1);
            const up = prev[j] + GAP;
            const left = cur[j - 1] + GAP;
            let best = diag; let move = 0;
            if (up > best) { best = up; move = 1; }
            if (left > best) { best = left; move = 2; }
            cur[j] = best;
            back[i * W + j] = move;
        }
        const t = prev; prev = cur; cur = t;
    }

    let i = n; let j = m; let matched = 0;
    while (i > 0 && j > 0) {
        const move = back[i * W + j];
        if (move === 0) {
            const a = srcKeys[i - 1]; const b = renKeys[j - 1];
            if (pair(a, b)) {
                srcToRen[i - 1] = j - 1;
                renToSrc[j - 1] = i - 1;
                // Only an exact pairing counts towards confidence; a wildcard
                // is placed BY the alignment and cannot also vouch for it.
                if (a === b) matched++;
            }
            i--; j--;
        } else if (move === 1) i--;
        else j--;
    }
    return { srcToRen, renToSrc, matched };
}

/**
 * The map for one object: its source tokens, its rendered glyphs, and the
 * correspondence between them.
 */
function buildObjectMap(o = {}) {
    const tokens = sourceTokens(o);
    const glyphs = renderedGlyphs(o.items, o.bandBp,
        o.symbolFonts || symbolicFonts(o.items));
    const { srcToRen, renToSrc, matched } = align(
        tokens.map(t => t.key), glyphs.map(g => g.key), {
            srcLevels: tokens.map(t => t.level || 'base'),
            renLevels: glyphs.map(g => g.level || 'base'),
        });
    return {
        tokens,
        glyphs,
        srcToRen,
        renToSrc,
        matched,
        // How much of the smaller side found a partner. Low means the two
        // sequences are not really the same material — a caller should fall
        // back rather than point somewhere confidently wrong.
        confidence: (tokens.length && glyphs.length)
            ? matched / Math.min(tokens.length, glyphs.length) : 0,
    };
}

/** The rendered glyph nearest a point, and how far away it was (in bp). */
function glyphAtPoint(map, page, xBp, yTopBp) {
    let best = -1; let bestD = Infinity;
    for (let i = 0; i < map.glyphs.length; i++) {
        const g = map.glyphs[i];
        if (g.page !== page) continue;
        const dx = xBp < g.x ? g.x - xBp : (xBp > g.x + g.w ? xBp - (g.x + g.w) : 0);
        const dy = yTopBp < g.y ? g.y - yTopBp : (yTopBp > g.y + g.h ? yTopBp - (g.y + g.h) : 0);
        // Vertical distance counts double: on a dense equation the glyph on the
        // NEXT line is often horizontally closer than the right one.
        const d = Math.hypot(dx, dy * 2);
        if (d < bestD) { bestD = d; best = i; }
    }
    return { index: best, distance: bestD };
}

/**
 * WHAT IS CERTAIN AROUND A GLYPH THAT PAIRED WITH NOTHING.
 *
 * Some rendered glyphs have no source token and never will: the parentheses a
 * `pmatrix` draws are the environment's, not anyone's characters; a stretched
 * `\bigl(` reports as a control code; the dots of `\ldots` are one command.
 * Answering those with the nearest token that happens to be close is how a
 * click on a delimiter ends up selecting an `x` — a confident wrong jump, which
 * is the one outcome worth avoiding.
 *
 * What IS certain is the neighbourhood. The paired glyphs either side name two
 * source tokens, and the structural path they share — `mathStructure` puts one
 * on every token — is the smallest construct that provably contains the click:
 * the subscript group, the numerator, else the object itself. Selecting that is
 * true, and it is the thing a reader would edit anyway.
 *
 * @returns {{startLine,startCol,endLine,endCol,depth}|null}
 */
function groupAround(map, glyphIndex) {
    if (!map || !map.tokens.length) return null;
    let left = -1; let right = -1;
    for (let i = glyphIndex - 1; i >= 0; i--) if (map.renToSrc[i] >= 0) { left = map.renToSrc[i]; break; }
    for (let i = glyphIndex + 1; i < map.glyphs.length; i++) if (map.renToSrc[i] >= 0) { right = map.renToSrc[i]; break; }
    const a = left >= 0 ? map.tokens[left] : null;
    const b = right >= 0 ? map.tokens[right] : null;
    if (!a && !b) return null;

    // The common structural prefix. A path is [anchor, rank, …, ownOffset], so
    // dropping the last element leaves the enclosing groups; the shared prefix
    // of the two neighbours is the construct they are both inside.
    const pa = (a && a.path ? a.path : []).slice(0, -1);
    const pb = (b && b.path ? b.path : []).slice(0, -1);
    const prefix = [];
    if (a && b) {
        for (let i = 0; i + 1 < Math.min(pa.length, pb.length) + 1; i += 2) {
            if (pa[i] === pb[i] && pa[i + 1] === pb[i + 1]) prefix.push(pa[i], pa[i + 1]);
            else break;
        }
    } else {
        // ONE-SIDED: the closing delimiter of a matrix has nothing paired to its
        // right, and taking its only neighbour's full path would answer with
        // the innermost cell — `x` — when what encloses the click is the matrix
        // body. With one witness, step out one level.
        const only = a ? pa : pb;
        for (let i = 0; i + 1 < only.length - 1; i += 2) prefix.push(only[i], only[i + 1]);
    }

    const inPrefix = (t) => {
        const p = t.path || [];
        if (p.length < prefix.length + 1) return false;
        for (let i = 0; i < prefix.length; i++) if (p[i] !== prefix[i]) return false;
        return true;
    };
    const members = prefix.length ? map.tokens.filter(inPrefix) : map.tokens;
    if (!members.length) return null;
    let startLine = Infinity; let startCol = 0; let endLine = -Infinity; let endCol = 0;
    for (const t of members) {
        if (t.line < startLine || (t.line === startLine && t.startCol < startCol)) {
            startLine = t.line; startCol = t.startCol;
        }
        if (t.endLine > endLine || (t.endLine === endLine && t.endCol > endCol)) {
            endLine = t.endLine; endCol = t.endCol;
        }
    }
    return { startLine, startCol, endLine, endCol, depth: prefix.length / 2 };
}

/** The source token covering a (line, column), or the nearest one on that line. */
function tokenAt(map, line, col) {
    let exact = -1; let near = -1; let nearD = Infinity;
    for (let i = 0; i < map.tokens.length; i++) {
        const t = map.tokens[i];
        if (t.line > line) break;
        if (t.line !== line) continue;
        if (col >= t.startCol && col < t.endCol) { exact = i; break; }
        const d = col < t.startCol ? t.startCol - col : col - t.endCol;
        if (d < nearD) { nearD = d; near = i; }
    }
    if (exact >= 0) return { index: exact, exact: true };
    if (near >= 0 && nearD <= 40) return { index: near, exact: false };
    return { index: -1, exact: false };
}

module.exports = {
    PRECISION, sourceTokens, renderedGlyphs, align, buildObjectMap,
    glyphAtPoint, tokenAt, groupAround, keyOf, symbolicFonts, WILD,
};
