// The evaluation half of managed computations: the expression sent to the
// kernel, and the reading of what comes back.
//
//   node out/extension/kernel/tests/tex-mma-eval.test.js
//
// No kernel and no native addon are required — the BTL addon is injected, which
// is deliberate: the width handling is the part most likely to be wrong and it
// must be checkable on any machine.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
function test(name, fn) {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); }
}

{
    const Module = require('module');
    const orig = Module._load;
    let violated = null;
    Module._load = function (req, ...rest) {
        if (req === 'vscode') violated = req;
        return orig.call(this, req, ...rest);
    };
    try { require('../../execution/eval-fragment'); } finally { Module._load = orig; }
    test('eval-fragment is vscode-free', () => assert.strictEqual(violated, null));
}

const E = require('../../execution/eval-fragment');

// --- the expression --------------------------------------------------------

test('the source is parsed before it is timed, so syntax errors say so', () => {
    const x = E.buildEvalExpr('1+1', { timeoutSeconds: 30 });
    const parseAt = x.indexOf('ToExpression[');
    const timeAt = x.indexOf('TimeConstrained[');
    assert.ok(parseAt > 0 && timeAt > parseAt, 'the parse comes first');
    assert.ok(x.includes('"ERROR:Syntax error in expression"'));
});

test('the timeout sentinel is Block-local, so no real result can impersonate it', () => {
    const x = E.buildEvalExpr('1+1', { timeoutSeconds: 12 });
    assert.ok(/Block\[\{[^}]*\$wbTO\$[^}]*\}/.test(x), '$wbTO$ is declared in the Block');
    assert.ok(x.includes('TimeConstrained[ReleaseHold[$wbParsed$], 12, $wbTO$]'));
    assert.ok(x.includes('$wbRes$ === $wbTO$'));
});

test('MakeBoxes gets the VALUE injected past HoldAllComplete', () => {
    assert.ok(E.buildEvalExpr('x', {}).includes('With[{$wbVal$ = $wbRes$}, ToString[MakeBoxes[$wbVal$'));
});

test('quotes and backslashes in the source are escaped for the string literal', () => {
    const x = E.buildEvalExpr('f["a\\b"]', {});
    assert.ok(x.includes('f[\\"a\\\\b\\"]'));
});

test('escaped:true trusts the caller, which is how .wslide still calls it', () => {
    assert.ok(E.buildEvalExpr('f[\\"x\\"]', { escaped: true }).includes('f[\\"x\\"]'));
});

test("prefer:'figure' forces the graphics branch, so a figure cannot come back as an equation", () => {
    assert.ok(E.buildEvalExpr('x', {}).includes('!FreeQ[$wbRes$, _Graphics'), 'auto sniffs the result');
    const fig = E.buildEvalExpr('x', { prefer: 'figure' });
    assert.ok(fig.includes('$wbGfx$ = True'));
    assert.ok(!fig.includes('!FreeQ[$wbRes$, _Graphics'));
});

test('the image width reaches every export in the expression', () => {
    const x = E.buildEvalExpr('x', { imageWidthPx: 733 });
    assert.strictEqual((x.match(/ImageSize -> 733/g) || []).length, 4);
});

// --- the result ------------------------------------------------------------

test('TEXT, IMAGE and ERROR are read off their prefixes', () => {
    assert.deepStrictEqual(
        ['TEXT:hello', 'IMAGE:AAAA', 'ERROR:boom'].map(s => E.parseEvalResult(s).kind),
        ['text', 'image', 'error']);
    assert.strictEqual(E.parseEvalResult('ERROR:boom').error, 'boom');
    assert.strictEqual(E.parseEvalResult('IMAGE:AAAA').base64, 'AAAA');
    assert.strictEqual(E.parseEvalResult('IMAGE:AAAA').mime, 'image/png');
});

test('an unprefixed reply is text rather than a thrown error', () => {
    assert.strictEqual(E.parseEvalResult('bare').kind, 'text');
    assert.strictEqual(E.parseEvalResult('').kind, 'text');
    assert.strictEqual(E.parseEvalResult(null).kind, 'text');
});

test('SVG is clipped to its own tags and stripped of fonts Chrome will not draw', () => {
    const raw = 'SVG:junk<svg width="1"><font-face x="1"/><font>Q</font>'
        + '<text font-family="MathematicaMono-Regular">a</text></svg>trailing';
    const r = E.parseEvalResult(raw);
    assert.strictEqual(r.kind, 'svg');
    assert.ok(r.svg.startsWith('<svg'), 'leading junk is dropped');
    assert.ok(r.svg.endsWith('</svg>'), 'trailing junk is dropped');
    assert.ok(!/<font/.test(r.svg), 'SVG 1.1 fonts are removed');
    assert.ok(r.svg.includes('Courier New'), 'and the family is mapped to a real one');
});

test('a paper asks for a PDF, because pdflatex cannot include an SVG at all', () => {
    // \includegraphics reads PDF, PNG and JPEG. An .svg is "Unknown graphics
    // extension" and the build stops — so a figure destined for a paper must
    // come back as a PDF, and the SVG rides along only as the card's preview.
    const paper = E.buildEvalExpr('Plot[x, {x, 0, 1}]', { wantPdf: true });
    assert.ok(paper.includes('{"Base64", "PDF"}'), 'a PDF is exported');
    assert.ok(paper.includes('"FIG:"'), 'and reported under its own prefix');

    const screen = E.buildEvalExpr('Plot[x, {x, 0, 1}]', {});
    assert.ok(!screen.includes('"Base64", "PDF"'),
        'a slide still gets the SVG-first path it had');
    assert.ok(screen.includes('"SVG:"'));
});

test('the figure reply carries the PDF to insert and the SVG to preview', () => {
    const r = E.parseEvalResult('FIG:QUJD$WBSEP$<svg id="p"/>');
    assert.strictEqual(r.kind, 'figure');
    assert.strictEqual(r.pdfBase64, 'QUJD');
    assert.ok(r.svg && r.svg.includes('<svg'), 'the preview came too');
});

test('a figure with no preview is still a figure, not a failure', () => {
    const r = E.parseEvalResult('FIG:QUJD$WBSEP$');
    assert.strictEqual(r.kind, 'figure');
    assert.strictEqual(r.pdfBase64, 'QUJD');
    assert.strictEqual(r.svg, null, 'and says plainly that there is no preview');
});

test('base64 never contains the separator, so the split cannot go wrong', () => {
    // The sentinel holds '$', which is outside the base64 alphabet — that is
    // the whole reason it is safe to send both halves down one string.
    assert.ok(!/[$]/.test(Buffer.from('any bytes at all \u0000\u00ff').toString('base64')));
});

// --- boxes -> LaTeX --------------------------------------------------------

function fakeBtl(record) {
    return {
        boxToLatex: (s) => { record.boxes = s; return { latex: 'x^2' }; },
        lineBreakLatex: (latex, opts) => { record.breakOpts = opts; return { result: latex + '%broken' }; },
    };
}

test('the page width is passed through to the line breaker as given', () => {
    const rec = {};
    const r = E.parseEvalResult('BOXES:SuperscriptBox["x","2"]', { pageWidthEm: 34, btl: fakeBtl(rec) });
    assert.strictEqual(r.kind, 'latex');
    assert.strictEqual(rec.breakOpts.pageWidth, 34, 'a paper width is not rescaled behind the caller');
    assert.strictEqual(r.latex, 'x^2%broken');
});

test('a width too small to be meaningful skips line breaking entirely', () => {
    const rec = {};
    E.parseEvalResult('BOXES:x', { pageWidthEm: 0, btl: fakeBtl(rec) });
    assert.strictEqual(rec.breakOpts, undefined);
});

test('an older addon returning a bare string is still understood', () => {
    const btl = { boxToLatex: () => ({ latex: 'a' }), lineBreakLatex: () => 'a+broken' };
    assert.strictEqual(E.parseEvalResult('BOXES:x', { pageWidthEm: 40, btl }).latex, 'a+broken');
});

test('KaTeX pre-rendering is off unless asked for — a paper wants the source', () => {
    const r = E.parseEvalResult('BOXES:x', { pageWidthEm: 34, btl: fakeBtl({}) });
    assert.strictEqual(r.html, undefined);
    assert.strictEqual(typeof r.latex, 'string');
});

test('the boxes are kept beside the LaTeX, so a re-render never needs the kernel again', () => {
    const r = E.parseEvalResult('BOXES:SuperscriptBox', { pageWidthEm: 34, btl: fakeBtl({}) });
    assert.strictEqual(r.boxes, 'SuperscriptBox');
});

test('no converter is reported honestly, with the boxes, not as a failed evaluation', () => {
    const r = E.parseEvalResult('BOXES:RowBox', { pageWidthEm: 34, btl: null });
    // btl:null falls back to loadBtl(), which on a machine without the addon
    // yields the labelled text form; with the addon it yields real LaTeX.
    assert.ok(r.kind === 'latex' || r.kind === 'text');
    if (r.kind === 'text') {
        assert.strictEqual(r.text, 'RowBox', 'the boxes survive');
        assert.ok(/unavailable|failed/.test(r.note), 'and the reason is stated');
    }
});

test('a converter that refuses these boxes says so rather than emitting empty LaTeX', () => {
    const btl = { boxToLatex: () => ({ error: 'unknown head' }) };
    const r = E.parseEvalResult('BOXES:Weird', { btl });
    assert.strictEqual(r.kind, 'text');
    assert.ok(/unknown head/.test(r.note));
});

// --- the .wslide shape -----------------------------------------------------

test('the slide vocabulary still comes out of the shared pipeline unchanged', () => {
    const out = E.toSlideOutput(E.parseEvalResult('BOXES:x', { pageWidthEm: 34, katex: true, btl: fakeBtl({}) }));
    assert.strictEqual(out.type, 'latex');
    assert.strictEqual(out.latex, 'x^2%broken');
    assert.ok(out.evaluatedAt, 'and it carries a wall-clock stamp as before');
    assert.strictEqual(E.toSlideOutput(E.parseEvalResult('IMAGE:AA')).data, 'data:image/png;base64,AA');
    assert.strictEqual(E.toSlideOutput(E.parseEvalResult('ERROR:x')).type, 'error');
});

console.log('\ntex-mma-eval.test.js');
console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
