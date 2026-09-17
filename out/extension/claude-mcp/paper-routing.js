'use strict';
const path = require('path');
function paperWindowInfo() {
    try {
        const { workspace } = require('vscode');
        return {
            paperFiles: (workspace.textDocuments || []).filter(d => !d.isClosed && /\.tex$/i.test(d.uri.fsPath)).map(d => d.uri.fsPath),
            workspaceRoots: (workspace.workspaceFolders || []).map(f => f.uri.fsPath),
        };
    } catch (_) { return { paperFiles: [], workspaceRoots: [] }; }
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
