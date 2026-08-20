// What repaints when a compile lands — and what it must NOT depend on.
//
//   node out/extension/kernel/tests/tex-paint.test.js
//
// WHY THIS EXISTS. Every repaint used to sit behind
//
//     const ed = vscode.window.activeTextEditor;
//     if (!ed || !isTex(ed.document)) return;      // <- and refresh() came after
//
// `activeTextEditor` is `undefined` whenever focus is inside a webview — a fact
// this feature already relies on elsewhere, when deciding not to auto-hide the
// paper. So editing in the Page view's OWN mini-editor recompiled correctly and
// then discarded the result: the pages updated only once the reader clicked
// back into the text editor. Reported from real use, and invisible to every
// test that keeps an editor focused.
//
// The rule these assertions hold: the VIEWER is refreshed unconditionally;
// page markers and render diagnostics, which decorate a specific TextEditor,
// are the only things allowed to require one.

const assert = require('assert');
const Module = require('module');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String((e && e.message) || e).replace(/\n/g, '\n         ')); }
};

const { makeVscodeStub } = require('./_stub-vscode.js');
const stub = makeVscodeStub();
stub.window.activeTextEditor = undefined;
stub.window.createTextEditorDecorationType = () => ({ dispose() {} });
stub.window.createStatusBarItem = () => ({ show() {}, hide() {}, dispose() {} });
stub.languages = {
    ...(stub.languages || {}),
    createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }),
    registerDocumentSymbolProvider: () => ({ dispose() {} }),
    registerFoldingRangeProvider: () => ({ dispose() {} }),
    registerCodeLensProvider: () => ({ dispose() {} }),
};

const origLoad = Module._load;
Module._load = function (req, ...rest) {
    return req === 'vscode' ? stub : origLoad.call(this, req, ...rest);
};
const { makePaintRender } = require('../../tex/index.js');
Module._load = origLoad;

const TEX = { uri: { fsPath: '/paper/main.tex', scheme: 'file' } };
const NOT_TEX = { uri: { fsPath: '/paper/notes.md', scheme: 'file' } };

function harness() {
    const calls = { refresh: 0, status: 0, markers: 0, diags: 0 };
    const deps = {
        viewer: { refresh: () => { calls.refresh++; return Promise.resolve(); } },
        // Shaped like the real coordinator with nothing compiled yet: both
        // consumers return early rather than throwing, which is what lets this
        // suite tell "was skipped" apart from "threw on the way".
        coord: { stateFor: () => null, mapFor: () => null },
        projection: { get: () => ({ model: { objects: [] } }) },
        status: { update: () => { calls.status++; } },
        // Recorded through the collection, which is the only per-editor
        // consumer reachable without a real TextEditor.
        renderDiags: { set: () => { calls.diags++; } },
        pageMarkers: null,
    };
    return { calls, paint: makePaintRender(deps) };
}

test('THE BUG: the viewer refreshes with NO editor focused at all', () => {
    // This is the mini-editor case exactly: focus is in the webview, so VS Code
    // reports no active text editor.
    stub.window.activeTextEditor = undefined;
    const { calls, paint } = harness();
    paint();
    assert.strictEqual(calls.refresh, 1,
        'the pages must be pushed even though nothing is focused');
});

test('and with a NON-tex editor focused', () => {
    // Reading the paper beside a .bib, a terminal, a notebook: the paper is
    // still on screen and its compile still finished.
    stub.window.activeTextEditor = { document: NOT_TEX };
    const { calls, paint } = harness();
    paint();
    assert.strictEqual(calls.refresh, 1);
});

test('the status item updates in every case too', () => {
    stub.window.activeTextEditor = undefined;
    const a = harness(); a.paint();
    stub.window.activeTextEditor = { document: TEX };
    const b = harness(); b.paint();
    assert.strictEqual(a.calls.status, 1, 'no editor');
    assert.strictEqual(b.calls.status, 1, 'a .tex editor');
});

test('per-editor work is STILL skipped when there is no .tex editor', () => {
    // The guard was not wrong, only too wide. Diagnostics decorate a specific
    // document, so running them with no editor would be meaningless.
    stub.window.activeTextEditor = undefined;
    const { calls, paint } = harness();
    paint();
    assert.strictEqual(calls.diags, 0, 'no diagnostics without an editor');

    stub.window.activeTextEditor = { document: NOT_TEX };
    const b = harness();
    b.paint();
    assert.strictEqual(b.calls.diags, 0, 'and not for a non-tex one');
});

test('per-editor work DOES run for a focused .tex', () => {
    stub.window.activeTextEditor = { document: TEX };
    const { calls, paint } = harness();
    paint();
    assert.strictEqual(calls.diags, 1);
    assert.strictEqual(calls.refresh, 1, 'along with the viewer');
});

test('a throwing viewer never stops the rest of the paint', () => {
    stub.window.activeTextEditor = { document: TEX };
    const calls = { diags: 0 };
    const paint = makePaintRender({
        viewer: { refresh: () => { throw new Error('panel disposed'); } },
        coord: { stateFor: () => null, mapFor: () => null },
        projection: { get: () => ({ model: { objects: [] } }) },
        status: { update: () => {} },
        renderDiags: { set: () => { calls.diags++; } },
    });
    assert.doesNotThrow(paint);
    assert.strictEqual(calls.diags, 1, 'the editor work still happened');
});

test('a rejected refresh promise is swallowed, not left unhandled', () => {
    stub.window.activeTextEditor = undefined;
    const paint = makePaintRender({
        viewer: { refresh: () => Promise.reject(new Error('no generation')) },
        coord: { stateFor: () => null, mapFor: () => null },
        projection: { get: () => ({ model: { objects: [] } }) },
        status: { update: () => {} },
    });
    assert.doesNotThrow(paint);
});

test('it survives being handed nothing at all', () => {
    stub.window.activeTextEditor = undefined;
    assert.doesNotThrow(() => makePaintRender({})());
});

console.log('what repaints when a compile lands\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
