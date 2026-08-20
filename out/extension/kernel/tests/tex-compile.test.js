// Stage 2 engine: the TeX log parser and the compile service.
//
//   node out/extension/kernel/tests/tex-compile.test.js
//
// Pure-node; no vscode stub. The compile half is SKIPPED when latexmk is
// absent rather than failing, so the suite stays green on a machine without
// TeX Live — but when TeX Live is there it really compiles.

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

const { parseLog, needsRerun, unwrap, detectWrapWidth } = require('../../tex/texLog');
const {
    compile, defaultOutDir, pdfContentHash, snapshotSources, generationIsCurrent, mirrorSkeleton,
} = require('../../tex/compileService');

const hasLatexmk = (() => {
    try { execFileSync('latexmk', ['--version'], { stdio: 'ignore' }); return true; }
    catch (_) { return false; }
})();

// --- log parsing -----------------------------------------------------------

const LOG_FILELINE = `This is pdfTeX, Version 3.141592653-2.6-1.40.29
(./paper.tex
./paper.tex:13: Undefined control sequence.
l.13 \\thiscommanddoesnotexist
LaTeX Warning: Reference \`fig:nope' on page 2 undefined on input line 21.
Overfull \\hbox (4.42pt too wide) in paragraph at lines 30--32
Underfull \\hbox (badness 10000) in paragraph at lines 40--41
LaTeX Warning: Citation \`nobody:1999' on page 1 undefined on input line 25.
Label \`eq:dup' multiply defined.
Output written on paper.pdf (12 pages, 34567 bytes).
`;

async function main() {
    await test('errors with -file-line-error carry a file AND a line', () => {
        const r = parseLog(LOG_FILELINE, { file: 'paper.tex' });
        const e = r.diagnostics.find(d => d.severity === 'error');
        assert.ok(e, 'the error is found');
        assert.strictEqual(e.line, 13);
        assert.strictEqual(e.file, 'paper.tex');
        assert.strictEqual(e.kind, 'undefined-control-sequence');
    });

    await test('errors WITHOUT -file-line-error still get a line from l.NN', () => {
        // GetLatexErrorsTool only matches /^!/, so turning ON the flag that
        // makes errors carry a filename DROPS its recall. This parser must
        // handle both shapes, because a user's own latexmkrc may not pass it.
        const r = parseLog('! Undefined control sequence.\nl.42 \\nope\n', { file: 'x.tex' });
        assert.strictEqual(r.diagnostics.length, 1);
        assert.strictEqual(r.diagnostics[0].line, 42);
        assert.strictEqual(r.diagnostics[0].context, '\\nope');
    });

    await test('overfull boxes carry the AMOUNT, in pt and mm', () => {
        const r = parseLog(LOG_FILELINE, { file: 'paper.tex' });
        const o = r.diagnostics.find(d => d.kind === 'overfull-hbox');
        assert.ok(o);
        assert.strictEqual(o.line, 30);
        assert.strictEqual(o.endLine, 32);
        assert.strictEqual(o.overBy, 4.42);
        // "exceeds the text width by 1.6 mm" is the sentence the UI wants
        assert.ok(Math.abs(o.overByMm - 1.553) < 0.01, `got ${o.overByMm}`);
        assert.strictEqual(o.direction, 'wide');
    });

    await test('unresolved refs and cites are classified and carry their symbol', () => {
        const r = parseLog(LOG_FILELINE, { file: 'paper.tex' });
        const ref = r.diagnostics.find(d => d.kind === 'unresolved-ref');
        const cite = r.diagnostics.find(d => d.kind === 'unresolved-cite');
        assert.strictEqual(ref.symbol, 'fig:nope');
        assert.strictEqual(ref.page, 2);
        assert.strictEqual(ref.line, 21);
        assert.strictEqual(cite.symbol, 'nobody:1999');
    });

    await test('a duplicate label has no line ANYWHERE and says so', () => {
        // It is detected while reading the previous .aux, so there is no line
        // to report. Emitting a fake one would be worse than admitting it.
        const r = parseLog(LOG_FILELINE, { file: 'paper.tex' });
        const d = r.diagnostics.find(x => x.kind === 'duplicate-label');
        assert.ok(d, 'found');
        assert.strictEqual(d.symbol, 'eq:dup');
        assert.strictEqual(d.lineUnavailable, true);
    });

    await test('page count and engine come out of the log', () => {
        const r = parseLog(LOG_FILELINE, { file: 'paper.tex' });
        assert.strictEqual(r.pages, 12);
        assert.strictEqual(r.engine, 'pdfTeX');
        assert.strictEqual(r.outputFormat, 'pdf');
    });

    await test('A LOG IS A PREFIX: a fatal stop is reported as such', () => {
        // min-errors.tex surfaces 1 of 10 planted problems because a missing
        // \usepackage is fatal in nonstopmode. A UI must be able to say
        // "stopped here, later problems unknown" rather than "1 problem".
        const r = parseLog('! LaTeX Error: File `nosuch.sty\' not found.\nl.5 \\usepackage{nosuch}\n' +
            '! Emergency stop.\n', { file: 'x.tex' });
        assert.strictEqual(r.stopped, true);
        assert.ok(r.stopReason);
        assert.ok(r.diagnostics.some(d => d.kind === 'missing-file'));
    });

    await test('wrap detection: an UNwrapped log is left alone', () => {
        // compileService sets max_print_line=1000, so nothing is wrapped.
        // Assuming a 79-column wrap glued `Output written on ...` onto the
        // line before it and reported an 89-page document as unknown.
        const lines = ['a'.repeat(120), 'Output written on x.pdf (7 pages, 1 bytes).'];
        assert.strictEqual(detectWrapWidth(lines), null);
        assert.strictEqual(parseLog(lines.join('\n')).pages, 7);
    });

    await test('wrap detection: a genuinely wrapped log IS rejoined', () => {
        const raw = ['x'.repeat(79), 'tail one', 'y'.repeat(79), 'tail two', 'z'.repeat(79), 'tail three'];
        assert.strictEqual(detectWrapWidth(raw), 79);
        const u = unwrap(raw.join('\n'));
        assert.strictEqual(u.length, 3, 'three records, not six lines and not one');
        assert.ok(u[0].endsWith('tail one'));
    });

    await test('needsRerun mirrors latexmk\'s own rule', () => {
        assert.ok(needsRerun('Label(s) may have changed. Rerun to get cross-references right.'));
        assert.ok(!needsRerun('Output written on x.pdf (1 page).'));
    });

    await test('parseLog never throws, on anything', () => {
        for (const bad of ['', null, undefined, '\0\0\0', 'x'.repeat(100000), '!\n!\nl.\n']) {
            const r = parseLog(bad);
            assert.ok(Array.isArray(r.diagnostics));
        }
    });

    // --- compile service ---------------------------------------------------

    await test('the out dir is stable per document and outside the project', () => {
        // A fresh dir per compile discards the .aux cache (712 ms vs 76 ms)
        // and changes the .synctex for reasons unrelated to the source.
        const a = defaultOutDir('/proj/paper.tex');
        const b = defaultOutDir('/proj/paper.tex');
        assert.strictEqual(a, b, 'stable');
        assert.notStrictEqual(a, defaultOutDir('/proj/other.tex'));
        assert.ok(!a.startsWith('/proj'), 'never inside the project');
    });

    await test('pdfContentHash ignores the metadata that moves every run', () => {
        const mk = (d) => Buffer.from(
            `%PDF-1.5\n/CreationDate (D:${d})\n/ModDate (D:${d})\n/ID [<aa> <bb>]\nbody stays\n`, 'latin1');
        assert.strictEqual(pdfContentHash(mk('20260101')), pdfContentHash(mk('20991231')),
            'same content, different clock -> same hash');
        const other = Buffer.from('%PDF-1.5\n/CreationDate (D:1)\nbody CHANGED\n', 'latin1');
        assert.notStrictEqual(pdfContentHash(mk('1')), pdfContentHash(other));
    });

    await test('sourceSnapshotHash covers content and set membership', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbsnap-'));
        const a = path.join(dir, 'a.tex'); const b = path.join(dir, 'b.tex');
        fs.writeFileSync(a, 'one'); fs.writeFileSync(b, 'two');
        const h1 = snapshotSources([a, b]);
        assert.strictEqual(snapshotSources([b, a]), h1, 'order does not matter');
        fs.writeFileSync(b, 'two!');
        assert.notStrictEqual(snapshotSources([a, b]), h1, 'content does');
        assert.notStrictEqual(snapshotSources([a]), h1, 'membership does');
        assert.ok(snapshotSources([a, path.join(dir, 'gone.tex')]), 'a missing file is not a crash');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('generationIsCurrent is false once a source changes', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbgen-'));
        const f = path.join(dir, 'p.tex');
        fs.writeFileSync(f, 'hello');
        const gen = { sourceSnapshotHash: snapshotSources([f]) };
        assert.strictEqual(generationIsCurrent(gen, [f]), true);
        fs.writeFileSync(f, 'hello world');
        assert.strictEqual(generationIsCurrent(gen, [f]), false);
        assert.strictEqual(generationIsCurrent(null, [f]), false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('mirrorSkeleton reproduces directories and NOT files', () => {
        // \include{sub/sec3} writes sub/sec3.aux relative to cwd; without the
        // mirrored skeleton pdftex dies with "I can't write on file".
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'wbmir-'));
        const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'wbmir2-'));
        fs.mkdirSync(path.join(src, 'sub', 'deep'), { recursive: true });
        fs.writeFileSync(path.join(src, 'sub', 'a.tex'), 'x');
        mirrorSkeleton(src, dst);
        assert.ok(fs.existsSync(path.join(dst, 'sub', 'deep')), 'directories mirrored');
        assert.ok(!fs.existsSync(path.join(dst, 'sub', 'a.tex')), 'files are NOT copied');
        fs.rmSync(src, { recursive: true, force: true });
        fs.rmSync(dst, { recursive: true, force: true });
    });

    if (!hasLatexmk) {
        skip('a real compile leaves the project byte-identical', 'latexmk not installed');
        skip('a compile of a BROKEN paper still yields a PDF and diagnostics', 'latexmk not installed');
        skip('cancellation kills the process group', 'latexmk not installed');
    } else {
        const mkProject = (name, body) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbproj-'));
            const root = path.join(dir, name);
            fs.writeFileSync(root, body);
            return { dir, root };
        };
        const treeHash = (dir) => {
            const out = {};
            for (const f of fs.readdirSync(dir)) {
                const p = path.join(dir, f);
                try { if (fs.statSync(p).isFile()) out[f] = fs.readFileSync(p).toString('latin1'); } catch (_) {}
            }
            return JSON.stringify(out);
        };

        await test('a real compile leaves the project byte-identical', async () => {
            const { dir, root } = mkProject('ok.tex',
                '\\documentclass{article}\\begin{document}\n\\section{S}\nHello world.\n\\end{document}\n');
            const before = treeHash(dir);
            const r = await compile({ root, sourceFiles: [root], timeoutMs: 120000 });
            assert.strictEqual(r.ok, true, 'compiled');
            assert.strictEqual(r.pageCount, 1);
            assert.ok(r.pdfHash && r.synctexHash, 'both hashes present');
            assert.ok(!r.outDir.startsWith(dir), 'built out of tree');
            assert.strictEqual(treeHash(dir), before, 'THE PROJECT MUST BE UNTOUCHED');
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(r.outDir, { recursive: true, force: true });
        });

        await test('a compile of a BROKEN paper still yields a PDF and diagnostics', async () => {
            // -halt-on-error would give no PDF at all here, leaving the render
            // map nothing to map against. -f ships the pages AND logs the error.
            const { dir, root } = mkProject('bad.tex',
                '\\documentclass{article}\\begin{document}\n\\section{S}\nText.\n' +
                '\\begin{equation} x=1 \\end{equation}\n\\end{equation}\nMore text.\n\\end{document}\n');
            const r = await compile({ root, sourceFiles: [root], timeoutMs: 120000 });
            assert.ok(r.pdfPath, 'a best-effort PDF exists');
            assert.ok(r.errors >= 1, 'and the error is still reported');
            assert.ok(r.diagnostics.some(d => d.line), 'with a line number');
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(r.outDir, { recursive: true, force: true });
        });

        await test('cancellation kills the process group and leaves the project clean', async () => {
            const { dir, root } = mkProject('slow.tex',
                '\\documentclass{article}\\usepackage{pgfplots}\\pgfplotsset{compat=1.18}\n' +
                '\\begin{document}\n' +
                '\\begin{tikzpicture}\\begin{axis}\\addplot3[surf,samples=42,domain=-3:3]' +
                '{exp(-x^2-y^2)*cos(deg(x*y))};\\end{axis}\\end{tikzpicture}\n' +
                '\\end{document}\n');
            const before = treeHash(dir);
            const ac = new AbortController();
            const t0 = Date.now();
            setTimeout(() => ac.abort(), 1000);
            const r = await compile({ root, sourceFiles: [root], signal: ac.signal, timeoutMs: 120000 });
            const elapsed = Date.now() - t0;
            assert.strictEqual(r.cancelled, true, 'reported as cancelled');
            assert.ok(elapsed < 20000, `returned promptly (${elapsed} ms)`);
            assert.strictEqual(treeHash(dir), before, 'project untouched by an aborted compile');
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(r.outDir, { recursive: true, force: true });
        });
    }

    // ---------------------------------------------------------- live overlay ----
    // Compiling the unsaved buffer instead of the file on disk. The hazard is not
    // the compile — it is the CACHE: if the snapshot hash keeps reading the file,
    // a live generation looks already-current and nothing ever recompiles again.

    await test('the source snapshot follows the unsaved buffer, not the file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtex-live-'));
        const f = path.join(dir, 'main.tex');
        fs.writeFileSync(f, 'on disk\n');

        const onDisk = snapshotSources([f]);
        const dirty = snapshotSources([f], new Map([[f, 'in the editor\n']]));
        assert.notStrictEqual(dirty, onDisk, 'unsaved text must change the hash');

        // Same buffer twice is the same generation — otherwise every idle tick
        // would queue another compile.
        assert.strictEqual(dirty, snapshotSources([f], new Map([[f, 'in the editor\n']])));

        // And one more keystroke must move it again.
        assert.notStrictEqual(dirty, snapshotSources([f], new Map([[f, 'in the editorx\n']])));

        // An overlay naming a file NOT in the graph changes nothing.
        assert.strictEqual(onDisk, snapshotSources([f], new Map([['/elsewhere/x.tex', 'zz']])));

        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('a live generation is not mistaken for current once typing continues', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtex-live2-'));
        const f = path.join(dir, 'main.tex');
        fs.writeFileSync(f, 'saved\n');

        const typed = new Map([[f, 'typed once\n']]);
        const gen = { sourceSnapshotHash: snapshotSources([f], typed) };
        assert.strictEqual(generationIsCurrent(gen, [f], typed), true, 'same buffer: current');
        assert.strictEqual(generationIsCurrent(gen, [f], new Map([[f, 'typed twice\n']])), false);
        // Saving the buffer with that exact text also leaves it current, because
        // the bytes are what matter, not where they came from.
        fs.writeFileSync(f, 'typed once\n');
        assert.strictEqual(generationIsCurrent(gen, [f], null), true);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    console.log('tex compile engine (log parser + compile service)\n');
    results.forEach(r => console.log(r));
    
console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
    process.exit(fail ? 1 : 0);
}

main();
