'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { ReviewRenderer, changedRanges, marksFor } = require('../../tex/reviewRender');
const { align } = require('../../tex/glyphAlign');

test('fragment alignment picks the complete equation instead of a shared prefix in preceding prose', () => {
    const source = [...'Q0(0)=1+abcdef'];
    const rendered = [...'Q0(0) preliminary prose Q0(0)=1+abcdef trailing prose'];
    const map = align(source, rendered, { freeRenderedEnds:true });
    assert.equal(map.matched, source.length);
    assert.equal(map.srcToRen[0], rendered.join('').lastIndexOf('Q0(0)'));
    assert.equal(map.srcToRen.at(-1) - map.srcToRen[0], source.length - 1);
});

test('a few shared equation symbols cannot stand in for a changed prose paragraph', () => {
    const text = String.raw`\paragraph{The weight.} On each interval $t$ runs over all of $\mathbb{R}$, so it vanishes inside $\Sigma$, at $t=\pm\sqrt{ab}$.`;
    const rows = [{ page:1, x:10, y:10, w:300, h:10 }];
    const result = marksFor({ macros:new Map() }, { context:{ lines:[text], startLine:1, endLine:1 },
        startLine:1, ranges:[{ line:0, col:0, len:text.length }], rows },
        [{ page:1, str:'t=log(t+a)(t-b)', x:10, y:10, baseline:20, w:100, h:10 }]);
    assert.deepEqual(result.marks, []);
    assert.deepEqual(result.crops, []);
    assert.match(result.error, /reliably/);
});

test('rendered marks follow changed source tokens and leave repeated unchanged words neutral', () => {
    const text = 'Alpha Alpha beta.';
    const detail = { context:{ lines:[text], startLine:1, endLine:1 }, startLine:1,
        ranges:[{ line:0, col:6, len:5 }], rows:[{ page:1, x:10, y:10, w:100, h:10 }] };
    const items = [{ page:1, str:text, x:10, y:10, baseline:20, w:85, h:10 },
        { page:1, str:'Alpha', x:10, y:100, baseline:110, w:25, h:10 }];
    const result = marksFor({ macros:new Map() }, detail, items);
    assert.equal(result.mapped, 1);
    assert.equal(result.marks.length, 5);
    assert.ok(result.marks.every(r => r.x >= 40 && r.x < 65 && r.y < 30));
});

test('insertions and removals mark their entire new or removed content', () => {
    assert.deepEqual(changedRanges({ verb:'add', ourText:'New words.\nNext.' }, 'after'),
        [{ line:0, col:0, len:10 }, { line:1, col:0, len:5 }]);
    assert.deepEqual(changedRanges({ verb:'del', theirText:'Gone.' }, 'before'), [{ line:0, col:0, len:5 }]);
});

test('one changed subscript or numeral marks that source part, not the unchanged equation', () => {
    const hunk = { verb:'change', theirText:String.raw`\boxed{\mathcal{D}_{j}=1}`,
        ourText:String.raw`\boxed{\mathcal{D}_{j}=2}` };
    const before = changedRanges(hunk, 'before'), after = changedRanges(hunk, 'after');
    assert.deepEqual(before.map(r => hunk.theirText.slice(r.col, r.col + r.len)), ['1']);
    assert.deepEqual(after.map(r => hunk.ourText.slice(r.col, r.col + r.len)), ['2']);
});

test('source marks keep supplementary Unicode characters intact', () => {
    const hunk = { verb:'change', theirText:'Symbol 𝛴.', ourText:'Symbol 𝛵.' };
    const before = changedRanges(hunk, 'before'), after = changedRanges(hunk, 'after');
    assert.equal(hunk.theirText.slice(before[0].col, before[0].col + before[0].len), '𝛴');
    assert.equal(hunk.ourText.slice(after[0].col, after[0].col + after[0].len), '𝛵');
});

const texAvailable = spawnSync('latexmk', ['-v']).status === 0 && spawnSync('pdflatex', ['--version']).status === 0;
test('review compiles real headers and included files in two isolated immutable versions', { skip:!texAvailable }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-review-fixture-'));
    const root = path.join(dir, 'main.tex'), file = path.join(dir, 'body.tex'), header = path.join(dir, 'commands.tex');
    const rootText = '\\documentclass{article}\n\\input{commands}\n\\begin{document}\n\\input{body}\n\\end{document}\n';
    const headerText = '\\usepackage{amsmath}\n\\newcommand{\\paperword}{Authentic}\n\\newcommand{\\paperop}{\\mathcal{D}}\n';
    const oldText = 'The \\paperword{} old result is $\\paperop=1$.\n';
    const newText = 'The \\paperword{} new result is $\\paperop=2$.\n';
    fs.writeFileSync(root, rootText); fs.writeFileSync(header, headerText); fs.writeFileSync(file, newText);
    let calls = 0;
    const { compile } = require('../../tex/compileService');
    const renderer = new ReviewRenderer({ compile:o => { calls++; return compile(o); } });
    const after = new Map([[root, rootText], [header, headerText], [file, newText]]);
    const before = new Map(after); before.set(file, oldText);
    const options = { root, file, engine:'pdflatex', before, after,
        hunk:{ verb:'change', ourText:newText.trimEnd(), theirText:oldText.trimEnd(),
            ourRange:{ startLine:1, endLine:2 }, theirRange:{ startLine:1, endLine:2 } } };
    try {
        const [preloaded, result] = await Promise.all([
            renderer.preload(options, [options.hunk, { ...options.hunk, id:'second-correction' }]),
            renderer.render({ ...options, hunk:{ ...options.hunk, id:'second-correction' } }),
        ]);
        assert.equal(preloaded.length, 2, 'all corrections share just two prepared PDFs');
        assert.ok(preloaded.every(p => p.pages.includes(1)), 'affected pages are ready for background font/text loading');
        assert.equal(renderer.abort.signal.aborted, false, 'selection does not kill background work');
        for (const side of ['before','after']) {
            assert.equal(result[side].error, undefined);
            assert.ok(result[side].crops.length > 0);
            assert.ok(result[side].pdfBase64.startsWith('JVBER'));
            assert.equal(result[side].detail.snapshot.macros.has('paperword'), true);
            if (spawnSync('pdftotext', ['-v']).status === 0) {
                const text = execFileSync('pdftotext', [result[side].detail.snapshot.gen.pdfPath, '-'], { encoding:'utf8' });
                assert.match(text, side === 'before' ? /Authentic old/ : /Authentic new/);
            }
        }
        assert.notEqual(result.before.pdfBase64, result.after.pdfBase64);
        await renderer.render(options);
        assert.equal(calls, 2, 'changing the focused hunk can reuse both document builds');
        let reuseCalls = 0;
        const reuseRenderer = new ReviewRenderer({ compile:o => { reuseCalls++; return compile(o); } });
        const liveGen = result.after.detail.snapshot.gen;
        try {
            await reuseRenderer.render({ ...options, generation:liveGen });
            assert.equal(reuseCalls, 1, 'an identical settled PDF supplies the after side without recompiling');
        } finally { reuseRenderer.dispose(); }
        assert.equal(fs.existsSync(liveGen.pdfPath), true, 'review cleanup never removes borrowed viewer artifacts');
        const nativeGeneration = { ...liveGen, runner:'wlatex', engine:'wlatex', synctexPath:null };
        const nativeMap = { native:true, live:false, available:true, displaced:false,
            generation:nativeGeneration, materializedPages:[1],
            lineRows:(file,line) => result.after.detail.snapshot.map.lineRows(file,line) };
        const nativeRenderer = new ReviewRenderer({ compile:() => { throw new Error('settled Pro PDF should be reused'); } });
        try {
            const native = await nativeRenderer.render({ ...options, engine:'xelatex', before:after,
                generation:nativeGeneration, map:nativeMap });
            assert.equal(native.after.error, undefined);
            assert.equal(native.after.pdfBase64, result.after.pdfBase64);
            nativeMap.available = false;
            assert.ok(native.after.detail.snapshot.map.lineRows(file,1).length,
                'copied Pro geometry remains valid when the live session changes');
        } finally { nativeRenderer.dispose(); }
        assert.equal(fs.readFileSync(root, 'utf8'), rootText);
        assert.equal(fs.readFileSync(header, 'utf8'), headerText);
        assert.equal(fs.readFileSync(file, 'utf8'), newText);
        assert.equal(fs.existsSync(path.join(dir, 'main.pdf')), false, 'preview output never enters the paper directory');
    } finally { renderer.dispose(); fs.rmSync(dir, { recursive:true, force:true }); }
});

test('a failed document build is shared across corrections until the source changes', async () => {
    let calls = 0;
    const renderer = new ReviewRenderer({ compile:async () => { calls++; return { ok:false, diagnostics:[{ severity:'error', message:'Bad command' }] }; } });
    const options = { root:'/p/main.tex', file:'/p/main.tex', engine:'pdflatex',
        before:new Map([['/p/main.tex','Old']]), after:new Map([['/p/main.tex','New']]),
        hunk:{ ourRange:{ startLine:1,endLine:2 }, theirRange:{ startLine:1,endLine:2 } } };
    try {
        await renderer.preload(options, Array.from({ length:20 }, (_, id) => ({ ...options.hunk, id })));
        assert.equal(calls, 2, 'twenty corrections do not rerun a failing compiler forty times');
        renderer.cancel();
        await renderer.render({ ...options, after:new Map([['/p/main.tex','Fixed']]) });
        assert.equal(calls, 4, 'source invalidation permits a new build');
    } finally { renderer.dispose(); }
});

test('an obsolete preview cannot publish after cancellation', async () => {
    let resolve;
    const renderer = new ReviewRenderer({ compile:() => new Promise(r => { resolve = r; }) });
    const overlay = new Map([['/p/main.tex', 'Text']]);
    const pending = renderer.render({ root:'/p/main.tex', file:'/p/main.tex', engine:'pdflatex', before:overlay, after:overlay,
        hunk:{ ourRange:{ startLine:1, endLine:2 }, theirRange:{ startLine:1, endLine:2 } } });
    renderer.cancel(); resolve({ ok:false });
    await assert.rejects(pending, /cancelled/);
    renderer.dispose();
});

test('a ready snippet side is delivered while the other immutable version is still compiling',async()=>{
 const renderer=new ReviewRenderer();let release;
 const before=new Map([['/tmp/paper.tex','Old prose.']]),after=new Map([['/tmp/paper.tex','New prose.']]);
 const pending=new Promise(resolve=>{release=resolve;});
 renderer.snapshot=async(o,overlay)=>{if(overlay===before)await pending;
  return {key:overlay===before?'old':'new',pdfBase64:'pdf',models:new Map(),map:{lineRows:()=>[{page:1,x:10,y:10,w:100,h:10}],objectRenderBoxes:()=>({rects:[]})},macros:new Map()};};
 const got=[];
 const options={root:'/tmp/paper.tex',file:'/tmp/paper.tex',engine:'pdflatex',before,after,
  hunk:{verb:'change',theirText:'Old prose.',ourText:'New prose.',theirRange:{startLine:1,endLine:2},ourRange:{startLine:1,endLine:2}},
  onSide:(side,preview)=>got.push({side,preview})};
 try{
  const work=renderer.render(options);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(got.map(r=>r.side),['after']);release();await work;assert.deepEqual(got.map(r=>r.side),['after','before']);
  let calls=0;renderer.snapshot=async()=>{calls++;throw Error('old version fails safely');};
  const skipped=await renderer.render({...options,skipAfter:true});assert.equal(calls,1);assert.equal(skipped.after,undefined);
 }finally{release();renderer.dispose();}
});
