const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { NativeMap, rectangle } = require('../../tex/nativeMap');
const root = path.join(os.tmpdir(), 'wpaper-native-fixture');
const file = path.join(root, 'paper.tex');
const SP = 65536;
const location = (column, accuracy = 'Exact') => ({ compiled_revision: 0, current_revision: 1,
    start: { line: 4, column_utf16: column }, end: { line: 4, column_utf16: column + 1 }, accuracy });
function fixture() {
    let current = true;
    const source = { isCurrentView: candidate => candidate === view && current };
    const hits = [0, 1, 2].map(i => {
        const origin = { file: 'paper.tex', location: location(i) };
        return { item_id: i, preferred_source: i === 2 ? null : origin,
            mapped_origins: i === 2 ? [] : [{ span: { tag: 1, line: 4, column: i, length: 1 }, source: origin }],
            box_path: [[8, { kind: 'Horizontal' }]],
            item: { page: 1, kind: i === 2 ? 'Rule' : 'Glyph', provenance: { definition: { line: 4 } },
                glyph: { font: 1, code: 65 + i },
                geometry: { position: { x: i * 10 * SP, y: 20 * SP }, width: 8 * SP, height: 7 * SP, depth: 2 * SP } } };
    });
    const view = { generation: 2, sequence: 1, artifact: { page_count: 2, pdf_hash: 'paired' },
        pages: [{ page: 1, header: { magnification: 1000, horizontal_offset: 123, vertical_offset: 456 }, hits },
            { page: 2, header: { magnification: 1000 }, hits: [] }] };
    const map = new NativeMap({ generation: { pdfHash: 'paired', projectDir: root }, nativeView: view, nativeSource: source });
    return { map, view, source, invalidate: () => { current = false; } };
}

test('native DVI coordinates use one inch, magnification and normalized signed extents', () => {
    const r = rectangle({ position: { x: 0, y: 0 }, width: -SP, height: 2 * SP, depth: SP },
        { magnification: 2000, horizontal_offset: 123456789, vertical_offset: 123456789 });
    const bp = 72 / 72.27;
    assert.equal(r.baseline, 72);
    assert.ok(Math.abs(r.x - (72 - 2 * bp)) < 1e-10);
    assert.ok(Math.abs(r.y - (72 - 4 * bp)) < 1e-10);
    assert.ok(Math.abs(r.h - 6 * bp) < 1e-10);
});

test('native rows and inverse columns retain the worker origins and exclude furniture', () => {
    const { map } = fixture();
    const rows = map.lineRows(file, 4);
    assert.equal(rows.length, 1);
    assert.equal(map.window(file, 4).collector, 4);
    assert.equal(rows[0].glyphs, 2);
    const glyph = map.glyphsForLine(file, 4)[1];
    const hit = map.renderToSource(1, glyph.x + glyph.w / 2, glyph.y + glyph.boxHeight / 2);
    assert.equal(hit.file, file);
    assert.equal(hit.column, 1);
    assert.equal(hit.line, 4);
    assert.equal(hit.generationLine, 4);
    assert.equal(hit.exact, true);
    assert.equal(map.fileOf(hit.glyph.fileId), file);
    assert.equal(map.renderToSource(1, 0, 0).flag, 'unmapped');
    assert.deepEqual(map.linesOnPage(1, file), [4]);
    assert.deepEqual(map.linesOnPage(2, file), []);
    assert.equal(map.pageOccupancy(2).records, 0);
    assert.equal(map.sourceToRender(file, 4).boxes.length, 1);
});

test('column maps bind all native contributors without text alignment or collector guesses', () => {
    const { map, view } = fixture();
    // Rebuild with an additional shaping contributor at a nonadjacent column.
    view.pages[0].hits[0].mapped_origins.push({ span: { tag: 1, line: 4, column: 3, length: 1 },
        source: { file: 'paper.tex', location: location(3) } });
    const columns = map.lineMap({ file, line: 4, lines: ['', '', '', 'XYZQ'] });
    assert.deepEqual(columns.tokens.map(t => t.startCol), [0, 1, 3]);
    assert.equal(columns.srcToRen[0], columns.srcToRen[2]);
    assert.equal(columns.confidence, 1);
    assert.equal(map.lineMap({ file, line: 3, lines: [] }), null);
    view.pages[0].hits[0].mapped_origins[0].source.location.accuracy = 'Displaced';
    assert.ok(!map.lineMap({ file, line: 4, lines: [] }).tokens.some(t => t.startCol === 0));
});

test('queued worker edits and legacy notifications invalidate every native lookup', () => {
    const { map, invalidate } = fixture();
    assert.equal(map.exact, true);
    invalidate();
    assert.equal(map.available, false);
    assert.deepEqual(map.lineRows(file, 4), []);
    assert.equal(map.lineMap({ file, line: 4 }), null);
    assert.equal(map.renderToSource(1, 75, 90).flag, 'unmapped');
    const other = fixture().map;
    other.noteEdit(file, 1, 0); // Same-line edits must invalidate too.
    other.clearEdits();
    assert.equal(other.available, false);
});

test('error hints can use retained native ink after failure, marked approximate, without enabling stale editing', () => {
    const { map, invalidate } = fixture();
    const exact = map.diagnosticLocation(file, 4);
    assert.equal(exact.exact, true);
    assert.equal(exact.rects.length, 1);
    const nearby = map.diagnosticLocation(file, 5);
    assert.equal(nearby.matchedLine, 4);
    assert.equal(nearby.exact, false);
    invalidate();
    const retained = map.diagnosticLocation(file, 4);
    assert.equal(retained.exact, false);
    assert.deepEqual(retained.rects, exact.rects);
    assert.deepEqual(map.lineRows(file, 4), [], 'editing still rejects the stale map');
    assert.equal(map.diagnosticLocation(path.join(root, 'other.tex'), 4), null);
    assert.equal(map.diagnosticLocation(file, 1000), null);
});

test('a native view cannot be paired with another PDF', () => {
    const { view, source } = fixture();
    assert.throws(() => new NativeMap({ generation: { pdfHash: 'other' }, nativeView: view, nativeSource: source }), /displayed PDF/);
});

test('displaced enclosing ranges do not invent ink on inserted interior lines', () => {
    const { view, source } = fixture();
    const location = view.pages[0].hits[0].mapped_origins[0].source.location;
    location.accuracy = 'Displaced';
    location.end = { line: 1000000, column_utf16: 1 };
    const map = new NativeMap({ nativeView: view, nativeSource: source, projectDir: root });
    assert.deepEqual(map.linesOnPage(1, file), [4, 1000000]);
    assert.deepEqual(map.lineRows(file, 500000), []);
    assert.equal(map.sourceToRender(file, 4).flag, 'probably-current');
});


test('native cursor admission uses worker membership instead of enclosing ranges', async () => {
    const { map, source, view, invalidate } = fixture();
    let requested;
    source.forward = async (...args) => { requested = args; return { hits:[view.pages[0].hits[1]] }; };
    const rects = await map.forwardAt(file, 4, 1);
    assert.deepEqual(requested, ['paper.tex', 4, 1]);
    assert.equal(rects.length, 1);
    assert.equal(rects[0].x, map.glyphsForLine(file, 4)[1].x);
    // A position that prints nothing lights the nearest printed glyph of its
    // line (column 1 is nearer to 2 than column 0), marked approximate.
    source.forward = async () => ({ hits:[] });
    const near = await map.forwardAt(file, 4, 2);
    assert.equal(near.length, 1);
    assert.equal(near[0].x, map.glyphsForLine(file, 4)[1].x);
    assert.equal(near[0].approximate, true);
    // Nothing printed within two lines: nothing.
    assert.deepEqual(await map.forwardAt(file, 9, 0), []);
    source.forward = async () => { invalidate(); return { hits:[view.pages[0].hits[0]] }; };
    assert.equal(await map.forwardAt(file, 4, 0), null);
});

test('native exact ranges select contributors without querying every character', async () => {
    const { map, source } = fixture();
    source.files = new Map([['paper.tex', { text:'\n\n\nABC' }]]);
    source.forward = () => { throw Error('exact contiguous ranges need no point queries'); };
    const selected = await map.forwardRange(file,
        { line:4, column_utf16:0 }, { line:4, column_utf16:2 });
    assert.equal(selected.length, 2);
    assert.deepEqual(await map.forwardRange(file, { line:4, column_utf16:2 }, { line:4, column_utf16:3 }), []);
});

test('displaced native ranges query membership and do not select inserted interiors', async () => {
    const { view, source } = fixture();
    const origin = view.pages[0].hits[0].mapped_origins[0].source;
    origin.location = { ...location(0, 'Displaced'), end:{ line:4, column_utf16:4 } };
    // Other entries do not describe this selected source file.
    view.pages[0].hits = [view.pages[0].hits[0]];
    source.files = new Map([['paper.tex', { text:'\n\n\nANEW' }]]);
    source.forward = async (file, line, col) => ({ hits:col === 0 ? view.pages[0].hits : [] });
    const map = new NativeMap({ generation:{ pdfHash:'paired', projectDir:root }, nativeView:view, nativeSource:source });
    assert.deepEqual(await map.forwardRange(file, { line:4, column_utf16:1 }, { line:4, column_utf16:4 }), []);
    assert.equal((await map.forwardRange(file, { line:4, column_utf16:0 }, { line:4, column_utf16:4 })).length, 1);
});

test('native range admission is cancelled if the selection or source changes during membership queries', async () => {
    const { view, source, invalidate } = fixture();
    for (const hit of view.pages[0].hits) for (const origin of hit.mapped_origins)
        origin.source.location.accuracy = 'Displaced';
    source.files = new Map([['paper.tex', { text:'\n\n\nABC' }]]);
    source.forward = async () => { invalidate(); return { hits:view.pages[0].hits }; };
    const map = new NativeMap({ generation:{ pdfHash:'paired', projectDir:root }, nativeView:view, nativeSource:source });
    assert.equal(await map.forwardRange(file, { line:4, column_utf16:0 }, { line:4, column_utf16:2 }), null);
});

test('native ranges respect UTF-16 boundaries and CRLF line positions', async () => {
    const { view, source } = fixture();
    const origins = [
        { start:{ line:1, column_utf16:2 }, end:{ line:1, column_utf16:3 } },
        { start:{ line:2, column_utf16:0 }, end:{ line:2, column_utf16:1 } },
    ];
    for (let i = 0; i < 2; i++) Object.assign(view.pages[0].hits[i].mapped_origins[0].source.location, origins[i]);
    source.files = new Map([['paper.tex', { text:'😀A\r\nB' }]]);
    const map = new NativeMap({ generation:{ pdfHash:'paired', projectDir:root }, nativeView:view, nativeSource:source });
    assert.equal((await map.forwardRange(file, { line:1, column_utf16:2 }, { line:2, column_utf16:1 })).length, 2);
    await assert.rejects(map.forwardRange(file, { line:1, column_utf16:1 }, { line:1, column_utf16:3 }), /Invalid/);
    await assert.rejects(map.forwardRange(file, { line:1, column_utf16:4 }, { line:2, column_utf16:1 }), /Invalid/);
});


test('unqualified native previews retain exact provenance without claiming authoritative freshness', () => {
    const { map, invalidate } = fixture();
    const glyph = map.glyphsForLine(file, 4)[0];
    const hit = map.renderToSource(1, glyph.x + glyph.w / 2, glyph.y + glyph.boxHeight / 2);
    assert.equal(hit.exact, true);
    assert.equal(hit.sourceRange.accuracy, 'Exact');
    assert.equal(hit.flag, 'probably-current');
    assert.equal(map.sourceToRender(file, 4).flag, 'probably-current');
    assert.equal(map.pageOccupancy(1).flag, 'probably-current');
    invalidate();
    assert.equal(map.sourceToRender(file, 4).flag, 'unmapped');
});


test('failed live queries permanently invalidate cached native source actions', async () => {
    for (const range of [false, true]) {
        const { map, view, source } = fixture();
        const glyph = map.glyphsForLine(file, 4)[0];
        source.files = new Map([['paper.tex', { text:'\n\n\nABC' }]]);
        for (const hit of view.pages[0].hits) for (const origin of hit.mapped_origins)
            origin.source.location.accuracy = 'Displaced';
        source.forward = async () => { throw Error('source worker exited'); };
        await assert.rejects(range
            ? map.forwardRange(file, { line:4,column_utf16:0 }, { line:4,column_utf16:2 })
            : map.forwardAt(file, 4, 0), /worker exited/);
        assert.equal(map.available, false);
        assert.equal(map.renderToSource(1, glyph.x+1, glyph.y+1).flag, 'unmapped');
        assert.deepEqual(map.glyphsForLine(file,4), []);
        source.forward = async () => ({ hits:view.pages[0].hits });
        assert.equal(await map.forwardAt(file,4,0), null, 'only a fresh admitted view can recover');
    }
});

test('displaced interval sweep matches an independent source-membership oracle', async () => {
    let seed = 98271;
    const random = n => { seed = (Math.imul(seed,1664525)+1013904223) >>> 0; return seed % n; };
    for (let trial=0; trial<80; trial++) {
        const { view, source } = fixture();
        const template = view.pages[0].hits[0];
        const memberships = new Map();
        view.pages[0].hits = Array.from({ length:24 }, (_,id) => {
            const hit = structuredClone(template), lo=random(40), hi=lo+random(41-lo);
            hit.item_id=id;
            hit.item.geometry.position.x=id*10*SP;
            const loc = { ...location(lo,'Displaced'), start:{ line:1,column_utf16:lo }, end:{ line:1,column_utf16:hi } };
            hit.mapped_origins[0].source.location=loc;
            hit.preferred_source.location=loc;
            memberships.set(id, new Set(Array.from({ length:random(4) }, () => lo+(hi===lo ? 0 : random(hi-lo)))));
            return hit;
        });
        source.files = new Map([['paper.tex', { text:'x'.repeat(40) }]]);
        const queried = new Set();
        source.forward = async (_,line,col) => {
            assert.equal(line,1);
            assert.ok(!queried.has(col), 'a source position must be queried at most once');
            queried.add(col);
            return { hits:view.pages[0].hits.filter(hit => memberships.get(hit.item_id).has(col)) };
        };
        const lo=random(40), hi=lo+1+random(40-lo);
        const expected = [...memberships].filter(([,points]) => [...points].some(p => lo<=p && p<hi)).map(([id]) => id);
        const map = new NativeMap({ generation:{ pdfHash:'paired',projectDir:root }, nativeView:view,nativeSource:source });
        const result = await map.forwardRange(file,{ line:1,column_utf16:lo },{ line:1,column_utf16:hi });
        const actual = result.map(rect => Math.round((rect.x-72)/(10*SP*72/(72.27*SP)))).sort((a,b)=>a-b);
        assert.deepEqual(actual,expected,`trial ${trial}, selection ${lo}..${hi}`);
    }
});

test('overlapping displaced origins share one scan of a large inserted range', async () => {
    const { view,source } = fixture();
    const template = view.pages[0].hits[0];
    const length=4000, count=300;
    view.pages[0].hits=Array.from({ length:count }, (_,id) => {
        const hit=structuredClone(template); hit.item_id=id;
        hit.mapped_origins[0].source.location={ ...location(0,'Displaced'),
            start:{ line:1,column_utf16:0 },end:{ line:1,column_utf16:length } };
        return hit;
    });
    source.files=new Map([['paper.tex',{ text:'x'.repeat(length) }]]);
    let calls=0;
    source.forward=async (_,line,col) => { calls++; return { hits:col===length-1 ? view.pages[0].hits : [] }; };
    const map=new NativeMap({ generation:{ pdfHash:'paired',projectDir:root },nativeView:view,nativeSource:source });
    assert.equal((await map.forwardRange(file,{ line:1,column_utf16:0 },{ line:1,column_utf16:length })).length,count);
    assert.equal(calls,length);
});

test('displaced sweep queries scalar boundaries across CRLF lines', async () => {
    const { view,source } = fixture();
    view.pages[0].hits=[view.pages[0].hits[0]];
    view.pages[0].hits[0].mapped_origins[0].source.location={ ...location(0,'Displaced'),
        start:{ line:1,column_utf16:0 },end:{ line:2,column_utf16:3 } };
    source.files=new Map([['paper.tex',{ text:'😀\r\nXYZ' }]]);
    const queries=[];
    source.forward=async (_,line,col) => {
        queries.push([line,col]);
        return { hits:line===2 && col===2 ? view.pages[0].hits : [] };
    };
    const map=new NativeMap({ generation:{ pdfHash:'paired',projectDir:root },nativeView:view,nativeSource:source });
    assert.equal((await map.forwardRange(file,{ line:1,column_utf16:0 },{ line:2,column_utf16:3 })).length,1);
    assert.deepEqual(queries,[[1,0],[1,2],[2,0],[2,1],[2,2]]);
});

/** A one-page view of `hits`, as the worker answers, over `projectDir`. */
function viewOf(hits, projectDir, outDir) {
    const source = { isCurrentView: () => true };
    const view = { generation: 1, sequence: 1, artifact: { page_count: 1, pdf_hash: 'h' },
        pages: [{ page: 1, header: { magnification: 1000 }, hits }] };
    return new NativeMap({ generation: { pdfHash: 'h', projectDir, outDir }, nativeView: view, nativeSource: source });
}
const glyphAt = (id, x, extra = {}) => ({ item_id: id, box_path: [[9, { kind: 'Horizontal' }]], preferred_source: null, mapped_origins: [],
    item: { page: 1, kind: 'Glyph', provenance: { definition: { tag: 0, line: 0, column: 0 }, invocation: { tag: 0, line: 0, column: 0 } },
        glyph: { font: 1, code: 65 }, geometry: { position: { x: x * SP, y: 20 * SP }, width: 6 * SP, height: 7 * SP, depth: 2 * SP } }, ...extra });
const centre = (map, id) => { const e = map._byItem.get(id); return [e.x + e.w / 2, e.y + e.boxHeight / 2]; };

test('a bibliography entry typeset from the .bbl leads to its .bib record (natbib and amsrefs keys)', () => {
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-bbl-')), out = path.join(dir, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(dir, 'refs.bib'), '@book{other,\n title={Other}\n}\n\n@article {knuth84,\n title={The TeXbook}\n}\n@misc{ams26,\n}\n');
    fs.writeFileSync(path.join(out, 'paper.bbl'), ['\\begin{thebibliography}{1}', '', '\\bibitem[{Knuth(1984)}]{knuth84}',
        'D. Knuth, The TeXbook.', '', '\\bib{ams26}{misc}{', '  title={A title},', '}'].join('\n'));
    const map = viewOf([glyphAt(0, 0, { generated_source: { file: 'paper.bbl', line: 4, column: 3 } }),
        glyphAt(1, 20, { generated_source: { file: 'paper.bbl', line: 7, column: 2 } }),
        glyphAt(2, 40, { generated_source: { file: 'paper.bbl', line: 1, column: 0 } })], dir, out);
    const knuth = map.renderToSource(1, ...centre(map, 0));
    assert.equal(knuth.file, path.join(dir, 'refs.bib'));
    assert.equal(knuth.line, 5, 'the @article line of knuth84');
    assert.deepEqual(knuth.generated, { file: 'paper.bbl', line: 4, column: 3 });
    assert.equal(map.renderToSource(1, ...centre(map, 1)).line, 8, "amsrefs' \\bib{key}{type}");
    // Above the first entry ("References") there is no key: no answer.
    assert.equal(map.renderToSource(1, ...centre(map, 2)).flag, 'unmapped');
});

test('a contents line typeset from the .toc leads to the heading with its title', () => {
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-toc-')), out = path.join(dir, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(dir, 'paper.tex'), ['\\documentclass{amsart}', '\\begin{document}', '\\tableofcontents',
        '\\section{Hopf algebras and \\Sym}', 'Text.', '\\subsection*{Main results}'].join('\n'));
    fs.writeFileSync(path.join(out, 'paper.toc'), ['\\contentsline {section}{\\tocsection {}{1}{Hopf algebras and Sym}}{1}{section.1}%',
        '\\contentsline {subsection}{\\numberline {1.1}Main results}{2}{subsection.1.1}%'].join('\n'));
    const map = viewOf([glyphAt(0, 0, { generated_source: { file: 'paper.toc', line: 1, column: 40 } }),
        glyphAt(1, 20, { generated_source: { file: 'paper.toc', line: 2, column: 45 } })], dir, out);
    const section = map.renderToSource(1, ...centre(map, 0));
    assert.equal(section.file, path.join(dir, 'paper.tex'));
    assert.equal(section.line, 4, 'most title words match; \\Sym is a macro in the source');
    assert.equal(map.renderToSource(1, ...centre(map, 1)).line, 6);
});

test('a letter \\MakeUppercase rebuilt takes the source of a typed letter of its word', () => {
    const typed = { tag: 1, line: 7, column: 9, length: 1 }, call = { tag: 1, line: 12, column: 0, length: 10 };
    const at = (span, file = 'paper.tex') => ({ file, location: { compiled_revision: 0, current_revision: 1,
        start: { line: span.line, column_utf16: span.column }, end: { line: span.line, column_utf16: span.column + 1 }, accuracy: 'Exact' } });
    // "A" kept its token (typed in \author{…}); "B" and "C" were rebuilt and
    // carry only \maketitle's call; "D", a word away, as well.
    const hits = [
        glyphAt(0, 0, { preferred_source: at(typed), mapped_origins: [{ span: typed, source: at(typed) }] }),
        glyphAt(1, 6, { preferred_source: at(call), mapped_origins: [{ span: call, source: at(call) }] }),
        glyphAt(2, 12, { preferred_source: at(call), mapped_origins: [{ span: call, source: at(call) }] }),
        glyphAt(3, 24, { preferred_source: at(call), mapped_origins: [{ span: call, source: at(call) }] }),
    ];
    hits[0].item.provenance.definition = { tag: 1, line: 7, column: 9 };
    for (const h of hits.slice(1)) h.item.provenance.invocation = { tag: 1, line: 12, column: 0 };
    const map = viewOf(hits, root, null);
    const c = map.renderToSource(1, ...centre(map, 2));
    assert.deepEqual([c.line, c.column], [7, 9], 'C answers with A, typed in \\author');
    const d = map.renderToSource(1, ...centre(map, 3));
    assert.deepEqual([d.line, d.column], [12, 0], 'D, in another word, keeps its own answer');
});

test('a click next to ink lands on the nearest sourced glyph of its line; far from any, nowhere', () => {
    const { map } = fixture();
    const [first, second] = map.glyphsForLine(file, 4);
    // Between the two glyph boxes (they are 8 wide, 10 apart): the nearer.
    const gap = map.renderToSource(1, second.x - 0.5, second.y + second.boxHeight / 2);
    assert.equal(gap.approximate, true);
    assert.equal(gap.column, 1);
    // Just above the line, within a line's height: still that line.
    assert.equal(map.renderToSource(1, first.x + first.w / 2, first.y - 3).column, 0);
    // Two lines' height above, or an inch and more along: nothing.
    assert.equal(map.renderToSource(1, first.x + first.w / 2, first.y - 40).flag, 'unmapped');
    assert.equal(map.renderToSource(1, second.x + second.w + 80, second.y + 2).flag, 'unmapped');
});

test('for a right-click, the nearest exactly sourced glyph however far (a margin, between paragraphs)', () => {
    const { map } = fixture();
    const [first, second] = map.glyphsForLine(file, 4);
    const margin = map.nearestExact(1, second.x + second.w + 200, second.y + 2);
    assert.equal(margin.exact, true);
    assert.equal(margin.line, 4); assert.equal(margin.column, 1, 'the end of the line level with the click');
    const above = map.nearestExact(1, first.x + first.w / 2, first.y - 40);
    assert.equal(above.line, 4); assert.equal(above.column, 0);
});

test('a click on text a preamble macro defined lands on its call in the body', () => {
    const text = ['\\documentclass{article}', '\\DeclareMathOperator{\\Gr}{Gr}', '\\begin{document}', 'See $\\Gr(k,n)$ here.', '\\emph{typed}', '\\end{document}'].join('\n');
    const at = (line, column) => ({ file: 'paper.tex', location: { compiled_revision: 0, current_revision: 1,
        start: { line, column_utf16: column }, end: { line, column_utf16: column + 1 }, accuracy: 'Exact' } });
    const hit = (id, x, definition, invocation) => {
        const h = glyphAt(id, x, { preferred_source: at(definition.line, definition.column),
            mapped_origins: [definition, invocation].map(sp => ({ span: { tag: 1, length: 1, ...sp }, source: at(sp.line, sp.column) })) });
        h.item.provenance = { definition: { tag: 1, ...definition }, invocation: { tag: 1, ...invocation } };
        return h;
    };
    const view = { generation: 1, sequence: 1, artifact: { page_count: 1, pdf_hash: 'h' },
        pages: [{ page: 1, header: { magnification: 1000 }, hits: [
            hit(0, 0, { line: 2, column: 26 }, { line: 4, column: 5 }),     // "G" of \Gr: defined in the preamble
            hit(1, 30, { line: 5, column: 6 }, { line: 5, column: 0 }),     // "t" of \emph{typed}: typed in the body
        ] }] };
    const map = new NativeMap({ generation: { pdfHash: 'h', projectDir: root }, nativeView: view,
        nativeSource: { isCurrentView: () => true, files: new Map([['paper.tex', { text }]]) } });
    const gr = map.renderToSource(1, ...centre(map, 0));
    assert.deepEqual([gr.line, gr.column], [4, 5], 'the \\Gr in the text, not its definition');
    const typed = map.renderToSource(1, ...centre(map, 1));
    assert.deepEqual([typed.line, typed.column], [5, 6], 'an argument keeps where it was typed');
});

test('a title typed in the preamble keeps its own line; a multi-line macro body does not', () => {
    const text = ['\\documentclass{article}', '\\title{Walking flows}', '\\newcommand{\\Gr}{%', '  \\mathrm{Gr}}',
        '\\begin{document}', '\\maketitle', 'See $\\Gr$.', '\\end{document}'].join('\n');
    const at = (line, column) => ({ file: 'paper.tex', location: { compiled_revision: 0, current_revision: 1,
        start: { line, column_utf16: column }, end: { line, column_utf16: column + 1 }, accuracy: 'Exact' } });
    const hit = (id, x, definition, invocation) => {
        const h = glyphAt(id, x, { preferred_source: at(definition.line, definition.column),
            mapped_origins: [definition, invocation].map(sp => ({ span: { tag: 1, length: 1, ...sp }, source: at(sp.line, sp.column) })) });
        h.item.provenance = { definition: { tag: 1, ...definition }, invocation: { tag: 1, ...invocation } };
        return h;
    };
    const view = { generation: 1, sequence: 1, artifact: { page_count: 1, pdf_hash: 'h' },
        pages: [{ page: 1, header: { magnification: 1000 }, hits: [
            hit(0, 0, { line: 2, column: 7 }, { line: 6, column: 0 }),      // "W" of the title, printed by \maketitle
            hit(1, 30, { line: 4, column: 11 }, { line: 7, column: 5 }),    // "G" in \Gr's body, a line below \newcommand
        ] }] };
    const map = new NativeMap({ generation: { pdfHash: 'h', projectDir: root }, nativeView: view,
        nativeSource: { isCurrentView: () => true, files: new Map([['paper.tex', { text }]]) } });
    assert.equal(map.renderToSource(1, ...centre(map, 0)).line, 2, 'the title line, not \\maketitle');
    assert.equal(map.renderToSource(1, ...centre(map, 1)).line, 7, 'the \\Gr in the text, not the macro body');
});

test('every macro on a shared definition line inversely maps to its own equation invocation', async () => {
    const definitions = '\\newcommand{\\iX}{\\mathbbm t}\\newcommand{\\iH}{\\mathbb H}\\newcommand{\\iV}{\\mathbbm v}\\newcommand{\\bbs}{\\mathbbm s}';
    const equation = '\\iH + \\iV + \\bbs = \\iX';
    const text = ['\\documentclass{article}',definitions,'\\begin{document}','\\begin{equation}',equation,'\\end{equation}','\\end{document}'].join('\n');
    const at = (line,column) => ({ file:'paper.tex',location:{ compiled_revision:0,current_revision:1,
        start:{ line,column_utf16:column },end:{ line,column_utf16:column+1 },accuracy:'Exact' } });
    const names = ['iX','iH','iV','bbs'];
    const hits = names.map((name,id) => {
        const definition = { tag:1,line:2,column:definitions.indexOf('}',definitions.indexOf('\\'+name))+2 };
        const invocation = { tag:1,line:5,column:equation.indexOf('\\'+name) };
        const h = glyphAt(id,id*30,{ preferred_source:at(definition.line,definition.column),
            mapped_origins:[definition,invocation].map(span => ({ span:{ ...span,length:1 },source:at(span.line,span.column) })) });
        h.item.provenance = { definition,invocation };
        return h;
    });
    for (const live of [false,true]) {
        const view = { live,generation:1,sequence:1,artifact:{ page_count:1,pdf_hash:'h' },
            pages:[{ page:1,header:{ magnification:1000 },hits }] };
        const source = { isCurrentView:() => true,files:new Map([['paper.tex',{ text }]]),
            inverse:async (_page,x) => ({ hits:[hits[Math.round(x / (30*SP))]] }) };
        const map = new NativeMap({ generation:{ pdfHash:'h',projectDir:root },nativeView:view,nativeSource:source });
        for (let id=0;id<hits.length;id++) {
            const point = centre(map,id), local = map.renderToSource(1,...point);
            assert.equal(local.line,5, `${names[id]} uses the equation call, including later definitions on the same line`);
            assert.equal(local.column,equation.indexOf('\\'+names[id]));
            const worker = await map.renderToSourceViaWorker(1,...point);
            assert.deepEqual([worker.line,worker.column],[local.line,local.column],'the worker path makes the same navigation choice');
        }
    }
});

test('long macro definitions and definitions after other commands keep call-site navigation', () => {
    for (const prefix of ['\\title{A title} ', '% do not read this commented \\newcommand{\\fake}{x}\n']) {
        const lines = ['\\documentclass{article}',prefix + '\\newcommand{\\Long}{%',
            ...Array.from({ length:12 },() => '  % long definition, with a commented }'),
            '  \\mathrm{Symbol}}','\\begin{document}','Use $\\Long$.','\\title{Another title}','\\end{document}'];
        const text = lines.join('\n'), all = text.split('\n');
        const definitionLine = all.findIndex(l => l.includes('\\mathrm{Symbol}')) + 1;
        const callLine = all.findIndex(l => l.startsWith('Use ')) + 1;
        const at = (line,column) => ({ file:'paper.tex',location:{ compiled_revision:0,current_revision:1,
            start:{ line,column_utf16:column },end:{ line,column_utf16:column+1 },accuracy:'Exact' } });
        const definition = { tag:1,line:definitionLine,column:all[definitionLine-1].indexOf('Symbol') };
        const invocation = { tag:1,line:callLine,column:all[callLine-1].indexOf('\\Long') };
        const h = glyphAt(0,0,{ preferred_source:at(definition.line,definition.column),
            mapped_origins:[definition,invocation].map(span => ({ span:{ ...span,length:1 },source:at(span.line,span.column) })) });
        h.item.provenance = { definition,invocation };
        const map = viewOf([h],root,null);
        map.source.files = new Map([['paper.tex',{ text }]]);
        const target = map.renderToSource(1,...centre(map,0));
        assert.equal(target.line,callLine,'a definition beyond the old eight-line lookback still targets its use');
        assert.equal(target.column,invocation.column);
    }
});

test('definition parsing skips defaults, comments and escaped delimiters while retaining typed arguments', () => {
    const definitions = [
        '\\newcommand*{\\Wrap}[1][{default}]{\\mathrm{#1}}',
        '\\NewDocumentCommand{\\Wrap}{m}{\\mathrm{#1}}',
        '\\def\\Wrap#1{\\{#1\\}+\\mathrm{X}}',
        '\\newcommand{\\First}{x} % \\newcommand{\\Fake}{never}\n\\providecommand\\Wrap[1]{\\mathrm{#1}}',
    ];
    for (const definitionText of definitions) {
        const lines = ['\\documentclass{article}',definitionText,'\\title{A typed title}',
            '\\begin{document}','Equation $\\Wrap{typed}$.','\\maketitle','\\end{document}'].join('\n').split('\n');
        const text = lines.join('\n');
        const definitionLine = lines.findIndex(l => l.includes('\\mathrm')) + 1;
        const invocationLine = lines.findIndex(l => l.startsWith('Equation')) + 1;
        const titleLine = lines.findIndex(l => l.startsWith('\\title')) + 1;
        const at = (line,column) => ({ file:'paper.tex',location:{ compiled_revision:0,current_revision:1,
            start:{ line,column_utf16:column },end:{ line,column_utf16:column+1 },accuracy:'Exact' } });
        const invocation = { tag:1,line:invocationLine,column:lines[invocationLine-1].indexOf('\\Wrap') };
        const hit = (id,definition,called=invocation) => {
            const h = glyphAt(id,id*30,{ preferred_source:at(definition.line,definition.column),
                mapped_origins:[definition,called].map(span => ({ span:{ ...span,length:1 },source:at(span.line,span.column) })) });
            h.item.provenance = { definition,invocation:called }; return h;
        };
        const hits = [hit(0,{ tag:1,line:definitionLine,column:lines[definitionLine-1].indexOf('\\mathrm')+3 }),
            hit(1,{ tag:1,line:invocationLine,column:lines[invocationLine-1].indexOf('typed') }),
            hit(2,{ tag:1,line:titleLine,column:7 },{ tag:1,line:titleLine+3,column:0 })];
        const map = viewOf(hits,root,null); map.source.files = new Map([['paper.tex',{ text }]]);
        const target = map.renderToSource(1,...centre(map,0));
        assert.deepEqual([target.line,target.column],[invocationLine,invocation.column],definitionText);
        const argument = map.renderToSource(1,...centre(map,1));
        assert.deepEqual([argument.line,argument.column],[invocationLine,lines[invocationLine-1].indexOf('typed')], 'actual argument text remains directly editable');
        assert.equal(map.renderToSource(1,...centre(map,2)).line,titleLine,'title text keeps its own position');
    }
});

test('the definition index ignores commented and escaped commands, preserves following title text and refreshes for edited buffers', () => {
    const text = ['% \\newcommand{\\Fake}{comment}', '\\\\newcommand{\\Fake}{literal}',
        '\\newcommand{\\Real}{x} \\title{A title}'].join('\n');
    const map = viewOf([],root,null); map.source.files = new Map([['paper.tex',{ text }]]);
    const at = (line,column) => ({ file:'paper.tex',location:{ start:{ line,column_utf16:column } } });
    assert.equal(map._inDefinition(at(1,text.split('\n')[0].indexOf('comment'))),false);
    assert.equal(map._inDefinition(at(2,text.split('\n')[1].indexOf('literal'))),false);
    const line = text.split('\n')[2];
    assert.equal(map._inDefinition(at(3,line.indexOf('x}'))),true);
    assert.equal(map._inDefinition(at(3,line.indexOf('A title'))),false,'a closed definition cannot claim later title text');
    const first = map._definitionCache.get(file);
    map._inDefinition(at(3,line.indexOf('x}')));
    assert.equal(map._definitionCache.get(file),first,'repeated clicks share one definition index');
    map.source.files.set('paper.tex',{ text:'\n\nPlain text' });
    assert.equal(map._inDefinition(at(3,line.indexOf('x}'))),false,'current buffer text invalidates the old position classification');
    assert.notEqual(map._definitionCache.get(file),first);
});

test('with no .bib record, a bibliography click lands in the .bbl the project ships', () => {
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-shipped-bbl-'));
    fs.writeFileSync(path.join(dir, 'paper.bbl'), ['\\begin{thebibliography}{1}', '', '\\bibitem{only}', 'A. Author, Title.'].join('\n'));
    const map = viewOf([glyphAt(0, 0, { generated_source: { file: 'paper.bbl', line: 4, column: 3 } })], dir, null);
    const hit = map.renderToSource(1, ...centre(map, 0));
    assert.equal(hit.file, path.join(dir, 'paper.bbl'));
    assert.deepEqual([hit.line, hit.column], [4, 3]);
});

// Bug #34: the map for a long paper was indexed in one piece on the extension
// host after every typing pause. NativeMap.build indexes it in slices of the
// event loop; the result must be the same map.
test('NativeMap.build indexes in slices and answers exactly as the one-piece constructor', async () => {
    const { map, view, source } = fixture();
    const pages = Array.from({ length: 40 }, (_, k) => ({ ...view.pages[0], page: k + 1,
        hits: view.pages[0].hits.map(h => ({ ...h, item_id: h.item_id + 10 * k, item: { ...h.item, page: k + 1 } })) }));
    const big = { ...view, artifact: { ...view.artifact, page_count: 40 }, pages };
    const src = { isCurrentView: v => v === big };
    const whole = new NativeMap({ generation: { pdfHash: 'paired', projectDir: root }, nativeView: big, nativeSource: src });
    const sliced = await NativeMap.build({ generation: { pdfHash: 'paired', projectDir: root }, nativeView: big, nativeSource: src });
    assert.deepEqual(sliced.materializedPages, whole.materializedPages);
    assert.equal(sliced._entries.length, whole._entries.length);
    assert.deepEqual(sliced.glyphsForLine(file, 4).map(e => [e.page, e.i]), whole.glyphsForLine(file, 4).map(e => [e.page, e.i]));
    assert.ok(sliced.available && map.available);
});
