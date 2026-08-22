'use strict';

// A copied cell reference has to be ADDRESSABLE, not just descriptive.
//
// The cell id is the fragment of the vscode-notebook-cell URI, which is
// positional — cell 4 of every wolfbook notebook is `W3sZmlsZQ` — and the bare
// filename does not disambiguate either (this workspace holds 144 notebooks
// called clean.wb). The MCP tools route on client + notebook, so the reference
// must carry both plus the absolute path.

const assert = require('assert');
const { withVscodeStub } = require('./_stub-vscode');

const mod = withVscodeStub(() => require('../../editor/cell-reference'));
const { _formatReference, _formatAddressableReference } = mod;

function cell(fragment) {
    return { metadata: { toolId: fragment }, document: { uri: { toString: () => 'x#' + fragment } } };
}
function notebook(fsPath) {
    return { uri: { fsPath, path: fsPath } };
}

const c = cell('W3sZmlsZQ');
const nb = notebook('/w/quests/QG_GT14/charms/C01/clean.wb');

// The short form is unchanged — it is what the MCP transcript prints.
assert.strictEqual(_formatReference(3, c), 'Cell 4 (cellId: W3sZmlsZQ)');

const full = _formatAddressableReference(3, c, nb, 'VSCode[VSCodeWolframExtension]');
const [head, second] = full.split('\n');
assert.strictEqual(head, 'Cell 4 (cellId: W3sZmlsZQ) · clean.wb @ VSCode[VSCodeWolframExtension]');
assert.strictEqual(second, '/w/quests/QG_GT14/charms/C01/clean.wb',
    'the absolute path is what separates 144 notebooks named clean.wb');

// Identical ids in two different notebooks must produce different references:
// this is the collision the old format could not express.
const other = _formatAddressableReference(
    3, cell('W3sZmlsZQ'), notebook('/w/quests/Q18/Q18_summary.wb'), 'VSCode[VSCodeWolframExtension]');
assert.notStrictEqual(other, full, 'same cell id in two notebooks must not read alike');
assert.ok(other.startsWith('Cell 4 (cellId: W3sZmlsZQ) · Q18_summary.wb @'));

// The client id resolves late during activation, so an empty one must degrade
// rather than emit a dangling "@".
const noClient = _formatAddressableReference(3, c, nb, '');
assert.strictEqual(noClient.split('\n')[0], 'Cell 4 (cellId: W3sZmlsZQ) · clean.wb');
assert.ok(!noClient.includes('@'), 'no trailing @ when the client id is not known yet');

// An unsaved / path-less notebook still yields a usable one-line reference.
const noPath = _formatAddressableReference(3, c, { uri: {} }, 'VSCode[W]');
assert.strictEqual(noPath, 'Cell 4 (cellId: W3sZmlsZQ) @ VSCode[W]',
    'a missing notebook name must not leave a dangling separator');
assert.ok(!noPath.includes('\n'), 'nothing to put on a second line');

// Windows-style separators must not leak a drive path into the name.
assert.ok(_formatAddressableReference(0, c, notebook('C:\\nb\\demo.wb'), '')
    .startsWith('Cell 1 (cellId: W3sZmlsZQ) · demo.wb'));

console.log('cell-reference: ok');
