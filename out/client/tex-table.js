// tex-table.js — a tabular as a grid, and back: the table editor's model.
//
// Pure (no DOM). `parseTabular` finds the first tabular / tabular* / tabularx
// in a text and reads its column spec, rules and cells; the grid operations
// return a new table; `serializeTabular` writes it back as tidy, idiomatic
// LaTeX. Cell contents are never interpreted: a \multicolumn, maths, a
// \textbf stay exactly as written. A column spec with constructs the grid
// cannot edit safely (>{…}, <{…}, *{n}{…}) keeps cells editable and marks the
// spec read-only.

// A rule, or a comment line, before a row: kept as written.
const RULE = /^(\\(hline|toprule|midrule|bottomrule|cmidrule(\([^)]*\))?\{[^}]*\}|cline\{[^}]*\})|%[^\n]*)\s*/;
// A cell holding a comment ends its line, or the comment would swallow the rest.
const COMMENT = /(^|[^\\])(\\\\)*%/;

/** Split at top-level (brace depth 0, not escaped) occurrences of `sep` (a regex source), keeping the separators. */
function splitTop(body, sep) {
    const parts = [], seps = [], starts = [0];
    const re = new RegExp(sep, 'y');
    let depth = 0, from = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '%') { const nl = body.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
        if (c === '{') { depth++; continue; }
        if (c === '}') { depth--; continue; }
        if (depth === 0) {
            re.lastIndex = i;
            const m = re.exec(body);
            if (m) { parts.push(body.slice(from, i)); seps.push(m[0]); i += m[0].length - 1; from = i + 1; starts.push(from); continue; }
        }
        if (c === '\\') i++;
    }
    parts.push(body.slice(from));
    return [parts, seps, starts];
}

function readGroup(s, i) {
    while (/\s/.test(s[i] || '')) i++;
    if (s[i] !== '{') return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '{') depth++;
        else if (s[j] === '}' && --depth === 0) return { body: s.slice(i + 1, j), end: j + 1 };
    }
    return null;
}

/** The columns of a spec: `{ align }` each, or null when the spec is not the grid's to edit. */
function parseSpec(spec) {
    if (/[<>*]/.test(spec)) return null;
    const cols = [];
    for (let i = 0; i < spec.length; i++) {
        const c = spec[i];
        if (/[lcrX]/.test(c)) cols.push({ align: c });
        else if (/[pmb]/.test(c)) { const g = readGroup(spec, i + 1); if (!g) return null; cols.push({ align: `${c}{${g.body}}` }); i = g.end - 1; }
        else if (c === '@' || c === '!') { const g = readGroup(spec, i + 1); if (!g) return null; i = g.end - 1; }
        else if (c === '|' || /\s/.test(c)) continue;
        else return null;
    }
    return cols;
}

/**
 * The tabular in `text` that holds offset `at` (else the first):
 * `{ start, end, env, width, position, spec, cols, specEditable, rows, closing }`.
 * `rows` are `{ rules, cells, spans, tail }`: the rules written before the row,
 * its cells (trimmed), each cell's `[from, to]` in `text` (so typing in a cell
 * replaces just that text), and what follows its \\ (such as [2pt]); `closing`
 * holds the rules after the last row. Null when there is none.
 */
function parseTabular(text, at = -1) {
    const s = String(text || '');
    const all = [...s.matchAll(/\\begin\s*\{(tabular\*?|tabularx)\}/g)];
    if (!all.length) return null;
    const parsed = all.map(m => parseAt(s, m)).filter(Boolean);
    return parsed.find(t => at >= t.start && at <= t.end) || parsed[0] || null;
}

function parseAt(s, m) {
    let at = m.index + m[0].length;
    let width = null;
    if (m[1] !== 'tabular') { const w = readGroup(s, at); if (!w) return null; width = w.body; at = w.end; }
    // An optional vertical position [t]/[b]/[c].
    const pos = /^\s*\[[tbc]\]/.exec(s.slice(at));
    const position = pos ? pos[0].trim() : '';
    if (pos) at += pos[0].length;
    const specGroup = readGroup(s, at);
    if (!specGroup) return null;
    const bodyStart = specGroup.end;
    const endRe = new RegExp(`\\\\end\\s*\\{${m[1].replace('*', '\\*')}\\}`, 'g');
    endRe.lastIndex = bodyStart;
    const end = endRe.exec(s);
    if (!end) return null;
    const body = s.slice(bodyStart, end.index);
    const [chunks, seps, starts] = splitTop(body, /\\\\(\[[^\]]*\])?/.source);
    const rows = [];
    let closing = [];
    chunks.forEach((chunk, k) => {
        let off = bodyStart + starts[k];
        let rest = chunk;
        const lead = rest.length - rest.trimStart().length;
        rest = rest.slice(lead); off += lead;
        const rules = [];
        let r;
        while ((r = RULE.exec(rest))) { rules.push(r[0].trim()); rest = rest.slice(r[0].length); off += r[0].length; }
        if (k === chunks.length - 1 && !rest.trim()) { closing = rules; return; }
        const [cells, , cellStarts] = splitTop(rest, '&');
        const spans = cells.map((c, j) => {
            const from = off + cellStarts[j] + (c.length - c.trimStart().length);
            return [from, from + c.trim().length];
        });
        rows.push({ rules, cells: cells.map(c => c.trim()), spans, tail: (seps[k] || '\\\\').slice(2) });
    });
    const cols = parseSpec(specGroup.body);
    return { start: m.index, end: end.index + end[0].length, env: m[1], width, position, spec: specGroup.body,
        cols: cols || [], specEditable: !!cols, rows, closing };
}

/** The cell holding offset `at`: `{ row, col }`, or null. */
function cellAt(t, at) {
    for (let r = 0; r < t.rows.length; r++) {
        const spans = t.rows[r].spans || [];
        for (let c = 0; c < spans.length; c++) {
            const next = spans[c + 1]?.[0] ?? t.rows[r + 1]?.spans?.[0]?.[0] ?? t.end;
            if (at >= spans[c][0] && at < Math.max(spans[c][1] + 1, next)) return { row: r, col: c };
        }
    }
    return null;
}

/** Write a table back: one row per line, cells padded into columns. */
function serializeTabular(t) {
    const width = t.width !== null && t.width !== undefined ? `{${t.width}}` : '';
    const spec = t.specEditable ? specOf(t) : t.spec;
    const n = Math.max(0, ...t.rows.map(r => r.cells.length));
    const widths = Array.from({ length: n }, (_, j) => Math.max(0, ...t.rows.map(r => (r.cells[j] ?? '').length)));
    const lines = [`\\begin{${t.env}}${width}${t.position || ''}{${spec}}`];
    for (const row of t.rows) {
        for (const rule of row.rules) lines.push(`  ${rule}`);
        const cells = row.cells.map((c, j) => (COMMENT.test(c) ? `${c}\n   ` : j < row.cells.length - 1 ? c.padEnd(widths[j]) : c));
        lines.push(`  ${cells.join(' & ').trimEnd()} \\\\${row.tail || ''}`);
    }
    for (const rule of t.closing || []) lines.push(`  ${rule}`);
    lines.push(`\\end{${t.env}}`);
    return lines.join('\n');
}

/** The spec from the columns, keeping the original's vertical bars when they are regular. */
function specOf(t) {
    const spec = t.spec.trim();
    const outer = t.bars ? t.bars.outer : /^\|\|/.test(spec) && /\|\|$/.test(spec) ? 2 : /^\|/.test(spec) && /\|$/.test(spec) ? 1 : 0;
    const between = t.bars ? t.bars.inner : /[lcrXpmb](\{[^}]*\})?\|[lcrXpmb]/.test(t.spec);
    // @{} and !{} are the spec's own and stay at the ends they were at.
    const lead = /^(@\{[^}]*\})/.exec(spec)?.[1] || '', trail = /(@\{[^}]*\})$/.exec(spec)?.[1] || '';
    const body = t.cols.map(c => c.align).join(between ? '|' : '');
    const bar = '|'.repeat(outer);
    return `${lead}${bar}${body}${bar}${trail}`;
}

const copy = t => ({ ...t, cols: t.cols.map(c => ({ ...c })), rows: t.rows.map(r => ({ ...r, rules: [...r.rules], cells: [...r.cells], spans: undefined })), closing: [...(t.closing || [])] });

function setCell(t, r, c, text) { const n = copy(t); if (n.rows[r]) { while (n.rows[r].cells.length <= c) n.rows[r].cells.push(''); n.rows[r].cells[c] = text; } return n; }
function addRow(t, after) {
    const n = copy(t);
    const cols = Math.max(n.cols.length, ...n.rows.map(r => r.cells.length), 1);
    n.rows.splice(after + 1, 0, { rules: [], cells: Array(cols).fill(''), tail: '' });
    return n;
}
/** Remove row `r`; its lines take the place of the next row's (one line where two rows met), its comments stay. */
function removeRow(t, r) {
    const n = copy(t);
    if (n.rows.length < 2) return n;
    const [gone] = n.rows.splice(r, 1);
    const line = x => /^\\(hline|toprule|midrule|bottomrule)$/.test(x);
    const next = n.rows[r];
    if (!next) {
        // The last row: its top line meets the closing rules.
        n.closing = [...gone.rules.filter(x => !line(x)), ...(n.closing.some(line) ? n.closing : [...gone.rules.filter(line), ...n.closing])];
        return n;
    }
    const lines = gone.rules.some(line) ? gone.rules.filter(line) : next.rules.filter(line);
    next.rules = [...gone.rules.filter(x => !line(x)), ...next.rules.filter(x => !line(x)), ...lines];
    return n;
}
function addColumn(t, after, align = 'c') {
    const n = copy(t);
    if (n.specEditable) n.cols.splice(after + 1, 0, { align });
    for (const row of n.rows) if (!/\\multicolumn/.test(row.cells.join(''))) row.cells.splice(Math.min(after + 1, row.cells.length), 0, '');
    return n;
}
function removeColumn(t, c) {
    const n = copy(t);
    if (n.specEditable && n.cols.length > 1) n.cols.splice(c, 1);
    for (const row of n.rows) if (!/\\multicolumn/.test(row.cells.join('')) && row.cells.length > 1) row.cells.splice(c, 1);
    return n;
}
function setAlign(t, c, align) { const n = copy(t); if (n.specEditable && n.cols[c]) n.cols[c].align = align; return n; }

/**
 * The border styles, each as a column frame and the rules between rows:
 *   none     — no lines;
 *   header   — one rule under the header row;
 *   rows     — a rule above, between and below every row;
 *   box      — a frame around the table;
 *   grid     — every cell framed;
 *   double   — a double frame, single lines inside;
 *   booktabs — \toprule, \midrule under the header, \bottomrule (the booktabs
 *              package; no vertical lines, as its author asks).
 * `outer`: bars at the spec's ends (0, 1 or 2); `inner`: bars between columns;
 * `top`/`head`/`between`/`bottom`: the rules at those places.
 */
const BORDERS = {
    none:     { outer: 0, inner: false, top: [], head: [], between: [], bottom: [] },
    header:   { outer: 0, inner: false, top: [], head: ['\\hline'], between: [], bottom: [] },
    rows:     { outer: 0, inner: false, top: ['\\hline'], head: ['\\hline'], between: ['\\hline'], bottom: ['\\hline'] },
    box:      { outer: 1, inner: false, top: ['\\hline'], head: [], between: [], bottom: ['\\hline'] },
    grid:     { outer: 1, inner: true, top: ['\\hline'], head: ['\\hline'], between: ['\\hline'], bottom: ['\\hline'] },
    double:   { outer: 2, inner: true, top: ['\\hline', '\\hline'], head: ['\\hline'], between: ['\\hline'], bottom: ['\\hline', '\\hline'] },
    booktabs: { outer: 0, inner: false, top: ['\\toprule'], head: ['\\midrule'], between: [], bottom: ['\\bottomrule'] },
};
const LINE = /^\\(hline|toprule|midrule|bottomrule)$/;

/** Set a border style: the rules and the spec's bars; comments and partial rules are kept. */
function setBorders(t, style) {
    const b = BORDERS[style];
    if (!b) return t;
    const n = copy(t);
    const booktabs = style === 'booktabs';
    // Partial rules follow the style's package: \cmidrule in booktabs, \cline otherwise.
    const partial = r => {
        const cm = /^\\cmidrule(\([^)]*\))?\{([^}]*)\}$/.exec(r), cl = /^\\cline\{([^}]*)\}$/.exec(r);
        if (booktabs && cl) return `\\cmidrule(lr){${cl[1]}}`;
        if (!booktabs && cm) return `\\cline{${cm[2]}}`;
        return r;
    };
    const keep = rules => rules.filter(r => !LINE.test(r)).map(partial);
    n.rows.forEach((row, i) => {
        const place = i === 0 ? b.top : i === 1 ? b.head : b.between;
        row.rules = [...keep(row.rules), ...place];
    });
    n.closing = [...keep(n.closing), ...b.bottom];
    n.bars = { outer: b.outer, inner: b.inner };
    return n;
}

/** The border style a table has, or null when it is none of them. */
function bordersOf(t) {
    const lines = rules => rules.filter(r => LINE.test(r)).join('');
    const spec = t.spec.replace(/\s+/g, '');
    const outer = (/^\|\|/.test(spec) ? 2 : /^\|/.test(spec) ? 1 : 0);
    const inner = /[^|]\|[^|]/.test(spec.replace(/^\|+|\|+$/g, 'x'));
    for (const [name, b] of Object.entries(BORDERS)) {
        if (b.outer !== outer || b.inner !== inner) continue;
        const want = (i) => (i === 0 ? b.top : i === 1 ? b.head : b.between).join('');
        if (t.rows.every((row, i) => lines(row.rules) === want(i)) && lines(t.closing) === b.bottom.join('')) return name;
    }
    return null;
}

/** booktabs rules (top, mid, bottom), or the \hline grid back. */
function setBooktabs(t, on) { return setBorders(t, on ? 'booktabs' : 'grid'); }

export { BORDERS, setBorders, bordersOf, parseTabular, cellAt, serializeTabular, setCell, addRow, removeRow, addColumn, removeColumn, setAlign, setBooktabs };
