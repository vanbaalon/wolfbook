'use strict';

// A model never writes through the reader's open mini-editor. Other fragments
// remain editable by the model, without locking the whole document or viewer.
const readers = new Set();
function registerReaderRange(read) {
    readers.add(read);
    return { dispose() { readers.delete(read); } };
}
function readerRanges(file) {
    const ranges = [];
    for (const read of readers) {
        try {
            const r = read();
            if (r && r.file === file && Number.isFinite(r.start) && Number.isFinite(r.end)) ranges.push(r);
        } catch (_) { /* a disposed viewer does not own an editor */ }
    }
    return ranges;
}
function readerConflict(file, changes) {
    for (const r of readerRanges(file)) {
        if (changes.some(c => c.start === c.end ? c.start >= r.start && c.start <= r.end
            : c.start < r.end && c.end > r.start)) return {
            state: 'user-editing', file,
            reason: 'The reader has this fragment open in the mini-editor; no model edit was applied.',
            reader_range: { startOffset:r.start, endOffset:r.end },
            remedy: 'Work on other fragments, or retry after the reader closes or moves the mini-editor. Keep the comment pending.',
        };
    }
    return null;
}
module.exports = { registerReaderRange, readerRanges, readerConflict };
