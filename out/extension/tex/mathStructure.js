// mathStructure.js — the little bit of maths layout the resolver has to know.
//
// Pure: no vscode, no I/O, never throws.
//
// WHY THIS EXISTS, MEASURED. `check-math.mjs` clicks every rendered glyph of a
// corpus of repeated-symbol equations and asks which source token comes back.
// The failures were not random: they were the glyphs that are not on the main
// baseline.
//
//     \frac{x+x}{x+x}   the numerator's x and the denominator's x
//                       resolved to the SAME source token
//     U_{m,k}^{\pm}     the superscript resolved to the base U
//
// The cause is that the two sequences being aligned are in different ORDERS.
// The source writes `U _{m,k} ^{\pm}`; the page draws the superscript higher
// than the subscript, so ordering rendered glyphs by position emits `U m ± k`.
// A monotone alignment cannot absorb a transposition — it drops one side, and a
// dropped glyph is a glyph that cannot be clicked.
//
// The fix is to put BOTH sides in the same canonical order and to know, for
// every token and every glyph, whether it sits on the baseline, above it or
// below it. This module answers that for the SOURCE; `glyphAlign.renderedGlyphs`
// answers the same question for the PAGE, from geometry.
//
// THE LEVEL IS THE ROBUST PART, NOT THE ROLE. A superscript and a fraction's
// numerator are different roles but the same LEVEL — above — and the page
// cannot always tell them apart (a display fraction is full size, an inline one
// is not). Scoring on level rather than role makes a misclassification cost
// nothing, while still forbidding a numerator glyph from pairing with a
// denominator token.

/** Where a token sits relative to the baseline it belongs to. */
const LEVEL = { BASE: 'base', ABOVE: 'above', BELOW: 'below' };

/** The role's level. The finer role is kept for reporting and for Stage 3. */
const ROLE_LEVEL = {
    sup: LEVEL.ABOVE,
    num: LEVEL.ABOVE,
    sub: LEVEL.BELOW,
    den: LEVEL.BELOW,
    root: LEVEL.BASE,
    cell: LEVEL.BASE,
    base: LEVEL.BASE,
};

/** Order among the groups hanging off one base: subscript before superscript. */
const RANK = { sub: 0, sup: 1, num: 0, den: 1, root: 0, cell: 0 };

const FRACTIONS = new Set(['frac', 'dfrac', 'tfrac', 'cfrac', 'binom', 'dbinom', 'tbinom']);

/** Is the character at `i` escaped by a backslash? */
function escaped(text, i) {
    let n = 0;
    for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) n++;
    return (n % 2) === 1;
}

/** The index just past the `{...}` starting at `i`, or -1. */
function matchGroup(text, i) {
    if (text[i] !== '{') return -1;
    let depth = 0;
    for (let k = i; k < text.length; k++) {
        const c = text[k];
        if (c === '\\') { k++; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (!depth) return k + 1; }
    }
    return -1;
}

/** Skip whitespace forwards from `i`. */
const skipWs = (text, i) => { let k = i; while (k < text.length && /\s/.test(text[k])) k++; return k; };

/**
 * The span an argument occupies: a braced group, a control sequence, or one
 * character — TeX's own rule for what `_`, `^` and `\sqrt` take.
 */
function argSpan(text, i) {
    const s = skipWs(text, i);
    if (s >= text.length) return null;
    if (text[s] === '{') {
        const e = matchGroup(text, s);
        return e < 0 ? null : { from: s + 1, to: e - 1, after: e };   // inside the braces
    }
    if (text[s] === '\\') {
        let e = s + 1;
        while (e < text.length && /[A-Za-z@]/.test(text[e])) e++;
        if (e === s + 1) e = s + 2;                              // \, \% \{ …
        return { from: s, to: e, after: e };
    }
    return { from: s, to: s + 1, after: s + 1 };
}

/**
 * The start of the token immediately BEFORE `i` — what a script attaches to.
 *
 * It matters that both scripts of one base report the SAME anchor: that is what
 * makes `x^{a}_{b}` and `x_{b}^{a}` canonicalise to the same order, so the two
 * spellings cannot produce two different alignments of the same picture.
 */
function baseStart(text, i) {
    let k = i - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    if (k < 0) return i;
    // `x_{m}^{p}`: walking back from the `^` lands on the SUBSCRIPT's group, but
    // both scripts belong to `x`. Keep walking past a script to its own base, or
    // the two spellings of one construct anchor differently and canonicalise
    // into two different orders.
    const throughScript = (start) => {
        let j = start - 1;
        while (j >= 0 && /\s/.test(text[j])) j--;
        return (j >= 0 && (text[j] === '_' || text[j] === '^') && !escaped(text, j))
            ? baseStart(text, j) : start;
    };
    if (text[k] === '}') {
        // Walk back to the matching brace.
        let depth = 0;
        for (let j = k; j >= 0; j--) {
            const c = text[j];
            if (c === '}' && !escaped(text, j)) depth++;
            else if (c === '{' && !escaped(text, j)) {
                depth--;
                if (!depth) {
                    // A group can itself be the argument of a command: \mathrm{x}_i
                    let m = j - 1;
                    while (m >= 0 && /[A-Za-z@]/.test(text[m])) m--;
                    return throughScript((m >= 0 && text[m] === '\\') ? m : j);
                }
            }
        }
        return k;
    }
    if (/[A-Za-z@]/.test(text[k])) {
        let j = k;
        while (j >= 0 && /[A-Za-z@]/.test(text[j])) j--;
        return throughScript((j >= 0 && text[j] === '\\') ? j : k);   // \alpha, or one letter
    }
    return throughScript(k);
}

/**
 * The structural spans of a maths body.
 *
 * @param {string} text
 * @returns {{from:number,to:number,role:string,rank:number,anchor:number}[]}
 *   `from`/`to` are offsets into `text`; `anchor` is the offset the group hangs
 *   off — the base token for a script, the command itself for a fraction — and
 *   `rank` orders the groups sharing one anchor.
 */
function mathSpans(text) {
    const src = String(text || '');
    const spans = [];
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') {
            let e = i + 1;
            while (e < src.length && /[A-Za-z@]/.test(src[e])) e++;
            const cmd = src.slice(i + 1, e);
            if (FRACTIONS.has(cmd)) {
                const a = argSpan(src, e);
                if (a) {
                    const b = argSpan(src, a.after);
                    spans.push({ from: a.from, to: a.to, role: 'num', rank: RANK.num, anchor: i });
                    if (b) spans.push({ from: b.from, to: b.to, role: 'den', rank: RANK.den, anchor: i });
                    // DO NOT SKIP THE ARGUMENTS. A nested \frac lives inside
                    // them, and its own spans are what tell the inner
                    // numerator from the inner denominator.
                    i = e - 1;
                    continue;
                }
            } else if (cmd === 'sqrt') {
                let at = e;
                if (src[skipWs(src, at)] === '[') {              // the optional index
                    const close = src.indexOf(']', at);
                    if (close > 0) at = close + 1;
                }
                const a = argSpan(src, at);
                if (a) {
                    spans.push({ from: a.from, to: a.to, role: 'root', rank: RANK.root, anchor: i });
                    i = e - 1;
                    continue;
                }
            }
            i = Math.max(i, e - 1);
            continue;
        }
        if ((c === '_' || c === '^') && !escaped(src, i)) {
            const a = argSpan(src, i + 1);
            if (!a) continue;
            const role = c === '_' ? 'sub' : 'sup';
            spans.push({ from: a.from, to: a.to, role, rank: RANK[role], anchor: baseStart(src, i) });
            // Scan ON through the argument: `x_{y^2}` has a script inside a
            // script, and skipping the group would lose the inner one.
        }
    }
    return spans;
}

/**
 * A lookup from offset to structural position.
 *
 * `path` is what canonicalises the token order: base tokens sort by their own
 * offset, a group's tokens sort after the base they hang off and among
 * themselves by rank, and nesting extends the path — so comparing two paths
 * lexicographically puts the whole object into ONE reading order that the page
 * can be put into as well.
 */
function roleIndex(text) {
    const spans = mathSpans(text);
    // Innermost last, so a scan can build the enclosing chain in order.
    spans.sort((a, b) => a.from - b.from || b.to - a.to);
    return {
        spans,
        /** @returns {{role:string, level:string, depth:number, path:number[]}} */
        at(offset) {
            const chain = [];
            for (const s of spans) {
                if (offset >= s.from && offset < s.to) chain.push(s);
                else if (s.from > offset) break;
            }
            const path = [];
            for (const s of chain) path.push(s.anchor, s.rank);
            path.push(offset);
            const inner = chain.length ? chain[chain.length - 1] : null;
            return {
                role: inner ? inner.role : 'base',
                level: inner ? (ROLE_LEVEL[inner.role] || LEVEL.BASE) : LEVEL.BASE,
                depth: chain.length,
                path,
                chain,
            };
        },
    };
}

/** Lexicographic order on the paths `roleIndex` produces. */
function comparePaths(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
}

module.exports = { LEVEL, ROLE_LEVEL, RANK, mathSpans, roleIndex, comparePaths, matchGroup, argSpan, baseStart };
