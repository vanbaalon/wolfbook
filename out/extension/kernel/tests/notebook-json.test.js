'use strict';
const assert = require('assert');
const { escapeInvalidJsonBackslashes, parseNotebookJson } = require('../../utils/notebook-json');

const legacy = String.raw`{"cells":[{"kind":2,"value":"A = \[Alpha] + \[CurlyTheta]"}]}`;
assert.throws(() => JSON.parse(legacy), /JSON|escape/i);
assert.strictEqual(parseNotebookJson(legacy).cells[0].value, String.raw`A = \[Alpha] + \[CurlyTheta]`);

// Valid JSON escapes keep their normal meaning.
assert.strictEqual(parseNotebookJson(String.raw`{"value":"\u2014"}`).value, '—');
// An intentionally literal backslash-u remains literal.
assert.strictEqual(parseNotebookJson(String.raw`{"value":"\\u2014"}`).value, String.raw`\u2014`);
assert.strictEqual(parseNotebookJson(String.raw`{"value":"quote: \"x\"\nnext"}`).value, 'quote: "x"\nnext');
assert.strictEqual(escapeInvalidJsonBackslashes(legacy).includes(String.raw`\\[Alpha]`), true);
assert.throws(() => parseNotebookJson('{"cells": [}'));
console.log('notebook JSON compatibility tests: OK');
