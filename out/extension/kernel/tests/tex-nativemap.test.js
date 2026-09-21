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
    source.forward = async () => ({ hits:[] });
    assert.deepEqual(await map.forwardAt(file, 4, 2), []);
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
