// The live (while-typing) compile policy.
//
//   node out/extension/kernel/tests/tex-live.test.js
//
// Pure-node, no vscode stub and no TeX Live: livePolicy.js is deliberately free
// of I/O so every decision the typing loop makes can be executed directly.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => Promise.resolve().then(fn)
    .then(() => { pass++; results.push('  ok   ' + name); })
    .catch((e) => { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); });

const {
    nextLiveDelayMs, cooldownDelayMs, blendLiveMs, shipDecision, synctexUnchanged,
    readPassLimit, generationSatisfies, authoritativeDelayMs,
} = require('../../tex/livePolicy');
const { needsRerun } = require('../../tex/texLog');

async function main() {
    // --- the debounce ------------------------------------------------------

    await test('with no measurement yet the debounce is the ceiling', () => {
        // Every session's first live build. This is exactly what the code did
        // before it was adaptive, which is what makes the change safe.
        assert.strictEqual(nextLiveDelayMs({ lastMs: null, ceilingMs: 900 }), 900);
        assert.strictEqual(nextLiveDelayMs({ lastMs: 0, ceilingMs: 900 }), 900);
        assert.strictEqual(nextLiveDelayMs({ ceilingMs: 900 }), 900);
    });

    await test('a fast paper recompiles sooner than the ceiling', () => {
        assert.strictEqual(nextLiveDelayMs({ lastMs: 400, ceilingMs: 900 }), 400);
    });

    await test('a slow paper is held at the ceiling', () => {
        assert.strictEqual(nextLiveDelayMs({ lastMs: 17000, ceilingMs: 900 }), 900);
    });

    await test('THE COOLDOWN BACKS OFF WHERE THE DEBOUNCE MAY NOT', () => {
        // The debounce is a ceiling on purpose: nobody should wait 17 s after
        // they stop typing. But that cap means a paper taking LONGER than the
        // ceiling fires again almost as soon as it lands, and spends most of
        // its wall-clock compiling — reported as the editor lagging behind "a
        // long queue of compilations". The queue is only ever one deep; a
        // latexmk running two thirds of the time is what it feels like.
        //
        // Only the go-round-again path uses this. The first pause after typing
        // keeps the ceiling and stays responsive.
        assert.strictEqual(nextLiveDelayMs({ lastMs: 1400, ceilingMs: 900 }), 900,
            'the first pause is unchanged');
        assert.strictEqual(cooldownDelayMs({ lastMs: 1400, ceilingMs: 900 }), 1400,
            'but going round again waits out the build it just did');
        assert.strictEqual(cooldownDelayMs({ lastMs: 400, ceilingMs: 900 }), 900,
            'a paper faster than the ceiling is never made slower');
        assert.strictEqual(cooldownDelayMs({ lastMs: 17000, ceilingMs: 900 }), 5000,
            'and a very slow one still comes back');
        assert.strictEqual(cooldownDelayMs({ ceilingMs: 900 }), 900,
            'with nothing measured yet it is just the ceiling');
    });

    await test('a very fast paper still waits for the floor', () => {
        assert.strictEqual(nextLiveDelayMs({ lastMs: 120, ceilingMs: 900 }), 300);
    });

    await test('THE CEILING BEATS THE FLOOR — clamp order is not reversible', () => {
        // A reader who sets liveRenderDelayMs to 200 must get 200, not the
        // 300 ms floor. Written the other way round (max(floor, min(...)))
        // this returns 300 and the setting looks broken.
        assert.strictEqual(nextLiveDelayMs({ lastMs: 400, ceilingMs: 200 }), 200);
    });

    await test('one outlier compile does not pin the debounce to its ceiling', () => {
        let ewma = null;
        for (let i = 0; i < 10; i++) ewma = blendLiveMs(ewma, 400);
        assert.strictEqual(ewma, 400, 'ten identical samples converge');
        const after = blendLiveMs(ewma, 17000);
        assert.ok(after < 17000 / 2, `a single 17 s outlier lands at ${after}, well under the sample`);
        assert.ok(after > 400, 'but it does move — a real slowdown must be believed eventually');
        // And it forgets. Being sticky-HIGH is the safe direction: while the
        // estimate is above the ceiling the debounce simply IS the ceiling,
        // i.e. exactly today's behaviour. Being sticky-low would queue
        // compiles. Measured: 6 ordinary builds clear a 17 s outlier.
        let back = after;
        for (let i = 0; i < 8; i++) back = blendLiveMs(back, 400);
        assert.ok(back < 900, `eight ordinary builds bring it back to ${back}`);
    });

    await test('the first sample IS the estimate; a bad sample is ignored', () => {
        assert.strictEqual(blendLiveMs(null, 900), 900);
        assert.strictEqual(blendLiveMs(500, 0), 500, 'a zero sample keeps the estimate');
        assert.strictEqual(blendLiveMs(null, 0), null);
    });

    // --- shipping ----------------------------------------------------------

    const genA = { generation: 7, pdfHash: 'aaa' };
    const genB = { generation: 8, pdfHash: 'bbb' };
    const genAagain = { generation: 8, pdfHash: 'aaa' };

    await test('a brand-new panel is always shipped a document', () => {
        // shownPdfHash null = nothing has ever crossed into this webview.
        const d = shipDecision({ shownGeneration: null, shownPdfHash: null, gen: genA });
        assert.strictEqual(d.ship, true);
    });

    await test('the same generation number is never re-shipped', () => {
        const d = shipDecision({ shownGeneration: 7, shownPdfHash: 'aaa', gen: genA });
        assert.strictEqual(d.ship, false);
        assert.strictEqual(d.reason, 'same generation');
    });

    await test('A NEW GENERATION WITH IDENTICAL INK SHIPS NOTHING', () => {
        // The whole point: typing a comment, or a word that does not reflow,
        // recompiles to a byte-identical (content-hashed) PDF.
        const d = shipDecision({ shownGeneration: 7, shownPdfHash: 'aaa', gen: genAagain });
        assert.strictEqual(d.ship, false);
        assert.strictEqual(d.reason, 'identical pdf');
    });

    await test('a changed PDF is shipped', () => {
        const d = shipDecision({ shownGeneration: 7, shownPdfHash: 'aaa', gen: genB });
        assert.strictEqual(d.ship, true);
        assert.strictEqual(d.reason, 'new pdf');
    });

    await test('force overrides every skip — the escape hatch', () => {
        const d = shipDecision({ force: true, shownGeneration: 7, shownPdfHash: 'aaa', gen: genA });
        assert.strictEqual(d.ship, true);
        assert.strictEqual(d.reason, 'forced');
    });

    await test('a generation with no pdfHash is shipped rather than guessed at', () => {
        const d = shipDecision({ shownGeneration: 1, shownPdfHash: 'aaa', gen: { generation: 2, pdfHash: null } });
        assert.strictEqual(d.ship, true);
    });

    // --- the SyncTeX parse -------------------------------------------------

    await test('identical .synctex bytes let the parse be reused', () => {
        assert.strictEqual(synctexUnchanged({ synctexHash: 'x' }, { synctexHash: 'x' }), true);
        assert.strictEqual(synctexUnchanged({ synctexHash: 'x' }, { synctexHash: 'y' }), false);
    });

    await test('NULL-VS-NULL IS NOT "UNCHANGED"', () => {
        // Two generations that both failed to produce a .synctex have nothing
        // to reuse. Reading this as "nothing changed" would hand the new map a
        // parse that does not exist.
        assert.strictEqual(synctexUnchanged({ synctexHash: null }, { synctexHash: null }), false);
        assert.strictEqual(synctexUnchanged(null, { synctexHash: 'x' }), false);
        assert.strictEqual(synctexUnchanged({ synctexHash: 'x' }, null), false);
    });

    // --- the pass cap ------------------------------------------------------

    // Captured from latexmk 4.88. The warning comes from perl's `warn`, so it
    // is on STDERR — a detector that reads only stdout sees a capped build as
    // an ordinary one and the correction is never scheduled.
    const CAPPED_STDOUT = `Latexmk: applying rule 'pdflatex'...
Latexmk: Run number 1 of rule 'pdflatex'
Latexmk: Log file says output to 'paper.pdf'
`;
    const CAPPED_STDERR = `Latexmk: Maximum runs of rule 'pdflatex' reached without getting stable files
`;
    const CONVERGED_STDOUT = `Latexmk: applying rule 'pdflatex'...
Latexmk: Run number 1 of rule 'pdflatex'
Latexmk: All targets (paper.pdf) are up-to-date
`;
    const RC_ERROR_STDOUT = `Latexmk: Stopping because executing following code from command line
       this is not perl(
`;

    await test('A CAPPED RUN IS DETECTED FROM STDERR', () => {
        const r = readPassLimit({ stdout: CAPPED_STDOUT, stderr: CAPPED_STDERR, maxPasses: 1 });
        assert.strictEqual(r.passesLimited, true);
        assert.strictEqual(r.rcUnsupported, false);
    });

    await test('a capped run that converged in one pass is NOT limited', () => {
        // The common typing case: one pass was enough, so the generation is
        // fully authoritative and no follow-up rebuild is needed at all.
        const r = readPassLimit({ stdout: CONVERGED_STDOUT, stderr: '', maxPasses: 1 });
        assert.strictEqual(r.passesLimited, false);
    });

    await test('an uncapped run is never reported as limited', () => {
        const r = readPassLimit({ stdout: CAPPED_STDOUT, stderr: CAPPED_STDERR, maxPasses: null });
        assert.strictEqual(r.passesLimited, false, 'no cap was asked for, so none was hit');
    });

    await test('latexmk refusing our -e code is named, not silently mistaken for a cap', () => {
        const r = readPassLimit({ stdout: RC_ERROR_STDOUT, stderr: '', maxPasses: 1 });
        assert.strictEqual(r.rcUnsupported, true);
    });

    // --- authoritative-vs-live --------------------------------------------

    await test('A BUILD LATEX ITSELF WANTS RERUN IS NOT A FINISHED BUILD', () => {
        // Reported: a NEW equation label renders as (?) and stays that way.
        // The cap is only one of the two ways to be one pass behind — the
        // other is a build that ran to completion and wrote a .aux nobody has
        // read yet, which is exactly what a new \label does. Only the cap was
        // checked, so nothing ever went back to fix it.
        const stale = { passesLimited: false, rerunWanted: true };
        assert.strictEqual(generationSatisfies(stale, { authoritative: false }), true,
            'the ink is current, so the live loop is content');
        assert.strictEqual(generationSatisfies(stale, { authoritative: true }), false,
            'but it must converge before it counts as finished');
    });

    await test('LATEX ASKING FOR A PASS IS RECOGNISED, IN ITS OWN WORDS', () => {
        assert.ok(needsRerun('LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.'));
        assert.ok(needsRerun('Package rerunfilecheck Warning: File `p.out\' has changed.\n(rerunfilecheck)  Rerun to get outlines right'));
        assert.ok(needsRerun('LaTeX Warning: Please rerun LaTeX.'));
        assert.ok(!needsRerun('LaTeX Warning: There were undefined references.'),
            'an undefined REFERENCE is reported by LaTeX separately; the rerun request is the signal');
        assert.ok(!needsRerun(''));
        assert.ok(!needsRerun(null));
    });

    await test('AN UNDEFINED CITATION MUST NOT ARM THE REBUILD FOR EVER', () => {
        // It used to be in this predicate. A \cite to a key that is not in the
        // .bib warns on EVERY pass, so treating it as "wants a rerun" would
        // start the background build again the moment it finished, for as long
        // as the paper stayed open. latexmk owns the bibtex loop; all we need
        // to know is whether the last build left the paper unconverged.
        const log = 'LaTeX Warning: Citation `Gromov:2013pga\' on page 3 undefined on input line 91.\n' +
            'LaTeX Warning: There were undefined citations.';
        assert.strictEqual(needsRerun(log), false);
        assert.strictEqual(generationSatisfies({ rerunWanted: needsRerun(log) }, { authoritative: true }), true,
            'so a paper with a missing bib entry still counts as finished');
    });

    await test('A ONE-PASS GENERATION DOES NOT SATISFY A SAVE', () => {
        const limited = { passesLimited: true };
        assert.strictEqual(generationSatisfies(limited, { authoritative: false }), true,
            'the ink is current, so the live loop is content');
        assert.strictEqual(generationSatisfies(limited, { authoritative: true }), false,
            'but a save must converge the cross-references');
    });

    await test('a full generation satisfies both', () => {
        const full = { passesLimited: false };
        assert.strictEqual(generationSatisfies(full, { authoritative: false }), true);
        assert.strictEqual(generationSatisfies(full, { authoritative: true }), true);
    });

    await test('no generation satisfies nothing', () => {
        assert.strictEqual(generationSatisfies(null, {}), false);
        assert.strictEqual(generationSatisfies(null, { authoritative: true }), false);
    });

    await test('THE IDLE REBUILD ALWAYS SITS BEHIND THE LIVE ONE', () => {
        // Otherwise the two race for the same out dir on every pause.
        assert.strictEqual(authoritativeDelayMs({ configuredMs: 4000, liveDelayMs: 900 }), 4000);
        assert.strictEqual(authoritativeDelayMs({ configuredMs: 1000, liveDelayMs: 900 }), 2400);
        assert.strictEqual(authoritativeDelayMs({ configuredMs: 1000, liveDelayMs: 17000 }), 18500);
    });

    await test('0 disables the idle rebuild', () => {
        assert.strictEqual(authoritativeDelayMs({ configuredMs: 0, liveDelayMs: 900 }), 0);
    });

    console.log('tex live-compile policy\n');
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

main();
