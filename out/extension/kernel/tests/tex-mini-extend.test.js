const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { makeVscodeStub } = require('./_stub-vscode');
const stub = makeVscodeStub();
class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
class Range { constructor(start, end) { Object.assign(this, { start, end }); } }
stub.Position = Position; stub.Range = Range;
stub.WorkspaceEdit = class { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push({ uri, range, text }); } };
const oldLoad = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? stub : oldLoad.call(this, name, ...args); };
const { TexViewer } = require('../../tex/texViewer');
Module._load = oldLoad;
const { scanTex } = require('../../tex/texScanner');
const { buildModel } = require('../../tex/texModel');
const { wireText } = require('../../tex/miniText');
const source = [ '\\documentclass{article}', '\\begin{document}',
    'First paragraph.', '', '% keep this comment',
    '\\paragraph{Middle title.}', 'Middle paragraph.', '',
    '\\begin{equation}', 'x=y', '\\end{equation}', '',
    'Last paragraph.', '\\end{document}' ];

function fixture(native, eol = '\n') {
    let text = source.join(eol), writes = 0;
    const file = '/project/paper.tex';
    const doc = { uri:{ fsPath:file }, version:1, eol:eol === '\r\n' ? 2 : 1,
        get lineCount() { return text.split(eol).length; },
        lineAt:n => ({ text:text.split(eol)[n] }),
        offsetAt(p) { const lines = text.split(eol); return lines.slice(0,p.line).reduce((a,s) => a+s.length+eol.length, 0) + p.character; },
        positionAt(offset) { const head = text.slice(0,offset).split(eol); return new Position(head.length - 1, head.at(-1).length); },
        getText(r) { return r ? text.slice(this.offsetAt(r.start), this.offsetAt(r.end)) : text; } };
    stub.workspace.openTextDocument = async () => doc;
    const state = { map:{ native }, root:file };
    const viewer = new TexViewer({}, { roots:new Map([[file,state]]) }, {});
    viewer.root = file; viewer.panel = {};
    const messages = []; viewer._post = m => messages.push(m);
    viewer._rememberEditState = () => {};
    viewer._modelFor = () => buildModel(scanTex(text, { file }), { file });
    viewer._onEditCaret = async () => {};
    viewer._applyReaderEdit = async (_, we) => {
        writes++;
        for (const op of we.ops) {
            const offset = doc.offsetAt(op.range.start), end = doc.offsetAt(op.range.end);
            text = text.slice(0,offset) + op.text + text.slice(end); doc.version++;
            viewer._onEditDocChange({ document:doc, contentChanges:[{ rangeOffset:offset, rangeLength:end-offset, text:op.text }] });
        }
        return true;
    };
    const startOffset = doc.offsetAt(new Position(5,0)), endOffset = doc.offsetAt(new Position(6,source[6].length));
    const session = { id:1, native, file, startOffset, endOffset, lastText:text.slice(startOffset,endOffset), label:'paragraph' };
    viewer._edit = session;
    const extend = async (delta, requestId = messages.length + 1) => {
        await viewer._extendEditSession({ editId:session.id, requestId, delta, text:wireText(session.lastText) });
        return messages.at(-1);
    };
    return { viewer, doc, session, messages, extend, get writes() { return writes; },
        external(next) { text = next; } };
}

for (const native of [false,true]) for (const eol of ['\n','\r\n']) {
    test(`${native ? 'Pro' : 'ordinary'} ${eol.length === 2 ? 'CRLF' : 'LF'} extends down and up in place, retaining intervening source and edit ownership`, async () => {
        const f = fixture(native,eol), before = f.doc.getText(), id = f.session.id;
        const down = await f.extend(1);
        assert.equal(down.type, 'editExtended'); assert.equal(down.added, true);
        assert.equal(down.prefix, ''); assert.equal(down.suffix, '\n\n\\begin{equation}\nx=y\n\\end{equation}');
        assert.equal(down.text.slice(down.caret), '\\begin{equation}\nx=y\n\\end{equation}');
        assert.equal(f.viewer._edit, f.session); assert.equal(f.session.id, id);
        const up = await f.extend(-1);
        assert.equal(up.added, true);
        assert.equal(up.prefix, 'First paragraph.\n\n% keep this comment\n');
        assert.equal(up.caret, 'First paragraph.'.length);
        assert.equal(f.doc.getText(), before); assert.equal(f.writes, 0, 'widening reads the source without rewriting or compiling');
        const extended = f.session.lastText;
        await f.viewer._applyEditChange({ editId:id, text:wireText(extended) + '!', beforeText:wireText(extended),
            operation:{ before:wireText(extended), start:wireText(extended).length, end:wireText(extended).length, text:'!' } });
        assert.equal(f.writes, 1);
        assert.ok(f.doc.getText().includes('\\end{equation}!'));
        assert.ok(f.doc.getText().includes('Last paragraph.'));
        if (eol.length === 2) assert.ok(!/(?<!\r)\n/.test(f.doc.getText()), 'expanded editing preserves CRLF');
    });
}

test('document boundaries stop growth without including the preamble, document wrappers or wrapping around', async () => {
    const f = fixture(false);
    await f.extend(-1);
    assert.equal((await f.extend(-1)).added, false);
    await f.extend(1); await f.extend(1);
    assert.equal((await f.extend(1)).added, false);
    assert.ok(!f.session.lastText.includes('\\begin{document}'));
    assert.ok(!f.session.lastText.includes('\\end{document}'));
    assert.equal(f.writes, 0);
});

test('extension waits for pending keystrokes before choosing the next block', async () => {
    const f = fixture(true);
    let release;
    f.viewer._editApplyQueue = new Promise(resolve => { release = resolve; });
    const pending = f.extend(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.messages.length, 0, 'no range change before the queued edit');
    release(); await pending;
    assert.equal(f.messages.at(-1).added, true);
});

test('a stale session or a conflict cannot extend over another source edit', async () => {
    const f = fixture(false), range = [f.session.startOffset,f.session.endOffset];
    await f.viewer._extendEditSession({ editId:2, requestId:1, delta:1, text:wireText(f.session.lastText) });
    assert.equal(f.messages.length, 0);
    f.external(f.doc.getText().replace('Middle paragraph.', 'External paragraph.'));
    await f.extend(1);
    assert.equal(f.messages.at(-1).added, false);
    assert.equal(f.session.conflict, true);
    assert.deepEqual([f.session.startOffset,f.session.endOffset], range);
    assert.equal(f.writes, 0);
});


test('cell starts follow semantic blocks, keeping paragraph titles with prose across LF and CRLF', async () => {
    for (const native of [false,true]) for (const eol of ['\n','\r\n']) {
        const f = fixture(native,eol);
        assert.deepEqual(f.viewer._editCellStarts(f.doc,f.session), [0]);
        const down = await f.extend(1);
        assert.deepEqual(down.cellStarts, [0, down.caret]);
        const up = await f.extend(-1);
        const title = up.text.indexOf('\\paragraph'), equation = up.text.indexOf('\\begin{equation}');
        assert.deepEqual(up.cellStarts, [0, title, equation]);
        assert.ok(!up.cellStarts.includes(up.text.indexOf('Middle paragraph.')), 'title and body share a cell');
        assert.equal(f.writes,0);
        const edited = up.text.replace('First paragraph.', 'First paragraph.\nMore text.');
        await f.viewer._applyEditChange({ editId:1, text:edited, beforeText:up.text });
        assert.deepEqual(f.viewer._editCellStarts(f.doc,f.session), [0, title + 11, equation + 11]);
    }
});

test('paper cell edges use both maps, are cached and disappear when the source is ahead', () => {
    for (const native of [false,true]) {
        const f = fixture(native);
        f.viewer.shownGeneration = f.viewer._openedGeneration = 7;
        const model = f.viewer._modelFor(f.doc);
        const st = { map:{ native, available:true }, generation:{ generation:7 } };
        f.viewer._projectModels = () => new Map([['/project/paper.tex',model]]);
        const models = f.viewer._projectModels();
        f.viewer._projectModels = () => models;
        f.viewer._textOf = () => f.doc.getText();
        let reads = 0;
        f.viewer.objectRects = (_file,a,b) => {
            reads++;
            return [{ page:1,x:72,y:a*20,w:400,h:(b-a)*20+10 }];
        };
        const edges = f.viewer._paperCellBoundaries(st);
        assert.equal(edges.length,8, 'four blocks, with one edge at each end');
        assert.ok(edges.some(r => r.y === 6*20-2), 'paragraph heading starts its cell');
        assert.ok(edges.some(r => r.y === 7*20+12), 'the paragraph cell ends after its prose');
        assert.ok(!edges.some(r => r.y === 7*20-2), 'no false cell boundary between the run-in title and prose');
        const count = reads;
        assert.equal(f.viewer._paperCellBoundaries(st),edges);
        assert.equal(reads,count,'holding Shift does not remeasure blocks');
        st.sourceAhead = true;
        assert.deepEqual(f.viewer._paperCellBoundaries(st),[]);
        st.sourceAhead = false; st.map.available = false;
        assert.deepEqual(f.viewer._paperCellBoundaries(st),[]);
        assert.equal(f.writes,0);
    }
});
