// collapse.js — folding a section AWAY, in the file itself.
//
// Pure: no vscode, no fs, never throws.
//
// THE IDEA. Hold Shift in WPaper and every section offers to collapse. A
// collapsed section's body is commented out in the .tex, so LaTeX genuinely
// does not typeset it: the paper gets shorter, the compile gets faster, and
// what is left is the part being worked on. The state lives in the FILE, not
// in a panel's memory — it survives a reload, a different machine, a git
// checkout, and a collaborator can see exactly what was folded away.
//
//   \section{The upper tower}
//   %WPaper[Collapsed] 42 lines
//   %WP%The body of the section, line by line,
//   %WP%each one prefixed, so the original comes back exactly.
//
// WHY A PREFIX AND NOT A BARE `%`. Restoring must be EXACT, and a bare `%`
// cannot be undone: a line that already started with one is indistinguishable
// from a line we commented. `%WP%` is stripped by position, so a line that was
// already a comment comes back as the comment it was.
//
// WHY NOT \iffalse … \fi. It is the usual trick and it is shorter, but it is
// TeX rather than text: the body must have balanced \if…\fi, and one stray
// \ifdim in a folded section silently swallows the rest of the paper. Line
// comments cannot do that. They also survive a body containing verbatim,
// unbalanced braces, or half-typed macros — which is the state a paper being
// written is usually in.
//
// WHAT IT COSTS, stated plainly: a \label inside a collapsed section stops
// existing, so \ref to it prints "??" until the section comes back. That is
// LaTeX's own behaviour for text that is not there, and it is the honest
// signal — hiding it would be worse.

const MARK = '%WPaper[Collapsed]';
const PREFIX = '%WP%';
/** Matches the marker at the start of a line, with anything after it. */
const MARK_RE = /^\s*%WPaper\[Collapsed\]/;

/** Where the document body ends: nothing at or after \end{document} is ours. */
function bodyEndLine(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\s*\\end\s*\{document\}/.test(lines[i])) return i;   // 1-based line above it
    }
    return lines.length;
}

/**
 * Is the section whose heading ends on `headEnd` collapsed?
 *
 * @returns {{collapsed:boolean, markerLine:number, hidden:number, note:string}}
 */
function collapseStateAt(lines, headEnd) {
    if (!Array.isArray(lines)) return { collapsed: false, markerLine: 0, hidden: 0, note: '' };
    const at = headEnd;                       // 1-based: the line after the heading
    const marker = lines[at] == null ? null : lines[at];
    if (marker == null || !MARK_RE.test(marker)) {
        return { collapsed: false, markerLine: 0, hidden: 0, note: '' };
    }
    let n = 0;
    while (lines[at + 1 + n] != null && lines[at + 1 + n].startsWith(PREFIX)) n++;
    return {
        collapsed: true,
        markerLine: at + 1,
        hidden: n,
        note: marker.slice(marker.indexOf(MARK) + MARK.length).trim(),
    };
}

/**
 * The edit that collapses one section.
 *
 * @param {object} o
 * @param {string[]} o.lines    the document, split into lines
 * @param {number} o.headEnd    1-based last line of the `\section{…}` command
 * @param {number} o.spanEnd    1-based last line the section governs
 * @param {string} [o.title]
 * @returns {{ok:true, edit:{startLine:number,endLine:number,lines:string[]}, hidden:number}
 *          | {ok:false, reason:string}}
 *   The edit replaces [startLine, endLine) — 1-based, end-exclusive.
 */
function collapseSection(o = {}) {
    const lines = Array.isArray(o.lines) ? o.lines : [];
    const headEnd = Number(o.headEnd) || 0;
    if (headEnd < 1 || headEnd > lines.length) return { ok: false, reason: 'that heading is not in the file' };
    if (collapseStateAt(lines, headEnd).collapsed) return { ok: false, reason: 'already collapsed' };

    // NEVER PAST THE END OF THE BODY. The last section's span runs to the end
    // of the file, and commenting out \end{document} produces a paper that does
    // not compile at all — from a gesture that was meant to shorten it.
    const end = Math.min(Number(o.spanEnd) || 0, bodyEndLine(lines));
    const from = headEnd + 1;
    if (end < from) return { ok: false, reason: 'this section has no body to collapse' };

    const body = lines.slice(from - 1, end);
    if (!body.some(l => l.trim())) return { ok: false, reason: 'this section is already empty' };
    // A body that is already folded (a parent was collapsed) is not ours to
    // fold again — the prefixes would nest and the reader would have to expand
    // twice for one section.
    if (body.every(l => !l.trim() || l.startsWith(PREFIX))) {
        return { ok: false, reason: 'this section is inside one that is already collapsed' };
    }

    const n = body.length;
    const title = String(o.title || '').replace(/\s+/g, ' ').trim();
    return {
        ok: true,
        hidden: n,
        edit: {
            startLine: from,
            endLine: end + 1,
            lines: [
                `${MARK} ${n} line${n === 1 ? '' : 's'}${title ? ` · ${title}` : ''}`,
                ...body.map(l => PREFIX + l),
            ],
        },
    };
}

/**
 * The edit that brings one back.
 *
 * The marker and the run of prefixed lines under it ARE the region — there is
 * no end marker to lose, and a reader who deletes some of the prefixed lines by
 * hand simply gets back the ones that are left.
 */
function expandSection(o = {}) {
    const lines = Array.isArray(o.lines) ? o.lines : [];
    const headEnd = Number(o.headEnd) || 0;
    const st = collapseStateAt(lines, headEnd);
    if (!st.collapsed) return { ok: false, reason: 'that section is not collapsed' };
    const first = st.markerLine + 1;
    const body = [];
    for (let i = 0; i < st.hidden; i++) body.push(lines[first - 1 + i].slice(PREFIX.length));
    return {
        ok: true,
        shown: st.hidden,
        edit: {
            startLine: st.markerLine,
            endLine: first + st.hidden,
            lines: body,
        },
    };
}

/** Apply one `{startLine, endLine, lines}` edit to a line array (for tests). */
function applyEdit(lines, edit) {
    const out = lines.slice();
    out.splice(edit.startLine - 1, Math.max(0, edit.endLine - edit.startLine), ...edit.lines);
    return out;
}

/** Every collapsed section in the file, keyed by the heading line above it. */
function collapsedSections(lines, heads) {
    const out = [];
    for (const h of (Array.isArray(heads) ? heads : [])) {
        const st = collapseStateAt(lines, Number(h.headEnd) || 0);
        if (st.collapsed) out.push({ ...h, ...st });
    }
    return out;
}

module.exports = {
    MARK, PREFIX, MARK_RE,
    bodyEndLine, collapseStateAt, collapseSection, expandSection, applyEdit, collapsedSections,
};
