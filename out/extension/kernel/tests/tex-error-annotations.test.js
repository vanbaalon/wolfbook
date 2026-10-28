const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const { currentErrors, errorAnnotations } = require('../../tex/errorAnnotations');
const { makeVscodeStub } = require('./_stub-vscode');
const oldLoad = Module._load;
const stub = makeVscodeStub();
Module._load = function (name, ...rest) { return name === 'vscode' ? stub : oldLoad.call(this, name, ...rest); };
const { TexViewer } = require('../../tex/texViewer');
Module._load = oldLoad;
const root = '/project/main.tex';
const error = { severity:'error', file:'chapters/one.tex', line:42, message:'Argument of \\math@egroup has an extra }.' };
const row = { page:2, x:108, y:330, w:180, h:12 };
function state(list = [error]) {
    return { root, sourceRevision:3, sourceAhead:false,
        compileDiagnostics:{ revision:3, at:100, sequence:1, list } };
}
function map(hash = 'shown') {
    return { generation:{ pdfHash:hash }, sourceToRender(file, line) {
        assert.equal(file, '/project/chapters/one.tex'); assert.equal(line, 42);
        return { exact:true, matchedLine:line, boxes:[{ page:row.page,
            xBp:row.x, yTopBp:row.y, wBp:row.w, hBp:row.h }] };
    } };
}

test('ordinary compiler errors map to their included file and line; duplicate messages group at one anchor', () => {
    const s = state([error, error, { ...error, message:'Missing $ inserted.' }, { ...error, severity:'warning' }]);
    const items = errorAnnotations(s, { root, map:map() });
    assert.equal(items.length, 1);
    assert.equal(items[0].file, '/project/chapters/one.tex');
    assert.equal(items[0].line, 42);
    assert.equal(items[0].exact, true);
    assert.deepEqual(items[0].rects, [row]);
    assert.deepEqual(items[0].messages, [error.message, 'Missing $ inserted.']);
});

test('a recovered preview clears full-build errors even when it finishes in the same millisecond', () => {
    const s = state();
    s.liveDiagnostics = { revision:3, at:100, sequence:2, list:[] };
    assert.deepEqual(currentErrors(s), []);
    s.compileDiagnostics = { revision:3, at:100, sequence:3, list:[error] };
    assert.deepEqual(currentErrors(s), [error]);
    s.sourceRevision++; s.sourceAhead = true;
    assert.deepEqual(currentErrors(s), [], 'old errors do not claim to describe newly typed text');
});

test('a failed live build can annotate the retained PDF without pretending its position is exact', () => {
    const s = state(); s.sourceAhead = true;
    s.liveDiagnostics = { revision:3, at:110, sequence:2, list:[error] };
    const [item] = errorAnnotations(s, { root, map:map() });
    assert.equal(item.page, 2);
    assert.equal(item.exact, false);
    assert.deepEqual(item.rects, [row]);
});

test('errors without a mapped line remain visible with their full text and no invented geometry', () => {
    const [item] = errorAnnotations(state([{ severity:'error', message:'Emergency stop.', line:null }]), { root });
    assert.equal(item.file, root); assert.equal(item.line, null); assert.equal(item.page, null);
    assert.deepEqual(item.rects, []); assert.equal(item.exact, false);
    assert.deepEqual(item.messages, ['Emergency stop.']);
});

test('a current displayed live map takes precedence; an unrelated live page never supplies a position', () => {
    const s = state(); s.sourceAhead = true;
    const liveRow = { ...row, y:380 };
    const liveMap = { diagnosticLocation:() => ({ rects:[liveRow], exact:true, matchedLine:42 }) };
    assert.deepEqual(errorAnnotations(s, { root, map:map(), liveMap, livePage:() => true })[0].rects, [liveRow]);
    assert.equal(errorAnnotations(s, { root, map:map(), liveMap, livePage:() => true })[0].exact, true);
    assert.deepEqual(errorAnnotations(s, { root, map:map(), liveMap, livePage:() => false })[0].rects, [row]);
});

test('viewer retains the map paired with the displayed PDF through repeated failures and replaces it on handoff', () => {
    const s = state(); s.map = map(); s.generation = { pdfHash:'shown' };
    const viewer = new TexViewer({}, { roots:new Map([[root, s]]) }, {});
    viewer.panel = {}; viewer.root = root; viewer._openedPdfHash = 'shown';
    const posted = []; viewer._post = msg => posted.push(msg);
    viewer._postErrorAnnotations(s);
    assert.equal(posted.at(-1).type, 'errorAnnotations');
    assert.deepEqual(posted.at(-1).items[0].rects, [row]);
    assert.equal(posted.at(-1).items[0].exact, true);
    s.generation = { pdfHash:'in-flight' };
    viewer._postErrorAnnotations(s);
    assert.equal(posted.at(-1).items[0].exact, false, 'a newer PDF not yet displayed cannot make old geometry exact');
    for (let i = 0; i < 2; i++) {
        s.map = map('failed'); s.prevMap = null; s.sourceAhead = true;
        viewer._postErrorAnnotations(s);
        assert.deepEqual(posted.at(-1).items[0].rects, [row]);
        assert.equal(posted.at(-1).items[0].exact, false);
    }
    viewer._openedPdfHash = 'replacement';
    viewer._postErrorAnnotations(s);
    assert.deepEqual(posted.at(-1).items[0].rects, [], 'old PDF coordinates are dropped on handoff');
    s.liveDiagnostics = { revision:3, sequence:2, at:110, list:[] };
    viewer._postErrorAnnotations(s);
    assert.deepEqual(posted.at(-1).items, []);
});

let hasLatexmk = true;
try { execFileSync('latexmk', ['--version'], { stdio:'ignore' }); } catch (_) { hasLatexmk = false; }
test('real conventional TeX errors use the actual SyncTeX location on the second page', { skip:!hasLatexmk }, async () => {
    const { compile } = require('../../tex/compileService');
    const { RenderMap } = require('../../tex/renderMap');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-error-position-'));
    const paper = path.join(directory, 'paper.tex');
    try {
        fs.writeFileSync(paper, '\\documentclass{article}\n\\begin{document}\nFirst page.\n\\clearpage\nSecond page.\n\\undefinedWolfbookError Here is the failing source line.\n\\end{document}\n');
        const gen = await compile({ root:paper, sourceFiles:[paper], timeoutMs:30000, engine:'pdflatex', maxPasses:1 });
        assert.ok(gen.errors > 0, 'the malformed fixture produces a compiler error');
        assert.ok(gen.pdfPath, 'best-effort PDF exists');
        const renderMap = new RenderMap({ generation:gen });
        const items = errorAnnotations({ generation:gen }, { root:paper, map:renderMap });
        const item = items.find(d => d.line === 6);
        assert.ok(item, 'the log identifies the actual failing line');
        assert.equal(item.file, paper);
        assert.equal(item.page, 2);
        assert.ok(item.rects.length > 0, 'the error has actual page geometry');
        assert.ok(item.messages.some(m => /Undefined control sequence/.test(m)));
    } finally { fs.rmSync(directory, { recursive:true, force:true }); }
});
