// tex-glyphmap.test.js — the GlyphMap: the render map read off the engine.
//
// Headless: a hand-written glyphmap record (the shape resources/tex/wbmap.lua
// writes) stands in for a compile. What is asserted is the CONTRACT the rest of
// the viewer relies on — rows per printed line, nearest glyph, the window of a
// collected construct, the alignment that gives a column — plus the TFM slot
// tables and the honesty of the Lua hook's own source.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GlyphMap, readGlyphMap, tfmChar, tfmFamily, KIND } = require('../../tex/glyphMap');
const { tokenAt } = require('../../tex/glyphAlign');

let passed = 0; let failed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n         ') : e}`); }
}

// A tiny document the way wbmap.lua would record it: two prose lines that
// print as one paragraph of two rows, a display equation whose body is on line
// 6 with its number on line 7, and a two-line caption collected on line 11.
//   glyph = [x, y(baseline), w, h, d, font, char, file, line, row, kind, lv, lig?]
const FILE = path.join(os.tmpdir(), 'wb-glyphmap-test', 'paper.tex');
const SRC = [
    '\\documentclass{article}',          // 1
    '\\begin{document}',                  // 2
    'Alpha beta gamma',                   // 3
    'delta epsilon.',                     // 4
    '\\begin{equation}',                  // 5
    '  x^2 = y',                          // 6
    '\\end{equation}',                    // 7
    '',                                   // 8
    '\\begin{figure}',                    // 9
    '\\caption{A caption that spans',     // 10
    'two lines.}',                        // 11
    '\\end{figure}',                      // 12
    '\\paragraph{Why now.}',              // 13  a peeker: its words print on line 15's row
    '',                                   // 14
    'Because it is time.',                // 15
    'Sentence.\\footnote{A note that',    // 16  construct opens on a line with ink
    'goes on.}',                          // 17
    '\\end{document}',                   // 18
];
function g(x, base, w, ch, line, row, kind = 0, lv = 0, font = 1, h = 7, d = 0) {
    return [x, base, w, h, d, font, ch.codePointAt(0), 1, line, row, kind, lv];
}
function word(x, base, text, line, row, kind = 0) {
    const out = []; let cx = x;
    for (const ch of text) { out.push(g(cx, base, 5, ch, line, row, kind)); cx += 5; }
    return out;
}
const PAGE1 = {
    p: 1, W: 595.276, H: 841.89,
    g: [
        ...word(72, 100, 'Alpha', 3, 1), ...word(105, 100, 'beta', 3, 1), ...word(130, 100, 'gamma', 3, 1),
        ...word(72, 112, 'delta', 4, 2), ...word(105, 112, 'epsilon.', 4, 2),
        // display: x (base), 2 (above, cmr7), = y ; number (1) on the \end line
        [200, 140, 6, 5, 0, 2, 'x'.codePointAt(0), 1, 6, 3, 2, 0],
        [206, 136, 4, 4, 0, 3, '2'.codePointAt(0), 1, 6, 3, 2, 1],
        [214, 140, 7, 4, 0, 1, '='.codePointAt(0), 1, 6, 3, 2, 0],
        [225, 140, 5, 5, 2, 2, 'y'.codePointAt(0), 1, 6, 3, 2, 0],
        ...word(470, 140, '(1)', 7, 3, 3),
        // caption: everything on line 11, two printed rows
        ...word(72, 300, 'Figure', 11, 4), ...word(110, 300, '1:', 11, 4), ...word(130, 300, 'A', 11, 4),
        ...word(140, 300, 'caption', 11, 4), ...word(180, 300, 'that', 11, 4), ...word(205, 300, 'spans', 11, 4),
        ...word(72, 312, 'two', 11, 5), ...word(95, 312, 'lines.', 11, 5),
        // the page number, typeset by the output routine while line 4 was read
        [300, 800, 5, 7, 0, 1, '1'.codePointAt(0), 1, 4, 6, 5, 0],
        // \paragraph{Why now.} + "Because it is time." on one row, filed on 15
        ...word(72, 400, 'Why', 15, 7), ...word(92, 400, 'now.', 15, 7), ...word(120, 400, 'Because', 15, 7),
        ...word(160, 400, 'it', 15, 7), ...word(175, 400, 'is', 15, 7), ...word(190, 400, 'time.', 15, 7),
        // "Sentence." on 16 with the footnote mark; the footnote text on 17
        ...word(72, 412, 'Sentence.', 16, 8), [118, 408, 3, 4, 0, 3, '1'.codePointAt(0), 1, 16, 8, 0, 1],
        ...word(72, 700, 'A', 17, 9), ...word(80, 700, 'note', 17, 9), ...word(105, 700, 'that', 17, 9),
        ...word(130, 700, 'goes', 17, 9), ...word(155, 700, 'on.', 17, 9),
    ],
};
const META = {
    v: 1,
    files: { 1: FILE },
    fonts: { 1: { name: 'cmr10', psname: null, format: 'unknown', size: 10 },
        2: { name: 'cmmi10', psname: null, format: 'unknown', size: 10 },
        3: { name: 'cmr7', psname: null, format: 'unknown', size: 7 } },
    pages: 1,
};

function writeFixture() {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, SRC.join('\n'));
    const jl = path.join(path.dirname(FILE), 'paper.glyphmap.jsonl');
    const mt = path.join(path.dirname(FILE), 'paper.glyphmap.meta.json');
    fs.writeFileSync(jl, JSON.stringify({ v: 1, unit: 'bp' }) + '\n' + JSON.stringify(PAGE1) + '\n');
    fs.writeFileSync(mt, JSON.stringify(META));
    return { jl, mt };
}

function makeMap(extra = {}) {
    const { jl, mt } = writeFixture();
    return new GlyphMap({
        generation: { generation: 1, glyphMapPath: jl, glyphMapMetaPath: mt, pageCount: 1, projectDir: path.dirname(FILE), ...extra },
        pageSize: { widthBp: 595.276, heightBp: 841.89 },
    });
}

(async () => {
    console.log('GlyphMap — the render map read off the engine\n');

    await test('TFM slot tables: letters, Greek, operators, ligatures, wildcards', () => {
        assert.strictEqual(tfmChar('cmr10', 65), 'A');
        assert.strictEqual(tfmChar('cmr10', 12), 'fi');
        assert.strictEqual(tfmChar('cmmi10', 11), 'α');
        assert.strictEqual(tfmChar('cmmi10', 120), 'x');
        assert.strictEqual(tfmChar('cmsy10', 0), '−');
        assert.strictEqual(tfmChar('cmsy10', 20), '≤');
        assert.strictEqual(tfmChar('cmex10', 88), '∑');
        assert.strictEqual(tfmChar('cmex10', 0), '(');
        assert.strictEqual(tfmChar('msbm10', 82), 'R');
        // An unmapped slot is a WILDCARD (U+0000), never a space that would be dropped.
        assert.strictEqual(tfmChar('cmex10', 117), '\u0000');
        assert.strictEqual(tfmChar('msam10', 3), '\u0000');
        assert.strictEqual(tfmFamily('cmbx12'), 'OT1');
        assert.strictEqual(tfmFamily('cmtt10'), 'OT1TT');
    });

    await test('the Lua hook parses, carries no raw control byte, and registers the four callbacks', () => {
        const lua = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'resources', 'tex', 'wbmap.lua'), 'utf8');
        for (const cb of ['process_input_buffer', 'start_file', 'stop_file', 'pre_shipout_filter']) {
            assert.ok(lua.includes(`"${cb}"`), `registers ${cb}`);
        }
        assert.ok(lua.includes('effective_glue'), 'vertical glue must be effective, not natural');
        assert.ok(lua.includes('72 / 72.27'), 'output is bp, not TeX pt');
        assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(lua), 'no raw control bytes');
        assert.ok(!/\[\[file\]\]|dofile\("/.test(lua), 'the hook never relies on quoted paths');
    });

    await test('readGlyphMap reads pages, fonts and files; a damaged page line is skipped, not fatal', () => {
        const { jl, mt } = writeFixture();
        fs.appendFileSync(jl, '{"p":2,"W":1,"H":1,"g":[[1,2,3\n');
        const doc = readGlyphMap(jl, mt);
        assert.strictEqual(doc.pages.size, 1);
        assert.strictEqual(doc.fonts.get(2).family, 'OML');
        assert.strictEqual(doc.pages.get(1).glyphs[0].str, 'A');
        // cmmi10 slot 'x'(120) reads as x; the superscript keeps its level
        const sup = doc.pages.get(1).glyphs.find(x => x.line === 6 && x.lv === 1);
        assert.strictEqual(sup.str, '2');
    });

    await test('a map is exact when the generation has a glyphmap, and still a RenderMap', () => {
        const m = makeMap();
        assert.strictEqual(m.exact, true);
        assert.strictEqual(m.available, true);
        assert.strictEqual(m._baseFlag(), 'fresh');
        const none = new GlyphMap({ generation: { generation: 2 } });
        assert.strictEqual(none.exact, false);
        assert.strictEqual(none.lineRows('/x.tex', 1).length, 0);
    });

    await test('lineRows: one rect per printed row, from the engine\'s own row ids — no leading estimate', () => {
        const m = makeMap();
        const r3 = m.lineRows(FILE, 3);
        assert.strictEqual(r3.length, 1, 'line 3 printed one row');
        assert.strictEqual(r3[0].page, 1);
        assert.ok(Math.abs(r3[0].x - 72) < 0.01 && Math.abs(r3[0].y - 93) < 0.01, `row top-left ${r3[0].x},${r3[0].y}`);
        assert.ok(Math.abs(r3[0].w - (130 + 25 - 72)) < 0.01, 'row spans the line\'s ink');
        const r11 = m.lineRows(FILE, 11);
        assert.strictEqual(r11.length, 2, 'the caption line printed two rows');
        // THE EQUATION NUMBER IS LEFT OUT of the \end line's rows.
        assert.strictEqual(m.lineRows(FILE, 7).length, 0);
        // A delimiter line has no rows of its own.
        assert.strictEqual(m.lineRows(FILE, 5).length, 0);
    });

    await test('lineAtPoint / renderToSource: the nearest glyph names the exact line', () => {
        const m = makeMap();
        const hit = m.lineAtPoint(1, 107, 97);          // on "beta"
        assert.strictEqual(hit.line, 3);
        assert.strictEqual(hit.exact, true);
        const r = m.renderToSource(1, 203, 138);       // the x of the display
        assert.strictEqual(r.line, 6);
        assert.strictEqual(r.exact, true);
        assert.ok(r.glyph && r.glyph.str === 'x');
        // Far from any ink → not a glyph answer (falls to SyncTeX, here absent).
        const far = m.renderToSource(1, 400, 600);
        assert.ok(!far.exact);
    });

    await test('sourceToRender / objectRenderBoxes: exact boxes per page for a line range', () => {
        const m = makeMap();
        const s = m.sourceToRender(FILE, 3, 4);
        assert.strictEqual(s.exact, true);
        assert.strictEqual(s.boxes.length, 2);
        assert.deepStrictEqual(s.pages, [1]);
        const o = m.objectRenderBoxes({ sourceRange: { file: FILE, startLine: 3, endLine: 4 } });
        assert.strictEqual(o.rects.length, 1);
        assert.ok(o.rects[0].h > 15, 'two rows union');
    });

    await test('WINDOW: a collected construct is the glyph-less lines above its collector', () => {
        const m = makeMap();
        assert.deepStrictEqual(m.window(FILE, 10, SRC), { startLine: 9, endLine: 11, collector: 11 });
        assert.deepStrictEqual(m.window(FILE, 11, SRC), { startLine: 9, endLine: 11, collector: 11 });
        // A prose line with its own glyphs is its own window, and does not
        // swallow the paragraph above it (which has glyphs).
        assert.deepStrictEqual(m.window(FILE, 4, SRC), { startLine: 4, endLine: 4, collector: 4 });
        // `\begin{equation}` belongs to the display it opens.
        assert.deepStrictEqual(m.window(FILE, 5, SRC), { startLine: 5, endLine: 6, collector: 6 });
        // A blank line ends a construct; line 8 has nothing to belong to…
        // (line 9 `\begin{figure}` is glyph-less and leads to the caption).
        assert.strictEqual(m.window(FILE, 8, SRC), null);
    });

    await test('lineMap: the window aligned against the exact glyphs gives a COLUMN per glyph', () => {
        const m = makeMap();
        const am = m.lineMap({ file: FILE, line: 10, lines: SRC, inMath: false });
        assert.ok(am, 'a map for the caption');
        assert.deepStrictEqual(am.window, { startLine: 9, endLine: 11, collector: 11 });
        // "spans" is on source line 10; the token for its first letter must
        // pair with a glyph on the caption's first printed row.
        const t = tokenAt(am, 10, SRC[9].indexOf('spans'));
        assert.ok(t.index >= 0 && t.exact, 'token at "spans"');
        const gi = am.srcToRen[t.index];
        assert.ok(gi >= 0, 'paired');
        assert.ok(Math.abs(am.glyphs[gi].x - 205) < 0.01, `glyph x ${am.glyphs[gi].x}`);
        // "two" is on line 11, second printed row.
        const t2 = tokenAt(am, 11, 0);
        const g2 = am.glyphs[am.srcToRen[t2.index]];
        assert.ok(Math.abs(g2.x - 72) < 0.01 && g2.baseline > 310, 'second row');
        // The equation number never enters an alignment.
        const eq = m.lineMap({ file: FILE, line: 6, lines: SRC, inMath: true });
        assert.ok(eq && eq.glyphs.every(x => x.ch !== '('), 'no "(1)" in the equation map');
        const tx = tokenAt(eq, 6, 2);
        assert.ok(tx.index >= 0 && eq.srcToRen[tx.index] >= 0, 'x pairs');
    });

    await test('edits translate: a line inserted above shifts every answer and invalidates caches', () => {
        const m = makeMap();
        const before = m.lineRows(FILE, 3);
        m.noteEdit(FILE, 1, +2);
        assert.strictEqual(m.lineRows(FILE, 3).length, 0, 'old line 3 is now line 5');
        assert.deepStrictEqual(m.lineRows(FILE, 5), before);
        assert.strictEqual(m._baseFlag(), 'probably-current');
        assert.strictEqual(m.lineAtPoint(1, 107, 97).line, 5);
    });

    await test('linesOnPage, pageOccupancy, coverage come from the glyphs', () => {
        const m = makeMap();
        assert.deepStrictEqual(m.linesOnPage(1, FILE), [3, 4, 6, 7, 11, 15, 16, 17]);
        const occ = m.pageOccupancy(1);
        assert.ok(occ.fill > 0 && occ.rows === 8, JSON.stringify(occ));
        assert.strictEqual(m.coverage(FILE, 18).covered, 8);
    });

    await test('PAGE FURNITURE (kind 5) is dropped: the page number never becomes a line\'s ink', () => {
        const m = makeMap();
        assert.strictEqual(m.gm.furniture, 1);
        assert.ok(m.glyphsForLine(FILE, 4).every(g => g.str !== '1'));
        assert.strictEqual(m.lineRows(FILE, 4).length, 1, 'line 4 keeps its own row only');
    });

    await test('WINDOW: a peeker (\\paragraph) across a blank line joins the row it printed on', () => {
        const m = makeMap();
        assert.deepStrictEqual(m.window(FILE, 13, SRC), { startLine: 13, endLine: 15, collector: 15 });
        // and the line that owns the glyphs sees the peeker above it too
        assert.deepStrictEqual(m.window(FILE, 15, SRC), { startLine: 13, endLine: 15, collector: 15 });
        const am = m.lineMap({ file: FILE, line: 13, lines: SRC, inMath: false });
        const t = tokenAt(am, 13, SRC[12].indexOf('now'));
        assert.ok(t.index >= 0 && am.srcToRen[t.index] >= 0, 'the heading word pairs');
        assert.ok(Math.abs(am.glyphs[am.srcToRen[t.index]].x - 92) < 0.01);
    });

    await test('WINDOW: a construct opening on a line with its own ink is found by brace balance', () => {
        const m = makeMap();
        assert.deepStrictEqual(m.window(FILE, 17, SRC), { startLine: 16, endLine: 17, collector: 17 });
        const am = m.lineMap({ file: FILE, line: 17, lines: SRC, inMath: false });
        const t = tokenAt(am, 16, SRC[15].indexOf('note that'));
        assert.ok(t.index >= 0 && am.srcToRen[t.index] >= 0, 'the footnote\'s first word pairs');
        assert.ok(Math.abs(am.glyphs[am.srcToRen[t.index]].x - 80) < 0.01, 'onto the note row');
    });

    await test('the live overlay prefix is mapped back to the project path', () => {
        const { jl, mt } = writeFixture();
        const od = path.join(os.tmpdir(), 'wb-glyphmap-test', 'out', '_wblive');
        const meta2 = { ...META, files: { 1: path.join(od, 'paper.tex') } };
        const mt2 = mt + '.overlay.json';
        fs.writeFileSync(mt2, JSON.stringify(meta2));
        const m = new GlyphMap({
            generation: { generation: 3, glyphMapPath: jl, glyphMapMetaPath: mt2, overlayDir: od, projectDir: path.dirname(FILE) },
        });
        assert.strictEqual(m.lineRows(FILE, 3).length, 1, 'answers for the PROJECT path');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
