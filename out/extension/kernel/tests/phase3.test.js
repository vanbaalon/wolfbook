'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCommittedOutputs } = require('../../tools/cell-pipeline');

const item = (mime, value) => ({ mime, data: Buffer.from(value) });
const cell = { outputs: [
    { items: [item('text/plain', '42')] },
    { items: [
        item('x-application/wolfram-language-html', '<span></span>'),
        item('text/plain', 'Power::infy: Infinite expression'),
        item('application/vnd.code.notebook.error', '{}'),
    ] },
] };
const committed = readCommittedOutputs(cell);
assert.deepStrictEqual(committed.outputs, ['42']);
assert.deepStrictEqual(committed.messages, ['Power::infy: Infinite expression']);
assert.strictEqual(committed.plain, '42\nPower::infy: Infinite expression');
assert.strictEqual(readCommittedOutputs({ outputs: [{ items: [item('text/plain', '$Failed')] }] }).failed, true);
assert.strictEqual(readCommittedOutputs({ outputs: [{ items: [item('text/plain', '$Aborted')] }] }).aborted, true);

const root = path.resolve(__dirname, '../..');
const tools = fs.readFileSync(path.join(root, 'tools/index.js'), 'utf8');
const checkout = fs.readFileSync(path.join(root, 'execution/checkout.js'), 'utf8');
const outputTools = fs.readFileSync(path.join(root, 'tools/wolfslide-tools.js'), 'utf8');
const pipelineCalls = tools.match(/runCellViaPipeline\(/g) || [];
assert(pipelineCalls.length >= 5, 'insert, batch edit, single edit, range run and single run share the pipeline');
assert.strictEqual(/(?:_ctrl|controller)\.execute\(\[notebook\.cellAt/.test(tools), false,
    'agent tools must not contain private duplicate notebook execution loops');
for (const state of ['never-run', 'running', 'success-with-output', 'success-Null',
    'completed-with-messages', 'failed', 'aborted', 'stale', 'unknown']) {
    assert(outputTools.includes(`'${state}'`) || checkout.includes(`'${state}'`), `missing state ${state}`);
}
assert(tools.includes('await notebook.save()'));
assert(tools.includes("fs.promises.readFile(filePath)"));
assert(tools.includes('mutationIdentityText'));
assert(checkout.includes("_terminalSymbol === '$Failed' || /\\$Failed/.test(_terminalTree)"));
assert(checkout.includes('!anyAborted && !anyFailed && !anyMessages'));

console.log('phase 3 pipeline/provenance tests: OK');
