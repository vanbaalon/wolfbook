// inkEdit.js — typing in the ink: a caret on the page, keys as source edits.
//
// Pure: no vscode, no I/O. texViewer places the caret from a native map's
// glyph entries and turns each key into one edit of the LaTeX source; this
// file decides where the caret is drawn, which keys are safe where, and what
// each key does to the text. What the reader sees stays what they typed:
// a `%` typed on the page is `\%` in the source, and Backspace never leaves
// a half-deleted command or an unbalanced brace behind.

const { isInMath } = require('./texWords');
const { commentMask } = require('./texBalance');

/** Environments whose content is not prose typed on the page. */
const NOT_PROSE = new Set(['verbatim', 'Verbatim', 'lstlisting', 'minted', 'comment', 'tikzpicture', 'tikzcd', 'pgfpicture',
    'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*',
    'eqnarray', 'eqnarray*', 'displaymath', 'math', 'flalign', 'flalign*', 'split', 'tabular', 'tabular*', 'tabularx',
    'longtable', 'array', 'CD', 'feynman', 'feynhand', 'filecontents', 'filecontents*']);

/** The innermost environment open at `offset` (by \begin/\end outside comments). */
function environmentAt(text, offset, mask = commentMask(text)) {
    const stack = [];
    const re = /\\(begin|end)\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(text)) && m.index < offset) {
        if (mask[m.index]) continue;
        if (m[1] === 'begin') stack.push(m[2]);
        else { const i = stack.lastIndexOf(m[2]); if (i >= 0) stack.length = i; }
    }
    return stack;
}

/**
 * May the reader type at `offset` directly on the page? Prose only: not in
 * maths (inline or display), a comment, verbatim, a picture, a table, or the
 * preamble; and not inside a command's name.
 */
function proseAt(text, offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
    const begin = text.search(/\\begin\s*\{document\}/);
    if (begin < 0 || offset <= begin) return false;
    const mask = commentMask(text);
    if (offset < text.length && mask[offset]) return false;
    if (offset > 0 && mask[offset - 1] && text[offset - 1] !== '\n') return false;
    if (environmentAt(text, offset, mask).some(env => NOT_PROSE.has(env))) return false;
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const lineEnd = text.indexOf('\n', offset);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    if (isInMath(line, offset - lineStart)) return false;
    // \[ … \] spanning lines. `\\[2mm]` is a line break, not maths: the
    // bracket counts only after an odd number of backslashes.
    let display = false;
    const re = /(\\+)([[\]])/g;
    let m;
    while ((m = re.exec(text)) && m.index < offset) {
        if (mask[m.index] || m[1].length % 2 === 0) continue;
        display = m[2] === '[';
    }
    if (display) return false;
    // In the middle of a control word (\emp|h).
    if (/\\[A-Za-z]*$/.test(text.slice(Math.max(0, offset - 40), offset)) && /^[A-Za-z]/.test(text.slice(offset, offset + 1))) return false;
    return true;
}

const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline',
    'multline*', 'eqnarray', 'eqnarray*', 'displaymath', 'math', 'flalign', 'flalign*']);

/** Is `offset` in maths — a maths environment, \\[ \\], or inline — after \\begin{document}? */
function mathAt(text, offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
    const begin = text.search(/\\begin\s*\{document\}/);
    if (begin < 0 || offset <= begin) return false;
    const mask = commentMask(text);
    if (offset < text.length && mask[offset]) return false;
    if (environmentAt(text, offset, mask).some(env => MATH_ENVS.has(env))) return true;
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const lineEnd = text.indexOf('\n', offset);
    if (isInMath(text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd), offset - lineStart)) return true;
    let display = false;
    for (const m of text.slice(0, offset).matchAll(/(\\+)([[\]])/g)) {
        if (mask[m.index] || m[1].length % 2 === 0) continue;
        display = m[2] === '[';
    }
    return display;
}

/** Whether `offset` of `text` is in a table's body (tabular, tabular*, tabularx, longtable) — the table grid's. */
function tableAt(text, offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
    const begin = text.search(/\\begin\s*\{document\}/);
    if (begin < 0 || offset <= begin) return false;
    const mask = commentMask(text);
    if (offset < text.length && mask[offset]) return false;
    const envs = environmentAt(text, offset, mask);
    // The innermost of a table or maths decides: a cell's $x$ is the table's.
    for (let i = envs.length - 1; i >= 0; i--) {
        if (/^(tabular\*?|tabularx)$/.test(envs[i])) return true;
        if (MATH_ENVS.has(envs[i])) return false;
    }
    return false;
}

function span(entry) {
    const loc = entry?.hit?.preferred_source?.location;
    if (!loc || loc.accuracy !== 'Exact' || loc.start.line !== loc.end.line) return null;
    return { line: loc.start.line, s: loc.start.column_utf16, e: loc.end.column_utf16 };
}

/**
 * Where to draw the caret for source position (line, column) — 1-based line,
 * UTF-16 column — from a map's glyph entries for that line: the left edge of
 * the glyph typed at the column, or the right edge of the one typed before
 * it; after a space, the start of the next word. `lineText` is the source
 * line. Null when no glyph of the line is on a page the map holds.
 */
function caretAt(entries, line, column, lineText = '') {
    const glyphs = [];
    for (const entry of entries || []) {
        const s = span(entry);
        if (s && s.line === line && s.e > s.s) glyphs.push({ entry, ...s });
    }
    if (!glyphs.length) return null;
    const rowBox = entry => {
        const row = glyphs.filter(g => g.entry.page === entry.page && g.entry.row === entry.row).map(g => g.entry);
        const y0 = Math.min(...row.map(e => e.y)), y1 = Math.max(...row.map(e => e.y + e.boxHeight));
        return { y: y0, h: y1 - y0 };
    };
    const at = (entry, x) => ({ page: entry.page, x, ...rowBox(entry), row: entry.row });
    const inside = glyphs.filter(g => g.s <= column && column < g.e).sort((a, b) => (a.e - a.s) - (b.e - b.s))[0];
    if (inside) return at(inside.entry, inside.entry.x + inside.entry.w * (column - inside.s) / (inside.e - inside.s));
    let before = null, after = null;
    for (const g of glyphs) {
        if (g.e <= column && (!before || g.e > before.e || (g.e === before.e && g.entry.x > before.entry.x))) before = g;
        if (g.s >= column && (!after || g.s < after.s)) after = g;
    }
    if (before && after) {
        if (after.s === column) return at(after.entry, after.entry.x);
        if (before.e === column) return at(before.entry, before.entry.x + before.entry.w);
        // Characters with no glyph of their own lie between: after a space,
        // the caret starts the next word; otherwise it ends the last one.
        return /\s/.test(lineText.slice(before.e, column)) ? at(after.entry, after.entry.x) : at(before.entry, before.entry.x + before.entry.w);
    }
    if (before) {
        // TRAILING SPACES PRINT NOTHING, but the caret after them is where the
        // next word will start: one interword space (as this row sets it)
        // past the last word, not glued to it.
        const x = before.entry.x + before.entry.w;
        const gap = lineText.slice(before.e, column);
        if (gap && /^[ \t]+$/.test(gap)) return at(before.entry, x + spaceWidth(glyphs, before.entry, lineText));
        return at(before.entry, x);
    }
    return at(after.entry, after.entry.x);
}

/** The width of an interword space on `entry`'s row, measured where the source has one. */
function spaceWidth(glyphs, entry, lineText) {
    const row = glyphs.filter(g => g.entry.page === entry.page && g.entry.row === entry.row).sort((a, b) => a.s - b.s);
    for (let i = 0; i + 1 < row.length; i++) {
        const a = row[i], b = row[i + 1];
        if (b.s > a.e && /^[ \t]+$/.test(lineText.slice(a.e, b.s))) {
            const w = b.entry.x - (a.entry.x + a.entry.w);
            if (w > 0) return w;
        }
    }
    return Math.max(2, (entry.boxHeight || 10) * 0.33);
}

/** What a character typed on the page is in the source. */
const LITERAL = { '%': '\\%', '&': '\\&', '#': '\\#', '_': '\\_', '$': '\\$', '{': '\\{', '}': '\\}',
    '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', '\\': '\\textbackslash{}' };
function literal(ch) { return LITERAL[ch] ?? ch; }

const CONTROL_WORD_BEFORE = /\\[A-Za-z]+\*?(?:\{\})?$/;
const ESCAPED_BEFORE = /\\[%&#_${}]$/;
const COMMAND_OPEN_BEFORE = /\\[A-Za-z]+\*?(?:\[[^\]\n]*\])?\{$/;

/** The edit a key makes at `offset`: `{ start, end, insert, caret }`, or `{ caret }` to only move, or null. */
function keyEdit(text, offset, key) {
    if (key === 'Enter') return { start: offset, end: offset, insert: '\n\n', caret: offset + 2 };
    if (key === 'Backspace') return backspace(text, offset);
    if (key === 'Delete') return del(text, offset);
    if (typeof key === 'string' && [...key].length === 1) {
        const insert = literal(key);
        return { start: offset, end: offset, insert, caret: offset + insert.length };
    }
    return null;
}

function remove(start, end, caret = start) { return { start, end, insert: '', caret }; }

function backspace(text, offset) {
    if (offset <= 0) return null;
    const before = text.slice(Math.max(0, offset - 80), offset);
    const prev = text[offset - 1];
    if (prev === '\n' || prev === ' ' || prev === '\t') {
        // Whitespace shows as one space (or a paragraph break): remove the run.
        let start = offset;
        while (start > 0 && /[ \t\n]/.test(text[start - 1])) start--;
        const run = text.slice(start, offset);
        // Joining two paragraphs leaves the space between their words.
        if (/\n[ \t]*\n/.test(run)) return { start, end: offset, insert: ' ', caret: start + 1 };
        return remove(start, offset);
    }
    if (ESCAPED_BEFORE.test(before)) return remove(offset - 2, offset);
    const word = CONTROL_WORD_BEFORE.exec(before);
    if (word) return remove(offset - word[0].length, offset);
    if (prev === '}') {
        // The end of a group (\emph{word}|): delete inside it, keep the caret
        // after it, and remove the command once its group is empty.
        const inner = backspace(text, offset - 1);
        if (!inner || inner.insert) return inner ? { ...inner, caret: inner.caret } : { caret: offset - 1 };
        const after = text.slice(0, inner.start) + text.slice(inner.end);
        const open = COMMAND_OPEN_BEFORE.exec(after.slice(Math.max(0, inner.start - 80), inner.start));
        if (open && after[inner.start] === '}' ) return remove(inner.start - open[0].length, inner.end + 1);
        return { ...inner, caret: inner.caret + 1 };
    }
    if (prev === '{') {
        // The start of a group (\emph{|word}): delete before the command.
        const open = COMMAND_OPEN_BEFORE.exec(before);
        const at = open ? offset - open[0].length : offset - 1;
        const inner = backspace(text, at);
        if (!inner || inner.insert) return inner ? null : { caret: at };
        return { ...inner, caret: offset - (inner.end - inner.start) };
    }
    // Maths, a line break command, a comment: not deleted from the page.
    if (prev === '$' || prev === '\\' || prev === '%') return null;
    // One character (both halves of a surrogate pair).
    const n = offset >= 2 && /[\uDC00-\uDFFF]/.test(prev) && /[\uD800-\uDBFF]/.test(text[offset - 2]) ? 2 : 1;
    return remove(offset - n, offset);
}

function del(text, offset) {
    if (offset >= text.length) return null;
    const next = text[offset];
    if (next === '\n' || next === ' ' || next === '\t') {
        let end = offset;
        while (end < text.length && /[ \t\n]/.test(text[end])) end++;
        const run = text.slice(offset, end);
        if (/\n[ \t]*\n/.test(run)) return { start: offset, end, insert: ' ', caret: offset };
        return remove(offset, end);
    }
    const after = text.slice(offset, offset + 80);
    const escaped = /^\\[%&#_${}]/.exec(after);
    if (escaped) return remove(offset, offset + 2);
    const word = /^\\[A-Za-z]+\*?(?:\{\})?(?![A-Za-z{])/.exec(after);
    if (word) return remove(offset, offset + word[0].length);
    if (next === '\\') {
        // A command with an argument (\emph{…}): step into it.
        const open = /^\\[A-Za-z]+\*?(?:\[[^\]\n]*\])?\{/.exec(after);
        if (!open) return null;
        const inner = del(text, offset + open[0].length);
        if (!inner || inner.insert) return inner ? null : { caret: offset };
        const rest = text.slice(0, inner.start) + text.slice(inner.end);
        if (rest[inner.start] === '}' && rest[inner.start - 1] === '{') return remove(offset, inner.end + 1);
        return { ...inner, caret: offset };
    }
    if (next === '}') {
        // Past the end of a group: delete what follows it.
        const inner = del(text, offset + 1);
        return inner ? { ...inner, caret: offset } : null;
    }
    if (next === '{' || next === '$' || next === '%') return null;
    const n = /[\uD800-\uDBFF]/.test(next) && /[\uDC00-\uDFFF]/.test(text[offset + 1] || '') ? 2 : 1;
    return remove(offset, offset + n);
}

module.exports = { caretAt, keyEdit, proseAt, mathAt, tableAt, environmentAt, literal };
