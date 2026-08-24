'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const controller = fs.readFileSync(path.join(root, 'controller.js'), 'utf8');
const cellReference = fs.readFileSync(path.join(root, 'editor/cell-reference.js'), 'utf8');
const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.resolve(root, '../../package.json'), 'utf8'));

assert(!controller.includes('createStatusBarItem(\n            "wolfram-eval-mode"'),
    'the unused WL: Auto status item must not return');
assert(!cellReference.includes('vscode.window.createStatusBarItem('),
    'cell-reference must not duplicate the active cell in the window status bar');
assert(cellReference.includes('new vscode.NotebookCellStatusBarItem('),
    'the compact in-cell Cell N reference must remain');
assert(extension.includes("'wolfbook-mcp-control-room'"));
assert(extension.includes("_mcpControlRoomItem.command = 'wolfbook.openActivityMonitor'"));
assert(pkg.contributes.commands.some(command => command.command === 'wolfbook.openActivityMonitor'
    && /MCP Control Room/.test(command.title)));

console.log('status bar layout: OK');
