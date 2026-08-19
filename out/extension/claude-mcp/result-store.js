'use strict';
const crypto = require('crypto');
const { resolveJsonPath } = require('../kernel/json-path');

class McpResultStore {
    constructor(options = {}) {
        this.maximum = options.maximum || 50;
        this.ttlMs = options.ttlMs || 60 * 60 * 1000;
        this._items = new Map();
    }
    put(value, format = 'text', metadata = {}) {
        const handle = `result_${crypto.randomUUID()}`;
        const item = { value: String(value), format, metadata: { ...metadata }, expiresAt: Date.now() + this.ttlMs };
        this._items.set(handle, item); this._trim();
        return { handle, ...item };
    }
    get(handle, offset = 0, limit = 8192, requestedFormat = null, path = undefined) {
        const item = this._items.get(String(handle));
        if (!item || item.expiresAt <= Date.now()) { this._items.delete(String(handle)); return null; }
        let value = item.value;
        if (path !== undefined) {
            let structured;
            try { structured = JSON.parse(value); }
            catch (_) { return { error: 'Result is not valid JSON.', handle }; }
            const resolved = resolveJsonPath(structured, path);
            if (resolved.error) return { handle, ...resolved };
            if (resolved.root) return { handle, path: [], manifest: resolved.manifest };
            value = JSON.stringify(resolved.value, null, 2);
            offset = Math.max(0, Number(offset) || 0); limit = Math.max(1, Math.min(65536, Number(limit) || 8192));
            return { handle, path, manifest: resolved.manifest, offset, limit, total_chars: value.length,
                next_offset: offset + limit < value.length ? offset + limit : null,
                data: value.slice(offset, offset + limit), expires_at: new Date(item.expiresAt).toISOString() };
        }
        const format = requestedFormat === 'json' ? 'json' : item.format;
        if (format === 'json') {
            try { value = JSON.stringify(JSON.parse(value), null, 2); } catch (_) { return { error: 'Result is not valid JSON.', handle }; }
        }
        offset = Math.max(0, Number(offset) || 0); limit = Math.max(1, Math.min(65536, Number(limit) || 8192));
        return {
            handle, ...item.metadata, format, offset, limit, total_chars: value.length,
            next_offset: offset + limit < value.length ? offset + limit : null,
            data: value.slice(offset, offset + limit), expires_at: new Date(item.expiresAt).toISOString(),
        };
    }
    envelope(value, previewChars = 2000, format = 'text', metadata = {}) {
        const item = this.put(value, format, metadata);
        return { preview: item.value.slice(0, previewChars), truncated: item.value.length > previewChars,
            total_chars: item.value.length, result_handle: item.handle,
            expires_at: new Date(item.expiresAt).toISOString(), format, ...metadata };
    }
    _trim() {
        for (const [key, item] of this._items) if (item.expiresAt <= Date.now()) this._items.delete(key);
        while (this._items.size > this.maximum) this._items.delete(this._items.keys().next().value);
    }
}
module.exports = { McpResultStore };
