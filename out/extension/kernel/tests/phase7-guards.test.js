'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, '../../package.json'), 'utf8'));
const entries = new Map(pkg.contributes.languageModelTools.map(tool => [tool.name, tool]));
for (const name of ['wolfbook_cancelOperation', 'wolfbook_exportSessionReport']) assert(entries.has(name), `${name} schema missing`);
assert(!(entries.get('wolfbook_exportSessionReport').tags || []).includes('mcp:hidden'));
assert(!('action' in entries.get('wolfbook_exportSessionReport').inputSchema.properties));
for (const name of ['wolfbook_evaluateExpression', 'wolfbook_insertCells', 'wolfbook_editCell']) {
    const props = entries.get(name).inputSchema.properties;
    assert(props.progress_symbol && props.progress_interval_ms, `${name} progress schema drift`);
}
assert(entries.get('wolfbook_getResult').inputSchema.properties.path);
assert(entries.get('wolfbook_kernelControl').inputSchema.properties.operation_id);
const source = fs.readFileSync(path.join(root, 'tools/index.js'), 'utf8');
const registered = [...source.matchAll(/\{ name: '([^']+)'\s*,\s*impl:/g)].map(match => match[1]);
const shadowInterceptors = new Set(['edit_notebook_file', 'run_notebook_cell', 'replace_string_in_file']);
for (const name of registered) if (!shadowInterceptors.has(name)) {
    assert(entries.has(name), `${name} is registered but absent from package.json`);
}
console.log('phase 7 schema/registration guards: OK');
