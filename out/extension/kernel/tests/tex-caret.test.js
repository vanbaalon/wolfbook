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

t('the caret does not inherit the highlight’s fade', () => {
    const fs = require('fs');
    const path = require('path');
    const css = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'client', 'tex-viewer.shell.html'), 'utf8');
    const i = css.indexOf('.curcaret {');
    assert.ok(i > 0, '.curcaret must be styled');
    const block = css.slice(i, i + 400);
    assert.ok(!/hlfade/.test(block), 'a caret that faded out would lie about where you are');
    assert.ok(/caretblink/.test(block), 'it blinks, like a text cursor');
    assert.ok(/width:\s*2px/.test(block), 'fixed px, so it does not become a bar at high zoom');
    assert.ok(/prefers-reduced-motion/.test(css), 'blinking is motion and must be opt-out-able');
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
const { TexViewer } = (() => {
    const orig = Module._load;
    Module._load = function (req, ...rest) {
        if (req === 'vscode') return require('./_stub-vscode').makeVscodeStub();
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

console.log(`\n${pass} assertions passed`);
