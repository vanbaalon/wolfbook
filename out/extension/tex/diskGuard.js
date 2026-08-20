// diskGuard.js — noticing when the file moved underneath us, and refusing to
// write over it.
//
// Pure: no vscode, never throws.
//
// WHY. A .tex in this workspace is a shared object. Dropbox syncs it, Overleaf
// pushes to it, a second editor or a git checkout rewrites it, and a
// collaborator's change can land while a buffer sits open with unsaved edits of
// its own. There are exactly two things that must not happen: a change on disk
// disappearing under a save, and a change on disk being applied on top of stale
// content the agent read minutes ago.
//
// Both reduce to one question — does what is on disk still match what we based
// our work on? — so it is answered in one place, deterministically, and every
// writer asks before writing.

const crypto = require('crypto');

/** sha256 of a string, the same digest the model uses for object identity. */
function hashText(text) {
    return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** What a change on disk means for a file we have open. */
const VERDICT = {
    /** Disk and buffer agree — most often our own save coming back at us. */
    UNCHANGED: 'unchanged',
    /** Disk moved; the buffer has no unsaved edits, so nothing is at risk. */
    EXTERNAL_CLEAN: 'external-clean',
    /** Disk moved AND the buffer has unsaved edits. Only a human can choose. */
    CONFLICT: 'external-conflict',
    /** The file is gone. */
    DELETED: 'deleted',
};

/**
 * Classify a change on disk.
 *
 * @param {object} o
 * @param {string|null} o.diskText   what the file holds now (null = deleted)
 * @param {string} o.docText         what the open buffer holds
 * @param {boolean} o.isDirty        whether the buffer has unsaved edits
 * @returns {string} a VERDICT
 */
function classifyExternalChange({ diskText, docText, isDirty }) {
    if (diskText == null) return VERDICT.DELETED;
    // Compared by CONTENT, not by mtime. Dropbox and git both touch mtimes
    // without changing bytes, and a save that round-trips through the watcher
    // would otherwise look like somebody else's edit every single time.
    if (diskText === docText) return VERDICT.UNCHANGED;
    return isDirty ? VERDICT.CONFLICT : VERDICT.EXTERNAL_CLEAN;
}

/**
 * May we write this file, given what our edit was computed from?
 *
 * `baseText` is the content the edit was derived from. If disk no longer holds
 * that, the edit was computed against something that is no longer true and
 * applying it would silently drop whatever arrived in between.
 *
 * A DIRTY buffer is the one case where disagreement is expected and fine: the
 * user's own unsaved edits are why disk differs, and they are not something to
 * protect the file from. What must still be refused is saving that buffer over
 * a disk copy that a third party changed — which is `isDirty` AND disk having
 * moved away from `baseText`.
 *
 * @returns {{ok: true} | {ok: false, reason: string, diskHash: string|null}}
 */
function checkWritable({ diskText, baseText, isDirty = false, willSave = false }) {
    // NO FILE ON DISK IS NOT A CONFLICT. An untitled buffer, or one whose file
    // was deleted, has nothing that a write could destroy — the buffer IS the
    // only copy. Refusing here would block editing the very documents that are
    // least at risk. (A deletion is still reported, by the watcher.)
    if (diskText == null) return { ok: true, absent: true };
    if (diskText === baseText) return { ok: true };
    if (!isDirty) {
        return {
            ok: false,
            diskHash: hashText(diskText),
            reason: 'the file changed on disk since it was read — reload it and redo the edit ' +
                'against the current content',
        };
    }
    if (willSave) {
        return {
            ok: false,
            diskHash: hashText(diskText),
            reason: 'the file changed on disk while this buffer has unsaved edits — saving now ' +
                'would discard the other change. Resolve it in the editor first',
        };
    }
    // Dirty buffer, not saving: the edit lands in the buffer only, and VS Code
    // will apply its own save-conflict rules when the user saves.
    return { ok: true };
}

/**
 * Remembers the last disk content we told the user about, so one external edit
 * produces one prompt rather than one per watcher event.
 *
 * Dropbox in particular fires several change events for a single write.
 */
class DiskWatch {
    constructor() {
        this._seen = new Map();      // path -> hash of the disk content last acted on
    }

    /** Note the content we consider current for a path, without prompting. */
    accept(file, text) {
        if (text == null) this._seen.delete(file);
        else this._seen.set(file, hashText(text));
    }

    forget(file) { this._seen.delete(file); }
    dispose() { this._seen.clear(); }

    /**
     * @returns {{verdict: string, repeat: boolean}} `repeat` is true when this
     *   is the same disk content we already reported — the caller should stay
     *   quiet rather than ask again.
     */
    classify(file, { diskText, docText, isDirty }) {
        const verdict = classifyExternalChange({ diskText, docText, isDirty });
        const h = diskText == null ? null : hashText(diskText);
        const repeat = this._seen.get(file) === h && h !== null;
        if (verdict !== VERDICT.UNCHANGED) this._seen.set(file, h);
        return { verdict, repeat };
    }
}

module.exports = { hashText, classifyExternalChange, checkWritable, DiskWatch, VERDICT };
