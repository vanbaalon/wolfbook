// reviewBus.js — the one thing the MCP tools and the review UI both know about.
//
// `paper_applyEdit` writes through a WorkspaceEdit on the OPEN BUFFER, so the
// file watcher never fires and the change would be invisible to the review —
// the tool the agent is told to use would be the only one whose edits cannot be
// judged. It cannot require tex/reviewUi.js (that pulls vscode into the tool
// module's require graph and makes a cycle), so it announces here instead.
//
// Pure, no vscode, no fs, and deliberately tiny: an announcement nobody is
// listening for is dropped, never queued.

const listeners = new Set();

/**
 * An announcement carries a PHASE, because the edit is applied to the open
 * buffer and the buffer's change event cannot tell who typed it:
 *
 *   begin  about to write — the review stops mirroring changes to this file
 *          into its baseline, which is how the reader's own typing is kept out
 *          of the list. Without it the tool's edit was mirrored, agreed to on
 *          the reader's behalf, and never appeared as something to review.
 *   end    written — open or extend the review.
 *
 * @param {(ev:{file:string, baseText:string, phase?:'begin'|'end',
 *              source?:string, note?:string}) => void} fn
 * @returns {{dispose:()=>void}}
 */
function onAgentEdit(fn) {
    if (typeof fn !== 'function') return { dispose() {} };
    listeners.add(fn);
    return { dispose() { listeners.delete(fn); } };
}

/** Tell whoever is listening that an agent changed a paper. Never throws. */
function announceAgentEdit(ev) {
    if (!ev || !ev.file) return;
    for (const fn of [...listeners]) {
        try { fn(ev); } catch (_) { /* a listener's failure is not the writer's */ }
    }
}

module.exports = { onAgentEdit, announceAgentEdit };
