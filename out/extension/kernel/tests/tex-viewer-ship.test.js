// The Page view's shipping decision: what actually crosses into the webview.
//
//   node out/extension/kernel/tests/tex-viewer-ship.test.js
//
// This EXECUTES TexViewer.refresh against a stubbed panel. The policy itself is
// unit-tested in tex-live.test.js; what is tested here is the wiring, because a
// handler with no executing test is a handler that can ship broken — this
// workstream has already paid for that lesson twice (a TDZ that killed every
// inverse click, and a repaint gated on activeTextEditor).
//
// The behaviour under test: a live rebuild that does not move the ink must NOT
// re-ship the PDF, re-parse it in pdf.js, repaint every canvas, re-sweep every
// text layer and drop every glyph alignment — to arrive at the pixels already
// on screen.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => Promise.resolve().then(fn)
    .then(() => { pass++; results.push('  ok   ' + name); })
    .catch((e) => { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); });

const EXT = path.resolve(__dirname, '..', '..', '..', '..');

const { makeVscodeStub } = require('./_stub-vscode.js');
const stub = makeVscodeStub();
stub.window.activeTextEditor = undefined;
stub.window.createWebviewPanel = () => { throw new Error('stub: not used'); };
const origLoad = Module._load;
Module._load = function (req, ...rest) {
    return req === 'vscode' ? stub : origLoad.call(this, req, ...rest);
};
const { TexViewer } = require('../../tex/texViewer.js');
Module._load = origLoad;

/** A viewer wired to a fake panel that records every message posted. */
function makeViewer(gen) {
    const posted = [];
    const root = gen.root;
    const coord = { roots: new Map([[root, { generation: gen, compiling: false }]]) };
    const v = new TexViewer({ extensionUri: { fsPath: EXT } }, coord, {});
    v.root = root;
    v.panel = {
        title: '',
        webview: {
            cspSource: 'vscode-resource:',
            asWebviewUri: (u) => ({ toString: () => `https://webview/${u.fsPath}` }),
            postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
        },
    };
    // Count the sync work the skip path is supposed to do INSTEAD of shipping.
    v._synced = 0;
    v.syncFromEditor = () => { v._synced++; };
    v._postEditAnchor = async () => {};
    return { v, posted, coord };
}

const opens = (posted) => posted.filter(m => m.type === 'open');

async function main() {
    // A real (tiny) PDF on disk: refresh() checks it exists and reads it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbship-'));
    const pdfPath = path.join(dir, 'p.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.5\n% a small but real file\n%%EOF\n');
    const baseGen = {
        root: path.join(dir, 'p.tex'),
        pdfPath, generation: 1, pageCount: 3, pdfHash: 'HASH-A', live: true,
    };

    await test('the first refresh always ships a document', async () => {
        const { v, posted } = makeViewer({ ...baseGen });
        await v.refresh();
        assert.strictEqual(opens(posted).length, 1, 'one open message');
        assert.strictEqual(v.shownGeneration, 1);
        assert.strictEqual(v.shownPdfHash, 'HASH-A');
    });

    await test('A REBUILD THAT DID NOT MOVE THE INK SHIPS NOTHING', async () => {
        const { v, posted, coord } = makeViewer({ ...baseGen });
        await v.refresh();
        assert.strictEqual(opens(posted).length, 1);

        // Typing a comment: a NEW generation, byte-identical output.
        coord.roots.get(v.root).generation = { ...baseGen, generation: 2, pdfHash: 'HASH-A' };
        await v.refresh();
        assert.strictEqual(opens(posted).length, 1, 'still exactly one open — nothing was re-shipped');
    });

    await test('and the reader still gets an answer: the map is re-consulted', async () => {
        const { v, coord } = makeViewer({ ...baseGen });
        await v.refresh();
        const before = v._synced;
        coord.roots.get(v.root).generation = { ...baseGen, generation: 2, pdfHash: 'HASH-A' };
        await v.refresh();
        assert.ok(v._synced > before,
            'the ink did not move but the SOURCE did, so the highlight is re-answered');
    });

    await test('THE SHOWN GENERATION DOES NOT ADVANCE ON A SKIP', async () => {
        // shownGeneration names the generation whose BYTES the webview holds.
        // _text.generation and _objMaps are keyed on it, so advancing it here
        // would invalidate every glyph alignment for nothing — which is the
        // exact cost this path exists to avoid.
        const { v, coord } = makeViewer({ ...baseGen });
        await v.refresh();
        coord.roots.get(v.root).generation = { ...baseGen, generation: 2, pdfHash: 'HASH-A' };
        await v.refresh();
        assert.strictEqual(v.shownGeneration, 1,
            'still naming the generation the webview actually holds');
    });

    await test('a rebuild that DID move the ink is shipped', async () => {
        const { v, posted, coord } = makeViewer({ ...baseGen });
        await v.refresh();
        coord.roots.get(v.root).generation = { ...baseGen, generation: 2, pdfHash: 'HASH-B' };
        await v.refresh();
        assert.strictEqual(opens(posted).length, 2, 'a second open message');
        assert.strictEqual(v.shownGeneration, 2);
        assert.strictEqual(v.shownPdfHash, 'HASH-B');
    });

    await test('force is the escape hatch, whatever the hashes say', async () => {
        // open(), rebuild() and adopt() all force. If a content hash ever lied,
        // one press of Compile is the way back.
        const { v, posted } = makeViewer({ ...baseGen });
        await v.refresh();
        await v.refresh();                       // skipped: same generation
        assert.strictEqual(opens(posted).length, 1);
        await v.refresh({ force: true });
        assert.strictEqual(opens(posted).length, 2, 'forced through');
    });

    await test('a generation with no content hash is shipped rather than guessed at', async () => {
        const { v, posted, coord } = makeViewer({ ...baseGen });
        await v.refresh();
        coord.roots.get(v.root).generation = { ...baseGen, generation: 2, pdfHash: null };
        await v.refresh();
        assert.strictEqual(opens(posted).length, 2);
    });

    await test('a missing PDF is reported, not skipped silently', async () => {
        const { v, posted, coord } = makeViewer({ ...baseGen });
        await v.refresh();
        coord.roots.get(v.root).generation = {
            ...baseGen, generation: 2, pdfHash: 'HASH-C', pdfPath: path.join(dir, 'gone.pdf'),
        };
        await v.refresh();
        assert.strictEqual(opens(posted).length, 1, 'nothing shipped');
        assert.ok(posted.some(m => m.type === 'status' && m.kind === 'err'), 'and the reader is told');
    });

    fs.rmSync(dir, { recursive: true, force: true });

    console.log('tex Page-view shipping\n');
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

main();
