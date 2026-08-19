'use strict';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

function describeJson(node) {
    if (node === null) return { type: 'null' };
    if (Array.isArray(node)) {
        const shape = _arrayShape(node, 0, { siblings: 0 });
        return { type: 'array', length: node.length, dims: shape.rectangular ? shape.dims : null };
    }
    if (typeof node === 'object') {
        const keys = Object.keys(node);
        return { type: 'object', keys: keys.slice(0, 200), keys_total: keys.length };
    }
    return { type: typeof node };
}

function _arrayShape(node, depth, budget) {
    if (!Array.isArray(node)) return { rectangular: true, dims: [] };
    if (depth >= 3 || budget.siblings >= 1000) return { rectangular: true, dims: [node.length] };
    budget.siblings += node.length;
    if (node.length === 0) return { rectangular: true, dims: [0] };
    const childShapes = node.map(item => _arrayShape(item, depth + 1, budget));
    const first = JSON.stringify(childShapes[0].dims);
    const rectangular = childShapes.every(s => s.rectangular && JSON.stringify(s.dims) === first);
    return { rectangular, dims: rectangular ? [node.length, ...childShapes[0].dims] : null };
}

function _failure(at, node, hint) {
    return { error: 'JSON path could not be resolved', at, ...describeJson(node), hint };
}

function resolveJsonPath(root, path) {
    let parts = path;
    if (typeof parts === 'string') {
        const trimmed = parts.trim();
        // Clients with a stale schema deliver the documented array form as a
        // JSON string ('["a",0,"b"]') — accept it rather than splitting on '.'.
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) parts = parsed;
            } catch (_) { /* fall through to dotted split */ }
        }
        if (typeof parts === 'string') parts = parts === '' ? [] : parts.split('.').filter(Boolean);
    }
    if (!Array.isArray(parts)) return _failure(0, root, 'Pass path as an array of string keys and numeric indexes.');
    if (parts.length === 0) return { manifest: describeJson(root), value: root, root: true };
    let node = root;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (typeof part === 'string' && FORBIDDEN.has(part)) {
            return _failure(i, node, `Path component ${JSON.stringify(part)} is not allowed.`);
        }
        if (Array.isArray(node)) {
            const index = typeof part === 'number' ? part : (/^(?:0|[1-9]\d*)$/.test(String(part)) ? Number(part) : NaN);
            if (!Number.isInteger(index) || index < 0 || index >= node.length) {
                return _failure(i, node, `Use an array index from 0 to ${Math.max(0, node.length - 1)}.`);
            }
            node = node[index];
            continue;
        }
        if (node && typeof node === 'object') {
            const key = String(part);
            if (!Object.prototype.hasOwnProperty.call(node, key)) {
                return _failure(i, node, `Choose one of the listed keys, then retry with the extended path.`);
            }
            node = node[key];
            continue;
        }
        return _failure(i, node, 'The current value is scalar; remove this path component.');
    }
    return { manifest: describeJson(node), value: node, root: false };
}

module.exports = { resolveJsonPath, describeJson };
