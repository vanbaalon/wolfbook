'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { projectActivity } = require('../../monitor/activity-projection');
const event = (type, state, timestamp, payload = {}) => ({ eventId: String(timestamp), operationId: 'op', type, state, timestamp, payload });
const asyncWork = projectActivity([
    event('tool.started', 'running', 1, { input: { expression: 'x' } }),
    event('kernel.operation.started', 'running', 2),
    event('tool.completed', 'accepted', 3),
]);
assert.equal(asyncWork.activeOperations.length, 1);
assert.equal(projectActivity([
    event('tool.started', 'running', 1), event('notebook.saved', 'completed', 2),
    event('kernel.operation.started', 'running', 3),
]).activeOperations.length, 1);
assert.deepEqual(projectActivity([event('tool.completed', 'completed', 1, { input: { text: 'hello' } })]).operations[0].input, { text: 'hello' });
assert.equal(projectActivity([{ type: 'agent.initialized', timestamp: 1, agentSessionId: 'old' }], { sessions: [] }).summary.connectedAgents, 0);
const paper = projectActivity([event('tool.started', 'running', 1, { tool: 'paper_getSection', input: { file: '/tmp/paper.tex', selector: 'sec:methods' } })]).operations[0];
assert.equal(paper.notebook, '/tmp/paper.tex');
assert.equal(paper.selector, 'sec:methods');
const html = require('../../monitor/dashboard').renderDashboard();
new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);

// Run the real serializer with rendering/import dependencies isolated. No
// notebook or kernel is touched by these failure-path tests.
const context = { exports: {}, require: name => {
    if (name === './output/renderer') return {};
    if (name === './nb-import/index') return { isNbSource: () => false };
    if (name === './utils/notebook-json') return { parseNotebookJson: JSON.parse };
    return require(name);
} };
vm.runInNewContext(fs.readFileSync(require.resolve('../../serializer'), 'utf8'), context);
(async () => {
    const serializer = new context.exports.VSNBContentSerializer();
    await assert.rejects(serializer.deserializeNotebook(Buffer.from('invalid')), /Cannot read notebook/);
    await assert.rejects(serializer.serializeNotebook({ cells: [{ kind: 2, outputs: [{}] }] }), /Cannot save notebook/);
    const bytes = new TextEncoder().encode('42');
    const data = { cells: [{ kind: 2, executionSummary: { success: true }, outputs: [{ items: [{ mime: 'text/plain', data: bytes }] }] }] };
    await serializer.serializeNotebook(data);
    assert.strictEqual(data.cells[0].outputs[0].items[0].data, bytes);
    assert.equal(data.cells[0].executionSummary.success, true);
    console.log('control room and notebook preservation regressions: OK');
})().catch(error => { console.error(error); process.exit(1); });
