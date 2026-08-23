// The promise that makes managed computations safe to use at all:
//
//   A paper carrying them is an ORDINARY .tex. It compiles on a plain latexmk,
//   on a machine with no Wolfbook, no kernel and no Wolfram installed.
//
//   node out/extension/kernel/tests/tex-mma-compile.test.js
//
// Everything Wolfbook adds is a TeX comment; the only non-comment bytes are the
// body inside an output fence, which is LaTeX a person could have typed. This
// suite writes a paper the way the viewer would, compiles it for real, and then
// checks the other half of the promise — that recomputing an unchanged result
// reproduces byte-identical content.
//
// SKIPPED when latexmk is absent, so the suite stays green without TeX Live.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0; let fail = 0; let skipped = 0;
const results = [];
const test = (name, fn) => Promise.resolve().then(fn)
    .then(() => { pass++; results.push('  ok   ' + name); })
    .catch((e) => { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); });
const skip = (name, why) => { skipped++; results.push(`  --   ${name}  (${why})`); };

const { parseMmaBlocks, BLOCK_STATE } = require('../../tex/mmaBlocks');
const W = require('../../tex/mmaWrite');

const hasLatexmk = (() => {
    try { execFileSync('latexmk', ['--version'], { stdio: 'ignore' }); return true; }
    catch (_) { return false; }
})();

const apply = (text, plan) => text.slice(0, plan.startOffset) + plan.newText + text.slice(plan.endOffset);

/** Build a paper the way the viewer would: drop a block, run it, insert output. */
function buildPaper() {
    let tex = [
        '\\documentclass{article}',
        '\\usepackage{graphicx}',
        '\\begin{document}',
        'Before the computation.',
        '',
        'After the computation.',
        '\\end{document}',
        '',
    ].join('\n');

    // 1. The drop: a block of pure comments, inserted before "After".
    const at = tex.indexOf('After the computation.');
    const block = W.buildBlockText({
        blockId: 'a1c2',
        cells: [
            { kind: 'markdown', cellId: 'm1', include: false, code: 'Why this integral matters.' },
            { kind: 'wolfram', cellId: 'c1', include: true, code: 'Integrate[1/(1+x^4), x]' },
            { kind: 'wolfram', cellId: 'c2', include: true, code: 'Plot[Sin[x], {x, 0, 2 Pi}]' },
            { kind: 'wolfram', cellId: 'c3', include: false, code: '(* scratch, never in the paper *)' },
        ],
    }) + '\n\n';
    tex = tex.slice(0, at) + block + tex.slice(at);

    // 2. An equation result, and 3. a figure result — both as the viewer writes them.
    let parsed = parseMmaBlocks(tex).blocks[0];
    tex = apply(tex, W.planInsert(tex, parsed, 'c1',
        W.equationBody('\\frac{1}{4} \\log(x)', { label: 'eq:quartic' })));
    parsed = parseMmaBlocks(tex).blocks[0];
    tex = apply(tex, W.planInsert(tex, parsed, 'c2',
        W.figureBody('img/paper/wl_deadbeef1234.pdf', { name: 'sine', caption: 'A sine wave.' })));
    return tex;
}

test('the whole file is comments except the managed output bodies', () => {
    const tex = buildPaper();
    const inside = tex.slice(tex.indexOf('%Mathematica'), tex.indexOf('After the computation.'));
    for (const line of inside.split('\n')) {
        if (!line.trim()) continue;
        const isComment = /^\s*%/.test(line);
        const isBody = /\\begin\{(equation|figure)\}|\\end\{(equation|figure)\}|\\includegraphics|\\centering|\\caption|\\label|frac/.test(line);
        assert.ok(isComment || isBody, `neither a comment nor an output body: ${JSON.stringify(line)}`);
    }
});

test('a cell marked out -> none puts nothing in the paper', () => {
    const tex = buildPaper();
    assert.ok(!tex.includes('%WolfbookOutputBegin[CellID: c3'), 'the scratch cell has no fence');
    assert.ok(!tex.includes('%WolfbookOutputBegin[CellID: m1'), 'nor the prose cell');
    // Its SOURCE is still there — not saving the output is not the same as
    // discarding the work.
    assert.ok(tex.includes('% (* scratch, never in the paper *)'));
    assert.ok(tex.includes('% Why this integral matters.'));
});

test('every cell reads back with the state it should have', () => {
    const b = parseMmaBlocks(buildPaper()).blocks[0];
    assert.deepStrictEqual(b.cells.map(c => c.state), [
        BLOCK_STATE.EPHEMERAL,   // m1 — prose, deliberately not materialised
        BLOCK_STATE.FRESH,       // c1 — equation
        BLOCK_STATE.FRESH,       // c2 — figure
        BLOCK_STATE.EPHEMERAL,   // c3 — scratch
    ]);
    assert.strictEqual(b.state, BLOCK_STATE.FRESH, 'and the block agrees');
});

test('recomputing an unchanged result reproduces the file byte for byte', () => {
    const tex = buildPaper();
    const b = parseMmaBlocks(tex).blocks[0];
    // The same result, inserted again — the thing "Recompute Paper" will do to
    // every cell in the paper, and the thing that proves provenance is real.
    const again = apply(tex, W.planInsert(tex, b, 'c1',
        W.equationBody('\\frac{1}{4} \\log(x)', { label: 'eq:quartic' })));
    assert.strictEqual(again, tex);
});

test('deleting an output and re-inserting it restores the same bytes', () => {
    const tex = buildPaper();
    const gone = apply(tex, W.planRemoveOutput(tex, parseMmaBlocks(tex).blocks[0], 'c1'));
    assert.ok(!gone.includes('eq:quartic'), 'it really went');
    assert.strictEqual(parseMmaBlocks(gone).blocks[0].cells[1].state, BLOCK_STATE.NO_OUTPUT);
    const back = apply(gone, W.planInsert(gone, parseMmaBlocks(gone).blocks[0], 'c1',
        W.equationBody('\\frac{1}{4} \\log(x)', { label: 'eq:quartic' })));
    assert.strictEqual(back, tex, 'and it came back identical');
});

test('a graphics result becomes a PDF — an SVG would stop the build', () => {
    // MEASURED THE HARD WAY: the first version wrote .svg, and pdflatex said
    // "Unknown graphics extension: .svg" and stopped. \includegraphics reads
    // PDF, PNG and JPEG only.
    const fig = W.bodyForResult({ kind: 'figure', pdfBase64: 'QUJD', svg: '<svg/>' });
    assert.deepStrictEqual(fig.needsAsset, { base64: 'QUJD', ext: 'pdf' });

    const png = W.bodyForResult({ kind: 'image', base64: 'QUJD' });
    assert.strictEqual(png.needsAsset.ext, 'png', 'the fallback is raster, but it builds');

    const svg = W.bodyForResult({ kind: 'svg', svg: '<svg/>' });
    assert.ok(svg.error && /pdflatex cannot include/.test(svg.error),
        'an SVG is refused with a sentence, never written into the paper');
    assert.ok(!svg.needsAsset && !svg.body);
});

test('no path puts an .svg into an \\includegraphics', () => {
    const tex = buildPaper();
    const includes = [...tex.matchAll(/\\includegraphics\[[^\]]*\]\{([^}]+)\}/g)].map(m => m[1]);
    assert.ok(includes.length >= 1, 'there is a figure to check');
    for (const rel of includes) {
        assert.ok(/\.(pdf|png|jpe?g)$/i.test(rel),
            `${rel} is not an extension pdflatex can read`);
    }
});

test('a hand-edited output is detected rather than silently overwritten', () => {
    const tex = buildPaper();
    const tampered = tex.replace('\\frac{1}{4} \\log(x)', '\\frac{1}{4} \\log(x) + C');
    const b = parseMmaBlocks(tampered).blocks[0];
    assert.strictEqual(b.cells[1].state, BLOCK_STATE.MODIFIED_BY_USER);
});

if (!hasLatexmk) {
    skip('the paper compiles on a plain latexmk', 'latexmk is not installed');
    skip('the managed output really is on the page', 'latexmk is not installed');
} else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbmma-'));
    const texPath = path.join(dir, 'paper.tex');

    test('the paper compiles on a plain latexmk, with no Wolfbook anywhere', () => {
        const tex = buildPaper();
        // The figure the viewer would have written. A real PDF is not needed to
        // prove the point, and generating one would need a kernel — the point
        // is that \includegraphics finds a file, exactly as for any figure.
        const imgDir = path.join(dir, 'img', 'paper');
        fs.mkdirSync(imgDir, { recursive: true });
        // A minimal valid one-page PDF, written by hand so this test needs
        // nothing but a TeX distribution.
        const pdf = [
            '%PDF-1.4',
            '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
            '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
            '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj',
            'trailer<</Root 1 0 R>>',
        ].join('\n');
        fs.writeFileSync(path.join(imgDir, 'wl_deadbeef1234.pdf'), pdf);
        fs.writeFileSync(texPath, tex);

        let out = '';
        try {
            out = execFileSync('latexmk',
                ['-pdf', '-interaction=nonstopmode', '-f', '-outdir=' + dir, texPath],
                { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
        } catch (e) { out = String((e.stdout || '') + (e.stderr || '')); }

        const log = path.join(dir, 'paper.log');
        const logText = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : out;
        assert.ok(fs.existsSync(path.join(dir, 'paper.pdf')), 'a PDF was produced:\n' + logText.slice(-1500));
        // The one failure mode that would matter: a stray Wolfbook directive
        // being read as a command rather than a comment.
        assert.ok(!/Undefined control sequence/.test(logText),
            'nothing in the block was read as a command:\n' + logText.slice(-1500));
        assert.ok(!/! LaTeX Error/.test(logText), 'no LaTeX error:\n' + logText.slice(-1500));
    });

    test('the managed output really is on the page', () => {
        const log = path.join(dir, 'paper.log');
        if (!fs.existsSync(log)) throw new Error('no log to read');
        const logText = fs.readFileSync(log, 'utf8');
        // The equation was numbered and labelled, and the figure floated: both
        // are things LaTeX records, so the .aux is the evidence that the
        // inserted bodies were typeset rather than merely present.
        const aux = path.join(path.dirname(log), 'paper.aux');
        const auxText = fs.existsSync(aux) ? fs.readFileSync(aux, 'utf8') : '';
        assert.ok(/eq:quartic/.test(auxText), 'the equation label reached the .aux:\n' + auxText);
        assert.ok(/fig:sine/.test(auxText), 'and the figure label too:\n' + auxText);
        assert.ok(!/Wolfbook|Mathematica/.test(auxText), 'and no directive leaked into the output');
    });
}

setTimeout(() => {
    console.log('\ntex-mma-compile.test.js');
    console.log(results.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
    process.exit(fail ? 1 : 0);
}, 0);
