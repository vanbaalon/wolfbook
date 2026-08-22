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

Solitary


The kernel of the operator is the kernel we started from, and a reader who
has read the kernel section will recognise the kernel again immediately, so
kernel counting is the only thing that this paragraph is really about here.
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

    await test('THE LEADING IS THE SMALL COMMON GAP BETWEEN WIDE ROWS', () => {
        // MEASURED on the reference paper (89 displays): the commonest gap
        // between baselines came out 4.5 bp — a subscript offset — against a
        // true leading of 13.6. Every row rect was then a third of its real
        // height, so a subscript printed on a prose line fell OUTSIDE that
        // line's own row, and a click on the α of `\theta_\alpha` resolved to
        // the first α on the line instead.
        //
        // Two things distinguish a leading from a maths offset, and this builds
        // a record set with both: body text rows are WIDE, and the leading is
        // the SMALL common gap — displays add space, they never remove it.
        const BP = 72.27 * 65536 / 72;              // one bp, in sp
        const boxes = [];
        for (let i = 0; i < 30; i++) {
            const v = (100 + i * 13.6) * BP;
            boxes.push({ type: 'char', page: 1, tag: 1, line: i + 1, v, h: 0, W: 400 * BP, H: 0, D: 0 });
            // Six script baselines per line, 4.5 bp off, a few points wide —
            // the shape of an equation-heavy page, and far more numerous.
            for (let k = 0; k < 6; k++) {
                for (const off of [-4.5, 4.5]) {
                    boxes.push({ type: 'char', page: 1, tag: 1, line: i + 1,
                        v: v + off * BP, h: (100 + k * 20) * BP, W: 6 * BP, H: 0, D: 0 });
                }
            }
        }
        // Wide rows are 13.6 apart; the displays around them are further.
        const rm = new RenderMap({ generation: { generation: 1 } });
        rm.doc = { pages: new Map([[1, { boxes }]]), inputs: new Map([[1, '/p.tex']]) };
        rm._lead = null;
        const leadBp = rm._leadingSp() * (72 / (72.27 * 65536));
        assert.ok(Math.abs(leadBp - 13.6) < 1.0,
            `the text leading, not the script offset: got ${leadBp.toFixed(1)}`);
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

        await test('AN UNCHANGED .synctex IS PARSED ONCE, NOT PER KEYSTROKE', () => {
            // A live rebuild that does not move the ink writes a byte-identical
            // .synctex.gz. Gunzipping and re-parsing it is pure waste, so the
            // new map is handed the previous parse — and must answer identically.
            const reused = new RenderMap({ generation: gen, model, synctexDoc: rm.doc });
            assert.strictEqual(reused.doc, rm.doc, 'the parse is shared, not repeated');
            assert.strictEqual(reused.available, true);
            assert.strictEqual(reused.pageCount, rm.pageCount);
            const eq = model.objects.find(o => o.label === 'eq:two');
            assert.deepStrictEqual(reused.pageForObject(eq), rm.pageForObject(eq),
                'and gives the same answers as a fresh parse');
        });

        await test('a reused parse is NOT overlay-remapped a second time', () => {
            // The remap rewrites inputs that start with the overlay prefix. It
            // is idempotent only by luck; running it twice on an already-mapped
            // doc is a bug waiting for a project path that contains the prefix.
            const overlayGen = {
                ...gen,
                overlayDir: '/tmp/fake-overlay',
                projectDir: '/tmp/fake-project',
            };
            const before = [...rm.doc.inputs.values()];
            const reused = new RenderMap({ generation: overlayGen, model, synctexDoc: rm.doc });
            assert.deepStrictEqual([...reused.doc.inputs.values()], before,
                'the shared doc is left exactly as it was');
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

        await test('THE LEADING IS THE TEXT LEADING, even on a paper made of maths', async () => {
            // MEASURED on the reference paper (89 displays): the commonest gap
            // between baselines was 4.5 bp — a subscript offset — against a true
            // leading of 13.6, because on an equation-heavy paper the maths
            // offsets outnumber the text lines. Every row rect then came out a
            // third of its real height, and a click on a subscript fell outside
            // its own row: that is what made the α of `\theta_\alpha` resolve to
            // the first α on the line.
            const mathy = [
                '\\documentclass[11pt,a4paper]{article}',
                '\\usepackage{amsmath}',
                '\\usepackage[margin=1in]{geometry}',
                '\\begin{document}',
                'At site $\\alpha$, with inhomogeneity $\\theta_\\alpha$ and',
                '$0<s_\\alpha<1$, the allowed separated values form two half-towers:',
            ];
            // Prose BETWEEN the displays, because a paper has paragraphs: a
            // document that is nothing but equations has no text leading to
            // find, and asserting one would be asserting a fiction.
            // The RATIO of the reference paper: paragraphs of ordinary prose,
            // and displays dense with scripts and fractions — each of which
            // contributes several baselines a few points apart. That is what
            // outvoted the text lines and produced a 4.5 bp "leading".
            for (let i = 0; i < 12; i++) {
                for (let k = 0; k < 3; k++) {
                    mathy.push(`Ordinary sentence number ${k} of paragraph ${i}, long enough to run`,
                        'across the measure the way body text does in a real paper.');
                }
                mathy.push('');
                mathy.push('\\begin{equation}',
                    `x_{\\alpha,${i}}^{\\uparrow} = \\frac{a_{${i}}}{b_{${i}}} + \\frac{p^{2}}{q_{3}} ` +
                    `+ y_{\\beta}^{\\downarrow} + \\frac{u_{7}}{v^{8}} + z_{9}^{10}`,
                    '\\end{equation}');
            }
            mathy.push('\\end{document}', '');
            const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbrm-lead-'));
            const mroot = path.join(mdir, 'm.tex');
            fs.writeFileSync(mroot, mathy.join('\n'));
            const mgen = await compile({ root: mroot, sourceFiles: [mroot], timeoutMs: 120000 });
            assert.strictEqual(mgen.ok, true, 'the maths-heavy fixture compiled');
            const mm = new RenderMap({ generation: mgen, model: buildModel(scanTex(mathy.join('\n'), { file: mroot }), { file: mroot }) });
            const leadBp = mm._leadingSp() * (72 / (72.27 * 65536));
            assert.ok(leadBp > 10 && leadBp < 20,
                `an 11pt document leads at ~13.6 bp, got ${leadBp.toFixed(1)}`);

            // And the consequence the bug was actually about: the row of the
            // prose line is a whole text line tall, so the subscript printed on
            // it is INSIDE its own row.
            const row = mm.lineRows(mroot, 5)[0];
            assert.ok(row, 'the prose line printed a row');
            assert.ok(row.h > 10, `the row is a text line tall, got ${row.h.toFixed(1)}`);
            try { fs.rmSync(mdir, { recursive: true, force: true }); } catch (_) { /* fine */ }
            try { if (mgen.outDir) fs.rmSync(mgen.outDir, { recursive: true, force: true }); } catch (_) { /* fine */ }
        });

        await test('A CLICK THAT MISSES THE INK STILL LANDS ON THE NEAREST ROW', () => {
            // THE REPORTED BUG. Only the row whose band CONTAINED the point used
            // to count, and the gaps between bands are not small: the space
            // above a display equation is several points of nothing. A click a
            // few points below the last line of a paragraph therefore matched no
            // row at all, the caller fell back to the box hierarchy, and the box
            // hierarchy answers prose with the equation below it — "slightly
            // away from the word and it selects the equation".
            // The line immediately ABOVE the display equation: the gap under it
            // is \abovedisplayskip, which is the gap the bug was about. (A
            // prose line with another prose line under it has no gap at all —
            // the bands tile — so it cannot exercise this.)
            const proseLine = PAPER.split('\n')
                .findIndex(l => l.startsWith('page so that the render map')) + 1;
            assert.ok(proseLine > 1, 'the fixture has that line');
            const rows = rm.lineRows(root, proseLine);
            assert.ok(rows.length, 'and it printed a row');
            const r0 = rows[0];

            // Dead centre: unchanged behaviour, dy = 0.
            const on = rm.lineAtPoint(r0.page, r0.x + r0.w / 2, r0.y + r0.h / 2);
            assert.ok(on, 'a point on the ink resolves');
            assert.strictEqual(on.line, proseLine);
            assert.strictEqual(on.dy, 0, 'and reports no vertical miss');
            assert.ok(on.lead > 0, 'the leading comes back with it, as the scale for "near"');

            // Four points BELOW the row's own band — the gap that used to
            // resolve to the equation.
            const below = rm.lineAtPoint(r0.page, r0.x + r0.w / 2, r0.y + r0.h + 4);
            assert.ok(below, 'a point just below the row still resolves');
            assert.strictEqual(below.line, proseLine,
                `expected the prose line back, got ${below && below.line}`);
            assert.ok(below.dy > 0 && below.dy < below.lead,
                `and says how far it missed by: ${below && below.dy}`);

            // Far away is still far away: two inches down is not this line.
            const far = rm.lineAtPoint(r0.page, r0.x + r0.w / 2, r0.y + r0.h + 144);
            assert.ok(!far || far.line !== proseLine,
                'a point two inches away is NOT claimed by this row');
        });

        await test('THE FIRST WORD OF A CONTINUATION ROW IS NOT \\end{document}', () => {
            // MEASURED, and the cause of two separate bug reports. SyncTeX
            // files the FIRST record of every continuation row of a paragraph
            // under the line the paragraph ENDS on — the \\par — not under the
            // line whose word it marks. In this fixture that is the
            // \\clearpage/\\end line, so clicking the first word of a wrapped
            // line jumped there; and because `lineRows` then started the row
            // one word late, a repeated word came out one occurrence short.
            const lines = PAPER.split('\n');
            const first = lines.findIndex(l => l.startsWith('The kernel of the operator')) + 1;
            assert.ok(first > 1, 'the fixture has the hard-wrapped paragraph');
            const last = lines.findIndex(l => l.startsWith('kernel counting')) + 1;

            // Every row of every line of the paragraph, and who owns its start.
            const owners = new Map();
            for (let n = first; n <= last; n++) {
                for (const r of rm.lineRows(root, n)) owners.set(`${r.page}|${r.y.toFixed(1)}`, n);
            }
            assert.ok(owners.size >= 3, 'it really wrapped into several rows');

            // The paragraph's own lines own every one of its rows: no row of it
            // is attributed to a line outside the paragraph.
            for (const [, n] of owners) {
                assert.ok(n >= first && n <= last, `row owned by line ${n}, outside ${first}..${last}`);
            }

            // The click itself: on the first word of a continuation row.
            const rows = [];
            for (let n = first; n <= last; n++) {
                for (const r of rm.lineRows(root, n)) rows.push({ n, ...r });
            }
            rows.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
            const cont = rows.find(r => r.x < 200 && r.y > rows[0].y);
            assert.ok(cont, 'there is a continuation row');
            const hit = rm.lineAtPoint(cont.page, cont.x + 2, cont.y + cont.h / 2);
            assert.ok(hit, 'clicking its first word resolves');
            assert.ok(hit.line >= first && hit.line <= last,
                `to a line OF THE PARAGRAPH, got ${hit.line} (paragraph is ${first}..${last})`);

            // ABLATION — the same query with the repair switched off, which is
            // the behaviour that shipped and was reported. Without it the click
            // lands on a line outside the paragraph altogether.
            const unrepaired = new RenderMap({ generation: gen, model });
            unrepaired._rowRepairs = () => new Map();
            const before = unrepaired.lineAtPoint(cont.page, cont.x + 2, cont.y + cont.h / 2);
            assert.ok(before && (before.line < first || before.line > last),
                `without the repair the same click lands outside the paragraph ` +
                `(got ${before && before.line}; if this ever fails, SyncTeX changed ` +
                `and the repair may no longer be needed)`);
            // And the row it starts is the one the repair recovers: unrepaired,
            // the paragraph's rows begin one word late.
            const rawRows = [];
            for (let n = first; n <= last; n++) {
                for (const r of unrepaired.lineRows(root, n)) rawRows.push({ n, ...r });
            }
            const rawCont = rawRows.filter(r => r.page === cont.page &&
                Math.abs(r.y - cont.y) < 1).sort((a, b) => a.x - b.x)[0];
            assert.ok(rawCont && rawCont.x > cont.x,
                `and its row started further right (${rawCont && rawCont.x.toFixed(1)} vs ${cont.x.toFixed(1)})`);
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

        await test('A ONE-WORD PARAGRAPH HAS A ROW OF ITS OWN', () => {
            // REPORTED: "single word lines are not individually selectable in
            // the viewer". MEASURED on a fixture of one-word paragraphs: TeX
            // emits a single DIMENSIONLESS char record for the whole line —
            //
            //     hbox      line=7  v=158.7 h=133.8 W=343.7   <- the line box
            //     char      line=6  v=158.7 h=170.9 W=0       <- the word
            //
            // — so the row came out zero-wide and was filtered away by the rule
            // that drops the `\[` phantom, and the cursor answered
            // "line N · unmapped": nothing highlighted, nothing selectable.
            //
            // The two cases are told apart by the BASELINE, not by the record:
            // the phantom shares its baseline with the prose line that really
            // printed there, while a one-word paragraph is the only thing on
            // its own.
            const line = PAPER.split('\n').findIndex(l => l === 'Solitary') + 1;
            assert.ok(line > 1, 'the fixture has a one-word paragraph');
            const rows = rm.lineRows(root, line);
            assert.ok(rows.length,
                `it must have a row of its own, or it cannot be clicked or ` +
                `highlighted at all (got ${rows.length})`);
            assert.ok(rows[0].w > 0.5, `and a real width: ${rows[0].w}`);

            // And the phantom is still dropped: the line that opens a display
            // must not claim a row on the paragraph above it.
            const eqLine = PAPER.split('\n')
                .findIndex(l => l.startsWith('\\begin{equation}')) + 1;
            const proseAbove = PAPER.split('\n')
                .findIndex(l => l.startsWith('page so that the render map')) + 1;
            const eqRows = rm.lineRows(root, eqLine);
            const proseRows = rm.lineRows(root, proseAbove);
            for (const e of eqRows) {
                for (const pr of proseRows) {
                    assert.ok(!(e.page === pr.page && Math.abs(e.y - pr.y) < 1),
                        'the display\'s own line must not claim the prose row above it');
                }
            }
        });

        await test('compare() needs two real generations and says so otherwise', () => {
            assert.strictEqual(rm.compare(null).available, false);
            assert.strictEqual(rm.compare(new RenderMap({})).available, false);
        });

        fs.rmSync(dir, { recursive: true, force: true });
        try { fs.rmSync(gen.outDir, { recursive: true, force: true }); } catch (_) {}
    }

    await test('THE REPORTED BUG: an edited map must not put a prose line INSIDE an equation', () => {
        // Reproduced on the reference paper by check-paper.mjs, whose displaced
        // pass answered a click on "coincide" with the single character "n".
        //
        // The model is the one that was COMPILED, so its ranges are generation
        // lines; every public method here speaks CURRENT lines. Once a line has
        // been added or removed the two frames differ, and a prose line just
        // above a display equation lands inside that equation's compiled range.
        // It then comes back as a CONTAINING object with no `approximate` mark
        // — which the click path reads as "this click was in maths", switching
        // off the prose rescue that was carrying those answers.
        // The shape of the paper: a paragraph of prose BETWEEN two displays, so
        // that a line shifted backwards falls inside the one ABOVE it. One
        // equation on its own cannot reproduce this — the shifted line simply
        // moves further away from it and is still, correctly, approximate.
        const model = {
            objects: [
                { objectId: 'e0', stableKey: 'EQ-ABOVE', kind: 'display-equation',
                    sourceRange: { file: '/p.tex', startLine: 144, endLine: 150 } },
                { objectId: 'e1', stableKey: 'EQ-BELOW', kind: 'display-equation',
                    sourceRange: { file: '/p.tex', startLine: 152, endLine: 158 } },
                { objectId: 's1', stableKey: 'SEC', kind: 'section-heading',
                    sourceRange: { file: '/p.tex', startLine: 100, endLine: 100 } },
            ],
        };
        const m = new RenderMap({ generation: { generation: 1 }, model });

        const fresh = m.objectAtLine('/p.tex', 151);
        assert.ok(fresh, 'the prose line between the two displays gets an answer');
        assert.strictEqual(fresh.approximate, true,
            'line 151 is in neither equation — it is the prose between them');

        // Two lines removed above: current 149 IS the same physical line as 151.
        m.noteEdit('/p.tex', 33, -2);
        const after = m.objectAtLine('/p.tex', 149);
        assert.ok(after, 'still answered');
        assert.strictEqual(after.approximate, true,
            'and it is STILL that prose line, not the inside of the display above it');
    });

    await test('an edited map reports an object in the frame the caller asked in', () => {
        // The range that comes back is used to read the CURRENT document — the
        // maths alignment slices those very lines out of it — so returning
        // compiled line numbers points it at the wrong text by exactly the shift.
        const model = {
            objects: [{ objectId: 'e1', stableKey: 'EQ', kind: 'display-equation',
                sourceRange: { file: '/p.tex', startLine: 152, endLine: 158 } }],
        };
        const m = new RenderMap({ generation: { generation: 1 }, model });
        const before = m.objectAtLine('/p.tex', 155);
        assert.deepStrictEqual([before.startLine, before.endLine], [152, 158],
            'unedited, the two frames are the same');

        m.noteEdit('/p.tex', 33, -2);
        const o = m.objectAtLine('/p.tex', 153);          // was 155
        assert.ok(o && !o.approximate, 'a line inside the equation is inside it');
        assert.deepStrictEqual([o.startLine, o.endLine], [150, 156],
            'and its range is where those lines are NOW');
    });

    console.log('render map (Stage 2 engine)\n');
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
    process.exit(fail ? 1 : 0);
}

main();
