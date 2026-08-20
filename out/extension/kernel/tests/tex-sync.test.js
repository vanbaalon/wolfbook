// Both sync directions, EXECUTED — not merely parsed.
//
//   node out/extension/kernel/tests/tex-sync.test.js
//
// WHY THIS EXISTS. A `const macros` declared below its own first use made every
// inverse click throw a TDZ ReferenceError: the click landed, the ping showed,
// and nothing else happened. `node --check` parses that file happily, the panel
// harness only exercises the WEBVIEW side, and the pure-function suites never
// call the handler. Nothing in the gate ran this code path at all.
//
// So this drives TexViewer.syncFromEditor and _jumpToSource end to end against
// stubs, on a document shaped like a real paper — user macros and all — and
// asserts what each direction posts and selects.

const assert = require('assert');
const Module = require('module');

let pass = 0; let fail = 0;
const results = [];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const { makeVscodeStub } = require('./_stub-vscode.js');
const stub = makeVscodeStub();

// Positions/ranges/selections the handler constructs.
class Position {
    constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
    constructor(a, b, c, d) {
        this.start = typeof a === 'object' ? a : new Position(a, b);
        this.end = typeof a === 'object' ? b : new Position(c, d);
    }
}
class Selection extends Range {}
stub.Position = Position;
stub.Range = Range;
stub.Selection = Selection;
stub.TextEditorRevealType = { InCenterIfOutsideViewport: 2 };
stub.ProgressLocation = { Notification: 15 };
stub.WorkspaceEdit = class {
    constructor() { this.ops = []; }
    replace(uri, range, text) { this.ops.push({ uri, range, text }); }
};

const origLoad = Module._load;
Module._load = function (req, ...rest) {
    return req === 'vscode' ? stub : origLoad.call(this, req, ...rest);
};
const { TexViewer } = require('../../tex/texViewer.js');
const { scanTex } = require('../../tex/texScanner');
const { buildModel } = require('../../tex/texModel');
const { RenderMap, FLAG } = require('../../tex/renderMap');
const { findWordInLine } = require('../../tex/texWords');
const { paragraphSpan } = require('../../tex/texSelect');
Module._load = origLoad;

// --- a document shaped like the real paper ----------------------------------
const FILE = '/paper/main.tex';
const SRC = [
    '\\documentclass{article}',
    '\\newcommand{\\SoV}{\\mathrm{SoV}}',
    '\\newcommand{\\bx}{\\boldsymbol{x}}',
    '\\begin{document}',
    'We write the transformed wavefunction as a thing worth reading twice.',
    '\\[',
    '  \\Psi_{\\SoV}(\\bx) := \\langle \\bx \\mid \\psi_{\\uparrow} \\rangle .',
    '\\]',
    'Then $E=mc^2$ closes the argument.',
    'For an on-shell state, let',
    '',
    // A paragraph of SEVERAL lines: selecting it instead of a word is only
    // visibly wrong when it spans more than the line that was clicked.
    'A long paragraph that runs across several source lines, so that',
    'selecting the paragraph instead of the word is unmistakable, and',
    'a clamp that keeps a plain click on one line can be measured.',
    '\\end{document}',
].join('\n');
const LINES = SRC.split('\n');

const offsetOf = (lines, p) => {
    let off = 0;
    for (let i = 0; i < p.line; i++) off += lines[i].length + 1;
    return off + p.character;
};
const posOf = (lines, off) => {
    let i = 0; let rem = off;
    while (i < lines.length - 1 && rem > lines[i].length) { rem -= lines[i].length + 1; i++; }
    return new Position(i, rem);
};

const makeDoc = () => ({
    uri: { fsPath: FILE, scheme: 'file', path: FILE },
    version: 1,
    lineCount: LINES.length,
    getText: (range) => range
        ? SRC.slice(offsetOf(LINES, range.start), offsetOf(LINES, range.end))
        : SRC,
    offsetAt: (p) => offsetOf(LINES, p),
    positionAt: (off) => posOf(LINES, off),
    lineAt: (i) => ({
        text: LINES[i],
        range: new Range(new Position(i, 0), new Position(i, LINES[i].length)),
    }),
});

/** A document the mini-editor tests can actually mutate, VS Code-shaped. */
class MutableDoc {
    constructor(text, fsPath) {
        this.uri = { fsPath, scheme: 'file', path: fsPath };
        this.version = 1;
        this._text = text;
    }
    get _lines() { return this._text.split('\n'); }
    get lineCount() { return this._lines.length; }
    lineAt(i) {
        const t = this._lines[i];
        return { text: t, range: new Range(new Position(i, 0), new Position(i, t.length)) };
    }
    getText(range) {
        if (!range) return this._text;
        return this._text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
    }
    offsetAt(p) { return offsetOf(this._lines, p); }
    positionAt(off) { return posOf(this._lines, off); }
    /** Mutate, and return the change event VS Code would fire. */
    applyChange(offset, length, text) {
        this._text = this._text.slice(0, offset) + text + this._text.slice(offset + length);
        this.version++;
        return {
            document: this,
            contentChanges: [{ rangeOffset: offset, rangeLength: length, text }],
        };
    }
}

/**
 * A RenderMap stand-in.
 *
 * `box` is what the box hierarchy would say, `row` what the printed-row lookup
 * would say. On a real paper those DISAGREE right above a display equation —
 * `\[` plants a zero-width record on the paragraph's last baseline — which is
 * the whole reason the handler consults both.
 */
function fakeMap(box, row, noRows) {
    boxCalls.length = 0;
    const model = buildModel(scanTex(SRC), { file: FILE });
    const objectAtLine = (file, line) => {
        const o = model.objects
            .filter(x => !['label', 'ref', 'cite'].includes(x.kind) &&
                x.sourceRange.startLine <= line && x.sourceRange.endLine >= line)
            .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
                (b.sourceRange.endLine - b.sourceRange.startLine))[0];
        return o ? { kind: o.kind, startLine: o.sourceRange.startLine, endLine: o.sourceRange.endLine } : null;
    };
    return {
        available: true,
        _baseFlag: () => FLAG.FRESH,
        // Either a fixed answer, or a function of the click point — a map that
        // returns the same line wherever you click cannot express "the reader
        // clicked somewhere else", which is exactly what the mini-editor's
        // stay-put rule needs to be tested against.
        renderToSource: (p, x, y) => (typeof box === 'function' ? box(p, x, y) : box),
        lineAtPoint: (p, x, y) => (typeof row === 'function' ? row(p, x, y) : (row || null)),
        objectAtLine,
        // One row per line, at a y derived from the line number, so a test can
        // tell which lines a highlight actually covers.
        lineRows: (f, line) => (noRows ? [] : [{ page: 1, x: 100, y: 100 * line, w: 300, h: 12 }]),
        // Deliberately TALLER than the rows and starting higher, the way a real
        // display's box does: it includes \abovedisplayskip and so reaches up
        // over the paragraph above.
        objectRenderBoxes: (o) => {
            boxCalls.push(o && o.kind);
            return { rects: [{ page: 1, x: 90, y: 100 * 5, w: 320, h: 400 }], flag: FLAG.FRESH };
        },
        sourceToRender: () => ({ page: 1, flag: FLAG.FRESH }),
    };
}

function makeViewer(hit, row, noRows) {
    const model = buildModel(scanTex(SRC), { file: FILE });
    const st = { map: fakeMap(hit, row, noRows), generation: { generation: 1, pageCount: 1 } };
    const coord = { roots: new Map([[FILE, st]]), rootFor: () => FILE, stateFor: () => st };
    const projection = { get: () => ({ model }) };
    const v = new TexViewer({ extensionUri: { fsPath: '/ext' } }, coord, projection);
    v.root = FILE;
    v.posted = [];
    v.panel = { webview: { postMessage: (msg) => v.posted.push(msg) } };
    return v;
}

const boxCalls = [];
const doc = makeDoc();
let selected = null;
stub.workspace.openTextDocument = async () => doc;
stub.window.showTextDocument = async () => ({
    document: doc,
    set selection(s) { selected = s; },
    get selection() { return selected; },
    revealRange: () => {},
});

// --- forward: editor -> viewer ----------------------------------------------

const editorAt = (line, character) => ({
    document: doc,
    selection: { active: new Position(line - 1, character) },
});

test('a cursor in prose posts a highlight naming the word', async () => {
    const v = makeViewer(null);
    v.syncFromEditor(editorAt(5, LINES[4].indexOf('wavefunction')));
    const h = v.posted.find(p => p.type === 'highlight');
    assert.ok(h, 'a highlight was posted');
    assert.strictEqual(h.word, 'wavefunction');
    assert.strictEqual(h.glyph, false, 'prose is not glyph-mode');
    assert.ok(h.rects.length, 'with rects');
});

test('a cursor on a MACRO in an equation posts its printed glyph', async () => {
    const v = makeViewer(null);
    v.syncFromEditor(editorAt(7, LINES[6].indexOf('\\bx')));
    const h = v.posted.find(p => p.type === 'highlight');
    assert.ok(h, 'a highlight was posted');
    assert.strictEqual(h.glyph, true, 'glyph mode');
    assert.strictEqual(h.word, 'x', `\\bx prints x, got ${JSON.stringify(h.word)}`);
});

test('a cursor inside INLINE maths is treated as maths, not the word before it', async () => {
    const v = makeViewer(null);
    v.syncFromEditor(editorAt(9, LINES[8].indexOf('mc')));
    const h = v.posted.find(p => p.type === 'highlight');
    assert.ok(h, 'a highlight was posted');
    assert.strictEqual(h.glyph, true, 'inline $…$ counts as maths');
    assert.ok(h.word && h.word.length === 1, `one glyph, got ${JSON.stringify(h.word)}`);
});

test('forward sync never scrolls the viewer right after an inverse click', async () => {
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 5, dx: 2 });
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'transformed', rowFraction: 0.3 });
    v.posted.length = 0;
    v.syncFromEditor(editorAt(5, 3));
    const h = v.posted.find(p => p.type === 'highlight');
    assert.strictEqual(h.reveal, false, 'no reveal so soon after a click');

    const v2 = makeViewer(null);
    v2.syncFromEditor(editorAt(5, 3));
    assert.strictEqual(v2.posted.find(p => p.type === 'highlight').reveal, true,
        'but an ordinary cursor move does reveal');
});

// --- inverse: viewer -> editor ----------------------------------------------

test('clicking a PROSE word selects exactly that word', async () => {
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 5, dx: 2 });
    selected = null;
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 });
    assert.ok(selected, 'something was selected — a TDZ here selects nothing at all');
    assert.strictEqual(selected.start.line, 4);
    assert.strictEqual(LINES[4].slice(selected.start.character, selected.end.character), 'wavefunction');
});

test('clicking a rendered MATHS glyph selects the macro that printed it', async () => {
    const eq = buildModel(scanTex(SRC), { file: FILE }).objects
        .find(o => o.kind === 'display-equation');
    assert.ok(eq, 'the fixture has a display equation');
    const v = makeViewer({
        file: FILE, line: 7, flag: FLAG.FRESH,
        object: { kind: eq.kind, startLine: eq.sourceRange.startLine, endLine: eq.sourceRange.endLine },
    }, { file: FILE, line: 7, dx: 2 });
    selected = null;
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, glyph: 'x', glyphFraction: 0.35 });
    assert.ok(selected, 'something was selected');
    const got = LINES[6].slice(selected.start.character, selected.end.character);
    assert.strictEqual(got, '\\bx', `expected the macro call, got ${JSON.stringify(got)}`);
});

test('A PLAIN REPEAT CLICK DOES NOT WIDEN — it stays on the symbol', async () => {
    // Widening on any repeat click turned an exploratory series of clicks into
    // a whole subsection selection. A plain click means "this word", always.
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 5, dx: 2 });
    const click = { page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 };
    await v._jumpToSource(click);
    const first = { a: selected.start.character, b: selected.end.character };
    for (let i = 0; i < 4; i++) await v._jumpToSource(click);
    assert.strictEqual(selected.start.character, first.a, 'still the same word');
    assert.strictEqual(selected.end.character, first.b, 'after five clicks');
    assert.strictEqual(LINES[4].slice(selected.start.character, selected.end.character),
        'wavefunction');
});

test('THE REPORTED BUG: a plain click NEVER selects a paragraph or section', async () => {
    // When no word resolves, the ladder's first rung is whatever comes after
    // the word — the paragraph, or with no paragraph the SECTION. So a click
    // whose word could not be matched silently selected the whole section,
    // which from the outside is "I clicked a word and got the whole paragraph".
    // A plain click must fall back to the LINE instead.
    const LN = LINES.findIndex(l => l.startsWith('selecting the paragraph')) + 1;
    assert.ok(LN > 1, 'the fixture has a multi-line paragraph');
    const para = paragraphSpan(LINES, LN);
    assert.ok(para.endLine - para.startLine >= 2,
        `and it really spans several lines (${para.startLine}-${para.endLine})`);

    const v = makeViewer({ file: FILE, line: LN, flag: FLAG.FRESH, object: null },
        { file: FILE, line: LN, dx: 2 });
    selected = null;
    // A word the PDF reports that is nowhere in the source line: the resolution
    // finds nothing, which is exactly the case that used to widen.
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'zzzznotpresent', rowFraction: 0.5 });
    assert.ok(selected, 'it still answers');
    assert.strictEqual(selected.start.line, selected.end.line,
        'and stays on ONE line rather than swallowing the paragraph');
    assert.strictEqual(selected.start.line, LN - 1, 'the line that was clicked');

    // Repeating it changes nothing — the complaint was about the second click.
    for (let i = 0; i < 3; i++) {
        await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'zzzznotpresent', rowFraction: 0.5 });
        assert.strictEqual(selected.start.line, selected.end.line, `still one line on click ${i + 2}`);
    }

    // Cmd-click is still how you ask for more.
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'zzzznotpresent', rowFraction: 0.5, widen: true });
    assert.ok(selected.end.line > selected.start.line || selected.end.character > selected.start.character,
        'widening still works when asked for');
});

test('an aligned click in PROSE selects the WORD, not one letter of it', async () => {
    // The alignment works character by character, which is right inside an
    // equation and wrong in a sentence. In prose its real contribution is the
    // LINE — the part SyncTeX gets wrong — so the word stays the unit.
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 5, dx: 2 });
    v.shownGeneration = 1;
    v._onMessage({
        type: 'textLayer', generation: 1, page: 1,
        items: [{ str: 'We write the transformed wavefunction', x: 100, y: 495, w: 200, h: 10, baseline: 505, font: 'f1' }],
    });
    selected = null;
    await v._jumpToSource({ page: 1, xBp: 180, yTopBp: 500, word: 'wavefunction', rowFraction: 0.6 });
    const got = LINES[4].slice(selected.start.character, selected.end.character);
    assert.strictEqual(got, 'wavefunction', `the whole word, got ${JSON.stringify(got)}`);
});

test('Cmd-click widens, and says how to keep going', async () => {
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 5, dx: 2 });
    const click = { page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 };
    await v._jumpToSource(click);
    const word = selected.end.character - selected.start.character;
    const s1 = v.posted.filter(p => p.type === 'status').pop();
    assert.ok(/click to widen/.test(s1.text), s1.text);

    // The FIRST Cmd-click must already be bigger: asking to widen and being
    // handed the same word back would look like nothing happened.
    await v._jumpToSource({ ...click, widen: true });
    const wider = (selected.end.line - selected.start.line) * 1000 +
        (selected.end.character - selected.start.character);
    assert.ok(wider > word, 'the first Cmd-click is already a container');

    await v._jumpToSource({ ...click, widen: true });
    const widest = (selected.end.line - selected.start.line) * 1000 +
        (selected.end.character - selected.start.character);
    assert.ok(widest > wider, 'and the next one is bigger still');

    await v._jumpToSource({ ...click, widen: true, shrink: true });
    const back = (selected.end.line - selected.start.line) * 1000 +
        (selected.end.character - selected.start.character);
    assert.ok(back < widest, 'Shift+Cmd steps back in');
});

test('a plain click after widening returns to the symbol', async () => {
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 5, dx: 2 });
    const click = { page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 };
    await v._jumpToSource({ ...click, widen: true });
    await v._jumpToSource({ ...click, widen: true });
    await v._jumpToSource(click);
    assert.strictEqual(LINES[4].slice(selected.start.character, selected.end.character),
        'wavefunction', 'the ladder resets');
});

test('a click far away starts a fresh ladder', async () => {
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 5, dx: 2 });
    const click = { page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 };
    await v._jumpToSource({ ...click, widen: true });
    await v._jumpToSource({ ...click, widen: true });               // widened
    // A plain click anywhere abandons the ladder and lands on the symbol.
    await v._jumpToSource({ ...click, xBp: 400, yTopBp: 700, word: 'thing', rowFraction: 0.7 });
    assert.strictEqual(LINES[4].slice(selected.start.character, selected.end.character), 'thing',
        'back to the tightest thing at the new place');

    // And a Cmd-click somewhere new starts that word's OWN ladder rather than
    // carrying on from where the previous one had got to.
    await v._jumpToSource({ ...click, widen: true, xBp: 900, yTopBp: 900, word: 'twice', rowFraction: 0.95 });
    const a = selected.start.character; const b = selected.end.character;
    assert.ok(a <= LINES[4].indexOf('twice') && b >= LINES[4].indexOf('twice') + 5,
        'the new selection contains the newly clicked word');
});

test('a click on the prose ABOVE an equation resolves to the prose', async () => {
    // The bug, exactly: `\[` plants a zero-width record on the paragraph's own
    // last baseline, so the box hierarchy answers with the equation. The
    // printed row says line 5, and the row is what the reader clicked.
    const eq = buildModel(scanTex(SRC), { file: FILE }).objects
        .find(o => o.kind === 'display-equation');
    const v = makeViewer(
        { file: FILE, line: 6, flag: FLAG.FRESH,
          object: { kind: eq.kind, startLine: eq.sourceRange.startLine, endLine: eq.sourceRange.endLine } },
        { file: FILE, line: 5, dx: 3 });
    selected = null;
    await v._jumpToSource({ page: 1, xBp: 300, yTopBp: 357, word: 'function', rowFraction: 0.95 });
    assert.ok(selected, 'something was selected');
    assert.strictEqual(selected.start.line, 4, 'the PROSE line, not the equation');
    // "function" is not literally on that line; "wavefunction" is, and the
    // containment fallback is allowed to land there. What must NOT happen is
    // the whole equation being selected.
    const got = LINES[4].slice(selected.start.character, selected.end.character);
    assert.ok(/function/.test(got), `a word on the prose line, got ${JSON.stringify(got)}`);
    assert.strictEqual(selected.end.line, 4, 'and it does not run into the display below');
});

test('the box answer still wins when the row lookup finds nothing', async () => {
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null }, null);
    selected = null;
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 });
    assert.ok(selected, 'it still answers');
    assert.strictEqual(LINES[4].slice(selected.start.character, selected.end.character), 'wavefunction');
});

test('a row hit far from any ink is not trusted', async () => {
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 9, dx: 400 });
    selected = null;
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 });
    assert.strictEqual(selected.start.line, 4, 'it fell back to the box answer');
});

test('a prose word next to an equation selects the WORD, not one letter', async () => {
    // `objectAtLine` reports the NEAREST object when none contains the line, so
    // this prose line comes back as the display equation above it. Deciding
    // "maths or prose" from that made the handler read prose glyph-by-glyph:
    // clicking "For" selected "F".
    const eq = buildModel(scanTex(SRC), { file: FILE }).objects
        .find(o => o.kind === 'display-equation');
    const lineNo = LINES.findIndex(l => l.startsWith('For an on-shell')) + 1;
    assert.ok(lineNo > 0, 'the fixture has the prose line');
    const v = makeViewer(
        { file: FILE, line: lineNo, flag: FLAG.FRESH,
          object: { kind: eq.kind, approximate: true,
                    startLine: eq.sourceRange.startLine, endLine: eq.sourceRange.endLine } },
        { file: FILE, line: lineNo, dx: 2 });
    selected = null;
    // The viewer sends BOTH readings; the handler must prefer the word.
    await v._jumpToSource({
        page: 1, xBp: 100, yTopBp: 100,
        word: 'For', rowFraction: 0.02, glyph: 'F', glyphFraction: 0.02,
    });
    assert.ok(selected, 'something was selected');
    const got = LINES[lineNo - 1].slice(selected.start.character, selected.end.character);
    assert.strictEqual(got, 'For', `the whole word, got ${JSON.stringify(got)}`);
});

test('a maths glyph still wins where the prose reading finds nothing', async () => {
    const eq = buildModel(scanTex(SRC), { file: FILE }).objects
        .find(o => o.kind === 'display-equation');
    const v = makeViewer(
        { file: FILE, line: 7, flag: FLAG.FRESH,
          object: { kind: eq.kind, startLine: eq.sourceRange.startLine, endLine: eq.sourceRange.endLine } },
        { file: FILE, line: 7, dx: 2 });
    selected = null;
    await v._jumpToSource({
        page: 1, xBp: 100, yTopBp: 100,
        word: 'x', rowFraction: 0.35, glyph: 'x', glyphFraction: 0.35,
    });
    const got = LINES[6].slice(selected.start.character, selected.end.character);
    assert.strictEqual(got, '\\bx', `the macro, got ${JSON.stringify(got)}`);
});

test('an equation highlight uses its ROWS, never its over-tall box', async () => {
    // Measured on the real paper: the display's box is y=470.1 h=34.4 while its
    // rows are y=491.2 h=13.5 — the box reaches 21bp higher, straight over the
    // paragraph above, which is the amber band that covered the prose.
    const v = makeViewer(null, null);
    v.syncFromEditor(editorAt(7, 4));
    const h = v.posted.find(p => p.type === 'highlight');
    assert.ok(h && h.rects.length, 'a highlight was posted');
    assert.deepStrictEqual(boxCalls, [], 'objectRenderBoxes was not consulted');
    // Every rect must belong to a line of the equation (rows are at 100*line).
    for (const r of h.rects) {
        const line = r.y / 100;
        assert.ok(line >= 6 && line <= 8, `rect at line ${line} is outside the equation`);
    }
});

test('the box is still the fallback when an object has no rows of its own', async () => {
    const v = makeViewer(null, null, true);          // lineRows returns nothing
    v.syncFromEditor(editorAt(7, 4));
    const h = v.posted.find(p => p.type === 'highlight');
    assert.ok(h && h.rects.length, 'a figure-like object still highlights');
    assert.ok(boxCalls.length > 0, 'via the box');
});

test('an unmapped click says so instead of throwing', async () => {
    const v = makeViewer(null, null);
    await v._jumpToSource({ page: 1, xBp: 1, yTopBp: 1 });
    const s = v.posted.filter(p => p.type === 'status').pop();
    assert.ok(s && /nothing there/.test(s.text), 'it reports, quietly');
});

// --- operators, occurrences, and the neighbouring-line rescue ----------------

const eqObject = () => {
    const eq = buildModel(scanTex(SRC), { file: FILE }).objects
        .find(o => o.kind === 'display-equation');
    return { kind: eq.kind, startLine: eq.sourceRange.startLine, endLine: eq.sourceRange.endLine };
};

test('clicking a rendered ARROW selects the \\uparrow that printed it', async () => {
    // Operators are all category Sm — the old letters-and-digits glyph class
    // excluded every one of them, so a click on ↑ resolved to a nearby letter.
    const v = makeViewer({ file: FILE, line: 7, flag: FLAG.FRESH, object: eqObject() },
        { file: FILE, line: 7, dx: 2 });
    selected = null;
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, glyph: '↑', glyphFraction: 0.8 });
    assert.ok(selected, 'something was selected');
    const got = LINES[6].slice(selected.start.character, selected.end.character);
    assert.strictEqual(got, '\\uparrow', `expected the arrow command, got ${JSON.stringify(got)}`);
});

test('the viewer\'s occurrence index picks the SECOND \\bx exactly', async () => {
    // Line 7 prints two x glyphs, both from \bx calls. The fraction hint says
    // "first"; the counted occurrence must win.
    const v = makeViewer({ file: FILE, line: 7, flag: FLAG.FRESH, object: eqObject() },
        { file: FILE, line: 7, dx: 2 });
    selected = null;
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, glyph: 'x', glyphFraction: 0.0, glyphOccurrence: 2 });
    const second = LINES[6].indexOf('\\bx', LINES[6].indexOf('\\bx') + 1);
    assert.strictEqual(selected.start.character, second,
        'the second call, not the one the fraction hint favours');
});

test('a glyph attributed to a neighbouring line of the SAME equation is rescued', async () => {
    // In a display, TeX attributes some records to the \] line. The clicked
    // glyph is not there — but it IS on another line of the same object, and
    // the handler must look before falling back to "the whole line".
    const v = makeViewer({ file: FILE, line: 8, flag: FLAG.FRESH, object: eqObject() },
        { file: FILE, line: 8, dx: 2 });
    selected = null;
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, glyph: 'x', glyphFraction: 0.3 });
    assert.ok(selected, 'something was selected');
    assert.strictEqual(selected.start.line, 6, 'the equation body line (0-based 6)');
    const got = LINES[6].slice(selected.start.character, selected.end.character);
    assert.strictEqual(got, '\\bx', `expected the macro on the rescued line, got ${JSON.stringify(got)}`);
});

// --- the mini-editor session -------------------------------------------------

test('the mini-editor round trip: open, type, no echo, editor change flows back', async () => {
    const mdoc = new MutableDoc(SRC, FILE);
    const oldOpen = stub.workspace.openTextDocument;
    const listeners = [];
    stub.workspace.onDidChangeTextDocument = (fn) => { listeners.push(fn); return { dispose() {} }; };
    stub.workspace.openTextDocument = async () => mdoc;
    let applied = null;
    stub.workspace.applyEdit = async (we) => {
        applied = we;
        const op = we.ops[0];
        const so = mdoc.offsetAt(op.range.start);
        const eo = mdoc.offsetAt(op.range.end);
        const ev = mdoc.applyChange(so, eo - so, op.text);
        for (const fn of listeners) fn(ev);      // VS Code fires the event
        return true;
    };
    try {
        const v = makeViewer({ file: FILE, line: 7, flag: FLAG.FRESH, object: null },
            { file: FILE, line: 7, dx: 2 });

        // Right-click on the equation opens ITS lines, anchored to its rows.
        await v._onMessage({ type: 'editHere', page: 1, xBp: 100, yTopBp: 700 });
        const eo = v.posted.find(p => p.type === 'editOpen');
        assert.ok(eo, 'an editOpen was posted');
        assert.strictEqual(eo.startLine, 6);
        assert.strictEqual(eo.endLine, 8);
        assert.ok(eo.text.includes('\\Psi_{\\SoV}'), 'with the block source');
        assert.ok(eo.rects.length >= 1, 'anchored to the block');

        // Typing in the card becomes a WorkspaceEdit on the REAL document…
        v.posted.length = 0;
        await v._onMessage({ type: 'editChange', editId: eo.editId, text: '\\[\n  E = mc^2\n\\]' });
        assert.ok(applied, 'a WorkspaceEdit was applied');
        assert.ok(mdoc.getText().includes('E = mc^2'), 'and the document really changed');
        // …whose own change event must NOT echo back into the card.
        assert.ok(!v.posted.find(p => p.type === 'editUpdate'), 'no echo of our own edit');

        // An edit made in the TEXT EDITOR inside the block flows to the card.
        v.posted.length = 0;
        const at = mdoc.getText().indexOf('mc^2');
        for (const fn of listeners) fn(mdoc.applyChange(at, 4, 'xy'));
        const up = v.posted.find(p => p.type === 'editUpdate');
        assert.ok(up, 'an external change posts an update');
        assert.ok(up.text.includes('E = xy'), `the card gets the new text, got ${JSON.stringify(up.text)}`);

        // An edit ABOVE the block shifts it silently — same text, new offsets.
        v.posted.length = 0;
        const before = { s: v._edit.startOffset, e: v._edit.endOffset };
        for (const fn of listeners) fn(mdoc.applyChange(0, 0, '% note\n'));
        assert.strictEqual(v._edit.startOffset, before.s + 7, 'the block moved down');
        assert.ok(!v.posted.find(p => p.type === 'editUpdate'), 'and nothing was reposted');

        // Closing forgets the session.
        await v._onMessage({ type: 'editClose', editId: eo.editId });
        assert.strictEqual(v._edit, null);
    } finally {
        stub.workspace.openTextDocument = oldOpen;
        stub.workspace.applyEdit = async () => true;
    }
});

test('with the card open, an inverse click puts the caret INSIDE it', async () => {
    const mdoc = new MutableDoc(SRC, FILE);
    const oldOpen = stub.workspace.openTextDocument;
    stub.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
    stub.workspace.openTextDocument = async () => mdoc;
    try {
        // High on the page is the prose line 5; low is the equation, line 7.
        const where = (p, x, y) => (y > 400
            ? { file: FILE, line: 7, dx: 2 }
            : { file: FILE, line: 5, dx: 2 });
        const v = makeViewer(
            (p, x, y) => ({ ...where(p, x, y), flag: FLAG.FRESH, object: y > 400 ? eqObject() : null }),
            where);
        await v._onMessage({ type: 'editHere', page: 1, xBp: 100, yTopBp: 700 });
        const eo = v.posted.find(p => p.type === 'editOpen');
        assert.ok(eo, 'the card opened');
        assert.strictEqual(eo.startLine, 6, 'on the equation');

        // Click the rendered x of \bx: the caret must land on that macro, at
        // offsets RELATIVE TO THE BLOCK the card is showing.
        v.posted.length = 0;
        await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 700, glyph: 'x', glyphFraction: 0.35 });
        const sel = v.posted.find(p => p.type === 'editSelect');
        assert.ok(sel, 'an editSelect was posted');
        assert.strictEqual(sel.editId, eo.editId);
        assert.strictEqual(eo.text.slice(sel.start, sel.end), '\\bx',
            `the card offsets must slice the macro, got ${JSON.stringify(eo.text.slice(sel.start, sel.end))}`);
        assert.strictEqual(sel.focus, true, 'a plain click focuses the card');

        // A double-click means "take me to the editor" — the card must not
        // steal the focus back.
        v.posted.length = 0;
        await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 700, glyph: 'x', glyphFraction: 0.35, takeMe: true });
        const sel2 = v.posted.find(p => p.type === 'editSelect');
        assert.ok(sel2 && sel2.focus === false, 'still selects, but does not focus');

        // A click OUTSIDE the open block leaves the card alone: moving it to
        // wherever the reader last clicked would take their work off screen.
        v.posted.length = 0;
        await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 });
        assert.ok(!v.posted.find(p => p.type === 'editSelect'), 'no editSelect for a hit outside the block');
    } finally {
        stub.workspace.openTextDocument = oldOpen;
    }
});

test('a right-click ALSO puts the caret where it was clicked', async () => {
    // Opening the block is only half of it: a right-click is still a click, so
    // the caret belongs on the symbol under the pointer — in the editor, and in
    // the card that just opened.
    const mdoc = new MutableDoc(SRC, FILE);
    const oldOpen = stub.workspace.openTextDocument;
    stub.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
    stub.workspace.openTextDocument = async () => mdoc;
    try {
        const v = makeViewer({ file: FILE, line: 7, flag: FLAG.FRESH, object: eqObject() },
            { file: FILE, line: 7, dx: 2 });
        selected = null;
        await v._onMessage({
            type: 'editHere', page: 1, xBp: 100, yTopBp: 700,
            glyph: 'x', glyphFraction: 0.35,
        });
        const eo = v.posted.find(p => p.type === 'editOpen');
        assert.ok(eo, 'the card opened');
        assert.ok(selected, 'and the caret moved');
        const got = LINES[6].slice(selected.start.character, selected.end.character);
        assert.strictEqual(got, '\\bx', `to the clicked symbol, got ${JSON.stringify(got)}`);
        const sel = v.posted.find(p => p.type === 'editSelect');
        assert.ok(sel, 'and the card was told where, so its caret lands there too');
        assert.strictEqual(eo.text.slice(sel.start, sel.end), '\\bx');
    } finally {
        stub.workspace.openTextDocument = oldOpen;
    }
});

test('a right-click on PROSE opens the paragraph, not a container', async () => {
    const mdoc = new MutableDoc(SRC, FILE);
    const oldOpen = stub.workspace.openTextDocument;
    stub.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
    stub.workspace.openTextDocument = async () => mdoc;
    try {
        const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
            { file: FILE, line: 5, dx: 2 });
        await v._onMessage({ type: 'editHere', page: 1, xBp: 100, yTopBp: 500 });
        const eo = v.posted.find(p => p.type === 'editOpen');
        assert.ok(eo, 'an editOpen was posted');
        assert.strictEqual(eo.label, 'paragraph');
        assert.strictEqual(eo.startLine, 5);
        assert.strictEqual(eo.endLine, 5, 'the display below is NOT swallowed');
        assert.ok(eo.text.startsWith('We write'), `got ${JSON.stringify(eo.text)}`);
    } finally {
        stub.workspace.openTextDocument = oldOpen;
    }
});

// --- comparing two versions --------------------------------------------------

test('COMPARING posts a session naming, placing and counting every change', async () => {
    const mdoc = new MutableDoc(SRC, FILE);
    const oldOpen = stub.workspace.openTextDocument;
    stub.workspace.openTextDocument = async () => mdoc;
    try {
        const v = makeViewer(null, { file: FILE, line: 5, dx: 2 });
        // Their version: one prose word changed, one line inserted.
        const theirs = SRC
            .replace('transformed wavefunction', 'transformed WAVEPACKET')
            .replace('\nThen $E=mc^2$', '\nA WHOLLY NEW LINE.\nThen $E=mc^2$');
        v.posted.length = 0;
        await v.compareWith({ text: theirs, label: 'the file on disk' });

        const msg = v.posted.find(p => p.type === 'diff');
        assert.ok(msg && msg.session, 'a diff session was posted');
        assert.strictEqual(msg.session.label, 'the file on disk');
        assert.strictEqual(msg.session.hunks.length, 2, 'one change and one insertion');

        const change = msg.session.hunks.find(h => h.kind === 'change');
        const add = msg.session.hunks.find(h => h.kind === 'add');
        assert.ok(change && add, 'both kinds present');
        assert.ok(change.rects.length, 'the change is placed on the page');
        assert.strictEqual(change.where, 'rows');
        assert.ok(add.rects.length && add.rects[0].caret, 'the insertion is a caret, not a wash');

        // The census must never imply it showed everything.
        assert.ok(/2 changes/.test(msg.session.census), msg.session.census);
        assert.strictEqual(msg.session.summary.total, 2);
    } finally {
        stub.workspace.openTextDocument = oldOpen;
    }
});

test('THEIR CHANGE READS AS THEIRS: comparing against the older side inverts', async () => {
    // Against a git revision, a line only WE have was added by us. Against the
    // text the file held before somebody else wrote to it, the same hunk means
    // they added it. Same diff, opposite reading — so the direction is carried
    // and the presentation swapped once, at the boundary.
    const mdoc = new MutableDoc(SRC, FILE);
    const oldOpen = stub.workspace.openTextDocument;
    stub.workspace.openTextDocument = async () => mdoc;
    try {
        const v = makeViewer(null, { file: FILE, line: 5, dx: 2 });
        // The previous content lacked a line we now have: THEY added it.
        const before = SRC.replace('Then $E=mc^2$ closes the argument.\n', '');
        v.posted.length = 0;
        await v.compareWith({ text: before, label: 'the version you were looking at', invert: true });
        const shown = v.posted.find(p => p.type === 'diff').session.hunks;
        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].kind, 'add', 'presented as an ADDITION, because they added it');

        // Without the flag the very same comparison reads the other way.
        v.posted.length = 0;
        await v.compareWith({ text: before, label: 'an older revision' });
        assert.strictEqual(v.posted.find(p => p.type === 'diff').session.hunks[0].kind, 'del',
            'against an older revision, a line only we have is one WE added');
    } finally {
        stub.workspace.openTextDocument = oldOpen;
    }
});

test('a comparison RE-PLACES itself when the pages move', async () => {
    // A recompile shifts every line. Rects measured against the previous
    // generation would mark whatever now sits there — the trap the cursor
    // highlight avoids by dropping itself. Here the list is being worked
    // through, so it is recomputed instead.
    const mdoc = new MutableDoc(SRC, FILE);
    const oldOpen = stub.workspace.openTextDocument;
    const oldDocs = stub.workspace.textDocuments;
    stub.workspace.openTextDocument = async () => mdoc;
    // The production path takes no argument and finds the open document, so
    // that is the path the test drives.
    stub.workspace.textDocuments = [mdoc];
    try {
        const v = makeViewer(null, { file: FILE, line: 5, dx: 2 });
        await v.compareWith({ text: SRC.replace('twice', 'THRICE'), label: 'disk' });
        const first = v.posted.find(p => p.type === 'diff').session.hunks[0];
        assert.ok(first.rects.length, 'placed once');

        // The document grows by three lines above the change. That insertion
        // is itself a difference, so the original hunk is no longer first —
        // which is exactly why hunks are found by a content-derived id and not
        // by position.
        mdoc.applyChange(0, 0, 'a\nb\nc\n');
        v.posted.length = 0;
        v.refreshComparison();
        const hunks = v.posted.find(p => p.type === 'diff').session.hunks;
        const again = hunks.find(h => h.id === first.id);
        assert.ok(again, `the same hunk is still there: ${JSON.stringify(hunks.map(h => h.id))}`);
        assert.strictEqual(again.startLine, first.startLine + 3,
            'and it followed the text down the file');
        assert.ok(hunks.length > 1, 'while the new text shows up as its own change');
    } finally {
        stub.workspace.openTextDocument = oldOpen;
        stub.workspace.textDocuments = oldDocs;
    }
});

test('an identical version reports no differences rather than an empty rail', async () => {
    const mdoc = new MutableDoc(SRC, FILE);
    const oldOpen = stub.workspace.openTextDocument;
    stub.workspace.openTextDocument = async () => mdoc;
    try {
        const v = makeViewer(null, { file: FILE, line: 5, dx: 2 });
        v.posted.length = 0;
        await v.compareWith({ text: SRC, label: 'HEAD' });
        assert.strictEqual(v.posted.find(p => p.type === 'diff').session.hunks.length, 0);
        const said = v.posted.filter(p => p.type === 'status').map(p => p.text);
        assert.ok(said.some(t => /no differences against HEAD/.test(t)), JSON.stringify(said));
    } finally {
        stub.workspace.openTextDocument = oldOpen;
    }
});

test('focusing a hunk moves the editor AND tells the page', async () => {
    const mdoc = new MutableDoc(SRC, FILE);
    const oldOpen = stub.workspace.openTextDocument;
    const oldShow = stub.window.showTextDocument;
    stub.workspace.openTextDocument = async () => mdoc;
    let sel = null;
    stub.window.showTextDocument = async () => ({
        document: mdoc,
        set selection(x) { sel = x; }, get selection() { return sel; },
        revealRange() {}, setDecorations() {},
    });
    try {
        const v = makeViewer(null, { file: FILE, line: 5, dx: 2 });
        await v.compareWith({
            text: SRC.replace('transformed wavefunction', 'transformed WAVEPACKET'),
            label: 'disk',
        });
        const id = v.posted.find(p => p.type === 'diff').session.hunks[0].id;
        v.posted.length = 0;
        await v._onMessage({ type: 'diffFocus', id });
        assert.ok(v.posted.find(p => p.type === 'diffFocus'), 'the page was told');
        assert.ok(sel, 'and the editor selection moved to the change');
        assert.strictEqual(sel.start.line, 4);
    } finally {
        stub.workspace.openTextDocument = oldOpen;
        stub.window.showTextDocument = oldShow;
    }
});

test('closing the comparison clears it on both sides', async () => {
    const mdoc = new MutableDoc(SRC, FILE);
    const oldOpen = stub.workspace.openTextDocument;
    stub.workspace.openTextDocument = async () => mdoc;
    try {
        const v = makeViewer(null, { file: FILE, line: 5, dx: 2 });
        await v.compareWith({ text: SRC.replace('twice', 'THRICE'), label: 'disk' });
        assert.ok(v._diff, 'a comparison is open');
        v.posted.length = 0;
        await v._onMessage({ type: 'diffClose' });
        assert.strictEqual(v._diff, null);
        const msg = v.posted.find(p => p.type === 'diff');
        assert.ok(msg && msg.session === null, 'and the page was told to clear');
    } finally {
        stub.workspace.openTextDocument = oldOpen;
    }
});

// --- full screen ------------------------------------------------------------

test('FULL SCREEN SURVIVES an inverse click and a right-click', async () => {
    // Full screen is `toggleMaximizeEditorGroup`: only the viewer's group is on
    // screen. `showTextDocument` in column ONE makes another group visible and
    // VS Code cancels the maximize to do it — so every click dropped the reader
    // out of full screen, which is exactly the mode the mini-editor is for.
    const mdoc = new MutableDoc(SRC, FILE);
    const oldShow = stub.window.showTextDocument;
    const oldOpen = stub.workspace.openTextDocument;
    stub.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
    stub.workspace.openTextDocument = async () => mdoc;
    let shown = 0;
    stub.window.showTextDocument = async () => { shown++; return null; };
    stub.window.visibleTextEditors = [];
    try {
        const v = makeViewer({ file: FILE, line: 7, flag: FLAG.FRESH, object: eqObject() },
            { file: FILE, line: 7, dx: 2 });
        v._fsActions = ['workbench.action.toggleMaximizeEditorGroup'];

        await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 700, glyph: 'x', glyphFraction: 0.35 });
        assert.strictEqual(shown, 0, 'a plain click reveals nothing while full screen');
        assert.ok(v._fsActions, 'and stays full screen');

        v.posted.length = 0;
        await v._onMessage({ type: 'editHere', page: 1, xBp: 100, yTopBp: 700, glyph: 'x' });
        assert.strictEqual(shown, 0, 'nor does a right-click');
        assert.ok(v._fsActions, 'which is the whole point: edit in the card, full screen');
        assert.ok(v.posted.find(p => p.type === 'editOpen'), 'the card still opened');
        assert.ok(v.posted.find(p => p.type === 'editSelect'), 'with the caret placed in it');

        // "Take me there" still means exactly that.
        await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 700, glyph: 'x', takeMe: true });
        assert.strictEqual(shown, 1, 'a double-click DOES reveal the editor');
        assert.strictEqual(v._fsActions, null, 'and leaves full screen');
    } finally {
        stub.window.showTextDocument = oldShow;
        stub.workspace.openTextDocument = oldOpen;
        stub.window.visibleTextEditors = undefined;
    }
});

test('while full screen it still uses an editor that IS already visible', async () => {
    const oldShow = stub.window.showTextDocument;
    let shown = 0;
    stub.window.showTextDocument = async () => { shown++; return null; };
    let sel = null;
    stub.window.visibleTextEditors = [{
        document: doc,
        set selection(x) { sel = x; },
        get selection() { return sel; },
        revealRange() {},
        setDecorations() {},
    }];
    try {
        const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
            { file: FILE, line: 5, dx: 2 });
        v._fsActions = ['workbench.action.toggleMaximizeEditorGroup'];
        await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 });
        assert.strictEqual(shown, 0, 'nothing was revealed');
        assert.ok(sel, 'but the visible editor DID move — no reason to waste it');
        assert.strictEqual(LINES[4].slice(sel.start.character, sel.end.character), 'wavefunction');
    } finally {
        stub.window.showTextDocument = oldShow;
        stub.window.visibleTextEditors = undefined;
    }
});

// --- the glyph alignment, THROUGH THE VIEWER ---------------------------------
//
// glyphAlign is proven on its own in tex-align.test.js. What can still be
// broken is the WIRE: the webview's text layer arriving, being kept for the
// right generation, and actually being consulted by both handlers. A pure
// suite cannot see any of that, and this project has already shipped a dead
// feature whose parts all worked.

test('the aligned map answers a click that name matching could never resolve', async () => {
    const eq = eqObject();
    const v = makeViewer({ file: FILE, line: 8, flag: FLAG.FRESH, object: eq },
        { file: FILE, line: 8, dx: 2 });
    v.shownGeneration = 1;
    // The equation body is line 7; SyncTeX here names line 8 (the \]), exactly
    // as it does on a real paper — so a per-line search looks in the wrong
    // line and finds nothing.
    const per = findWordInLine(LINES[7], 'Ψ', 0.1, { scope: 'math', inMath: true });
    assert.strictEqual(per, null, 'the fixture really does defeat the old path');

    // The webview hands over the glyphs, in the extension's own bp frame. The
    // rows the fake map reports for the equation are at y = 100*line.
    v._onMessage({
        type: 'textLayer', generation: 1, page: 1,
        items: [
            { str: 'Ψ', x: 100, y: 700, w: 8, h: 10, baseline: 710 },
            { str: 'SoV', x: 108, y: 704, w: 14, h: 7, baseline: 712 },
            { str: 'x', x: 130, y: 700, w: 6, h: 10, baseline: 710 },
        ],
    });
    selected = null;
    // A click on the Ψ, by POSITION — no glyph name is sent at all.
    await v._jumpToSource({ page: 1, xBp: 103, yTopBp: 705 });
    assert.ok(selected, 'it resolved');
    assert.strictEqual(selected.start.line, 6, 'to the equation BODY line, not the \\] line');
    const got = LINES[6].slice(selected.start.character, selected.end.character);
    assert.strictEqual(got, '\\Psi', `expected the command, got ${JSON.stringify(got)}`);
});

test('and the forward direction highlights that same glyph', async () => {
    // The map must answer lineAtPoint: the alignment filters every text item
    // through the coarse anchor, which is what keeps the prose around an
    // equation out of its glyph sequence.
    const v = makeViewer(null, { file: FILE, line: 7, dx: 2 });
    v.shownGeneration = 1;
    v._onMessage({
        type: 'textLayer', generation: 1, page: 1,
        items: [
            { str: 'Ψ', x: 100, y: 700, w: 8, h: 10, baseline: 710 },
            { str: 'x', x: 130, y: 700, w: 6, h: 10, baseline: 710 },
        ],
    });
    v.posted.length = 0;
    v.syncFromEditor(editorAt(7, LINES[6].indexOf('\\Psi') + 1));
    const h = v.posted.find(p => p.type === 'highlight');
    assert.ok(h, 'a highlight was posted');
    assert.strictEqual(h.rects.length, 1, 'ONE rect — the glyph, not the whole row');
    assert.strictEqual(h.rects[0].x, 100, 'at the Ψ');
    assert.strictEqual(h.rects[0].w, 8);
    assert.ok(!h.word, 'and no name for the webview to re-match — the rect is exact');
});

test('a text layer from a STALE generation is never used', async () => {
    const v = makeViewer(null, null);
    v.shownGeneration = 2;
    v._onMessage({ type: 'textLayer', generation: 1, page: 1,
        items: [{ str: 'Ψ', x: 100, y: 700, w: 8, h: 10, baseline: 710 }] });
    assert.strictEqual(v._textReady(), false, 'geometry from the previous compile is refused');
    v.posted.length = 0;
    v.syncFromEditor(editorAt(7, LINES[6].indexOf('\\Psi') + 1));
    const h = v.posted.find(p => p.type === 'highlight');
    assert.ok(h && h.word, 'so it falls back to the per-line path, which names a word');
});

test('a newer generation clears the old alignment cache', async () => {
    const v = makeViewer(null, { file: FILE, line: 7, dx: 2 });
    v.shownGeneration = 1;
    v._onMessage({ type: 'textLayer', generation: 1, page: 1,
        items: [{ str: 'Ψ', x: 100, y: 700, w: 8, h: 10, baseline: 710 }] });
    v.syncFromEditor(editorAt(7, LINES[6].indexOf('\\Psi') + 1));
    assert.ok(v._objMaps.size > 0, 'an alignment was cached');
    v._onMessage({ type: 'textLayer', generation: 2, page: 1, items: [] });
    assert.strictEqual(v._objMaps.size, 0, 'and dropped when the pages changed');
    assert.strictEqual(v._text.generation, 2);
});

// --- the Compile button, and the flash ---------------------------------------

test('THE COMPILE BUTTON compiles the panel\'s OWN paper, with no editor focused', async () => {
    // It used to run `wolfbook.tex.compile`, whose first line reads
    // `vscode.window.activeTextEditor` — and pressing a button in a webview
    // means focus is in the webview, so there is no active editor. The command
    // warned into the corner of the screen and the button did nothing at all.
    const v = makeViewer(null, null);
    stub.window.activeTextEditor = undefined;
    let built = null;
    v.coord.build = async (d, opts) => {
        built = { file: d.uri.fsPath, opts };
        return { generation: { generation: 2, pageCount: 3, errors: 0, warnings: 1 } };
    };
    let commanded = 0;
    const oldCmd = stub.commands.executeCommand;
    stub.commands.executeCommand = async () => { commanded++; };
    try {
        await v._onMessage({ type: 'recompile' });
        assert.ok(built, 'it built something');
        assert.strictEqual(built.file, FILE, 'the paper this panel is showing');
        assert.strictEqual(built.opts.force, true, 'and really rebuilt it');
        assert.strictEqual(commanded, 0, 'without bouncing through the editor-only command');
        // The refresh that follows posts its own status, so look for ours
        // among them rather than assuming it is last.
        const said = v.posted.filter(p => p.type === 'status').map(p => p.text);
        assert.ok(said.some(t => /3 pages/.test(t)), `and reported back: ${JSON.stringify(said)}`);
    } finally {
        stub.commands.executeCommand = oldCmd;
    }
});

test('a failed compile is reported in the panel, not swallowed', async () => {
    const v = makeViewer(null, null);
    v.coord.build = async () => ({ lastError: 'Undefined control sequence' });
    await v._onMessage({ type: 'recompile' });
    const err = v.posted.filter(p => p.type === 'status')
        .find(p => /Undefined control sequence/.test(p.text));
    assert.ok(err, JSON.stringify(v.posted.filter(p => p.type === 'status').map(p => p.text)));
    assert.strictEqual(err.kind, 'err');
});

test('an inverse click FLASHES the editor selection, then clears it', async () => {
    // The page marks where you are with a wash that fades; the editor end of
    // the same gesture should land the same way rather than just appearing.
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 5, dx: 2 });
    const painted = [];
    const ed = {
        document: doc,
        set selection(x) { selected = x; },
        get selection() { return selected; },
        revealRange: () => {},
        setDecorations: (type, ranges) => { if (ranges.length) painted.push(type); },
    };
    const oldShow = stub.window.showTextDocument;
    stub.window.showTextDocument = async () => ed;
    let made = 0;
    stub.window.createTextEditorDecorationType = (o) => ({ o, dispose() {} });
    stub.OverviewRulerLane = { Center: 2 };
    try {
        await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 });
        assert.ok(painted.length >= 1, 'something was painted over the selection');
        // Falling alpha: the first step is the strongest.
        const a = (t) => Number(/rgba\(255,196,0,([\d.]+)\)/.exec(t.o.backgroundColor)[1]);
        assert.ok(a(painted[0]) > 0.2, `starts visible: ${a(painted[0])}`);
        assert.ok(v._flash._types.length > 1, 'and it has steps to fade through');
        const alphas = v._flash._types.map(a);
        for (let i = 1; i < alphas.length; i++) {
            assert.ok(alphas[i] < alphas[i - 1], 'each step is fainter than the last');
        }
        v._flash.clear();
    } finally {
        stub.window.showTextDocument = oldShow;
        void made;
    }
});

test('a host with no overview-ruler enum still jumps', async () => {
    // Reading `.Center` off an undefined enum threw out of EVERY inverse click.
    // Decoration is decoration: it must never be able to break the navigation.
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 5, dx: 2 });
    const saved = stub.OverviewRulerLane;
    delete stub.OverviewRulerLane;
    stub.window.createTextEditorDecorationType = () => { throw new Error('no decorations here'); };
    try {
        selected = null;
        await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 });
        assert.ok(selected, 'the jump still happened');
        assert.strictEqual(LINES[4].slice(selected.start.character, selected.end.character), 'wavefunction');
    } finally {
        stub.OverviewRulerLane = saved;
        stub.window.createTextEditorDecorationType = () => ({ dispose() {} });
    }
});

// --- page theme --------------------------------------------------------------
//
// These rewrite window/workspace on the shared stub, so each restores what it
// found: a leaked getConfiguration would quietly change what every later test
// is running against.
const STUB0 = {
    getConfiguration: stub.workspace.getConfiguration,
    activeColorTheme: stub.window.activeColorTheme,
};
const restoreStub = () => {
    stub.workspace.getConfiguration = STUB0.getConfiguration;
    stub.window.activeColorTheme = STUB0.activeColorTheme;
};

test('page theme: auto follows VS Code, and light/dark override it', async () => {
    const v = makeViewer(null, null);
    const cfg = { pageTheme: 'auto' };
    stub.workspace.getConfiguration = () => ({
        get: (k, dflt) => (k === 'pageTheme' ? cfg.pageTheme : dflt),
        update: async (k, val) => { cfg.pageTheme = val; },
    });
    const setTheme = (kind) => { stub.window.activeColorTheme = { kind }; };
    stub.ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };

    setTheme(1); assert.strictEqual(v.pageTheme(), 'light', 'a light theme');
    setTheme(2); assert.strictEqual(v.pageTheme(), 'dark', 'a dark theme');
    setTheme(3); assert.strictEqual(v.pageTheme(), 'dark', 'high contrast dark');
    setTheme(4); assert.strictEqual(v.pageTheme(), 'light', 'high contrast LIGHT is light');

    // THE OPTION THE USER ASKED FOR: white paper in a dark editor, because a
    // paper is a printed thing and darkening inverts its figures too.
    cfg.pageTheme = 'light';
    setTheme(2);
    assert.strictEqual(v.pageTheme(), 'light', 'an explicit light wins over a dark theme');
    cfg.pageTheme = 'dark';
    setTheme(1);
    assert.strictEqual(v.pageTheme(), 'dark', 'and the other way round');
    restoreStub();
});

test('the toolbar toggle writes the setting and reports back at once', async () => {
    const v = makeViewer(null, null);
    const cfg = { pageTheme: 'auto' };
    let target = null;
    stub.ConfigurationTarget = { Global: 1, Workspace: 2 };
    stub.window.activeColorTheme = { kind: 2 };
    stub.workspace.getConfiguration = () => ({
        get: (k, dflt) => (k === 'pageTheme' ? cfg.pageTheme : dflt),
        update: async (k, val, t) => { cfg.pageTheme = val; target = t; },
    });

    v.posted.length = 0;
    await v._onMessage({ type: 'pageTheme', value: 'light' });
    assert.strictEqual(cfg.pageTheme, 'light', 'the setting was written');
    assert.strictEqual(target, 1, 'globally, so it is remembered next time');
    const t = v.posted.find(p => p.type === 'theme');
    assert.ok(t, 'and the panel was told immediately, not left waiting on the config event');
    assert.strictEqual(t.pages, 'light');
    assert.strictEqual(t.dark, true, 'while the EDITOR is still dark — the two are separate');
    assert.strictEqual(t.setting, 'light');

    // A bad value cannot wedge the setting.
    await v._onMessage({ type: 'pageTheme', value: 'chartreuse' });
    assert.strictEqual(cfg.pageTheme, 'auto');
    restoreStub();
});

test('a failed settings write is reported, not thrown', async () => {
    const v = makeViewer(null, null);
    stub.window.activeColorTheme = { kind: 1 };
    stub.workspace.getConfiguration = () => ({
        get: (k, dflt) => dflt,
        update: async () => { throw new Error('settings.json is read-only'); },
    });
    await v._onMessage({ type: 'pageTheme', value: 'dark' });
    const s = v.posted.filter(p => p.type === 'status').pop();
    assert.ok(s && /read-only/.test(s.text), 'the reader is told why nothing happened');
    restoreStub();
});

// --- the panel following the .tex -------------------------------------------

test('auto-hide closes the panel and remembers it was us', async () => {
    const v = makeViewer(null, null);
    let disposed = 0;
    v.panel = { webview: { postMessage: () => {} }, dispose: () => { disposed++; } };
    assert.strictEqual(v.isOpen(), true);
    await v.autoHide();
    assert.strictEqual(disposed, 1, 'the panel really closes — VS Code cannot hide one');
    assert.strictEqual(v.isOpen(), false);
    assert.strictEqual(v.autoHidden, true, 'and it is marked as OUR doing');
});

test('auto-hide is idempotent and never closes twice', async () => {
    const v = makeViewer(null, null);
    let disposed = 0;
    v.panel = { webview: { postMessage: () => {} }, dispose: () => { disposed++; } };
    await v.autoHide();
    await v.autoHide();
    await v.autoHide();
    assert.strictEqual(disposed, 1);
});

test('a panel the READER closed is not auto-restored', async () => {
    // Only a panel we hid may come back on its own. Reopening one the reader
    // deliberately closed would be the extension arguing with them.
    const v = makeViewer(null, null);
    v.panel = null;
    assert.strictEqual(v.autoHidden, false);
    let opened = 0;
    v.open = async () => { opened++; };
    await v.autoRestore(doc);
    assert.strictEqual(opened, 0, 'nothing reopened');
});

test('an auto-hidden panel IS restored, once', async () => {
    const v = makeViewer(null, null);
    v.panel = { webview: { postMessage: () => {} }, dispose: () => {} };
    await v.autoHide();
    let opened = 0;
    v.open = async () => { opened++; v.panel = { webview: { postMessage: () => {} }, dispose: () => {} }; };
    await v.autoRestore(doc);
    assert.strictEqual(opened, 1);
    assert.strictEqual(v.autoHidden, false, 'and it stops being marked hidden');
    await v.autoRestore(doc);
    assert.strictEqual(opened, 1, 'a second call does nothing');
});

test('the reading position survives a hide and restore', async () => {
    const v = makeViewer(null, null);
    v.panel = { webview: { postMessage: () => {} }, dispose: () => {} };
    await v._onMessage({ type: 'viewstate', page: 7, frac: 0.4 });
    await v.autoHide();
    assert.deepStrictEqual(v._viewState, { page: 7, frac: 0.4 },
        'the place is remembered across the close');
});

test('a reopened document drops the stale ladder', async () => {
    const v = makeViewer({ file: FILE, line: 5, flag: FLAG.FRESH, object: null },
        { file: FILE, line: 5, dx: 2 });
    await v._jumpToSource({ page: 1, xBp: 100, yTopBp: 100, word: 'wavefunction', rowFraction: 0.4 });
    assert.ok(v._ladder, 'a ladder exists');
    stub.window.activeTextEditor = undefined;
    await v._onMessage({ type: 'opened', generation: 2 });
    assert.strictEqual(v._ladder, null, 'and a new generation clears it');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); pass++; results.push('  ok   ' + name); }
        catch (e) {
            fail++;
            results.push('  FAIL ' + name + '\n         ' +
                String((e && e.stack) || e).split('\n').slice(0, 4).join('\n         '));
        }
    }
    console.log('both sync directions, executed\n');
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
