'use strict';
/**
 * Gold-suite verifier smoke — validates the WL verifier code of every task in
 * tests/suite.js against a LIVE wolframscript (no extension, no fairy, no LLM).
 *
 * For each task a scripted setup defines correct contract symbols (pass-path)
 * or deliberately wrong ones (fail-path: TS02/TS06/TS10, whose correct values
 * are expensive to construct), then runs the task's verifier and checks the
 * outcome. This catches WL syntax errors, convention drift between brief and
 * verifier, and bad reference computations — before any real (paid) fairy run.
 *
 * Run: node out/extension/oberon/tests/goldVerifiers.smoke.js
 * Skips with exit 0 when wolframscript is not available (house convention,
 * same as fairyPhase4.smoke.js).
 *
 * NOTE (WL gotcha, learned 2026-08-01): `Return[]` inside an inline Module
 * propagates OUT through enclosing Modules — verifiers must use Catch/Throw
 * for early exits. This smoke is what catches such regressions.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const gold  = require('./goldRunner');
const TASKS = require('./suite');

function findWolframscript() {
    const candidates = [
        'wolframscript',
        '/Applications/Wolfram 3.app/Contents/MacOS/wolframscript',
        '/Applications/Wolfram.app/Contents/MacOS/wolframscript',
        '/Applications/Wolfram 2.app/Contents/MacOS/wolframscript',
        '/Applications/Mathematica.app/Contents/MacOS/wolframscript',
    ];
    for (const c of candidates) {
        try {
            const r = spawnSync(c, ['-code', '1+1'], { timeout: 60000, encoding: 'utf8' });
            if (r.status === 0 && /2/.test(r.stdout || '')) return c;
        } catch (_) {}
    }
    return null;
}

// setup: WL defining the contract symbols; expect: 'pass' | 'fail'
const SMOKE = {
    TS01: { expect: 'pass', setup:
        'states = Tuples[Range[4], 4];' +
        'pos = AssociationThread[states -> Range[Length[states]]];' +
        'swap[s_, i_] := ReplacePart[s, {i -> s[[Mod[i, 4] + 1]], Mod[i, 4] + 1 -> s[[i]]}];' +
        'HH = Sum[SparseArray[Table[{pos[swap[s, i]], pos[s]} -> 1, {s, states}], {256, 256}], {i, 1, 4}];' +
        'evs = Sort[Eigenvalues[Normal[N[HH]]]];' +
        'goldResult = SortBy[Tally[Round[evs, 10^-6]], First];' },
    TS02: { expect: 'fail', setup:
        'goldResult = <|0 -> ConstantArray[0., 243], 1 -> {}, 2 -> {}, 3 -> {}, 4 -> {}|>;' },
    TS03: { expect: 'pass', setup:
        'sp = {{0, 1}, {0, 0}}; sm = {{0, 0}, {1, 0}}; sz = {{1/2, 0}, {0, -1/2}}; id2 = IdentityMatrix[2];' +
        'op[m_, i_] := KroneckerProduct @@ ReplacePart[ConstantArray[id2, 8], i -> m];' +
        'HH = Sum[Module[{j = Mod[i, 8] + 1}, (op[sp, i] . op[sm, j] + op[sm, i] . op[sp, j])/2 + op[sz, i] . op[sz, j] - IdentityMatrix[256]/4], {i, 1, 8}];' +
        'sel = 1 + Select[Range[0, 255], DigitCount[#, 2, 1] == 2 &];' +
        'goldResult = Sort[Eigenvalues[N[HH[[sel, sel]]]]]; goldBethe = goldResult;' },
    TS04: { expect: 'pass', setup:
        'goldResult = Table[Det[Table[1/(1 + i + j), {i, nn}, {j, nn}]], {nn, 2, 12}];' +
        'goldClosedForm = Function[n, Det[Table[1/(1 + i + j), {i, n}, {j, n}]]];' },
    TS05: { expect: 'pass', setup:
        'goldResult = Association[Table[nn -> (z /. NSolve[Sum[z^k/k!, {k, 0, nn}] == 0, z, WorkingPrecision -> 40]), {nn, {20, 40, 80}}]];' },
    TS06: { expect: 'fail', setup:
        'goldResult = {<|"T" -> (u + I/2)^4 + (u - I/2)^4, "Q" -> 1, "M" -> 0, "physical" -> True|>};' },
    TS07: { expect: 'pass', setup:
        'goldResult = <|50 -> <|"ksStatistic" -> 0.06, "meanSpacing" -> 1.02, "nSpacings" -> 49|>,' +
        ' 100 -> <|"ksStatistic" -> 0.05, "meanSpacing" -> 0.99, "nSpacings" -> 99|>,' +
        ' 200 -> <|"ksStatistic" -> 0.04, "meanSpacing" -> 1.0, "nSpacings" -> 199|>|>;' },
    TS08: { expect: 'pass', setup:
        'fdEigs[nn_] := Module[{LL = 10, h, xs, fd}, h = 2 LL/(nn + 1); xs = Table[-LL + i h, {i, nn}];' +
        ' fd = SparseArray[{Band[{1, 1}] -> 2/h^2 + xs^4, Band[{2, 1}] -> -1/h^2, Band[{1, 2}] -> -1/h^2}, {nn, nn}];' +
        ' Sort[Eigenvalues[N[Normal[fd]]]][[1 ;; 10]]];' +
        'e1 = fdEigs[1000]; e2 = fdEigs[2000];' +
        'goldResult = (4 e2 - e1)/3;' },
    TS09: { expect: 'pass', setup: 'goldResult = {{1, 1}, {5, 1}, {5, 1}, {9, 1}};' },
    TS10: { expect: 'fail', setup:
        'goldResult = {<|"Q" -> 1, "Qt" -> u^5, "M" -> 0, "physical" -> True|>};' },
    GT01: { expect: 'pass', setup: 'goldResult = Pi^4/15;' },
    GT02: { expect: 'pass', setup: 'goldResult = 2 - Pi^2/6;' },
    GT03: { expect: 'pass', setup: 'goldResult = -(Pi/2) Log[2];' },
    GT04: { expect: 'pass', setup: 'goldResult = Function[b, (Sqrt[Pi]/2) Exp[-b^2]];' },
    GT05: { expect: 'pass', setup: 'goldResult = SeriesCoefficient[Tan[x], {x, 0, 9}];' },
    GT06: { expect: 'pass', setup: 'goldResult = 6;' },
    GT07: { expect: 'pass', setup: 'goldResult = Pi^2/3 - 3;' },
    GT08: { expect: 'pass', setup:
        'yy = y /. First[DSolve[{y\'\'[t] + 4 y[t] == Sin[2 t], y[0] == 0, y\'[0] == 1}, y, t]];' +
        'goldResult = Function[x0, yy[x0]];' },
    GT09: { expect: 'pass', setup: 'goldResult = Function[x0, BesselJ[1, x0]/BesselJ[1, 1]];' },
    GT10: { expect: 'pass', setup:
        'sp = {{0, 1}, {0, 0}}; sm = {{0, 0}, {1, 0}}; sz = {{1/2, 0}, {0, -1/2}}; id2 = IdentityMatrix[2];' +
        'op[m_, i_] := KroneckerProduct @@ ReplacePart[ConstantArray[id2, 6], i -> m];' +
        'HH = Sum[Module[{j = Mod[i, 6] + 1}, (op[sp, i] . op[sm, j] + op[sm, i] . op[sp, j])/2 + op[sz, i] . op[sz, j] - IdentityMatrix[64]/4], {i, 1, 6}];' +
        'goldResult = Min[Eigenvalues[N[Normal[HH]]]];' },
    GT11: { expect: 'pass', setup:
        'goldResult = Sort[Eigenvalues[Normal[SparseArray[{Band[{1, 1}] -> 2, Band[{2, 1}] -> -1, Band[{1, 2}] -> -1}, {5, 5}]]]];' },
    GT12: { expect: 'pass', setup: 'goldResult = (1 + Sqrt[3])/Sqrt[2];' },
    GT13: { expect: 'pass', setup: 'goldResult = -E/2;' },
    GT14: { expect: 'pass', setup: 'goldResult = Fibonacci[100];' },
    GT15: { expect: 'pass', setup: 'goldResult = Subfactorial[12];' },
    // SU(1|1) chain family (2026-08-03): free-fermion rule with sector-dependent
    // boundary — periodic momenta for odd M, antiperiodic for even M.
    TS11: { expect: 'pass', setup:
        'ff[L_, M_] := Sort[N[Total[2 (1 - Cos[#]) & /@ #] & /@ Subsets[Table[2 Pi (n + Mod[M - 1, 2]/2)/L, {n, 0, L - 1}], {M}]]];' +
        'goldResult = ff[8, 3]; goldBethe = goldResult;' },
    TS12: { expect: 'pass', setup:
        'ff[L_, M_] := Sort[N[Total[2 (1 - Cos[#]) & /@ #] & /@ Subsets[Table[2 Pi (n + Mod[M - 1, 2]/2)/L, {n, 0, L - 1}], {M}]]];' +
        'goldResult = Sort[Flatten[Table[ff[6, M], {M, 0, 6}]]]; goldBethe = goldResult;' +
        'goldSingle = {-(2 + Sqrt[3])/2, (2 + Sqrt[3])/2};' },
    GT16: { expect: 'pass', setup: 'goldResult = {0, 1, 1, 3, 3, 4};' },
    GT17: { expect: 'pass', setup:
        'ff[L_, M_] := Sort[N[Total[2 (1 - Cos[#]) & /@ #] & /@ Subsets[Table[2 Pi (n + Mod[M - 1, 2]/2)/L, {n, 0, L - 1}], {M}]]];' +
        'goldResult = Sort[Flatten[Table[ff[4, M], {M, 0, 4}]]]; goldBethe = goldResult;' },
};

function wlTol(tol) {
    const [m, e] = tol.toExponential().split('e');
    return `(${m}*10^(${e}))`;
}

function buildScript() {
    let wl = gold.VERIFIER_PRELUDE + '\n';
    wl += 'WBSmoke`chk[id_, expect_, tol_, res_] := Print[id <> " " <> If[expect === "pass",\n' +
          ' If[res === True || (NumericQ[res] && Abs[N[res]] < tol), "OK", "BAD << " <> ToString[res, InputForm]],\n' +
          ' If[StringQ[res] && StringStartsQ[res, "FAIL"], "OKFAILPATH", "BAD(expected FAIL) << " <> ToString[res, InputForm]]]];\n';
    for (const t of TASKS) {
        const s = SMOKE[t.id];
        if (!s) { wl += `Print["${t.id} SKIPPED"];\n`; continue; }
        wl += 'ClearAll["Global`*"];\n';
        wl += `Module[{}, ${s.setup}\n` +
              `WBSmoke\`res = Quiet[Check[${t.verifier}, "FAILEVAL: " <> ToString[$MessageList]]];\n` +
              `WBSmoke\`chk["${t.id}", "${s.expect}", ${wlTol(t.tolerance || gold.DEFAULT_TOLERANCE)}, WBSmoke\`res]];\n`;
    }
    wl += 'Print["SMOKE DONE"];\n';
    return wl;
}

(function main() {
    const ws = findWolframscript();
    if (!ws) {
        console.log('goldVerifiers.smoke: wolframscript not found — skipping (exit 0).');
        process.exit(0);
    }
    const uncovered = TASKS.filter(t => !SMOKE[t.id]).map(t => t.id);
    if (uncovered.length) {
        console.error(`goldVerifiers.smoke: tasks without smoke coverage: ${uncovered.join(', ')}`);
        process.exit(1);
    }
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gold-smoke-')), 'gold-smoke.wls');
    fs.writeFileSync(file, buildScript(), 'utf8');
    console.log(`goldVerifiers.smoke: running ${TASKS.length} verifiers via ${ws} …`);
    let out = '';
    try {
        out = execFileSync(ws, ['-file', file], { timeout: 15 * 60 * 1000, encoding: 'utf8' });
    } catch (e) {
        console.error('wolframscript failed:', e.message);
        if (e.stdout) console.error(String(e.stdout).slice(-2000));
        process.exit(1);
    }
    process.stdout.write(out);
    const lines = out.split('\n').filter(Boolean);
    const bad = lines.filter(l => l.includes('BAD'));
    const done = lines.some(l => l.includes('SMOKE DONE'));
    const okCount = lines.filter(l => / OK$| OKFAILPATH$/.test(l)).length;
    if (!done || bad.length || okCount !== TASKS.length) {
        console.error(`\ngoldVerifiers.smoke: FAILED (${okCount}/${TASKS.length} ok, ${bad.length} bad, done=${done})`);
        process.exit(1);
    }
    console.log(`\ngoldVerifiers.smoke: all ${TASKS.length} verifiers ok.`);
})();
