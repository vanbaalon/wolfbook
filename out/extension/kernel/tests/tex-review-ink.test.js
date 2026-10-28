'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { withVscodeStub } = require('./_stub-vscode');
const { TexViewer } = withVscodeStub(() => require('../../tex/texViewer'));
const { NativeMap } = require('../../tex/nativeMap');

function viewerFor(map, file, text, hunk) {
    const v = Object.create(TexViewer.prototype), messages = [], errors = [];
    const session = { file, _lastText:text, hunks:[hunk] };
    Object.assign(v, { root:file, panel:{}, shownGeneration:2,
        coord:{ roots:new Map([[file, { map, files:[file] }]]) },
        _review:{ sessionFor:() => session }, _textOf:() => text,
        _reviewRenderRevision:() => 'current', _displayMatchesSource:() => true,
        _post:m => messages.push(m), _log:m => errors.push(m) });
    return { v, messages, errors, request:{ file, id:hunk.id, requestId:1, generation:2, revision:'current' } };
}

function fixture(before, after, verb = 'change') {
    const root = path.join(os.tmpdir(), 'wpaper-review-ink-fixture'), file = path.join(root, 'paper.tex');
    const text = '\n\n\n' + after, SP = 65536, columns = [];
    const hits = [];
    after.split(/\r?\n/).forEach((line, row) => {
        let col = 0;
        for (const ch of line) {
            if (!/\s/.test(ch)) {
                const origin = { file:'paper.tex', location:{ accuracy:'Exact',
                    start:{ line:row + 4, column_utf16:col }, end:{ line:row + 4, column_utf16:col + ch.length } } };
                const x = hits.length * 6;
                columns.push({ row, col, x:72 + x * 72 / 72.27 });
                hits.push({ item_id:hits.length, preferred_source:origin,
                    mapped_origins:[{ span:{ tag:1, line:row + 4, column:col, length:ch.length }, source:origin }],
                    box_path:[[8, { kind:'Horizontal' }]], item:{ page:1, kind:'Glyph',
                        glyph:{ font:1, code:ch.codePointAt(0) }, provenance:{ definition:{ line:row + 4 } },
                        geometry:{ position:{ x:x * SP, y:(20 + row * 15) * SP }, width:5 * SP, height:7 * SP, depth:2 * SP } } });
            }
            col += ch.length;
        }
    });
    const view = { generation:2, sequence:1, artifact:{ page_count:1, pdf_hash:'paired' },
        pages:[{ page:1, header:{ magnification:1000 }, hits }] };
    const source = { isCurrentView:c => c === view, files:new Map([['paper.tex', { text }]]),
        forward:() => { throw Error('exact origins need no approximate point queries'); } };
    const map = new NativeMap({ generation:{ pdfHash:'paired', projectDir:root }, nativeView:view, nativeSource:source });
    const hunk = { id:'ink', verb, theirText:before, ourText:after,
        ourRange:{ startLine:4, endLine:4 + after.split('\n').length }, rects:[] };
    return { ...viewerFor(map, file, text, hunk), columns };
}

for (const example of [
    { name:'replacement beside an identical unchanged word', before:'Alpha Alpha beta.', after:'Alpha Omega beta.', selected:[[0,6,5]] },
    { name:'a whole added fragment', before:'', after:'Alpha beta.', verb:'add', selected:[[0,0,11]] },
    { name:'a sentence deletion leaves remaining text neutral', before:'Alpha beta. Removed sentence.', after:'Alpha beta.', selected:[] },
    { name:'an equation digit leaves operators and tags neutral', before:'\\[x^1+y=3\\]', after:'\\[x^2+y=3\\]', selected:[[0,4,1]] },
    { name:'UTF-16 columns and CRLF lines', before:'😀 Alpha Alpha.\r\nTail old.', after:'😀 Alpha Omega.\r\nTail new.', selected:[[0,9,4],[1,5,3]] },
]) test(`Pro correction ink: ${example.name}`, async () => {
    const f = fixture(example.before, example.after, example.verb);
    await f.v._reviewPageMarks(f.request);
    assert.deepEqual(f.errors, [], 'native ranges must be admitted');
    assert.equal(f.messages.length, 1);
    const expected = f.columns.filter(c => example.selected.some(([row,col,len]) => c.row === row && c.col >= col && c.col < col + len));
    const rounded = n => Number(n.toFixed(7));
    assert.deepEqual(f.messages[0].marks.map(m => rounded(m.x)), expected.map(c => rounded(c.x)));
});

test('correction ink rejects obsolete source revisions and PDF generations', async () => {
    const f = fixture('Old text.', 'New text.');
    await f.v._reviewPageMarks({ ...f.request, generation:1 });
    await f.v._reviewPageMarks({ ...f.request, revision:'previous' });
    assert.deepEqual(f.messages, []);
    const map = f.v.coord.roots.get(f.v.root).map;
    const forward = map.forwardRange.bind(map);
    map.forwardRange = async (...args) => { const result = await forward(...args); f.v.shownGeneration = 3; return result; };
    await f.v._reviewPageMarks(f.request);
    assert.deepEqual(f.messages, [], 'a PDF replaced during mapping cannot receive old highlights');
});

test('actual WLaTeX correction marks cover changed words and math glyphs',
    { skip:!process.env.WPAPER_NATIVE_TEST_DIR }, async () => {
    const { NativeBuildLane } = require('../../tex/nativeCompileService');
    const { snapshotSources } = require('../../tex/compileService');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-review-native-')), file = path.join(dir, 'paper.tex');
    const after = 'Alpha Omega beta.\n\\begin{equation} x^2+y=3 \\end{equation}';
    const before = after.replace('Omega', 'Alpha').replace('x^2', 'x^1');
    const text = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n' + after + '\n\\end{document}\n';
    fs.writeFileSync(file, text);
    const lane = new NativeBuildLane(file, process.env.WPAPER_NATIVE_TEST_DIR);
    try {
        const g = await lane.compile({ root:file, sourceFiles:[file], sourceSnapshotHash:snapshotSources([file]), nativePages:[1], timeoutMs:60000 });
        assert.equal(g.ok, true, JSON.stringify(g.diagnostics));
        const map = new NativeMap({ generation:g, nativeView:g.nativeView, nativeSource:g.nativeSource });
        const f = viewerFor(map, file, text, { id:'real', verb:'change', theirText:before, ourText:after, ourRange:{ startLine:4,endLine:6 } });
        await f.v._reviewPageMarks(f.request);
        assert.deepEqual(f.errors, []);
        const marks = f.messages[0].marks;
        const expected = [...await map.forwardRange(file, { line:4,column_utf16:6 }, { line:4,column_utf16:11 }),
            ...await map.forwardRange(file, { line:5,column_utf16:19 }, { line:5,column_utf16:20 })];
        assert.equal(expected.length, 6, 'five replacement letters and one superscript digit');
        assert.deepEqual(marks, expected);
    } finally { await lane.close(); fs.rmSync(dir, { recursive:true, force:true }); }
});

test('Pro review ink uses the exact live map before the full compile and rejects old ink identities',async()=>{
 const f=fixture('Old word.','New word.');const st=f.v.coord.roots.get(f.v.root);
 st.sourceAhead=true;st.sourceRevision=8;f.v._displayMatchesSource=()=>false;
 f.v._liveMap=st.map;f.v._liveMapSourceRevision=8;
 f.v._liveMapIdentities=new Map([[1,'live-current']]);f.v._liveOverlays=new Map([[1,'live-current']]);f.v._liveMapReady=new Map([[1,'live-current']]);
 f.request.livePages={1:'live-current'};
 await f.v._reviewPageMarks(f.request);assert.equal(f.messages.length,1);assert.ok(f.messages[0].marks.length);
 f.messages.length=0;f.v._liveMapReady.set(1,'live-next');await f.v._reviewPageMarks(f.request);assert.equal(f.messages.length,0);
 f.v._liveMapReady.set(1,'live-current');st.sourceRevision=9;await f.v._reviewPageMarks(f.request);assert.equal(f.messages.length,0);
});
