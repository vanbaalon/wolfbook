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

    const out = [];
    const re = MATH_GLYPH_RE();
    let m;
    while ((m = re.exec(proj.text)) !== null) {
        const i = m.index;
        const from = at(proj.map[i]);
        const to = at(proj.end[i] ?? (proj.map[i] + 1));
        out.push({
            key: keyOf(m[0]), ch: m[0],
            line: from.line, startCol: from.col,
            endLine: to.line, endCol: to.col,
            inMath: !!proj.math[i],
        });
    }
    return out;
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

    // READING ORDER COMES FROM VERTICAL OVERLAP, NOT FROM BASELINES.
    //
    // A superscript sits on its own baseline ~9bp above the body one, so
    // grouping by baseline made `x^2` two separate bands and — because the
    // superscript is HIGHER — put the 2 before everything else on the line:
    // the rendered sequence for one equation began "2R=D..." where the source
    // says "R...x2". Boxes tell the truth instead: a superscript's box
    // OVERLAPS the box of the glyph it modifies, while a fraction's numerator
    // and denominator do not overlap each other at all. So a line is a run of
    // glyphs whose vertical extents connect, and within it, left to right.
    glyphs.sort((p, q) => p.page - q.page || p.y - q.y || p.x - q.x);
    const lines = [];
    for (const g of glyphs) {
        const last = lines[lines.length - 1];
        const top = g.y; const bottom = g.y + g.h;
        if (last && last.page === g.page && top < last.bottom - 0.5) {
            last.items.push(g);
            if (bottom > last.bottom) last.bottom = bottom;
            continue;
        }
        lines.push({ page: g.page, top, bottom, items: [g] });
    }
    const out = [];
    for (const ln of lines) {
        ln.items.sort((p, q) => p.x - q.x);
        for (const g of ln.items) out.push(g);
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
    // A wildcard is worth pairing but not worth trusting — except against a
    // glyph a math-extension font actually draws, where it is as good as an
    // exact match. See EXTENSIBLE.
    const score = opts.score || ((a, b) => {
        if (a === b) return MATCH;
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
            const diag = prev[j - 1] + score(sk, renKeys[j - 1]);
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
        tokens.map(t => t.key), glyphs.map(g => g.key));
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
    glyphAtPoint, tokenAt, keyOf, symbolicFonts, WILD,
};
