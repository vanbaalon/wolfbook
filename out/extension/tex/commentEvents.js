'use strict';

// Notifications carry filenames only. Posting a comment never waits for a
// model, parses source, compiles, or reserves the editor.
const listeners = new Set();
function onCommentChange(fn) {
    listeners.add(fn);
    return { dispose() { listeners.delete(fn); } };
}
function announceCommentChange(file) {
    for (const fn of [...listeners]) {
        try { fn({ file }); } catch (_) { /* annotations must remain usable */ }
    }
}
module.exports = { onCommentChange, announceCommentChange };
