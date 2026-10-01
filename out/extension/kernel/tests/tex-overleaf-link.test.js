'use strict';

// A paper linked to an Overleaf project and edited in place, in real time
// (tex/overleafLink.js), against a model of Overleaf's real-time service
// (Socket.IO 0.9 framing, joinProjectResponse, joinDoc with UTF-8 lines in
// latin1, applyOtUpdate transformed as "left", otUpdateApplied) and a VS
// Code whose documents behave as real ones do where it matters: versions, an
// edit refused when the document changed after it was made, change events.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OverleafLink, changeOp, span, LINKS_KEY } = require('../../tex/overleafLink');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));

const { FakeOverleaf, blobHash } = require('../../tex/overleafFakeService.cjs');

/** VS Code, as far as the link uses it. Documents change versions; an edit made on an older version is refused. */
function fakeVscode({ answers = {} } = {}) {
    const docs = [];
    const handlers = [];
    const secrets = new Map();
    const state = new Map();
    const fire = (doc, changes) => { for (const h of handlers) h({ document: doc, contentChanges: changes }); };
    const makeDoc = (fsPath, text) => {
        const d = { uri: { fsPath }, text, version: 1, isClosed: false, isDirty: false, saved: 0,
            getText() { return this.text; }, positionAt(offset) { return { offset }; },
            async save() { fs.writeFileSync(fsPath, this.text); this.isDirty = false; this.saved++; return true; } };
        docs.push(d);
        return d;
    };
    class WorkspaceEdit {
        constructor() { this.edits = []; }
        replace(uri, range, text) {
            const d = docs.find(x => x.uri.fsPath === uri.fsPath);
            this.edits.push({ d, version: d.version, from: range.start.offset, to: range.end.offset, text });
        }
    }
    const selectionHandlers = [];
    const vscode = {
        WorkspaceEdit,
        Range: class { constructor(start, end) { this.start = start; this.end = end; } },
        workspace: {
            get textDocuments() { return docs; },
            onDidChangeTextDocument: (h) => { handlers.push(h); return { dispose() { handlers.splice(handlers.indexOf(h), 1); } }; },
            applyEdit: async (we) => {
                await settle(1); // the round trip to the editor
                for (const e of we.edits) if (e.d.version !== e.version) return false;
                for (const e of we.edits) {
                    const before = e.d.text;
                    e.d.text = before.slice(0, e.from) + e.text + before.slice(e.to);
                    e.d.version++; e.d.isDirty = true;
                    fire(e.d, [{ rangeOffset: e.from, rangeLength: e.to - e.from, text: e.text }]);
                }
                return true;
            },
        },
        window: {
            showInputBox: async (o) => answers.input?.(o),
            showQuickPick: async (items) => answers.pick ? answers.pick(items) : items[0],
            showWarningMessage: async (m, opts, ...items) => answers.warning ? answers.warning(m, items) : items[0],
            showInformationMessage: async (m) => { (answers.infos ||= []).push(m); },
            showErrorMessage: async () => undefined,
            showOpenDialog: async () => answers.folder ? [{ fsPath: answers.folder }] : undefined,
            onDidChangeTextEditorSelection: (h) => { selectionHandlers.push(h); return { dispose() {} }; },
        },
        Uri: { file: fsPath => ({ fsPath }) },
        RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    };
    const watchers = [];
    vscode.workspace.createFileSystemWatcher = () => {
        const w = { create: [], change: [], onDidCreate(f) { this.create.push(f); return { dispose() {} }; },
            onDidChange(f) { this.change.push(f); return { dispose() {} }; }, dispose() {} };
        watchers.push(w);
        return w;
    };
    /** Something on disk changed (a figure saved from another program). */
    const touched = (fsPath, created = false) => { for (const w of watchers) for (const f of (created ? w.create : w.change)) f({ fsPath }); };
    const context = {
        secrets: { get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); } },
        globalState: { get: k => state.get(k), update: async (k, v) => { state.set(k, v); } },
    };
    /** The reader types into an open document. */
    const type = (doc, offset, text, remove = 0) => {
        doc.text = doc.text.slice(0, offset) + text + doc.text.slice(offset + remove);
        doc.version++; doc.isDirty = true;
        fire(doc, [{ rangeOffset: offset, rangeLength: remove, text }]);
    };
    /** The reader moves the caret in the editor of `doc`. */
    const caret = (doc, line, character) => { for (const h of selectionHandlers) h({ textEditor: { document: doc, selection: { active: { line, character } } } }); };
    return { vscode, context, makeDoc, type, secrets, state, touched, caret };
}

function project(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-link-'));
    const paper = path.join(root, 'PAPER');
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(paper, rel)), { recursive: true });
        fs.writeFileSync(path.join(paper, rel), Buffer.isBuffer(text) ? text : String(text));
    }
    return paper;
}

test('an editor change becomes an op on the text before it; one replacement spans two texts', () => {
    assert.deepStrictEqual(changeOp('abcdef', [{ rangeOffset: 1, rangeLength: 2, text: 'XY' }, { rangeOffset: 5, rangeLength: 0, text: '!' }]),
        [{ p: 5, i: '!' }, { p: 1, d: 'bc' }, { p: 1, i: 'XY' }]);
    assert.deepStrictEqual(span('Hello world', 'Hello, world'), { from: 5, to: 5, text: ',' });
});

test('linking the paper\'s folder: the cookie asked once (the Value alone is enough), the project picked from the list, no other window', async () => {
    const paper = project({ 'main.tex': 'One.\nTwo.\n', 'sections/a.tex': 'A.\n' });
    const server = new FakeOverleaf({ 'main.tex': 'One.\nTwo.\n', 'sections/a.tex': 'A.\n' });
    let asked = null;
    const v = fakeVscode({ answers: { input: (o) => { asked = o; return 'good'; } } });
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
    assert.strictEqual(await link.link(path.join(paper, 'main.tex')), true);
    assert.ok(/Application → Storage → Cookies/.test(asked.prompt) && /overleaf_session2/.test(asked.prompt), 'the prompt says where the cookie is');
    assert.strictEqual(v.secrets.get('wolfbook.tex.overleafCookie:https://www.overleaf.com'), 'overleaf_session2=good', 'kept as the header, in Secret Storage');
    assert.deepStrictEqual(Object.keys(v.state.get(LINKS_KEY)), [paper], 'the paper\'s own folder is linked');
    assert.strictEqual(link.state.status, 'connected');
    assert.strictEqual(link.linkFor(path.join(paper, 'sections', 'a.tex')).root, paper, 'every file under it belongs to the link');
    link.disconnect();
});

test('the Overleaf folder that is the paper\'s folder is chosen (best match first), confirmed, and what is made here is made there', async () => {
    // The project keeps the paper in its folder paper/; here it is PAPER/ with a new picture.
    const main = 'One.\n\\includegraphics{img/new.png}\n';
    const paper = project({ 'main.tex': main, 'img/new.png': Buffer.from([1, 2, 3]) });
    const server = new FakeOverleaf({ 'paper/main.tex': main, 'other/notes.tex': 'x\n' });
    const picks = [];
    let confirm = null;
    const answers = { input: () => 'good',
        pick: items => { picks.push(items); return items[0]; },
        warning: (m, items) => { confirm = confirm || m; return items[0]; } };
    const v = fakeVscode({ answers });
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
    assert.strictEqual(await link.link(path.join(paper, 'main.tex')), true);
    const folders = picks[1];
    assert.strictEqual(folders[0].dir, 'paper/', JSON.stringify(folders.map(f => f.label)));
    assert.ok(/1 of its 1 files are in .* — best match/.test(folders[0].description), folders[0].description);
    assert.ok(folders.some(f => f.dir === ''), 'the project\'s top is offered');
    assert.ok(folders.at(-1).fresh, 'and a new folder');
    assert.ok(/Link .*PAPER.* to the folder “paper\/” of the Overleaf project “Fishnets”/.test(confirm), confirm);
    assert.deepStrictEqual(v.state.get(LINKS_KEY)[paper].prefix, 'paper/');
    await settle(30);
    assert.ok(server.uploads.includes('paper/img/new.png'), `the new picture is made in paper/ (${server.uploads})`);
    assert.ok(!link.client.byPath('other/notes.tex'), 'outside the folder: not synced');
    assert.ok(answers.infos.some(m => /^Linked .* to “paper\/” in the Overleaf project “Fishnets”: 1 document and 1 other file/.test(m)), JSON.stringify(answers.infos));
    link.disconnect();
    // Declined at the confirmation: nothing is linked.
    const p2 = project({ 'main.tex': 'x\n' });
    const v2 = fakeVscode({ answers: { input: () => 'good', warning: () => undefined } });
    const l2 = new OverleafLink({ vscode: v2.vscode, context: v2.context, deps: new FakeOverleaf({ 'main.tex': 'x\n' }).deps() });
    assert.strictEqual(await l2.link(path.join(p2, 'main.tex')), false);
    assert.strictEqual(v2.state.get(LINKS_KEY), undefined);
});

test('typing goes to Overleaf; a collaborator\'s edit arrives in the open editor (not sent back), and in the file when it is not open', async () => {
    const paper = project({ 'main.tex': 'One.\nTwo.\n\\input{sections/a}\n', 'sections/a.tex': 'A.\n' });
    const server = new FakeOverleaf({ 'main.tex': 'One.\nTwo.\n\\input{sections/a}\n', 'sections/a.tex': 'A.\n' });
    const v = fakeVscode({ answers: { input: () => 'good' } });
    const doc = v.makeDoc(path.join(paper, 'main.tex'), 'One.\nTwo.\n\\input{sections/a}\n');
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
    await link.link(path.join(paper, 'main.tex'));
    v.type(doc, 4, ' More');
    await settle(20);
    assert.strictEqual(server.text('main.tex'), 'One. More\nTwo.\n\\input{sections/a}\n');
    server.collaborator('main.tex', [{ p: 0, i: '% theirs\n' }]);
    await settle(30);
    assert.strictEqual(doc.text, '% theirs\nOne. More\nTwo.\n\\input{sections/a}\n');
    const history = server.docs.get(server.idOf('main.tex')).history.length;
    await settle(30);
    assert.strictEqual(server.docs.get(server.idOf('main.tex')).history.length, history, 'the collaborator\'s edit is not echoed back');
    server.collaborator('sections/a.tex', [{ p: 2, i: ' And B.' }]);
    await settle(30);
    assert.strictEqual(fs.readFileSync(path.join(paper, 'sections', 'a.tex'), 'utf8'), 'A. And B.\n', 'a file not open is written');
    await settle(1700);
    assert.ok(doc.saved >= 1, 'the open document is saved a moment later');
    link.disconnect();
});

test('your presence: the caret is reported to Overleaf as its editor does (row, column, document)', async () => {
    const paper = project({ 'main.tex': 'One.\nTwo.\n' });
    const server = new FakeOverleaf({ 'main.tex': 'One.\nTwo.\n' });
    const v = fakeVscode({ answers: { input: () => 'good' } });
    const doc = v.makeDoc(path.join(paper, 'main.tex'), 'One.\nTwo.\n');
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
    await link.link(path.join(paper, 'main.tex'));
    v.caret(doc, 1, 2); v.caret(doc, 1, 3);
    await settle(350);
    assert.deepStrictEqual(server.positions, [{ row: 1, column: 3, doc_id: server.idOf('main.tex') }], 'one report for a burst of moves, where the caret ended');
    const other = v.makeDoc(path.join(os.tmpdir(), 'elsewhere.tex'), 'x');
    v.caret(other, 0, 0);
    await settle(350);
    assert.strictEqual(server.positions.length, 1, 'a file outside the project is not reported');
    link.disconnect();
});

test('the reader and a collaborator typing at once stay in step (randomised, with refused edits retried)', async () => {
    for (let seed = 1; seed <= 8; seed++) {
        const paper = project({ 'main.tex': 'Alpha beta gamma.\n' });
        const server = new FakeOverleaf({ 'main.tex': 'Alpha beta gamma.\n' });
        const v = fakeVscode({ answers: { input: () => 'good' } });
        const doc = v.makeDoc(path.join(paper, 'main.tex'), 'Alpha beta gamma.\n');
        const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
        await link.link(path.join(paper, 'main.tex'));
        let s = seed;
        const rand = n => ((s = (s * 1103515245 + 12345) & 0x7fffffff) >> 16) % n;
        for (let k = 0; k < 50; k++) {
            if (rand(2)) v.type(doc, rand(doc.text.length + 1), 'k');
            else { const t = server.text('main.tex'); const p = rand(t.length + 1); server.collaborator('main.tex', rand(4) === 0 && p < t.length ? [{ p, d: t[p] }] : [{ p, i: 'R' }]); }
            if (rand(3) === 0) await settle(rand(3));
        }
        await settle(5);
        for (let i = 0; i < 400 && ((link.unapplied.get('main.tex') || []).length || !link.client.idle()); i++) await settle(5);
        await settle(10);
        assert.strictEqual(link.state.status, 'connected', `seed ${seed}`);
        assert.strictEqual(doc.text, server.text('main.tex'), `seed ${seed}: the editor and Overleaf agree`);
        assert.ok(/k/.test(doc.text) && /R/.test(doc.text), `seed ${seed}: both typed`);
        link.disconnect();
    }
});

test('connecting to a project whose files differ asks first; Overleaf\'s version replaces the local text as an edit', async () => {
    const paper = project({ 'main.tex': 'my text\n' });
    const server = new FakeOverleaf({ 'main.tex': 'Overleaf text\n\\input{new}\n', 'new.tex': 'only there\n', 'unused.tex': 'not the paper\'s\n' });
    let asked = null;
    const v = fakeVscode({ answers: { input: () => 'good', warning: (m, items) => { asked = m; return items[0]; } } });
    const doc = v.makeDoc(path.join(paper, 'main.tex'), 'my text\n');
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
    await link.link(path.join(paper, 'main.tex'));
    assert.ok(/1 file of PAPER differs from Overleaf/.test(asked), asked);
    assert.strictEqual(doc.text, 'Overleaf text\n\\input{new}\n');
    assert.strictEqual(fs.readFileSync(path.join(paper, 'new.tex'), 'utf8'), 'only there\n', 'a file the paper uses that only Overleaf has is written');
    assert.ok(!fs.existsSync(path.join(paper, 'unused.tex')), 'a document the paper does not use is left on Overleaf');
    link.disconnect();
    // Cancelled: nothing changes, not connected.
    const p2 = project({ 'main.tex': 'mine\n' });
    const s2 = new FakeOverleaf({ 'main.tex': 'theirs\n' });
    const v2 = fakeVscode({ answers: { input: () => 'good', warning: () => undefined } });
    const l2 = new OverleafLink({ vscode: v2.vscode, context: v2.context, deps: s2.deps() });
    assert.strictEqual(await l2.link(path.join(p2, 'main.tex')), false);
    assert.strictEqual(fs.readFileSync(path.join(p2, 'main.tex'), 'utf8'), 'mine\n');
    assert.strictEqual(l2.state.status, 'off');
});

test('the files the paper uses are kept in step too: pictures fetched and sent, a new .bib sent, the compiled PDF left alone', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const newer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
    const mine = Buffer.from('%PDF-1.5 mine');
    const main = '\\documentclass{article}\n\\usepackage{graphicx}\\graphicspath{{img/}}\n\\begin{document}\n' +
        '\\includegraphics{plot}\\includegraphics{mine.pdf}\n\\bibliography{refs}\n\\end{document}\n';
    const paper = project({ 'main.tex': main, 'img/mine.pdf': mine, 'refs.bib': '@article{a,}\n', 'main.pdf': Buffer.from('%PDF compiled') });
    const server = new FakeOverleaf({ 'main.tex': main }, { 'img/plot.png': png });
    const v = fakeVscode({ answers: { input: () => 'good' } });
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
    assert.strictEqual(await link.link(path.join(paper, 'main.tex')), true);
    await settle(30);
    assert.deepStrictEqual(fs.readFileSync(path.join(paper, 'img', 'plot.png')), png, 'the picture only Overleaf had is fetched');
    assert.deepStrictEqual(server.fileBytes('img/mine.pdf'), mine, 'the picture only this folder had is sent');
    assert.ok(server.idOf('refs.bib'), 'the bibliography becomes a document on Overleaf');
    assert.ok(!server.uploads.includes('main.pdf'), 'the compiled PDF is not the paper\'s: not sent');
    assert.ok(link.client.byPath('refs.bib'), 'and is then kept in step as a document');
    // A collaborator replaces the picture: fetched.
    server.putFile('img/plot.png', newer);
    await settle(30);
    assert.deepStrictEqual(fs.readFileSync(path.join(paper, 'img', 'plot.png')), newer);
    // The reader re-exports their figure: sent.
    const again = Buffer.from('%PDF-1.5 mine, redrawn');
    fs.writeFileSync(path.join(paper, 'img', 'mine.pdf'), again);
    v.touched(path.join(paper, 'img', 'mine.pdf'));
    await settle(700);
    assert.deepStrictEqual(server.fileBytes('img/mine.pdf'), again);
    // What WPaper itself wrote is not sent back.
    const uploads = server.uploads.length;
    v.touched(path.join(paper, 'img', 'plot.png'));
    await settle(700);
    assert.strictEqual(server.uploads.length, uploads, 'a fetched picture is not uploaded again');
    link.disconnect();
});

test('an agent\'s edit of a synced file that is not open (written on disk) reaches Overleaf', async () => {
    const main = 'One.\n\\input{b}\n';
    const paper = project({ 'main.tex': main, 'b.tex': 'Bee.\n' });
    const server = new FakeOverleaf({ 'main.tex': main, 'b.tex': 'Bee.\n' });
    const v = fakeVscode({ answers: { input: () => 'good' } });
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
    await link.link(path.join(paper, 'main.tex'));
    fs.writeFileSync(path.join(paper, 'b.tex'), 'Bee, rewritten by the agent.\n');
    v.touched(path.join(paper, 'b.tex'));
    await settle(400);
    assert.strictEqual(server.text('b.tex'), 'Bee, rewritten by the agent.\n');
    // A collaborator's edit written into it is not sent back.
    const n = server.docs.get(server.idOf('b.tex')).history.length;
    server.collaborator('b.tex', [{ p: 0, i: '% c\n' }]);
    await settle(30);
    v.touched(path.join(paper, 'b.tex'));
    await settle(400);
    assert.strictEqual(server.docs.get(server.idOf('b.tex')).history.length, n + 1, 'only the collaborator\'s own edit');
    assert.strictEqual(fs.readFileSync(path.join(paper, 'b.tex'), 'utf8'), '% c\nBee, rewritten by the agent.\n');
    link.disconnect();
});

test('never synced: Markdown files, dot-files and dot-folders, and what the paper does not name', async () => {
    const main = '\\input{a}\\includegraphics{.cache/fig.png}\\input{notes.md}\n';
    const paper = project({ 'main.tex': main, 'a.tex': 'A\n', 'README.md': '# notes\n', '.cache/fig.png': Buffer.from([1]), 'notes.md': 'm\n', 'stray.png': Buffer.from([2]) });
    const server = new FakeOverleaf({ 'main.tex': main, 'a.tex': 'A\n', 'notes.md': 'theirs\n', '.latexmkrc': 'x\n', 'old.tex': 'old\n' }, { 'unused.png': Buffer.from([3]) });
    const v = fakeVscode({ answers: { input: () => 'good' } });
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
    assert.strictEqual(await link.link(path.join(paper, 'main.tex')), true);
    await settle(30);
    assert.deepStrictEqual([...link.uses].sort(), ['a.tex', 'main.tex']);
    for (const p of ['notes.md', '.latexmkrc', 'old.tex']) assert.ok(!link.client.byPath(p), `${p} is not joined`);
    assert.deepStrictEqual(server.uploads, [], 'nothing of those sent');
    assert.strictEqual(fs.readFileSync(path.join(paper, 'notes.md'), 'utf8'), 'm\n', 'a Markdown file here is untouched');
    for (const f of ['.latexmkrc', 'old.tex', 'unused.png']) assert.ok(!fs.existsSync(path.join(paper, f)), `${f} not written here`);
    // Naming a picture in the paper makes it the paper's: then it is sent.
    const doc = v.makeDoc(path.join(paper, 'main.tex'), main);
    link.mirrors.set('main.tex', main);
    v.type(doc, main.length, '\\includegraphics{stray.png}');
    await settle(1700);
    assert.ok(server.uploads.includes('stray.png'), `named now, sent (${server.uploads})`);
    link.disconnect();
});

test('never out of step: an edit made while connecting is sent, a drifted mirror is healed, every update carries Overleaf\'s hash', async () => {
    const text = 'One.\nTwo.\nThree.\n';
    const paper = project({ 'main.tex': text });
    const server = new FakeOverleaf({ 'main.tex': text });
    const v = fakeVscode({ answers: { input: () => 'good' } });
    const doc = v.makeDoc(path.join(paper, 'main.tex'), text);
    const logs = [];
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps(), log: l => logs.push(l) });
    // A keystroke (or an agent's write) before the listener is there.
    const watch = link.watch.bind(link);
    link.watch = () => { v.type(doc, 0, 'EARLY '); watch(); };
    await link.link(path.join(paper, 'main.tex'));
    await settle(30);
    assert.strictEqual(server.text('main.tex'), doc.text, 'the edit made while connecting reached Overleaf');
    // What this side knew drifts (the lost-edit bug): the next keystroke must not land at a wrong place.
    link.mirrors.set('main.tex', doc.text.replace('Two', 'Owt'));
    v.type(doc, doc.text.indexOf('Three'), 'and ');
    await settle(30);
    assert.strictEqual(server.text('main.tex'), doc.text, 'healed before the edit');
    assert.ok(logs.some(l => /had drifted/.test(l)), logs.join('\n'));
    // A change nothing reported (the editor's text moved silently): the periodic check sends it.
    doc.text = doc.text.replace('One', 'Uno');
    link.checkInStep('periodic check');
    await settle(30);
    assert.strictEqual(server.text('main.tex'), doc.text, 'the periodic check sent it');
    // Every update carried the hash, and none was refused.
    assert.strictEqual(server.refused || 0, 0);
    link.disconnect();
});

test('an emoji (stored by Overleaf as U+FFFD) is not drift: no heal loop, keystrokes stay ordinary edits', async () => {
    const text = 'One.\nTwo.\n';
    const paper = project({ 'main.tex': text });
    const server = new FakeOverleaf({ 'main.tex': text });
    const v = fakeVscode({ answers: { input: () => 'good' } });
    const doc = v.makeDoc(path.join(paper, 'main.tex'), text);
    const logs = [];
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps(), log: l => logs.push(l) });
    await link.link(path.join(paper, 'main.tex'));
    await settle(30);
    v.type(doc, 0, '\u{1F600} ');
    await settle(30);
    assert.strictEqual(server.text('main.tex'), doc.text.replace(/[\uD800-\uDFFF]/g, '\uFFFD'));
    v.type(doc, doc.text.indexOf('Two'), 'x');
    await settle(30);
    for (let k = 0; k < 3; k++) link.checkInStep('periodic check');
    await settle(30);
    assert.ok(!logs.some(l => /had drifted/.test(l)), 'never healed: ' + logs.join('\n'));
    assert.strictEqual(server.text('main.tex'), doc.text.replace(/[\uD800-\uDFFF]/g, '\uFFFD'));
    link.disconnect();
});

test('Overleaf\'s hash check: an update from a text Overleaf does not have is refused and said, not applied', async () => {
    const paper = project({ 'main.tex': 'abc\n' });
    const server = new FakeOverleaf({ 'main.tex': 'abc\n' });
    const v = fakeVscode({ answers: { input: () => 'good' } });
    const doc = v.makeDoc(path.join(paper, 'main.tex'), 'abc\n');
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
    await link.link(path.join(paper, 'main.tex'));
    // The client's copy corrupted behind the link's back.
    const d = link.client.byPath('main.tex');
    d.ot.text = 'abX\n';
    link.client.local('main.tex', [{ p: 0, i: 'Z' }]);
    await settle(30);
    assert.strictEqual(server.refused, 1);
    assert.strictEqual(server.text('main.tex'), 'abc\n', 'not applied');
    assert.notStrictEqual(link.state.status, 'connected', 'said, and the link stops');
    link.disconnect();
});

test('a refused cookie is said, and forgotten so the next connect asks again', async () => {
    const paper = project({ 'main.tex': 'x\n' });
    const server = new FakeOverleaf({ 'main.tex': 'x\n' });
    const v = fakeVscode({ answers: { input: () => 'expired' } });
    const link = new OverleafLink({ vscode: v.vscode, context: v.context, deps: server.deps() });
    v.state.set(LINKS_KEY, { [paper]: { url: 'https://www.overleaf.com/project/0123456789abcdef01234567' } });
    v.secrets.set('wolfbook.tex.overleafCookie:https://www.overleaf.com', 'overleaf_session2=expired');
    assert.strictEqual(await link.connect(paper), false);
    assert.strictEqual(link.state.status, 'error');
    assert.ok(/did not accept the session cookie/.test(link.state.detail), link.state.detail);
    assert.strictEqual(v.secrets.get('wolfbook.tex.overleafCookie:https://www.overleaf.com'), undefined, 'forgotten');
});

(async () => {
    console.log('WPaper Overleaf link\n');
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log(`  ok   ${name}`); }
        catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.stack || e}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
