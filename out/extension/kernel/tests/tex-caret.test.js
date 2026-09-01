'use strict';

// The editor caret's position INSIDE the printed word.
//
//   node out/extension/kernel/tests/tex-caret.test.js
//
// The word highlight says which word the cursor is on. This says where in it.
// Because the exact map carries a box per glyph and a source column range per
// token, the answer is a lookup — so it has to be exactly right, not roughly:
// a caret one letter out reads as a bug in the editor, not as a limit of the
// map, and is worse than no caret at all.

const assert = require('assert');
const { caretInRange } = require('../../tex/glyphAlign');

let pass = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ── fixtures ──────────────────────────────────────────────────────────────
//
// "half" typeset at x=100, four 10-bp glyphs on page 2. EM box y=200 h=12;
// ink is deliberately different (y=203 h=7) so a caret that used the ink box
// instead of the em box is visible as a failure.
function word(chars, { line = 5, startCol = 10, x = 100, adv = 10, page = 2 } = {}) {
    const tokens = [];
    const glyphs = [];
    const srcToRen = [];
    chars.split('').forEach((ch, i) => {
        tokens.push({ ch, line, startCol: startCol + i, endLine: line, endCol: startCol + i + 1 });
        glyphs.push({ page, x: x + i * adv, y: 200, w: adv, h: 12, inkY: 203, inkH: 7, ch });
        srcToRen.push(i);
    });
    return { tokens, glyphs, srcToRen, exact: true };
}

const RANGE = { start: 10, end: 14 };            // "half" occupies columns 10..13

// ── the basic ladder ──────────────────────────────────────────────────────

console.log('caretInRange — snapping to glyph edges');

t('at the start of the word the caret is at the first glyph’s LEFT edge', () => {
    const c = caretInRange(word('half'), 5, 10, RANGE);
    assert.strictEqual(c.x, 100);
    assert.strictEqual(c.at, 'before');
    assert.strictEqual(c.offset, 0);
});

t('after the first letter it is at the second glyph’s left edge', () => {
    const c = caretInRange(word('half'), 5, 11, RANGE);
    assert.strictEqual(c.x, 110);
    assert.strictEqual(c.offset, 1);
});

t('after the last letter it is at the last glyph’s RIGHT edge', () => {
    const c = caretInRange(word('half'), 5, 14, RANGE);
    assert.strictEqual(c.x, 140, 'x=100 + 4 glyphs × 10');
    assert.strictEqual(c.at, 'after');
});

t('every interior column gets its own distinct position', () => {
    const xs = [10, 11, 12, 13, 14].map(col => caretInRange(word('half'), 5, col, RANGE).x);
    assert.deepStrictEqual(xs, [100, 110, 120, 130, 140]);
});

t('the caret advances monotonically with the column — never backwards', () => {
    // The property that matters when reading: holding → moves the caret right.
    let prev = -Infinity;
    for (let col = 10; col <= 14; col++) {
        const x = caretInRange(word('half'), 5, col, RANGE).x;
        assert.ok(x >= prev, `column ${col} moved the caret backwards (${x} after ${prev})`);
        prev = x;
    }
});

// ── the box it uses ───────────────────────────────────────────────────────

console.log('the caret’s height');

t('spans the EM box, not the ink box', () => {
    // Ink stops at the top of an 'x' and below a 'p'; a caret is a line-height
    // mark, so an ink-height caret would be a stub next to a lowercase word.
    const c = caretInRange(word('half'), 5, 11, RANGE);
    assert.strictEqual(c.y, 200, 'em top, not ink top 203');
    assert.strictEqual(c.h, 12, 'em height, not ink height 7');
});

t('the page comes from the glyph, so a word split across rows is handled', () => {
    // A hyphenated word: the last two glyphs are on the next page.
    const w = word('half');
    w.glyphs[2] = { ...w.glyphs[2], page: 3, x: 50, y: 700 };
    w.glyphs[3] = { ...w.glyphs[3], page: 3, x: 60, y: 700 };
    assert.strictEqual(caretInRange(w, 5, 11, RANGE).page, 2);
    const c = caretInRange(w, 5, 12, RANGE);
    assert.strictEqual(c.page, 3);
    assert.strictEqual(c.x, 50, 'the caret follows the glyph onto the next row');
});

// ── things that print nothing, and things that print less ─────────────────

console.log('tokens that do not map one-to-one');

t('a token that printed nothing is stepped over, not landed in', () => {
    // A `~` or a macro's braces occupy source columns and print no glyph. The
    // caret belongs at the start of the next thing that DID print.
    const w = word('half');
    w.srcToRen[1] = -1;                       // the 'a' printed nothing
    const c = caretInRange(w, 5, 11, RANGE);
    assert.strictEqual(c.x, 120, 'skips to the next printed glyph');
});

t('a ligature is interpolated across its advance', () => {
    // One glyph, two source characters: there is no interior position to read
    // off, so the caret goes proportionally through the shape it drew.
    const w = {
        tokens: [
            { ch: 'f', line: 5, startCol: 10, endLine: 5, endCol: 12 },   // "fi" ligature
            { ch: 'x', line: 5, startCol: 12, endLine: 5, endCol: 13 },
        ],
        glyphs: [
            { page: 1, x: 100, y: 200, w: 12, h: 12 },
            { page: 1, x: 112, y: 200, w: 10, h: 12 },
        ],
        srcToRen: [0, 1],
        exact: true,
    };
    const r = { start: 10, end: 13 };
    assert.strictEqual(caretInRange(w, 5, 10, r).x, 100, 'before the ligature');
    assert.strictEqual(caretInRange(w, 5, 11, r).x, 106, 'halfway through its advance');
    assert.strictEqual(caretInRange(w, 5, 12, r).x, 112, 'after it');
});

t('a single-character token is never interpolated', () => {
    const c = caretInRange(word('half'), 5, 12, RANGE);
    assert.strictEqual(c.x, 120, 'exactly the glyph edge, no fraction');
});

// ── refusing to answer ────────────────────────────────────────────────────

console.log('when there is no answer');

t('a range that printed nothing returns null, not a guess', () => {
    // A comment or a \\label{…}: source columns with no ink. Drawing a caret
    // somewhere plausible would be an invention.
    const w = word('half');
    w.srcToRen = [-1, -1, -1, -1];
    assert.strictEqual(caretInRange(w, 5, 11, RANGE), null);
});

t('a range on another line returns null', () => {
    assert.strictEqual(caretInRange(word('half'), 9, 11, RANGE), null);
});

t('a column far outside the range still resolves to an edge, not null', () => {
    assert.strictEqual(caretInRange(word('half'), 5, 0, RANGE).x, 100);
    assert.strictEqual(caretInRange(word('half'), 5, 99, RANGE).x, 140);
});

t('missing or malformed input is tolerated', () => {
    assert.strictEqual(caretInRange(null, 5, 11, RANGE), null);
    assert.strictEqual(caretInRange(word('half'), 5, 11, null), null);
    assert.strictEqual(caretInRange({ tokens: [], glyphs: [], srcToRen: [] }, 5, 11, RANGE), null);
});

// ── ordering ──────────────────────────────────────────────────────────────

console.log('ordering');

t('tokens supplied out of source order are sorted before use', () => {
    const w = word('half');
    const order = [3, 1, 0, 2];
    w.tokens = order.map(i => w.tokens[i]);
    w.srcToRen = order.map(i => w.srcToRen[i]);
    assert.strictEqual(caretInRange(w, 5, 10, RANGE).x, 100);
    assert.strictEqual(caretInRange(w, 5, 14, RANGE).x, 140);
});

t('tokens outside the range are ignored', () => {
    // The neighbouring word must not widen the caret's search.
    const w = word('halfmoon', { startCol: 10 });
    const c = caretInRange(w, 5, 14, RANGE);     // range still ends at 14
    assert.strictEqual(c.x, 140, 'the caret stops at the end of "half"');
    assert.strictEqual(c.at, 'after');
});

// ── the wiring ────────────────────────────────────────────────────────────

console.log('wiring');

t('only an EXACT map is allowed to place a caret', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tex', 'texViewer.js'), 'utf8');
    assert.ok(/caret:\s*amap\.exact\s*\?\s*caret\s*:\s*null/.test(src),
        'an approximate map is right about the word and must not claim a position inside it');
});

t('the client only paints a caret that came with an exact highlight', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'client', 'tex-viewer.js'), 'utf8');
    assert.ok(/caret:\s*msg\.exact\s*\?\s*\(msg\.caret\s*\|\|\s*null\)\s*:\s*null/.test(src),
        'a client-narrowed highlight has its own geometry; the caret x no longer belongs to it');
    assert.ok(/paintCursorCaret\(h\)/.test(src),
        'paintHighlight must drive the caret, so it can never outlive its highlight');
});

t('the caret neither fades nor blinks', () => {
    // It does not FADE, because the position is still true — a caret that
    // dimmed out would lie about where you are. And it does not BLINK: a text
    // cursor blinks to be findable in a field you are typing into, but this one
    // sits on a page you are READING, where the same motion is something moving
    // in the corner of your eye that you cannot ignore. Reported as distracting.
    const fs = require('fs');
    const path = require('path');
    const css = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'client', 'tex-viewer.shell.html'), 'utf8');
    const i = css.indexOf('.curcaret {');
    assert.ok(i > 0, '.curcaret must be styled');
    const block = css.slice(i, i + 400);
    assert.ok(!/hlfade/.test(block), 'a caret that faded out would lie about where you are');
    assert.ok(!/animation/.test(block), 'no animation at all on the caret');
    assert.ok(!/caretblink/.test(css), 'and the blink keyframes are gone, not merely unused');
    assert.ok(/width:\s*2px/.test(block), 'fixed px, so it does not become a bar at high zoom');
});

// ── RESOLUTION COLUMN vs CARET COLUMN ─────────────────────────────────────
//
// These are two different questions and the answer is different for each:
//
//   which token does this selection NAME?  → its START. Reading the active end
//     lights up the token AFTER the one an inverse click resolved (measured:
//     92 of 243 maths glyphs landed exactly one glyph right).
//   where is the reader's cursor?          → its ACTIVE end. After an inverse
//     click VS Code leaves the caret at the END of the word it selected.
//
// Using one column for both drew the caret at the start of a word whose editor
// cursor was at the end — reported, and visibly wrong against the editor next
// to it. This drives the REAL method with a stubbed alignment map.

console.log('resolution column vs caret column');

const Module = require('module');
const stubVscode = require('./_stub-vscode').makeVscodeStub();
// The shared stub has no Selection/Range — _onEditCaret builds one.
if (!stubVscode.Selection) {
    stubVscode.Selection = class {
        constructor(a, b) {
            this.anchor = a; this.active = b; this.start = a; this.end = b;
            this.isEmpty = a.line === b.line && a.character === b.character;
        }
    };
}
// Async tests run in a queue at the end: `t` is synchronous, so an async body
// passed to it would run detached and an assertion failure would surface as an
// unhandled rejection long after the summary said everything passed.
const asyncTests = [];
const at = (name, fn) => asyncTests.push({ name, fn });
const { TexViewer } = (() => {
    const orig = Module._load;
    Module._load = function (req, ...rest) {
        if (req === 'vscode') return stubVscode;
        return orig.call(this, req, ...rest);
    };
    try { return require('../../tex/texViewer'); }
    finally { Module._load = orig; }
})();

/** Drive _postAlignedGlyph over "half" at columns 10..13 and return the message. */
function postFor(column, caretCol) {
    const amap = word('half');
    amap.exact = true;
    amap.tokens.forEach(t => { t.inMath = false; });
    let sent = null;
    const self = {
        _alignMap: () => amap,
        _macrosFor: () => ({}),
        _wordFromTokens: () => ({ start: 10, end: 14, word: 'half', line: 5 }),
        _mayScroll: () => false,
        _invertedAt: 0,
        _syncInstant: false,
        _post: (m) => { sent = m; },
    };
    const st = { map: { _baseFlag: () => 0 } };
    const doc = { uri: { fsPath: '/x.tex' }, lineAt: () => ({ text: '          half more' }) };
    TexViewer.prototype._postAlignedGlyph.call(self, st, doc, 5, column, 'title', caretCol);
    return sent;
}

t('the caret honours the ACTIVE end while the word came from the start', () => {
    // Exactly the inverse-click case: selection [10,14), caret left at 14.
    const m = postFor(10, 14);
    assert.ok(m, 'a highlight must be posted');
    assert.strictEqual(m.word, 'half', 'the word is still resolved from the start');
    assert.ok(m.caret, 'a caret must travel with it');
    assert.strictEqual(m.caret.x, 140, 'drawn at the END of the word, where the cursor is');
    assert.strictEqual(m.caret.at, 'after');
});

t('with no caret column given it falls back to the resolution column', () => {
    const m = postFor(10, undefined);
    assert.strictEqual(m.caret.x, 100, 'the start, as before');
});

t('a caret column of 0 is honoured, not treated as missing', () => {
    // The falsy-zero trap: `caretCol || column` would silently use the start.
    const m = postFor(12, 0);
    assert.strictEqual(m.caret.x, 100, 'column 0 clamps to the word’s left edge');
});

t('an interior caret column lands inside the word', () => {
    const m = postFor(10, 12);
    assert.strictEqual(m.caret.x, 120);
    assert.strictEqual(m.caret.at, 'inside');
});

t('syncFromEditor takes the caret column from the selection’s active end', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tex', 'texViewer.js'), 'utf8');
    assert.ok(/const caretCol = \(sel && sel\.active && sel\.active\.line === cur\.line\)\s*\n?\s*\? sel\.active\.character : column;/.test(src),
        'the caret column must come from sel.active, guarded to the resolved line');
    assert.ok(/_postAlignedGlyph\(st, doc, line, column, obj \? obj\.stableKey : `line \$\{line\}`, caretCol\)/.test(src),
        'and be passed through — resolution still uses `column`');
});

t('a selection spanning lines falls back rather than inventing a position', () => {
    // There is no position on the resolved line to honour, and a caret placed
    // for a different line would be a fabrication.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tex', 'texViewer.js'), 'utf8');
    assert.ok(/sel\.active\.line === cur\.line/.test(src), 'guarded on the line');
});

// ── THE INVERSE CLICK: WORD OUTLINED, CARET WHERE YOU POINTED ─────────────
//
// VS Code's caret is always at one END of a selection, so a selected word can
// only ever put it before or after the word — never where the pointer actually
// was. The word is therefore OUTLINED with the decoration this gesture already
// drew, and the selection collapses to the clicked character.
//
// These read the real source: the branch lives inside _jumpToSource, which
// needs a compiled paper, a webview and an open editor to run. What can be
// pinned without all that is the CONTRACT — which gestures collapse and which
// keep a selection, and that the bookkeeping records what was actually set.

console.log('inverse click: caret placement');

const VIEWER_SRC = (() => {
    const fs = require('fs');
    const path = require('path');
    return fs.readFileSync(path.join(__dirname, '..', '..', 'tex', 'texViewer.js'), 'utf8');
})();

/** The plain-click block of _jumpToSource. */
const CLICK_BLOCK = (() => {
    // Start at the containment helper, which sits just above the decision, so
    // the block under test is the whole plain-click branch.
    const i = VIEWER_SRC.indexOf('const inRange = (r, pos)');
    return i > 0 ? VIEWER_SRC.slice(i, i + 2800) : '';
})();

t('the clicked CHARACTER is carried alongside the word', () => {
    assert.ok(/const hitPos = \(aligned && aligned\.line === lineIdx \+ 1/.test(VIEWER_SRC),
        'the hit position must come from the aligned glyph — the exact map already knows it');
});

t('a plain click on a word collapses the selection to that character', () => {
    assert.ok(CLICK_BLOCK, 'the plain-click branch must exist');
    assert.ok(/step\.kind === 'word'/.test(CLICK_BLOCK), 'only for a word rung');
    assert.ok(/new vscode\.Selection\(hitPos, hitPos\)/.test(CLICK_BLOCK),
        'a collapsed selection IS the caret');
});

t('a double-click still SELECTS the word, so it can be typed over', () => {
    assert.ok(/!m\.takeMe/.test(CLICK_BLOCK),
        'takeMe (double-click) means "take me there to work on it" — it wants a real selection');
});

t('a widened Cmd-click still selects the group', () => {
    assert.ok(/!m\.widen/.test(CLICK_BLOCK),
        'widening is an explicit "select this much" and must not collapse');
});

t('MATHS still selects the macro that printed the symbol', () => {
    // A click on a Ψ resolves `\Psi`, and selecting it is the right answer:
    // the reader clicked the SYMBOL, not a letter of its name, so there is no
    // "middle of the word" to point at. Collapsing there would take away a
    // useful selection and answer a question nobody asked.
    assert.ok(/hitInProse/.test(CLICK_BLOCK), 'the collapse must be gated on prose');
    assert.ok(/hitInProse = !isMath;/.test(VIEWER_SRC),
        'and that flag must come from the same isMath decision the word unit uses');
});

t('containment is computed, never asked of the host', () => {
    // Range.contains is a host method, and this must never be able to throw out
    // of the jump — the rule the flash decoration already follows. A stubbed
    // host caught it doing exactly that.
    assert.ok(!/range\.contains\(/.test(CLICK_BLOCK),
        'no host method in the caret decision');
    assert.ok(/const inRange = \(r, pos\)/.test(CLICK_BLOCK),
        'arithmetic on line/character needs nothing from vscode');
});

t('the caret must actually be inside the word it outlines', () => {
    assert.ok(/inRange\(range, hitPos\)/.test(CLICK_BLOCK),
        'a hit outside the resolved word would put the caret somewhere the outline does not cover');
});

t('the word is still outlined — that outline is now half the answer', () => {
    assert.ok(/_flash\.show\(editor, range\)/.test(CLICK_BLOCK),
        'with the selection collapsed the decoration is the only thing naming the word');
    assert.ok(/revealRange\(range,/.test(CLICK_BLOCK),
        'and the WORD is revealed, not the zero-width caret');
});

t('the self-selection bookkeeping records what was ACTUALLY set', () => {
    // Recording the word while placing a caret would leave the forward sync
    // unable to recognise its own gesture, and every click would come back
    // looking like the reader had made a selection.
    assert.ok(/sl: placed\.start\.line, sc: placed\.start\.character/.test(CLICK_BLOCK),
        '_selfRange must be built from the placed selection, not from `range`');
    assert.ok(/editor\.selection = placed;/.test(CLICK_BLOCK));
});

t('the behaviour is settable, and defaults to on', () => {
    assert.ok(/_inverseClickCaret\(\)/.test(CLICK_BLOCK), 'gated by the setting');
    assert.ok(/get\('inverseClickCaret', true\) !== false/.test(VIEWER_SRC),
        'default on, and only an explicit false turns it off');
    const pkg = require('../../../../package.json');
    const cfg = pkg.contributes.configuration;
    const props = Array.isArray(cfg) ? Object.assign({}, ...cfg.map(c => c.properties)) : cfg.properties;
    const dec = props['wolfbook.tex.inverseClickCaret'];
    assert.ok(dec, 'the setting must be declared, or nobody can find it');
    assert.strictEqual(dec.default, true);
});

t('reading the setting can never break the click', () => {
    // A decoration is decoration and a setting is a setting: neither may be
    // able to throw out of the jump. The same lesson EditorFlash records.
    const i = VIEWER_SRC.indexOf('_inverseClickCaret() {');
    const body = VIEWER_SRC.slice(i, i + 400);
    assert.ok(/try \{/.test(body) && /catch \(_\) \{ return true; \}/.test(body),
        'it must fall back to the default rather than throwing');
});

// ── THE MINI-EDITOR, BOTH WAYS ────────────────────────────────────────────
//
// The card is a second editing surface for the same text, so the cursor has to
// behave the same there: a click on the page puts the card's caret at the
// character clicked (with the word still marked), and moving the card's caret
// moves the caret drawn on the page. Two surfaces for one document should not
// disagree about where the reader is.

console.log('mini-editor: page → card');

/** A document whose offsets and positions are a single line, for simplicity. */
function flatDoc(fsPath = '/x.tex') {
    return {
        uri: { fsPath, toString: () => `file://${fsPath}` },
        positionAt: (n) => ({ line: 0, character: n }),
        offsetAt: (pos) => pos.character,
        lineCount: 1,
        lineAt: () => ({ text: 'x'.repeat(400) }),
    };
}

function cardViewer(edit) {
    const posted = [];
    const self = Object.create(TexViewer.prototype);
    self._edit = edit;
    self._post = (m) => posted.push(m);
    return { self, posted };
}

t('a click sends the card the word AND the clicked character', () => {
    const { self, posted } = cardViewer({ id: 'e1', file: '/x.tex', startOffset: 100, endOffset: 200 });
    const doc = flatDoc();
    // The word occupies 120..132; the reader clicked at 126.
    self._postEditSelection(doc,
        { start: { line: 0, character: 120 }, end: { line: 0, character: 132 } },
        true, { line: 0, character: 126 });
    const m = posted.find(x => x.type === 'editSelect');
    assert.ok(m, 'the card must be told');
    assert.strictEqual(m.start, 20, 'block-relative word start');
    assert.strictEqual(m.end, 32, 'block-relative word end');
    assert.strictEqual(m.caret, 26, 'block-relative caret, inside the word');
});

t('a caret outside the marked word is dropped, not sent', () => {
    // It would put the card's cursor somewhere the mark does not cover, which
    // is the confusion this whole change exists to remove.
    const { self, posted } = cardViewer({ id: 'e1', file: '/x.tex', startOffset: 100, endOffset: 200 });
    self._postEditSelection(flatDoc(),
        { start: { line: 0, character: 120 }, end: { line: 0, character: 132 } },
        true, { line: 0, character: 180 });
    assert.strictEqual(posted.find(x => x.type === 'editSelect').caret, undefined);
});

t('with no caret given the card still gets the range', () => {
    // A widened Cmd-click or a dragged selection: a real range is the answer.
    const { self, posted } = cardViewer({ id: 'e1', file: '/x.tex', startOffset: 100, endOffset: 200 });
    self._postEditSelection(flatDoc(),
        { start: { line: 0, character: 120 }, end: { line: 0, character: 132 } }, true, null);
    const m = posted.find(x => x.type === 'editSelect');
    assert.strictEqual(m.caret, undefined);
    assert.strictEqual(m.start, 20);
    assert.strictEqual(m.end, 32);
});

t('a click outside the open block still tells the card nothing', () => {
    const { self, posted } = cardViewer({ id: 'e1', file: '/x.tex', startOffset: 100, endOffset: 200 });
    self._postEditSelection(flatDoc(),
        { start: { line: 0, character: 10 }, end: { line: 0, character: 20 } },
        true, { line: 0, character: 15 });
    assert.strictEqual(posted.length, 0, 'the range is not in this block');
});

t('the click path passes the caret only when it placed one', () => {
    assert.ok(/_postEditSelection\(doc, range, !m\.takeMe, caretHere \? hitPos : null\)/.test(VIEWER_SRC),
        'the card and the editor must make the SAME decision, not two');
});

t('a decline says WHY, so the next report is diagnosable', () => {
    // Every branch used to be a silent return, and from the reader's seat all
    // of them look identical: "I clicked and the card ignored me" — which is
    // exactly how it was reported.
    const { self } = cardViewer(null);
    assert.strictEqual(self._postEditSelection(flatDoc(),
        { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, true, null),
        'no mini-editor is open');

    const other = cardViewer({ id: 'e1', file: '/other.tex', startOffset: 0, endOffset: 50 });
    assert.ok(/another file/.test(other.self._postEditSelection(flatDoc('/x.tex'),
        { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, true, null)));

    const outside = cardViewer({ id: 'e1', file: '/x.tex', startOffset: 100, endOffset: 200 });
    const why = outside.self._postEditSelection(flatDoc(),
        { start: { line: 0, character: 10 }, end: { line: 0, character: 20 } }, true, null);
    assert.ok(/outside the card's block/.test(why), why);
    assert.ok(/lines/.test(why), 'and names the lines it does hold, so it can be checked');
});

t('a successful post returns no reason', () => {
    const { self } = cardViewer({ id: 'e1', file: '/x.tex', startOffset: 100, endOffset: 200 });
    assert.strictEqual(self._postEditSelection(flatDoc(),
        { start: { line: 0, character: 120 }, end: { line: 0, character: 132 } },
        true, { line: 0, character: 126 }), null);
});

t('the click puts that reason in the status line', () => {
    assert.ok(/card not moved: \$\{_cardWhy\}/.test(VIEWER_SRC),
        'the reason must reach the reader, not just the return value');
    assert.ok(/this\._edit && _cardWhy/.test(VIEWER_SRC),
        'and only when a card is actually open — with none there is nothing to explain');
});

console.log('mini-editor: card → page');

at('moving the card’s caret carries it as the selection’s ACTIVE end', async () => {
    // This is what makes the page draw its in-word caret: syncFromEditor reads
    // sel.active, so a card caret that did not travel there would move the word
    // highlight and leave the caret behind.
    const doc = flatDoc();
    const self = Object.create(TexViewer.prototype);
    self._edit = { id: 'e1', file: '/x.tex', startOffset: 100, endOffset: 200 };
    self.panel = {};
    let seen = null;
    self.syncFromEditor = (e) => { seen = e; };
    stubVscode.workspace.openTextDocument = async () => doc;
    stubVscode.window.visibleTextEditors = [];       // no editor open → direct sync
    await TexViewer.prototype._onEditCaret.call(self, { editId: 'e1', start: 26, end: 26 });
    assert.ok(seen, 'the page must be synced');
    assert.strictEqual(seen.selection.active.character, 126, 'the caret offset, in document terms');
    assert.strictEqual(seen.selection.isEmpty, true, 'a caret, not a range');
});

at('a range dragged in the card keeps its active END', async () => {
    const doc = flatDoc();
    const self = Object.create(TexViewer.prototype);
    self._edit = { id: 'e1', file: '/x.tex', startOffset: 100, endOffset: 200 };
    self.panel = {};
    let seen = null;
    self.syncFromEditor = (e) => { seen = e; };
    stubVscode.workspace.openTextDocument = async () => doc;
    stubVscode.window.visibleTextEditors = [];
    await TexViewer.prototype._onEditCaret.call(self, { editId: 'e1', start: 20, end: 32 });
    assert.strictEqual(seen.selection.start.character, 120);
    assert.strictEqual(seen.selection.active.character, 132, 'active is the far end of the drag');
    assert.strictEqual(seen.selection.isEmpty, false);
});

t('the card marks the WORD while its textarea holds only the caret', () => {
    const fs = require('fs');
    const path = require('path');
    const client = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'client', 'tex-viewer.js'), 'utf8');
    const i = client.indexOf('function selectInEditCard(');
    const body = client.slice(i, i + 1800);
    assert.ok(/e\.sel = \{ start: msg\.start, end: msg\.end \}/.test(body),
        'the highlight layer keeps the WORD — it reads e.sel, not the textarea');
    assert.ok(/setSelectionRange\(taFrom, taTo\)/.test(body),
        'while the textarea collapses to the caret');
    assert.ok(/_caretSent = `\$\{taFrom\}:\$\{taTo\}`/.test(body),
        'the echo guard must claim what the TEXTAREA will report, or the card ' +
        'posts the position straight back as the reader’s own movement');
});

(async () => {
    for (const a of asyncTests) {
        try { await a.fn(); pass++; console.log(`  ✓ ${a.name}`); }
        catch (e) { console.error(`  ✗ ${a.name}\n    ${e.message}`); process.exitCode = 1; }
    }
    console.log(`\n${pass} assertions passed`);
})();
