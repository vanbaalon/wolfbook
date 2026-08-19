'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectOutput, projectNotebook, ContentAddressedRenderCache, PROJECTION_VERSION } = require('../../claude-mcp/output-projection');
const { McpResultStore } = require('../../claude-mcp/result-store');

const latex = '\\frac{1}{2}';
const html = `<div data-latex-b64="${Buffer.from(latex).toString('base64')}">rendered</div>`;
const output = { items: [
    { mime: 'x-application/wolfram-language-html', data: Buffer.from(html) },
    { mime: 'text/plain', data: Buffer.from('Out[1]=1/2') },
] };
const projected = projectOutput(output);
assert.strictEqual(projected.preview, 'Out[1]=1/2');
assert.strictEqual(projected.manifest.length, 2);
assert.strictEqual(projected.manifest[0].derivable, true);
assert(!JSON.stringify(projected).includes('rendered'));

const fakeCell = { kind: 2, document: { languageId: 'wolfram', getText: () => '1/2' }, outputs: [output] };
const notebook = { cellCount: 1, cellAt: () => fakeCell, uri: { fsPath: '/tmp/fidelity.wb' } };
const nb = projectNotebook(notebook, { getCellId: () => 'cell-1' });
assert.strictEqual(nb.projection_version, PROJECTION_VERSION);
assert.strictEqual(nb.cells[0].source, '1/2');
assert.strictEqual(nb.cells[0].outputs[0].manifest.length, output.items.length);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-projection-test-'));
try {
    const cache = new ContentAddressedRenderCache(tmp, true);
    const first = cache.put('latex-html', latex, html);
    const second = cache.put('latex-html', latex, 'different render ignored');
    assert.strictEqual(first.key, second.key);
    assert.strictEqual(cache.get(first.key).toString(), html);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

const store = new McpResultStore({ maximum: 2, ttlMs: 10000 });
const envelope = store.envelope('abcdefghijklmnopqrstuvwxyz', 5, 'text', { kernel_id: 'k-test' });
assert.deepStrictEqual(Object.keys(envelope), ['preview', 'truncated', 'total_chars', 'result_handle', 'expires_at', 'format', 'kernel_id']);
assert.strictEqual(envelope.preview, 'abcde');
assert.strictEqual(store.get(envelope.result_handle, 5, 4).data, 'fghi');
assert.strictEqual(store.get(envelope.result_handle, 0, 4).kernel_id, 'k-test');
const json = store.put('{"a":1}', 'text', { kernel_id: 'k-json' });
assert.strictEqual(store.get(json.handle, 0, 100, 'json').data, '{\n  "a": 1\n}');
const nested = store.put('{"rows":[{"value":7},{"value":9}]}', 'text');
assert.strictEqual(store.get(nested.handle, 0, 100, null, []).manifest.type, 'object');
const nestedSlice = store.get(nested.handle, 0, 100, null, ['rows', 1, 'value']);
assert.strictEqual(nestedSlice.data, '9');
assert.strictEqual(nestedSlice.manifest.type, 'number');
console.log('phase 6 projection/result tests: OK');
