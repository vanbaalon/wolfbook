'use strict';
const assert = require('assert');
const { withVscodeStub } = require('./_stub-vscode');
const { OperationRegistry } = require('../operations');
const { CancelOperationTool } = withVscodeStub(() => require('../../tools/index'));

const text = result => result.content[0].value;
async function make(result, mode = 'abort') {
    const operations = new OperationRegistry();
    const op = operations.create({ id: 'op-test', kernelId: 'k-1' });
    operations.start(op.id);
    let abortCalls = 0;
    const controller = { operations, kernelIdentity: { kernel_id: 'k-1' },
        arbiter: { abort: async () => { abortCalls++; return result; } } };
    const getController = () => controller;
    getController.manager = { findControllerByOperation: id => id === op.id ? controller : null };
    const response = await new CancelOperationTool(getController).invoke({ input: { operation_id: op.id, mode } });
    return { operations, abortCalls, payload: JSON.parse(text(response)), tool: new CancelOperationTool(getController) };
}

(async () => {
    const queued = await make({ aborted: true });
    assert.strictEqual(queued.operations.get('op-test').state, 'aborted');
    assert.strictEqual(queued.payload.registry_state, 'aborted');
    const discard = await make(null, 'discard-result');
    assert.strictEqual(discard.abortCalls, 0);
    assert.match(discard.payload.note, /kernel may still be computing/);
    const mismatch = await make({ aborted: false, reason: 'operation-mismatch' });
    assert.strictEqual(mismatch.operations.get('op-test').state, 'aborted');
    assert.match(mismatch.payload.note, /different operation/);
    const operations = new OperationRegistry();
    const op = operations.create({ id: 'op-done' });
    operations.start(op.id); operations.complete(op.id, 'done');
    let called = false;
    const controller = { operations, arbiter: { abort: async () => { called = true; } } };
    const getController = () => controller;
    getController.manager = { findControllerByOperation: () => controller };
    const noOp = await new CancelOperationTool(getController).invoke({ input: { operation_id: op.id } });
    assert.strictEqual(JSON.parse(text(noOp)).already, 'completed');
    assert.strictEqual(called, false);
    console.log('cancel-operation tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
