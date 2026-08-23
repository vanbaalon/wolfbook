// Managed Mathematica computations: the multi-cell grammar (mmaBlocks) and the
// canonical writer (mmaWrite). Pure modules only — no vscode stub needed.
//
//   node out/extension/kernel/tests/tex-mma.test.js
//
// Auto-discovered by kernel/tests/run-all.js and therefore gated by
// deploy-extension.sh.
//
// The first group is the one that matters most: every .tex written before
// multi-cell existed must parse EXACTLY as it did, because those files are
// already on disk in people's papers.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
function test(name, fn) {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); }
}

// --- purity ----------------------------------------------------------------
{
    const Module = require('module');
    const orig = Module._load;
    let violated = null;
    Module._load = function (req, ...rest) {
        if (req === 'vscode') violated = req;
        return orig.call(this, req, ...rest);
    };
    try {
        require('../../tex/mmaBlocks');
        require('../../tex/mmaWrite');
    } finally { Module._load = orig; }
    test('mmaBlocks and mmaWrite are vscode-free', () => {
        assert.strictEqual(violated, null, `required ${violated}`);
    });
}

const {
    parseMmaBlocks, parseCells, formatOutputFence, sha256, BLOCK_STATE,
} = require('../../tex/mmaBlocks');
const W = require('../../tex/mmaWrite');

const CODE = 'branchPoints[g_] := NSolve[disc[g] == 0, u];';
const OUTBODY = '\\begin{figure}[t]\n\\includegraphics{figs/branch.pdf}\n\\end{figure}';
const h8 = (s) => sha256(s).slice(0, 8);

// ===========================================================================
// 1. Legacy blocks are untouched
// ===========================================================================

function legacyDoc({ srcHash, outHash, code = CODE, body = OUTBODY }) {
    return [
        '%Mathematica[figure, name -> "branch", format -> PDF]',
        '% ' + code,
        '%EndMathematica',
        `%WolfbookOutputBegin[CellID: 4f2a, SourceHash: ${srcHash}, OutputHash: ${outHash}]`,
        body,
        '%WolfbookOutputEnd',
    ].join('\n');
}

test('legacy: a block with no directive is one implicit Wolfram cell', () => {
    const b = parseMmaBlocks(legacyDoc({ srcHash: h8(CODE), outHash: h8(OUTBODY) })).blocks[0];
    assert.strictEqual(b.state, BLOCK_STATE.FRESH);
    assert.strictEqual(b.cells.length, 1);
    assert.strictEqual(b.cells[0].kind, 'wolfram');
    assert.strictEqual(b.cells[0].implicit, true);
    assert.strictEqual(b.cells[0].include, true);
    assert.strictEqual(b.cells[0].code, CODE);
    assert.strictEqual(b.code, CODE, 'block-level code is unchanged');
    assert.strictEqual(b.codeHash, sha256(CODE));
});

test('legacy: the implicit cell adopts the CellID that only the fence carries', () => {
    const b = parseMmaBlocks(legacyDoc({ srcHash: h8(CODE), outHash: h8(OUTBODY) })).blocks[0];
    assert.strictEqual(b.cellId, '4f2a');
    assert.strictEqual(b.cells[0].cellId, '4f2a');
    assert.strictEqual(b.cells[0].outputIndex, 0, 'and it is paired with that fence');
    assert.strictEqual(b.blockId, '4f2a', 'with no BlockID declared, the cell id serves');
});

test('legacy: the implicit cell hashes as the whole region, so old fences adjudicate', () => {
    const b = parseMmaBlocks(legacyDoc({ srcHash: h8(CODE), outHash: h8(OUTBODY) })).blocks[0];
    assert.strictEqual(b.cells[0].sourceHash, b.codeHash);
    const stale = parseMmaBlocks(legacyDoc({ srcHash: h8('OTHER'), outHash: h8(OUTBODY) })).blocks[0];
    assert.strictEqual(stale.state, BLOCK_STATE.STALE);
    assert.strictEqual(stale.cells[0].state, BLOCK_STATE.STALE);
});

test('legacy: block.output still points at the first fence', () => {
    const b = parseMmaBlocks(legacyDoc({ srcHash: h8(CODE), outHash: h8(OUTBODY) })).blocks[0];
    assert.ok(b.output, 'the Stage-1 field is still populated');
    assert.strictEqual(b.output.body, OUTBODY);
    assert.strictEqual(b.outputs.length, 1);
});

test('the closer may carry a bracket, as the vision document writes it', () => {
    const src = legacyDoc({ srcHash: h8(CODE), outHash: h8(OUTBODY) })
        .replace('%WolfbookOutputEnd', '%WolfbookOutputEnd[CellID: 4f2a]');
    const r = parseMmaBlocks(src);
    assert.strictEqual(r.blocks[0].state, BLOCK_STATE.FRESH);
    assert.strictEqual(r.warnings.length, 0);
});

// ===========================================================================
// 2. Cells
// ===========================================================================

const MULTI = [
    '%Mathematica[notebook, BlockID: 4f2a]',
    '%%Markdown[CellID: m1, out -> insert]',
    '% The branch points solve $\\disc(g)=0$.',
    '%%Wolfram[CellID: c1, out -> insert, kind -> figure]',
    '% ListPlot[pts]',
    '%%Wolfram[out -> none]',
    '% (* scratch *)',
    '%EndMathematica',
].join('\n');

test('parseCells splits on %% directives and reads kind, id and flags', () => {
    const b = parseMmaBlocks(MULTI).blocks[0];
    assert.strictEqual(b.cells.length, 3);
    assert.deepStrictEqual(b.cells.map(c => c.kind), ['markdown', 'wolfram', 'wolfram']);
    assert.deepStrictEqual(b.cells.map(c => c.cellId), ['m1', 'c1', null]);
    assert.deepStrictEqual(b.cells.map(c => c.include), [true, true, false]);
    assert.strictEqual(b.cells[1].options.kind, 'figure');
    assert.strictEqual(b.blockId, '4f2a');
});

test('a cell knows the lines it occupies', () => {
    const b = parseMmaBlocks(MULTI).blocks[0];
    assert.strictEqual(b.cells[0].directiveLine, 2);
    assert.strictEqual(b.cells[0].startLine, 3);
    assert.strictEqual(b.cells[0].endLine, 3);
    assert.strictEqual(b.cells[1].code, 'ListPlot[pts]');
});

test('defaults: Wolfram materialises, Markdown does not', () => {
    const cells = parseCells(['%%Wolfram', '% 1+1', '%%Markdown', '% hi'], 2);
    assert.strictEqual(cells[0].include, true);
    assert.strictEqual(cells[1].include, false);
});

test('%% requires a known keyword, so hand-written %% is not a split point', () => {
    const b = parseMmaBlocks('%Mathematica\n% a\n%%%% ruler\n% b\n%EndMathematica').blocks[0];
    assert.strictEqual(b.cells.length, 1, 'the ruler is code, not a directive');
    assert.ok(b.cells[0].code.includes('%% ruler'));
});

test('a code line beginning with % survives decoration and never reads as a directive', () => {
    const doc = { cells: [{ kind: 'wolfram', code: '%%Wolfram\n%EndMathematica\nx = 1' }] };
    const b = parseMmaBlocks(W.buildBlockText(doc)).blocks[0];
    assert.strictEqual(b.cells.length, 1);
    assert.strictEqual(b.cells[0].code, '%%Wolfram\n%EndMathematica\nx = 1');
});

test('an empty block still offers one cell to type into', () => {
    const b = parseMmaBlocks('%Mathematica\n%EndMathematica').blocks[0];
    assert.strictEqual(b.cells.length, 1);
    assert.strictEqual(b.cells[0].code, '');
});

// ===========================================================================
// 3. Fence pairing and per-cell state
// ===========================================================================

function fenceFor(cellId, code, body) {
    return [formatOutputFence(cellId, sha256(code), sha256(body)), body, '%WolfbookOutputEnd'].join('\n');
}

test('fences pair by CellID, not by position', () => {
    const src = [
        '%Mathematica[BlockID: b1]',
        '%%Wolfram[CellID: c1]',
        '% one',
        '%%Wolfram[CellID: c2]',
        '% two',
        '%EndMathematica',
        fenceFor('c2', 'two', 'BODY-TWO'),
        fenceFor('c1', 'one', 'BODY-ONE'),
    ].join('\n');
    const b = parseMmaBlocks(src).blocks[0];
    assert.strictEqual(b.outputs.length, 2);
    assert.strictEqual(b.cells[0].cellId, 'c1');
    assert.strictEqual(b.outputs[b.cells[0].outputIndex].body, 'BODY-ONE',
        'c1 got its own output even though it is written second');
    assert.strictEqual(b.outputs[b.cells[1].outputIndex].body, 'BODY-TWO');
    assert.strictEqual(b.state, BLOCK_STATE.FRESH);
});

test('ephemeral: out -> none with no fence is a choice, not a gap', () => {
    const b = parseMmaBlocks('%Mathematica\n%%Wolfram[out -> none]\n% 1+1\n%EndMathematica').blocks[0];
    assert.strictEqual(b.cells[0].state, BLOCK_STATE.EPHEMERAL);
    assert.strictEqual(b.state, BLOCK_STATE.EPHEMERAL);
});

test('no-output: a cell that wants an output and has none', () => {
    const b = parseMmaBlocks('%Mathematica\n%%Wolfram[out -> insert]\n% 1+1\n%EndMathematica').blocks[0];
    assert.strictEqual(b.cells[0].state, BLOCK_STATE.NO_OUTPUT);
});

test('a fence whose cell was deleted orphans that fence, and the block still parses', () => {
    const src = [
        '%Mathematica[BlockID: b1]',
        '%%Wolfram[CellID: c1]',
        '% one',
        '%EndMathematica',
        fenceFor('c1', 'one', 'BODY-ONE'),
        fenceFor('gone', 'x', 'BODY-GONE'),
    ].join('\n');
    const b = parseMmaBlocks(src).blocks[0];
    assert.strictEqual(b.cells.length, 1);
    assert.strictEqual(b.orphanedFences.length, 1);
    assert.strictEqual(b.orphanedFences[0].body, 'BODY-GONE');
    assert.strictEqual(b.state, BLOCK_STATE.ORPHANED);
});

test('the block reports the WORST of its cells', () => {
    const src = [
        '%Mathematica[BlockID: b1]',
        '%%Wolfram[CellID: c1]',
        '% one',
        '%%Wolfram[CellID: c2]',
        '% two',
        '%EndMathematica',
        fenceFor('c1', 'one', 'A'),                     // fresh
        [formatOutputFence('c2', sha256('DIFFERENT'), sha256('B')), 'B', '%WolfbookOutputEnd'].join('\n'),
    ].join('\n');
    const b = parseMmaBlocks(src).blocks[0];
    assert.strictEqual(b.cells[0].state, BLOCK_STATE.FRESH);
    assert.strictEqual(b.cells[1].state, BLOCK_STATE.STALE);
    assert.strictEqual(b.state, BLOCK_STATE.STALE, 'one stale cell is not hidden by a fresh neighbour');
    assert.ok(/changed/.test(b.stateReason), 'and the reason belongs to the cell that earned it');
});

test('a fresh block beats an ephemeral scratch cell in the rollup', () => {
    const src = [
        '%Mathematica[BlockID: b1]',
        '%%Wolfram[CellID: c1]',
        '% one',
        '%%Wolfram[out -> none]',
        '% scratch',
        '%EndMathematica',
        fenceFor('c1', 'one', 'A'),
    ].join('\n');
    assert.strictEqual(parseMmaBlocks(src).blocks[0].state, BLOCK_STATE.FRESH);
});

// ===========================================================================
// 4. The writer
// ===========================================================================

test('an empty line decorates as bare %, never as "% "', () => {
    assert.deepStrictEqual(W.decorate('a\n\nb'), ['% a', '%', '% b']);
});

test('the legacy shape is written with no directive at all', () => {
    const text = W.buildBlockText({ cells: [{ kind: 'wolfram', code: '1+1', include: true }] });
    assert.strictEqual(text, '%Mathematica\n% 1+1\n%EndMathematica');
});

test('any other shape gets explicit directives', () => {
    const text = W.buildBlockText({
        blockId: 'b1',
        cells: [
            { kind: 'markdown', cellId: 'm1', include: true, code: 'hi' },
            { kind: 'wolfram', cellId: 'c1', include: false, code: '1+1' },
        ],
    });
    assert.ok(text.includes('%Mathematica[BlockID: b1]'));
    assert.ok(text.includes('%%Markdown[CellID: m1, out -> insert]'));
    assert.ok(text.includes('%%Wolfram[CellID: c1, out -> none]'));
});

test('round trip: parse(build(doc)) preserves every cell', () => {
    const doc = {
        blockId: 'b1',
        options: { _positional: ['notebook'], name: 'branch' },
        cells: [
            { kind: 'markdown', cellId: 'm1', include: true, code: 'Some prose.\n\nTwo paragraphs.', options: {} },
            { kind: 'wolfram', cellId: 'c1', include: true, code: 'f[x_] := x^2;\n\nf[3]', options: { kind: 'figure' } },
            { kind: 'wolfram', cellId: 'c2', include: false, code: '(* scratch *)', options: {} },
        ],
    };
    const back = W.toDoc(parseMmaBlocks(W.buildBlockText(doc)).blocks[0]);
    assert.deepStrictEqual(back, doc);
});

test('round trip: hashes are stable across awkward source lines', () => {
    for (const code of ['% leading percent', '', '\ttab indented', 'a\n\n\nb', '%EndMathematica', 'x  ']) {
        const doc = { cells: [{ kind: 'wolfram', code, include: true }] };
        const b = parseMmaBlocks(W.buildBlockText(doc)).blocks[0];
        assert.strictEqual(b.cells[0].code, code, `code survived: ${JSON.stringify(code)}`);
        assert.strictEqual(b.cells[0].sourceHash, sha256(code));
    }
});

test('formatOutputFence carries BlockID when asked, and is silent when not', () => {
    const withB = formatOutputFence('c1', sha256('a'), sha256('b'), { blockId: 'b1' });
    assert.ok(/BlockID: b1/.test(withB));
    assert.strictEqual(parseMmaBlocks(`%Mathematica\n% a\n%EndMathematica\n${withB}\nb\n%WolfbookOutputEnd`)
        .blocks[0].state, BLOCK_STATE.FRESH);
    assert.ok(!/BlockID/.test(formatOutputFence('c1', 'aa', 'bb')));
});

// ===========================================================================
// 5. planInsert — where the fence lands
// ===========================================================================

const TWO_CELL = [
    'before',
    '%Mathematica[BlockID: b1]',
    '%%Wolfram[CellID: c1]',
    '% one',
    '%%Wolfram[CellID: c2]',
    '% two',
    '%EndMathematica',
    'after',
    '',
].join('\n');

function applyPlan(text, plan) {
    return text.slice(0, plan.startOffset) + plan.newText + text.slice(plan.endOffset);
}

test('planInsert: the first fence lands directly after %EndMathematica', () => {
    const b = parseMmaBlocks(TWO_CELL).blocks[0];
    const plan = W.planInsert(TWO_CELL, b, 'c1', 'BODY-ONE');
    assert.strictEqual(plan.replaced, false);
    const out = applyPlan(TWO_CELL, plan);
    const lines = out.split('\n');
    assert.strictEqual(lines[7], '%WolfbookOutputBegin[CellID: c1, BlockID: b1, SourceHash: '
        + sha256('one').slice(0, 8) + ', OutputHash: ' + sha256('BODY-ONE').slice(0, 8) + ']');
    assert.strictEqual(lines[8], 'BODY-ONE');
    assert.strictEqual(lines[9], '%WolfbookOutputEnd');
    assert.strictEqual(lines[10], 'after', 'the text below is undisturbed');
    const after = parseMmaBlocks(out).blocks[0];
    assert.strictEqual(after.cells[0].state, BLOCK_STATE.FRESH);
    assert.strictEqual(after.state, BLOCK_STATE.NO_OUTPUT,
        'the block is not fresh yet — its second cell still has no output');
});

test('planInsert: a second cell fences BELOW the first cell fence', () => {
    let text = applyPlan(TWO_CELL, W.planInsert(TWO_CELL, parseMmaBlocks(TWO_CELL).blocks[0], 'c1', 'BODY-ONE'));
    const b = parseMmaBlocks(text).blocks[0];
    text = applyPlan(text, W.planInsert(text, b, 'c2', 'BODY-TWO'));
    const idxOne = text.indexOf('BODY-ONE');
    const idxTwo = text.indexOf('BODY-TWO');
    assert.ok(idxOne > 0 && idxTwo > idxOne, 'cell order is fence order');
    const parsed = parseMmaBlocks(text).blocks[0];
    assert.strictEqual(parsed.outputs.length, 2);
    assert.strictEqual(parsed.state, BLOCK_STATE.FRESH);
    assert.ok(text.includes('\nafter\n'), 'and the paper below is still intact');
});

test('planInsert: an EARLIER cell fences above a later one that already exists', () => {
    let text = applyPlan(TWO_CELL, W.planInsert(TWO_CELL, parseMmaBlocks(TWO_CELL).blocks[0], 'c2', 'BODY-TWO'));
    const b = parseMmaBlocks(text).blocks[0];
    text = applyPlan(text, W.planInsert(text, b, 'c1', 'BODY-ONE'));
    assert.ok(text.indexOf('BODY-ONE') < text.indexOf('BODY-TWO'));
    assert.strictEqual(parseMmaBlocks(text).blocks[0].state, BLOCK_STATE.FRESH);
});

test('planInsert: re-inserting REPLACES in place and reproduces byte-identical text', () => {
    const first = applyPlan(TWO_CELL, W.planInsert(TWO_CELL, parseMmaBlocks(TWO_CELL).blocks[0], 'c1', 'BODY-ONE'));
    const b = parseMmaBlocks(first).blocks[0];
    const plan = W.planInsert(first, b, 'c1', 'BODY-ONE');
    assert.strictEqual(plan.replaced, true);
    assert.strictEqual(applyPlan(first, plan), first, 'recompute is a no-op on disk');
});

test('planInsert: a body may be re-inserted with different content without moving neighbours', () => {
    const first = applyPlan(TWO_CELL, W.planInsert(TWO_CELL, parseMmaBlocks(TWO_CELL).blocks[0], 'c1', 'BODY-ONE'));
    const second = applyPlan(first, W.planInsert(first, parseMmaBlocks(first).blocks[0], 'c1', 'NEW\nBODY'));
    assert.ok(second.includes('NEW\nBODY'));
    assert.ok(!second.includes('BODY-ONE'));
    assert.strictEqual(parseMmaBlocks(second).blocks[0].cells[0].state, BLOCK_STATE.FRESH);
    assert.ok(second.endsWith('after\n'));
});

test('planInsert: an unknown cell is refused, not guessed at', () => {
    const b = parseMmaBlocks(TWO_CELL).blocks[0];
    assert.ok(W.planInsert(TWO_CELL, b, 'nope', 'X').error);
});

test('planInsert: a legacy one-cell block takes an output with no cellId at all', () => {
    const src = '%Mathematica\n% 1+1\n%EndMathematica\n';
    const b = parseMmaBlocks(src).blocks[0];
    const out = applyPlan(src, W.planInsert(src, b, null, '$2$'));
    assert.strictEqual(parseMmaBlocks(out).blocks[0].state, BLOCK_STATE.FRESH);
});

test('first materialisation: the fence names the id the cell is being GIVEN', () => {
    // The exact sequence the viewer performs when a freshly dropped cell has
    // its first output inserted: the cell has no id yet, so it is looked up as
    // the block's only cell, given an id in the block rewrite, and its fence
    // must name THAT id. Writing the id it had (none) put `CellID: null` in the
    // fence, which reads back as a cell paired with a stranger.
    const src = '%Mathematica[BlockID: b9]\n% 1+1\n%EndMathematica\n';
    const block = parseMmaBlocks(src).blocks[0];
    assert.strictEqual(block.cells[0].cellId, null, 'it starts anonymous');

    const doc = W.toDoc(block);
    doc.cells[0].cellId = 'c9';
    const blockPlan = W.planBlockText(src, block, doc);
    const fencePlan = W.planInsert(src, block, null, '$2$', { blockId: 'b9', writeCellId: 'c9' });

    // Lowest edit last, as the viewer applies them.
    let out = applyPlan(src, fencePlan);
    out = applyPlan(out, blockPlan);

    assert.ok(out.includes('CellID: c9'), 'the fence names the new id');
    assert.ok(!/CellID: (null|undefined)/.test(out), 'and never a null one');
    const after = parseMmaBlocks(out).blocks[0];
    assert.strictEqual(after.cells[0].cellId, 'c9');
    assert.strictEqual(after.cells[0].outputIndex, 0, 'the cell owns that output');
    assert.strictEqual(after.state, BLOCK_STATE.FRESH);

    // And re-inserting is now a REPLACEMENT, not a second copy.
    const again = applyPlan(out, W.planInsert(out, after, 'c9', '$2$', { blockId: 'b9' }));
    assert.strictEqual(again, out);
});

test('planRemoveOutput deletes a fence and leaves a no-output cell behind', () => {
    const first = applyPlan(TWO_CELL, W.planInsert(TWO_CELL, parseMmaBlocks(TWO_CELL).blocks[0], 'c1', 'BODY-ONE'));
    const plan = W.planRemoveOutput(first, parseMmaBlocks(first).blocks[0], 'c1');
    const out = applyPlan(first, plan);
    assert.strictEqual(out, TWO_CELL, 'removing the output restores the original bytes');
    assert.strictEqual(W.planRemoveOutput(out, parseMmaBlocks(out).blocks[0], 'c1'), null,
        'and removing it again is a no-op, not an error');
});

test('planBlockText rewrites the block and leaves the fences below alone', () => {
    const first = applyPlan(TWO_CELL, W.planInsert(TWO_CELL, parseMmaBlocks(TWO_CELL).blocks[0], 'c1', 'BODY-ONE'));
    const b = parseMmaBlocks(first).blocks[0];
    const doc = W.toDoc(b);
    doc.cells[0].code = 'one edited';
    const out = applyPlan(first, W.planBlockText(first, b, doc));
    assert.ok(out.includes('% one edited'));
    assert.ok(out.includes('BODY-ONE'), 'the output is still there');
    assert.strictEqual(parseMmaBlocks(out).blocks[0].state, BLOCK_STATE.STALE,
        'and it is correctly reported as stale now');
});

// ---------------------------------------------------------------------------
console.log('\ntex-mma.test.js');
console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
