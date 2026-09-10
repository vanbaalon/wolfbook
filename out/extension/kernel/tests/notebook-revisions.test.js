'use strict';
const assert = require('assert');
const { seedNotebook, recordNotebookRevision, changedSince, forgetNotebook } = require('../../monitor/notebook-revisions');
const { beginMutationIntent, endMutationIntent, findMutationIntent } = require('../../monitor/mutation-intent');

const doc = { version: 3, uri: { fsPath: '/tmp/revisions.wb' } };
seedNotebook(doc);
doc.version = 4; recordNotebookRevision(doc, ['c1']);
doc.version = 5; recordNotebookRevision(doc, ['c2', 'c1']);
assert.deepStrictEqual(changedSince(doc, 3).cellIds.sort(), ['c1', 'c2']);
assert.deepStrictEqual(changedSince(doc, 5).cellIds, []);
forgetNotebook(doc);
assert.strictEqual(changedSince(doc, 4).available, false);

const intent = beginMutationIntent({ notebook: '/TMP/Revisions.wb', operationId: 'op-1',
    agentSessionId: 'session-1', agentName: 'Codex', tool: 'wolfbook_editCell' });
assert.strictEqual(findMutationIntent('/tmp/revisions.wb').operationId, 'op-1');
assert.strictEqual(findMutationIntent('/tmp/revisions.wb').tool, 'wolfbook_editCell');
endMutationIntent(intent);

console.log('notebook revision/intent tests: OK');
