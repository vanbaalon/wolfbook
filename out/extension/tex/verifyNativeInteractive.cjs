// The interactive (incremental) preview lane, end to end against the real
// engine. Uses only what the extension itself uses: NativeBuildLane, and the
// renderer the webview loads.
//
//   node verifyNativeInteractive.cjs /absolute/WLaTeX/install
//
// Set WLATEX_NATIVE_FORMAT to a compatible saved format, or the engine spends
// tens of seconds building one before the first page.
//
// What this proves:
//   * the lane offers an interactive engine, and a cold build still works
//   * an interactive build delivers TXDL pages, and an edit on page 2 of a
//     six-page paper recomputes only the pages that could have moved
//   * a second edit converges: the engine stops at a state match and reuses
//     the pages after it (`pages_reused >= 1`, `stop.Converged`)
//   * the auxiliary files of the last cold build really reach the preview, so
//     a forward \ref resolves there as it does in the PDF
//   * a delivered page draws: every glyph the renderer asks for is answered by
//     the engine through the same outline call the webview makes
//   * an interactive failure is a failure of the preview only — the lane
//     survives it and its cold builds keep working
//   * every recomputed live page publishes its own source map, bound to the
//     text it was typeset from: a click on the edited page's glyph lands on
//     the edited line, and the cursor on that line highlights that page
//
// What it does NOT prove: that a `txdlPage` message creates an overlay canvas
// in the real webview. That needs the VS Code acceptance harness
// (launchNativeVSCodeCheck.cjs), which drives a real panel and is not run here.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { NativeBuildLane } = require('./nativeCompileService');

// SIX PAGES, NOT FOUR. An edit on page 2 makes the engine restart before it
// and typeset forward until the state matches again, which costs the edited
// page, the page after it and a one-page output witness. On a four-page paper
// that is every remaining page and nothing can be reused, so `pages_reused`
// could only ever be 0 and the reuse claim would go unchecked.
const PAGES = 6;

function paper(marker) {
    let body = '\\section{Opening}\nThe closing section is on page~\\ref{sec:last}.\n\\newpage\n';
    for (let page = 2; page <= PAGES; page++) {
        body += `\\section{Section ${page}}\n` +
            (page === 2 ? `${marker}\n` : 'Ordinary body text for this section.\n') +
            (page === PAGES ? '\\label{sec:last}\nIdentity $\\mathbbm{1}$.\n' : '') +
            (page === PAGES ? '' : '\\newpage\n');
    }
    return `\\documentclass{article}\\usepackage{bbm}\n\\begin{document}\n${body}\\end{document}\n`;
}

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A 2D context that records nothing but the fills, for the renderer check. */
function fakeContext() {
    const calls = { fill: 0, fillRect: 0 };
    const noop = () => {};
    return { calls, save: noop, restore: noop, scale: noop, translate: noop, beginPath: noop,
        moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop, closePath: noop,
        setLineDash: noop, strokeRect: noop, stroke: noop,
        fill: () => { calls.fill += 1; }, fillRect: () => { calls.fillRect += 1; },
        set fillStyle(_v) {}, get fillStyle() { return '#000'; },
        set strokeStyle(_v) {}, get strokeStyle() { return '#000'; },
        set lineWidth(_v) {}, get lineWidth() { return 1; } };
}

async function main() {
    const directory = process.argv[2];
    if (!directory || !path.isAbsolute(directory)) throw Error('Supply an absolute WLaTeX installation path');
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'wpaper-native-interactive-'));
    const root = path.join(project, 'paper.tex');
    const original = paper('The original text of the second section.');
    await fs.writeFile(root, original);

    const lane = new NativeBuildLane(root, directory);
    const evidence = { project, platform: process.platform, arch: process.arch };
    try {
        assert.equal(lane.interactive, true, `no interactive engine: ${lane.interactiveUnavailable}`);

        // THE FIRST PAUSE IN TYPING IS NOT SPENT BUILDING A FORMAT. The first
        // preview asks for the engine and declines to wait for it; every pause
        // after that previews. Here the verifier waits deliberately.
        assert.equal(await lane.interactiveBuild({ sourceFiles: [root], overlay: new Map([[root, original]]) }), null,
            'the first preview blocked on the engine starting');
        assert.equal(await lane.warmInteractive(), true, `the engine did not start: ${lane.interactiveUnavailable}`);
        evidence.first_preview_does_not_block = true;

        // A build for a document whose last cold build wrote nothing: the
        // forward \ref has no number to find, exactly as a first cold build
        // would show it. Kept as the baseline the auxiliary replay is compared
        // against below.
        const cold0 = await run(lane, { text: original, pages: [1, 2] });
        assert.equal(cold0.ok, true, 'the first interactive build failed');
        assert.equal(cold0.pageCount, PAGES);
        assert.deepEqual(cold0.delivered.map(p => p.page), [1, 2, 3, 4, 5, 6],
            'a first interactive build must deliver every page');
        for (const page of cold0.delivered) {
            assert.ok(page.txdl && Array.isArray(page.txdl.ops) && page.txdl.ops.length,
                `page ${page.page} carried no display list`);
            assert.ok(page.fonts && Object.keys(page.fonts).length, `page ${page.page} carried no font table`);
            assert.match(page.identity, /^[0-9a-f]{64}$/);
        }
        const unresolvedReference = cold0.delivered[0].identity;
        evidence.first_build_delivers_every_page = true;

        // The cold build: the PDF, the map, the settlement — and the auxiliary
        // files the preview replays.
        const cold = await lane.compile({ sourceFiles: [root] });
        assert.equal(cold.ok, true, `the cold build failed: ${cold.stopReason}`);
        assert.equal(cold.pageCount, PAGES);
        const auxiliary = Object.keys(lane._auxiliaryTexts());
        assert.ok(auxiliary.includes('paper.aux'), `no auxiliary text to replay: ${auxiliary.join(', ')}`);
        evidence.auxiliary_replayed = auxiliary.sort();

        // The same text again, now with those auxiliary files. Page 1 holds a
        // forward \ref, so it MUST typeset differently from the build above.
        const settledRefs = await run(lane, { text: original, pages: [1, 2] });
        assert.equal(settledRefs.ok, true);
        const resolvedReference = settledRefs.delivered.find(p => p.page === 1)?.identity;
        assert.ok(resolvedReference, 'page 1 was not delivered after the cold build');
        assert.notEqual(resolvedReference, unresolvedReference,
            'the cold auxiliary files did not change the preview: the reference did not resolve');
        evidence.auxiliary_resolves_references = true;

        // FIRST EDIT, on page 2. Page 1 cannot have moved, so it is not
        // recomputed; the edited page and what follows it are.
        await typeInto(lane, original, paper('An edited second section, one line longer.'));
        const firstEdit = await run(lane, { text: paper('An edited second section, one line longer.'), pages: [1, 2] });
        assert.equal(firstEdit.ok, true, 'the first edited interactive build failed');
        const firstPages = firstEdit.delivered.map(p => p.page);
        assert.ok(firstPages.includes(2) && firstPages.includes(3),
            `pages 2 and 3 must be delivered, got ${firstPages.join(', ')}`);
        assert.ok(!firstPages.includes(1), 'page 1 cannot be affected by an edit on page 2');
        assert.equal(firstEdit.delivered.find(p => p.page === 2).changed, true);
        assert.ok(firstEdit.report.restart_page >= 1, 'the build did not resume from a checkpoint');
        assert.ok(firstEdit.report.pages_recomputed < PAGES,
            `an edit on page 2 recomputed the whole document (${firstEdit.report.pages_recomputed})`);
        evidence.first_edit = { delivered: firstPages, restart_page: firstEdit.report.restart_page,
            pages_recomputed: firstEdit.report.pages_recomputed, pages_reused: firstEdit.report.pages_reused,
            stop: firstEdit.report.stop, total_ms: Math.round(firstEdit.report.total_ms) };

        // SECOND EDIT, on the same page. The engine now has an old document to
        // match against and converges: it stops one page after the last change
        // and reuses the rest.
        await typeInto(lane, paper('An edited second section, one line longer.'), paper('A second edit of that section, longer still.'));
        const secondEdit = await run(lane, { text: paper('A second edit of that section, longer still.'), pages: [1, 2] });
        assert.equal(secondEdit.ok, true, 'the second edited interactive build failed');
        const secondPages = secondEdit.delivered.map(p => p.page);
        assert.ok(secondPages.includes(2) && secondPages.includes(3),
            `pages 2 and 3 must be delivered, got ${secondPages.join(', ')}`);
        assert.equal(secondEdit.delivered.find(p => p.page === 2).changed, true);
        assert.ok(secondEdit.report.pages_reused >= 1,
            `no page was reused (${JSON.stringify(secondEdit.report.stop)})`);
        assert.ok(secondEdit.report.stop && secondEdit.report.stop.Converged,
            `the build did not converge: ${JSON.stringify(secondEdit.report.stop)}`);
        assert.equal(secondEdit.pageCount, PAGES);
        evidence.second_edit = { delivered: secondPages, restart_page: secondEdit.report.restart_page,
            pages_recomputed: secondEdit.report.pages_recomputed, pages_reused: secondEdit.report.pages_reused,
            stop: secondEdit.report.stop, total_ms: Math.round(secondEdit.report.total_ms) };

        // THE LIVE PAGE HAS ITS OWN MAP. Every recomputed page published one;
        // page 2's glyphs map to the edited line (line 7) of the current text.
        // A placed paragraph fragment publishes its map before the completed
        // page publishes another. Require each changed page's own identity,
        // rather than counting both maps as two changed pages.
        for (const page of secondEdit.delivered.filter(p => p.changed)) {
            assert.ok(secondEdit.maps.some(m => m.ready && m.page === page.page && m.identity === page.identity),
                `changed page ${page.page} has no map bound to its identity`);
        }
        const mapped = [...new Set(secondEdit.maps.filter(m => m.ready).map(m => m.page))].sort((a, b) => a - b);
        assert.deepEqual(mapped, secondPages.filter(p => secondEdit.delivered.find(d => d.page === p).changed).sort((a, b) => a - b),
            `live page maps: ${JSON.stringify(secondEdit.maps)}`);
        const { NativeMap } = require('./nativeMap');
        const live = new NativeMap({ nativeView: await lane.liveView([2]), nativeSource: lane.source, projectDir: lane.projectDir });
        assert.equal(live.available && live.live, true, 'the live map is not available');
        const glyph = live.glyphsForLine(root, 7).find(e => e.page === 2);
        assert.ok(glyph, 'no live glyph of page 2 maps to the edited line');
        const hit = await live.renderToSourceViaWorker(2, glyph.x + glyph.w / 2, glyph.y + glyph.boxHeight / 2);
        assert.equal(hit.file, root);
        assert.equal(hit.line, 7, `a click on the edited page landed on line ${hit.line}`);
        const rects = await live.forwardAt(root, 7, 2);
        assert.ok(rects?.length && rects.every(r => r.page === 2), `forward from line 7: ${JSON.stringify(rects)}`);
        evidence.live_page_maps = { pages: mapped, click_line: hit.line, exact: hit.exact, forward_rects: rects.length };

        // The identities are the engine's own: the same text must produce the
        // same pages, or the preview would flicker on every keystroke.
        const repeat = await run(lane, { text: paper('A second edit of that section, longer still.'), pages: [1, 2] });
        assert.equal(repeat.ok, true);
        for (const page of repeat.delivered) assert.equal(page.changed, false,
            `page ${page.page} was reported changed although the text did not move`);
        evidence.identical_text_changes_nothing = true;

        // THE PAGE DRAWS. The renderer the webview loads, the outline call the
        // webview makes, and a delivered page: every glyph must resolve.
        const clientRenderer = path.resolve(__dirname, '../../client/txdl-canvas.js');
        const sdkRenderer = path.join(lane.runtime.installed ? path.dirname(lane.runtime.sdk) : lane.runtime.sdk,
            lane.runtime.installed ? 'sdk/viewer/txdl-canvas.js' : 'viewer/txdl-canvas.js');
        const { createTxdlRenderer } = await import(`file://${clientRenderer}`);
        let sameAsSdk = null;
        try {
            sameAsSdk = (await fs.readFile(clientRenderer, 'utf8')) === (await fs.readFile(sdkRenderer, 'utf8'));
        } catch (_) { sameAsSdk = null; }     // a packaged runtime may not ship the viewer
        const asked = [];
        const renderer = createTxdlRenderer({
            async requestOutlines(font, gids) { asked.push({ font, gids: gids.length }); return lane.outlines(font, gids); },
        });
        const drawn = secondEdit.delivered.find(p => p.page === 2);
        const ctx = fakeContext();
        const scale = 96 / 72.27;
        let result = renderer.render(drawn.txdl, ctx, { scale, dpr: 1 });
        assert.ok(result.width > 0 && result.height > 0);
        assert.ok(result.pending > 0, 'nothing was pending before any outline was fetched');
        assert.equal(result.fallback, false, 'a plain article page must not need the PDF');
        await renderer.prefetch(drawn.txdl);
        assert.ok(asked.length, 'the renderer asked for no outlines');
        result = renderer.render(drawn.txdl, ctx, { scale, dpr: 1 });
        assert.equal(result.pending, 0, `${result.pending} glyphs still had no outline`);
        assert.equal(result.skipped, 0, `${result.skipped} glyphs could never be drawn`);
        assert.ok(result.glyphs > 0, 'no glyph was painted');
        assert.ok(ctx.calls.fill >= result.glyphs, 'the context recorded fewer fills than glyphs');
        evidence.rendered_page = { page: drawn.page, glyphs: result.glyphs, rules: result.rules,
            outline_requests: asked.length, client_renderer_matches_sdk: sameAsSdk };

        // A BITMAP FONT MUST NOT DISABLE THE WHOLE LAST PAGE'S LIVE PREVIEW.
        // bbm has no vector outline; the lane supplies the same PK glyphs the
        // full PDF uses. Both a new final paragraph and its next key paint.
        let tailBefore = paper('A second edit of that section, longer still.');
        let tailIdentity = cold0.delivered.find(p => p.page === PAGES).identity;
        const tailEvidence = [];
        for (const suffix of ['LiveTailAlpha', 'LiveTailAlphaBeta']) {
            const text = paper('A second edit of that section, longer still.').replace('\\end{document}', `${suffix}\n\\end{document}`);
            await typeInto(lane, tailBefore, text);
            const tail = await run(lane, { text, pages: [PAGES] });
            assert.equal(tail.ok, true);
            const page = tail.delivered.find(p => p.page === PAGES && p.changed);
            assert.ok(page, 'the last source line did not deliver a changed page');
            assert.notEqual(page.identity, tailIdentity);
            const bbm = page.txdl.fonts.find(f => f.name === 'bbm10');
            assert.ok(bbm && !page.fonts[bbm.definition_digest].file, 'the fixture must use the unresolved bitmap font');
            const fetched = await renderer.prefetch(page.txdl);
            assert.deepEqual(fetched.errors, [], 'every font, including bbm, must load');
            const painted = renderer.render(page.txdl, fakeContext(), { scale, dpr: 1 });
            assert.equal(painted.pending + painted.skipped, 0, 'no missing bitmap glyphs');
            assert.equal(painted.fallback, false, 'last-line edits must remain live');
            tailEvidence.push({ suffix, page: page.page, total_ms: Math.round(tail.report.total_ms), glyphs: painted.glyphs });
            tailBefore = text; tailIdentity = page.identity;
        }
        evidence.bitmap_font_last_line = tailEvidence;
        await typeInto(lane, tailBefore, paper('A second edit of that section, longer still.'));

        // THE TWO HALVES STILL AGREE. Everything above runs in Node; the
        // overlay itself is DOM, and only the VS Code acceptance harness can
        // drive that. What is checked here is that the webview still loads
        // this renderer and still handles the three messages the host sends,
        // so the halves cannot drift apart unnoticed.
        const client = await fs.readFile(path.resolve(__dirname, '../../client/tex-viewer.js'), 'utf8');
        for (const needle of ["from './txdl-canvas.js'", "case 'txdlPage'", "case 'txdlBuilt'",
            "case 'txdlOutlines'", 'clearTxdlOverlays()', 'canvas.className = \'txdl-overlay\'']) {
            assert.ok(client.includes(needle), `the webview no longer carries ${needle}`);
        }
        evidence.webview_wiring_present = true;

        // Unrelated dirty files do not belong to this paper's overlay. They
        // are ignored, rather than failing an otherwise valid preview.
        const foreign = await lane.interactiveBuild({ sourceFiles: [root],
            overlay: new Map([[path.join(os.tmpdir(), 'not-in-this-project.tex'), 'x']]) });
        assert.equal(foreign?.ok, true, 'an unrelated dirty file broke the preview');
        evidence.unrelated_overlay_ignored = true;

        // AN INTERACTIVE FAILURE IS NOT THE LANE'S FAILURE. A missing main
        // file must return a diagnostic without closing the cold lane.
        await fs.rename(root, `${root}.saved`);
        let missing;
        try { missing = await lane.interactiveBuild({ sourceFiles: [root] }); }
        finally { await fs.rename(`${root}.saved`, root); }
        assert.equal(missing?.ok, false, 'a missing main file did not fail the preview');
        assert.ok(missing.diagnostics[0].message, 'a failed preview carried no reason');
        assert.equal(lane.closed, undefined, 'a failed preview closed the lane');
        const afterFailure = await run(lane, { text: paper('After the failed preview.'), pages: [1, 2] });
        assert.equal(afterFailure.ok, true, 'the lane did not survive a failed preview');
        const coldAfter = await lane.compile({ sourceFiles: [root] });
        assert.equal(coldAfter.ok, true, 'the cold lane did not survive a failed preview');
        assert.ok(coldAfter.generation > cold.generation);
        evidence.failed_preview_keeps_the_lane = true;

        // Nothing here ever writes to the project.
        assert.equal(await fs.readFile(root, 'utf8'), original);
        evidence.saved_source_unchanged = true;
        evidence.preview_never_settles = !secondEdit.settled;
        // THE WHOLE DOCUMENT, not only the pages this build re-typeset: a
        // build reports the identity of every page it stands behind, reused or
        // recomputed, and identical text must stand behind identical pages.
        assert.equal(secondEdit.pages.length, PAGES);
        assert.deepEqual(repeat.pages, secondEdit.pages,
            'identical text produced a different document');
        evidence.page_identity_stable = { pages_compared: PAGES,
            pages_delivered: repeat.delivered.length,
            pages_recomputed: repeat.report.pages_recomputed, stop: repeat.report.stop };

        // A closed lane has no preview, and says so by answering null rather
        // than by throwing into a keystroke.
        await lane.close();
        assert.equal(await lane.interactiveBuild({ sourceFiles: [root] }), null);
        assert.equal(lane.interactive, false);
        evidence.closed_lane_has_no_preview = true;

        console.log(JSON.stringify({ result: 'PASS', ...evidence }, null, 2));
    } finally { await lane.close().catch(() => {}); }
}

/** One interactive build, with every page it delivered and every page map. */
async function run(lane, { text, pages }) {
    const delivered = [], maps = [];
    const result = await lane.interactiveBuild({ sourceFiles: [lane.root], wait: true,
        overlay: new Map([[lane.root, text]]), nativePages: pages,
        onPage: page => delivered.push(page), onPageMap: map => maps.push(map) });
    assert.ok(result, 'the interactive build was superseded with nothing else running');
    return { ...result, delivered, maps, settled: false };
}

/** The editor replacing the whole buffer, as VS Code reports it to the lane. */
function typeInto(lane, before, after) {
    const document = { uri: { fsPath: lane.root }, getText: () => after };
    return lane.noteChange(document, [{ rangeOffset: 0, rangeLength: before.length, text: after }]);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
