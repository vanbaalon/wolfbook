'use strict';
// TikZ SOURCE EDITS FOR THE PICTURE TOOLBAR.
//
// The live engine tells the viewer which source command painted each path
// (TXDL `path.special` → `map_specials`), so an edit on the page is an edit
// of that command's text: a move, scale or rotation becomes a transform
// option put FIRST in the command's option list — TikZ applies the options'
// transformations last-given-first, so the first one acts on the picture's
// own frame, after everything the command already does — and a new shape
// becomes a command inserted before the picture's `\end{tikzpicture}`.
//
// Geometry arrives in PDF big points relative to the picture's origin (TikZ's
// (0,0)), y up, and leaves in centimetres, TikZ's default unit, divided by
// the picture's own `scale=` when it has one.

const BP_PER_CM = 72 / 2.54;

/** A number as a TikZ coordinate: at most two decimals, no trailing zeros. */
function num(x) {
    const r = Math.round(x * 100) / 100;
    return String(Object.is(r, -0) ? 0 : r);
}

/** Skip a comment or an escaped character at `i`; the index after it, or `i`. */
function skipTrivia(text, i) {
    if (text[i] === '%') {
        const eol = text.indexOf('\n', i);
        return eol < 0 ? text.length : eol + 1;
    }
    if (text[i] === '\\' && i + 1 < text.length) return i + 2;
    return i;
}

/**
 * The command starting at `start` (the offset of its `\draw`, `\node`, …):
 * through the `;` that ends it at depth 0, with comments and escapes skipped.
 * `null` when no end is found before `limit`.
 */
function commandRange(text, start, limit = text.length) {
    let depth = 0;
    for (let i = start; i < limit; i++) {
        const next = skipTrivia(text, i);
        if (next !== i) { i = next - 1; continue; }
        const c = text[i];
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth = Math.max(0, depth - 1);
        else if (c === ';' && depth === 0) return { start, end: i + 1 };
    }
    return null;
}

/** The balanced group opening at `open` (`[`, `{` or `(`): its closing index. */
function closing(text, open) {
    const pair = { '[': ']', '{': '}', '(': ')' }[text[open]];
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const next = skipTrivia(text, i);
        if (next !== i) { i = next - 1; continue; }
        if (text[i] === text[open]) depth++;
        else if (text[i] === pair && --depth === 0) return i;
    }
    return -1;
}

/**
 * The option list right after the command name (`\draw[…]`), as offsets into
 * `command`: `{ open, close }` of the brackets, or `null` without one. `after`
 * is where a new list would go (just after the name).
 */
function optionList(command) {
    const name = /^\\[A-Za-z@]+\*?/.exec(command);
    const after = name ? name[0].length : 0;
    let i = after;
    while (i < command.length && /\s/.test(command[i])) i++;
    if (command[i] !== '[') return { after, open: -1, close: -1 };
    return { after, open: i, close: closing(command, i) };
}

/** Top-level comma-separated items of an option list's content. */
function splitOptions(content) {
    const items = [];
    let depth = 0, from = 0;
    for (let i = 0; i < content.length; i++) {
        const c = content[i];
        if ('{[('.includes(c)) depth++;
        else if ('}])'.includes(c)) depth--;
        else if (c === ',' && depth === 0) { items.push(content.slice(from, i)); from = i + 1; }
    }
    items.push(content.slice(from));
    return items.map(s => s.trim()).filter(Boolean);
}

/**
 * `command` with `transform` applied after what it already does: a
 * `shift={(dx,dy)}` in cm merges into a leading shift; anything else is put
 * first in the options.
 */
function withTransform(command, transform) {
    const { after, open, close } = optionList(command);
    if (open >= 0 && close < 0) return null;
    const items = open >= 0 ? splitOptions(command.slice(open + 1, close)) : [];
    let first;
    if (transform.kind === 'shift') {
        const lead = items.length ? /^shift\s*=\s*\{\s*\(\s*([-+0-9.eE]+)\s*(?:cm)?\s*,\s*([-+0-9.eE]+)\s*(?:cm)?\s*\)\s*\}$/.exec(items[0]) : null;
        let [dx, dy] = [transform.dx, transform.dy];
        if (lead) { dx += Number(lead[1]); dy += Number(lead[2]); items.shift(); }
        first = Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005 ? null : `shift={(${num(dx)},${num(dy)})}`;
    } else if (transform.kind === 'rotate') {
        first = `rotate around={${num(transform.degrees)}:(${num(transform.cx)},${num(transform.cy)})}`;
    } else if (transform.kind === 'scale') {
        first = `scale around={${num(transform.factor)}:(${num(transform.cx)},${num(transform.cy)})}`;
    } else return null;
    const list = first ? [first, ...items] : items;
    const head = command.slice(0, after);
    const tail = open >= 0 ? command.slice(close + 1) : command.slice(after);
    return list.length ? `${head}[${list.join(', ')}]${tail}` : `${head}${tail.replace(/^\s+/, ' ')}`;
}

/**
 * The `\begin{tikzpicture}` at `start` (its offset, as the picture's special
 * maps it) and its end: `{ scale, bodyEnd }`, where `bodyEnd` is the offset of
 * the matching `\end{tikzpicture}`. `scale` is the picture's `scale=` (1
 * without one); other picture-wide transforms are not modelled.
 */
function picture(text, start) {
    const begin = text.indexOf('\\begin{tikzpicture}', Math.max(0, start - 1));
    if (begin < 0 || begin > start + 200) return null;
    let scale = 1;
    let i = begin + '\\begin{tikzpicture}'.length;
    while (/\s/.test(text[i] || '')) i++;
    if (text[i] === '[') {
        const close = closing(text, i);
        for (const item of splitOptions(text.slice(i + 1, close))) {
            const m = /^scale\s*=\s*([-+0-9.eE]+)$/.exec(item);
            if (m) scale = Number(m[1]) || 1;
        }
    }
    const pattern = /\\(begin|end)\{tikzpicture\}/g;
    pattern.lastIndex = begin;
    let depth = 0, m;
    while ((m = pattern.exec(text))) {
        if (text.lastIndexOf('%', m.index) > text.lastIndexOf('\n', m.index)) continue; // commented out
        depth += m[1] === 'begin' ? 1 : -1;
        if (depth === 0) return { begin, bodyEnd: m.index, scale };
    }
    return null;
}

/** Picture-relative big points (y up) to the picture's centimetres. */
function toCm(bp, scale = 1) { return bp / BP_PER_CM / (scale || 1); }

/**
 * A new command for `shape` from picture-relative points in bp (y up), or
 * `null` when the points do not make one. `snap` rounds to a 0.1 cm grid.
 */
function newCommand(shape, points, { scale = 1, snap = true, text = '' } = {}) {
    const cm = ([x, y]) => {
        let [u, v] = [toCm(x, scale), toCm(y, scale)];
        if (snap) [u, v] = [Math.round(u * 10) / 10, Math.round(v * 10) / 10];
        return [u, v];
    };
    const at = p => `(${num(p[0])},${num(p[1])})`;
    const [a, b] = points.map(cm);
    switch (shape) {
    case 'line': return b ? `\\draw ${at(a)} -- ${at(b)};` : null;
    case 'rect': return b ? `\\draw ${at(a)} rectangle ${at(b)};` : null;
    case 'circle': {
        if (!b) return null;
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return r > 0 ? `\\draw ${at(a)} circle (${num(snap ? Math.round(r * 10) / 10 || 0.1 : r)});` : null;
    }
    case 'node': {
        const clean = String(text).replace(/[{}\\%#$&^_~]/g, c => `\\${c === '\\' ? 'textbackslash{}' : c}`).trim();
        return clean ? `\\node at ${at(a)} {${clean}};` : null;
    }
    default: return null;
    }
}

module.exports = { BP_PER_CM, num, commandRange, optionList, splitOptions, withTransform, picture, toCm, newCommand };
