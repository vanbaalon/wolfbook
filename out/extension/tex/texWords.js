// texWords.js — matching rendered words back to source columns, and back again.
//
// Pure: no vscode, no pdf.js, never throws.
//
// WHY THIS EXISTS. SyncTeX records carry a LINE and no column. For an equation
// that is enough — the object is the unit. For prose it is not: draft.tex
// line 3086 is a single 250-character source line that wraps into three
// typeset lines, so "the source line" is a poor answer to "what did I click
// on", and "the paragraph" is a much worse one.
//
// The PDF's own text layer does carry words and their positions, and Spike C
// measured pdf.js's text items against poppler at median x-IoU 1.000 with
// 97.9-98.7% coverage. So the missing column can be recovered by matching the
// WORD: rendered word -> source column, and source word -> rendered item.
//
// The matching has to survive LaTeX, which is the whole difficulty:
//   $\mathcal{Q}_1$ renders as Q1, \eqref{x} as (3.4), -- as an en dash.
// So markup is stripped to a "visible" projection of the line, an index is
// kept from every visible character back to its source offset, and matching
// happens in that projection.

/**
 * Stands in for something rendered whose glyphs we cannot predict — math, an
 * \eqref, a Greek letter. It occupies one position so the words on either side
 * keep their order, and it never matches a word, so nothing is ever guessed
 * about what it contains.
 */
const OPAQUE = '\u0001';

/** Control sequences whose ARGUMENT is typeset (so its text is visible). */
const TEXT_ARG_CMDS = new Set([
    'text', 'textrm', 'textit', 'textbf', 'textsf', 'texttt', 'textsc', 'textmd',
    'textup', 'textsl', 'emph', 'mbox', 'hbox', 'caption', 'footnote', 'mathrm',
    'section', 'subsection', 'subsubsection', 'paragraph', 'title', 'author',
]);

/** Control sequences that produce NO visible text at all. */
const INVISIBLE_CMDS = new Set([
    'begin', 'end', 'label', 'index', 'nonumber', 'noindent', 'centering', 'small', 'footnotesize',
    'normalsize', 'large', 'Large', 'huge', 'clearpage', 'newpage', 'hfill', 'vfill',
    'bigskip', 'medskip', 'smallskip', 'par', 'linebreak', 'newline',
]);

/**
 * Project a source line onto what a reader sees, keeping a map back.
 *
 * @returns {{text: string, map: number[]}} `map[i]` is the source offset
 *   (relative to the start of `src`) that produced `text[i]`.
 */
function visibleProjection(src, opts = {}) {
    const out = [];
    const map = [];
    const end = [];
    const math = [];
    const inMath = !!opts.inMath;
    const macros = opts.macros instanceof Map ? opts.macros : null;
    const depth = opts.depth || 0;
    // `to` is where the SOURCE construct that produced this character ends.
    // For an ordinary letter that is the next offset; for an expanded macro it
    // is the end of the whole call, so clicking the rendered x of \bx selects
    // `\bx` and not one character of it.
    const push = (ch, at, m = inMath, to = at + 1) => {
        out.push(ch); map.push(at); end.push(to); math.push(m);
    };

    let i = 0;
    const n = src.length;

    const skipBracedArgs = () => {
        while (i < n) {
            if (src[i] === '[') { const c2 = src.indexOf(']', i); if (c2 < 0) break; i = c2 + 1; continue; }
            if (src[i] === '{') { const c2 = matchBrace(src, i); if (c2 < 0) break; i = c2 + 1; continue; }
            break;
        }
    };

    while (i < n) {
        const c = src[i];

        if (c === '%' && (i === 0 || src[i - 1] !== '\\')) break;   // comment to EOL

        if (c === '$' && !inMath) {
            // MATH IS PROJECTED, NOT SKIPPED.
            //
            // Treating $...$ as one opaque blob made every equation a single
            // position, so clicking `a` in \frac{a}{b} could only ever select
            // the whole equation. The letters and digits inside math ARE
            // typeset literally — \frac{a}{b} prints "a" and "b", \mathcal{Q}_1
            // prints "Q" and "1" — so projecting them, tagged as math, makes
            // each one addressable while keeping prose matching separate.
            const close = findMathEnd(src, i);
            const delim = src.startsWith('$$', i) ? 2 : 1;
            const inner = visibleProjection(src.slice(i + delim, Math.max(i + delim, close - delim)),
                { inMath: true, macros, depth });
            for (let k = 0; k < inner.text.length; k++) {
                push(inner.text[k], i + delim + inner.map[k], true, i + delim + inner.end[k]);
            }
            i = close;
            continue;
        }

        if (c === '\\') {
            const m = /^\\([A-Za-z@]+)\s*/.exec(src.slice(i));
            if (!m) {
                if (i + 1 < n) { push(src[i + 1], i + 1); i += 2; continue; }  // \& \% \_
                i++; continue;
            }
            const name = m[1];
            const callStart = i;
            i += m[0].length;
            if (INVISIBLE_CMDS.has(name)) { skipBracedArgs(); continue; }

            // A NAMED SYMBOL PRINTS A GLYPH WE CAN NAME.
            // \Psi prints Ψ, and the PDF's text layer reports Ψ, so the two can
            // be matched. Leaving it opaque is why clicking a Greek letter used
            // to select the whole equation instead.
            const sym = SYMBOL_GLYPHS[name];
            // Span the COMMAND only: the regex ate any trailing space, and a
            // selection that includes it looks sloppy and breaks round trips.
            if (sym) { push(sym, callStart, inMath, callStart + 1 + name.length); continue; }

            // AN OPERATOR NAME PRINTS ITS OWN LETTERS. \cos typesets "cos", so
            // each letter is addressable and maps back to the whole command —
            // clicking the rendered c of cos θ selects \cos, not one char.
            if (inMath && MATH_OPERATORS.has(name)) {
                const printed = (name === 'bmod' || name === 'pmod') ? 'mod' : name;
                const to = callStart + 1 + name.length;
                for (const ch of printed) push(ch, callStart, true, to);
                continue;
            }

            // \sqrt prints the radical AND typesets its argument — so the √ is
            // pushed as a glyph and the braces still recurse below.
            if (inMath && name === 'sqrt') {
                push('√', callStart, true, callStart + 1 + name.length);
            }

            // A USER MACRO IS NOT OPAQUE — ITS DEFINITION IS RIGHT THERE.
            // \bx is \boldsymbol{x}, which prints x. Without expanding it the
            // projection of a real paper's maths is nearly empty, so nothing
            // matches and every click falls back to "the whole equation".
            // Everything the expansion produces is mapped to the CALL, so the
            // selection lands on `\bx` — the thing the writer would edit.
            if (macros && macros.has(name) && depth < 8) {
                const def = macros.get(name);
                const args = [];
                let j = i;
                for (let a = 0; a < (def.params || 0); a++) {
                    while (j < n && /\s/.test(src[j])) j++;
                    if (src[j] !== '{') break;
                    const close = matchBrace(src, j);
                    if (close < 0) break;
                    args.push(src.slice(j + 1, close));
                    j = close + 1;
                }
                const body = String(def.body || '').replace(/#(\d)/g, (_, d) => args[+d - 1] ?? '');
                const inner = visibleProjection(body, { inMath, macros, depth: depth + 1 });
                // The span ends at the last consumed ARGUMENT — or, with none,
                // at the command itself: the regex ate any trailing space, and
                // a selection that includes it looks sloppy.
                const to = args.length ? j : callStart + 1 + name.length;
                for (let k = 0; k < inner.text.length; k++) push(inner.text[k], callStart, inMath, to);
                i = j;
                continue;
            }
            if (TEXT_ARG_CMDS.has(name)) {
                if (src[i] === '{') {
                    const close = matchBrace(src, i);
                    if (close > 0) {
                        const inner = visibleProjection(src.slice(i + 1, close), { macros, depth, inMath });
                        for (let k = 0; k < inner.text.length; k++) {
                            push(inner.text[k], i + 1 + inner.map[k], inMath, i + 1 + inner.end[k]);
                        }
                        i = close + 1;
                        continue;
                    }
                }
                continue;
            }
            if (inMath) {
                // AN ACCENT PRINTS A MARK OF ITS OWN, AFTER ITS ARGUMENT.
                //
                // `\dot x` typesets ẋ as TWO glyphs, and pdf.js reports them
                // separately with the accent very slightly to the RIGHT of the
                // base (measured: x at 267.6, the dot at 269.5), so in reading
                // order the base comes first and the mark second. Emitting them
                // in that order is what lets both match; the mark carries the
                // \dot call as its source, so clicking the dot selects \dot and
                // clicking the x selects the x — which is what a writer means.
                const acc = ACCENT_GLYPHS[name];
                if (acc) {
                    const to = callStart + 1 + name.length;
                    if (src[i] === '{') {
                        const close = matchBrace(src, i);
                        if (close > 0) {
                            const inner = visibleProjection(src.slice(i + 1, close), { inMath: true, macros, depth });
                            for (let k = 0; k < inner.text.length; k++) {
                                push(inner.text[k], i + 1 + inner.map[k], true, i + 1 + inner.end[k]);
                            }
                            i = close + 1;
                        }
                    } else if (/[A-Za-z0-9]/.test(src[i] || '')) {
                        push(src[i], i, true);      // \dot x, with no braces
                        i++;
                    }
                    push(acc, callStart, true, to);
                    continue;
                }
                // \frac, \mathcal, \left … are structure: they print nothing
                // themselves, and their braced arguments hold the glyphs. So
                // recurse rather than skip, which is what makes the `a` inside
                // \frac{a}{b} reachable at its own source offset.
                if (GLYPH_CMDS.has(name)) { push(OPAQUE, i, true); skipBracedArgs(); continue; }
                while (i < n && (src[i] === '{' || src[i] === '[')) {
                    const openCh = src[i];
                    const close = openCh === '{' ? matchBrace(src, i) : src.indexOf(']', i);
                    if (close < 0) break;
                    if (openCh === '{') {
                        const inner = visibleProjection(src.slice(i + 1, close), { inMath: true, macros, depth });
                        for (let k = 0; k < inner.text.length; k++) {
                            push(inner.text[k], i + 1 + inner.map[k], true, i + 1 + inner.end[k]);
                        }
                    }
                    i = close + 1;
                }
                continue;
            }
            push(OPAQUE, i);          // \ref, \cite … renders as something
            skipBracedArgs();
            continue;
        }

        if (c === '{' || c === '}') { i++; continue; }
        if (c === '~') { push(' ', i); i++; continue; }
        if (inMath && (c === '_' || c === '^' || c === '&' || c === ' ' || c === '\t')) { i++; continue; }
        push(c, i);
        i++;
    }

    return { text: out.join(''), map, end, math };
}

/**
 * Named symbols, and the character each one prints.
 *
 * The PDF's text layer reports the Unicode a glyph maps to, so a command whose
 * output is a single known character can be matched by that character. Only
 * unambiguous ones belong here: a wrong entry silently sends a click to the
 * wrong place, which is worse than declining.
 */
const SYMBOL_GLYPHS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', varrho: 'ϱ',
    sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ',
    chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    infty: '∞', partial: '∂', nabla: '∇', times: '×', cdot: '·', pm: '±',
    mp: '∓', leq: '≤', geq: '≥', neq: '≠', approx: '≈', sim: '∼', equiv: '≡',
    rightarrow: '→', to: '→', leftarrow: '←', Rightarrow: '⇒', mapsto: '↦',
    int: '∫', sum: '∑', prod: '∏', oint: '∮', hbar: 'ℏ', ell: 'ℓ',
    langle: '⟨', rangle: '⟩', mid: '∣', in: '∈', otimes: '⊗', oplus: '⊕',
    dagger: '†', star: '⋆', circ: '∘', cup: '∪', cap: '∩', subset: '⊂',
    // Arrows. \uparrow/\downarrow are spin labels in half the hep-th corpus
    // (54 uses each in the reference paper) and were unmatchable before.
    uparrow: '↑', downarrow: '↓', Uparrow: '⇑', Downarrow: '⇓',
    updownarrow: '↕', leftrightarrow: '↔', Leftrightarrow: '⇔', iff: '⇔',
    gets: '←', Leftarrow: '⇐', longrightarrow: '⟶', longleftarrow: '⟵',
    Longrightarrow: '⟹', Longleftarrow: '⟸', longmapsto: '⟼',
    hookrightarrow: '↪', hookleftarrow: '↩', nearrow: '↗', searrow: '↘',
    swarrow: '↙', nwarrow: '↖', rightharpoonup: '⇀', leftharpoonup: '↼',
    // Relations and set/logic operators.
    ll: '≪', gg: '≫', simeq: '≃', cong: '≅', propto: '∝', asymp: '≍',
    perp: '⊥', parallel: '∥', ne: '≠', le: '≤', ge: '≥',
    subseteq: '⊆', supseteq: '⊇', supset: '⊃', ni: '∋', notin: '∉',
    vdash: '⊢', dashv: '⊣', models: '⊨', top: '⊤', bot: '⊥',
    land: '∧', lor: '∨', wedge: '∧', vee: '∨', neg: '¬', lnot: '¬',
    setminus: '∖', smallsetminus: '∖', sqcup: '⊔', sqcap: '⊓',
    bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂',
    bigsqcup: '⨆', bigwedge: '⋀', bigvee: '⋁', coprod: '∐',
    iint: '∬', iiint: '∭', forall: '∀', exists: '∃', nexists: '∄',
    emptyset: '∅', varnothing: '∅', aleph: 'ℵ', Re: 'ℜ', Im: 'ℑ', wp: '℘',
    imath: 'ı', jmath: 'ȷ', angle: '∠', triangle: '△', Box: '□', square: '□',
    diamond: '⋄', bullet: '∙', ast: '∗', odot: '⊙', ominus: '⊖', oslash: '⊘',
    cdots: '⋯', vdots: '⋮', ddots: '⋱', prime: '′', degree: '°', surd: '√',
    // An ellipsis prints as separate dots, and a reader clicks one of them. As
    // one opaque marker it matched nothing; as three dots each of them resolves
    // to the command that printed it — the projection maps every character of a
    // multi-character expansion back to the whole call.
    ldots: '...', dots: '...',
    dag: '†', ddag: '‡', ddagger: '‡',
    lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
    Vert: '‖', lVert: '‖', rVert: '‖', vert: '|', lvert: '|', rvert: '|',
};

/**
 * Operator names \cos, \log, … — commands that typeset their own letters in
 * roman. Each printed letter maps back to the whole call.
 */
const MATH_OPERATORS = new Set([
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'coth', 'exp', 'log', 'ln', 'lg', 'det', 'dim',
    'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'arg', 'ker',
    'deg', 'gcd', 'hom', 'Pr', 'bmod', 'pmod',
]);

/**
 * Accents, and the standalone mark each one prints.
 *
 * The PDF's text layer reports these as ordinary glyphs beside their base
 * letter, not as combining characters — so they are matched as ordinary
 * glyphs. `\dot` alone appears 133 times in the reference paper.
 */
const ACCENT_GLYPHS = {
    dot: '\u02d9', ddot: '\u00a8', dddot: '\u20db',
    hat: '\u02c6', widehat: '\u02c6',
    tilde: '\u02dc', widetilde: '\u02dc',
    check: '\u02c7', breve: '\u02d8', acute: '\u00b4', grave: '`',
    mathring: '\u02da', bar: '\u00af', overline: '\u00af', vec: '\u20d7',
};

/** Math commands that print a glyph of their own rather than structure. */
const GLYPH_CMDS = new Set([
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
    'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi',
    'rho', 'sigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
    'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi',
    'Psi', 'Omega', 'infty', 'partial', 'nabla', 'times', 'cdot', 'pm', 'mp',
    'leq', 'geq', 'neq', 'approx', 'sim', 'equiv', 'rightarrow', 'to', 'ldots',
    'dots', 'cdots', 'int', 'sum', 'prod', 'oint', 'hbar', 'ell',
]);

function findMathEnd(src, at) {
    const delim = src.startsWith('$$', at) ? '$$' : '$';
    let i = at + delim.length;
    while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src.startsWith(delim, i)) return i + delim.length;
        i++;
    }
    return src.length;
}

function matchBrace(s, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === '{') depth++;
        else if (s[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/** Word tokens of a visible projection, with their offsets back into `src`. */
/**
 * @param {string} src
 * @param {{scope?: 'prose'|'math'|'both'}} opts
 *   `prose` (default) ignores anything inside math, so a stray `a` in an
 *   equation never claims a click on the word "a" in a sentence. `math` is the
 *   opposite, for resolving a click INSIDE an equation. Single math glyphs are
 *   returned as one-character words, which is exactly what makes the `a` of
 *   \frac{a}{b} selectable.
 */
function visibleWords(src, opts = {}) {
    const scope = opts.scope || 'prose';
    // `inMath` is the caller telling us this line sits inside a display-math
    // environment. It cannot be inferred from the line alone: \begin{equation}
    // opens math several lines earlier, and unlike $…$ there is no delimiter
    // on the line itself to key off.
    const { text, map, end, math } = visibleProjection(src,
        { inMath: !!opts.inMath, macros: opts.macros });
    const words = [];
    const re = scope === 'math'
        ? MATH_GLYPH_RE()                        // math is glyph-by-glyph
        : /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
    let m;
    while ((m = re.exec(text)) !== null) {
        const isMath = !!math[m.index];
        if (scope === 'prose' && isMath) continue;
        if (scope === 'math' && !isMath) continue;
        words.push({
            word: m[0],
            visibleIndex: m.index,
            inMath: isMath,
            sourceStart: map[m.index],
            // The END of the construct, which for an expanded macro is the end
            // of the whole call — so the selection covers `\bx`, not one char.
            sourceEnd: end[m.index + m[0].length - 1] ?? (map[m.index] + 1),
        });
    }
    return words;
}

// --- glyph folding -----------------------------------------------------------
// The PDF's text layer reports the UNICODE a glyph maps to, and for maths that
// is often a variant of what the source spells: the minus renders as U+2212
// while the source has '-', a prime as U+2032 while the source has "'", and a
// \mathcal{Q} or \mathbb{Q} can come back as 𝒬/ℚ while the projection produced
// a plain Q. Folding both sides onto one representative is what lets them meet.

/** One-character folds outside the Mathematical Alphanumerics block. */
const FOLD_ONE = {
    '−': '-',                 // minus sign -> hyphen-minus
    '′': "'", '″': '"',  // prime, double prime
    '‘': "'", '’': "'", '“': '"', '”': '"',
    '⋅': '·', '∙': '·',  // dot operator / bullet operator -> \cdot's ·
    '⁄': '/', '∕': '/',
    ' ': ' ',
    // Letterlike double-struck / script / fraktur (they live OUTSIDE 1D400).
    'ℂ': 'C', 'ℍ': 'H', 'ℕ': 'N', 'ℙ': 'P', 'ℚ': 'Q', 'ℝ': 'R', 'ℤ': 'Z',
    'ℬ': 'B', 'ℰ': 'E', 'ℱ': 'F', 'ℋ': 'H', 'ℐ': 'I', 'ℒ': 'L', 'ℳ': 'M',
    'ℛ': 'R', 'ℭ': 'C', 'ℌ': 'H', 'ℑ': 'I', 'ℜ': 'R', 'ℨ': 'Z',
    'ℊ': 'g', 'ℯ': 'e', 'ℴ': 'o', 'ı': 'i', 'ȷ': 'j',
};

/** The 58-letter cycle of each maths Greek alphabet at U+1D6A8…U+1D7CB. */
const MATH_GREEK = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡϴΣΤΥΦΧΨΩ∇αβγδεζηθικλμνξοπρςστυφχψω∂ϵϑϰϕϱϖ';

/** A Mathematical Alphanumeric Symbol -> its base letter/digit, else null. */
function foldMathAlnum(cp) {
    if (cp < 0x1D400 || cp > 0x1D7FF) return null;
    if (cp <= 0x1D6A3) {                       // bold/italic/script/… A-Z a-z
        const k = (cp - 0x1D400) % 52;
        return String.fromCharCode(k < 26 ? 65 + k : 97 + (k - 26));
    }
    if (cp <= 0x1D6A5) return cp === 0x1D6A4 ? 'i' : 'j';   // dotless
    if (cp >= 0x1D7CE) return String.fromCharCode(48 + (cp - 0x1D7CE) % 10);
    if (cp >= 0x1D6A8 && cp <= 0x1D7CB) return MATH_GREEK[(cp - 0x1D6A8) % 58] || null;
    return null;
}

/** Fold every character of `s` onto its matching representative. */
function foldGlyphs(s) {
    let out = '';
    for (const ch of String(s || '')) {
        out += FOLD_ONE[ch] || foldMathAlnum(ch.codePointAt(0)) || ch;
    }
    return out;
}

// ONE CHARACTER CLASS decides what counts as an addressable maths glyph:
// letters, digits, and the operators/relations/delimiters TeX actually prints.
// The old letters-and-digits class silently excluded EVERY operator (≤ ↑ ∫ = +
// − → are all category Sm), so clicking one resolved to the nearest letter
// instead. The webview (out/client/tex-viewer.js itemWords) carries a literal
// copy of this class — keep the two in sync.
// PUNCTUATION IS PART OF THE MATHS. `x_{m,k}` prints a comma, `k=0,1,2` prints
// three, and a full stop ends a displayed sentence — all of them are in the
// source, all of them are clicked, and while they were not in this class they
// could not resolve to anything: measured, every comma in the reference
// equation landed on the symbol beside it.
const MATH_GLYPH_RE = () => /[-,.\p{L}\p{N}\p{Sm}\p{Sk}·⋅†‡′″‖§¶°√⟨⟩⌈⌉⌊⌋()[\]/]/gu;

// Symbols must survive normalisation or a click on Ψ could never match: the
// letters-and-digits filter would erase it to the empty string.
const norm = (w) => {
    const raw = foldGlyphs(String(w || '').trim());
    if (!raw) return '';
    // Case-folding is right for prose — "The" and "the" are the same word — but
    // WRONG for symbols: Ψ and ψ are different letters that a physicist uses to
    // mean different things, and folding them let a click on one select the
    // other. Anything with no ASCII letter in it keeps its case.
    const t = /[A-Za-z]/.test(raw) ? raw.toLowerCase() : raw;
    const stripped = t.replace(/[^\p{L}\p{N}]/gu, '');
    return stripped || t;
};

/**
 * The macros a document defines, so the projection can see through them.
 *
 * A real paper's maths is almost entirely user macros — \bx, \SoV, \bdx — and
 * without their bodies the projection of an equation comes out empty, so every
 * click falls back to selecting the whole thing. Reading the definitions costs
 * one pass over the source and is the difference between per-symbol and
 * per-equation precision.
 *
 * @returns {Map<string,{params:number,body:string}>}
 */
function collectMacros(src) {
    const out = new Map();
    const text = String(src || '');
    // \newcommand{\name}[n][opt]{body} and \renewcommand / \providecommand,
    // with or without the braces around the name.
    const re = /\\(?:re|provide)?newcommand\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*(?:\[(\d+)\])?\s*(?:\[[^\]]*\]\s*)?\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const close = matchBrace(text, re.lastIndex - 1);
        if (close < 0) continue;
        out.set(m[1], { params: Number(m[2] || 0), body: text.slice(re.lastIndex, close) });
        re.lastIndex = close + 1;
    }
    // \DeclareMathOperator{\name}{printed}
    const op = /\\DeclareMathOperator\*?\s*\{\s*\\([A-Za-z@]+)\s*\}\s*\{/g;
    while ((m = op.exec(text)) !== null) {
        const close = matchBrace(text, op.lastIndex - 1);
        if (close < 0) continue;
        out.set(m[1], { params: 0, body: text.slice(op.lastIndex, close) });
        op.lastIndex = close + 1;
    }
    // \def\name{body} — no parameter text supported, which is the common case.
    const df = /\\def\s*\\([A-Za-z@]+)\s*\{/g;
    while ((m = df.exec(text)) !== null) {
        const close = matchBrace(text, df.lastIndex - 1);
        if (close < 0) continue;
        if (!out.has(m[1])) out.set(m[1], { params: 0, body: text.slice(df.lastIndex, close) });
        df.lastIndex = close + 1;
    }
    // A macro that expands to itself would spin; the depth cap catches it, but
    // dropping it here keeps the common case cheap.
    for (const [k, v] of out) if (new RegExp(`\\\\${k}(?![A-Za-z])`).test(v.body)) out.delete(k);
    return out;
}

/**
 * A word seen in the PDF -> its column range in a source line.
 *
 * `hint` (0..1) is roughly how far along the line the click was, and breaks
 * ties when a word occurs several times — "the" appearing twice in a long line
 * is not an unusual case.
 */
function findWordInLine(lineSrc, targetWord, hint = 0.5, opts = {}) {
    const target = norm(targetWord);
    if (!target) return null;
    const words = visibleWords(lineSrc, opts);
    if (!words.length) return null;

    const exact = words.filter(w => norm(w.word) === target);
    // A rendered PROSE word can be a hyphenation fragment, or carry punctuation
    // the projection kept, so fall back to containment before giving up.
    //
    // Glyph scope gets no such fallback. Every maths glyph is one character, so
    // containment matches almost anything — "alpha" would happily resolve to
    // the `a` of \frac{a}{b} and drop the cursor somewhere unrelated with no
    // sign that it guessed. Exact or nothing.
    const pool = exact.length ? exact
        : (opts.scope === 'math' ? []
            : words.filter(w => norm(w.word).includes(target) || target.includes(norm(w.word))));
    if (!pool.length) return null;

    let best = null; let bestD = Infinity;
    // WHICH occurrence — by INDEX when the caller can count them, by fraction
    // otherwise. The hint compares a RENDERED row fraction against a SOURCE
    // column fraction, and macro expansion skews the two apart: \bx costs 3
    // source columns and prints 1 glyph, so on a macro-heavy equation the
    // fractions disagree and the wrong `x` wins. When the source line typeset
    // as a single row, rendered order IS projection order, and the caller's
    // "the n-th such glyph on the row" picks exactly.
    const occ = Math.floor(opts.occurrence || 0);
    if (occ >= 1 && exact.length && pool === exact && occ <= pool.length) {
        best = pool[occ - 1]; bestD = 0;
    }
    if (!best) {
        best = pool[0];
        for (const w of pool) {
            const frac = w.sourceStart / Math.max(1, lineSrc.length);
            const d = Math.abs(frac - hint);
            if (d < bestD) { bestD = d; best = w; }
        }
    }
    return {
        start: best.sourceStart,
        end: best.sourceEnd,
        word: best.word,
        occurrence: pool.indexOf(best) + 1,
        total: pool.length,
        exact: exact.length > 0,
        inMath: !!best.inMath,
    };
}

/**
 * WHICH WORD, DECIDED BY THE WORDS AROUND IT.
 *
 * Every position-based answer to "which of these identical words did you click"
 * is fighting SyncTeX's line attribution, and MEASURED (check-occurrence.mjs)
 * that attribution is wrong at exactly the places it matters most: the first
 * word of a continuation row is attributed to the line the paragraph ENDS on,
 * and a word sitting across a row break can carry its neighbour's line number.
 * A source line's first word is nearly always at a row break, which is why
 * "clicking the first word of a line" was its own bug report.
 *
 * Reading is the way out, and it is what a person does: `kernel` between `the`
 * and `section` is a different `kernel` from the one between `the` and `again`.
 * The printed neighbours come from the PDF's own text layer, in reading order,
 * so they are immune to every attribution error above — and matching them
 * against the source projection identifies the LINE as well as the column,
 * which means a wrong line coming in does not produce a wrong answer going out.
 *
 * The window is several lines wide because prose flows across source lines: a
 * word at the start of line 12 has its printed predecessors at the end of
 * line 11.
 *
 * @param {string[]} lines        the whole file, 0-based
 * @param {number} centerLine     1-based line the map thinks was clicked
 * @param {string} word           the printed word
 * @param {string[]} before       printed words before it, nearest LAST
 * @param {string[]} after        printed words after it, nearest FIRST
 * @param {object} [opts]         {macros, span} — span defaults to 2 lines
 * @returns {{line:number,start:number,end:number,word:string,score:number,
 *            exact:boolean,unique:boolean}|null}
 */
function locateByContext(lines, centerLine, word, before, after, opts = {}) {
    const target = norm(word);
    if (!target || !Array.isArray(lines) || !lines.length) return null;
    const span = Number.isFinite(opts.span) ? opts.span : 2;
    const lo = Math.max(1, centerLine - span);
    const hi = Math.min(lines.length, centerLine + span);

    // The projected word sequence of the whole window, in reading order, each
    // word remembering the line and columns it came from.
    const seq = [];
    for (let n = lo; n <= hi; n++) {
        for (const w of visibleWords(lines[n - 1] || '', { macros: opts.macros })) {
            seq.push({ n, w, key: norm(w.word) });
        }
    }
    const hits = [];
    for (let i = 0; i < seq.length; i++) if (seq[i].key === target) hits.push(i);
    if (!hits.length) return null;

    const bef = (before || []).map(norm).filter(Boolean);
    const aft = (after || []).map(norm).filter(Boolean);
    if (!bef.length && !aft.length) return null;

    // NEARER NEIGHBOURS COUNT FOR MORE. A neighbour three words away can be a
    // coincidence; the word immediately beside it rarely is. Weighting also
    // breaks ties the plain count leaves: two candidates each matching two of
    // four context words are not equally good if one of them matches the two
    // ADJACENT ones.
    const weight = (d) => 1 / d;
    let best = null; let bestScore = 0; let ties = 0;
    for (const i of hits) {
        let score = 0;
        for (let k = 0; k < bef.length; k++) {
            const d = bef.length - k;                 // bef is nearest-LAST
            const j = i - d;
            if (j >= 0 && seq[j].key === bef[k]) score += weight(d);
        }
        for (let k = 0; k < aft.length; k++) {
            const d = k + 1;                          // aft is nearest-FIRST
            const j = i + d;
            if (j < seq.length && seq[j].key === aft[k]) score += weight(d);
        }
        if (score > bestScore + 1e-9) { bestScore = score; best = i; ties = 1; }
        else if (Math.abs(score - bestScore) < 1e-9 && score > 0) ties++;
    }
    // NO EVIDENCE MEANS NO ANSWER. A tie between two candidates is exactly the
    // case the caller's other heuristics exist for; claiming one of them here
    // would just be guessing with more machinery.
    if (best == null || bestScore <= 0 || ties > 1) return null;
    const { n, w } = seq[best];
    return {
        line: n,
        start: w.sourceStart,
        end: w.sourceEnd,
        word: w.word,
        score: bestScore,
        exact: true,
        unique: ties === 1,
        occurrence: 1,
        total: 1,
        inMath: !!w.inMath,
    };
}

/**
 * The inline-maths regions of a LINE: $…$, \\(…\\), \\[…\\] on one line.
 *
 * A display environment is recognised from the document model, but $E=mc^2$ in
 * the middle of a sentence is not an object — and a cursor inside it was being
 * answered with the nearest PROSE word, which is how a click meant for the
 * maths highlighted the word before it.
 */
function mathRegions(lineSrc) {
    const src = String(lineSrc || '');
    const out = [];
    let i = 0;
    while (i < src.length) {
        if (src[i] === '%' && (i === 0 || src[i - 1] !== '\\')) break;
        if (src[i] === '\\') {
            if (src[i + 1] === '(' || src[i + 1] === '[') {
                const close = src.indexOf(src[i + 1] === '(' ? '\\)' : '\\]', i + 2);
                out.push({ from: i, to: close < 0 ? src.length : close + 2 });
                i = close < 0 ? src.length : close + 2;
                continue;
            }
            i += 2; continue;
        }
        if (src[i] === '$') {
            const close = findMathEnd(src, i);
            out.push({ from: i, to: close });
            i = close;
            continue;
        }
        i++;
    }
    return out;
}

/** Is this column inside inline maths on its own line? */
function isInMath(lineSrc, column) {
    return mathRegions(lineSrc).some(r => column >= r.from && column <= r.to);
}

/**
 * The reverse: the word at a COLUMN, as it will appear in the PDF, plus which
 * occurrence it is — enough for the viewer to pick the right text item when
 * the same word appears twice on the line.
 */
function wordAtColumn(lineSrc, column, opts = {}) {
    const words = visibleWords(lineSrc, opts);
    if (!words.length) return null;
    // Half-open containment first: a cursor at the boundary between `(` and
    // `\bx` belongs to the token that STARTS there, not the one that ends.
    let hit = words.find(w => column >= w.sourceStart && column < w.sourceEnd)
        || words.find(w => column >= w.sourceStart && column <= w.sourceEnd);
    if (!hit) {
        let bestD = Infinity;
        for (const w of words) {
            const d = column < w.sourceStart ? w.sourceStart - column : column - w.sourceEnd;
            if (d < bestD) { bestD = d; hit = w; }
        }
        if (bestD > 40) return null;      // the cursor is not near prose at all
    }
    const same = words.filter(w => norm(w.word) === norm(hit.word));
    return {
        word: hit.word,
        occurrence: same.indexOf(hit) + 1,
        total: same.length,
        hint: hit.sourceStart / Math.max(1, lineSrc.length),
        sourceStart: hit.sourceStart,
        sourceEnd: hit.sourceEnd,
        inMath: !!hit.inMath,
    };
}

module.exports = {
    visibleProjection, visibleWords, findWordInLine, wordAtColumn, locateByContext,
    collectMacros, mathRegions, isInMath, OPAQUE, SYMBOL_GLYPHS,
    foldGlyphs, MATH_GLYPH_RE, MATH_OPERATORS, ACCENT_GLYPHS,
};
