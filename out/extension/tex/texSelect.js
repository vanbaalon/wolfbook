// texSelect.js — the containers around a point, tightest first.
//
// Pure: no vscode, never throws.
//
// WHY. A click has to mean ONE thing, and the right one depends on what the
// reader is doing: fixing a typo wants the word, rewriting wants the sentence,
// moving text wants the paragraph, and reorganising wants the section. Asking
// up front is not possible, and guessing is wrong most of the time.
//
// So the click does not choose — it starts at the tightest thing, and each
// further click in the same place widens by one step. The reader stops when
// the selection is what they meant, which is the only reliable signal there
// is. VS Code's own Expand Selection works this way.

const { visibleProjection } = require('./texWords');

/** Kinds that are containers in their own right, not annotations on one. */
const CONTAINER_KINDS = new Set([
    'display-equation', 'figure', 'table', 'tabular', 'theorem', 'verbatim',
    'list', 'itemize', 'enumerate', 'align', 'environment', 'abstract',
]);

/** Never a step of their own — they annotate whatever encloses them. */
const SKIP_KINDS = new Set(['label', 'ref', 'cite', 'include', 'section-heading']);

/**
 * Abbreviations whose full stop does not end a sentence. Missing one costs a
 * too-short selection, which the next click fixes — so this list is allowed to
 * be incomplete, and is deliberately short rather than speculative.
 */
const ABBREV = new Set([
    'e.g', 'i.e', 'cf', 'vs', 'etc', 'al', 'fig', 'figs', 'eq', 'eqs', 'ref',
    'refs', 'sec', 'secs', 'ch', 'app', 'tab', 'no', 'nos', 'vol', 'pp', 'resp',
    'approx', 'ca', 'dr', 'prof', 'mr', 'mrs', 'ms', 'st', 'inc', 'ltd',
]);

const BLANK = /^\s*$/;
const HEADING = /^\s*\\(chapter|section|subsection|subsubsection|paragraph|part)\*?\s*[[{]/;
/**
 * A line that opens or closes a display bounds a paragraph.
 *
 * `\[` and `\]` count as much as `\begin{equation}` does — they are the same
 * construct with different spelling, and missing them let a paragraph run
 * straight through an equation and on into the prose beyond it, which made the
 * "sentence" step swallow several unrelated lines.
 */
const DELIM = /^\s*(\\(begin|end)\s*\{|\\\[|\\\]|\$\$)/;

/**
 * The paragraph containing a line: bounded by blank lines, headings, and any
 * line that opens or closes an environment.
 *
 * In LaTeX a paragraph does not actually end at \begin{equation} — the prose
 * after the display is the same paragraph. But a selection that silently
 * swallows an equation, or reaches past \end{document}, is not what anyone
 * means by "this paragraph", and nothing is lost by stopping: the next click
 * up the ladder is the enclosing object or section anyway.
 */
function paragraphSpan(lines, line) {
    const i = line - 1;
    if (i < 0 || i >= lines.length) return null;
    if (BLANK.test(lines[i])) return null;
    const stops = (n) => BLANK.test(lines[n]) || HEADING.test(lines[n]) || DELIM.test(lines[n]);
    let a = i; let b = i;
    while (a > 0 && !stops(a - 1)) a--;
    while (b < lines.length - 1 && !stops(b + 1)) b++;
    if ((HEADING.test(lines[a]) || DELIM.test(lines[a])) && a < b) a++;
    return { startLine: a + 1, endLine: b + 1 };
}

/**
 * Sentence spans in a run of prose, as offsets into the text given.
 *
 * Found in the VISIBLE projection, so a full stop inside \cite{a.b} or a macro
 * name is not mistaken for the end of a thought, then mapped back to source.
 */
function sentenceSpans(text) {
    const { text: vis, map } = visibleProjection(text);
    const out = [];
    const at = (k) => (map[k] == null ? null : map[k]);
    let start = 0;
    for (let i = 0; i < vis.length; i++) {
        const c = vis[i];
        if (c !== '.' && c !== '!' && c !== '?') continue;
        // Run on through "?!" and ".)" and closing quotes.
        let j = i;
        while (j + 1 < vis.length && /[.!?)\]'"”’]/.test(vis[j + 1])) j++;
        const atEnd = j + 1 >= vis.length;
        if (!atEnd && !/\s/.test(vis[j + 1])) continue;            // 3.14, foo.bar
        if (c === '.') {
            const before = vis.slice(Math.max(0, i - 12), i);
            const wordM = /([\p{L}.]+)$/u.exec(before);
            if (wordM && ABBREV.has(wordM[1].toLowerCase())) continue;
            if (/(^|\s)\p{Lu}$/u.test(before)) continue;           // a single initial
        }
        // A new sentence opens with a capital, a digit, or maths.
        if (!atEnd && !/^\s+[\p{Lu}\p{N}\\$(]/u.test(vis.slice(j + 1, j + 4))) continue;
        const from = at(start);
        const to = at(j);
        if (from != null && to != null) out.push({ from, to: to + 1 });
        let k = j + 1;
        while (k < vis.length && /\s/.test(vis[k])) k++;
        start = k;
        i = j;
    }
    if (start < vis.length && vis.slice(start).trim()) {
        const from = at(start);
        const to = at(vis.length - 1);
        if (from != null && to != null) out.push({ from, to: to + 1 });
    }
    return out;
}

/**
 * Bracket levels around a point inside maths, innermost first.
 *
 * "One bracket level higher" is what a reader means by a bigger piece of an
 * equation: a -> {a} -> \\frac{a}{b} -> the group that holds it, and so on out
 * to the equation itself. Source braces and printed delimiters are BOTH levels,
 * because \\left( ... \\right) is a level the reader can see and {…} is a level
 * the writer can see, and neither is more real than the other.
 *
 * @param {string} text    the maths source (may span lines)
 * @param {number} offset  a position within it
 * @returns {Array<{from:number,to:number,what:string}>} widening, non-duplicated
 */
function mathLadder(text, offset) {
    const pairs = [];
    const stack = [];
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\\') { i++; continue; }                 // \{ is a literal brace
        if (c === '{' || c === '(' || c === '[') { stack.push({ ch: c, at: i }); continue; }
        if (c === '}' || c === ')' || c === ']') {
            const want = c === '}' ? '{' : c === ')' ? '(' : '[';
            for (let k = stack.length - 1; k >= 0; k--) {
                if (stack[k].ch !== want) continue;
                pairs.push({ from: stack[k].at, to: i + 1, ch: want });
                stack.length = k;
                break;
            }
        }
    }

    const out = [];
    const seen = new Set();
    const add = (from, to, what) => {
        if (from == null || to == null || to <= from) return;
        const key = `${from}:${to}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ from, to, what });
    };

    const inner = pairs
        .filter(p => offset >= p.from && offset <= p.to)
        .sort((a, b) => (a.to - a.from) - (b.to - b.from));

    for (const g of inner) {
        add(g.from, g.to, g.ch === '{' ? 'group' : 'bracket');
        // A group is usually an ARGUMENT. \\frac{a}{b} is one thing to a reader,
        // so after {a} the next step is the whole \\frac, not {b}'s parent.
        const call = commandAround(text, g.from);
        if (call) add(call.from, call.to, `\\${call.name}`);
    }
    return out.sort((a, b) => (a.to - a.from) - (b.to - b.from));
}

/**
 * If a group is an argument of \name, the extent of that whole call.
 * Walks left over sibling {…} and […] arguments to find the control word, then
 * right over all of them to find where the call ends.
 */
function commandAround(text, groupStart) {
    let i = groupStart;
    while (i > 0) {
        const prev = text[i - 1];
        if (/\s/.test(prev)) { i--; continue; }
        if (prev === '}' || prev === ']') {
            const open = prev === '}' ? '{' : '[';
            let depth = 0; let k = i - 1;
            for (; k >= 0; k--) {
                if (k > 0 && text[k - 1] === '\\') continue;
                if (text[k] === prev) depth++;
                else if (text[k] === open) { depth--; if (!depth) break; }
            }
            if (k < 0) return null;
            i = k;
            continue;
        }
        break;
    }
    const m = /\\([A-Za-z@]+)\s*$/.exec(text.slice(0, i));
    if (!m) return null;
    const from = i - m[0].length;
    // Now consume every argument group to the right.
    let j = i;
    while (j < text.length) {
        while (j < text.length && /\s/.test(text[j])) j++;
        const ch = text[j];
        if (ch !== '{' && ch !== '[') break;
        const close = ch === '{' ? '}' : ']';
        let depth = 0; let k = j;
        for (; k < text.length; k++) {
            if (text[k] === '\\') { k++; continue; }
            if (text[k] === ch) depth++;
            else if (text[k] === close) { depth--; if (!depth) break; }
        }
        if (k >= text.length) break;
        j = k + 1;
    }
    while (j > i && /\s/.test(text[j - 1])) j--;   // never trail into whitespace
    return { from, to: j, name: m[1] };
}

const posLE = (a, b) => a.line < b.line || (a.line === b.line && a.col <= b.col);
const sameSpan = (a, b) =>
    a.start.line === b.start.line && a.start.col === b.start.col &&
    a.end.line === b.end.line && a.end.col === b.end.col;

/**
 * Containers around a point, tightest first, each strictly larger than the last.
 *
 * @param {object} o
 * @param {string[]} o.lines      the file, split into lines
 * @param {object}   [o.model]    the parsed model, for objects
 * @param {Array}    [o.sections] sectionSpans() output, for the heading hierarchy
 * @param {string}   [o.file]     absolute path, to filter the model's objects
 * @param {number}   o.line       1-based
 * @param {number}   [o.column]   0-based
 * @param {{start:number,end:number}} [o.word]  columns of the word or glyph clicked
 */
function selectionLadder(o = {}) {
    const lines = Array.isArray(o.lines) ? o.lines : [];
    if (!lines.length) return [];
    const line = Math.max(1, Math.min(o.line || 1, lines.length));
    const column = Math.max(0, o.column || 0);

    const steps = [];
    const eol = (n) => (lines[n - 1] || '').length;
    const push = (kind, label, sl, sc, el, ec) => {
        if (sl == null || el == null) return;
        const s = { line: Math.max(1, sl), col: Math.max(0, sc) };
        const e = { line: Math.max(1, Math.min(el, lines.length)), col: Math.max(0, ec) };
        if (!posLE(s, e)) return;
        const span = { kind, label, start: s, end: e, lines: e.line - s.line + 1 };
        const prev = steps[steps.length - 1];
        if (!prev) { steps.push(span); return; }
        // Each step must be strictly bigger, or the click appears to do nothing
        // and the reader concludes the feature is broken. Equal spans replace
        // the previous one so the more meaningful NAME survives.
        if (sameSpan(prev, span)) { steps[steps.length - 1] = span; return; }
        if (!(posLE(s, prev.start) && posLE(prev.end, e))) return;
        steps.push(span);
    };

    const lineText = lines[line - 1] || '';

    // 1 — the word, or the maths glyph.
    if (o.word && o.word.end > o.word.start) {
        push('word', JSON.stringify(lineText.slice(o.word.start, o.word.end)),
            line, o.word.start, line, o.word.end);
    }

    // The innermost model object also decides whether this is prose at all.
    const objs = ((o.model && o.model.objects) || [])
        .filter(x => x && x.sourceRange && !SKIP_KINDS.has(x.kind) &&
            (!o.file || !x.sourceRange.file || x.sourceRange.file === o.file) &&
            x.sourceRange.startLine <= line && x.sourceRange.endLine >= line)
        .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
            (b.sourceRange.endLine - b.sourceRange.startLine));

    // 2 — sentence, then paragraph, but only in prose. Inside an equation the
    // analogous step is the equation itself, which arrives next anyway.
    if (!objs.length || !CONTAINER_KINDS.has(objs[0].kind)) {
        const para = paragraphSpan(lines, line);
        if (para) {
            const body = lines.slice(para.startLine - 1, para.endLine).join('\n');
            let off = column;
            for (let n = para.startLine; n < line; n++) off += (lines[n - 1] || '').length + 1;
            const hit = sentenceSpans(body).find(s => off >= s.from && off <= s.to);
            if (hit) {
                const pos = (abs) => {
                    let n = para.startLine; let rem = abs;
                    while (n < para.endLine && rem > (lines[n - 1] || '').length) {
                        rem -= (lines[n - 1] || '').length + 1; n++;
                    }
                    return { line: n, col: Math.max(0, rem) };
                };
                const a = pos(hit.from); const b = pos(hit.to);
                push('sentence', 'sentence', a.line, a.col, b.line, b.col);
            }
            push('paragraph',
                para.endLine > para.startLine
                    ? `paragraph (${para.endLine - para.startLine + 1} lines)`
                    : 'paragraph',
                para.startLine, 0, para.endLine, eol(para.endLine));
        }
    }

    // 2b — inside maths, the bracket levels, before the equation as a whole.
    if (objs.length && CONTAINER_KINDS.has(objs[0].kind) && o.word) {
        const eq = objs[0].sourceRange;
        const body = lines.slice(eq.startLine - 1, eq.endLine).join('\n');
        let base = 0;
        for (let n = eq.startLine; n < line; n++) base += (lines[n - 1] || '').length + 1;
        const at = (abs) => {
            let n = eq.startLine; let rem = abs;
            while (n < eq.endLine && rem > (lines[n - 1] || '').length) {
                rem -= (lines[n - 1] || '').length + 1; n++;
            }
            return { line: n, col: Math.max(0, rem) };
        };
        for (const g of mathLadder(body, base + o.word.start)) {
            const a = at(g.from); const b = at(g.to);
            push('group', g.what, a.line, a.col, b.line, b.col);
        }
    }

    // 3 — every model object around the point, innermost outward.
    for (const x of objs) {
        const nm = x.label ? `${x.kind} ${x.label}` : (x.envName || x.kind);
        push(x.kind, nm, x.sourceRange.startLine, 0,
            x.sourceRange.endLine, eol(x.sourceRange.endLine));
    }

    // 4 — the section hierarchy, innermost outward.
    for (const s of ((o.sections || [])
        .filter(s2 => s2.startLine <= line && s2.endLine >= line)
        .sort((a, b) => (b.level ?? 0) - (a.level ?? 0)))) {
        push('section', `${s.title} (${s.endLine - s.startLine + 1} lines)`,
            s.startLine, 0, s.endLine, eol(s.endLine));
    }

    // 5 — everything.
    push('document', 'whole file', 1, 0, lines.length, eol(lines.length));
    return steps;
}

module.exports = { selectionLadder, paragraphSpan, sentenceSpans, mathLadder, CONTAINER_KINDS };
