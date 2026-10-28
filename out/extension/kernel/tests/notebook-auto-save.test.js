'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeVscodeStub, withVscodeStub } = require('./_stub-vscode');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-auto-save-'));
    const warnings = [], log = [];
    const stub = makeVscodeStub({ window: {
        showNotebookDocument: () => { throw new Error('automatic saving must not open a tab'); },
        showWarningMessage: message => { warnings.push(message); },
    } });
    const { saveAfterCleanCell } = withVscodeStub(() => require('../../execution/auto-save'), stub);
    function fixture(filename = 'clean.wb') {
        let source = '2+2';
        const notebook = {
            uri: { fsPath: path.join(root, filename), scheme: 'file' }, metadata: {},
            isDirty: true, isClosed: false, isUntitled: false,
            cellAt: index => { if (index !== 0) throw new Error('cell removed'); return cell; },
            saves: 0,
            save: async () => {
                notebook.saves++;
                fs.writeFileSync(notebook.uri.fsPath, JSON.stringify({
                    cells: [{ value: source, outputs: cell.outputs }], metadata: notebook.metadata,
                }));
                notebook.isDirty = false;
                return true;
            },
        };
        const cell = { notebook, index: 0, kind: stub.NotebookCellKind.Code,
            document: { uri: { toString: () => `cell://${notebook.uri.fsPath}#0` }, getText: () => source },
            outputs: [{ items: [{ mime: 'text/plain', data: '4' }] }],
        };
        return { notebook, cell, setSource: value => { source = value; } };
    }
    try {
        const f = fixture();
        assert.deepStrictEqual(await saveAfterCleanCell(f.cell, { source: '2+2' }), { saved: true });
        const disk = JSON.parse(fs.readFileSync(f.notebook.uri.fsPath, 'utf8'));
        assert.strictEqual(disk.cells[0].value, '2+2');
        assert.strictEqual(disk.cells[0].outputs[0].items[0].data, '4', 'persist the completed output alongside source');
        assert.strictEqual(f.notebook.isDirty, false);
        assert.strictEqual((await saveAfterCleanCell(f.cell, { source: '2+2' })).reason, 'already-saved');
        assert.strictEqual(f.notebook.saves, 1);

        const definition = fixture('definition.wb');
        definition.setSource('f[x_] := x^2'); definition.cell.outputs = [];
        assert.strictEqual((await saveAfterCleanCell(definition.cell, { source: 'f[x_] := x^2' })).saved, true,
            'successful definition/Null cells also save');
        for (const flag of ['aborted', 'failed', 'hasMessages', 'stale']) {
            const bad = fixture(`${flag}.wb`);
            assert.strictEqual((await saveAfterCleanCell(bad.cell, { source: '2+2', [flag]: true })).saved, false);
            assert.strictEqual(bad.notebook.saves, 0, `${flag} must never trigger a save`);
        }
        const edited = fixture('edited.wb');
        edited.setSource('new edit');
        assert.strictEqual((await saveAfterCleanCell(edited.cell, { source: '2+2' })).reason, 'stale');
        assert.strictEqual(edited.notebook.saves, 0);
        const lateEdit = fixture('late-edit.wb');
        const pending = saveAfterCleanCell(lateEdit.cell, { source: '2+2' });
        lateEdit.setSource('edit while execution.end() is being flushed');
        assert.strictEqual((await pending).reason, 'stale', 're-check source after asynchronous save setup');
        assert.strictEqual(lateEdit.notebook.saves, 0);

        for (const [label, mutate] of [
            ['untitled', f => { f.notebook.isUntitled = true; }],
            ['closed', f => { f.notebook.isClosed = true; }],
            ['imported', f => { f.notebook.metadata.wolfbookNbImport = {}; }],
            ['markdown', f => { f.cell.kind = stub.NotebookCellKind.Markup; }],
            ['deleted', f => { f.notebook.cellAt = () => { throw new Error('removed'); }; }],
        ]) {
            const skipped = fixture(`${label}.wb`); mutate(skipped);
            assert.strictEqual((await saveAfterCleanCell(skipped.cell, { source: '2+2' })).saved, false);
            assert.strictEqual(skipped.notebook.saves, 0);
        }
        const native = fixture('original.nb');
        assert.strictEqual((await saveAfterCleanCell(native.cell, { source: '2+2' })).reason, 'unsupported');
        assert.strictEqual(native.notebook.saves, 0, 'never overwrite imported Mathematica .nb files');

        // Consecutive clean completions during a save must not overlap disk
        // writes, and the later cell's new output must get its own snapshot.
        const concurrent = fixture('concurrent.wb');
        let releaseFirst, firstStarted;
        const started = new Promise(resolve => { firstStarted = resolve; });
        const gate = new Promise(resolve => { releaseFirst = resolve; });
        let activeSaves = 0, saveCount = 0;
        const snapshots = [];
        concurrent.notebook.save = async () => {
            assert.strictEqual(activeSaves++, 0, 'saves of a single document are serialized');
            saveCount++;
            snapshots.push(concurrent.cell.outputs[0].items[0].data);
            if (saveCount === 1) { firstStarted(); await gate; }
            activeSaves--;
            return true;
        };
        const first = saveAfterCleanCell(concurrent.cell, { source: '2+2' });
        await started;
        concurrent.cell.outputs[0].items[0].data = 'later output';
        const second = saveAfterCleanCell(concurrent.cell, { source: '2+2' });
        releaseFirst();
        assert((await first).saved); assert((await second).saved);
        assert.deepStrictEqual(snapshots, ['4', 'later output']);

        const failure = fixture('cannot-save.wb');
        failure.notebook.save = async () => { throw new Error('disk full'); };
        assert.strictEqual((await saveAfterCleanCell(failure.cell, { source: '2+2' }, m => log.push(m))).reason, 'save-failed');
        assert.strictEqual((await saveAfterCleanCell(failure.cell, { source: '2+2' })).reason, 'save-failed');
        assert.strictEqual(warnings.length, 1, 'a repeated save failure shows one nonmodal warning');
        assert.match(warnings[0], /cannot-save\.wb: disk full/);
        assert.match(log[0], /autosave/);
        assert.strictEqual(failure.notebook.isDirty, true, 'failed saves leave the document dirty');
        failure.notebook.save = async () => true;
        assert.strictEqual((await saveAfterCleanCell(failure.cell, { source: '2+2' })).saved, true,
            'a save failure does not poison future clean completions');
        const refused = fixture('refused.wb');
        refused.notebook.save = async () => false;
        assert.strictEqual((await saveAfterCleanCell(refused.cell, { source: '2+2' })).reason, 'save-failed');

        // Execute the actual checkout completion block with mocked kernel flags,
        // rather than duplicating its call-site gating in this test.
        const checkout = fs.readFileSync(path.join(__dirname, '../../execution/checkout.js'), 'utf8');
        const start = checkout.indexOf('        const _cellResultPreview =');
        const end = checkout.indexOf('        self._evalDispatched = false;', start);
        assert(start > 0 && end > start);
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const complete = new AsyncFunction('ctx', `const { self, currentExecution, code,
            anyAborted, anyFailed, anyMessages, msgTexts, _cellOperationId, _cellToolId,
            _operationOutputPreview, saveAfterCleanCell } = ctx;\n` + checkout.slice(start, end));
        for (const scenario of ['clean', 'failed', 'aborted', 'messages', 'stale', 'cancelled', 'source-edited']) {
            const f = fixture(`checkout-${scenario}.wb`);
            const ends = [];
            const actualSave = f.notebook.save;
            f.notebook.save = async () => {
                assert.strictEqual(ends.length, 1, 'save only after execution.end()');
                return actualSave();
            };
            if (scenario === 'source-edited') f.setSource('new source');
            await complete({
                self: { isAborting: false, writeDebugLog() {},
                    executionQueue: { end: (id, clean) => ends.push({ id, clean }) },
                    operations: { finishCell: () => ({ status: scenario === 'stale' ? 'stale' : 'success-with-output' }) },
                },
                currentExecution: { id: 'e1', hasOutput: true, execution: { cell: f.cell,
                    token: { isCancellationRequested: scenario === 'cancelled' },
                    replaceOutput: async () => { f.cell.outputs = []; },
                } },
                code: '2+2', anyFailed: scenario === 'failed', anyAborted: scenario === 'aborted',
                anyMessages: scenario === 'messages', msgTexts: scenario === 'messages' ? ['warning'] : [],
                _cellOperationId: 'op1', _cellToolId: 'cell1',
                _operationOutputPreview: () => scenario === 'failed' ? '$Failed' : scenario === 'aborted' ? '$Aborted' : '4',
                saveAfterCleanCell,
            });
            assert.strictEqual(f.notebook.saves, scenario === 'clean' ? 1 : 0, `${scenario}: real checkout save gating`);
        }
        console.log('notebook auto-save: clean source/output persistence, failure/staleness guards, serialized saves, checkout integration passed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
