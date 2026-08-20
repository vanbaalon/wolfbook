// Stage 1 core: scanner + object model + identity + managed blocks + project
// graph. Pure modules only — no vscode stub needed, and the suite asserts that.
//
//   node out/extension/kernel/tests/tex-model.test.js
//
// Auto-discovered by kernel/tests/run-all.js and therefore gated by
// deploy-extension.sh, which is the whole reason it lives here rather than
// beside the module (nb-import/tests/ is not gated, and that is a trap worth
// not repeating).

const assert = require('assert');
const path = require('path');

let pass = 0; let fail = 0;
const results = [];
function test(name, fn) {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); }
}

// --- purity: these four must never pull vscode into the require cache -------
{
    const Module = require('module');
    const orig = Module._load;
    let violated = null;
    Module._load = function (req, ...rest) {
        if (req === 'vscode') violated = req;
        return orig.call(this, req, ...rest);
    };
    try {
        require('../../tex/texScanner');
        require('../../tex/texModel');
        require('../../tex/mmaBlocks');
        require('../../tex/texProject');
    } finally { Module._load = orig; }
    test('the four core modules are vscode-free', () => {
        assert.strictEqual(violated, null, `required ${violated}`);
    });
}

const { scanTex, summarise, discoverVerbatimEnvs, preambleSpan } = require('../../tex/texScanner');
const {
    buildModel, reconcile, buildOutline, sectionSpans, summariseObject,
    normalizeSource, similarity,
} = require('../../tex/texModel');
const { parseMmaBlocks, parseHeader, BLOCK_STATE, formatOutputFence } = require('../../tex/mmaBlocks');
const { findRoot, buildGraph, directIncludes, resolveTexPath, ROOT_SOURCE } = require('../../tex/texProject');

const DOC = `\\documentclass{article}
\\usepackage{amsmath}
\\newtcblisting{wbcell}{}
\\begin{document}
\\section{First}
\\label{sec:one}
Some prose here that is long enough to be recognised as an actual paragraph.
\\begin{equation}\\label{eq:a}
  E = mc^2
\\end{equation}
More prose following the equation, again long enough to count as a paragraph.
\\begin{wbcell}
  \\[Alpha] = 1/2;
\\end{wbcell}
\\begin{align}
  a &= b \\\\[2pt]
  c &= d
\\end{align}
See \\eqref{eq:a} and \\cite{Someone:2020}.
\\end{document}`;

const model = (src, file = 't.tex') => buildModel(scanTex(src, { file }), { file });

// --- scanner ---------------------------------------------------------------

test('scanner finds the classes Wolfbook addresses', () => {
    const s = summarise(scanTex(DOC, { file: 't.tex' }).objects);
    assert.strictEqual(s['display-equation'], 2);
    assert.strictEqual(s['section-heading'], 1);
    assert.strictEqual(s.label, 2);
    assert.strictEqual(s.ref, 1);
    assert.strictEqual(s.cite, 1);
});

test('scanner produces no warnings on well-formed input', () => {
    assert.deepStrictEqual(scanTex(DOC, { file: 't.tex' }).warnings, []);
});

test('project-defined verbatim envs come from the preamble, not a hardcoded list', () => {
    // wolfbook_tutorial.tex declares wbcell via \newtcblisting and fills it
    // with Wolfram \[Alpha] named characters that read as display math.
    assert.ok(discoverVerbatimEnvs(DOC).has('wbcell'));
    assert.strictEqual(summarise(scanTex(DOC, { file: 't.tex' }).objects)['display-equation'], 2);
});

test('\\\\[2pt] is a line break, not display math', () => {
    const r = scanTex(DOC, { file: 't.tex' });
    assert.ok(!r.warnings.some(w => /unterminated/.test(w)), r.warnings.join('; '));
});

test('the scanner never throws, on anything', () => {
    for (const bad of ['', '\\', '{{{{{', '\\begin{', '$$', '\\[', '%'.repeat(500),
        '\\begin{document}\\begin{a}\\begin{b}\\end{a}\\end{document}',
        '\\begin{verbatim}\\end{document}']) {
        const r = scanTex(bad, { file: 'x.tex' });
        assert.ok(Array.isArray(r.objects) && Array.isArray(r.warnings));
    }
});

test('an unbalanced environment is a warning, not an exception', () => {
    const r = scanTex('\\documentclass{a}\\begin{document}\n\\end{equation}\n\\end{document}', { file: 't.tex' });
    assert.ok(r.warnings.some(w => /no matching/.test(w)));
});

test('an \\end inside a MACRO DEFINITION is not document structure', () => {
    // Real arXiv papers define \newcommand{\neqa}{\nonumber\end{eqnarray}}.
    // Counting that literal \end produced a spurious "no matching \\begin"
    // and then a cascade of them on every later use of the macro.
    const src = `\\documentclass{a}
\\newcommand{\\neqa}{\\nonumber\\end{eqnarray}}
\\begin{document}
Some prose long enough to be a paragraph in its own right, here.
\\end{document}`;
    assert.deepStrictEqual(scanTex(src, { file: 't.tex' }).warnings, []);
});

test('macros that stand in for \\begin/\\end are honoured', () => {
    // `\\newcommand{\\beq}{\\begin{equation}}` and friends are near-universal in
    // hep-th sources; without this the equations are invisible AND the
    // environments look unclosed.
    const src = `\\documentclass{a}
\\newcommand{\\beq}{\\begin{equation}}
\\newcommand{\\eeq}{\\end{equation}}
\\def\\be{\\begin{eqnarray}}
\\def\\ee{\\end{eqnarray}}
\\begin{document}
\\beq E = mc^2 \\eeq
\\be a = b \\ee
\\be c = d \\end{eqnarray}
\\end{document}`;
    const r = scanTex(src, { file: 't.tex' });
    assert.deepStrictEqual(r.warnings, [], 'closing longhand what a macro opened is valid');
    assert.strictEqual(summarise(r.objects)['display-equation'], 3);
});

test('a macro that does more than delimit is NOT treated as a delimiter', () => {
    // \\newcommand{\\thing}{\\begin{equation}x=1\\end{equation}} is self-contained;
    // faking a dangling \\begin for it would invent an unclosed environment.
    const src = `\\documentclass{a}
\\newcommand{\\thing}{\\begin{equation}x=1\\end{equation}}
\\begin{document}
\\thing
Prose after it, long enough to register as an actual paragraph of text.
\\end{document}`;
    assert.deepStrictEqual(scanTex(src, { file: 't.tex' }).warnings, []);
});

test('macros that stand in for \\label / \\ref / \\cite are followed', () => {
    // MEASURED on a real 3 400-line paper: it defines
    //   \newcommand{\la}[1]{\label{#1}}   (140 uses vs 88 literal \label)
    //   \newcommand{\eq}[1]{(\ref{#1})}   (84 uses)
    // Without this a third of the paper's cross-references are invisible, and
    // every label declared through \la is reported as an unresolved \ref.
    const src = `\\documentclass{a}
\\newcommand{\\la}[1]{\\label{#1}}
\\newcommand{\\eq}[1]{(\\ref{#1})}
\\newcommand{\\cc}[1]{\\cite{#1}}
\\begin{document}
\\begin{equation}\\la{eq:flat} x = 1 \\end{equation}
As shown in \\eq{eq:flat} and \\cc{Someone:2020}.
\\end{document}`;
    const r = scanTex(src, { file: 't.tex' });
    const s2 = summarise(r.objects);
    assert.strictEqual(s2.label, 1, 'the \\la label is found');
    assert.strictEqual(s2.ref, 1, 'the \\eq reference is found');
    assert.strictEqual(s2.cite, 1, 'the \\cc citation is found');
    assert.deepStrictEqual(r.warnings, []);
    const lbl = r.objects.find(o => o.kind === 'label');
    assert.strictEqual(lbl.name, 'eq:flat');
    assert.ok(lbl.viaMacro, 'flagged as reached through a macro');
    // and it must attach to its equation, exactly as a literal \label would
    const eq = r.objects.find(o => o.kind === 'display-equation');
    assert.strictEqual(eq.label, 'eq:flat');
    // so the reference resolves
    const declared = new Set(r.objects.filter(o => o.kind === 'label').map(o => o.name));
    assert.ok(declared.has(r.objects.find(o => o.kind === 'ref').target));
});

test('a macro that does TWO referential things is not treated as an alias', () => {
    // \newcommand{\both}[2]{\label{#1}\ref{#2}} is not a plain \label, and
    // guessing which one it "really" is would invent cross-references.
    const src = `\\documentclass{a}
\\newcommand{\\both}[2]{\\label{#1}\\ref{#2}}
\\begin{document}
\\both{a}{b}
Prose long enough to count as a paragraph of real text goes here.
\\end{document}`;
    const s2 = summarise(scanTex(src, { file: 't.tex' }).objects);
    assert.ok(!s2.label && !s2.ref, 'no cross-references invented');
});

test('\\def-style label aliases work too', () => {
    const src = `\\documentclass{a}
\\def\\lab#1{\\label{#1}}
\\begin{document}
\\begin{equation}\\lab{eq:d} y = 2 \\end{equation}
\\end{document}`;
    const r = scanTex(src, { file: 't.tex' });
    assert.strictEqual(summarise(r.objects).label, 1);
    assert.strictEqual(r.objects.find(o => o.kind === 'display-equation').label, 'eq:d');
});

// --- object model ----------------------------------------------------------

test('every object carries a range, a hash and a section path', () => {
    for (const o of model(DOC).objects) {
        assert.ok(o.objectId && o.stableKey, 'ids');
        assert.ok(o.sourceRange && o.sourceRange.startLine >= 1, 'line is 1-based');
        assert.ok(o.sourceRange.endLine >= o.sourceRange.startLine, 'range is ordered');
        assert.strictEqual(typeof o.sourceHash, 'string');
        assert.ok(Array.isArray(o.sectionPath));
        assert.ok(o.confidence === 'parsed' || o.confidence === 'opaque');
    }
});

test('a labelled equation keys on its label', () => {
    const eq = model(DOC).objects.find(o => o.kind === 'display-equation' && o.label === 'eq:a');
    assert.ok(eq, 'the equation carries its label');
    assert.ok(eq.stableKey.includes('L:eq:a'), eq.stableKey);
});

test('a \\label after \\section attaches to the SECTION, not to \\begin{document}', () => {
    // \begin{document} is always on the environment stack, so "attach to the
    // innermost environment" gave every top-level label to the document and
    // left sections unlabelled. Measured on a real paper: an agent asking for
    // `sec:intro` got the bare label marker instead of the section it names.
    const src = `\\documentclass{a}
\\begin{document}
\\section{Orientation}
\\label{sec:intro}
Prose that is long enough to count as a paragraph of actual text here.
\\begin{figure}
\\caption{C}\\label{fig:one}
\\end{figure}
\\end{document}`;
    const m = model(src);
    const sec = m.objects.find(o => o.kind === 'section-heading');
    assert.strictEqual(sec.label, 'sec:intro');
    const fig = m.objects.find(o => o.kind === 'figure');
    assert.strictEqual(fig.label, 'fig:one', 'a float still claims its own label');
});

test('stableKey is stable across pure reformatting', () => {
    const a = model(DOC);
    const reflowed = DOC.replace('  E = mc^2', '        E   =   mc^2   % a comment');
    const b = model(reflowed);
    const ka = a.objects.find(o => o.label === 'eq:a').stableKey;
    const kb = b.objects.find(o => o.label === 'eq:a').stableKey;
    assert.strictEqual(ka, kb);
});

test('normalizeSource ignores whitespace and comments but not \\%', () => {
    assert.strictEqual(normalizeSource('a  b % note'), 'a b');
    assert.ok(normalizeSource('50\\% of x').includes('\\%'));
});

test('similarity is 1 for identical, ~0 for unrelated', () => {
    assert.strictEqual(similarity('hello world', 'hello world'), 1);
    assert.ok(similarity('hello world', 'zzzzzzzzzz') < 0.2);
});

test('outline nests by section level', () => {
    const src = `\\documentclass{a}\\begin{document}
\\section{One}
\\subsection{One A}
\\subsection{One B}
\\section{Two}
\\end{document}`;
    const tree = buildOutline(model(src).objects);
    assert.strictEqual(tree.length, 2);
    assert.strictEqual(tree[0].title, 'One');
    assert.strictEqual(tree[0].children.length, 2);
    assert.strictEqual(tree[1].title, 'Two');
});

test('the preamble is one foldable span, ending before \\begin{document}', () => {
    const src = `\\documentclass{article}
\\usepackage{amsmath}
\\newcommand{\\x}{y}
\\begin{document}
Body text here.
\\end{document}`;
    const sp = preambleSpan(src);
    assert.deepStrictEqual(sp, { startLine: 1, endLine: 3 });
});

test('preambleSpan declines rather than guessing', () => {
    // A fragment pulled in by \\input has no \\begin{document} at all, and a
    // one-line preamble has nothing to fold.
    assert.strictEqual(preambleSpan('\\section{X}\nprose'), null);
    assert.strictEqual(preambleSpan('\\documentclass{a}\\begin{document}\nx\n\\end{document}'), null);
    assert.strictEqual(preambleSpan(''), null);
});

test('preambleSpan skips leading blank lines so the header line is useful', () => {
    const sp = preambleSpan('\n\n\\documentclass{a}\n\\usepackage{b}\n\\begin{document}\nx');
    assert.strictEqual(sp.startLine, 3, 'starts at \\documentclass, not at a blank line');
    assert.strictEqual(sp.endLine, 4);
});

test('sectionSpans covers what a heading GOVERNS, not just its own line', () => {
    // A section-heading object's range is the \\section{...} command — one
    // line — so folding it directly does nothing. The span is derived instead
    // of widening the object, keeping "what is this object" and "what does it
    // govern" as separate questions.
    const src = `\\documentclass{a}
\\begin{document}
\\section{One}
body of one
\\subsection{One A}
body of one a
\\subsection{One B}
body of one b
\\section{Two}
body of two
\\end{document}`;
    const m = model(src);
    const spans = sectionSpans(m.objects, src.split('\n').length, 11);
    assert.strictEqual(spans.length, 4);
    const [one, oneA, oneB, two] = spans;
    assert.strictEqual(one.title, 'One');
    assert.strictEqual(one.startLine, 3);
    assert.strictEqual(one.endLine, 8, 'section One runs up to the line before section Two');
    assert.strictEqual(oneA.endLine, 6, 'a subsection stops at the next subsection');
    assert.strictEqual(oneB.endLine, 8, 'the last subsection stops with its parent');
    assert.strictEqual(two.endLine, 11, 'the final section stops at \\end{document}');
    assert.ok(oneA.level > one.level, 'levels nest');
});

test('sectionSpans is safe on degenerate input', () => {
    assert.deepStrictEqual(sectionSpans([], 10), []);
    const m = model('\\documentclass{a}\\begin{document}\n\\section{Only}\n\\end{document}');
    const sp = sectionSpans(m.objects, 3, 3);
    assert.strictEqual(sp.length, 1);
    assert.ok(sp[0].endLine >= sp[0].startLine, 'never runs backwards');
});

test('a section title spanning lines loses its continuation %', () => {
    const src = '\\documentclass{a}\\begin{document}\n' +
        '\\section{The Defect RG Flow that Removes the Trivial Line%\n' +
        '  and Then Some}\n\\end{document}';
    const t = model(src).objects.find(o => o.kind === 'section-heading').title;
    assert.ok(!t.includes('%'), `title still has a comment marker: ${JSON.stringify(t)}`);
});

test('summariseObject omits text unless asked, and truncates when it does', () => {
    const o = model(DOC).objects.find(x => x.kind === 'display-equation');
    assert.strictEqual(summariseObject(o).text, undefined);
    const big = { ...o, text: 'x'.repeat(5000) };
    assert.ok(summariseObject(big, { includeText: true, maxText: 100 }).text.length < 200);
});

// --- identity, which is the point of the whole module ----------------------

test('typing INSIDE an object keeps its objectId', () => {
    const a = model(DOC);
    const b = model(DOC.replace('E = mc^2', 'E = mc^2 + \\epsilon'));
    reconcile(a, b);
    const ida = a.objects.find(o => o.label === 'eq:a').objectId;
    const idb = b.objects.find(o => o.label === 'eq:a').objectId;
    assert.strictEqual(idb, ida);
});

test('inserting a paragraph ABOVE does not renumber anything below', () => {
    const a = model(DOC);
    const b = model(DOC.replace('\\section{First}',
        'A brand new paragraph inserted right at the top of the document body.\n\n\\section{First}'));
    const r = reconcile(a, b);
    const ida = a.objects.find(o => o.label === 'eq:a').objectId;
    const idb = b.objects.find(o => o.label === 'eq:a').objectId;
    assert.strictEqual(idb, ida, 'the equation is the same object');
    assert.ok(r.added.length >= 1, 'and the new paragraph is reported as added');
});

test('an object MOVED to another section keeps its id via its label', () => {
    const src = `\\documentclass{a}\\begin{document}
\\section{Alpha}
\\begin{equation}\\label{eq:m} x = 1 \\end{equation}
\\section{Beta}
\\end{document}`;
    const moved = `\\documentclass{a}\\begin{document}
\\section{Alpha}
\\section{Beta}
\\begin{equation}\\label{eq:m} x = 1 \\end{equation}
\\end{document}`;
    const a = model(src); const b = model(moved);
    reconcile(a, b);
    const ea = a.objects.find(o => o.label === 'eq:m');
    const eb = b.objects.find(o => o.label === 'eq:m');
    assert.strictEqual(eb.objectId, ea.objectId);
    assert.ok(['stableKey', 'label', 'contentHash'].includes(eb.identityRule), eb.identityRule);
});

test('a genuinely new object is reported as new, never as a rename', () => {
    const a = model(DOC);
    const b = model(DOC.replace('\\end{document}',
        '\\begin{equation}\\label{eq:brand-new} q = 7 \\end{equation}\n\\end{document}'));
    const r = reconcile(a, b);
    const fresh = b.objects.find(o => o.label === 'eq:brand-new');
    assert.strictEqual(fresh.identityRule, 'new');
    assert.ok(r.added.includes(fresh.stableKey));
});

test('a deleted object is reported as removed', () => {
    const a = model(DOC);
    const b = model(DOC.replace(/\\begin\{equation\}[\s\S]*?\\end\{equation\}/, ''));
    const r = reconcile(a, b);
    assert.ok(r.removed.length >= 1);
});

test('identity survives 30 successive edits — the exit-criterion shape', () => {
    // Stage 1's exit criterion is "objects stable under 30 minutes of editing".
    // This is that, compressed: 30 edits that each touch something, with the
    // tracked equation never itself deleted.
    let cur = model(DOC);
    const target = cur.objects.find(o => o.label === 'eq:a');
    const id0 = target.objectId;
    let src = DOC;
    for (let i = 0; i < 30; i++) {
        src = src.replace('\\end{document}', `Filler paragraph number ${i} with enough words to register as prose.\n\n\\end{document}`);
        if (i % 5 === 0) src = src.replace('E = mc^2', `E = mc^2 % pass ${i}`).replace(/% pass \d+ % pass \d+/, `% pass ${i}`);
        const next = model(src);
        reconcile(cur, next);
        cur = next;
    }
    const still = cur.objects.find(o => o.label === 'eq:a');
    assert.ok(still, 'the equation is still found');
    assert.strictEqual(still.objectId, id0, 'and it is still the same object');
});

// --- managed Mathematica blocks --------------------------------------------

const CODE = 'branchPoints[g_] := NSolve[disc[g] == 0, u];';
const { sha256 } = require('../../tex/texModel');
const OUTBODY = '\\begin{figure}[t]\n\\includegraphics{figs/branch.pdf}\n\\end{figure}';

// NOTE the single space after `%`: undecorate() strips the comment marker and
// exactly ONE space, deliberately, so that relative indentation inside a
// Wolfram block survives. `'%  ' + CODE` would therefore hash as ' ' + CODE and
// every provenance comparison below would fail for a reason that has nothing to
// do with provenance.
function mmaDoc({ srcHash, outHash, code = CODE, body = OUTBODY }) {
    return [
        '%Mathematica[figure, name -> "branch", format -> PDF]',
        '% ' + code,
        '%EndMathematica',
        `%WolfbookOutputBegin[CellID: 4f2a, SourceHash: ${srcHash}, OutputHash: ${outHash}]`,
        body,
        '%WolfbookOutputEnd',
    ].join('\n');
}

test('parseHeader reads both -> and : forms, and keeps what it cannot parse', () => {
    const h = parseHeader('[figure, name -> "branch", format -> PDF]');
    assert.deepStrictEqual(h._positional, ['figure']);
    assert.strictEqual(h.name, 'branch');
    assert.strictEqual(h.format, 'PDF');
    const p = parseHeader('[CellID: 4f2a, SourceHash: a91c]');
    assert.strictEqual(p.CellID, '4f2a');
    assert.strictEqual(p.SourceHash, 'a91c');
    assert.ok(parseHeader('[?!?]')._unparsed.length === 1, 'garbage is surfaced, not dropped');
});

test('fresh: both hashes agree', () => {
    const src = mmaDoc({ srcHash: sha256(CODE).slice(0, 8), outHash: sha256(OUTBODY).slice(0, 8) });
    const { blocks, warnings } = parseMmaBlocks(src, { file: 'p.tex' });
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].state, BLOCK_STATE.FRESH);
    assert.strictEqual(blocks[0].cellId, '4f2a');
    assert.strictEqual(blocks[0].kind, 'figure');
});

test('stale: the code changed under its own output', () => {
    const src = mmaDoc({ srcHash: sha256('OTHER CODE').slice(0, 8), outHash: sha256(OUTBODY).slice(0, 8) });
    assert.strictEqual(parseMmaBlocks(src).blocks[0].state, BLOCK_STATE.STALE);
});

test('modified-by-user: the output was hand-edited', () => {
    const src = mmaDoc({ srcHash: sha256(CODE).slice(0, 8), outHash: sha256('SOMETHING ELSE').slice(0, 8) });
    assert.strictEqual(parseMmaBlocks(src).blocks[0].state, BLOCK_STATE.MODIFIED_BY_USER);
});

test('stale beats modified-by-user when both differ', () => {
    // If the code changed, re-running is the answer regardless of what happened
    // to the output; reporting "modified" would send the user to the wrong fix.
    const src = mmaDoc({ srcHash: sha256('X').slice(0, 8), outHash: sha256('Y').slice(0, 8) });
    assert.strictEqual(parseMmaBlocks(src).blocks[0].state, BLOCK_STATE.STALE);
});

test('no-output: a block that has never run', () => {
    const src = '%Mathematica[expression]\n%  1 + 1\n%EndMathematica\n';
    assert.strictEqual(parseMmaBlocks(src).blocks[0].state, BLOCK_STATE.NO_OUTPUT);
});

test('orphaned: managed output with no block above it', () => {
    const src = '%WolfbookOutputBegin[CellID: zz, SourceHash: aa, OutputHash: bb]\nhello\n%WolfbookOutputEnd\n';
    const r = parseMmaBlocks(src);
    assert.strictEqual(r.blocks.length, 0);
    assert.strictEqual(r.outputs.length, 1);
    assert.strictEqual(r.outputs[0].state, BLOCK_STATE.ORPHANED);
    assert.ok(r.warnings.length === 1);
});

test('malformed: an unclosed block, and an unclosed output fence', () => {
    const a = parseMmaBlocks('%Mathematica\n%  1+1\n');
    assert.strictEqual(a.blocks[0].state, BLOCK_STATE.MALFORMED);
    assert.ok(a.warnings.some(w => /never closed/.test(w)));
    const b = parseMmaBlocks('%Mathematica\n%  1+1\n%EndMathematica\n%WolfbookOutputBegin[CellID: q]\nx\n');
    assert.strictEqual(b.blocks[0].state, BLOCK_STATE.MALFORMED);
});

test('malformed: a fence with no provenance is not silently called fresh', () => {
    const src = '%Mathematica\n%  1+1\n%EndMathematica\n%WolfbookOutputBegin\nx\n%WolfbookOutputEnd\n';
    const b = parseMmaBlocks(src).blocks[0];
    assert.strictEqual(b.state, BLOCK_STATE.MALFORMED);
    assert.ok(/neither SourceHash nor OutputHash/.test(b.stateReason));
});

test('hashes match by PREFIX, so the legible short form works', () => {
    const full = sha256(CODE);
    const src = mmaDoc({ srcHash: full.slice(0, 6) + '…', outHash: sha256(OUTBODY).slice(0, 6) + '…' });
    assert.strictEqual(parseMmaBlocks(src).blocks[0].state, BLOCK_STATE.FRESH);
});

test('the code is undecorated: leading % and one space are stripped', () => {
    const src = '%Mathematica\n%  a = 1;\n%  b = 2;\n%EndMathematica\n';
    assert.strictEqual(parseMmaBlocks(src).blocks[0].code, ' a = 1;\n b = 2;');
});

test('two blocks in one file are both found with correct line numbers', () => {
    const src = ['pre', mmaDoc({ srcHash: 'aa', outHash: 'bb' }), 'mid',
        mmaDoc({ srcHash: 'cc', outHash: 'dd' }), 'post'].join('\n');
    const r = parseMmaBlocks(src, { file: 'p.tex' });
    assert.strictEqual(r.blocks.length, 2);
    assert.ok(r.blocks[0].startLine < r.blocks[1].startLine);
    assert.strictEqual(src.split('\n')[r.blocks[0].startLine - 1].trim().startsWith('%Mathematica'), true);
});

test('formatOutputFence round-trips through the parser', () => {
    const fence = formatOutputFence('c1', sha256('code'), sha256('out'));
    const h = parseHeader(/\[.*\]/.exec(fence)[0]);
    assert.strictEqual(h.CellID, 'c1');
    assert.strictEqual(h.SourceHash, sha256('code').slice(0, 8));
});

test('managed blocks do not disturb the structural scan', () => {
    const src = `\\documentclass{a}\\begin{document}\n${mmaDoc({ srcHash: 'aa', outHash: 'bb' })}\n\\end{document}`;
    const s = summarise(scanTex(src, { file: 'p.tex' }).objects);
    assert.strictEqual(s.figure, 1, 'the managed output is still an ordinary figure');
});

// --- project graph ---------------------------------------------------------

function fakeFs(files) {
    const norm = (p) => path.normalize(p);
    const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
    return {
        readFile: (p) => { const v = map.get(norm(p)); if (v == null) throw new Error('ENOENT ' + p); return v; },
        exists: (p) => map.has(norm(p)),
        listDir: (d) => [...map.keys()].filter(p => path.dirname(p) === norm(d)).map(p => path.basename(p)),
    };
}

const PROJ = {
    '/p/paper.tex': '\\documentclass{article}\n\\begin{document}\n\\input{sec1}\n\\include{sub/sec3}\n\\end{document}',
    '/p/sec1.tex': '\\section{One}\n\\input{sec2}\n',
    '/p/sec2.tex': '\\section{Two}\n',
    '/p/sub/sec3.tex': '\\section{Three}\n',
};

test('\\input resolves with an implicit .tex extension', () => {
    const deps = fakeFs(PROJ);
    assert.strictEqual(resolveTexPath('/p', 'sec1', deps), path.normalize('/p/sec1.tex'));
    assert.strictEqual(resolveTexPath('/p', 'sec1.tex', deps), path.normalize('/p/sec1.tex'));
});

test('directIncludes finds \\input, \\include and their line numbers', () => {
    const deps = fakeFs(PROJ);
    const inc = directIncludes(PROJ['/p/paper.tex'], '/p/paper.tex', deps);
    assert.strictEqual(inc.length, 2);
    assert.strictEqual(inc[0].cmd, 'input');
    assert.strictEqual(inc[0].line, 3);
    assert.strictEqual(inc[1].cmd, 'include');
    assert.ok(inc.every(i => i.exists));
});

test('\\import takes two arguments and resolves through the first', () => {
    const deps = fakeFs({ '/p/main.tex': '\\import{parts/}{intro}', '/p/parts/intro.tex': 'x' });
    const inc = directIncludes(deps.readFile('/p/main.tex'), '/p/main.tex', deps);
    assert.strictEqual(inc.length, 1);
    assert.strictEqual(inc[0].target, path.normalize('/p/parts/intro.tex'));
});

test('the graph reaches every file transitively', () => {
    const g = buildGraph('/p/paper.tex', fakeFs(PROJ));
    assert.strictEqual(g.files.length, 4);
    assert.ok(g.files.includes(path.normalize('/p/sub/sec3.tex')));
    assert.strictEqual(g.missing.length, 0);
    assert.strictEqual(g.cycles.length, 0);
});

test('a missing \\input becomes a reported hole, not a crash', () => {
    const deps = fakeFs({ '/p/paper.tex': '\\documentclass{a}\\input{nope}' });
    const g = buildGraph('/p/paper.tex', deps);
    assert.strictEqual(g.missing.length, 1);
    assert.strictEqual(g.missing[0].raw, 'nope');
});

test('an include cycle terminates and is reported', () => {
    const deps = fakeFs({ '/p/a.tex': '\\input{b}', '/p/b.tex': '\\input{a}' });
    const g = buildGraph('/p/a.tex', deps);
    assert.ok(g.files.length <= 2);
    assert.ok(g.cycles.length >= 1);
});

test('root: an explicit magic comment wins', () => {
    const deps = fakeFs({
        '/p/paper.tex': '\\documentclass{a}\\begin{document}\\input{ch}\\end{document}',
        '/p/ch.tex': '% !TEX root = paper.tex\n\\section{C}',
    });
    const r = findRoot('/p/ch.tex', deps);
    assert.strictEqual(r.root, path.normalize('/p/paper.tex'));
    assert.strictEqual(r.source, ROOT_SOURCE.MAGIC_COMMENT);
});

test('root: a file with \\documentclass is its own root', () => {
    const r = findRoot('/p/paper.tex', fakeFs(PROJ));
    assert.strictEqual(r.root, path.normalize('/p/paper.tex'));
    assert.strictEqual(r.source, ROOT_SOURCE.DOCUMENTCLASS);
});

test('root: a bare fragment finds the sole root in its directory', () => {
    const r = findRoot('/p/sec1.tex', fakeFs(PROJ));
    assert.strictEqual(r.root, path.normalize('/p/paper.tex'));
    assert.strictEqual(r.source, ROOT_SOURCE.SOLE_TEX);
});

test('root: with two candidate roots, the one that REACHES the file wins', () => {
    const deps = fakeFs({
        '/p/paper.tex': '\\documentclass{a}\\begin{document}\\input{shared}\\end{document}',
        '/p/talk.tex': '\\documentclass{beamer}\\begin{document}\\end{document}',
        '/p/shared.tex': '\\section{S}',
    });
    assert.strictEqual(findRoot('/p/shared.tex', deps).root, path.normalize('/p/paper.tex'));
});

test('root: an orphan fragment falls back to itself rather than guessing', () => {
    const deps = fakeFs({ '/p/loose.tex': '\\section{Nothing points here}' });
    const r = findRoot('/p/loose.tex', deps);
    assert.strictEqual(r.root, path.normalize('/p/loose.tex'));
    assert.strictEqual(r.source, ROOT_SOURCE.FALLBACK);
});

test('an unreadable file does not take the graph down', () => {
    const deps = fakeFs(PROJ);
    deps.readFile = (p) => { if (String(p).includes('sec2')) throw new Error('EACCES'); return PROJ[path.normalize(p).replace(/\\/g, '/')] ?? PROJ[p]; };
    const g = buildGraph('/p/paper.tex', deps);
    assert.ok(Array.isArray(g.files));
});

// --- corpus: the real-world regression gate --------------------------------

test('the Porto corpus scans clean, fast, and with sane ranges', () => {
    const fs = require('fs');
    const base = path.resolve(__dirname, '../../../../..',
        'Wolfbook Presentations', '2026 Porto');
    const papers = [
        ['Stockastic Quantization/SQ_report.tex', { 'display-equation': 20, label: 26, 'section-heading': 60 }],
        ['Cross Cup/Baxter_notes.tex', { 'display-equation': 23, label: 31, 'section-heading': 20 }],
        ['Superrotations/notes.tex', { 'display-equation': 41, label: 22, 'section-heading': 69 }],
    ];
    let checked = 0;
    for (const [rel, expect] of papers) {
        const p = path.join(base, rel);
        if (!fs.existsSync(p)) continue;          // corpus absent: skip, do not fail
        const src = fs.readFileSync(p, 'utf8');
        const t0 = Date.now();
        const r = scanTex(src, { file: rel });
        const ms = Date.now() - t0;
        const s = summarise(r.objects);
        for (const [k, v] of Object.entries(expect)) {
            assert.strictEqual(s[k] || 0, v, `${rel}: ${k} expected ${v}, got ${s[k] || 0}`);
        }
        assert.deepStrictEqual(r.warnings, [], `${rel} should scan clean`);
        // Stage 0 measured 0.7-3.6 ms for 16-47 KB; 50 ms is a generous ceiling
        // that still catches an accidental quadratic.
        assert.ok(ms < 50, `${rel} took ${ms} ms`);
        for (const o of r.objects) {
            assert.ok(o.startLine >= 1 && o.endLine >= o.startLine, `${rel}: bad range`);
            assert.ok(o.endOffset <= src.length, `${rel}: range past EOF`);
        }
        checked++;
    }
    if (!checked) results.push('       (corpus not present — real-paper checks skipped)');
});

test('the corpus scanner catches the real bug in spinchain_report.tex', () => {
    const fs = require('fs');
    const p = path.resolve(__dirname, '../../../../..',
        'Wolfbook Presentations', '2026 Porto', 'Heisenberg', 'spinchain_report.tex');
    if (!fs.existsSync(p)) return;                // skip if the corpus is absent
    const r = scanTex(fs.readFileSync(p, 'utf8'), { file: 'spinchain_report.tex' });
    // Line 231 is a duplicated \end{equation}; pdflatex fails there with
    // "Bad math environment delimiter". The scanner finds it with no compiler.
    assert.ok(r.warnings.some(w => /:231:/.test(w) && /no matching/.test(w)),
        'expected the duplicated \\end{equation} at line 231; got ' + JSON.stringify(r.warnings));
});

// ---------------------------------------------------------------------------

console.log('tex/ core (scanner, model, identity, managed blocks, project)\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
