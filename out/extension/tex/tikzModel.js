'use strict';
// A TIKZ PICTURE AS STATEMENTS, AND THE EDITS THE PICTURE EDITOR MAKES.
//
// The live engine says which statement painted each path (TXDL `special` →
// `map_specials`); this module says what that statement IS: a node with a
// name and an `at (x,y)`, an edge between named nodes, a `\diagram*` of
// tikz-feynman, an opaque `\foreach`. Moving a node then rewrites its
// coordinates — the edges that name it follow by themselves — and align,
// distribute and the palette are all edits of this model.
//
// PURE and offset-based: every function works on the document's text and
// returns edits `{start, end, text}` in that text's offsets, so one gesture
// that changes several statements (and maybe the preamble) is one
// WorkspaceEdit. Comments are masked before lexing; offsets never move.

const { commentMask } = require('./texBalance');

const NUMBER = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(cm)?\s*$/;

/** A number as TikZ source: at most three decimals, no trailing zeros. */
function num(x) {
    const r = Math.round(x * 1000) / 1000;
    return String(Object.is(r, -0) ? 0 : r);
}

/** The text with comments blanked (newlines kept), so offsets are unchanged. */
function masked(text) {
    const mask = commentMask(text);
    let out = '';
    for (let i = 0; i < text.length; i++) out += mask[i] && text[i] !== '\n' && text[i] !== '\r' ? ' ' : text[i];
    return out;
}

/** The closing bracket of the group opening at `open` in masked text `m`, or -1. */
function closing(m, open) {
    const pair = { '[': ']', '{': '}', '(': ')' }[m[open]];
    let depth = 0;
    for (let i = open; i < m.length; i++) {
        if (m[i] === '\\') { i++; continue; }
        if (m[i] === m[open]) depth++;
        else if (m[i] === pair && --depth === 0) return i;
    }
    return -1;
}

/** The `;` ending a statement that starts at `start`, at depth 0, or -1. */
function statementEnd(m, start, limit) {
    let depth = 0;
    for (let i = start; i < limit; i++) {
        const c = m[i];
        if (c === '\\') { i++; continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth = Math.max(0, depth - 1);
        else if (c === ';' && depth === 0) return i;
    }
    return -1;
}

/** Top-level comma-separated items of an option list's content, trimmed. */
function splitOptions(content) {
    const items = [];
    let depth = 0, from = 0;
    for (let i = 0; i < content.length; i++) {
        const c = content[i];
        if (c === '\\') { i++; continue; }
        if ('{[('.includes(c)) depth++;
        else if ('}])'.includes(c)) depth--;
        else if (c === ',' && depth === 0) { items.push(content.slice(from, i)); from = i + 1; }
    }
    items.push(content.slice(from));
    return items.map(s => s.trim()).filter(Boolean);
}

/** `key=value` or a bare key, as `{key, value}` (value `true` for a bare key). */
function option(item) {
    const eq = item.indexOf('=');
    if (eq < 0) return { key: item.trim(), value: true };
    return { key: item.slice(0, eq).trim(), value: item.slice(eq + 1).trim() };
}

/** A coordinate `(…)`'s content read as a node name (with an optional anchor), or null. */
function nameIn(content) {
    const m = /^\s*([A-Za-z_][\w-]*)(?:\.[\w ]+)?\s*$/.exec(content);
    return m ? m[1] : null;
}

/** Numeric `(x,y)` content, or null. */
function xyIn(content) {
    const parts = content.split(',');
    if (parts.length !== 2) return null;
    const x = NUMBER.exec(parts[0]), y = NUMBER.exec(parts[1]);
    return x && y ? { x: Number(x[1]), y: Number(y[1]) } : null;
}

const KINDS = {
    node: 'node', coordinate: 'coordinate', vertex: 'vertex', draw: 'draw', fill: 'draw', filldraw: 'draw',
    path: 'draw', clip: 'draw', shade: 'draw', shadedraw: 'draw', pattern: 'draw', matrix: 'matrix',
    diagram: 'diagram', foreach: 'foreach', pic: 'pic',
};
/** Commands that take groups and no `;`. */
const NO_SEMICOLON = new Set(['tikzset', 'pgfmathsetmacro', 'pgfmathtruncatemacro', 'pgfmathparse', 'def', 'newcommand',
    'renewcommand', 'tikzfeynmanset', 'colorlet', 'definecolor', 'usetikzlibrary']);

/**
 * One statement from `start` (at its backslash) in masked text `m`:
 * `{kind, command, start, end, name, options, at, label, refs}`; `end` is past
 * its `;` (or its last group). `null` when it does not end before `limit`.
 */
function statementAt(text, m, start, limit) {
    const head = /^\\([A-Za-z@]+)(\*?)/.exec(m.slice(start, start + 40));
    if (!head) return null;
    const command = head[1] + head[2];
    let i = start + head[0].length;
    const skip = () => { while (i < limit && /\s/.test(m[i])) i++; };
    if (NO_SEMICOLON.has(head[1])) {
        skip();
        while (i < limit && (m[i] === '{' || m[i] === '[')) { const c = closing(m, i); if (c < 0) return null; i = c + 1; skip(); }
        return { kind: 'setting', command, start, end: i, name: null, options: null, at: null, label: null, refs: [] };
    }
    if (head[1] === 'foreach') {
        // `\foreach \x in {…}` then a group or one statement.
        const inAt = m.indexOf(' in', i);
        if (inAt < 0 || inAt > limit) return null;
        i = inAt + 3; skip();
        if (m[i] === '{') { const c = closing(m, i); if (c < 0) return null; i = c + 1; }
        skip();
        let end;
        if (m[i] === '{') { const c = closing(m, i); if (c < 0) return null; end = c + 1; }
        else { const e = statementEnd(m, i, limit); if (e < 0) return null; end = e + 1; }
        return { kind: 'foreach', command, start, end, name: null, options: null, at: null, label: null, refs: [] };
    }
    const semi = statementEnd(m, start, limit);
    if (semi < 0) return null;
    const stmt = { kind: KINDS[head[1]] || 'other', command, start, end: semi + 1, name: null, options: null,
        at: null, label: null, refs: [], coords: [] };
    if (head[1] === 'diagram') stmt.kind = 'diagram';
    // Walk the statement's top-level tokens.
    let sawAt = false, first = true;
    while (i < semi) {
        const c = m[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '[') {
            const close = closing(m, i);
            if (close < 0 || close > semi) break;
            if (first && !stmt.options) stmt.options = { open: i, close, items: splitOptions(text.slice(i + 1, close)) };
            i = close + 1; continue;
        }
        if (c === '(') {
            const close = closing(m, i);
            if (close < 0 || close > semi) break;
            const content = text.slice(i + 1, close);
            const xy = xyIn(content), name = nameIn(content);
            if (sawAt) { stmt.at = { start: i + 1, end: close, ...(xy || { x: null, y: null }) }; sawAt = false; }
            else if (name && (stmt.kind === 'node' || stmt.kind === 'coordinate' || stmt.kind === 'vertex') && !stmt.name && !stmt.at)
                stmt.name = { value: name, start: i + 1, end: close };
            else if (name) stmt.refs.push(name);
            else if (xy) stmt.coords.push({ start: i + 1, end: close, ...xy });
            i = close + 1; first = false; continue;
        }
        if (c === '{') {
            const close = closing(m, i);
            if (close < 0 || close > semi) break;
            if (stmt.kind === 'diagram') {
                // `\diagram* { (a) -- [photon] (b) }`: the names in it are its ends.
                for (const g of text.slice(i + 1, close).matchAll(/\(([^()]*)\)/g)) { const n = nameIn(g[1]); if (n) stmt.refs.push(n); }
            } else if (!stmt.label && (stmt.kind === 'node' || stmt.kind === 'vertex')) stmt.label = { start: i + 1, end: close };
            i = close + 1; first = false; continue;
        }
        if (m.startsWith('at', i) && !/[A-Za-z]/.test(m[i + 2] || '')) { sawAt = true; i += 2; continue; }
        // Words (`--`, `to`, `edge`, `node`, …) and anything else.
        i++; first = false;
    }
    return stmt;
}

/**
 * The picture whose `\begin{tikzpicture}` is at (or just before) `start`:
 * `{begin, bodyStart, bodyEnd, end, scale, options, feynman, statements}`,
 * where `feynman` is the `{start, bodyStart, bodyEnd}` of its feynman
 * environment. `null` when there is no such picture.
 */
function parsePicture(text, start) {
    const m = masked(text);
    const begin = m.indexOf('\\begin{tikzpicture}', Math.max(0, start - 1));
    if (begin < 0 || begin > start + 200) return null;
    let i = begin + '\\begin{tikzpicture}'.length;
    while (/\s/.test(m[i] || '')) i++;
    let scale = 1, xscale = 1, yscale = 1, xunit = 1, yunit = 1, options = null;
    if (m[i] === '[') {
        const close = closing(m, i);
        if (close < 0) return null;
        options = { open: i, close, items: splitOptions(text.slice(i + 1, close)) };
        for (const item of options.items) {
            const o = option(item), v = Number(o.value);
            if (o.key === 'scale' && v) scale = v;
            else if (o.key === 'xscale' && v) xscale = v;
            else if (o.key === 'yscale' && v) yscale = v;
            else if ((o.key === 'x' || o.key === 'y') && typeof o.value === 'string') {
                const cm = lengthCm(o.value);
                if (cm) { if (o.key === 'x') xunit = cm; else yunit = cm; }
            }
        }
        i = close + 1;
    }
    const bodyStart = i;
    const envs = /\\(begin|end)\{(tikzpicture|feynman)\}/g;
    envs.lastIndex = begin;
    let depth = 0, e, bodyEnd = -1, feynman = null;
    while ((e = envs.exec(m))) {
        if (e[2] === 'feynman') {
            if (depth === 1 && e[1] === 'begin' && !feynman) feynman = { start: e.index, bodyStart: e.index + e[0].length, bodyEnd: -1 };
            else if (depth === 1 && e[1] === 'end' && feynman && feynman.bodyEnd < 0) feynman.bodyEnd = e.index;
            continue;
        }
        depth += e[1] === 'begin' ? 1 : -1;
        if (depth === 0) { bodyEnd = e.index; break; }
    }
    if (bodyEnd < 0) return null;
    const statements = [];
    for (let k = bodyStart; k < bodyEnd;) {
        if (m[k] !== '\\') { k++; continue; }
        if (m.startsWith('\\begin{', k) || m.startsWith('\\end{', k)) {
            const close = m.indexOf('}', k);
            k = close < 0 ? bodyEnd : close + 1; continue;
        }
        const stmt = statementAt(text, m, k, bodyEnd);
        if (!stmt) { k++; continue; }
        stmt.text = text.slice(stmt.start, stmt.end);
        statements.push(stmt);
        k = stmt.end;
    }
    // Centimetres per picture unit along each axis: `x=`/`y=` lengths, times
    // `scale` and `xscale`/`yscale`. Picture-wide rotations and shifts are
    // not modelled (a unit vector with a y part is ignored).
    const unitX = xunit * scale * xscale, unitY = yunit * scale * yscale;
    return { begin, bodyStart, bodyEnd, end: bodyEnd + '\\end{tikzpicture}'.length, scale, unitX, unitY, options, feynman, statements };
}

/** A TeX length (`1.5cm`, `8mm`, `20pt`, `1in`, `28bp`) in centimetres, or null. */
function lengthCm(text) {
    const m = /^\s*\{?\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(cm|mm|pt|in|bp)\s*\}?\s*$/.exec(text);
    if (!m) return null;
    const per = { cm: 1, mm: 0.1, pt: 2.54 / 72.27, in: 2.54, bp: 2.54 / 72 }[m[2]];
    return Number(m[1]) * per || null;
}

/** The statement containing `offset` (for instance a special's source span). */
function statementAtOffset(picture, offset) {
    return picture.statements.find(s => offset >= s.start && offset < s.end) || null;
}

/** The node names used in a picture. */
function names(picture) {
    return new Set(picture.statements.map(s => s.name?.value).filter(Boolean));
}

/** A name not yet used in the picture: `prefix1`, `prefix2`, … */
function freshName(picture, prefix = 'n', taken = new Set()) {
    const used = names(picture);
    for (let k = 1; ; k++) if (!used.has(`${prefix}${k}`) && !taken.has(`${prefix}${k}`)) return `${prefix}${k}`;
}

/**
 * Move a statement by (dx, dy) in picture units: its `at (x,y)` numbers when it
 * has them (edges naming it follow), otherwise a leading `shift` option.
 */
function moveEdit(stmt, dx, dy) {
    if (stmt.at && stmt.at.x != null) {
        return { start: stmt.at.start, end: stmt.at.end, text: `${num(stmt.at.x + dx)},${num(stmt.at.y + dy)}` };
    }
    if (stmt.kind === 'setting') return null;
    const items = stmt.options ? [...stmt.options.items] : [];
    const lead = items.length ? /^shift\s*=\s*\{\s*\(\s*([-+0-9.eE]+)\s*(?:cm)?\s*,\s*([-+0-9.eE]+)\s*(?:cm)?\s*\)\s*\}$/.exec(items[0]) : null;
    let [x, y] = [dx, dy];
    if (lead) { x += Number(lead[1]); y += Number(lead[2]); items.shift(); }
    if (Math.abs(x) >= 0.0005 || Math.abs(y) >= 0.0005) items.unshift(`shift={(${num(x)},${num(y)})}`);
    return optionListEdit(stmt, items);
}

/** Place a statement at (x, y), when it has numeric `at` coordinates. */
function placeEdit(stmt, x, y) {
    if (!stmt.at || stmt.at.x == null) return null;
    return { start: stmt.at.start, end: stmt.at.end, text: `${num(x)},${num(y)}` };
}

/** Replace the statement's option list with `items` (inserting one after the command when it has none). */
function optionListEdit(stmt, items) {
    const list = items.length ? `[${items.join(', ')}]` : '';
    if (stmt.options) return { start: stmt.options.open, end: stmt.options.close + 1, text: list };
    if (!list) return null;
    const at = stmt.start + 1 + stmt.command.length;
    return { start: at, end: at, text: list };
}

/**
 * Set option `key` to `value` (`true` for a bare key, `null` to remove it).
 * `replaces` names other keys the new one supersedes (e.g. every dash
 * pattern replaces the others).
 */
function setOptionEdit(stmt, key, value, replaces = []) {
    const drop = new Set([key, ...replaces]);
    const items = (stmt.options?.items || []).filter(item => !drop.has(option(item).key));
    if (value !== null && value !== false) items.push(value === true ? key : `${key}=${value}`);
    return optionListEdit(stmt, items);
}

/** Give an unnamed node, coordinate or vertex the name `name`. */
function nameEdit(stmt, name) {
    if (stmt.name || !['node', 'coordinate', 'vertex'].includes(stmt.kind)) return null;
    const at = stmt.options ? stmt.options.close + 1 : stmt.start + 1 + stmt.command.length;
    return { start: at, end: at, text: ` (${name})` };
}

/** Where a new statement goes: before `\end{feynman}` for feynman items when there is one, else before `\end{tikzpicture}`. */
function insertionPoint(text, picture, { feynman = false } = {}) {
    const before = feynman && picture.feynman && picture.feynman.bodyEnd > 0 ? picture.feynman.bodyEnd : picture.bodyEnd;
    const lineStart = text.lastIndexOf('\n', before - 1) + 1;
    const own = text.slice(lineStart, before).trim() === '';
    // Indented like what precedes it at the same level: statements inside the
    // feynman environment when inserting there, else those outside it (and the
    // environment's own `\end{feynman}`).
    const f = picture.feynman;
    const inside = s => f && f.bodyEnd > 0 && s.start > f.start && s.start < f.bodyEnd;
    const marks = picture.statements.filter(s => s.end <= before && (before === f?.bodyEnd ? inside(s) : !inside(s))).map(s => s.start);
    if (f && f.bodyEnd > 0 && before !== f.bodyEnd && f.bodyEnd < before) marks.push(f.bodyEnd);
    const last = marks.length ? Math.max(...marks) : -1;
    let indent = '  ';
    if (last >= 0) { const ls = text.lastIndexOf('\n', last - 1) + 1; indent = /^[ \t]*/.exec(text.slice(ls, last))[0] || indent; }
    return { at: own ? lineStart : before, prefix: own ? indent : `\n${indent}`, own };
}

/**
 * Edits inserting statements (each a line of source) into the picture, with a
 * feynman environment around feynman items when the picture has none.
 */
function insertEdits(text, picture, lines, { feynman = false, after = 0 } = {}) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    // `after`: the statements must come after this offset (an edge after its
    // nodes). A feynman environment that ends before it gets a new one.
    const wrap = feynman && (!picture.feynman || picture.feynman.bodyEnd < 0 || picture.feynman.bodyEnd < after);
    const p = insertionPoint(text, picture, { feynman: feynman && !wrap });
    const indent = p.prefix.replace(/^\n/, '');
    const body = wrap ? ['\\begin{feynman}', ...lines.map(l => `  ${l}`), '\\end{feynman}'] : lines;
    const joined = body.map(l => indent + l).join(eol);
    return [{ start: p.at, end: p.at, text: p.own ? joined + eol : eol + joined }];
}

/** The range removing a statement — its whole line when it is alone there. */
function deleteEdit(text, stmt) {
    const lineStart = text.lastIndexOf('\n', stmt.start - 1) + 1;
    let lineEnd = text.indexOf('\n', stmt.end);
    if (lineEnd < 0) lineEnd = text.length;
    const alone = text.slice(lineStart, stmt.start).trim() === '' && text.slice(stmt.end, lineEnd).trim() === '';
    return alone ? { start: lineStart, end: Math.min(text.length, lineEnd + 1), text: '' } : { start: stmt.start, end: stmt.end, text: '' };
}

/** Statements that name `name` (edges of a node), for deleting a node with its edges. */
function dependents(picture, name) {
    return picture.statements.filter(s => s.refs.includes(name));
}

/**
 * Copies of statements shifted by (dx, dy), renamed so they do not clash;
 * references between the copied statements follow the renaming.
 */
function duplicateLines(picture, stmts, dx, dy) {
    const taken = new Set();
    const rename = new Map();
    for (const s of stmts) if (s.name) {
        const fresh = freshName(picture, s.name.value.replace(/\d+$/, '') || 'n', taken);
        taken.add(fresh);
        rename.set(s.name.value, fresh);
    }
    return stmts.map(s => {
        let t = s.text;
        const edits = [];
        if (s.at && s.at.x != null) edits.push({ start: s.at.start, end: s.at.end, text: `${num(s.at.x + dx)},${num(s.at.y + dy)}` });
        if (s.name) edits.push({ start: s.name.start, end: s.name.end, text: rename.get(s.name.value) });
        for (const e of edits.sort((a, b) => b.start - a.start)) t = t.slice(0, e.start - s.start) + e.text + t.slice(e.end - s.start);
        // References to copied nodes follow the copies.
        t = t.replace(/\(([A-Za-z_][\w-]*)((?:\.[\w ]+)?)\)/g, (all, n, anchor) => rename.has(n) && !(s.name && n === s.name.value) ? `(${rename.get(n)}${anchor})` : all);
        const followsCopies = s.refs.some(n => rename.has(n));
        if (!s.at && !s.name && !followsCopies && (dx || dy)) {
            const moved = moveEdit({ ...s, start: 0, command: s.command, options: s.options && { ...s.options, open: s.options.open - s.start, close: s.options.close - s.start } }, dx, dy);
            if (moved) t = t.slice(0, moved.start) + moved.text + t.slice(moved.end);
        }
        return t.replace(/\r?\n\s*/g, ' ');
    });
}

// --- the preamble ------------------------------------------------------------

/** WPaper's styles for super Dynkin diagrams (Kac; Frappat–Sciarrino–Sorba conventions). */
const DYNKIN_STYLES = [
    'dynkin even/.style={circle,draw,fill=white,minimum size=2.4mm,inner sep=0pt}',
    'dynkin odd/.style={circle,draw,fill=black,minimum size=2.4mm,inner sep=0pt}',
    'dynkin iso/.style={circle,draw,fill=gray!40,minimum size=2.4mm,inner sep=0pt,path picture={\\draw (path picture bounding box.north west)--(path picture bounding box.south east) (path picture bounding box.north east)--(path picture bounding box.south west);}}',
    'dynkin iso white/.style={dynkin iso,fill=white}',
    'dynkin double/.style={double,double distance=1.6pt,postaction={decorate},decoration={markings,mark=at position .6 with {\\arrow{Straight Barb[length=3pt,width=5pt]}}}}',
    'dynkin double reversed/.style={double,double distance=1.6pt,postaction={decorate},decoration={markings,mark=at position .4 with {\\arrowreversed{Straight Barb[length=3pt,width=5pt]}}}}',
    'dynkin triple/.style={double,double distance=2.4pt,postaction={draw},postaction={decorate},decoration={markings,mark=at position .6 with {\\arrow{Straight Barb[length=3pt,width=6pt]}}}}',
    'dynkin triple reversed/.style={double,double distance=2.4pt,postaction={draw},postaction={decorate},decoration={markings,mark=at position .4 with {\\arrowreversed{Straight Barb[length=3pt,width=6pt]}}}}',
    'dynkin indefinite/.style={dashed}',
];
const STYLE_BEGIN = '% WPaper TikZ styles (added by the WPaper picture editor)';
const STYLE_END = '% end of WPaper TikZ styles';

/**
 * Edits making the preamble load what `needs` asks for, once:
 * `{ tikz, libraries: [...], feynman, dynkin }`. Existing loads (including
 * `tikz-feynman`, which loads tikz) are respected; additions go in a marked
 * block just before `\begin{document}`.
 */
function preambleEdits(text, needs) {
    const m = masked(text);
    const docStart = m.indexOf('\\begin{document}');
    if (docStart < 0) return [];
    const pre = m.slice(0, docStart);
    const loads = pkg => new RegExp(`\\\\(?:usepackage|RequirePackage)\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*\\b${pkg.replace('-', '\\-')}\\b[^}]*\\}`).test(pre);
    const libs = new Set();
    for (const g of pre.matchAll(/\\usetikzlibrary\s*\{([^}]*)\}/g)) for (const l of g[1].split(',')) libs.add(l.trim());
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = [];
    const hasFeynman = loads('tikz-feynman');
    if (needs.feynman && !hasFeynman) lines.push('\\usepackage[compat=1.1.0]{tikz-feynman}', '\\tikzfeynmanset{warn luatex=false}');
    else if ((needs.tikz || needs.libraries?.length || needs.dynkin || needs.colors?.length) && !loads('tikz') && !hasFeynman && !loads('pgfplots')) lines.push('\\usepackage{tikz}');
    for (const pkg of needs.packages || []) if (!loads(pkg)) lines.push(`\\usepackage{${pkg}}`);
    // Palette colours, defined once (a paper's own definition wins).
    for (const [name, hex] of needs.colors || []) {
        if (!new RegExp(`\\\\(?:define|provide)color\\s*\\{${name}\\}`).test(pre)) lines.push(`\\definecolor{${name}}{HTML}{${hex}}`);
    }
    const wanted = [...new Set([...(needs.libraries || []), ...(needs.dynkin ? ['arrows.meta', 'decorations.markings'] : [])])]
        .filter(l => !libs.has(l));
    if (wanted.length) lines.push(`\\usetikzlibrary{${wanted.join(',')}}`);
    const blockAt = pre.indexOf(STYLE_BEGIN);
    const hasDynkin = /dynkin even\/\.style/.test(pre);
    if (needs.dynkin && !hasDynkin) lines.push(`\\tikzset{${eol}  ${DYNKIN_STYLES.join(`,${eol}  `)}${eol}}`);
    if (!lines.length) return [];
    if (blockAt >= 0) {
        const endAt = pre.indexOf(STYLE_END, blockAt);
        if (endAt >= 0) return [{ start: endAt, end: endAt, text: lines.join(eol) + eol }];
    }
    return [{ start: docStart, end: docStart, text: [STYLE_BEGIN, ...lines, STYLE_END, ''].join(eol) }];
}

module.exports = {
    num, masked, splitOptions, option, lengthCm, parsePicture, statementAtOffset, names, freshName,
    moveEdit, placeEdit, setOptionEdit, optionListEdit, nameEdit, insertEdits, deleteEdit, dependents, duplicateLines,
    preambleEdits, DYNKIN_STYLES, STYLE_BEGIN, STYLE_END,
};
