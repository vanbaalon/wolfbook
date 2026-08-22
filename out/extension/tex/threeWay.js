// threeWay.js — the reader was typing while the agent wrote the file.
//
// Pure: no vscode, no fs, never throws.
//
// THE SITUATION. A .tex is open with unsaved edits and an agent rewrites the
// file on disk. VS Code cannot reload a dirty buffer, so it keeps both and
// refuses the next save — "the content of the file is newer" — and the reader
// is left with a modal that offers only *discard one side or the other*. The
// review never engages, because there is no single text to review: there are
// three.
//
//   BASE    what both sides started from (the last saved content)
//   OURS    BASE + the reader's unsaved edits
//   THEIRS  BASE + the agent's edits, now on disk
//
// Nearly always the two touch different parts of the paper — the reader is
// fixing a sentence in section 2 while the agent rewrites an equation in
// section 5 — and then there is no conflict at all, only a merge nobody
// performed. That is what this does: bring the agent's changes into the
// reader's text wherever the two do not overlap, and say plainly which ones
// could not be brought in.
//
// CONSERVATIVE ON PURPOSE. An agent hunk is applied only when the BASE lines
// it replaces are untouched by the reader. A merge that is wrong is far worse
// than one that declines: the decline is visible, the wrong merge is not.
//
// The delicate case is an INSERTION, which replaces no lines at all — it sits
// in the seam between two of them. The rule here is the one git uses, and it
// is symmetric, which is why it can be explained: a seam is contested only when
// the reader replaced the lines on BOTH sides of it. An insertion that merely
// abuts a line the reader rewrote is applied — it is new text next to changed
// text, which is not a disagreement about anything. Two insertions into the
// same seam both land, the reader's first; nothing is lost either way.
//
// WHAT IT NEVER DOES: write conflict markers. `<<<<<<<` in a .tex does not
// compile, and a paper that will not compile is a worse outcome than a change
// left on disk for the reader to look at.

const { diffLines, splitLines } = require('./texDiff');

/** Lines, with the trailing "" of a final newline dropped — as diffLines does. */
function lines(text) {
    const a = splitLines(String(text == null ? '' : text));
    if (a.length && a[a.length - 1] === '') a.pop();
    return a;
}

const isSeam = (h) => h.bEnd === h.bStart;

/**
 * Do these two hunks disagree about the same BASE text?
 *
 * Ranges are half-open, so two hunks that merely touch (one ends where the
 * other begins) do not collide — they are consecutive edits, not competing
 * ones. A seam (an insertion, which replaces nothing) collides only when it
 * falls STRICTLY INSIDE what the other side replaced: the reader rewrote the
 * lines either side of it, so there is no longer a place to put it.
 */
function collides(r, t) {
    if (isSeam(r) && isSeam(t)) return false;   // both land; see the header
    if (isSeam(t)) return r.bStart < t.bStart && t.bStart < r.bEnd;
    if (isSeam(r)) return t.bStart < r.bStart && r.bStart < t.bEnd;
    return r.bStart < t.bEnd && t.bStart < r.bEnd;
}

/**
 * Merge the agent's changes into the reader's text.
 *
 * @param {object} o
 * @param {string} o.base    the last text both sides agreed on
 * @param {string} o.ours    the reader's buffer, unsaved edits included
 * @param {string} o.theirs  what the agent wrote to disk
 * @returns {{text:string, applied:object[], conflicts:object[], clean:boolean,
 *            readerHunks:number}}
 *   `applied` and `conflicts` each carry `{baseRange:[s,e), theirLines,
 *   baseLines}`; `text` is OURS with every applied hunk brought in.
 */
function mergeThreeWay(o = {}) {
    const base = String(o.base == null ? '' : o.base);
    const ours = String(o.ours == null ? '' : o.ours);
    const theirs = String(o.theirs == null ? '' : o.theirs);

    // The two degenerate cases are answers, not special cases: if one side did
    // not move, the other side IS the merge.
    if (base === ours) return { text: theirs, applied: [], conflicts: [], clean: true, readerHunks: 0, trivial: 'ours-unchanged' };
    if (base === theirs) return { text: ours, applied: [], conflicts: [], clean: true, readerHunks: 0, trivial: 'theirs-unchanged' };

    const baseL = lines(base);
    const ourL = lines(ours);
    const theirL = lines(theirs);

    // diffLines(a, b) reports `a` ranges as aStart/aEnd and `b` ranges as
    // bStart/bEnd, so passing BASE as `b` puts both sides in one frame.
    let readers = [];
    let agents = [];
    try {
        readers = diffLines(ourL, baseL);
        agents = diffLines(theirL, baseL);
    } catch (_) {
        return { text: ours, applied: [], conflicts: [], clean: false, readerHunks: 0, failed: true };
    }

    const applied = [];
    const conflicts = [];
    for (const h of agents) {
        const record = {
            baseRange: [h.bStart, h.bEnd],
            kind: h.kind,
            theirLines: theirL.slice(h.aStart - 1, h.aEnd - 1),
            baseLines: baseL.slice(h.bStart - 1, h.bEnd - 1),
        };
        if (readers.some(r => collides(r, h))) conflicts.push(record);
        else applied.push({ ...record, _h: h });
    }

    // WHERE A BASE LINE SITS IN OURS. Only the reader hunks that end before it
    // can have moved it, and no reader hunk straddles an applied agent hunk —
    // that is what "no overlap" bought — so one offset holds across the range.
    const shiftAt = (baseLine) => {
        let d = 0;
        for (const r of readers) {
            if (r.bEnd <= baseLine) d += (r.aEnd - r.aStart) - (r.bEnd - r.bStart);
        }
        return d;
    };

    // Bottom-up, so an earlier splice cannot move a later one.
    const out = ourL.slice();
    const placed = applied
        .map(a => ({ a, start: a._h.bStart + shiftAt(a._h.bStart), end: a._h.bEnd + shiftAt(a._h.bStart) }))
        .sort((x, y) => y.start - x.start);
    for (const p of placed) {
        const from = Math.max(0, p.start - 1);
        const count = Math.max(0, p.end - p.start);
        out.splice(from, count, ...p.a.theirLines);
    }
    for (const a of applied) delete a._h;

    // A FINAL NEWLINE IS PART OF THE FILE, not of the diff. Both sides are
    // compared without it (diffLines drops it deliberately), so it is restored
    // from what the texts themselves say — the agent's copy wins, since disk is
    // what a later save is compared against.
    const endsNl = /\n$/.test(theirs) || (/\n$/.test(ours) && !theirs);
    const text = out.join('\n') + (endsNl && out.length ? '\n' : '');

    return {
        text,
        applied,
        conflicts,
        clean: conflicts.length === 0,
        readerHunks: readers.length,
    };
}

module.exports = { mergeThreeWay, collides };
