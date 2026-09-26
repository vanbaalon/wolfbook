const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.resolve(__dirname, '../../../client/tex-find.mjs')).href);
const run = (str, x, y, w, h = 10) => ({ str, x, y, w, h });

test('printed characters fold to what people type', async () => {
    const f = await load();
    assert.equal(f.foldQuery('  Schrödinger   Equation '), 'schrodinger equation');
    assert.equal(f.foldQuery('𝑥 − 𝑦'), 'x - y', 'math italic and the minus sign');
    assert.equal(f.foldQuery('ﬁrst “quoted” it’s'), 'first "quoted" it\'s');
});

test('runs join with spaces at gaps and line breaks, and hyphenated words rejoin', async () => {
    const f = await load();
    const items = [
        run('The quick', 0, 0, 45), run('brown', 50, 0, 25),      // a gap: a space
        run('fox', 75, 0, 15),                                   // touching: no space
        run('inter-', 0, 12, 30), run('esting', 0, 24, 30),      // hyphenated across lines
        run('well-', 0, 36, 25), run('Known', 0, 48, 25),        // not a lowercase continuation
    ];
    const m = f.pageText(items);
    assert.equal(m.text, 'the quick brownfox interesting well- known');
    assert.equal(m.text.length, m.at.length);
    assert.deepEqual(m.at[0], [0, 0, 1]);
    assert.equal(m.at[9], null, 'the space between two runs belongs to neither');
});

test('matches map back to per-run character spans and boxes', async () => {
    const f = await load();
    const items = [run('Hello wor', 0, 0, 90), run('ld again', 100, 0, 80)];
    const m = f.pageText(items);
    // A 10-unit gap between the runs is a space, so "world" is not found.
    assert.deepEqual(f.findAll(m.text, 'world'), []);
    assert.deepEqual(f.findAll(m.text, 'wor ld'), [[6, 12]]);
    const spans = f.matchSpans(m, 6, 12);
    assert.deepEqual(spans, [{ run: 0, from: 6, to: 9 }, { run: 1, from: 0, to: 2 }]);
    const rects = f.spanRects(items, spans);
    assert.deepEqual(rects.map(r => [r.x, r.w]), [[60, 30], [100, 20]], 'runs a space apart stay two boxes');
    // Glyph-sized runs (a live page) that touch make one box.
    const glyphs = [run('f', 0, 0, 3), run('o', 3, 0, 5), run('x', 8.5, 0, 5)];
    const g = f.pageText(glyphs);
    const [[gs, ge]] = f.findAll(g.text, 'fox');
    assert.deepEqual(f.spanRects(glyphs, f.matchSpans(g, gs, ge)), [{ x: 0, y: 0, w: 13.5, h: 10 }]);
    // Repeated matches do not overlap.
    const t = f.pageText([run('aaaa', 0, 0, 40)]).text;
    assert.deepEqual(f.findAll(t, 'aa'), [[0, 2], [2, 4]]);
    assert.deepEqual(f.findAll(t, '   '), [], 'an empty query finds nothing');
});

test('a ligature or math letter matches inside its run', async () => {
    const f = await load();
    const items = [run('the ﬁnal 𝑥', 0, 0, 100)];
    const m = f.pageText(items);
    assert.equal(m.text, 'the final x');
    const [[s, e]] = f.findAll(m.text, 'fin');
    // "fi" comes from the one ligature character; "n" is the next one.
    assert.deepEqual(f.matchSpans(m, s, e), [{ run: 0, from: 4, to: 6 }]);
    const [[xs, xe]] = f.findAll(m.text, 'x');
    assert.deepEqual(f.matchSpans(m, xs, xe), [{ run: 0, from: 9, to: 11 }], '𝑥 is two UTF-16 units');
});
