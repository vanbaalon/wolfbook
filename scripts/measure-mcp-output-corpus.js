#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const { projectOutput, PROJECTION_VERSION, ContentAddressedRenderCache } = require('../out/extension/claude-mcp/output-projection');

const roots = process.argv.slice(2).length ? process.argv.slice(2) : [path.resolve(__dirname, '../quests')];
function walk(root, output = []) {
    if (!fs.existsSync(root)) return output;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) walk(full, output);
        else if (/\.(wb|evsnb|vsnb)$/i.test(entry.name)) output.push(full);
    }
    return output;
}
const files = roots.flatMap(root => walk(path.resolve(root))).sort();
const mime = {}, reductions = [], parseMs = [], projections = [];
let cells = 0, outputs = 0, items = 0, persistedOutputBytes = 0, projectedBytes = 0;
let sourceMismatches = 0, itemCountMismatches = 0;
let previewMismatches = 0;
let cacheSample = null;
for (const file of files) {
    const start = performance.now();
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    parseMs.push(performance.now() - start);
    const projected = { projection_version: PROJECTION_VERSION, cells: [] };
    let rawForFile = 0;
    for (const cell of doc.cells || []) {
        cells++;
        const pCell = { kind: cell.kind, language: cell.languageId || cell.language, source: cell.value || '', outputs: [] };
        if (pCell.source !== (cell.value || '')) sourceMismatches++;
        for (const output of cell.outputs || []) {
            outputs++;
            const p = projectOutput(output, { previewChars: 1000 });
            const plain = (output.items || []).find(item => (item.mime || '') === 'text/plain');
            if (plain) {
                const expected = String(plain.data || '').trim().slice(0, 1000);
                if (p.preview !== expected) previewMismatches++;
            }
            if (!cacheSample && p.manifest.some(m => m.derivable) && p.preview) {
                const rendered = (output.items || []).find(item => /^\s*</.test(String(item.data || '')))?.data;
                if (rendered) cacheSample = { canonical: p.preview, rendered };
            }
            pCell.outputs.push(p);
            if (p.manifest.length !== (output.items || []).length) itemCountMismatches++;
            for (const item of output.items || []) {
                items++;
                const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(String(item.data || ''), 'utf8');
                rawForFile += data.length; persistedOutputBytes += data.length;
                const key = item.mime || (/^\s*</.test(data.toString('utf8')) ? 'text/html' : 'text/plain');
                mime[key] = (mime[key] || 0) + data.length;
            }
        }
        projected.cells.push(pCell);
    }
    const pBytes = Buffer.byteLength(JSON.stringify(projected));
    projectedBytes += pBytes;
    if (rawForFile > 0) reductions.push(1 - pBytes / (rawForFile + Buffer.byteLength(JSON.stringify((doc.cells || []).map(c => c.value || '')))));
    projections.push(projected);
}
reductions.sort((a, b) => a - b);
parseMs.sort((a, b) => a - b);
const median = values => values.length ? values[Math.floor(values.length / 2)] : 0;
const firstPassTotal = parseMs.reduce((sum, value) => sum + value, 0);
let warmStart = performance.now();
for (const file of files) { try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {} }
const warmPassTotal = performance.now() - warmStart;
let cacheLatency = { cold_write: null, cold_read: null, warm_read: null };
if (cacheSample) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-mcp-cache-measure-'));
    try {
        const cache = new ContentAddressedRenderCache(temp, true);
        let t = performance.now(); const stored = cache.put('latex-html', cacheSample.canonical, cacheSample.rendered);
        cacheLatency.cold_write = Number((performance.now() - t).toFixed(3));
        t = performance.now(); cache.get(stored.key); cacheLatency.cold_read = Number((performance.now() - t).toFixed(3));
        t = performance.now(); cache.get(stored.key); cacheLatency.warm_read = Number((performance.now() - t).toFixed(3));
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
const result = {
    measured_at: new Date().toISOString(), projection_version: PROJECTION_VERSION,
    corpus: { roots, notebooks: files.length, cells, outputs, items },
    bytes: { persisted_output: persistedOutputBytes, canonical_projection: projectedBytes,
        estimated_persisted_output_tokens: Math.ceil(persistedOutputBytes / 4),
        estimated_projection_tokens: Math.ceil(projectedBytes / 4) },
    reduction: { aggregate_percent: persistedOutputBytes ? Number((100 * (1 - projectedBytes / persistedOutputBytes)).toFixed(2)) : 0,
        median_notebook_percent: Number((100 * median(reductions)).toFixed(2)), target_percent: 70 },
    fidelity: { source_mismatches: sourceMismatches, item_count_mismatches: itemCountMismatches, plain_preview_mismatches: previewMismatches },
    latency_ms: {
        first_observed_reopen_total: Number(firstPassTotal.toFixed(3)),
        warm_reopen_total: Number(warmPassTotal.toFixed(3)),
        median_json_reopen: Number(median(parseMs).toFixed(3)), cache: cacheLatency
    },
    bytes_by_mime: Object.fromEntries(Object.entries(mime).sort((a, b) => b[1] - a[1])),
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
