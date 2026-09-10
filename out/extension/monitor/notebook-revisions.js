'use strict';

// A bounded, extension-host-lifetime delta journal. NotebookDocument.version is
// the authority; this merely records which stable cell IDs changed at each
// version so agents can request deltas instead of rereading an entire notebook.
const histories = new Map();
const MAX_REVISIONS = 500;

function key(doc) { return String(doc?.uri?.fsPath || doc?.uri?.toString?.() || '').replace(/\\/g, '/').toLowerCase(); }

function seedNotebook(doc) {
    const k = key(doc); if (!k) return;
    if (!histories.has(k)) histories.set(k, { baseRevision: Number(doc.version || 0), entries: [] });
}

function recordNotebookRevision(doc, cellIds = []) {
    const k = key(doc); if (!k) return;
    seedNotebook(doc);
    const history = histories.get(k);
    const revision = Number(doc.version || 0);
    const ids = [...new Set(cellIds.filter(Boolean).map(String))];
    const previous = history.entries[history.entries.length - 1];
    if (previous?.revision === revision) previous.cellIds = [...new Set([...previous.cellIds, ...ids])];
    else history.entries.push({ revision, cellIds: ids });
    while (history.entries.length > MAX_REVISIONS) {
        const removed = history.entries.shift();
        history.baseRevision = Math.max(history.baseRevision, removed.revision);
    }
}

function changedSince(doc, sinceRevision) {
    const currentRevision = Number(doc?.version || 0);
    const since = Number(sinceRevision);
    if (!Number.isFinite(since) || since < 0) return { available: false, currentRevision, reason: 'invalid-revision' };
    if (since >= currentRevision) return { available: true, currentRevision, cellIds: [] };
    const history = histories.get(key(doc));
    if (!history || since < history.baseRevision) {
        return { available: false, currentRevision, reason: 'history-unavailable', baseRevision: history?.baseRevision ?? currentRevision };
    }
    return {
        available: true,
        currentRevision,
        cellIds: [...new Set(history.entries.filter(e => e.revision > since).flatMap(e => e.cellIds))],
    };
}

function forgetNotebook(doc) { histories.delete(key(doc)); }

module.exports = { seedNotebook, recordNotebookRevision, changedSince, forgetNotebook };
