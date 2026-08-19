'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.resolve(root, '../../package.json'), 'utf8'));
const tools = fs.readFileSync(path.join(root, 'tools/index.js'), 'utf8');
const checkout = fs.readFileSync(path.join(root, 'execution/checkout.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'claude-mcp/server.js'), 'utf8');

const schemas = new Map(pkg.contributes.languageModelTools.map(tool => [tool.name, tool.inputSchema]));
for (const name of [
    'wolfbook_evaluateExpression', 'wolfbook_insertCells', 'wolfbook_editCell',
    'wolfbook_runCell', 'wolfbook_runCells'
]) {
    const mode = schemas.get(name)?.properties?.wait_mode;
    assert(mode, `${name} must expose wait_mode`);
    assert.deepStrictEqual(mode.enum, ['up_to_timeout', 'async']);
    assert(schemas.get(name)?.properties?.caption, `${name} must expose caption`);
}

assert(tools.includes("options?.input?.wait_mode === 'async'"));
assert(tools.includes('id: options?.input?._operationId'));
assert(checkout.includes("appendProgress(_cellOperationId, 'print'"));
assert(checkout.includes("appendProgress(_cellOperationId, 'message'"));
assert(server.includes('_invokeLocalOperationStatus(operationId, 0,'));
// kernel_id must survive the operationStatus fast-path (feedback 2026-08-18 §3.2).
assert(server.includes("String(args.kernel_id || '').trim() || undefined"));
assert(server.includes("if (name === 'wolfbook_operationStatus')"));
assert(/arguments:\s*\{[\s\S]{0,160}\.{3}\(params\?\.arguments \|\| \{\}\),\s*_operationId: operationId/.test(server));
assert.strictEqual(/operation\.sessionId\s*!==\s*sessionId/.test(server), false);
assert.strictEqual(/_expireOperation[\s\S]{0,700}(abort|interrupt)\s*\(/.test(server), false);

console.log('phase 2 static guards: OK');
