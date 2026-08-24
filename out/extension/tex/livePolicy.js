// livePolicy.js — every decision the live (while-typing) compile loop makes.
//
// Pure: no vscode, no fs, no child_process, no clock. That is deliberate, and
// it is what lets kernel/tests/tex-live.test.js execute all of it with no stub
// at all. The callers (renderUi, texViewer, compileService) do the I/O; this
// file only decides.
//
// The loop these functions serve:
//
//   keystroke -> debounce (nextLiveDelayMs)
//             -> compile, possibly capped to one pass (readPassLimit)
//             -> ship to the webview only if the ink moved (shipDecision)
//             -> re-parse SyncTeX only if its bytes moved (synctexUnchanged)
//             -> once the typing really stops, a full rebuild
//                (authoritativeDelayMs, generationSatisfies)

/** The lower bound on the debounce: below this, a pause is not a pause. */
const FLOOR_MS = 300;

/**
 * How long to wait after the last keystroke before rebuilding.
 *
 * The setting is the CEILING, not the value. A 400 ms paper should feel
 * immediate; an 89-page one that takes 17 s should stay calm, because a
 * rebuild fired sooner than the last one finished only queues work that the
 * next keystroke will cancel.
 *
 * With no measurement yet — every session's first live build — this returns
 * the ceiling, which is exactly what the code did before it was adaptive.
 */
function nextLiveDelayMs({ lastMs, ceilingMs, floorMs = FLOOR_MS, k = 1 } = {}) {
    const ceiling = Number(ceilingMs) > 0 ? Number(ceilingMs) : 900;
    if (!lastMs || !(Number(lastMs) > 0)) return ceiling;
    // Math.min LAST: a ceiling below the floor must still win, or a reader who
    // sets liveRenderDelayMs to 200 gets 300 and the setting looks broken.
    return Math.min(ceiling, Math.max(floorMs, Math.round(k * Number(lastMs))));
}

/**
 * How long to wait before the build that a build was queued BEHIND.
 *
 * The ordinary debounce is a ceiling on purpose: an 89-page paper should not
 * make the reader wait 17 s after they stop typing. But that same cap means a
 * paper which takes LONGER than the debounce spends most of its wall-clock
 * compiling — fire at 900 ms, run for 1.4 s, someone typed meanwhile, go round
 * again — and a latexmk running two thirds of the time is felt as the whole
 * machine being slow, which is how it was reported.
 *
 * So the FIRST pause after typing keeps the ceiling and stays responsive, and
 * only the round-again case backs off: wait at least as long as the last build
 * took, so the loop can never use more than about half the time. Capped,
 * because a paper that takes a minute must still come back eventually.
 *
 * @param {{lastMs?: number, ceilingMs?: number, maxMs?: number}} o
 */
function cooldownDelayMs({ lastMs, ceilingMs, maxMs = 5000 } = {}) {
    const ceiling = Number(ceilingMs) > 0 ? Number(ceilingMs) : 900;
    const last = Number(lastMs) > 0 ? Number(lastMs) : 0;
    if (!last) return ceiling;
    return Math.min(Math.max(maxMs, ceiling), Math.max(ceiling, Math.round(last)));
}

/**
 * Blend one compile time into the running estimate.
 *
 * A single slow build (a figure recompiled, a package loaded for the first
 * time) must not push the debounce to its ceiling for the rest of the session,
 * and a single fast one must not make it jumpy. An EWMA is the cheapest thing
 * that does both.
 */
function blendLiveMs(prev, sample, alpha = 0.4) {
    const s = Number(sample);
    if (!(s > 0)) return prev ?? null;
    if (prev == null || !(Number(prev) > 0)) return s;
    return Math.round((1 - alpha) * Number(prev) + alpha * s);
}

/**
 * Does this compile's PDF need to cross into the webview at all?
 *
 * pdfHash is a CONTENT hash (compileService.pdfContentHash), so it is not
 * fooled by /CreationDate moving on every run. When it matches what the webview
 * already holds, shipping would base64 the whole PDF, re-parse it in pdf.js,
 * repaint every visible canvas, sweep every page's text layer and throw away
 * every glyph alignment — to arrive at the pixels already on screen.
 *
 * Typing a comment, or editing a word that does not reflow its line, produces
 * exactly this case.
 */
function shipDecision({ force = false, shownGeneration = null, shownPdfHash = null, gen = null } = {}) {
    if (!gen) return { ship: false, reason: 'no generation' };
    if (force) return { ship: true, reason: 'forced' };
    if (!gen.pdfHash) return { ship: true, reason: 'no pdf hash' };
    if (shownGeneration != null && shownGeneration === gen.generation) {
        return { ship: false, reason: 'same generation' };
    }
    // A null shownPdfHash means nothing has ever been shipped to this webview
    // (a fresh or restored panel), and it must always get a document.
    if (shownPdfHash && shownPdfHash === gen.pdfHash) {
        return { ship: false, reason: 'identical pdf' };
    }
    return { ship: true, reason: 'new pdf' };
}

/**
 * Can the new generation reuse the previous generation's parsed .synctex?
 *
 * Both hashes must be present AND equal. Two generations that both failed to
 * produce a .synctex have null hashes, and "null equals null" must NOT be read
 * as "nothing changed" — there is no parse to reuse in that case.
 */
function synctexUnchanged(prevGen, gen) {
    if (!prevGen || !gen) return false;
    if (!prevGen.synctexHash || !gen.synctexHash) return false;
    return prevGen.synctexHash === gen.synctexHash;
}

/**
 * What latexmk's output says about a run we capped.
 *
 * $max_repeat is latexmk's infinite-loop guard. Set to 1, the first pass runs
 * normally and a REQUEST for a second trips it: latexmk warns "Maximum runs of
 * <rule> reached without getting stable files", sets its failure flag, and
 * returns — leaving the pass-1 PDF in place. That is the trade an editor wants:
 * the ink you just typed, now, with cross-references that may lag one pause.
 *
 * THE WARNING GOES TO STDERR (latexmk uses perl's warn), which is why both
 * streams are scanned. A detector that reads only stdout reports every capped
 * build as unlimited, and then nothing ever schedules the correction.
 *
 * `rcUnsupported` is the other outcome: our -e code did not even parse, so
 * latexmk stopped before compiling anything.
 */
function readPassLimit({ stdout = '', stderr = '', maxPasses = null } = {}) {
    const all = `${stdout}\n${stderr}`;
    const rcUnsupported = /Stopping because executing following code from command line/.test(all);
    const passesLimited = !!maxPasses &&
        /Maximum runs of .* reached|needed too many passes|Maximum runs reached/i.test(all);
    return { passesLimited, rcUnsupported };
}

/**
 * Is this generation good enough for the purpose asking?
 *
 * A one-pass build whose source snapshot still matches is genuinely current in
 * its INK, so the live loop is happy with it. A save is not: cross-references,
 * the table of contents and page numbers may be one pass behind, and the whole
 * point of the authoritative build is to converge them. Without this, the save
 * path saw a matching snapshot hash, said "already current", and did nothing —
 * leaving the paper capped for as long as the reader kept typing.
 */
function generationSatisfies(gen, { authoritative = false } = {}) {
    if (!gen) return false;
    if (!authoritative) return true;
    // TWO WAYS TO BE ONE PASS BEHIND. The cap biting is one; the other is a
    // build that ran to completion and still wrote a .aux nobody has read —
    // which is what a brand new \label does, and it prints `??` until then.
    return !gen.passesLimited && !gen.rerunWanted;
}

/**
 * How long after the last keystroke the full rebuild should run.
 *
 * It MUST be strictly later than the live rebuild it exists to correct, or the
 * two race for the same out dir on every pause. 0 disables it entirely (the
 * save path still corrects).
 */
function authoritativeDelayMs({ configuredMs = 4000, liveDelayMs = 900 } = {}) {
    const c = Number(configuredMs);
    if (!(c > 0)) return 0;
    return Math.max(c, Number(liveDelayMs || 0) + 1500);
}

module.exports = {
    FLOOR_MS,
    nextLiveDelayMs,
    cooldownDelayMs,
    blendLiveMs,
    shipDecision,
    synctexUnchanged,
    readPassLimit,
    generationSatisfies,
    authoritativeDelayMs,
};
