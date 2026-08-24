// tex-reviewui.test.js — the review's four surfaces, EXECUTED.
//
// The session has its own suite; this drives the half that touches vscode,
// because "any handler with no executing test is a handler that can ship
// broken" is a rule this workstream has paid for twice. What is asserted is
// what the reader can see and do:
//
//   · the status bar counts what is pending, and hides when nothing is
//   · every pending change is decorated, and the decorations are CLEARED when
//     the review ends — a mark left behind is a lie about the text
//   · focusing a change NEVER touches the selection (the reported "total mess
//     of selection and highlighting")
//   · Keep removes exactly that change; Undo applies one whole-line edit
//   · a CodeLens offers Undo only where undoing is honest

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// --- the smallest vscode that reviewUi needs --------------------------------
const decorations = [];
const changeHandlers = [];
const commands = new Map();
let infoPick = null;
const infoCalls = [];
let warnPick = null;
const warnCalls = [];

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
    constructor(a, b, c, d) {
        this.start = typeof a === 'object' ? a : new Position(a, b);
        this.end = typeof a === 'object' ? b : new Position(c, d);
    }
}
class Selection extends Range { constructor(a, b, c, d) { super(a, b, c, d); this.anchor = this.start; this.active = this.end; } }

const editsApplied = [];
class WorkspaceEdit {
    constructor() { this.parts = []; }
    replace(uri, range, text) { this.parts.push({ kind: 'replace', range, text }); }
    delete(uri, range) { this.parts.push({ kind: 'delete', range, text: '' }); }
}

let DOC = null;                       // the paper under review
function makeDoc(fsPath, text) {
    let lines = text.split('\n');
    return {
        uri: { fsPath, scheme: 'file', path: fsPath },
        // A CLEAN BUFFER IS A COPY OF THE FILE; only a dirty one is ahead of
        // it. The review reads the file when the buffer is clean, which is what
        // makes a change visible before VS Code has finished reloading it.
        isDirty: false,
        get lineCount() { return lines.length; },
        getText() { return lines.join('\n'); },
        lineAt(i) { return { text: lines[i], range: new Range(i, 0, i, lines[i].length) }; },
        _setText(t) { lines = t.split('\n'); },
        _lines() { return lines; },
    };
}

const editor = {
    get document() { return DOC; },
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    revealRange() { this.revealed = true; },
    setDecorations(type, ranges) { decorations.push({ type: type.id, n: ranges.length }); },
};

let decorSeq = 0;
const stub = {
    workspace: {
        getConfiguration: () => ({ get: (k, d) => d }),
        onDidChangeTextDocument: (fn) => { changeHandlers.push(fn); return { dispose() {} }; },
        get textDocuments() { return [DOC]; },
        openTextDocument: async () => DOC,
        applyEdit: async (we) => {
            // Apply it the way VS Code would: bottom-up, whole lines.
            const lines = DOC._lines().slice();
            const parts = we.parts.slice().sort((a, b) => b.range.start.line - a.range.start.line);
            for (const p of parts) {
                const from = p.range.start.line;
                const to = p.range.end.character === 0 ? p.range.end.line : p.range.end.line + 1;
                const insert = p.text ? p.text.replace(/\n$/, '').split('\n') : [];
                lines.splice(from, Math.max(0, to - from), ...insert);
            }
            DOC._setText(lines.join('\n'));
            DOC.isDirty = true;          // an applied edit is unsaved, as in VS Code
            editsApplied.push(we.parts.length);
            return true;
        },
    },
    window: {
        createStatusBarItem: () => ({
            text: '', tooltip: '', command: '', shown: false,
            show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {},
        }),
        createTextEditorDecorationType: () => ({ id: ++decorSeq, dispose() {} }),
        showTextDocument: async () => editor,
        showInformationMessage: async (...a) => { infoCalls.push(a); return infoPick; },
        showWarningMessage: async (...a) => { warnCalls.push(a); return warnPick; },
        onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
        get visibleTextEditors() { return [editor]; },
        activeTextEditor: editor,
    },
    commands: {
        registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
        executeCommand: async (id, ...args) => (commands.has(id) ? commands.get(id)(...args) : undefined),
    },
    languages: {},
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    MarkdownString: class {
        constructor() { this.value = ''; }
        appendMarkdown(t) { this.value += t; return this; }
        appendCodeblock(t) { this.value += t; return this; }
    },
    CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    Position, Range, Selection, WorkspaceEdit,
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
    ViewColumn: { One: 1 },
    StatusBarAlignment: { Right: 2 },
    OverviewRulerLane: { Left: 1 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
};

const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? stub : origLoad.call(this, req, ...rest); };
for (const m of ['../../tex/reviewUi', '../../tex/reviewBus']) {
    try { delete require.cache[require.resolve(m)]; } catch (_) { /* first run */ }
}
const { ReviewUi, describeHunk } = require('../../tex/reviewUi');
const busMod = require('../../tex/reviewBus');
Module._load = origLoad;

// --- the paper ---------------------------------------------------------------
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-review-'));
const FILE = path.join(DIR, 'p.tex');
const BASE = [
    '\\documentclass{article}',
    '\\begin{document}',
    'The SoV pairing contains both allowed sectors here.',
    '',
    'A second paragraph nobody is arguing about.',
    '\\end{document}',
].join('\n');
const AGENT = BASE.replace('The SoV pairing contains both allowed sectors here.',
    'The SoV pairing contains both allowed sectors in the strip.');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function makeUi(o = {}) {
    DOC = makeDoc(FILE, o.docText || AGENT);
    DOC.isDirty = !!o.dirty;
    fs.writeFileSync(FILE, o.diskText || o.docText || AGENT);
    changeHandlers.length = 0;
    decorations.length = 0; editsApplied.length = 0; infoCalls.length = 0;
    const posted = [];
    const viewer = {
        root: FILE, isOpen: () => true, reviewVisible: false,
        showReview: (p) => posted.push(p),
        focusReviewHunk: (h) => posted.push({ focus: h.id }),
        openReview: async () => {}, status: () => {},
    };
    const ui = new ReviewUi({ viewer, output: { appendLine() {} }, mapView: () => ({}) });
    ui.register({ subscriptions: [] });
    return { ui, viewer, posted };
}

test('a batch arrives: the status bar counts it and the panel is handed the list', async () => {
    const { ui, posted } = makeUi();
    await ui.noteAgentChange({ file: FILE, baseText: BASE, source: 'disk' });
    assert.strictEqual(ui.sessionFor(FILE).pendingCount, 1);
    assert.ok(ui.status.shown, 'the status bar is showing');
    assert.ok(/1 change to review/.test(ui.status.text), ui.status.text);
    const last = posted[posted.length - 1];
    assert.strictEqual(last.pending, 1);
    assert.strictEqual(last.groups[0].source, 'disk');
});

test('ONE TOAST PER BATCH THAT CHANGED SOMETHING, and none while the list is on screen', async () => {
    // Grouping OFF for this one, so every write is its own arrival — which is
    // also the check that the setting is read at all.
    const cfg = stub.workspace.getConfiguration;
    stub.workspace.getConfiguration = () => ({ get: (k, d) => (k === 'groupWindowSeconds' ? 0 : d) });
    try {
    const { ui, viewer } = makeUi();
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    assert.strictEqual(infoCalls.length, 1, 'announced once');

    // A batch that changed nothing the reader can see says nothing.
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    assert.strictEqual(infoCalls.length, 1, 'an empty batch is not worth a toast');

    // A second real write joins the same list, and is announced.
    const second = AGENT.replace('A second paragraph nobody is arguing about.',
        'A second paragraph the agent rewrote as well.');
    DOC._setText(second); fs.writeFileSync(FILE, second);
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    assert.strictEqual(infoCalls.length, 2, 'the second write is announced');
    assert.strictEqual(ui.sessionFor(FILE).pendingCount, 2,
        'and BOTH changes are pending — the first was not approved by the second arriving');

    viewer.reviewVisible = true;
    const third = DOC.getText().replace('\\end{document}', 'One more line.\n\\end{document}');
    DOC._setText(third); fs.writeFileSync(FILE, third);
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    assert.strictEqual(infoCalls.length, 2, 'not while the reader is already looking at the list');
    } finally { stub.workspace.getConfiguration = cfg; }
});

test('EVERY PENDING CHANGE IS DECORATED, AND CLEARED WHEN THE REVIEW ENDS', async () => {
    const { ui } = makeUi();
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    const painted = decorations.filter(d => d.n > 0);
    assert.ok(painted.length >= 1, 'something was marked in the editor');
    decorations.length = 0;
    ui.close(FILE);
    assert.ok(decorations.length >= 5, 'every decoration type is addressed on the way out');
    assert.ok(decorations.every(d => d.n === 0), 'and every one of them is emptied');
    assert.ok(!ui.status.shown, 'the status bar goes away with the last change');
});

test('FOCUSING A CHANGE NEVER TOUCHES THE SELECTION', async () => {
    const { ui, posted } = makeUi();
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    const id = ui.sessionFor(FILE).hunks[0].id;
    const before = editor.selection;
    await ui.show(FILE, id);
    assert.strictEqual(editor.selection, before, 'the reader\'s selection is untouched');
    assert.ok(editor.revealed, 'it was revealed instead');
    assert.ok(posted.some(p => p && p.focus === id), 'and the page was told which change');
});

test('DECIDING ONE CHANGE MOVES TO THE NEXT', async () => {
    // Reviewing is a WORKLIST. Deciding a change and then having to point at
    // the next one is a click nobody needs, and it is the click that makes a
    // long review feel long.
    const TWO = AGENT.replace('A second paragraph nobody is arguing about.',
        'A second paragraph somebody is arguing about.');
    const { ui, posted } = makeUi({ docText: TWO });
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    const s = ui.sessionFor(FILE);
    assert.strictEqual(s.hunks.length, 2, 'the fixture really has two changes');

    const [first, second] = s.hunks.map(h => h.id);
    await ui.show(FILE, first);
    assert.strictEqual(ui.focused.get(FILE), first, 'the first is the one in hand');

    posted.length = 0;
    await ui.keep(FILE, first);
    assert.strictEqual(ui.focused.get(FILE), second,
        'keeping it moves to the one after it, with no second click');
    assert.ok(posted.some(p => p && p.focus === second),
        'and the page is told which change is now in hand');
});

test('DECIDING THE LAST CHANGE DOES NOT LEAVE THE FOCUS NOWHERE', async () => {
    const TWO = AGENT.replace('A second paragraph nobody is arguing about.',
        'A second paragraph somebody is arguing about.');
    const { ui } = makeUi({ docText: TWO });
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    const s = ui.sessionFor(FILE);
    const [first, second] = s.hunks.map(h => h.id);

    await ui.keep(FILE, second);          // the LAST one first
    assert.strictEqual(ui.focused.get(FILE), first,
        'the list closed up, so the one before it is what is left');

    await ui.keep(FILE, first);
    assert.strictEqual(ui.sessionFor(FILE), null, 'and deciding the last one ends the review');
});

test('KEEP removes exactly that change and leaves the document alone', async () => {
    const { ui } = makeUi();
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    const s = ui.sessionFor(FILE);
    const id = s.hunks[0].id;
    const text = DOC.getText();
    await ui.keep(FILE, id);
    assert.strictEqual(DOC.getText(), text, 'keeping changes no text');
    assert.strictEqual(ui.sessionFor(FILE), null, 'and the review is over');
    assert.strictEqual(editsApplied.length, 0, 'no edit was applied');
});

test('UNDO applies ONE edit and puts the baseline text back', async () => {
    const { ui } = makeUi();
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    const id = ui.sessionFor(FILE).hunks[0].id;
    await ui.undo(FILE, id);
    assert.strictEqual(editsApplied.length, 1, 'one WorkspaceEdit — one undo step');
    assert.strictEqual(DOC.getText(), BASE, 'the text is back to what the reader agreed to');
    assert.strictEqual(ui.sessionFor(FILE), null, 'nothing left to review');
});

test('the CodeLens carries Keep, Undo and Show — and drops Undo where it would lie', async () => {
    const { ui } = makeUi();
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    const provider = ui.lensProvider();
    const lenses = provider.provideCodeLenses(DOC);
    const titles = lenses.map(l => l.command.title);
    assert.ok(titles.some(t => /Keep/.test(t)), titles.join(' | '));
    assert.ok(titles.some(t => /Undo/.test(t)));
    assert.ok(titles.some(t => /Show on page/.test(t)));

    const s = ui.sessionFor(FILE);
    s.edited.add(s.hunks[0].id);
    const after = provider.provideCodeLenses(DOC).map(l => l.command.title);
    assert.ok(!after.some(t => /Undo/.test(t)), 'no Undo offered for text the reader has edited');
    assert.ok(after.some(t => /you have edited this/.test(t)), after.join(' | '));
});

test('AN EDIT FROM THE MCP TOOL IS REVIEWABLE — the bus carries it', async () => {
    const { ui } = makeUi();
    busMod.announceAgentEdit({ file: FILE, baseText: BASE, source: 'paper_applyEdit', note: 'eq:x' });
    await new Promise(r => setTimeout(r, 10));
    const s = ui.sessionFor(FILE);
    assert.ok(s, 'a session was opened for a tool edit');
    assert.strictEqual(s.batches[0].source, 'paper_applyEdit');
    assert.strictEqual(s.pendingCount, 1);
});

test('AN MCP EDIT THROUGH THE BUFFER IS REVIEWABLE, NOT MIRRORED AWAY', async () => {
    // paper_applyEdit writes through the OPEN BUFFER, so the change event it
    // provokes is indistinguishable from typing — and the review mirrors the
    // reader's typing into its baseline. Without the `begin` announcement the
    // tool's own edit was agreed to on the reader's behalf and never appeared.
    // The real sequence: a review is already open and has compared once (which
    // is what arms the mirror), and THEN the tool writes.
    const { ui } = makeUi({ docText: AGENT, diskText: AGENT });
    await ui.noteAgentChange({ file: FILE, baseText: BASE, source: 'disk' });
    assert.strictEqual(ui.sessionFor(FILE).pendingCount, 1, 'one change from the disk write');

    busMod.announceAgentEdit({ file: FILE, baseText: AGENT, phase: 'begin', source: 'paper_applyEdit' });
    await new Promise(r => setTimeout(r, 5));

    // The tool applies its edit: the buffer changes and goes dirty.
    const TOOL = AGENT.replace('A second paragraph nobody is arguing about.',
        'A second paragraph the tool rewrote.');
    const at = AGENT.indexOf('A second paragraph nobody is arguing about.');
    DOC._setText(TOOL);
    DOC.isDirty = true;
    for (const fn of changeHandlers) {
        fn({ document: DOC, contentChanges: [{
            rangeOffset: at,
            rangeLength: 'A second paragraph nobody is arguing about.'.length,
            text: 'A second paragraph the tool rewrote.',
        }] });
    }
    busMod.announceAgentEdit({ file: FILE, baseText: AGENT, phase: 'end', source: 'paper_applyEdit', note: 'eq:x' });
    await new Promise(r => setTimeout(r, 20));

    const s = ui.sessionFor(FILE);
    assert.ok(s, 'the session is open');
    assert.strictEqual(s.pendingCount, 2,
        'the tool\'s edit joins the list instead of being agreed to silently');
    assert.ok(s.hunks.every(h => !s.edited.has(h.id)),
        'and neither change is marked as something the reader typed');
    assert.ok(s.hunks.every(h => s.undo(h.id).ok), 'so both can be undone');
});

test('the commands are registered and act on the file in front', async () => {
    const { ui } = makeUi();
    await ui.noteAgentChange({ file: FILE, baseText: BASE });
    assert.ok(commands.has('wolfbook.tex.reviewKeep'));
    assert.ok(commands.has('wolfbook.tex.reviewUndoAll'));
    await stub.commands.executeCommand('wolfbook.tex.reviewUndoAll');
    assert.strictEqual(DOC.getText(), BASE, 'Undo all put the paper back');
    void ui;
});

test('THE BUFFER HAS NOT CAUGHT UP YET — the change is still found', async () => {
    // The reported failure: an agent writes the open, clean file; the watcher
    // notices before VS Code has reloaded the buffer, so the document still
    // holds the OLD text. Reading the buffer found no difference, the empty
    // session was thrown away, and the pages changed with nothing to review.
    const { ui } = makeUi({ docText: BASE, diskText: AGENT });
    await ui.noteAgentChange({ file: FILE, baseText: BASE, source: 'disk' });
    const s = ui.sessionFor(FILE);
    assert.ok(s, 'the session survived');
    assert.strictEqual(s.pendingCount, 1, 'and the change is in it, read from the file');
    assert.ok(ui.status.shown, 'the status bar says so');
});

test('A RELOAD IS NOT THE READER TYPING — it must not move the baseline', async () => {
    const { ui } = makeUi({ docText: BASE, diskText: BASE });
    await ui.noteAgentChange({ file: FILE, baseText: BASE, source: 'disk' });
    // Nothing has changed yet, so nothing is pending; the session waits.
    assert.strictEqual(ui.sessionFor(FILE).pendingCount, 0);

    // Now the agent's write lands and VS Code refreshes the CLEAN buffer: the
    // change event describes the agent's edit, not the reader's.
    fs.writeFileSync(FILE, AGENT);
    DOC._setText(AGENT);
    DOC.isDirty = false;
    for (const fn of changeHandlers) {
        fn({ document: DOC, contentChanges: [{ rangeOffset: 0, rangeLength: BASE.length, text: AGENT }] });
    }
    await ui.refresh(FILE);
    assert.strictEqual(ui.sessionFor(FILE).pendingCount, 1,
        'the agent\'s change is pending — the reload did not agree to it');
});

test('describeHunk says what happened in words', () => {
    const s = { edited: new Set() };
    assert.strictEqual(
        describeHunk({ verb: 'add', ourRange: { startLine: 3, endLine: 5 }, theirRange: { startLine: 3, endLine: 3 } }, s),
        '2 lines added');
    assert.strictEqual(
        describeHunk({ verb: 'change', changedWords: 3, ourRange: { startLine: 3, endLine: 4 }, theirRange: { startLine: 3, endLine: 4 } }, s),
        '3 words changed');
});

test('A BURST OF WRITES INTERRUPTS ONCE, AND READS AS ONE ARRIVAL', async () => {
    // An agent working on a paper writes several times in a row. Each write
    // used to be its own arrival: its own group in the list and, worse, its
    // own toast. What the reader wants to know is that the agent has been
    // through the paper, once.
    const { ui, posted } = makeUi();
    const step1 = BASE.replace('The SoV pairing contains both allowed sectors here.',
        'The SoV pairing contains both allowed sectors in the strip.');
    const step2 = step1.replace('A second paragraph nobody is arguing about.',
        'A second paragraph nobody is arguing about. With a new sentence.');
    const step3 = step2.replace('in the strip.', 'in the physical strip.');

    for (const text of [step1, step2, step3]) {
        fs.writeFileSync(FILE, text);
        DOC._setText(text);
        await ui.noteAgentChange({ file: FILE, baseText: BASE, source: 'disk' });
    }

    assert.strictEqual(infoCalls.length, 1, 'one interruption for the episode, not three');
    const last = posted[posted.length - 1];
    assert.strictEqual(last.groups.length, 1, 'and one arrival in the list');
    assert.strictEqual(last.groups[0].writes, 3, 'which says it was three writes');
    assert.strictEqual(last.pending, 2, 'two places changed in the end');
    // The part written twice is ONE change, in that arrival — not one entry
    // per write and not stranded in an arrival of its own.
    const names = last.groups[0].hunks.map(h => h.startLine).sort((a, b) => a - b);
    assert.strictEqual(new Set(names).size, 2);
});

test('KEEPING A SECTION DECIDES ITS CHANGES AND LEAVES THE REST', async () => {
    // The panel groups by section and sends the ids in that group; the UI's
    // job is to keep exactly those and repaint. Anything else — keeping the
    // whole file, or dropping the others from the list — would be the bug the
    // review exists to prevent.
    const { ui, posted } = makeUi();
    const both = BASE
        .replace('The SoV pairing contains both allowed sectors here.',
            'The SoV pairing contains both allowed sectors in the strip.')
        .replace('A second paragraph nobody is arguing about.',
            'A second paragraph the agent rewrote as well.');
    DOC._setText(both); fs.writeFileSync(FILE, both);
    await ui.noteAgentChange({ file: FILE, baseText: BASE, source: 'disk' });
    const s = ui.sessionFor(FILE);
    assert.strictEqual(s.pendingCount, 2);

    const first = s.hunks.find(h => h.ourRange.startLine < 4);
    assert.ok(first, 'the fixture has a change near the top');
    await ui.keepMany(FILE, [first.id]);

    assert.strictEqual(ui.sessionFor(FILE).pendingCount, 1, 'only the other one is left');
    assert.ok(ui.sessionFor(FILE).baseText.includes('in the strip.'), 'that one is agreed to');
    assert.ok(!ui.sessionFor(FILE).baseText.includes('rewrote as well'), 'the other is not');
    assert.strictEqual(posted[posted.length - 1].pending, 1, 'and the panel is told');
});

test('keeping a group of nothing does nothing at all', async () => {
    const { ui } = makeUi();
    await ui.noteAgentChange({ file: FILE, baseText: BASE, source: 'disk' });
    const before = ui.sessionFor(FILE).pendingCount;
    await ui.keepMany(FILE, []);
    await ui.keepMany(FILE, null);
    await ui.keepMany('/not/a/file.tex', ['x']);
    assert.strictEqual(ui.sessionFor(FILE).pendingCount, before);
});

// --- EDITING AT THE SAME TIME AS THE AGENT -----------------------------------
//
// Reported with a screenshot of VS Code's own refusal: "Failed to save … the
// content of the file is newer", and then "this does not trigger the internal
// review — I cannot review with our tools". The buffer is dirty, the file has
// moved, and there is no single text to diff. These drive the merge that makes
// one, through the real ReviewUi.

/** VS Code's revert: the buffer becomes the file, and is clean again. */
const armRevert = () => {
    let reverts = 0;
    commands.set('workbench.action.files.revert', () => {
        reverts++;
        DOC._setText(fs.readFileSync(FILE, 'utf8'));
        DOC.isDirty = false;
        return undefined;
    });
    return () => reverts;
};

// The reader is polishing the second paragraph; the agent rewrites the first.
const READER = BASE.replace('A second paragraph nobody is arguing about.',
    'A second paragraph the reader is in the middle of rewriting.');

test('A DIRTY BUFFER AND A CHANGED FILE BECOME ONE TEXT AND ONE REVIEW', async () => {
    const { ui, posted } = makeUi({ docText: READER, dirty: true, diskText: AGENT });
    const reverts = armRevert();
    warnCalls.length = 0;

    const r = await ui.mergeExternalChange({
        file: FILE, doc: DOC, base: BASE, ours: READER, theirs: AGENT, source: 'disk',
    });
    assert.ok(r, 'the merge was handled here, not handed to a modal');
    assert.strictEqual(r.applied, 1);
    assert.strictEqual(r.conflicts.length, 0);
    assert.strictEqual(reverts(), 1, 'the buffer was reloaded — that is what clears the stale save');

    // BOTH edits are in the buffer.
    assert.ok(DOC.getText().includes('in the strip.'), "the agent's change is in the buffer");
    assert.ok(DOC.getText().includes('in the middle of rewriting.'), "and so are the reader's own words");
    assert.ok(DOC.isDirty, 'the reader still has unsaved edits, exactly as before');

    // And it is a REVIEW: the agent's change is pending, the reader's is not.
    const s = ui.sessionFor(FILE);
    assert.ok(s, 'a session was opened');
    assert.strictEqual(s.pendingCount, 1, 'one thing to decide');
    assert.strictEqual(s.baseText, READER, "the baseline is the reader's own text");
    const last = posted[posted.length - 1];
    assert.strictEqual(last.pending, 1);
    assert.ok(/strip/.test(JSON.stringify(last.groups[0].hunks[0])), 'and it is the agent\'s change');
    assert.strictEqual(warnCalls.length, 0, 'nothing to warn about');
});

test('and UNDO on that change gives the reader back exactly their text', async () => {
    const { ui } = makeUi({ docText: READER, dirty: true, diskText: AGENT });
    armRevert();
    await ui.mergeExternalChange({ file: FILE, doc: DOC, base: BASE, ours: READER, theirs: AGENT });
    const s = ui.sessionFor(FILE);
    await ui.undo(FILE, s.hunks[0].id);
    assert.strictEqual(DOC.getText(), READER,
        'undoing the merged-in change restores the reader\'s buffer byte for byte');
});

test('WHAT BOTH SIDES TOUCHED IS NOT GUESSED AT, AND THE READER IS TOLD', async () => {
    const line = 'The SoV pairing contains both allowed sectors here.';
    const mine = BASE.replace(line, 'The SoV pairing contains both allowed sectors, plainly.');
    const { ui } = makeUi({ docText: mine, dirty: true, diskText: AGENT });
    armRevert();
    warnCalls.length = 0; warnPick = null;

    const r = await ui.mergeExternalChange({
        file: FILE, doc: DOC, base: BASE, ours: mine, theirs: AGENT,
    });
    assert.ok(r, 'still handled here');
    assert.strictEqual(r.applied, 0);
    assert.strictEqual(r.conflicts.length, 1);
    assert.strictEqual(DOC.getText(), mine, 'the reader\'s words are what the buffer holds');
    assert.ok(warnCalls.length === 1, 'and they are told, once');
    assert.ok(/touched lines you were editing/.test(warnCalls[0][0]), warnCalls[0][0]);
    assert.ok(warnCalls[0].includes('Compare…'), 'with a way to see what was left out');
});

test('the merge declines when it has nothing to work from', async () => {
    const { ui } = makeUi({ docText: READER, dirty: true, diskText: AGENT });
    armRevert();
    // No base: the caller must fall back to asking the reader.
    assert.strictEqual(await ui.mergeExternalChange({ file: FILE, doc: DOC, ours: READER, theirs: AGENT }), null);
    // Nothing of theirs to bring in.
    assert.strictEqual(await ui.mergeExternalChange({
        file: FILE, doc: DOC, base: BASE, ours: READER, theirs: BASE }), null);
    assert.strictEqual(await ui.mergeExternalChange({}), null);
});

test('A SECOND WRITE WHILE STILL DIRTY JOINS THE SAME LIST', async () => {
    // The invariant the whole review exists for, through the merge path: an
    // arriving change must never quietly approve the one before it.
    const { ui } = makeUi({ docText: READER, dirty: true, diskText: AGENT });
    armRevert();
    await ui.mergeExternalChange({ file: FILE, doc: DOC, base: BASE, ours: READER, theirs: AGENT });
    assert.strictEqual(ui.sessionFor(FILE).pendingCount, 1);

    // The reader types on, and the agent writes again — now against AGENT.
    const ours2 = DOC.getText().replace('rewriting.', 'rewriting, still.');
    DOC._setText(ours2); DOC.isDirty = true;
    const agent2 = AGENT.replace('A second paragraph nobody is arguing about.',
        'A second paragraph nobody is arguing about. Except this new sentence.');
    fs.writeFileSync(FILE, agent2);
    const r = await ui.mergeExternalChange({
        file: FILE, doc: DOC, base: AGENT, ours: ours2, theirs: agent2,
    });
    assert.ok(r);
    const s = ui.sessionFor(FILE);
    assert.strictEqual(s.pendingCount, 2, 'both the first change and the second are waiting');
    // Back to back, so they read as one episode of work — with the count of
    // writes kept, which is what the list shows.
    assert.strictEqual(s.batches.length, 1);
    assert.strictEqual(s.batches[0].writes, 2);
});

(async () => {
    console.log('the review UI, executed\n');
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log('  ok   ' + name); }
        catch (e) {
            fail++;
            console.log('  FAIL ' + name + '\n         ' +
                String((e && e.stack) || e).split('\n').slice(0, 4).join('\n         '));
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
