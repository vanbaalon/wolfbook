'use strict';
const crypto = require('crypto');

// Wolfram LSP expects file URIs; URL[vscode-notebook-cell:...] reaches
// FileNameSplit unevaluated. Use distinct virtual .wl URIs, without writing
// files, and map diagnostics/locations back to the actual notebook cell.
function notebookUriConverters(vscode) {
    const originals = new Map();
    return {
        code2Protocol(uri) {
            if (uri.scheme !== 'vscode-notebook-cell') return uri.toString();
            const original = uri.toString();
            const key = crypto.createHash('sha256').update(original).digest('hex').slice(0, 24);
            const virtual = uri.with({scheme:'file', query:'', fragment:'', path:`${uri.path}.wolfbook-cell-${key}.wl`}).toString();
            originals.set(virtual, uri);
            return virtual;
        },
        protocol2Code(value) { return originals.get(value) || vscode.Uri.parse(value); },
    };
}

module.exports = {notebookUriConverters};
