'use strict';
/**
 * Oberon Fairy — static Wolfram Language dependency analysis.
 *
 * Conservative regex-based approach — no AST, no runtime kernel call.
 * Over-inclusive (false-positive dependencies) is always preferred over
 * under-inclusive (missing a real dependency breaks the fresh-kernel run).
 *
 * Critical: usesSymbols uses /[A-Za-z$].../ — NOT uppercase-only — because
 * almost all user symbols in math/physics code are lowercase (f, g, m, result).
 * An uppercase-only scan would silently miss every lowercase user symbol and
 * guarantee false-negative dependency edges.
 *
 * API:
 *   analyzeCode(code) → { definesSymbols: string[], usesSymbols: string[] }
 */

// ── WL System` built-in blocklist ──────────────────────────────────────────
// Subtract from usesSymbols to avoid recording spurious dependencies on
// built-in functions. Keep conservative: a missed built-in becomes a false-
// positive dep (larger closure) — acceptable. A wrongly subtracted user symbol
// becomes a false-negative dep (missed dependency) — not acceptable.
// If a user names a variable "Integrate", it appears in both definesSymbols
// and this blocklist; definesSymbols takes precedence in the caller.
const WL_BUILTINS = new Set([
    // Core forms
    'Module', 'Block', 'With', 'CompoundExpression', 'Sequence',
    'Set', 'SetDelayed', 'TagSet', 'TagSetDelayed', 'UpSet', 'UpSetDelayed',
    'OwnValues', 'DownValues', 'UpValues', 'SubValues',
    'Unset', 'Clear', 'ClearAll', 'Remove', 'Protect', 'Unprotect',
    'Quiet', 'Check', 'Catch', 'Throw', 'Abort', 'Return', 'Break', 'Continue',
    // Control flow
    'If', 'Which', 'Switch', 'Do', 'For', 'While', 'Goto', 'Label',
    'NestWhile', 'FixedPoint', 'FixedPointList',
    // Functional
    'Function', 'Slot', 'SlotSequence',
    'Map', 'MapAt', 'MapIndexed', 'MapThread', 'Apply',
    'Select', 'Cases', 'Pick', 'Count', 'Position', 'Extract',
    'Scan', 'Nest', 'NestList', 'NestWhileList',
    'Fold', 'FoldList', 'FoldPairList',
    'Array', 'Table', 'Range', 'ConstantArray', 'SparseArray',
    'Tuples', 'Permutations', 'Subsets',
    // List operations
    'List', 'Append', 'AppendTo', 'Prepend', 'PrependTo',
    'Join', 'Flatten', 'FlattenAt', 'Riffle',
    'Part', 'First', 'Last', 'Rest', 'Most', 'Take', 'Drop',
    'Length', 'Dimensions', 'Depth', 'ArrayDepth',
    'Transpose', 'Partition', 'Gather', 'GatherBy',
    'Sort', 'SortBy', 'Ordering', 'Reverse',
    'Union', 'Intersection', 'Complement', 'DeleteDuplicates',
    'MemberQ', 'FreeQ', 'ContainsAll', 'ContainsNone',
    'Total', 'Accumulate', 'Differences',
    'Min', 'Max', 'MinMax', 'Clip',
    'Mean', 'Variance', 'StandardDeviation', 'Median',
    // Arithmetic & math
    'Plus', 'Times', 'Power', 'Subtract', 'Divide',
    'Sqrt', 'Exp', 'Log', 'Log2', 'Log10',
    'Abs', 'Sign', 'Re', 'Im', 'Conjugate', 'Arg',
    'Sin', 'Cos', 'Tan', 'Cot', 'Sec', 'Csc',
    'ArcSin', 'ArcCos', 'ArcTan', 'ArcCot', 'ArcSec', 'ArcCsc',
    'Sinh', 'Cosh', 'Tanh', 'Coth',
    'ArcSinh', 'ArcCosh', 'ArcTanh',
    'Floor', 'Ceiling', 'Round', 'IntegerPart', 'FractionalPart',
    'Mod', 'Quotient', 'GCD', 'LCM', 'EulerPhi',
    'Prime', 'PrimeQ', 'NextPrime', 'PrimePi', 'Divisors', 'DivisorSum',
    'Factorial', 'Factorial2', 'Binomial', 'Multinomial',
    'Pochhammer', 'HarmonicNumber', 'BernoulliB', 'EulerE',
    'BesselJ', 'BesselY', 'BesselI', 'BesselK',
    'HypergeometricPFQ', 'Hypergeometric0F1', 'Hypergeometric1F1', 'Hypergeometric2F1',
    'Gamma', 'LogGamma', 'PolyGamma', 'Beta', 'Zeta', 'LerchPhi',
    'Erf', 'Erfc', 'Erfi', 'FresnelS', 'FresnelC',
    // Symbolic math
    'Integrate', 'NIntegrate',
    'D', 'Derivative',
    'Limit', 'Series', 'SeriesCoefficient', 'Normal', 'O',
    'Simplify', 'FullSimplify', 'Expand', 'ExpandAll', 'ExpandNumerator', 'ExpandDenominator',
    'Factor', 'FactorInteger', 'Together', 'Apart', 'Cancel',
    'Collect', 'Coefficient', 'CoefficientList', 'Exponent', 'PolynomialQ',
    'Solve', 'NSolve', 'Reduce', 'FindRoot', 'FindMinimum', 'FindMaximum',
    'DSolve', 'NDSolve', 'RSolve',
    'Sum', 'Product', 'NSum', 'NProduct',
    'LaplaceTransform', 'InverseLaplaceTransform',
    'FourierTransform', 'InverseFourierTransform',
    'ZTransform', 'InverseZTransform',
    'ConvolvingPolynomials', 'Convolve', 'ListConvolve',
    'Residue', 'ContourIntegrate',
    // Assumptions
    'Assuming', 'Element', 'NotElement', 'Reals', 'Integers', 'Rationals',
    'Complexes', 'Primes', 'Booleans', 'PositiveReals', 'NonNegativeReals',
    // Linear algebra
    'Dot', 'MatrixPower', 'Inverse', 'Det', 'Tr', 'MatMul',
    'Eigenvalues', 'Eigenvectors', 'Eigensystem',
    'SingularValueList', 'SingularValueDecomposition',
    'LinearSolve', 'NullSpace', 'RowReduce', 'RowSpace',
    'Norm', 'Cross', 'Outer', 'Inner', 'TensorProduct',
    'DiagonalMatrix', 'IdentityMatrix', 'ZeroMatrix',
    'PseudoInverse', 'MatrixRank',
    // Output/format
    'Print', 'Echo', 'ToString', 'InputForm', 'OutputForm', 'FullForm',
    'StandardForm', 'TraditionalForm', 'HoldForm', 'HoldAll', 'Hold',
    'NumberForm', 'ScientificForm', 'EngineeringForm', 'AccountingForm',
    'N', 'Precision', 'Accuracy', 'SetPrecision', 'SetAccuracy', 'MachinePrecision',
    'NumberString', 'ToString',
    // Patterns and rules
    'Pattern', 'Blank', 'BlankSequence', 'BlankNullSequence', 'Optional',
    'Condition', 'PatternTest', 'Except', 'Alternatives', 'Repeated', 'RepeatedNull',
    'Rule', 'RuleDelayed', 'Replace', 'ReplaceAll', 'ReplaceRepeated', 'ReplaceList',
    // Logic
    'And', 'Or', 'Not', 'Xor', 'Nand', 'Nor', 'Implies', 'Equivalent',
    'True', 'False',
    'Equal', 'Unequal', 'Less', 'LessEqual', 'Greater', 'GreaterEqual',
    'SameQ', 'UnsameQ', 'TrueQ', 'FalseQ',
    // Strings
    'StringJoin', 'StringLength', 'StringQ', 'StringReverse',
    'StringSplit', 'StringReplace', 'StringTake', 'StringDrop', 'StringPart',
    'StringMatchQ', 'StringStartsQ', 'StringEndsQ', 'StringContainsQ',
    'StringInsert', 'Characters', 'CharacterRange', 'FromCharacterCode', 'ToCharacterCode',
    'ToExpression', 'FromDigits', 'IntegerDigits', 'RealDigits',
    // Associations
    'Association', 'AssociationQ', 'AssociationThread', 'AssociationMap',
    'Lookup', 'KeySelect', 'KeyMap', 'KeyDrop', 'KeyTake', 'KeyExistsQ',
    'Values', 'Keys', 'Merge', 'GroupBy',
    // Special constants
    'Pi', 'E', 'I', 'Infinity', 'ComplexInfinity', 'DirectedInfinity',
    'Degree', 'GoldenRatio', 'EulerGamma', 'Catalan', 'Khinchin',
    'Indeterminate', 'Null', 'None', 'All', 'Automatic', 'Inherited',
    'Full', 'Missing',
    // Type predicates
    'AtomQ', 'NumberQ', 'NumericQ', 'IntegerQ', 'EvenQ', 'OddQ',
    'ListQ', 'MatrixQ', 'VectorQ', 'SquareMatrixQ',
    'StringQ', 'SymbolQ', 'ValueQ', 'MatchQ', 'PossibleZeroQ',
    'Head', 'Length', 'LeafCount', 'ByteCount',
    // Misc
    'Sow', 'Reap', 'Unique', 'Trace', 'TracePrint',
    'Timing', 'AbsoluteTiming', 'TimeConstrained', 'MemoryConstrained',
    'Dynamic', 'Manipulate', 'Plot', 'Plot3D', 'ListPlot', 'MatrixPlot',
    'Show', 'Graphics', 'Graphics3D', 'Axes', 'AxesLabel', 'PlotRange',
    // List/structure editing (run Q32: `Nothing` was flagged as a missing dep)
    'Nothing', 'Thread', 'Through', 'Identity', 'Composition', 'RightComposition',
    'Insert', 'Delete', 'DeleteCases', 'ReplacePart', 'Splice',
    'PadLeft', 'PadRight', 'RotateLeft', 'RotateRight',
    'Split', 'SplitBy', 'TakeWhile', 'LengthWhile', 'Tally', 'Counts', 'CountsBy',
    'AnyTrue', 'AllTrue', 'NoneTrue', 'Subdivide', 'CenterArray',
    // Evaluation control
    'Evaluate', 'Unevaluated', 'Inactive', 'Activate', 'Inactivate',
    'Definition', 'Information', 'Names', 'Symbol', 'Context',
    // Numbers & polynomials
    'Chop', 'Rationalize', 'Threshold', 'Boole', 'Piecewise', 'ConditionalExpression',
    'Refine', 'Root', 'RootSum', 'RootReduce', 'ToRadicals', 'MinimalPolynomial',
    'Numerator', 'Denominator', 'Variables', 'Eliminate', 'GroebnerBasis',
    'Resultant', 'Discriminant', 'Decompose', 'PolynomialRemainder', 'PolynomialQuotient',
    'PolynomialGCD', 'PolynomialLCM', 'Cyclotomic', 'MonomialList',
    'Divisible', 'CoprimeQ', 'PowerMod', 'ModularInverse', 'ContinuedFraction', 'Convergents',
    'IntegerPartitions', 'PartitionsP', 'PartitionsQ', 'FrobeniusNumber', 'SquaresR',
    // Linear algebra (additions)
    'CharacteristicPolynomial', 'KroneckerProduct', 'ArrayFlatten', 'Band',
    'UnitVector', 'Normalize', 'Orthogonalize', 'ConjugateTranspose',
    'HermitianMatrixQ', 'UnitaryMatrixQ', 'PositiveDefiniteMatrixQ',
    'Tr', 'Minors', 'Adjugate', 'SchurDecomposition', 'JordanDecomposition',
    'QRDecomposition', 'LUDecomposition', 'CholeskyDecomposition',
    // Randomness
    'RandomReal', 'RandomInteger', 'RandomComplex', 'RandomChoice', 'RandomSample',
    'RandomVariate', 'SeedRandom', 'BlockRandom', 'NormalDistribution', 'UniformDistribution',
    // Special functions (math-physics staples)
    'ChebyshevT', 'ChebyshevU', 'LegendreP', 'LegendreQ', 'HermiteH', 'LaguerreL',
    'GegenbauerC', 'JacobiP', 'SphericalHarmonicY', 'ClebschGordan', 'ThreeJSymbol',
    'SixJSymbol', 'WignerD', 'KroneckerDelta', 'DiracDelta', 'UnitStep', 'HeavisideTheta',
    'Signature', 'LeviCivitaTensor', 'PolyLog', 'HurwitzZeta', 'StieltjesGamma',
    'EllipticK', 'EllipticE', 'EllipticF', 'EllipticPi', 'EllipticTheta',
    'JacobiSN', 'JacobiCN', 'JacobiDN', 'JacobiAmplitude', 'InverseJacobiSN',
    'WeierstrassP', 'WeierstrassPPrime', 'DedekindEta', 'KleinInvariantJ',
    'ModularLambda', 'QPochhammer', 'QGamma', 'QFactorial', 'QBinomial',
    'InverseFunction', 'ProductLog', 'AiryAi', 'AiryBi',
    'MathieuC', 'MathieuS', 'SpheroidalPS', 'SpheroidalQS',
    // Interpolation / data
    'Interpolation', 'ListInterpolation', 'InterpolatingPolynomial', 'Fit', 'FindFit',
    'Nearest', 'FindSequenceFunction', 'FindLinearRecurrence',
    // I/O & formatting
    'Export', 'Import', 'ExportString', 'ImportString',
    'MatrixForm', 'TableForm', 'Grid', 'Row', 'Column', 'Style', 'Text', 'Framed',
    'BinCounts', 'HistogramList',
]);

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Strip string literals and block comments from WL code to prevent false
 * symbol matches inside them. Content is replaced with spaces so character
 * offsets are preserved (important for regex exec indices).
 */
function stripStringsAndComments(code) {
    // Block comments: (* ... *) — non-nested (nested comments are WL11.3+ only)
    let s = code.replace(/\(\*[\s\S]*?\*\)/g, m => ' '.repeat(m.length));
    // String literals: "..." with escape handling
    s = s.replace(/"(?:[^"\\]|\\.)*"/g, m => ' '.repeat(m.length));
    return s;
}

/**
 * Extract local variable names from Module/Block/With var lists.
 * e.g. Module[{x, y = 0, z_}, body] → {x, y, z}
 */
function extractLocals(stripped) {
    const locals = new Set();
    const containerRe = /\b(?:Module|Block|With)\s*\[\s*\{([^}]*)\}/g;
    let m;
    while ((m = containerRe.exec(stripped)) !== null) {
        const varList = m[1];
        // Variables can appear as: x, x_, x = expr, x := expr, {x,y}
        const varRe = /([A-Za-z$][A-Za-z0-9$]*)/g;
        let v;
        while ((v = varRe.exec(varList)) !== null) {
            locals.add(v[1]);
        }
    }
    return locals;
}

/**
 * Extract pattern variable names from function definitions.
 * e.g. f[x_, y_Integer, z___] := ... → {x, y, z}
 */
function extractPatternVars(stripped) {
    const vars = new Set();
    // Match symbol names immediately followed by _ (pattern variables)
    const re = /([A-Za-z$][A-Za-z0-9$]*)_/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
        vars.add(m[1]);
    }
    return vars;
}

/**
 * Extract symbol names defined (top-level LHS bindings) in `code`.
 */
function extractDefines(stripped) {
    const defines = new Set();

    // f[args...] := body  OR  f = expr  OR  f := expr  (with optional args)
    // Match: symbolName optionally followed by [...] then := or = (but not ==, <=, >=, !=)
    const lhsRe = /([A-Za-z$][A-Za-z0-9$]*)(?:\s*\[[^\]]*\])?\s*(?::=|(?<![=!<>])=(?!=))/g;
    let m;
    while ((m = lhsRe.exec(stripped)) !== null) {
        const sym = m[1];
        // Exclude built-in assignment operators that appear at call site
        if (!WL_BUILTINS.has(sym)) {
            defines.add(sym);
        }
    }

    // Set[f, expr]  and  SetDelayed[f, expr]
    const setCallRe = /\b(?:Set|SetDelayed)\s*\[\s*([A-Za-z$][A-Za-z0-9$]*)/g;
    while ((m = setCallRe.exec(stripped)) !== null) {
        const sym = m[1];
        if (!WL_BUILTINS.has(sym)) defines.add(sym);
    }

    // TagSet[sym, lhs, rhs]  and  UpSet  (define on f's head)
    const tagRe = /\b(?:TagSet|TagSetDelayed)\s*\[\s*([A-Za-z$][A-Za-z0-9$]*)/g;
    while ((m = tagRe.exec(stripped)) !== null) {
        const sym = m[1];
        if (!WL_BUILTINS.has(sym)) defines.add(sym);
    }

    return [...defines];
}

/**
 * Extract all free symbol names used in `code`.
 *
 * @param {string} stripped  - code already processed by stripStringsAndComments
 * @param {string[]} defines - symbols defined in this step (subtracted from uses)
 */
function extractUses(stripped, defines) {
    const locals     = extractLocals(stripped);
    const patVars    = extractPatternVars(stripped);
    const defined    = new Set(defines);
    const exclude    = new Set([...WL_BUILTINS, ...locals, ...patVars, ...defined]);

    const uses = new Set();
    const re = /[A-Za-z$][A-Za-z0-9$]*/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
        const sym = m[0];
        if (!exclude.has(sym)) uses.add(sym);
    }
    return [...uses];
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Analyse a single WL code string for top-level symbol definitions and uses.
 *
 * @param {string} code
 * @returns {{ definesSymbols: string[], usesSymbols: string[] }}
 */
function analyzeCode(code) {
    if (!code || typeof code !== 'string') {
        return { definesSymbols: [], usesSymbols: [] };
    }
    const stripped      = stripStringsAndComments(code);
    const definesSymbols = extractDefines(stripped);
    const usesSymbols    = extractUses(stripped, definesSymbols);
    return { definesSymbols, usesSymbols };
}

module.exports = { analyzeCode, WL_BUILTINS };
