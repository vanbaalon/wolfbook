'use strict';
// texStructure.js — moving blocks and editing figures, as source edits.
//
// Pure (no vscode). Every move is one delete and one insert of whole lines on
// the text as read, so a WorkspaceEdit applies it in one step (one undo);
// the result also says where the moved block now is, so an open card can
// follow it.

/** Offsets of whole lines `from..to` (1-based, inclusive), with the newline that ends the last. */
function lineSpan(text, from, to) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    const a = starts[Math.max(0, from - 1)] ?? text.length;
    const b = to < starts.length ? starts[to] : text.length;
    return [a, b];
}

/**
 * Move the text `start..end` (whole lines) to offset `at` (a line start outside it).
 * Returns `{ deleteFrom, deleteTo, insertAt, insertText, text, start, end }`:
 * the edit on the original text, the new text, and the block's new offsets.
 */
function moveSpan(text, start, end, at) {
    if (at >= start && at <= end) return null;
    let block = text.slice(start, end);
    if (!block.endsWith('\n')) block += '\n';
    // A block moved up from the very end of a file without a final newline.
    const rest = text.slice(0, start) + text.slice(end);
    const where = at > end ? at - (end - start) : at;
    const next = rest.slice(0, where) + block + rest.slice(where);
    return { deleteFrom: start, deleteTo: end, insertAt: at, insertText: block, text: next, start: where, end: where + block.length };
}

/** Move source lines `from..to` (a section: heading to the end of its span) before line `before`. */
function moveLines(text, from, to, before) {
    if (before >= from && before <= to + 1) return null;
    const [a, b] = lineSpan(text, from, to);
    const [at] = lineSpan(text, before, before);
    return moveSpan(text, a, b, at);
}

const BLANK = /^\s*(%.*)?$/;
const HARD = /^\s*\\(begin|end)\s*\{document\}|^\s*\\(part|chapter|section|subsection|subsubsection)\*?\s*[[{]/;

/**
 * Move the block at `start..end` above the paragraph before it (dir < 0) or
 * below the one after it (dir > 0). A paragraph is a run of non-blank lines;
 * a heading or the document's begin/end is a wall. Null when there is none.
 */
function moveBlock(text, start, end, dir) {
    const lines = text.split('\n');
    const lineOf = off => text.slice(0, off).split('\n').length;   // 1-based
    const first = lineOf(start), last = lineOf(Math.max(start, end - 1));
    const [a, b] = lineSpan(text, first, last);
    if (dir < 0) {
        let i = first - 1;                                   // 1-based line above
        while (i >= 1 && BLANK.test(lines[i - 1])) i--;
        if (i < 1 || HARD.test(lines[i - 1])) return null;
        while (i > 1 && !BLANK.test(lines[i - 2]) && !HARD.test(lines[i - 2])) i--;
        return moveSpan(text, a, b, lineSpan(text, i, i)[0]);
    }
    let i = last + 1;
    while (i <= lines.length && BLANK.test(lines[i - 1])) i++;
    if (i > lines.length || HARD.test(lines[i - 1])) return null;
    while (i < lines.length && !BLANK.test(lines[i]) && !HARD.test(lines[i])) i++;
    // After that paragraph and one blank line, so the block stands apart.
    const after = lineSpan(text, i, i)[1];
    const r = moveSpan(text, a, b, after);
    if (r && !/\n\s*\n$/.test(text.slice(0, after))) {
        r.insertText = '\n' + r.insertText;
        r.text = r.text.slice(0, r.start) + '\n' + r.text.slice(r.start);
        r.start += 1; r.end += 1;
    }
    return r;
}

const FIGURE_ENVS = /^(figure\*?|wrapfigure|SCfigure)$/;

/** The figure environment around `offset`: `{ start, end, env }`, or null. */
function figureAt(text, offset) {
    const re = /\\(begin|end)\s*\{([^}]*)\}/g;
    const stack = [];
    let m, found = null;
    while ((m = re.exec(text))) {
        if (m[1] === 'begin') stack.push({ env: m[2], start: m.index });
        else {
            const i = stack.map(x => x.env).lastIndexOf(m[2]);
            if (i < 0) continue;
            const open = stack[i];
            stack.length = i;
            const end = m.index + m[0].length;
            if (FIGURE_ENVS.test(open.env) && offset >= open.start && offset <= end && (!found || open.start > found.start)) found = { start: open.start, end, env: open.env };
        }
    }
    return found;
}

/**
 * Where a new float may go for a drop at `offset`: `offset` itself in running
 * text, else the start of the line after the outermost environment (other
 * than the document) around it — a figure dropped on a caption, a table or an
 * equation goes after that block, never inside it.
 */
function outsideEnvironments(text, offset) {
    const re = /\\(begin|end)\s*\{([^}]*)\}/g;
    const stack = [];
    let m, outer = null;
    while ((m = re.exec(text))) {
        const comment = text.lastIndexOf('%', m.index) > text.lastIndexOf('\n', m.index) && text[text.lastIndexOf('%', m.index) - 1] !== '\\';
        if (comment) continue;
        if (m[1] === 'begin') { if (m[2] !== 'document') stack.push({ env: m[2], start: m.index }); continue; }
        const i = stack.map(x => x.env).lastIndexOf(m[2]);
        if (i < 0) continue;
        const open = stack[i];
        stack.length = i;
        const end = m.index + m[0].length;
        if (i === 0 && open.start < offset && offset < end) { outer = end; break; }
        if (open.start >= offset) break;
    }
    if (outer === null) return offset;
    const nl = text.indexOf('\n', outer);
    return nl < 0 ? text.length : nl + 1;
}

/** A figure float for an image (plain text, not a snippet), labelled from its file name. */
function figureFor(rel, width = '0.8\\linewidth') {
    const stem = String(rel).replace(/^.*\//, '').replace(/\.[^.]*$/, '').replace(/^paste_/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'image';
    return ['\\begin{figure}[htbp]', '  \\centering', `  \\includegraphics[width=${width}]{${rel}}`,
        '  \\caption{}', `  \\label{fig:${stem}}`, '\\end{figure}', ''].join('\n');
}

module.exports = { lineSpan, moveSpan, moveLines, moveBlock, figureAt, outsideEnvironments, figureFor };
