'use strict';
const assert = require('assert');
const { withVscodeStub } = require('./_stub-vscode');
const { filterJournal } = withVscodeStub(() => require('../../tools/index'));

const journal = Array.from({ length: 12 }, (_, i) => ({
    operation_id: String(i), tool: i % 2 ? 'wolfbook_runCell' : 'wolfbook_editCell',
    state: i < 3 ? 'failed' : 'completed', caption: i === 1 ? 'Residual Check' : 'work',
    notebook: i % 2 ? '/tmp/A.wb' : '/tmp/B.wb'
}));
const failed = filterJournal(journal, { state: 'failed' });
assert.strictEqual(failed.length, 3);
assert.strictEqual(failed.slice(0, 2).length, 2, 'limit is applied after filtering');
assert.strictEqual(filterJournal(journal, { tool: 'RUNcell', notebook: 'a.wb' }).length, 6);
assert.strictEqual(filterJournal(journal, { caption_contains: 'residual' }).length, 1);

// The transport injects the session target's notebook into args as ROUTING
// convenience and marks it _notebookInjected. That injection must NOT become a
// journal filter — it silently hid other notebooks' ops (live-found 2026-08-19:
// a no-filter call reported "matched 4 of 10").
const { _journalFilters } = require('../../tools/index');
assert.strictEqual(_journalFilters({ notebook: 'A.wb', _notebookInjected: true }).notebook, undefined,
    'injected notebook must not filter');
assert.strictEqual(_journalFilters({ notebook: 'A.wb' }).notebook, 'A.wb',
    'explicit notebook still filters');

console.log('journal-filter tests: OK');
