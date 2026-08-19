'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECTION_VERSION = 1;
const RENDERER_VERSION = 'wolfbook-btl-v1';

function bytesOf(data) {
    if (data == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data);
    return Buffer.from(String(data), 'utf8');
}

function inferMime(item, text) {
    if (item?.mime) return item.mime;
    if (/^\s*</.test(text)) return 'text/html';
    if (/^data:image\//.test(text)) return text.slice(5, text.indexOf(';'));
    return 'text/plain';
}

function canonicalLatex(html) {
    const match = String(html).match(/data-latex-b64="([A-Za-z0-9+/=]+)"/);
    if (!match) return null;
    try { return Buffer.from(match[1], 'base64').toString('utf8'); } catch (_) { return null; }
}

function plainPreview(items, maxChars = 1000) {
    for (const item of items) {
        const text = bytesOf(item?.data).toString('utf8');
        if (inferMime(item, text) === 'text/plain' && text.trim()) return text.trim().slice(0, maxChars);
    }
    for (const item of items) {
        const text = bytesOf(item?.data).toString('utf8');
        const latex = canonicalLatex(text);
        if (latex) return latex.slice(0, maxChars);
    }
    return '';
}

class ContentAddressedRenderCache {
    constructor(directory, enabled = false) { this.directory = directory; this.enabled = !!enabled && !!directory; }
    key(format, canonical) {
        return crypto.createHash('sha256').update(`${RENDERER_VERSION}\0${format}\0${canonical}`).digest('hex');
    }
    put(format, canonical, rendered) {
        const key = this.key(format, canonical);
        if (!this.enabled) return { key, stored: false };
        fs.mkdirSync(this.directory, { recursive: true });
        const target = path.join(this.directory, `${key}.cache`);
        if (!fs.existsSync(target)) fs.writeFileSync(target, bytesOf(rendered));
        return { key, stored: true };
    }
    get(key) {
        if (!this.enabled || !/^[0-9a-f]{64}$/.test(String(key))) return null;
        const target = path.join(this.directory, `${key}.cache`);
        return fs.existsSync(target) ? fs.readFileSync(target) : null;
    }
}

function projectOutput(output, options = {}) {
    const items = output?.items || [];
    const cache = options.cache || null;
    const manifest = items.map(item => {
        const data = bytesOf(item?.data);
        const text = data.toString('utf8');
        const mime = inferMime(item, text);
        const latex = /html/.test(mime) ? canonicalLatex(text) : null;
        const record = {
            mime, bytes: data.length,
            sha256: crypto.createHash('sha256').update(data).digest('hex'),
            derivable: !!latex,
        };
        if (latex) {
            record.canonical_format = 'latex';
            record.canonical_sha256 = crypto.createHash('sha256').update(latex).digest('hex');
            record.cache = cache?.put('latex-html', latex, data) || { key: null, stored: false };
        }
        return record;
    });
    return { preview: plainPreview(items, options.previewChars), manifest };
}

function projectNotebook(notebook, options = {}) {
    const cells = [];
    const from = Math.max(0, Number(options.from || 0));
    const to = Math.min(notebook.cellCount, Number(options.to ?? notebook.cellCount));
    for (let index = from; index < to; index++) {
        const cell = notebook.cellAt(index);
        cells.push({
            cell_number: index + 1,
            cell_id: options.getCellId?.(cell) || null,
            kind: Number(cell.kind) === 1 ? 'markdown' : 'code',
            language: cell.document?.languageId || null,
            source: cell.document?.getText?.() || '',
            outputs: (cell.outputs || []).map(output => projectOutput(output, options)),
        });
    }
    return {
        projection: 'wolfbook.mcp.notebook', projection_version: PROJECTION_VERSION,
        notebook: notebook.uri?.fsPath || notebook.uri?.toString?.() || null,
        cell_count: notebook.cellCount, cells,
    };
}

module.exports = { PROJECTION_VERSION, RENDERER_VERSION, ContentAddressedRenderCache, projectOutput, projectNotebook, plainPreview };
