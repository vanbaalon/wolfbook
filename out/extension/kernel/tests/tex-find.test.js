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

test('search uses measured proportional glyph widths and printed ink height',async()=>{
 const f=await load();
 const items=[{str:'Wide Baxter iii',x:10,y:20,w:150,h:20,charBoxes:[
  {from:0,to:1,x:10,y:25,w:16,h:14},{from:1,to:2,x:26,y:25,w:4,h:14},
  {from:2,to:3,x:30,y:25,w:10,h:14},{from:3,to:4,x:40,y:28,w:9,h:11},
  {from:4,to:5,x:49,y:40,w:6,h:0},{from:5,to:6,x:55,y:25,w:12,h:14},
  {from:6,to:7,x:67,y:28,w:9,h:11},{from:7,to:8,x:76,y:28,w:9,h:11},
  {from:8,to:9,x:85,y:26,w:6,h:13},{from:9,to:10,x:91,y:28,w:9,h:11},
  {from:10,to:11,x:100,y:28,w:6,h:11},{from:11,to:12,x:106,y:40,w:6,h:0},
  {from:12,to:13,x:112,y:25,w:4,h:14},{from:13,to:14,x:116,y:25,w:4,h:14},{from:14,to:15,x:120,y:25,w:4,h:14}]}];
 const model=f.pageText(items),[[start,end]]=f.findAll(model.text,'baxter');
 assert.deepEqual(f.spanRects(items,f.matchSpans(model,start,end)),[{x:55,y:25,w:51,h:14}]);
 const [[a,z]]=f.findAll(model.text,'axte');
 assert.deepEqual(f.spanRects(items,f.matchSpans(model,a,z)),[{x:67,y:26,w:33,h:13}]);
});

test('measured boxes honour UTF-16 spans for ligatures and supplementary math characters',async()=>{
 const f=await load();
 const items=[{str:'ﬁ 𝑥',x:0,y:0,w:40,h:15,charBoxes:[
  {from:0,to:1,x:0,y:3,w:8,h:11},{from:1,to:2,x:8,y:14,w:4,h:0},{from:2,to:4,x:12,y:4,w:9,h:10}]}];
 const model=f.pageText(items);
 for(const [query,expected] of [['fi',{x:0,y:3,w:8,h:11}],['x',{x:12,y:4,w:9,h:10}]]){
  const [[start,end]]=f.findAll(model.text,query);
  assert.deepEqual(f.spanRects(items,f.matchSpans(model,start,end)),[expected]);
 }
});
