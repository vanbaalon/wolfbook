// texFormat.js — formatting from the page: bold, italic, typewriter,
// footnote, inline maths and heading level, as idiomatic LaTeX.
//
// Pure: no vscode, no I/O. Every action is one edit of the source and a
// toggle: applied to text that already has it, it takes it off instead of
// nesting (`\textbf{\textbf{x}}` never happens). A wrapper never swallows a
// paragraph break or half a group, which would not compile; the action then
// answers why instead of editing.

const WRAPPERS = { bold: '\\textbf', italic: '\\emph', mono: '\\texttt', footnote: '\\footnote' };

/** Braces balance in `s` (escaped \{ \} and comments aside). */
function balanced(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\\') { i++; continue; }
        if (c === '%') { const nl = s.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth < 0) return false;
    }
    return depth === 0;
}

/** The `}` that closes the `{` at `open`, or -1. */
function closing(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '\\') { i++; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i;
    }
    return -1;
}

/** The innermost `{` open at `offset` (not closed before it), or -1. */
function enclosingOpen(text, offset) {
    let depth = 0;
    for (let i = offset - 1; i >= 0; i--) {
        const c = text[i];
        if (i > 0 && text[i - 1] === '\\') continue;
        if (c === '}') depth++;
        else if (c === '{') { if (depth === 0) return i; depth--; }
    }
    return -1;
}

const PARAGRAPH_BREAK = /\n[ \t]*\n/;

/**
 * Format [start, end) of `text` as `kind`: `{ start, end, insert, select: [s, e] }`
 * for a range (select is the formatted text after the edit), `{ start, end,
 * insert, caret }` or `{ caret }` at a caret, or `{ error }`.
 */
function format(text, start, end, kind) {
    if (kind === 'heading') return heading(text, start);
    if (kind === 'math') return math(text, start, end);
    const cmd = WRAPPERS[kind];
    if (!cmd) return { error: `unknown format ${kind}` };
    const open = cmd + '{';
    if (start === end) {
        // At a caret: inside a group of this command, step out after it;
        // otherwise open one and type into it.
        const o = enclosingOpen(text, start);
        if (o >= 0 && text.slice(o - cmd.length, o + 1) === open) {
            const close = closing(text, o);
            if (close >= 0) return { caret: close + 1 };
        }
        return { start, end, insert: open + '}', caret: start + open.length };
    }
    const inner = text.slice(start, end);
    // The selection is this command's argument: take the command off.
    if (text.slice(start - open.length, start) === open && closing(text, start - 1) === end)
        return { start: start - open.length, end: end + 1, insert: inner, select: [start - open.length, start - open.length + inner.length] };
    // The selection is the whole command: take it off.
    if (inner.startsWith(open) && closing(text, start + cmd.length) === end - 1) {
        const arg = inner.slice(open.length, -1);
        return { start, end, insert: arg, select: [start, start + arg.length] };
    }
    if (!balanced(inner)) return { error: 'the selection splits a group — select whole words or commands' };
    if (kind !== 'footnote' && PARAGRAPH_BREAK.test(inner)) return { error: 'formatting stops at a paragraph break — select within one paragraph' };
    return { start, end, insert: open + inner + '}', select: [start + open.length, start + open.length + inner.length] };
}

function math(text, start, end) {
    if (start === end) return { start, end, insert: '$$', caret: start + 1 };
    const inner = text.slice(start, end);
    if (text[start - 1] === '$' && text[end] === '$' && text[start - 2] !== '$' && text[end + 1] !== '$')
        return { start: start - 1, end: end + 1, insert: inner, select: [start - 1, start - 1 + inner.length] };
    if (/^\$[^$]+\$$/.test(inner)) return { start, end, insert: inner.slice(1, -1), select: [start, end - 2] };
    if (!balanced(inner) || inner.includes('$') || PARAGRAPH_BREAK.test(inner)) return { error: 'inline maths takes a piece of one paragraph without maths in it' };
    return { start, end, insert: `$${inner}$`, select: [start + 1, start + 1 + inner.length] };
}

const LEVELS = ['section', 'subsection', 'subsubsection'];

/** The line at `offset`: a heading goes one level down (the last back to text); a short line of text becomes a section. */
function heading(text, offset) {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    let lineEnd = text.indexOf('\n', offset);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    const m = /^(\s*)\\(section|subsection|subsubsection)(\*?)\{(.*)\}(\s*)$/.exec(line);
    if (m && balanced(m[4])) {
        const next = LEVELS[LEVELS.indexOf(m[2]) + 1];
        const insert = next ? `${m[1]}\\${next}${m[3]}{${m[4]}}${m[5]}` : `${m[1]}${m[4]}${m[5]}`;
        return { start: lineStart, end: lineEnd, insert, caret: lineStart + insert.length - m[5].length - (next ? 1 : 0) };
    }
    const body = line.trim();
    if (!body || body.startsWith('\\') || body.startsWith('%') || body.length > 200 || !balanced(body) || body.includes('$'))
        return { error: 'a heading is made from a short line of text' };
    const lead = line.slice(0, line.indexOf(body));
    const insert = `${lead}\\section{${body}}`;
    return { start: lineStart, end: lineEnd, insert, caret: lineStart + insert.length - 1 };
}

module.exports = { format, balanced, WRAPPERS };
