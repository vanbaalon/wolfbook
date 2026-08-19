'use strict';
const assert = require('assert');
const { resolveJsonPath, describeJson } = require('../json-path');

const root = { rows: [[1, 2], [3, 4]], meta: { name: 'test' } };
assert.strictEqual(resolveJsonPath(root, ['meta', 'name']).value, 'test');
assert.strictEqual(resolveJsonPath(root, 'rows.1.0').value, 3);
assert.deepStrictEqual(resolveJsonPath(root, []).manifest.keys.sort(), ['meta', 'rows']);
const miss = resolveJsonPath(root, ['missing']);
assert.strictEqual(miss.error, 'JSON path could not be resolved');
assert(miss.keys.includes('rows'));
assert.match(resolveJsonPath(root, ['__proto__']).hint, /not allowed/);
assert.deepStrictEqual(describeJson(root.rows).dims, [2, 2]);
assert.strictEqual(describeJson([[1], [2, 3]]).dims, null);

// Stale-schema clients deliver the documented array form as a JSON STRING —
// it must resolve identically to the real array (live-tested 2026-08-19).
assert.strictEqual(resolveJsonPath(root, '["rows", 1, 0]').value, 3);
assert.strictEqual(resolveJsonPath(root, '["meta","name"]').value, 'test');
// A malformed bracket string still falls back to the dotted interpretation.
assert.strictEqual(resolveJsonPath(root, '[broken').error, 'JSON path could not be resolved');

console.log('json-path tests: OK');
