'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { makeVscodeStub } = require('./_stub-vscode');
const stub = makeVscodeStub(), original = Module._load;
let TexViewer;
try {
    Module._load = function(name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
    ({ TexViewer } = require('../../tex/texViewer'));
} finally { Module._load = original; }
async function main() {
    const messages = [];
    const v = Object.create(TexViewer.prototype);
    // A run-in heading has no SyncTeX row of its own. Never borrow the
    // preceding paragraph; source-aligned ink identifies just its words.
    const heading = { startLine: 3, endLine: 3, stableKey: 'heading' };
    const ink = [{ page: 1, x: 70, y: 200, w: 240, h: 10 }];
    v._textOf = () => 'Previous paragraph.\n\n\\paragraph{Step 3.}\n\nBody';
    v._lineInkRects = (_st, _doc, line) => line === 3 ? ink : [];
    v._modelFor2 = () => ({ objects: [heading] });
    const map = { available: true, exact: true, lineRows: () => [],
        objectAtLine: () => heading,
        objectRenderBoxes: () => ({ exact: false, rects: [{ page: 1, y: 100 }] }) };
    const compare = v._compareMap({ map }, '/paper.tex');
    assert.deepEqual(compare.rowsFor(3), ink);
    assert.deepEqual(compare.objectRects(heading), ink);
    v._lineInkRects = () => [];
    assert.deepEqual(compare.objectRects(heading), [], 'unmatched heading must not highlight its neighbour');
    delete v._lineInkRects;
    v.panel = {}; v.followMode = 'scroll'; v._post = m => messages.push(m);
    v._replayReviewFocus = () => true;
    const editor = { document: { uri: { fsPath: '/paper.tex' } }, selection: {
        anchor: { line: 10, character: 0 }, active: { line: 10, character: 0 } } };
    stub.window.activeTextEditor = editor;
    v.focusReviewHunk({ id: 'change-1' }, 1);
    assert(v._reviewNavigation); assert.equal(v._mayScroll(), false);
    assert.equal(messages.at(-1).owner, 'review');
    v.syncFromEditor(editor, { instant: true }); // would require coord if not suppressed
    assert(v._reviewNavigation, 'refresh of unchanged cursor cannot steal the view');
    v.syncFromEditor(editor, { userCursorGesture: true });
    assert(v._reviewNavigation, 'clicking the unchanged editor position does not resume following');
    editor.selection.active = { line: 11, character: 1 };
    v.syncFromEditor(editor);
    assert(v._reviewNavigation, 'unattributed automatic position adjustment is ignored');
    editor.selection.active = { line: 12, character: 1 };
    v.followMode = 'off'; v._rememberCursor = () => {};
    v.syncFromEditor(editor, { userCursorGesture: true });
    assert.equal(v._reviewNavigation, null);
    assert.equal(v._reviewFocus.pending, false, 'pending review replay cannot undo editor intent');
    assert.equal(messages.at(-1).owner, 'editor');
    v.followMode = 'scroll'; assert.equal(v._mayScroll(), true);
    v._claimViewerNavigation();
    assert.equal(v._mayScroll(), false);
    assert.equal(messages.at(-1).owner, 'viewer');
    v.syncFromEditor(editor, { instant: true });
    assert.equal(v._mayScroll(), false, 'background cursor replay must not undo manual scrolling');
    v._noteEditorNavigation(editor, true);
    assert.equal(v._mayScroll(), false, 'unchanged cursor does not resume following');
    editor.selection.active = { line: 15, character: 0 };
    v._noteEditorNavigation(editor, false);
    assert.equal(v._mayScroll(), false, 'passive replay cannot resume scrolling');
    v._noteEditorNavigation(editor, true);
    assert.equal(v._mayScroll(), true, 'real editor gesture resumes even after a passive replay of the same cursor');

    const client = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const start = client.indexOf('async function revealHighlight(');
    const end = client.indexOf('\n// --- interaction', start);
    let finish, scrolls = 0, paints = 0;
    const state = { navigationOwner: 'editor', navigationEpoch: 0, rendered: new Map(),
        highlight: { rects: [{ page: 2, x: 0, y: 0, w: 20, h: 20 }] } };
    const mainEl = { scrollTop: 0, clientHeight: 400, scrollTo: () => scrolls++ };
    const wrap = { offsetTop: 900, offsetHeight: 842 };
    const ctx = vm.createContext({ state, paintHighlight() { paints++; }, renderAround() {},
        renderPage: () => new Promise(r => { finish = r; }),
        document: { querySelector: s => s === 'main' ? mainEl : wrap },
        pagesEl: () => ({ querySelector: () => wrap }), rectToViewport: () => ({ y: 100, h: 20 }) });
    vm.runInContext(client.slice(start, end), ctx);
    const pending = ctx.revealHighlight();
    state.navigationOwner = 'review'; state.navigationEpoch++;
    state.rendered.set(2, {}); finish(); await pending;
    assert.equal(scrolls, 0, 'late cursor render cannot jump away from review');
    await ctx.revealHighlight(); assert.equal(scrolls, 0);
    state.navigationOwner = 'viewer';
    const beforePaint = paints;
    await ctx.revealHighlight(); assert.equal(scrolls, 0, 'manual scrolling also blocks cursor reveal');
    assert.equal(paints, beforePaint + 1, 'viewport ownership must not suppress caret painting');
    state.navigationOwner = 'editor'; state.edit = { id: 'mini' };
    const beforeMini = paints;
    for (let i = 0; i < 10; i++) await ctx.revealHighlight();
    assert.equal(paints, beforeMini + 10, 'every mini-editor caret movement repaints while the card stays open');
    assert.equal(scrolls, 0, 'painting the mini-editor caret must never move the paper');
    const edgeStart = client.indexOf('    const edge = async (anchor, side) => {');
    const edgeEnd = client.indexOf('\n    const from = await edge(', edgeStart);
    const edgeContext = vm.createContext({ wordInRows: () => { throw Error('exact source selection must not re-search PDF words'); } });
    vm.runInContext(client.slice(edgeStart, edgeEnd) + '\nglobalThis.resolveEdge = edge;', edgeContext);
    const exactEdge = { page: 2, x: 70, y: 200, h: 10 };
    const resolved = await edgeContext.resolveEdge({ exactEdge, word: '0', rects: [] }, 'start');
    assert.equal(resolved.x, 70); assert.equal(resolved.page, 2);
    // Actual PDF.js em boxes from the reported paragraph on page 10. The
    // accent raises the row; the '+' is lower and belongs to a separate row.
    const pdfItems = [
        ['An important operator for us is', 103.662, 84.24391, 151.47271, 10.90909],
        ['ˆ', 260.283, 81.42591, 5.454545, 10.90909],
        ['Q', 258.767, 84.24391, 8.48509, 10.90909],
        ['+', 267.252, 88.81989, 6.58650, 7.97011],
        [', defined through an integral kernel action as', 274.337, 84.24391, 215.01816, 10.90909],
        ['with', 83.338, 143.04591, 21.21818, 10.90909],
    ];
    for (const zoom of [1, 1.58, 2.5, 4]) {
        const nodes = [], page = { appendChild: n => nodes.push(n) };
        const context = vm.createContext({
            state: { rendered: new Map([[10, {}]]) },
            document: { querySelectorAll: () => [], createElement: () => ({ style: {} }) },
            pagesEl: () => ({ querySelector: () => page }), renderPage: async () => {},
            paintSelectionActions() {},
            textItems: async () => pdfItems.map(([str,x,y,w,h]) => ({str,x:x*zoom,y:y*zoom,w:w*zoom,h:h*zoom})),
            markToPx: m => ({ x:m.x*zoom, y:m.y*zoom, h:m.h*zoom }),
        });
        vm.runInContext(client.slice(client.indexOf('function inkRows('),
            client.indexOf('/**\n * WHAT TO DO WITH THE THING YOU JUST SELECTED.')), context);
        await context.paintSelection({ reveal:false, rows:[{page:10}],
            start:{exactEdge:{page:10,x:103.66,y:87.34,h:7.81}},
            end:{exactEdge:{page:10,x:104.55618,y:146.4,h:7.5}} });
        const bracket = nodes.find(n => n.className === 'selbrk start');
        assert.ok(bracket, 'selection paints a start bracket');
        assert.ok(Math.abs(parseFloat(bracket.style.left)/zoom-103.662)<0.02,
            `at zoom ${zoom} the start stays at An, never jumps to the subscript +`);
    }
    // A source selection ends at the r in a_r, BEFORE the third expression
    // on the same display line. Its low ink box must clip the baseline row.
    for (const zoom of [1, 1.58, 2.5, 4]) {
        const nodes = [], page = { appendChild: n => nodes.push(n) };
        const items = [
            {str:', t(u) = sum u a, third expression',x:100,y:10,w:300,h:12},
            {str:'r',x:213,y:18,w:7,h:8},
        ];
        const context = vm.createContext({
            state:{rendered:new Map([[1,{}]])},
            document:{querySelectorAll:()=>[],createElement:()=>({style:{}})},
            pagesEl:()=>({querySelector:()=>page}),renderPage:async()=>{},paintSelectionActions(){},
            textItems:async()=>items.map(r=>({...r,x:r.x*zoom,y:r.y*zoom,w:r.w*zoom,h:r.h*zoom})),
            markToPx:m=>({x:m.x*zoom,y:m.y*zoom,h:m.h*zoom}),
        });
        vm.runInContext(client.slice(client.indexOf('function inkRows('),
            client.indexOf('/**\n * WHAT TO DO WITH THE THING YOU JUST SELECTED.')),context);
        await context.paintSelection({reveal:false,rows:[{page:1}],
            start:{exactEdge:{page:1,x:100,y:12,h:8}},
            end:{exactEdge:{page:1,x:220,y:18,h:8}}});
        const fills=nodes.filter(n=>n.className==='selfill');
        assert.ok(fills.length);
        for(const n of fills) assert.ok((parseFloat(n.style.left)+parseFloat(n.style.width))/zoom<=220.001,
            `subscript endpoint clips every selection band at zoom ${zoom}, excluding the third expression`);
        assert.equal(parseFloat(nodes.find(n=>n.className==='selbrk end').style.left)/zoom,220);
    }
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8'));
    assert.ok(manifest.contributes.menus['editor/title/context'].some(m =>
        m.command === 'wolfbook.tex.copyFilePath' && m.when.includes('wolfbook.texViewer')));
    const index = fs.readFileSync(path.resolve(__dirname, '../../tex/index.js'), 'utf8');
    let copy, copied;
    const copyContext = vm.createContext({ viewer: {root:'/paper/current.tex'},
        reg: (_id, fn) => { copy=fn; }, vscode: {env:{clipboard:{writeText: async text => {copied=text;}}},
        window:{setStatusBarMessage(){},activeTextEditor:{document:{uri:{fsPath:'/unrelated.tex'}}}}} });
    vm.runInContext(index.slice(index.indexOf("    reg('wolfbook.tex.copyFilePath'"),
        index.indexOf("    reg('wolfbook.tex.openViewer'")), copyContext);
    await copy(); assert.equal(copied, '/paper/current.tex', 'copy uses viewer source, not an unrelated active editor');
    console.log('Review navigation, real PDF selection geometry, and copy-path menu: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
