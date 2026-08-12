'use strict';
/**
 * Oberon — gold task suite.
 *
 * 25 physics / mathematics research problems used to benchmark the pipeline
 * end-to-end (fairy quick-compute path).  Every entry carries a machine
 * verifier so grading is kernel-based, never LLM-based.
 *
 * Entry fields:
 *   id              — stable identifier (TS01…TS10 legacy, GT01…GT15 closed-form)
 *   title           — short display name
 *   category        — spectra | bethe | linalg | zeros | stats | rep-theory |
 *                     integral | series | ode | identity | combinatorics
 *   brief           — the exact brief dispatched to the fairy (goldRunner appends
 *                     the OUTPUT CONTRACT sentence derived from `contract`)
 *   contract        — what the clean notebook must define (prose, precise)
 *   contractSymbols — symbols the verifier requires to exist after replay
 *   validationChecks— cheap adjudicable WL checks handed to the run itself
 *                     (executed by run_clean; keep them shape-level, not answers)
 *   verifier        — WL code evaluated in a FRESH kernel AFTER replaying the
 *                     run's clean.wb.  Must evaluate to True (pass), a numeric
 *                     residual (pass iff |r| < tolerance), or a "FAIL: …" string.
 *                     May use the WBGold` helpers installed by goldRunner's
 *                     VERIFIER_PRELUDE.  Verifiers recompute reference values by
 *                     an independent method wherever feasible.
 *   verify          — 'full'    = verifier fully adjudicates correctness
 *                     'partial' = verifier checks necessary conditions only
 *                     'manual'  = sanity checks only; human review advised
 *   tolerance       — |residual| threshold (default 1e-6, set per task)
 *
 * Convention notes (deliberate, do not weaken):
 *  - Briefs pin Hamiltonian/relation conventions explicitly, so verifier and
 *    agent cannot disagree by convention. TS03/TS06/TS10 briefs were re-pinned
 *    2026-08-01 when verifiers were added (the old TS06 relation as stated was
 *    degree-inconsistent and had no polynomial solutions).
 */

module.exports = [
    // ────────────────────────────────────────────────────────────────────
    // TS — legacy research-grade tasks (now contract + verifier bearing)
    // ────────────────────────────────────────────────────────────────────
    {
        id: 'TS01',
        title: 'SU(4) spin chain spectrum L=4',
        category: 'spectra',
        verify: 'full',
        tolerance: 1e-6,
        brief:
            'Compute the full energy spectrum of the SU(4) fundamental-representation spin chain at ' +
            'length L=4 (Hilbert space dimension 4^4 = 256) by exact diagonalisation of the nearest-' +
            'neighbour Hamiltonian H = Sum_{i=1}^{4} P_{i,i+1} (sum of permutation operators, periodic ' +
            'boundary conditions, site 5 = site 1). List every distinct eigenvalue together with its ' +
            'degeneracy.',
        contract:
            'define goldResult as the list of {eigenvalue, degeneracy} pairs (eigenvalue exact or ' +
            'numeric to at least 8 digits, degeneracies positive integers summing to 256), sorted by ' +
            'increasing eigenvalue.',
        contractSymbols: ['goldResult'],
        validationChecks: [
            'Head[goldResult] === List',
            'Total[goldResult[[All, 2]]] == 256',
        ],
        verifier:
            'Module[{L = 4, n = 4, states, pos, swap, H, ref, got},' +
            ' states = Tuples[Range[n], L];' +
            ' pos = AssociationThread[states -> Range[Length[states]]];' +
            ' swap[s_, i_] := ReplacePart[s, {i -> s[[Mod[i, L] + 1]], Mod[i, L] + 1 -> s[[i]]}];' +
            ' H = Sum[SparseArray[Table[{pos[swap[s, i]], pos[s]} -> 1, {s, states}], {n^L, n^L}], {i, 1, L}];' +
            ' ref = Sort[Eigenvalues[Normal[N[H]]]];' +
            ' got = Sort[N[Flatten[Table[ConstantArray[p[[1]], p[[2]]], {p, goldResult}]]]];' +
            ' WBGold`listDiff[got, ref]]',
    },
    {
        id: 'TS02',
        title: 'SU(3) spin chain translation sectors L=5',
        category: 'spectra',
        verify: 'full',
        tolerance: 1e-6,
        brief:
            'For the SU(3) fundamental-representation spin chain at length L=5 (dimension 3^5 = 243), ' +
            'block-diagonalise the nearest-neighbour Hamiltonian H = Sum_{i=1}^{5} P_{i,i+1} ' +
            '(permutation operators, periodic BC) by lattice momentum k = 2 Pi n/5, n = 0,1,2,3,4. ' +
            'Compute the energy spectrum in each momentum sector separately.',
        contract:
            'define goldResult as an Association n -> sorted list of that momentum sector\'s energies ' +
            '(numeric, at least 8 digits), for n = 0,1,2,3,4; sector list lengths must total 243.',
        contractSymbols: ['goldResult'],
        validationChecks: [
            'Head[goldResult] === Association',
            'Total[Length /@ Values[goldResult]] == 243',
        ],
        verifier:
            'Catch[Module[{L = 5, n = 3, states, pos, swap, H, ref, dims, got, all},' +
            ' states = Tuples[Range[n], L];' +
            ' pos = AssociationThread[states -> Range[Length[states]]];' +
            ' swap[s_, i_] := ReplacePart[s, {i -> s[[Mod[i, L] + 1]], Mod[i, L] + 1 -> s[[i]]}];' +
            ' H = Sum[SparseArray[Table[{pos[swap[s, i]], pos[s]} -> 1, {s, states}], {n^L, n^L}], {i, 1, L}];' +
            ' ref = Sort[Eigenvalues[Normal[N[H]]]];' +
            ' dims = Sort[Length /@ Values[goldResult]];' +
            ' If[dims =!= {48, 48, 48, 48, 51}, Throw["FAIL: sector dimensions " <> ToString[dims] <> " != {48,48,48,48,51}"]];' +
            ' all = Sort[N[Flatten[Values[goldResult]]]];' +
            ' WBGold`listDiff[all, ref]]]',
    },
    {
        id: 'TS03',
        title: 'XXX Heisenberg vs exact diagonalisation L=8 two-magnon',
        category: 'bethe',
        verify: 'full',
        tolerance: 1e-6,
        brief:
            'For the XXX spin-1/2 Heisenberg chain at L=8 with periodic boundary conditions and ' +
            'Hamiltonian H = Sum_{i=1}^{8} (Svec_i . Svec_{i+1} - 1/4)  (so the ferromagnetic vacuum ' +
            'has E = 0; site 9 = site 1), compute the two-magnon sector energies (i) from the Bethe ' +
            'ansatz equations, and (ii) by exact diagonalisation of the two-down-spin subspace ' +
            '(dimension 28). List both sets of eigenvalues and verify that the Bethe ansatz ' +
            'reproduces the exact spectrum.',
        contract:
            'define goldResult as the sorted list of all 28 two-magnon-sector energies (numeric, at ' +
            'least 8 digits) obtained by exact diagonalisation, and goldBethe as the sorted list of ' +
            'the same energies obtained from the Bethe ansatz.',
        contractSymbols: ['goldResult', 'goldBethe'],
        validationChecks: [
            'Length[goldResult] == 28',
            'Max[Abs[Sort[N[goldResult]] - Sort[N[goldBethe]]]] < 10^-6',
        ],
        verifier:
            'Module[{L = 8, sp, sm, sz, id2, op, H, basis, sel, sub, ref, got},' +
            ' sp = {{0, 1}, {0, 0}}; sm = {{0, 0}, {1, 0}}; sz = {{1/2, 0}, {0, -1/2}}; id2 = IdentityMatrix[2];' +
            ' op[m_, i_] := KroneckerProduct @@ ReplacePart[ConstantArray[id2, L], i -> m];' +
            ' H = Sum[Module[{j = Mod[i, L] + 1},' +
            '   (op[sp, i] . op[sm, j] + op[sm, i] . op[sp, j])/2 + op[sz, i] . op[sz, j] - IdentityMatrix[2^L]/4],' +
            '  {i, 1, L}];' +
            ' basis = Range[0, 2^L - 1];' +
            ' sel = 1 + Select[basis, DigitCount[#, 2, 1] == 2 &];' +
            ' sub = N[H[[sel, sel]]];' +
            ' ref = Sort[Eigenvalues[sub]];' +
            ' got = Sort[N[goldResult]];' +
            ' WBGold`listDiff[got, ref]]',
    },
    {
        id: 'TS04',
        title: 'Cauchy-like matrix determinant pattern',
        category: 'linalg',
        verify: 'full',
        brief:
            'Define the n x n matrix A with entries A_{ij} = 1/(1+i+j) for i,j = 1…n. ' +
            'Compute det(A) exactly (as a rational number) for n = 2 through 12, identify the ' +
            'closed form, and verify the conjecture for n = 15 and n = 20.',
        contract:
            'define goldResult as the list of the 11 exact determinants for n = 2…12 (exact rationals, ' +
            'in order of increasing n), and goldClosedForm as a pure function such that ' +
            'goldClosedForm[n] equals det(A) exactly for every n tested.',
        contractSymbols: ['goldResult', 'goldClosedForm'],
        validationChecks: [
            'Length[goldResult] == 11',
            'goldResult[[1]] === Det[Table[1/(1 + i + j), {i, 2}, {j, 2}]]',
        ],
        verifier:
            'Catch[Module[{ref, cf15},' +
            ' ref = Table[Det[Table[1/(1 + i + j), {i, nn}, {j, nn}]], {nn, 2, 12}];' +
            ' If[goldResult =!= ref, Throw["FAIL: determinant list mismatch"]];' +
            ' cf15 = Det[Table[1/(1 + i + j), {i, 15}, {j, 15}]];' +
            ' If[Simplify[goldClosedForm[15] - cf15] =!= 0, Throw["FAIL: closed form wrong at n=15"]];' +
            ' True]]',
    },
    {
        id: 'TS05',
        title: 'Zeros of truncated exponential sum',
        category: 'zeros',
        verify: 'full',
        tolerance: 1e-4,
        brief:
            'Compute all zeros (in the complex plane) of the truncated exponential polynomial ' +
            'P_N(z) = Sum_{k=0}^{N} z^k / k! for N = 20, 40, and 80. Describe the distribution ' +
            'of the zeros and state the limiting-shape conjecture (Szego curve) as N -> infinity.',
        contract:
            'define goldResult as an Association N -> list of the N complex zeros (numeric, at least ' +
            '10 correct digits) for N = 20, 40, 80.',
        contractSymbols: ['goldResult'],
        validationChecks: [
            'Sort[Keys[goldResult]] == {20, 40, 80}',
            'Length[goldResult[80]] == 80',
        ],
        verifier:
            'Module[{bad = {}},' +
            ' Do[Module[{ref, got},' +
            '   ref = z /. NSolve[Sum[z^k/k!, {k, 0, nn}] == 0, z, WorkingPrecision -> 40];' +
            '   got = goldResult[nn];' +
            '   If[Length[got] =!= nn, AppendTo[bad, {nn, "count"}],' +
            '     If[WBGold`listDiff[N[got], N[ref]] > 10^-4, AppendTo[bad, {nn, "values"}]]];' +
            '  ], {nn, {20, 40, 80}}];' +
            ' If[bad === {}, True, "FAIL: " <> ToString[bad]]]',
    },
    {
        id: 'TS06',
        title: 'Baxter TQ polynomial solutions L=4',
        category: 'bethe',
        verify: 'partial',
        brief:
            'For the XXX spin-1/2 Heisenberg chain at L=4, find all polynomial solutions Q(u) of the ' +
            'Baxter TQ relation  T(u) Q(u) = (u + I/2)^4 Q(u - I) + (u - I/2)^4 Q(u + I),  where T(u) ' +
            'is a degree-4 polynomial with leading coefficient 2 and Q(u) is monic of degree M <= 2 ' +
            '(M = number of Bethe roots; only highest-weight sectors M = 0, 1, 2 are required). ' +
            'Classify the distinct (T, Q) solution branches, including the singular/exceptional M=2 ' +
            'solution, and identify which branches correspond to physical eigenstates of the L=4 chain.',
        contract:
            'define goldResult as the list of solution branches, each an Association with keys "T" ' +
            '(the polynomial T(u) in the variable u), "Q" (the monic polynomial Q(u) in u), "M" ' +
            '(degree of Q), and "physical" (True|False). All physical highest-weight branches ' +
            '(there are 6 for L=4: one M=0, three M=1, two M=2) must be present.',
        contractSymbols: ['goldResult'],
        validationChecks: [
            'Head[goldResult] === List',
            'Length[goldResult] >= 6',
        ],
        verifier:
            'Block[{u}, Catch[Module[{res, phys},' +
            ' res = Table[Module[{T = b["T"], Q = b["Q"], r},' +
            '   r = Expand[T*Q - (u + I/2)^4 (Q /. u -> u - I) - (u - I/2)^4 (Q /. u -> u + I)];' +
            '   {Simplify[r] === 0, Exponent[Q, u] === b["M"], Exponent[T, u] === 4}], {b, goldResult}];' +
            ' If[!AllTrue[Flatten[res], TrueQ], Throw["FAIL: some branch violates the TQ relation or degree bounds"]];' +
            ' phys = Count[goldResult, b_ /; TrueQ[b["physical"]]];' +
            ' If[phys =!= 6, Throw["FAIL: physical branch count " <> ToString[phys] <> " != 6"]];' +
            ' True]]]',
    },
    {
        id: 'TS07',
        title: 'GUE random matrix nearest-neighbour statistics',
        category: 'stats',
        verify: 'manual',
        brief:
            'Generate GUE (Gaussian Unitary Ensemble) random matrices of sizes N = 50, 100, and 200. ' +
            'Unfold the spectra using the local mean level spacing. Compute the nearest-neighbour ' +
            'spacing distribution and compare it quantitatively with the Wigner surmise ' +
            'p(s) = (Pi/2) s Exp[-Pi s^2/4] using a Kolmogorov-Smirnov test and a chi-squared test.',
        contract:
            'define goldResult as an Association N -> Association with keys "ksStatistic" (the KS ' +
            'distance between the empirical unfolded spacing distribution and the Wigner surmise), ' +
            '"meanSpacing" (mean unfolded spacing, should be ~1), and "nSpacings" (sample count), ' +
            'for N = 50, 100, 200.',
        contractSymbols: ['goldResult'],
        validationChecks: [
            'Sort[Keys[goldResult]] == {50, 100, 200}',
        ],
        verifier:
            'Module[{bad = {}},' +
            ' Do[Module[{r = goldResult[nn]},' +
            '   If[!(0 < r["ksStatistic"] < 0.25), AppendTo[bad, {nn, "ks", r["ksStatistic"]}]];' +
            '   If[Abs[r["meanSpacing"] - 1] > 0.15, AppendTo[bad, {nn, "mean", r["meanSpacing"]}]];' +
            '   If[r["nSpacings"] < nn - 2, AppendTo[bad, {nn, "count", r["nSpacings"]}]];' +
            '  ], {nn, {50, 100, 200}}];' +
            ' If[bad === {}, True, "FAIL: " <> ToString[bad]]]',
    },
    {
        id: 'TS08',
        title: 'Anharmonic oscillator eigenvalues',
        category: 'ode',
        verify: 'full',
        tolerance: 0.02,
        brief:
            'Find the lowest 10 eigenvalues of the anharmonic oscillator -f\'\'(x) + x^4 f(x) = E f(x) ' +
            'on the real line by discretising on the interval [-10, 10] with a second-order finite-' +
            'difference method at N = 500, 1000, and 2000 uniformly spaced grid points. The FD error ' +
            'is O(h^2): use Richardson extrapolation in the grid spacing across the N values to ' +
            'obtain converged eigenvalues, and verify convergence (the extrapolated values should be ' +
            'stable to ~1e-3 or better; the ground state is near 1.0604).',
        contract:
            'define goldResult as the sorted list of the 10 lowest converged eigenvalues (numeric, ' +
            'accurate to at least 3 significant digits; the ground state is E0 = 1.06036…).',
        contractSymbols: ['goldResult'],
        validationChecks: [
            'Length[goldResult] == 10',
            'Abs[goldResult[[1]] - 1.0604] < 0.01',
        ],
        // Reference by an INDEPENDENT method: Hermite (harmonic-oscillator) basis
        // truncation, spectrally convergent — nb=120 gives the 10 lowest levels of
        // p^2 + x^4 to far better than the 0.02 gate.
        verifier:
            'Module[{nb = 120, a, at, xm, p2, H, ref, got},' +
            ' a = Normal[SparseArray[Table[{m, m + 1} -> Sqrt[m], {m, nb - 1}], {nb, nb}]];' +
            ' at = Transpose[a];' +
            ' xm = (a + at)/Sqrt[2]; p2 = -(at - a) . (at - a)/2;' +
            ' H = p2 + MatrixPower[xm, 4];' +
            ' ref = Sort[Eigenvalues[N[H]]][[1 ;; 10]];' +
            ' got = Sort[N[goldResult]];' +
            ' WBGold`listDiff[got, ref]]',
    },
    {
        id: 'TS09',
        title: 'S_6 permutation representation on 3-subsets',
        category: 'rep-theory',
        verify: 'full',
        brief:
            'Construct the 20-dimensional permutation representation of S_6 acting on the set of ' +
            '3-element subsets of {1,…,6}. Decompose it into irreducible representations using ' +
            'character theory and list each irreducible constituent with its dimension and multiplicity.',
        contract:
            'define goldResult as the sorted list of {dimension, multiplicity} pairs of the ' +
            'irreducible constituents (one pair per distinct irrep).',
        contractSymbols: ['goldResult'],
        validationChecks: [
            'Total[Times @@@ goldResult] == 20',
        ],
        verifier:
            'Catch[Module[{subs, chi, g, gs, normSq, trivIP, dims},' +
            ' subs = Subsets[Range[6], {3}];' +
            ' gs = GroupElements[SymmetricGroup[6]];' +
            ' chi = Table[Count[subs, s_ /; Sort[PermutationReplace[s, g]] === s], {g, gs}];' +
            ' normSq = Total[chi^2]/Length[gs];' +
            ' trivIP = Total[chi]/Length[gs];' +
            ' If[normSq =!= 4 || trivIP =!= 1, Throw["FAIL: internal character check"]];' +
            ' If[Sort[goldResult[[All, 2]]] =!= {1, 1, 1, 1}, Throw["FAIL: multiplicities " <> ToString[goldResult] <> " (char norm^2 = 4 forces four multiplicity-1 constituents)"]];' +
            ' dims = Sort[goldResult[[All, 1]]];' +
            ' If[dims =!= {1, 5, 5, 9}, Throw["FAIL: dimensions " <> ToString[dims] <> " != {1,5,5,9}"]];' +
            ' True]]',
    },
    {
        id: 'TS10',
        title: 'QQ-system (Wronskian) bootstrap for XXX L=4',
        category: 'bethe',
        verify: 'partial',
        brief:
            'For the SU(2) XXX spin-1/2 chain at L=4, solve the QQ-relation (Wronskian) system: find ' +
            'pairs of polynomials Q(u) (monic, degree M) and Qt(u) (monic, degree 5-M) satisfying ' +
            'Q(u + I/2) Qt(u - I/2) - Q(u - I/2) Qt(u + I/2) = c u^4 for a nonzero constant c, for ' +
            'the highest-weight sectors M = 0, 1, 2. Classify all solution branches (including the ' +
            'singular/exceptional M=2 branch) and identify which correspond to physical eigenstates.',
        contract:
            'define goldResult as the list of solution branches, each an Association with keys "Q" ' +
            '(monic polynomial in u, degree M), "Qt" (monic polynomial in u, degree 5-M), "M", and ' +
            '"physical" (True|False). All 6 physical highest-weight branches must be present.',
        contractSymbols: ['goldResult'],
        validationChecks: [
            'Head[goldResult] === List',
            'Length[goldResult] >= 6',
        ],
        verifier:
            'Block[{u}, Catch[Module[{ok, phys},' +
            ' ok = Table[Module[{Q = b["Q"], Qt = b["Qt"], w, cl},' +
            '   w = Expand[(Q /. u -> u + I/2) (Qt /. u -> u - I/2) - (Q /. u -> u - I/2) (Qt /. u -> u + I/2)];' +
            '   cl = CoefficientList[w, u];' +
            '   {Exponent[Q, u] === b["M"], Exponent[Qt, u] === 5 - b["M"],' +
            '    Length[cl] == 5 && AllTrue[Most[cl], Simplify[#] === 0 &] && Simplify[Last[cl]] =!= 0}], {b, goldResult}];' +
            ' If[!AllTrue[Flatten[ok], TrueQ], Throw["FAIL: some branch violates the Wronskian relation or degrees"]];' +
            ' phys = Count[goldResult, b_ /; TrueQ[b["physical"]]];' +
            ' If[phys =!= 6, Throw["FAIL: physical branch count " <> ToString[phys] <> " != 6"]];' +
            ' True]]]',
    },
    {
        id: 'TS11',
        title: 'SU(1|1) chain L=8 three-particle sector: BAE vs exact diagonalisation',
        category: 'bethe',
        verify: 'full',
        tolerance: 1e-6,
        brief:
            'The integrable su(1|1) spin chain of length L has Hamiltonian H = Sum_{i=1}^{L} ' +
            '(I - Pg_{i,i+1}) with periodic boundaries (site L+1 = site 1), where Pg is the GRADED ' +
            'permutation on C^{1|1} (x) C^{1|1}: in the two-site basis {bb, bf, fb, ff} ' +
            '(b = boson = spin-up, f = fermion = spin-down) it is the 4x4 matrix ' +
            'Pg = {{1,0,0,0},{0,0,1,0},{0,1,0,0},{0,0,0,-1}}. The fermion number M is conserved. ' +
            'For L=8, compute the M=3 sector spectrum (dimension 56) two ways: (i) by exact ' +
            'diagonalisation, and (ii) from the Bethe ansatz for this chain — derive or look up the ' +
            'su(1|1) Bethe equations ((u_j + I/2)/(u_j - I/2))^L = (-1)^(M-1) (magnon energy ' +
            '1/(u^2+1/4), i.e. 2(1-cos k) with u = (1/2) Cot[k/2]) and enumerate all 56 states, ' +
            'taking care of the zero-energy mode k = 0 (rapidity at infinity). Verify the two agree.',
        contract:
            'define goldResult as the sorted list of all 56 M=3 sector energies (numeric, at least ' +
            '8 digits) from exact diagonalisation, and goldBethe as the sorted list of the same 56 ' +
            'energies obtained from the Bethe ansatz enumeration.',
        contractSymbols: ['goldResult', 'goldBethe'],
        validationChecks: [
            'Length[goldResult] == 56',
            'Max[Abs[Sort[N[goldResult]] - Sort[N[goldBethe]]]] < 10^-6',
        ],
        verifier:
            'Module[{L = 8, ebb, ebf, efb, eff, op, pg, H, sel, ref, got},' +
            ' ebb = {{1,0},{0,0}}; ebf = {{0,1},{0,0}}; efb = {{0,0},{1,0}}; eff = {{0,0},{0,1}};' +
            ' op[m_, i_] := KroneckerProduct @@ ReplacePart[ConstantArray[IdentityMatrix[2], L], i -> m];' +
            ' pg[i_, j_] := op[ebb,i].op[ebb,j] + op[ebf,i].op[efb,j] + op[efb,i].op[ebf,j] - op[eff,i].op[eff,j];' +
            ' H = Sum[IdentityMatrix[2^L] - pg[i, Mod[i, L] + 1], {i, 1, L}];' +
            ' sel = 1 + Select[Range[0, 2^L - 1], DigitCount[#, 2, 1] == 3 &];' +
            ' ref = Sort[Eigenvalues[N[H[[sel, sel]]]]];' +
            ' got = Sort[N[goldResult]];' +
            ' WBGold`listDiff[got, ref]]',
    },
    {
        id: 'TS12',
        title: 'SU(1|1) chain L=6 full spectrum: graded Bethe ansatz across all sectors',
        category: 'bethe',
        verify: 'full',
        tolerance: 1e-6,
        brief:
            'For the su(1|1) chain of length L=6 (Hamiltonian H = Sum_{i=1}^{6} (I - Pg_{i,i+1}), ' +
            'periodic, with the graded permutation Pg = {{1,0,0,0},{0,0,1,0},{0,1,0,0},{0,0,0,-1}} ' +
            'in the two-site basis {bb, bf, fb, ff}), reconstruct the FULL 64-state spectrum from ' +
            'the Bethe ansatz and verify it against exact diagonalisation. Derive the su(1|1) Bethe ' +
            'equations from the graded algebraic Bethe ansatz or a Baxter T-Q argument; the key ' +
            'structural facts to establish are that the two-particle S-matrix is a pure sign ' +
            '(S = -1, free fermions), so the equations are ((u_j + I/2)/(u_j - I/2))^L = (-1)^(M-1) ' +
            '— sector-dependent boundary: momenta are periodic for odd fermion number M and ' +
            'ANTIPERIODIC for even M — and that each sector M contributes Binomial[L, M] states as ' +
            'sums of M distinct mode energies. Also give the exact rapidity pair of the lowest-energy ' +
            'M=2 state.',
        contract:
            'define goldResult as the sorted list of all 64 energies (numeric, at least 8 digits) ' +
            'from exact diagonalisation of the full 2^6-dimensional H, goldBethe as the sorted list ' +
            'of the same 64 energies from the Bethe ansatz enumeration over all sectors M = 0..6, ' +
            'and goldSingle as the exact rapidity pair {u1, u2} (exact, not numeric) of the ' +
            'lowest-energy M=2 state.',
        contractSymbols: ['goldResult', 'goldBethe', 'goldSingle'],
        validationChecks: [
            'Length[goldResult] == 64',
            'Max[Abs[Sort[N[goldResult]] - Sort[N[goldBethe]]]] < 10^-6',
            'Length[goldSingle] == 2',
        ],
        verifier:
            'Catch[Module[{L = 6, ebb, ebf, efb, eff, op, pg, H, ref, got, us, ee},' +
            ' ebb = {{1,0},{0,0}}; ebf = {{0,1},{0,0}}; efb = {{0,0},{1,0}}; eff = {{0,0},{0,1}};' +
            ' op[m_, i_] := KroneckerProduct @@ ReplacePart[ConstantArray[IdentityMatrix[2], L], i -> m];' +
            ' pg[i_, j_] := op[ebb,i].op[ebb,j] + op[ebf,i].op[efb,j] + op[efb,i].op[ebf,j] - op[eff,i].op[eff,j];' +
            ' H = Sum[IdentityMatrix[2^L] - pg[i, Mod[i, L] + 1], {i, 1, L}];' +
            ' ref = Sort[Eigenvalues[N[H]]];' +
            ' got = Sort[N[goldResult]];' +
            ' If[WBGold`listDiff[got, ref] > 10^-6, Throw["FAIL: goldResult does not match the ED spectrum"]];' +
            ' us = Sort[N[goldSingle]];' +
            ' If[WBGold`listDiff[us, N[{-(2 + Sqrt[3])/2, (2 + Sqrt[3])/2}]] > 10^-8,' +
            '  Throw["FAIL: goldSingle is not the rapidity pair {-(2+Sqrt[3])/2, (2+Sqrt[3])/2}"]];' +
            ' ee = Simplify[Total[1/(goldSingle^2 + 1/4)] - (4 - 2 Sqrt[3])];' +
            ' If[ee =!= 0, Throw["FAIL: goldSingle energy is not exactly 4 - 2 Sqrt[3]"]];' +
            ' True]]',
    },

    // ────────────────────────────────────────────────────────────────────
    // GT — closed-form gold tasks (cheap, binary, mostly full-verified)
    // ────────────────────────────────────────────────────────────────────
    {
        id: 'GT01',
        title: 'Bose integral x^3/(e^x - 1)',
        category: 'integral',
        verify: 'full',
        brief:
            'Evaluate the definite integral Integrate[x^3/(Exp[x] - 1), {x, 0, Infinity}] in closed ' +
            'form and verify the result numerically to at least 20 digits.',
        contract: 'define goldResult as the exact closed-form value.',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult]]'],
        verifier:
            'If[Simplify[goldResult - Pi^4/15] === 0, True,' +
            ' Abs[N[goldResult, 30] - N[Pi^4/15, 30]]]',
    },
    {
        id: 'GT02',
        title: 'Integral of Log[x] Log[1-x]',
        category: 'integral',
        verify: 'full',
        brief:
            'Evaluate Integrate[Log[x] Log[1 - x], {x, 0, 1}] in closed form and verify numerically.',
        contract: 'define goldResult as the exact closed-form value.',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult]]'],
        verifier:
            'If[Simplify[goldResult - (2 - Pi^2/6)] === 0, True,' +
            ' Abs[N[goldResult, 30] - N[2 - Pi^2/6, 30]]]',
    },
    {
        id: 'GT03',
        title: 'Log-sine integral',
        category: 'integral',
        verify: 'full',
        brief:
            'Evaluate Integrate[Log[Sin[x]], {x, 0, Pi/2}] in closed form and verify numerically.',
        contract: 'define goldResult as the exact closed-form value.',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult]]'],
        verifier:
            'If[Simplify[goldResult + (Pi/2) Log[2]] === 0, True,' +
            ' Abs[N[goldResult, 30] + N[(Pi/2) Log[2], 30]]]',
    },
    {
        id: 'GT04',
        title: 'Gaussian cosine integral with parameter',
        category: 'integral',
        verify: 'full',
        tolerance: 1e-20,
        brief:
            'Evaluate Integrate[Exp[-x^2] Cos[2 b x], {x, 0, Infinity}] in closed form as a function ' +
            'of the real parameter b, and verify the result numerically for several values of b.',
        contract:
            'define goldResult as a pure function of b giving the exact closed form (so goldResult[b] ' +
            'is the value for parameter b).',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult[1]]]'],
        verifier:
            'Module[{bs = {1/3, 7/5, 3}, r},' +
            ' r = Max[Table[Abs[N[goldResult[b], 30] - N[(Sqrt[Pi]/2) Exp[-b^2], 30]], {b, bs}]];' +
            ' r]',
    },
    {
        id: 'GT05',
        title: 'Taylor coefficient of Tan',
        category: 'series',
        verify: 'full',
        brief:
            'Compute the coefficient of x^9 in the Taylor expansion of Tan[x] about x = 0, exactly, ' +
            'and relate it to Bernoulli numbers.',
        contract: 'define goldResult as the exact rational coefficient.',
        contractSymbols: ['goldResult'],
        validationChecks: ['Head[goldResult] === Rational || IntegerQ[goldResult]'],
        verifier: 'If[goldResult === SeriesCoefficient[Tan[x], {x, 0, 9}], True, "FAIL: expected " <> ToString[SeriesCoefficient[Tan[x], {x, 0, 9}], InputForm]]',
    },
    {
        id: 'GT06',
        title: 'Sum n^2/2^n',
        category: 'series',
        verify: 'full',
        brief: 'Evaluate Sum[n^2/2^n, {n, 1, Infinity}] exactly, deriving the value (not just quoting it).',
        contract: 'define goldResult as the exact value.',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult]]'],
        verifier: 'If[Simplify[goldResult - 6] === 0, True, Abs[N[goldResult, 30] - 6]]',
    },
    {
        id: 'GT07',
        title: 'Sum 1/(n^2 (n+1)^2)',
        category: 'series',
        verify: 'full',
        brief:
            'Evaluate Sum[1/(n^2 (n + 1)^2), {n, 1, Infinity}] exactly via partial fractions, and ' +
            'verify numerically.',
        contract: 'define goldResult as the exact closed-form value.',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult]]'],
        verifier:
            'If[Simplify[goldResult - (Pi^2/3 - 3)] === 0, True,' +
            ' Abs[N[goldResult, 30] - N[Pi^2/3 - 3, 30]]]',
    },
    {
        id: 'GT08',
        title: 'Resonantly forced oscillator ODE',
        category: 'ode',
        verify: 'full',
        tolerance: 1e-10,
        brief:
            'Solve the initial value problem y\'\'[x] + 4 y[x] == Sin[2 x], y[0] == 0, y\'[0] == 1 ' +
            'in closed form (note the resonance) and verify by substitution.',
        contract:
            'define goldResult as a pure function such that goldResult[x] is the solution y(x).',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult[1]]]'],
        verifier:
            'Module[{ref, xs = {1/2, 13/7, 3}, r},' +
            ' ref = y /. First[DSolve[{y\'\'[x] + 4 y[x] == Sin[2 x], y[0] == 0, y\'[0] == 1}, y, x]];' +
            ' r = Max[Table[Abs[N[goldResult[x0], 25] - N[ref[x0], 25]], {x0, xs}]];' +
            ' r]',
    },
    {
        id: 'GT09',
        title: 'Bessel boundary value problem',
        category: 'ode',
        verify: 'full',
        tolerance: 1e-10,
        brief:
            'Find the solution of x^2 y\'\'[x] + x y\'[x] + (x^2 - 1) y[x] == 0 that is bounded at ' +
            'x = 0 and satisfies y[1] == 1, in closed form.',
        contract:
            'define goldResult as a pure function such that goldResult[x] is the solution y(x).',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult[1/2]]]'],
        verifier:
            'Module[{xs = {1/5, 1/2, 17/10}, r},' +
            ' r = Max[Table[Abs[N[goldResult[x0], 25] - N[BesselJ[1, x0]/BesselJ[1, 1], 25]], {x0, xs}]];' +
            ' r]',
    },
    {
        id: 'GT10',
        title: 'XXX L=6 ground-state energy',
        category: 'spectra',
        verify: 'full',
        tolerance: 1e-8,
        brief:
            'For the XXX spin-1/2 Heisenberg chain at L=6 with periodic boundary conditions and ' +
            'Hamiltonian H = Sum_{i=1}^{6} (Svec_i . Svec_{i+1} - 1/4) (site 7 = site 1), compute ' +
            'the ground-state energy by exact diagonalisation, to at least 10 digits.',
        contract: 'define goldResult as the ground-state energy (exact or numeric to >= 10 digits).',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult]]', 'N[goldResult] < -2'],
        verifier:
            'Module[{L = 6, sp, sm, sz, id2, op, H, ref},' +
            ' sp = {{0, 1}, {0, 0}}; sm = {{0, 0}, {1, 0}}; sz = {{1/2, 0}, {0, -1/2}}; id2 = IdentityMatrix[2];' +
            ' op[m_, i_] := KroneckerProduct @@ ReplacePart[ConstantArray[id2, L], i -> m];' +
            ' H = Sum[Module[{j = Mod[i, L] + 1},' +
            '   (op[sp, i] . op[sm, j] + op[sm, i] . op[sp, j])/2 + op[sz, i] . op[sz, j] - IdentityMatrix[2^L]/4],' +
            '  {i, 1, L}];' +
            ' ref = Min[Eigenvalues[N[Normal[H]]]];' +
            ' Abs[N[goldResult] - ref]]',
    },
    {
        id: 'GT11',
        title: 'Tridiagonal Toeplitz eigenvalues',
        category: 'linalg',
        verify: 'full',
        brief:
            'Compute, in exact closed form, all eigenvalues of the 5 x 5 tridiagonal matrix with 2 on ' +
            'the diagonal and -1 on the sub- and super-diagonals, and state the general-n formula.',
        contract:
            'define goldResult as the sorted list of the 5 exact eigenvalues.',
        contractSymbols: ['goldResult'],
        validationChecks: ['Length[goldResult] == 5'],
        verifier:
            'Module[{ref},' +
            ' ref = Sort[Eigenvalues[SparseArray[{Band[{1, 1}] -> 2, Band[{2, 1}] -> -1, Band[{1, 2}] -> -1}, {5, 5}] // Normal]];' +
            ' If[Simplify[Sort[goldResult] - ref] === ConstantArray[0, 5] || Simplify[Total[Abs[Sort[goldResult] - ref]]] === 0, True,' +
            '  WBGold`listDiff[N[goldResult, 25], N[ref, 25]]]]',
    },
    {
        id: 'GT12',
        title: 'Denesting a nested radical',
        category: 'identity',
        verify: 'full',
        brief:
            'Denest the radical Sqrt[2 + Sqrt[3]]: express it in the form (a + b Sqrt[3])/Sqrt[c] ' +
            'with integers a, b, c, prove the identity, and verify numerically.',
        contract:
            'define goldResult as the denested exact expression (it must contain no nested radicals).',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult]]'],
        verifier:
            'Catch[Module[{diff, nested},' +
            ' diff = FullSimplify[goldResult - Sqrt[2 + Sqrt[3]]];' +
            ' If[diff =!= 0, Throw[Abs[N[goldResult, 30] - N[Sqrt[2 + Sqrt[3]], 30]]]];' +
            ' nested = Position[goldResult, Power[_?(!FreeQ[#, Power[_, 1/2 | -1/2]] &), 1/2 | -1/2]];' +
            ' If[nested =!= {}, Throw["FAIL: result still contains a nested radical"]];' +
            ' True]]',
    },
    {
        id: 'GT13',
        title: 'Limit of n((1+1/n)^n - e)',
        category: 'identity',
        verify: 'full',
        brief:
            'Compute Limit[n ((1 + 1/n)^n - E), n -> Infinity] exactly, with a derivation (asymptotic ' +
            'expansion of (1+1/n)^n), and verify numerically at large n.',
        contract: 'define goldResult as the exact limit value.',
        contractSymbols: ['goldResult'],
        validationChecks: ['NumericQ[N[goldResult]]'],
        verifier:
            'If[Simplify[goldResult + E/2] === 0, True, Abs[N[goldResult, 30] + N[E/2, 30]]]',
    },
    {
        id: 'GT14',
        title: 'Fibonacci F(100) via matrix power',
        category: 'combinatorics',
        verify: 'full',
        brief:
            'Compute the 100th Fibonacci number (F(1) = F(2) = 1) exactly using the 2x2 matrix-power ' +
            'method (not the built-in Fibonacci function), and cross-check with Binet\'s formula.',
        contract: 'define goldResult as the exact integer F(100).',
        contractSymbols: ['goldResult'],
        validationChecks: ['IntegerQ[goldResult]'],
        verifier: 'If[goldResult === Fibonacci[100], True, "FAIL: expected Fibonacci[100]"]',
    },
    {
        id: 'GT15',
        title: 'Derangements D(12)',
        category: 'combinatorics',
        verify: 'full',
        brief:
            'Compute the number of derangements of 12 objects exactly, both from the inclusion-' +
            'exclusion formula and from the recurrence D(n) = (n-1)(D(n-1) + D(n-2)), and confirm ' +
            'the two agree.',
        contract: 'define goldResult as the exact integer D(12).',
        contractSymbols: ['goldResult'],
        validationChecks: ['IntegerQ[goldResult]'],
        verifier: 'If[goldResult === Subfactorial[12], True, "FAIL: expected Subfactorial[12]"]',
    },
    {
        id: 'GT16',
        title: 'SU(1|1) chain L=6 one-particle spectrum',
        category: 'bethe',
        verify: 'full',
        tolerance: 1e-8,
        brief:
            'The su(1|1) spin chain of length L=6 has Hamiltonian H = Sum_{i=1}^{6} (I - Pg_{i,i+1}) ' +
            'with periodic boundaries, where Pg is the graded permutation: in the two-site basis ' +
            '{bb, bf, fb, ff} it is Pg = {{1,0,0,0},{0,0,1,0},{0,1,0,0},{0,0,0,-1}}. The fermion ' +
            'number M (number of f sites) is conserved. Compute the M=1 sector spectrum (dimension 6) ' +
            'by exact diagonalisation and confirm it equals the one-magnon dispersion values ' +
            '2(1 - cos k) at the periodic momenta k = 2 Pi n/6.',
        contract:
            'define goldResult as the sorted list of the 6 one-particle energies (exact integers ' +
            'or numeric to at least 8 digits).',
        contractSymbols: ['goldResult'],
        validationChecks: ['Length[goldResult] == 6'],
        verifier:
            'Module[{got = Sort[N[goldResult]]},' +
            ' WBGold`listDiff[got, N[{0, 1, 1, 3, 3, 4}]]]',
    },
    {
        id: 'GT17',
        title: 'SU(1|1) chain L=4 full spectrum via sector-dependent free fermions',
        category: 'bethe',
        verify: 'full',
        tolerance: 1e-8,
        brief:
            'For the su(1|1) chain of length L=4 (H = Sum_{i=1}^{4} (I - Pg_{i,i+1}), periodic, ' +
            'graded permutation Pg = {{1,0,0,0},{0,0,1,0},{0,1,0,0},{0,0,0,-1}} in the basis ' +
            '{bb, bf, fb, ff}), compute the full 16-state spectrum two ways: (i) exact ' +
            'diagonalisation of the 16x16 Hamiltonian, and (ii) the free-fermion rule: the M-fermion ' +
            'sector energies are sums of M distinct mode energies 2(1 - cos k), where the momenta ' +
            'obey e^{I k L} = (-1)^(M-1) — periodic k for odd M, antiperiodic for even M. Getting ' +
            'the sector-dependent boundary condition right is the point of the exercise.',
        contract:
            'define goldResult as the sorted list of all 16 energies (numeric, at least 8 digits) ' +
            'from exact diagonalisation, and goldBethe as the sorted list of the same energies from ' +
            'the free-fermion rule.',
        contractSymbols: ['goldResult', 'goldBethe'],
        validationChecks: [
            'Length[goldResult] == 16',
            'Max[Abs[Sort[N[goldResult]] - Sort[N[goldBethe]]]] < 10^-8',
        ],
        verifier:
            'Module[{L = 4, ebb, ebf, efb, eff, op, pg, H, ref, got},' +
            ' ebb = {{1,0},{0,0}}; ebf = {{0,1},{0,0}}; efb = {{0,0},{1,0}}; eff = {{0,0},{0,1}};' +
            ' op[m_, i_] := KroneckerProduct @@ ReplacePart[ConstantArray[IdentityMatrix[2], L], i -> m];' +
            ' pg[i_, j_] := op[ebb,i].op[ebb,j] + op[ebf,i].op[efb,j] + op[efb,i].op[ebf,j] - op[eff,i].op[eff,j];' +
            ' H = Sum[IdentityMatrix[2^L] - pg[i, Mod[i, L] + 1], {i, 1, L}];' +
            ' ref = Sort[Eigenvalues[N[H]]];' +
            ' got = Sort[N[goldResult]];' +
            ' WBGold`listDiff[got, ref]]',
    },
];
