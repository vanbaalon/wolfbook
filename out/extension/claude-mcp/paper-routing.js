'use strict';
const path = require('path');
// Open .wslide decks. They live in a custom editor, not workspace.textDocuments,
// so the tabs are the source of truth. Drives the MCP "slides" tool family.
function openSlideFiles(window) {
    const out = new Set();
    for (const group of window?.tabGroups?.all || []) {
        for (const tab of group.tabs || []) {
            const uri = tab.input?.uri;
            if (uri?.fsPath && /\.wslide$/i.test(uri.fsPath)) out.add(uri.fsPath);
        }
    }
    return [...out];
}
function paperWindowInfo() {
    try {
        const { workspace, window } = require('vscode');
        return {
            paperFiles: [...new Set((workspace.textDocuments || []).filter(d => !d.isClosed && /\.tex$/i.test(d.uri.fsPath)).map(d => d.uri.fsPath))],
            slideFiles: openSlideFiles(window),
            workspaceRoots: (workspace.workspaceFolders || []).map(f => f.uri.fsPath),
        };
    } catch (_) { return { paperFiles: [], slideFiles: [], workspaceRoots: [] }; }
}
function normal(file) {
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(file || '');
    const value = (windows ? path.win32 : path.posix).normalize(file || '').replace(/\\/g, '/').replace(/\/$/, '');
    return windows ? value.toLowerCase() : value;
}
function selectPaperClient(clients, file, explicit) {
    if (explicit) return clients.filter(c => c.clientId === explicit);
    if (!file) return clients.length === 1 ? clients : [];
    const absolute = path.posix.isAbsolute(file) || path.win32.isAbsolute(file);
    const matches = clients.filter(c => (c.paperFiles || []).some(f => absolute ? normal(f) === normal(file) : normal(f).split('/').pop() === file));
    if (matches.length) return matches;
    if (absolute) {
        const scores = clients.map(c => ({ c, score: Math.max(0, ...(c.workspaceRoots || []).map(root => {
            const r = normal(root), f = normal(file);
            return f === r || f.startsWith(r + '/') ? r.length : 0;
        })) }));
        const best = Math.max(0, ...scores.map(s => s.score));
        if (best) return scores.filter(s => s.score === best).map(s => s.c);
    }
    return clients.length === 1 ? clients : [];
}
module.exports = { paperWindowInfo, selectPaperClient };
