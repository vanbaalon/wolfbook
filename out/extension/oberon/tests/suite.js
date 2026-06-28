'use strict';
/**
 * Oberon — standard test suite.
 *
 * 10 hard physics / mathematics research problems used to benchmark the full
 * Planner → Fairy pipeline.  Each entry has:
 *   id    — stable identifier (TS01…TS10)
 *   title — short display name
 *   brief — the exact brief string sent to runPlanner()
 */

module.exports = [
    {
        id: 'TS01',
        title: 'SU(4) spin chain spectrum L=4',
        brief:
            'Compute the full energy spectrum of the SU(4) fundamental-representation spin chain at ' +
            'length L=4 (Hilbert space dimension 4^4 = 256) by exact diagonalisation of the nearest-' +
            'neighbour Hamiltonian H = Σ P_{i,i+1} (sum of permutation operators, periodic boundary ' +
            'conditions). List every distinct eigenvalue together with its degeneracy.',
    },
    {
        id: 'TS02',
        title: 'SU(3) spin chain translation sectors L=5',
        brief:
            'For the SU(3) fundamental-representation spin chain at length L=5 (dimension 3^5 = 243), ' +
            'block-diagonalise the nearest-neighbour Hamiltonian (periodic BC) by lattice momentum ' +
            'k = 2π n/5, n = 0,1,2,3,4.  Compute the energy spectrum in each momentum sector separately.',
    },
    {
        id: 'TS03',
        title: 'XXX Heisenberg vs exact diagonalisation L=8 two-magnon',
        brief:
            'For the XXX spin-1/2 Heisenberg chain at L=8 with periodic boundary conditions, ' +
            'compute the two-magnon sector energies (i) from the Bethe ansatz equations, and ' +
            '(ii) by exact diagonalisation of the two-magnon subspace.  List both sets of eigenvalues ' +
            'and verify that the Bethe ansatz reproduces the exact spectrum.',
    },
    {
        id: 'TS04',
        title: 'Cauchy-like matrix determinant pattern',
        brief:
            'Define the n×n matrix A with entries A_{ij} = 1/(1+i+j) for i,j = 1…n.  ' +
            'Compute det(A) exactly (as a rational number or a closed-form expression) for ' +
            'n = 2 through 12, identify the pattern or closed form, and verify the conjecture for ' +
            'n = 15 and n = 20.',
    },
    {
        id: 'TS05',
        title: 'Zeros of truncated exponential sum',
        brief:
            'Compute all zeros (in the complex plane) of the truncated exponential polynomial ' +
            'P_N(z) = Σ_{k=0}^{N} z^k / k! for N = 20, 40, and 80.  Describe the distribution ' +
            'of the zeros and state the limiting-shape conjecture as N → ∞.',
    },
    {
        id: 'TS06',
        title: 'Baxter TQ polynomial solutions L=4',
        brief:
            'For the XXX spin-1/2 Heisenberg chain at L=4, find all polynomial solutions Q(u) ' +
            'of degree ≤ 8 to the Baxter TQ relation T(u)Q(u) = Q(u+i) + Q(u-i), where T(u) is ' +
            'the transfer matrix (a degree-4 polynomial in u).  Classify the distinct T(u) and Q(u) ' +
            'solution branches and identify which correspond to physical eigenstates.',
    },
    {
        id: 'TS07',
        title: 'GUE random matrix nearest-neighbour statistics',
        brief:
            'Generate GUE (Gaussian Unitary Ensemble) random matrices of sizes N = 50, 100, and 200. ' +
            'Unfold the spectra using the local mean level spacing.  Compute the nearest-neighbour ' +
            'spacing distribution and compare it quantitatively with the Wigner surmise ' +
            'p(s) = (π/2) s exp(−π s²/4) using a Kolmogorov–Smirnov test and a chi-squared test.',
    },
    {
        id: 'TS08',
        title: 'Anharmonic oscillator eigenvalues',
        brief:
            'Find the lowest 10 eigenvalues of the anharmonic oscillator −d²f/dx² + x⁴ f(x) = E f(x) ' +
            'on the real line by discretising on the finite interval [−L, L] with L = 10, 15, 20 and ' +
            'N = 500 uniformly spaced grid points (finite-difference method).  Report the eigenvalues ' +
            'and discuss convergence with L.',
    },
    {
        id: 'TS09',
        title: 'S_6 permutation representation on 3-subsets',
        brief:
            'Construct the 20-dimensional permutation representation of S_6 acting on the set of ' +
            '3-element subsets of {1,…,6}.  Decompose it into irreducible representations using ' +
            'character theory and list the multiplicity of each irrep.',
    },
    {
        id: 'TS10',
        title: 'Nested Bethe ansatz coupled TQ bootstrap',
        brief:
            'For the SU(2) XXX spin-1/2 chain at L=4, solve the nested Bethe ansatz coupled TQ ' +
            'equations involving two Q-functions Q_1 and Q_2, each of polynomial degree ≤ 6.  ' +
            'Classify all solution branches (including singular/exceptional solutions) and identify ' +
            'which branches correspond to physical eigenstates.',
    },
];
