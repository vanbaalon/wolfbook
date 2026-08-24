// auxLabels.js — what LaTeX itself decided each label is NUMBERED as.
//
// The structural projection knows a label's NAME and where it was declared.
// It cannot know that `eq:inversion-transpose` prints as "(12)" on page 7 —
// that is settled by LaTeX's own counters on a full compile, and it is written
// down in exactly one place: the `.aux` file next to the PDF.
//
//     \newlabel{eq:foo}{{(4)}{7}{}{equation.0.4}{}}
//     \bibcite{smith2020}{21}
//
// So a chip can say `eq:foo (4)` rather than just `eq:foo`, and a `\eqref`
// site can be located on the page by looking for the ink that reads "(4)".
//
// PURE, with the file system injected: the whole point of keeping it here is
// that it can be unit-tested without a compile. Nothing in here throws — a
// missing, half-written or unreadable `.aux` yields an empty map and the chips
// simply lose their numbers.

const path = require('path');

/**
 * Read one brace group starting at `i` (which must be the `{`).
 *
 * A regex cannot do this: `\newlabel{eq:a}{{(4)}{7}{}{equation.0.4}{}}` nests,
 * and the printed number itself may contain braces (`{\bf 4}`) or a `\relax`.
 * Returns null when the group never closes — a truncated `.aux`, which happens
 * whenever we read one while latexmk is still writing it.
 *
 * @returns {{body:string, end:number}|null}   `end` is just past the `}`
 */
function readGroup(s, i) {
    if (s[i] !== '{') return null;
    let depth = 0;
    for (let k = i; k < s.length; k++) {
        const c = s[k];
        if (c === '\\') { k++; continue; }          // \{ and \} are not delimiters
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return { body: s.slice(i + 1, k), end: k + 1 };
        }
    }
    return null;
}

/** Split a brace-group body into its own top-level `{...}` groups. */
function splitGroups(body) {
    const out = [];
    for (let i = 0; i < body.length; i++) {
        if (body[i] !== '{') continue;
        const g = readGroup(body, i);
        if (!g) break;
        out.push(g.body);
        i = g.end - 1;
    }
    return out;
}

/**
 * The printed form, as a reader would see it.
 *
 * hyperref writes `{4}` where plain LaTeX writes `{(4)}`, cleveref adds its own
 * wrappers, and a `\ref` to a subsection arrives as `{2.1}`. The chip shows
 * what was written, minus the TeX noise; the PARENTHESES are kept because they
 * are what an `\eqref` actually prints, and finding "(4)" on the page is how a
 * ref-site chip is placed.
 */
function cleanPrinted(raw) {
    let t = String(raw == null ? '' : raw);
    t = t.replace(/\\relax\b/g, '');
    // {\bf 4} / \textbf{4} — the number is what is left once the command goes.
    t = t.replace(/\\[a-zA-Z@]+\s*/g, '');
    t = t.replace(/[{}$]/g, '');
    t = t.trim();
    return t;
}

/** Is this a number a reader would recognise, rather than an internal anchor? */
function looksPrintable(t) {
    return !!t && t.length <= 24 && /[0-9A-Za-z]/.test(t);
}

/**
 * Every `\newlabel` and `\bibcite` in one `.aux` file's text.
 *
 * @param {string} text
 * @returns {{labels: Map<string,{printed:string, page:number|null}>,
 *            cites: Map<string,{printed:string}>,
 *            inputs: string[]}}
 */
function parseAux(text) {
    const labels = new Map();
    const cites = new Map();
    const inputs = [];
    const s = String(text || '');

    const re = /\\(newlabel|bibcite|@input)\s*(?=\{)/g;
    let m;
    while ((m = re.exec(s))) {
        const cmd = m[1];
        const first = readGroup(s, re.lastIndex);
        if (!first) break;                       // truncated: keep what we have
        if (cmd === '@input') {
            const f = first.body.trim();
            if (f) inputs.push(f);
            re.lastIndex = first.end;
            continue;
        }
        const second = readGroup(s, first.end);
        if (!second) break;
        const name = first.body.trim();
        re.lastIndex = second.end;
        if (!name) continue;

        if (cmd === 'bibcite') {
            const printed = cleanPrinted(second.body);
            if (looksPrintable(printed) && !cites.has(name)) cites.set(name, { printed });
            continue;
        }
        // \newlabel{name}{{printed}{page}{title}{anchor}{}}
        const parts = splitGroups(second.body);
        const printed = cleanPrinted(parts[0]);
        const pageRaw = cleanPrinted(parts[1]);
        const page = /^\d+$/.test(pageRaw) ? Number(pageRaw) : null;
        // A LABEL IS DECLARED ONCE. hyperref writes a second `\newlabel` for
        // the same name with a `@cref` suffix; the bare name is the one a
        // `\ref` resolves through, so the first wins and the rest are ignored.
        if (/@cref$/.test(name) || labels.has(name)) continue;
        labels.set(name, { printed: looksPrintable(printed) ? printed : '', page });
    }
    return { labels, cites, inputs };
}

/**
 * Read the compile's `.aux`, following the `\@input{sub.aux}` of an
 * `\include`d project one level down.
 *
 * @param {string} outDir  where the compile put its products
 * @param {string} root    the root .tex, whose basename is the job name
 * @param {{readFile:(p:string)=>string, exists:(p:string)=>boolean}} deps
 */
/**
 * The section numbers LaTeX actually printed, from the .aux's TOC lines.
 *
 *   \@writefile{toc}{\contentsline {section}{\numberline {1}Title}{5}{section.1}…}
 *   \@writefile{toc}{\contentsline {paragraph}{Unnumbered}{6}{section*.1}…}
 *
 * WHY THE .aux AND NOT THE .toc: these lines are in the .aux whether or not
 * the document ever calls \tableofcontents, and a preprint without a contents
 * page is the normal case. Reading the .toc would only work for papers that
 * print one.
 *
 * Only the `toc` stream is read. The same file carries `lof` and `lot` lines
 * of identical shape, and a figure caption picked up as a section title is
 * worse than no number at all.
 *
 * An entry with no `\numberline` is unnumbered and is kept with
 * `number: null`: it still occupies a place in the order.
 */
function parseToc(text) {
    const out = [];
    const src = String(text == null ? '' : text);
    const re = /\\@writefile\{toc\}\{\\contentsline\s*(?=\{)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const level = readGroup(src, skipSpace(src, m.index + m[0].length));
        if (!level) continue;
        const title = readGroup(src, skipSpace(src, level.end));
        if (!title) continue;
        const page = readGroup(src, skipSpace(src, title.end));
        const anchor = page ? readGroup(src, skipSpace(src, page.end)) : null;

        let number = null;
        let name = title.body;
        const num = /^\s*\\numberline\s*(?=\{)/.exec(name);
        if (num) {
            const g = readGroup(name, num[0].length);
            if (g) { number = g.body.trim(); name = name.slice(g.end); }
        }
        out.push({
            level: level.body.trim(),
            number,
            title: normalizeTocTitle(name),
            raw: name,
            page: page ? page.body.trim() : null,
            anchor: anchor ? anchor.body.trim() : null,
        });
    }
    return out;
}

function skipSpace(s, i) {
    while (i < s.length && /\s/.test(s[i])) i++;
    return i;
}

/**
 * A title reduced to something two spellings of it can be compared by.
 *
 * The .aux holds the EXPANDED form — `\dot  x` where the source says
 * `\dot x` — so a byte comparison against the source title fails on most real
 * headings. Commands, braces, maths delimiters and runs of space all go; what
 * is left is the words, which is what a person would have compared.
 */
function normalizeTocTitle(t) {
    return expandTexorpdfstring(String(t == null ? '' : t))
        .replace(/\\protected@file@percent/g, '')
        .replace(/\\[a-zA-Z@]+\s*/g, ' ')
        .replace(/[{}$~]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * `\texorpdfstring{TeX}{plain}` -> the TeX half.
 *
 * hyperref's way of giving a heading two spellings, and it is all over a
 * physics paper: `\subsection{Where may \texorpdfstring{$x$ and $\dot x$}{x
 * and x-dot} lie?}`. The .aux keeps the FIRST argument, so a comparison that
 * keeps both never matches — measured at 7 of 21 headings before this, and
 * every one of the misses was a heading with maths in it.
 */
function expandTexorpdfstring(s) {
    let out = String(s);
    for (let guard = 0; guard < 32; guard++) {
        const at = out.indexOf('\\texorpdfstring');
        if (at < 0) break;
        const a = readGroup(out, skipSpace(out, at + '\\texorpdfstring'.length));
        if (!a) break;
        const b = readGroup(out, skipSpace(out, a.end));
        out = out.slice(0, at) + a.body + out.slice(b ? b.end : a.end);
    }
    return out;
}

/**
 * The braced title of a sectioning command, from its own source.
 *
 * The MODEL's title is a flattened rendering — `$x$ and $\dot x$` arrives as
 * "x and xx and x-dot" — which cannot be compared with what LaTeX wrote. The
 * source can.
 */
function sectionTitleSource(text) {
    const t = String(text == null ? '' : text);
    const m = /\\[a-zA-Z]+\*?\s*(?=\{)/.exec(t);
    if (!m) return '';
    const g = readGroup(t, m.index + m[0].length);
    return g ? g.body : '';
}

/**
 * Section title -> printed number.
 *
 * A title occurring TWICE is dropped rather than guessed at: two sections
 * called "Setup" cannot be told apart this way, and a wrong number beside a
 * change is worse than none.
 */
function readTocNumbers(outDir, root, deps) {
    const empty = { byTitle: new Map(), entries: [] };
    if (!outDir || !root || !deps || typeof deps.readFile !== 'function') return empty;
    const job = path.basename(root).replace(/\.tex$/i, '');
    let text = null;
    try {
        const f = path.join(outDir, `${job}.aux`);
        if (!deps.exists || deps.exists(f)) text = deps.readFile(f);
    } catch (_) { text = null; }
    if (text == null) return empty;

    const entries = parseToc(text);
    const seen = new Map();
    for (const e of entries) {
        if (!e.number || !e.title) continue;
        seen.set(e.title, seen.has(e.title) ? null : e.number);   // null marks ambiguous
    }
    const byTitle = new Map();
    for (const [k, v] of seen) if (v) byTitle.set(k, v);
    return { byTitle, entries };
}

function readAuxLabels(outDir, root, deps) {
    const empty = { labels: new Map(), cites: new Map() };
    if (!outDir || !root || !deps || typeof deps.readFile !== 'function') return empty;
    const job = path.basename(root).replace(/\.tex$/i, '');
    const main = path.join(outDir, `${job}.aux`);
    const read = (p) => {
        try {
            if (deps.exists && !deps.exists(p)) return null;
            return deps.readFile(p);
        } catch (_) { return null; }
    };
    const first = read(main);
    if (first == null) return empty;

    const out = parseAux(first);
    for (const rel of out.inputs.slice(0, 64)) {
        const sub = read(path.resolve(outDir, rel));
        if (sub == null) continue;
        const more = parseAux(sub);
        for (const [k, v] of more.labels) if (!out.labels.has(k)) out.labels.set(k, v);
        for (const [k, v] of more.cites) if (!out.cites.has(k)) out.cites.set(k, v);
    }
    return { labels: out.labels, cites: out.cites };
}

module.exports = {
    parseAux, readAuxLabels, readGroup, splitGroups, cleanPrinted,
    parseToc, readTocNumbers, normalizeTocTitle,
    expandTexorpdfstring, sectionTitleSource,
};
