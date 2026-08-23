// collapse.js — folding a section away, WITHOUT touching the shared paper.
//
// Pure: no vscode, no fs, never throws.
//
// THE IDEA. Hold Shift in WPaper and every section offers to collapse. A
// collapsed section is not typeset: the paper on screen gets shorter and the
// compile gets faster, so what is left is the part being worked on.
//
// WHAT IS WRITTEN INTO THE .tex IS THE STATE, NOT THE CONSEQUENCE.
//
// The first version of this commented the section's body out of the file
// itself. That was wrong, and the reason is the whole point of the feature:
// the same .tex is shared — on Overleaf, over git, with collaborators — and a
// fold is ONE READER'S VIEW of it. A colleague opening the shared paper must
// see every section, and Overleaf must typeset all of them. So the file gets
// two comment lines saying what is folded:
//
//   \section{The upper tower}
//   %WPaper[Collapsed]
//   … the body, untouched …
//   %WPaper[/Collapsed]
//
// and the commenting-out happens in the TEMPORARY COPY that WPaper compiles
// (the same overlay the live render already writes for unsaved buffers). To
// anyone without this extension the markers are two inert comments and the
// paper is complete.
//
// TWO MARKERS, NOT ONE. The region is then EXPLICIT: no rule has to be
// re-derived later about where a section ends, the reader can see both ends in
// the editor, and a heading that is renamed or moved does not strand the fold.
//
// THE TRANSFORM PRESERVES THE LINE COUNT. Each folded line becomes `%WP%` plus
// itself rather than being deleted, so every line of the temporary copy is at
// the same line number as in the real file — which is what keeps the render
// map, and with it every click on the page, pointing at the right place.

const MARK = '%WPaper[Collapsed]';
const MARK_END = '%WPaper[/Collapsed]';
const PREFIX = '%WP%';
/** Matches either marker at the start of a line, with anything after it. */
const MARK_RE = /^\s*%WPaper\[Collapsed\]/;
const MARK_END_RE = /^\s*%WPaper\[\/Collapsed\]/;

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
 * @returns {{collapsed:boolean, markerLine:number, endLine:number,
 *            hidden:number, note:string}}
 */
function collapseStateAt(lines, headEnd) {
    const none = { collapsed: false, markerLine: 0, endLine: 0, hidden: 0, note: '' };
    if (!Array.isArray(lines)) return none;
    const at = headEnd;                       // 1-based: the line after the heading
    const marker = lines[at] == null ? null : lines[at];
    if (marker == null || !MARK_RE.test(marker)) return none;
    // The closing marker, which is where the region ends. Without one the fold
    // is malformed — a reader deleted it — and the honest answer is that this
    // section is NOT folded, so nothing is hidden from anybody.
    let end = 0;
    for (let i = at + 1; i < lines.length; i++) {
        if (MARK_END_RE.test(lines[i])) { end = i + 1; break; }
        if (MARK_RE.test(lines[i])) break;    // a new fold starts: this one never closed
    }
    if (!end) return none;
    return {
        collapsed: true,
        markerLine: at + 1,
        endLine: end,
        hidden: end - (at + 1) - 1,
        note: marker.slice(marker.indexOf(MARK) + MARK.length).trim(),
    };
}

/**
 * The edit that folds one section: TWO COMMENT LINES, and nothing else.
 *
 * The body is not touched. What is on disk stays the paper everybody else
 * reads; only WPaper's own temporary copy leaves it out (see foldForCompile).
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
    // of the file, and putting the closing marker after \end{document} would
    // fold the end of the document out of the compiled copy — a paper that
    // does not compile at all, from a gesture that was meant to shorten it.
    const end = Math.min(Number(o.spanEnd) || 0, bodyEndLine(lines));
    const from = headEnd + 1;
    if (end < from) return { ok: false, reason: 'this section has no body to collapse' };

    const body = lines.slice(from - 1, end);
    if (!body.some(l => l.trim())) return { ok: false, reason: 'this section is already empty' };
    // A body already inside somebody else's fold is not ours to fold again.
    if (body.some(l => MARK_RE.test(l) || MARK_END_RE.test(l))) {
        return { ok: false, reason: 'this section already contains a fold' };
    }

    const title = String(o.title || '').replace(/\s+/g, ' ').trim();
    return {
        ok: true,
        hidden: body.length,
        edit: {
            startLine: from,
            endLine: end + 1,
            lines: [`${MARK}${title ? ` ${title}` : ''}`, ...body, MARK_END],
        },
    };
}

/**
 * The edit that brings one back: the two marker lines go, the body stays.
 */
function expandSection(o = {}) {
    const lines = Array.isArray(o.lines) ? o.lines : [];
    const headEnd = Number(o.headEnd) || 0;
    const st = collapseStateAt(lines, headEnd);
    if (!st.collapsed) return { ok: false, reason: 'that section is not collapsed' };
    return {
        ok: true,
        shown: st.hidden,
        edit: {
            startLine: st.markerLine,
            endLine: st.endLine + 1,
            lines: lines.slice(st.markerLine, st.endLine - 1),
        },
    };
}

/**
 * THE TEMPORARY COPY: the same text with every folded region commented out.
 *
 * This is what WPaper compiles, and it is the ONLY place the content is ever
 * commented. Line for line with the original — a folded line becomes `%WP%`
 * plus itself, never disappears — because the render map records source LINE
 * NUMBERS, and a copy whose lines had shifted would put every click on the
 * page a few lines out.
 *
 * Idempotent, and safe on a file with no folds at all (it returns the text it
 * was given, unchanged and un-copied).
 */
function foldForCompile(text) {
    const src = String(text == null ? '' : text);
    if (src.indexOf(MARK) < 0) return src;          // the overwhelmingly common case
    const lines = src.split('\n');
    let out = null;
    for (let i = 0; i < lines.length; i++) {
        if (!MARK_RE.test(lines[i])) continue;
        // ONLY A MATCHED PAIR HIDES ANYTHING. A reader who deletes a closing
        // marker by hand must not thereby fold the rest of their paper out of
        // the compiled copy — an opening marker with no partner is inert, the
        // same answer collapseStateAt gives.
        let end = -1;
        for (let j = i + 1; j < lines.length; j++) {
            if (MARK_END_RE.test(lines[j])) { end = j; break; }
            if (MARK_RE.test(lines[j])) break;      // the next fold starts: this one never closed
            // AND NEVER PAST THE END OF THE DOCUMENT, whatever the markers
            // say. Commenting \end{document} out produces a paper that does
            // not compile at all; no fold is worth that, so the scan stops
            // there even for a pair a hand-edit has stretched too far.
            if (/^\s*\\end\s*\{document\}/.test(lines[j])) break;
        }
        if (end < 0) continue;
        if (!out) out = lines.slice();
        for (let k = i + 1; k < end; k++) {
            // An empty line needs no comment and reads better without one.
            if (lines[k].length) out[k] = PREFIX + lines[k];
        }
        i = end;
    }
    return out ? out.join('\n') : src;
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
    MARK, MARK_END, PREFIX, MARK_RE, MARK_END_RE, foldForCompile,
    bodyEndLine, collapseStateAt, collapseSection, expandSection, applyEdit, collapsedSections,
};
