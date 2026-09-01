'use strict';

// Re-running a cell that is ALREADY RUNNING.
//
//   node out/extension/kernel/tests/rerun-guard.test.js
//
// Reported: run a long cell, click it, Shift+Enter — it does not run and
// "finishes instantly".
//
// VS Code refuses to hand out a second NotebookCellExecution for a cell that
// already has one, and it refuses by THROWING. The guard in execute() only
// looked for a NOT-YET-STARTED queue item, so a running cell sailed past it
// into createNotebookCellExecution; the throw was re-raised out of
// executeHandler and the run ended looking like it had succeeded in no time.
//
// Two things are asserted here: the queue can tell "live" from "pending", and
// the controller consults the right one.

const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const { makeVscodeStub } = require('./_stub-vscode');
const nk = (() => {
    const orig = Module._load;
    Module._load = function (req, ...rest) {
        if (req === 'vscode') return makeVscodeStub();
        return orig.call(this, req, ...rest);
    };
    try { return require('../../notebook-kernel'); }
    finally { Module._load = orig; }
})();

/** The execution queue class, whatever it is exported as. */
const Queue = (() => {
    for (const v of Object.values(nk)) {
        if (typeof v === 'function' && v.prototype && typeof v.prototype.hasAnyForCell === 'function') return v;
    }
    return null;
})();

const cellA = { index: 0 };
const cellB = { index: 1 };
const exec = (cell) => ({ cell, start() {}, end() {} });

// ── the queue can tell live from pending ──────────────────────────────────

console.log('the queue');

t('the execution queue is reachable and has the new predicate', () => {
    assert.ok(Queue, 'no exported class with hasAnyForCell — the guard cannot be used');
});

t('a QUEUED cell is both pending and present', () => {
    const q = new Queue();
    q.push(exec(cellA));
    assert.strictEqual(q.hasPendingForCell(cellA), true);
    assert.strictEqual(q.hasAnyForCell(cellA), true);
});

t('a RUNNING cell is no longer pending, but IS still present', () => {
    // This is the whole bug: the old guard asked the first question and needed
    // the second.
    const q = new Queue();
    const id = q.push(exec(cellA));
    q.start(id);
    assert.strictEqual(q.hasPendingForCell(cellA), false, 'not pending — it has started');
    assert.strictEqual(q.hasAnyForCell(cellA), true, 'but very much still running');
});

t('a FINISHED cell is neither', () => {
    // end() removes the item, which is what makes presence mean "live".
    const q = new Queue();
    const id = q.push(exec(cellA));
    q.start(id);
    q.end(id, true);
    assert.strictEqual(q.hasAnyForCell(cellA), false, 'it must be runnable again');
    assert.strictEqual(q.hasPendingForCell(cellA), false);
});

t('another cell is unaffected', () => {
    const q = new Queue();
    q.start(q.push(exec(cellA)));
    assert.strictEqual(q.hasAnyForCell(cellB), false,
        'a running cell must not block every other cell');
});

t('two different cells can both be live', () => {
    const q = new Queue();
    q.push(exec(cellA));
    q.push(exec(cellB));
    assert.ok(q.hasAnyForCell(cellA) && q.hasAnyForCell(cellB));
});

// ── the controller consults it ────────────────────────────────────────────

console.log('the controller');

const CTRL = fs.readFileSync(path.join(__dirname, '..', '..', 'controller.js'), 'utf8');

t('execute() guards on hasAnyForCell, not only hasPendingForCell', () => {
    assert.ok(/hasAnyForCell\(cell\)/.test(CTRL),
        'the running case must be caught before createNotebookCellExecution');
    // The old predicate may remain to TELL the two cases apart, but it must not
    // be the gate on its own.
    const gates = CTRL.match(/if \(this\.executionQueue\.hasPendingForCell\(cell\)\) \{/g) || [];
    assert.strictEqual(gates.length, 0,
        'no path may still gate on hasPendingForCell alone');
});

t('a re-run of a running cell is reported, not silent', () => {
    // Silence here reads as "Shift+Enter did nothing", which is exactly how it
    // was reported.
    assert.ok(/already-running/.test(CTRL), 'the skip carries its own reason');
    assert.ok(/still running — interrupt it first to re-run/.test(CTRL),
        'and the reader is told, rather than left guessing');
});

t('a failure to create an execution never takes the batch down', () => {
    // Anything but "not associated" used to be re-thrown out of executeHandler,
    // so one bad cell aborted a whole Run All with no explanation.
    const i = CTRL.indexOf('const _createExecution');
    const body = CTRL.slice(i, i + 1600);
    assert.ok(!/\bthrow e;/.test(body), 'the throw must not escape');
    assert.ok(/return null;/.test(body), 'it degrades to "this cell was skipped"');
});

console.log(`\n${pass} assertions passed`);
