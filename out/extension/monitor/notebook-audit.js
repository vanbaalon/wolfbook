'use strict';

const path = require('path');
const crypto = require('crypto');
const { getActivityContext } = require('./activity');

function cellId(cell) {
    const metadata = cell?.metadata || {};
    return String(metadata.id || metadata.cellId || cell?.document?.uri?.fragment || `cell-${cell?.index ?? '?'}`);
}
function hash(text) { return crypto.createHash('sha256').update(String(text || '')).digest('hex'); }
function compactDiff(before, after) {
    before = String(before || ''); after = String(after || '');
    let prefix = 0; const maxPrefix = Math.min(before.length, after.length);
    while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    const removed = before.slice(prefix, before.length - suffix);
    const added = after.slice(prefix, after.length - suffix);
    return { prefixLength: prefix, suffixLength: suffix, removed: removed.slice(0, 12000), added: added.slice(0, 12000), removedLength: removed.length, addedLength: added.length };
}

function registerNotebookAudit(vscode, context, monitor, clientInfo = {}) {
    const snapshots = new Map();
    const isWolfbook = doc => doc?.notebookType === 'extended-wolfram-notebook' || /\.(wb|evsnb|vsnb)$/i.test(doc?.uri?.fsPath || '');
    const key = (doc, cell) => `${doc.uri.toString()}::${cellId(cell)}`;
    const seed = doc => { if (isWolfbook(doc)) for (const cell of doc.getCells()) snapshots.set(key(doc, cell), cell.document.getText()); };
    for (const doc of vscode.workspace.notebookDocuments || []) seed(doc);

    const record = (type, doc, payload, extra = {}) => {
        const activity = getActivityContext() || {};
        monitor.record({ type, source: activity.source || 'vscode', clientId: clientInfo.clientId,
            workspace: clientInfo.workspace, notebook: doc.uri.fsPath, state: extra.state || null,
            operationId: activity.operationId, agentSessionId: activity.agentSessionId, agentName: activity.agentName,
            payload: { file: path.basename(doc.uri.fsPath), dirty: doc.isDirty, ...payload } });
    };

    context.subscriptions.push(vscode.workspace.onDidOpenNotebookDocument(doc => {
        if (!isWolfbook(doc)) return; seed(doc); record('notebook.opened', doc, { cellCount: doc.cellCount });
    }));
    context.subscriptions.push(vscode.workspace.onDidCloseNotebookDocument(doc => {
        if (!isWolfbook(doc)) return; record('notebook.closed', doc, { cellCount: doc.cellCount });
        for (const item of [...snapshots.keys()]) if (item.startsWith(`${doc.uri.toString()}::`)) snapshots.delete(item);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeNotebookDocument(event => {
        const doc = event.notebook; if (!isWolfbook(doc)) return;
        for (const change of event.cellChanges || []) {
            if (!change.document) continue;
            const cell = change.cell, id = cellId(cell), current = cell.document.getText();
            const previous = snapshots.get(key(doc, cell)); snapshots.set(key(doc, cell), current);
            if (previous === undefined || previous === current) continue;
            record('notebook.cell.edited', doc, { action: 'edit', cellId: id, cellNumber: (cell.index ?? 0) + 1,
                kind: cell.kind === 1 ? 'markdown' : 'code', language: cell.document.languageId,
                beforeHash: hash(previous), afterHash: hash(current), diff: compactDiff(previous, current) });
        }
        for (const change of event.contentChanges || []) {
            for (const removed of change.removedCells || []) {
                const id = cellId(removed), previous = snapshots.get(key(doc, removed)) ?? removed.document?.getText?.() ?? '';
                snapshots.delete(key(doc, removed));
                record('notebook.cell.deleted', doc, { action: 'delete', cellId: id, cellNumber: (removed.index ?? change.range?.start ?? 0) + 1,
                    kind: removed.kind === 1 ? 'markdown' : 'code', beforeHash: hash(previous), previous: String(previous).slice(0, 12000) });
            }
            let index = change.range?.start ?? 0;
            for (const added of change.addedCells || []) {
                const source = added.document?.getText?.() || ''; snapshots.set(key(doc, added), source);
                record('notebook.cell.inserted', doc, { action: 'insert', cellId: cellId(added), cellNumber: ++index,
                    kind: added.kind === 1 ? 'markdown' : 'code', language: added.document?.languageId, afterHash: hash(source), source: source.slice(0, 12000) });
            }
        }
    }));
    if (typeof vscode.workspace.onDidSaveNotebookDocument === 'function') {
        context.subscriptions.push(vscode.workspace.onDidSaveNotebookDocument(doc => {
            if (isWolfbook(doc)) record('notebook.saved', doc, { cellCount: doc.cellCount, savedAt: new Date().toISOString() }, { state: 'completed' });
        }));
    }
}

module.exports = { registerNotebookAudit, compactDiff, cellId };
