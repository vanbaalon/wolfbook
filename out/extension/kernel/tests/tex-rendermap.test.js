// Stage 2: the Continuous Render Map.
//
//   node out/extension/kernel/tests/tex-rendermap.test.js
//
// Pure-node. Compiles a small real paper when latexmk is present (so the map
// is exercised against a genuine .synctex.gz) and skips those cases otherwise;
// the flag/staleness logic is tested with no TeX at all.

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
const skip = (n, why) => { skipped++; results.push(`  --   ${n}  (${why})`); };

const { RenderMap, FLAG } = require('../../tex/renderMap');
const { compile } = require('../../tex/compileService');
const { scanTex } = require('../../tex/texScanner');
const { buildModel } = require('../../tex/texModel');

const hasLatexmk = (() => {
    try { execFileSync('latexmk', ['--version'], { stdio: 'ignore' }); return true; } catch (_) { return false; }
})();

const PAPER = `\\documentclass[11pt,a4paper]{article}
\\usepackage{amsmath}
\\usepackage[margin=1in]{geometry}
\\begin{document}
\\section{First}
\\label{sec:one}
Some prose in the first section, long enough to occupy a line or two of the
page so that the render map has something real to point at.
\\begin{equation}
\\label{eq:one}
E(p) = \\sqrt{1 + 16 g^2 \\sin^2 \\tfrac{p}{2}}
\\end{equation}
More prose after the first equation, again long enough to be a real paragraph.
\\clearpage
\\section{Second}
\\label{sec:two}
This section starts on the second page, which is the whole point of the
\\texttt{clearpage} above it.
\\begin{equation}
\\label{eq:two}
\\Delta E = \\tfrac{1}{2} g^{-1} + O(g^{-2})
\\end{equation}
\\end{document}
`;

async function main() {
    // --- flags and staleness, no TeX required ------------------------------

    await test('with no generation at all, every answer is unmapped and says why', () => {
        const rm = new RenderMap({});
        assert.strictEqual(rm.available, false);
        const r = rm.sourceToRender('/x.tex', 1);
        assert.strictEqual(r.flag, FLAG.UNMAPPED);
        assert.ok(r.reason, 'an unmapped answer must explain itself');
        assert.deepStrictEqual(r.boxes, []);
        assert.deepStrictEqual(rm.pageBreaks('/x.tex'), []);
        assert.strictEqual(rm.pageOccupancy(1).flag, FLAG.UNMAPPED);
    });

    await test('a generation marked stale reports stale, not fresh', () => {
        const rm = new RenderMap({ generation: { stale: true } });
        assert.strictEqual(rm._baseFlag(), FLAG.STALE);
    });

    await test('edit translation maps a current line back to the compiled one', () => {
        const rm = new RenderMap({ generation: { generation: 1 } });
        assert.strictEqual(rm.displaced, false);
        rm.noteEdit('/p.tex', 10, +3);          // 3 lines inserted at line 10
        assert.strictEqual(rm.displaced, true);
        assert.deepStrictEqual(rm._toGenerationLine('/p.tex', 5), { line: 5, shifted: false });
        assert.deepStrictEqual(rm._toGenerationLine('/p.tex', 20), { line: 17, shifted: true });
        assert.strictEqual(rm._toCurrentLine('/p.tex', 17), 20);
        rm.noteEdit('/p.tex', 30, -1);
        assert.strictEqual(rm._toGenerationLine('/p.tex', 40).line, 38);
        rm.clearEdits('/p.tex');
        assert.strictEqual(rm.displaced, false);
    });

    await test('an edit softens fresh to probably-current, never silently', () => {
        // Between compiles the map is not wrong, it is displaced by a known
        // amount. Saying so beats refusing to answer AND beats claiming fresh.
        const rm = new RenderMap({ generation: { generation: 1 } });
        assert.strictEqual(rm._baseFlag(), FLAG.FRESH);
        rm.noteEdit('/p.tex', 1, +2);
        assert.strictEqual(rm._baseFlag(), FLAG.PROBABLY_CURRENT);
    });

    if (!hasLatexmk) {
        for (const n of ['a compiled paper maps objects to the right pages',
            'objectRenderBoxes returns a LIST, one union per page',
            'renderToSource lands on the semantic object, not just a line',
            'pageOccupancy is monotone and bounded',
            'pageBreaks gives one marker per page',
            'compare() reports page movement between generations']) skip(n, 'latexmk not installed');
    } else {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbrm-'));
        const root = path.join(dir, 'p.tex');
        fs.writeFileSync(root, PAPER);
        const gen = await compile({ root, sourceFiles: [root], timeoutMs: 120000 });
        const model = buildModel(scanTex(PAPER, { file: root }), { file: root });
        const rm = new RenderMap({ generation: gen, model });

        await test('a compiled paper maps objects to the right pages', () => {
            assert.strictEqual(gen.ok, true, 'the fixture compiled');
            assert.strictEqual(rm.available, true, 'synctex parsed');
            assert.strictEqual(rm.pageCount, 2);
            const one = model.objects.find(o => o.label === 'eq:one');
            const two = model.objects.find(o => o.label === 'eq:two');
            const p1 = rm.pageForObject(one);
            const p2 = rm.pageForObject(two);
            assert.strictEqual(p1.page, 1, 'eq:one is on page 1');
            assert.strictEqual(p2.page, 2, 'eq:two is on page 2 after the \\clearpage');
            assert.strictEqual(p1.flag, FLAG.FRESH);
        });

        await test('objectRenderBoxes returns a LIST, one union per page', () => {
            // A paragraph across a page break is not one rectangle, and every
            // tier scores paragraphs worst. A single-box API cannot say that.
            const eq = model.objects.find(o => o.label === 'eq:one');
            const r = rm.objectRenderBoxes(eq);
            assert.ok(Array.isArray(r.rects), 'always a list');
            assert.ok(r.rects.length >= 1);
            const b = r.rects[0];
            assert.strictEqual(b.page, 1);
            for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(b[k]), `${k} is a number`);
            assert.ok(b.w > 0 && b.h > 0, 'a real rectangle');
            assert.ok(b.x >= 0 && b.x + b.w <= 596, 'inside an A4 page width');
        });

        await test('renderToSource lands on the semantic object, not just a line', () => {
            // Click a point on the equation's OWN tightest record. The union
            // box spans the prose above it too — SyncTeX's boxes for a display
            // are generous, which Stage 0 measured as T3c 44% for equations —
            // so its centre is not necessarily on the equation at all.
            const eq = model.objects.find(o => o.label === 'eq:one');
            const r = rm.sourceToRender(root, eq.sourceRange.startLine, eq.sourceRange.endLine);
            const tight = r.boxes.filter(b => b.wBp > 0 && b.hBp > 0)
                .sort((a, b) => a.wBp * a.hBp - b.wBp * b.hBp)[0];
            assert.ok(tight, 'the equation has at least one sized record');
            const hit = rm.renderToSource(tight.page, tight.xBp + tight.wBp / 2, tight.yTopBp + tight.hBp / 2);
            assert.notStrictEqual(hit.flag, FLAG.UNMAPPED, hit.reason || '');
            assert.ok(hit.object, 'an OBJECT, which is the whole point');
            assert.strictEqual(hit.object.kind, 'display-equation');
            assert.strictEqual(hit.object.label, 'eq:one');
            assert.ok(!hit.object.approximate, 'and exactly, not by proximity');
        });

        await test('a click BETWEEN objects still resolves, flagged approximate', () => {
            // Prose the paragraph scanner did not claim leaves gaps. Returning
            // nothing there is worse than "you landed 2 lines below eq:one".
            const rm3 = new RenderMap({ generation: gen, model });
            const near = rm3._objectAt(root, 9999);
            if (near) assert.ok(near.approximate, 'a far-away line is never claimed exactly');
        });

        await test('pageOccupancy is monotone and bounded', () => {
            for (const p of [1, 2]) {
                const o = rm.pageOccupancy(p);
                assert.ok(o.fill >= 0 && o.fill <= 1, `fill in range on p${p}: ${o.fill}`);
                assert.ok(o.bars >= 0 && o.bars <= 5);
                assert.strictEqual(o.flag, FLAG.FRESH);
            }
            // page 1 is fuller than page 2 in this fixture
            assert.ok(rm.pageOccupancy(1).fill > rm.pageOccupancy(2).fill);
        });

        await test('pageBreaks gives one marker per page, in order', () => {
            const brk = rm.pageBreaks(root);
            assert.strictEqual(brk.length, 2);
            assert.strictEqual(brk[0].page, 1);
            assert.ok(brk[1].firstLine > brk[0].firstLine, 'markers advance');
        });

        await test('an edit downgrades the flag on a real map', () => {
            const rm2 = new RenderMap({ generation: gen, model });
            const eq = model.objects.find(o => o.label === 'eq:two');
            assert.strictEqual(rm2.pageForObject(eq).flag, FLAG.FRESH);
            rm2.noteEdit(root, 1, +5);
            assert.strictEqual(rm2.pageForObject(eq).flag, FLAG.PROBABLY_CURRENT);
        });

        await test('coverage reports how much of the file SyncTeX knows', () => {
            const c = rm.coverage(root, PAPER.split('\n').length);
            assert.ok(c.fraction > 0 && c.fraction <= 1, `got ${c.fraction}`);
            assert.ok(c.covered <= c.total);
        });

        await test('compare() reports page movement between generations', async () => {
            const grown = PAPER.replace('\\section{First}',
                '\\section{Zeroth}\nA whole extra section of prose inserted at the very top of the\n' +
                'document, long enough to push the material after it down the page.\n' +
                '\\clearpage\n\\section{First}');
            fs.writeFileSync(root, grown);
            const gen2 = await compile({ root, sourceFiles: [root], timeoutMs: 120000 });
            const model2 = buildModel(scanTex(grown, { file: root }), { file: root });
            const rm2 = new RenderMap({ generation: gen2, model: model2 });

            const diff = rm2.compare(rm);
            assert.strictEqual(diff.available, true);
            assert.ok(diff.pagesAfter > diff.pagesBefore, 'the paper grew');
            assert.strictEqual(diff.contentChanged, true);
            assert.ok(diff.moved.length >= 1, 'something moved page');
            const movedEq = diff.moved.find(m => m.label === 'eq:one' || m.label === 'eq:two');
            assert.ok(movedEq, 'an equation is named among the movements');
            assert.ok(movedEq.to > movedEq.from, `${movedEq.label}: p${movedEq.from} -> p${movedEq.to}`);
        });

        await test('compare() needs two real generations and says so otherwise', () => {
            assert.strictEqual(rm.compare(null).available, false);
            assert.strictEqual(rm.compare(new RenderMap({})).available, false);
        });

        fs.rmSync(dir, { recursive: true, force: true });
        try { fs.rmSync(gen.outDir, { recursive: true, force: true }); } catch (_) {}
    }

    console.log('render map (Stage 2 engine)\n');
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
    process.exit(fail ? 1 : 0);
}

main();
