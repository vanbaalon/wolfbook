// math-keys.js — Mathematica's structure keys in the edit card's LaTeX.
//
//   ⌃^ or ⌃6  superscript        x^{▮}      (a selection becomes the base)
//   ⌃_ or ⌃-  subscript          x_{▮}
//   ⌃/        fraction           \frac{x}{▮} (a selection, or the term just
//                                             before the caret, is the numerator)
//   ⌃2        square root        \sqrt{▮}   (a selection goes under it)
//   ⌃Space    out of the structure: past the group the caret is in
//   Tab       to the next empty slot {}
//   ⌃,        a column: an empty cell after the caret's, in every row of the
//             matrix (or aligned rows); outside one, a row vector from the term
//   ⌃Enter    a row below the caret's, with as many cells; outside a matrix,
//             a column vector from the term
//
// Outside maths the structure is written in $…$, so the result always
// compiles. Pure (no DOM): the card applies the answer as one text insertion,
// so it is one undo step and reaches the source like typing.

const MATH_ENVS = /\\(begin|end)\s*\{(equation|align|alignat|gather|multline|eqnarray|displaymath|math|flalign|split|gathered|aligned|cases|matrix|pmatrix|bmatrix|vmatrix|Bmatrix|Vmatrix|array)\*?\}/g;

/** Is `pos` of `text` inside maths: a maths environment, \[ \], \( \), $$ $$ or $ $? */
export function inMathAt(text, pos) {
    const s = String(text || '');
    let depth = 0;
    for (const m of s.slice(0, pos).matchAll(MATH_ENVS)) depth += m[1] === 'begin' ? 1 : -1;
    if (depth > 0) return true;
    let inline = false, display = false;
    for (let i = 0; i < pos && i < s.length; i++) {
        const c = s[i];
        if (c === '%' && s[i - 1] !== '\\') { const nl = s.indexOf('\n', i); if (nl < 0 || nl >= pos) break; i = nl; continue; }
        if (c === '\\') {
            const n = s[i + 1];
            if (n === '[' || n === '(') display = true;
            else if (n === ']' || n === ')') display = false;
            i++;
            continue;
        }
        if (c === '$') {
            if (s[i + 1] === '$') { display = !display; i++; }
            else inline = !inline;
        }
    }
    return inline || display;
}

/** Environments whose rows are `\\` and cells `&`. */
const GRIDS = new Set(['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'array', 'cases',
    'aligned', 'align', 'alignat', 'eqnarray', 'split', 'gathered', 'flalign']);

/** The grid environment around `pos`: its body's bounds, or null. */
function gridAt(s, pos) {
    const stack = [];
    for (const m of s.matchAll(/\\(begin|end)\s*\{([A-Za-z]+)\*?\}(\{[^}]*\})?/g)) {
        if (m.index >= pos) {
            if (m[1] === 'end' && stack.length) {
                const top = stack[stack.length - 1];
                if (top.env === m[2] && GRIDS.has(top.env)) return { start: top.body, end: m.index };
                stack.pop();
            }
            continue;
        }
        if (m[1] === 'begin') stack.push({ env: m[2], body: m.index + m[0].length });
        else { const i = stack.map(x => x.env).lastIndexOf(m[2]); if (i >= 0) stack.length = i; }
    }
    return null;
}

/** Split `body` at top-level `sep` (a regex source), keeping the separators: [parts, seps]. */
function splitTop(body, sep) {
    const parts = [], seps = [];
    const re = new RegExp(sep, 'y');
    let depth = 0, from = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        if (depth) { if (c === '\\') i++; continue; }
        re.lastIndex = i;
        const m = re.exec(body);
        if (m) { parts.push(body.slice(from, i)); seps.push(m[0]); i += m[0].length - 1; from = i + 1; continue; }
        if (c === '\\') i++;
    }
    parts.push(body.slice(from));
    return [parts, seps];
}
const ROW_SEP = /\\\\(\[[^\]]*\])?[ \t]*\n?/.source;

/** ⌃, and ⌃Enter inside a grid: the new body, and the caret in it. */
function gridKey(s, grid, pos, key) {
    const body = s.slice(grid.start, grid.end);
    const [rows, rowSeps] = splitTop(body, ROW_SEP);
    // The caret's row and cell.
    let at = pos - grid.start, r = 0;
    while (r < rows.length - 1 && at > rows[r].length + rowSeps[r].length) { at -= rows[r].length + rowSeps[r].length; r++; }
    const cellsOf = row => splitTop(row, '&')[0];
    const cells = cellsOf(rows[r]);
    let c = 0, left = at;
    while (c < cells.length - 1 && left > cells[c].length) { left -= cells[c].length + 1; c++; }
    let caretRow = r, caretCell = c + 1;
    let out;
    if (key === 'col') {
        out = rows.map(row => { const cs = cellsOf(row); cs.splice(Math.min(c + 1, cs.length), 0, '  '); return cs; });
    } else {
        out = rows.map(cellsOf);
        const fresh = Array.from({ length: cells.length }, () => '  ');
        out.splice(r + 1, 0, fresh);
        // The last row may have had no separator: the new one gets one before it.
        rowSeps.splice(r, 0, '\\\\\n');
        if (rowSeps.length > out.length - 1) rowSeps.length = out.length - 1;
        caretRow = r + 1; caretCell = 0;
    }
    let text = '', caret = 0;
    out.forEach((cs, i) => {
        cs.forEach((cell, j) => {
            if (i === caretRow && j === caretCell) caret = text.length + (cell.startsWith(' ') ? 1 : 0);
            text += cell + (j < cs.length - 1 ? '&' : '');
        });
        if (i < out.length - 1) text += rowSeps[i] ?? '\\\\\n';
    });
    return { start: grid.start, end: grid.end, insert: text, caret: grid.start + caret };
}

/** Where the term that ends at `pos` starts: \cmd{…}, a {…} group, (…), a word, a number, \alpha. */
function termStart(s, pos) {
    let i = pos;
    const matchBack = (open, close) => {
        let d = 0;
        for (let j = i - 1; j >= 0; j--) {
            if (s[j] === close && s[j - 1] !== '\\') d++;
            else if (s[j] === open && s[j - 1] !== '\\' && --d === 0) return j;
        }
        return -1;
    };
    if (s[i - 1] === '}' || s[i - 1] === ')') {
        const o = matchBack(s[i - 1] === '}' ? '{' : '(', s[i - 1]);
        if (o < 0) return pos;
        i = o;
        // A command's argument, a sub/superscript's, or a further argument: take them with it.
        while (i > 0 && s[i - 1] === '}') { const o2 = (() => { const k = i; i = k; return matchBack('{', '}'); })(); if (o2 < 0) break; i = o2; }
        const cmd = /\\[A-Za-z]+\*?$/.exec(s.slice(0, i)) || /[\^_]$/.exec(s.slice(0, i));
        if (cmd) i -= cmd[0].length;
        if (/[\^_]$/.test(s.slice(0, pos)) === false && /[A-Za-z0-9]$/.test(s.slice(0, i)) && /[\^_]/.test(s[i])) {
            const base = /(\\[A-Za-z]+|[A-Za-z0-9.]+)$/.exec(s.slice(0, i));
            if (base) i -= base[0].length;
        }
        return i;
    }
    const word = /(\\[A-Za-z]+|[A-Za-z0-9.]+)$/.exec(s.slice(0, i));
    return word ? i - word[0].length : pos;
}

/**
 * The edit a structure key makes: `{ start, end, insert, caret }` (replace
 * [start, end) of `text` with `insert`, then put the caret at `caret`, an
 * offset in the new text), `{ caret }` to move only, or null (not handled).
 */
export function mathKey(text, start, end, key) {
    const s = String(text || '');
    const sel = s.slice(start, end);
    const math = inMathAt(s, start);
    const wrap = (from, to, body, caretIn) => math
        ? { start: from, end: to, insert: body, caret: from + caretIn }
        : { start: from, end: to, insert: `$${body}$`, caret: from + 1 + caretIn };
    switch (key) {
        case 'sup':
        case 'sub': {
            const op = key === 'sup' ? '^' : '_';
            const body = `${sel}${op}{}`;
            return wrap(start, end, body, body.length - 1);
        }
        case 'frac': {
            if (sel) return wrap(start, end, `\\frac{${sel}}{}`, `\\frac{${sel}}{`.length);
            const from = math ? termStart(s, start) : start;
            const term = s.slice(from, start);
            return term ? wrap(from, start, `\\frac{${term}}{}`, `\\frac{${term}}{`.length)
                : wrap(start, end, '\\frac{}{}', '\\frac{'.length);
        }
        case 'sqrt':
            return sel ? wrap(start, end, `\\sqrt{${sel}}`, `\\sqrt{${sel}}`.length) : wrap(start, end, '\\sqrt{}', '\\sqrt{'.length);
        case 'exit': {
            // Past the closing brace of the group the caret is in (or out of $…$).
            let d = 0;
            for (let i = end; i < s.length; i++) {
                const c = s[i];
                if (c === '\\') { i++; continue; }
                if (c === '{') d++;
                else if (c === '}') { if (d === 0) return { caret: i + 1 }; d--; }
                else if (c === '$' && d === 0) return { caret: s[i + 1] === '$' ? i + 2 : i + 1 };
                else if (c === '\n' && s[i + 1] === '\n') break;
            }
            return null;
        }
        case 'col':
        case 'row': {
            const grid = math && gridAt(s, start);
            if (grid) return gridKey(s, grid, start, key);
            // Outside a matrix: a vector from the selection, or the term before the caret.
            const from = sel ? start : math ? termStart(s, start) : start;
            const first = s.slice(from, sel ? end : start);
            const sepr = key === 'col' ? ' & ' : ' \\\\ ';
            const head = `\\begin{pmatrix} ${first}${sepr}`;
            return wrap(from, sel ? end : start, `${head} \\end{pmatrix}`, head.length);
        }
        case 'tab': {
            const at = s.indexOf('{}', end);
            return at >= 0 && at - end < 200 ? { caret: at + 1 } : null;
        }
        default: return null;
    }
}

/** The key a keydown means, Mathematica's way (Control, on every platform), or null. */
export function mathKeyFor(event) {
    if (!event.ctrlKey || event.metaKey || event.altKey) return null;
    const k = event.key;
    if (k === '^' || k === '6') return 'sup';
    if (k === '_' || k === '-') return 'sub';
    if (k === '/') return 'frac';
    if (k === '2' || k === '@') return 'sqrt';
    if (k === ' ') return 'exit';
    if (k === ',') return 'col';
    if (k === 'Enter') return 'row';
    return null;
}

// Mathematica's escape aliases (Esc a Esc is α), as LaTeX commands: the
// Greek alphabet (Mathematica's letters: e is \epsilon, ce \varepsilon, j
// \varphi) and the symbols a writer reaches for most.
const ALIASES = {
    a: 'alpha', b: 'beta', g: 'gamma', d: 'delta', e: 'epsilon', ce: 'varepsilon', z: 'zeta', h: 'eta', et: 'eta',
    q: 'theta', th: 'theta', cq: 'vartheta', cth: 'vartheta', i: 'iota', k: 'kappa', l: 'lambda', m: 'mu', n: 'nu',
    x: 'xi', p: 'pi', cp: 'varpi', r: 'rho', cr: 'varrho', s: 'sigma', fs: 'varsigma', t: 'tau', u: 'upsilon',
    f: 'phi', ph: 'phi', j: 'varphi', cph: 'varphi', c: 'chi', ch: 'chi', y: 'psi', ps: 'psi', w: 'omega', o: 'omega',
    G: 'Gamma', D: 'Delta', Q: 'Theta', Th: 'Theta', L: 'Lambda', X: 'Xi', P: 'Pi', S: 'Sigma', U: 'Upsilon',
    F: 'Phi', Ph: 'Phi', Y: 'Psi', Ps: 'Psi', W: 'Omega', O: 'Omega',
    inf: 'infty', pd: 'partial', del: 'nabla', '->': 'to', '<-': 'leftarrow', '=>': 'Rightarrow', '<=': 'leq', '>=': 'geq',
    '!=': 'neq', '~~': 'approx', '===': 'equiv', xx: 'times', '.': 'cdot', '+-': 'pm', elem: 'in', sum: 'sum', int: 'int',
    prod: 'prod', hb: 'hbar', dg: 'dagger',
};

/** The LaTeX command an escape alias stands for (`a` → `\alpha`), or null. */
export function aliasCommand(alias) {
    const name = Object.prototype.hasOwnProperty.call(ALIASES, alias) ? ALIASES[alias] : null;
    return name ? `\\${name}` : null;
}

/** The Greek letters for the card's palette, as [command, glyph]. */
export const GREEK_PALETTE = [['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ϵ'], ['varepsilon', 'ε'],
    ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'], ['kappa', 'κ'], ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['pi', 'π'],
    ['rho', 'ρ'], ['sigma', 'σ'], ['tau', 'τ'], ['phi', 'φ'], ['varphi', 'ϕ'], ['chi', 'χ'], ['psi', 'ψ'], ['omega', 'ω'],
    ['Gamma', 'Γ'], ['Delta', 'Δ'], ['Theta', 'Θ'], ['Lambda', 'Λ'], ['Xi', 'Ξ'], ['Pi', 'Π'], ['Sigma', 'Σ'], ['Phi', 'Φ'],
    ['Psi', 'Ψ'], ['Omega', 'Ω'], ['infty', '∞'], ['partial', '∂'], ['nabla', '∇']];

/**
 * The card's symbol palette, in groups as other maths editors keep them. An
 * item is [template, label, title?]: the template is inserted as is, or — with
 * `¦` in it — wrapped around the selection with the caret after it (a bracket
 * pair, an accent, a letter style). Outside maths the whole thing goes in `$…$`.
 * Commands from amssymb / amsmath say so in their titles.
 */
export const SYMBOL_GROUPS = [
    { id: 'greek', label: 'αβ', title: 'Greek letters — or type Esc a Esc for α, Esc D Esc for Δ',
        items: [...GREEK_PALETTE.filter(([n]) => !['infty', 'partial', 'nabla'].includes(n)),
            ['iota', 'ι'], ['upsilon', 'υ'], ['vartheta', 'ϑ'], ['varrho', 'ϱ'], ['varsigma', 'ς'], ['varpi', 'ϖ'], ['Upsilon', 'Υ']]
            .map(([n, g]) => [`\\${n}`, g]) },
    { id: 'arrows', label: '→', title: 'Arrows', items: [
        ['\\to', '→'], ['\\gets', '←'], ['\\leftrightarrow', '↔'], ['\\mapsto', '↦'], ['\\Rightarrow', '⇒'], ['\\Leftarrow', '⇐'],
        ['\\Leftrightarrow', '⇔'], ['\\implies', '⟹', '\\implies (amsmath)'], ['\\iff', '⟺'], ['\\longrightarrow', '⟶'], ['\\longmapsto', '⟼'],
        ['\\uparrow', '↑'], ['\\downarrow', '↓'], ['\\updownarrow', '↕'], ['\\nearrow', '↗'], ['\\searrow', '↘'], ['\\swarrow', '↙'], ['\\nwarrow', '↖'],
        ['\\hookrightarrow', '↪'], ['\\rightharpoonup', '⇀'], ['\\rightleftharpoons', '⇌'], ['\\xrightarrow{¦}', 'x→', '\\xrightarrow{…} (amsmath): the selection over the arrow'],
        ['\\xleftarrow{¦}', '←x', '\\xleftarrow{…} (amsmath)']] },
    { id: 'brackets', label: '⟨⟩', title: 'Brackets — around the selection', items: [
        ['\\left(¦\\right)', '( )'], ['\\left[¦\\right]', '[ ]'], ['\\left\\{¦\\right\\}', '{ }'], ['\\left\\langle ¦\\right\\rangle', '⟨ ⟩'],
        ['\\left|¦\\right|', '| |'], ['\\left\\|¦\\right\\|', '‖ ‖'], ['\\lfloor ¦\\rfloor', '⌊ ⌋'], ['\\lceil ¦\\rceil', '⌈ ⌉'],
        ['\\langle ¦|', '⟨ψ|', 'bra'], ['|¦\\rangle', '|ψ⟩', 'ket'], ['\\langle ¦\\rangle', '⟨ψ⟩', 'expectation value'],
        ['\\bigl(¦\\bigr)', 'big( )', '\\bigl( … \\bigr)'], ['\\Bigl(¦\\Bigr)', 'Big( )', '\\Bigl( … \\Bigr)'],
        ['\\overbrace{¦}', '⏞', '\\overbrace{…}'], ['\\underbrace{¦}', '⏟', '\\underbrace{…}']] },
    { id: 'relations', label: '≤', title: 'Relations', items: [
        ['\\leq', '≤'], ['\\geq', '≥'], ['\\neq', '≠'], ['\\approx', '≈'], ['\\sim', '∼'], ['\\simeq', '≃'], ['\\cong', '≅'], ['\\equiv', '≡'],
        ['\\propto', '∝'], ['\\ll', '≪'], ['\\gg', '≫'], ['\\doteq', '≐'], ['\\prec', '≺'], ['\\succ', '≻'], ['\\in', '∈'], ['\\notin', '∉'],
        ['\\ni', '∋'], ['\\subset', '⊂'], ['\\subseteq', '⊆'], ['\\supset', '⊃'], ['\\supseteq', '⊇'], ['\\perp', '⊥'], ['\\parallel', '∥'], ['\\mid', '∣']] },
    { id: 'operators', label: '±', title: 'Operators', items: [
        ['\\pm', '±'], ['\\mp', '∓'], ['\\times', '×'], ['\\div', '÷'], ['\\cdot', '·'], ['\\circ', '∘'], ['\\ast', '∗'], ['\\star', '⋆'],
        ['\\otimes', '⊗'], ['\\oplus', '⊕'], ['\\odot', '⊙'], ['\\wedge', '∧'], ['\\vee', '∨'], ['\\cap', '∩'], ['\\cup', '∪'],
        ['\\setminus', '∖'], ['\\dagger', '†'], ['\\ddagger', '‡']] },
    { id: 'big', label: '∑', title: 'Big operators and named functions', items: [
        ['\\sum', '∑'], ['\\prod', '∏'], ['\\coprod', '∐'], ['\\int', '∫'], ['\\iint', '∬', '\\iint (amsmath)'], ['\\iiint', '∭', '\\iiint (amsmath)'],
        ['\\oint', '∮'], ['\\bigcup', '⋃'], ['\\bigcap', '⋂'], ['\\bigoplus', '⨁'], ['\\bigotimes', '⨂'],
        ['\\lim', 'lim'], ['\\sup', 'sup'], ['\\inf', 'inf'], ['\\max', 'max'], ['\\min', 'min'], ['\\det', 'det'], ['\\log', 'log'],
        ['\\exp', 'exp'], ['\\sin', 'sin'], ['\\cos', 'cos'], ['\\operatorname{¦}', 'op', '\\operatorname{…} (amsmath)']] },
    { id: 'accents', label: 'â', title: 'Accents — on the selection', items: [
        ['\\hat{¦}', 'â'], ['\\bar{¦}', 'ā'], ['\\tilde{¦}', 'ã'], ['\\dot{¦}', 'ȧ'], ['\\ddot{¦}', 'ä'], ['\\vec{¦}', 'a⃗'],
        ['\\check{¦}', 'ǎ'], ['\\breve{¦}', 'ă'], ['\\widehat{¦}', 'âb', '\\widehat{…}'], ['\\widetilde{¦}', 'ãb', '\\widetilde{…}'],
        ['\\overline{¦}', 'a̅b', '\\overline{…}'], ['\\underline{¦}', 'a̲b', '\\underline{…}']] },
    { id: 'styles', label: '𝔸', title: 'Letter styles — on the selection', items: [
        ['\\mathbb{¦}', '𝔸', '\\mathbb{…} (amssymb)'], ['\\mathcal{¦}', '𝒜', '\\mathcal{…}'], ['\\mathfrak{¦}', '𝔄', '\\mathfrak{…} (amssymb)'],
        ['\\mathrm{¦}', 'A', '\\mathrm{…}'], ['\\mathbf{¦}', '𝐀', '\\mathbf{…}'], ['\\mathsf{¦}', '𝖠', '\\mathsf{…}'],
        ['\\boldsymbol{¦}', '𝜶', '\\boldsymbol{…} (amsmath)'], ['\\text{¦}', 'text', '\\text{…} (amsmath)'],
        ['\\mathbb{R}', 'ℝ', '\\mathbb{R} (amssymb)'], ['\\mathbb{C}', 'ℂ', '\\mathbb{C} (amssymb)'], ['\\mathbb{Z}', 'ℤ', '\\mathbb{Z} (amssymb)'],
        ['\\mathbb{N}', 'ℕ', '\\mathbb{N} (amssymb)'], ['\\mathbb{Q}', 'ℚ', '\\mathbb{Q} (amssymb)']] },
    { id: 'misc', label: '∀∞', title: 'Logic, sets and other symbols', items: [
        ['\\forall', '∀'], ['\\exists', '∃'], ['\\nexists', '∄', '\\nexists (amssymb)'], ['\\neg', '¬'], ['\\emptyset', '∅'],
        ['\\infty', '∞'], ['\\partial', '∂'], ['\\nabla', '∇'], ['\\hbar', 'ℏ'], ['\\ell', 'ℓ'], ['\\Re', 'ℜ'], ['\\Im', 'ℑ'],
        ['\\aleph', 'ℵ'], ['\\wp', '℘'], ['\\angle', '∠'], ['\\triangle', '△'], ['\\prime', '′'],
        ['\\ldots', '…'], ['\\cdots', '⋯'], ['\\vdots', '⋮'], ['\\ddots', '⋱']] },
];

/**
 * The edit a palette item makes on `text` with the selection `start..end`:
 * `{ start, end, insert, caret }`. `inMath` says whether `start` is in maths.
 */
export function symbolEdit(text, start, end, template, inMath) {
    const sel = text.slice(start, end);
    let body, caret;
    if (template.includes('¦')) {
        const [a, b] = template.split('¦');
        body = a + sel + b;
        caret = start + a.length + sel.length;
    } else {
        // A command word followed by a letter needs a space to stay one word.
        const tail = /[A-Za-z]$/.test(template) && /^[A-Za-z]/.test(text.slice(end, end + 1)) ? ' ' : '';
        body = template + tail;
        caret = start + body.length;
    }
    if (inMath) return { start, end, insert: body, caret };
    // Outside maths: the same inside $…$ — the caret stays where it was put,
    // or after the closing $ when the item has no slot.
    return { start, end, insert: `$${body}$`, caret: template.includes('¦') ? caret + 1 : caret + 2 };
}

/**
 * The edit an alias makes, from `from` (where Esc began it) to `to` (the
 * caret at the closing Esc): the command, spaced from a letter after it.
 * Null when the alias names nothing.
 */
export function aliasEdit(text, from, to) {
    const command = aliasCommand(String(text || '').slice(from, to));
    if (!command) return null;
    const insert = /^[A-Za-z]/.test(String(text || '').slice(to, to + 1)) ? `${command} ` : command;
    return { start: from, end: to, insert, caret: from + insert.length };
}
