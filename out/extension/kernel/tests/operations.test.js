'use strict';
const assert = require('assert');
const { OperationRegistry } = require('../operations');

(async () => {
    const r = new OperationRegistry({ maxOperations: 3, maxProgressBytes: 180, retrievalTtlMs: 5000 });
    const op = r.create({ tool: 'runCell', caption: ' long\nrun ' });
    r.start(op.id);
    for (let i = 0; i < 20; i++) r.appendProgress(op.id, 'print', `line-${i}-xxxxxxxx`);
    assert(r.get(op.id).progressBytes <= 180);
    const cell = r.beginCell(op.id, { notebook: '/tmp/a.wb', cellId: 'c1', source: '1+1' });
    assert.strictEqual(cell.status, 'running');
    const finished = r.finishCell(op.id, { cellId: 'c1', currentSource: '1+1', status: 'success-with-output', outputCount: 1, resultPreview: '2' });
    assert.strictEqual(finished.status, 'success-with-output');
    assert.strictEqual(finished.resultPreview, '2');
    assert.strictEqual(r.cellState('/tmp/a.wb', 'c1').operationId, op.id);
    const encoded = r.beginCell(op.id, { notebook: '/tmp/a.wb', cellId: 'abc==', source: 'Null' });
    assert(encoded);
    r.finishCell(op.id, { cellId: 'abc==', currentSource: 'Null', status: 'success-Null' });
    assert.strictEqual(r.cellState('/tmp/a.wb', 'abc%3D%3D').status, 'success-Null',
        'URI-encoded MCP CellIds resolve raw checkout provenance');
    const stale = r.beginCell(op.id, { notebook: '/tmp/a.wb', cellId: 'c2', source: 'old' });
    assert(stale);
    const staleFinished = r.finishCell(op.id, { cellId: 'c2', currentSource: 'new', resultPreview: 'detached result' });
    assert.strictEqual(staleFinished.status, 'stale');
    assert.strictEqual(staleFinished.resultPreview, 'detached result', 'stale output remains auditable in the journal');
    const pending = await r.wait(op.id, 5);
    assert.strictEqual(pending.settled, false);
    r.complete(op.id, '42');
    const done = await r.wait(op.id, 5);
    assert.strictEqual(done.operation.result, '42');
    assert.strictEqual(r.snapshot(op.id).state, 'completed');
    assert(r.snapshot(op.id).retrieval_expiry);

    let abortCalled = false;
    const expiring = r.create({ tool: 'runCell' });
    r.start(expiring.id);
    r.expire(expiring.id);
    assert.strictEqual(r.snapshot(expiring.id).state, 'expired');
    assert.strictEqual(abortCalled, false, 'registry expiry must never call an abort side effect');

    const bounded = new OperationRegistry({ maxOperations: 3 });
    const overflow = Array.from({ length: 4 }, () => bounded.create({ tool: 'runCell' }));
    assert.strictEqual(bounded._items.size, 4, 'active work is never discarded merely to satisfy the history cap');
    bounded.complete(overflow[0].id, 'done');
    assert.strictEqual(bounded._items.size, 3, 'settlement trims history back to its hard bound');
    r.invalidateAll('kernel restart');
    assert.strictEqual(r.hasRestarted, true);
    assert.strictEqual(r.cellState('/tmp/a.wb', 'c1'), null, 'restart degrades cell provenance to unknown');
    console.log('operation registry tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
