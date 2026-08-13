'use strict';
/**
 * Headless suite for the .nb importer.
 *
 *   node out/extension/nb-import/tests/nbImport.test.js
 *
 * Only vscode-free modules are exercised (wlParser + nbModel); the test asserts
 * that neither of them pulled vscode into the require cache. BTL is stubbed, so
 * the suite passes with or without the native addon present.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const P = require('../wlParser');
const M = require('../nbModel');

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
    try { fn(); pass++; results.push('  ✓ ' + name); }
    catch (e) { fail++; results.push('  ✗ ' + name + '\n      ' + (e && e.message)); }
}

// Stub deps — deterministic, no native code.
const NAMED = { Alpha: 0x3b1, LongDash: 0x2014, Rule: 0xf522, DoubleStruckCapitalQ: 0x211a };
const deps = {
    boxToLatex: (s) => ({ latex: 'LX{' + s.length + '}', error: null }),
    prerenderLatex: (l) => '<span class="katex">' + l + '</span>',
    wlUTFtoNames: (s) => s,
    namedChars: NAMED,
};
const noDeps = { boxToLatex: null, prerenderLatex: null, wlUTFtoNames: (s) => s, namedChars: NAMED };

const NB_HEADER = '(* Content-type: application/vnd.wolfram.mathematica *)\n\n(*** Wolfram Notebook File ***)\n\n';
const nb = (body) => NB_HEADER + 'Notebook[{\n' + body + '\n}]\n';

// ---------------------------------------------------------------------------
console.log('\n── tokenizer / parser ──');

test('nested comments are skipped', () => {
    const r = P.parseExpr('(* a (* b *) c *) Foo[1]');
    assert.ok(r.ok);
    assert.strictEqual(P.printInputForm(r.ast), 'Foo[1]');
});

test('string escapes and backslash-newline folds', () => {
    const r = P.parseExpr('"a\\"b\\\\c\\\ndef"');
    assert.ok(r.ok);
    assert.strictEqual(r.ast.value, 'a"b\\cdef');
});

test('named characters survive verbatim in a string', () => {
    const r = P.parseExpr('"\\[Alpha] + 1"');
    assert.strictEqual(r.ast.value, '\\[Alpha] + 1');
    assert.strictEqual(P.printInputForm(r.ast), '"\\[Alpha] + 1"');
});

test('precision and *^ exponent numbers are kept verbatim', () => {
    const src = '{3.6148802318567953`*^9, -2, 1.5``20, 16^^ff}';
    const r = P.parseExpr(src);
    assert.ok(r.ok);
    assert.strictEqual(P.printInputForm(r.ast), '{3.6148802318567953`*^9, -2, 1.5``20, 16^^ff}');
});

test('context symbols, rules and delayed rules', () => {
    const r = P.parseExpr('SeriesData[$CellContext`u, a -> b, c :> d]');
    assert.strictEqual(P.printInputForm(r.ast), 'SeriesData[$CellContext`u, a -> b, c :> d]');
});

test('slots, postfix & and implicit multiplication', () => {
    assert.strictEqual(P.printInputForm(P.parseExpr('HypergeometricPFQ[#, #2, #3]&').ast),
                       'HypergeometricPFQ[#, #2, #3]&');
    assert.strictEqual(P.printInputForm(P.parseExpr('Magnification :> 1.5 Inherited').ast),
                       'Magnification :> 1.5 Inherited');
});

test('an unparseable argument is captured instead of failing the file', () => {
    const r = P.parseExpr('Cell[BoxData["x"], "Input", Junk -> ;;;@@, Other -> 1]');
    assert.ok(r.ok, 'should still parse');
    assert.ok(r.recoveries >= 1, 'expected a recovery');
    assert.ok(P.printInputForm(r.ast).includes('Other -> 1'), 'later options must survive');
});

test('parseNotebookSource rejects a non-notebook', () => {
    assert.strictEqual(P.parseNotebookSource('just some text').ok, false);
});

// ---------------------------------------------------------------------------
console.log('\n── sniffing ──');

test('isNbSource accepts .nb and rejects .wb JSON', () => {
    assert.strictEqual(M.isNbSource(NB_HEADER + 'Notebook[{}]'), true);
    assert.strictEqual(M.isNbSource('Notebook[{\n Cell["x", "Text"]}]'), true);
    assert.strictEqual(M.isNbSource('{\n "cells": [],\n "metadata": {}\n}'), false);
    assert.strictEqual(M.isNbSource(''), false);
});

// ---------------------------------------------------------------------------
console.log('\n── simple (wolfbook-exported) dialect ──');

test('headings, prose and code map to the wb cell model', () => {
    const src = nb([
        ' Cell["My Title", "Title"],',
        ' Cell["Some \\[LongDash] prose", "Text"],',
        ' Cell["## Already markdown\n more", "Text"],',
        ' Cell["1 + 1", "Input"],',
        ' Cell["E^(i \\[Pi])", "DisplayFormula", FormatType -> TeXForm]',
    ].join('\n'));
    const r = M.importNb(src, deps, { mode: 'save' });
    const c = r.cells;
    assert.strictEqual(c[0].value, '# My Title');
    assert.strictEqual(c[0].kind, 1);
    assert.strictEqual(c[1].value, 'Some — prose');
    assert.strictEqual(c[2].value, '## Already markdown\nmore', 'wb-export line prefix must be undone');
    assert.deepStrictEqual([c[3].kind, c[3].languageId, c[3].value], [2, 'wolfram', '1 + 1']);
    assert.ok(c[4].value.startsWith('$$'), 'DisplayFormula -> $$…$$');
});

test('heading levels invert wb-export exactly', () => {
    const src = nb([' Cell["a", "Title"],', ' Cell["b", "Section"],',
                    ' Cell["c", "Subsection"],', ' Cell["d", "Subsubsection"]'].join('\n'));
    const v = M.importNb(src, deps, { mode: 'save' }).cells.map(x => x.value);
    assert.deepStrictEqual(v, ['# a', '## b', '### c', '#### d']);
});

// ---------------------------------------------------------------------------
console.log('\n── box flattening ──');

test('common boxes flatten to runnable code', () => {
    const src = nb(' Cell[BoxData[RowBox[{"a", "+", FractionBox["1", "2"], "*", SqrtBox["x"], ' +
                   '"*", SuperscriptBox["u", "2"], "*", SubscriptBox["y", "3"]}]], "Input"]');
    const c = M.importNb(src, deps, { mode: 'save' }).cells[0];
    assert.strictEqual(c.value, 'a+(1)/(2)*Sqrt[x]*u^2*Subscript[y, 3]');
});

test('\\[Rule] becomes -> instead of an invisible private-use character', () => {
    const src = nb(' Cell[BoxData[RowBox[{"x", "\\[Rule]", "1"}]], "Input"]');
    const c = M.importNb(src, deps, { mode: 'save' }).cells[0];
    assert.strictEqual(c.value, 'x -> 1');
    assert.ok(!/[-]/.test(c.value), 'no PUA characters may reach the cell');
});

test('multi-statement BoxData produces one line per statement', () => {
    const src = nb(' Cell[BoxData[{RowBox[{"a", "=", "1"}], "\\[IndentingNewLine]", ' +
                   'RowBox[{"b", "=", "2"}]}], "Input"]');
    const c = M.importNb(src, deps, { mode: 'save' }).cells[0];
    assert.strictEqual(c.value, 'a=1\nb=2');
});

test('an unmodelled box is kept verbatim and marks the cell approximate', () => {
    const src = nb(' Cell[BoxData[RowBox[{"f", "[", TemplateBox[{"1"}, "Weird"], "]"}]], "Input"]');
    const r = M.importNb(src, deps, { mode: 'save' });
    const c = r.cells.find(x => x.kind === 2);
    assert.ok(c.metadata.nbImport && c.metadata.nbImport.approx, 'cell must be marked approx');
    assert.ok(c.metadata.nbImport.boxSource.includes('TemplateBox'), 'box source kept for the kernel pass');
    assert.ok(r.warnings.approxCells >= 1);
});

// ---------------------------------------------------------------------------
console.log('\n── TextData prose ──');

test('bold, italic, links and inline math', () => {
    const src = nb(' Cell[TextData[{"plain ", StyleBox["bold", FontWeight -> "Bold"], " ", ' +
                   'StyleBox["it", FontSlant -> "Italic"], " ", ' +
                   'ButtonBox["site", BaseStyle -> "Hyperlink", ButtonData -> {URL["https://x.dev"], None}], ' +
                   '" ", Cell[BoxData[FormBox["q", TraditionalForm]]]}], "Text"]');
    const v = M.importNb(src, deps, { mode: 'save' }).cells[0].value;
    assert.ok(v.includes('**bold**'), v);
    assert.ok(v.includes('*it*'), v);
    assert.ok(v.includes('[site](https://x.dev)'), v);
    assert.ok(/\$LX\{\d+\}\$/.test(v), 'inline formula becomes $latex$: ' + v);
});

// ---------------------------------------------------------------------------
console.log('\n── outputs ──');

const GROUPED = nb(
    ' Cell[CellGroupData[{\n' +
    '  Cell[BoxData[RowBox[{"1", "+", "1"}]], "Input"],\n' +
    '  Cell[BoxData[FormBox["2", TraditionalForm]], "Output", CellLabel -> "Out[16]="]\n' +
    ' }, Open]]'
);

test('Output attaches to its Input cell with the live HTML contract', () => {
    const r = M.importNb(GROUPED, deps, { mode: 'save' });
    const code = r.cells.find(c => c.kind === 2);
    assert.strictEqual(code.outputs.length, 1);
    const items = code.outputs[0].items;
    assert.strictEqual(items[0].mime, 'x-application/wolfram-language-html', 'html must be items[0]');
    assert.strictEqual(items[1].mime, 'text/plain');
    const html = items[0].data;
    assert.ok(html.includes('data-out-n="16"'), 'Out[N] comes from CellLabel');
    assert.ok(html.includes('vscode-wolfram-wllatex-prerendered'));
    assert.ok(html.includes('data-latex-b64="'));
    assert.ok(!html.includes('data-session-epoch'), 'epoch would delete the output on session change');
    assert.ok(!html.includes('data-output-id'), 'no live output registry exists for an import');
    const latex = Buffer.from(/data-latex-b64="([^"]*)"/.exec(html)[1], 'base64').toString('utf8');
    assert.ok(/^LX\{\d+\}$/.test(latex), 'base64 must round-trip the LaTeX, got ' + latex);
    assert.ok(html.includes('<span class="katex">' + latex + '</span>'), 'KaTeX html is embedded');
    assert.strictEqual(items[1].data, 'Out[16]= ' + latex);
});

const GFX_NB = nb(
    ' Cell[CellGroupData[{\n' +
    '  Cell[BoxData["Plot[x,{x,0,1}]"], "Input"],\n' +
    '  Cell[BoxData[GraphicsBox[{}, ImageSize -> 100]], "Output", CellLabel -> "Out[7]="]\n' +
    ' }, Open]]'
);

test('a graphics output is queued for rasterisation, not dropped', () => {
    const r = M.importNb(GFX_NB, deps, { mode: 'save' });
    const code = r.cells.find(c => c.kind === 2);
    assert.strictEqual(code.outputs.length, 1);
    assert.strictEqual(code.outputs[0].items[0].mime, 'text/plain');
    assert.strictEqual(r.warnings.graphicsOutputs, 1);
    assert.strictEqual(r.graphicsTasks.length, 1);
    const task = r.graphicsTasks[0];
    assert.ok(/^nb_[0-9a-f]{12}\.png$/.test(task.file), 'content-hashed name: ' + task.file);
    assert.ok(task.boxSource.startsWith('GraphicsBox['), task.boxSource.slice(0, 40));
    const note = code.metadata.nbImport.graphics[0];
    assert.deepStrictEqual(
        { id: note.id, target: note.target, outputIndex: note.outputIndex, outN: note.outN },
        { id: task.id, target: 'output', outputIndex: 0, outN: 7 });
    assert.ok(!code.outputs[0]._gfx, 'the internal marker must not leak into the notebook');
});

test('the same graphic always hashes to the same file name', () => {
    const a = M.importNb(GFX_NB, deps, { mode: 'save' }).graphicsTasks[0].file;
    const b = M.importNb(GFX_NB, deps, { mode: 'save' }).graphicsTasks[0].file;
    assert.strictEqual(a, b);
});

test('applyGraphics swaps a rendered PNG into the output', () => {
    const r = M.importNb(GFX_NB, deps, { mode: 'save' });
    const task = r.graphicsTasks[0];
    const res = M.applyGraphics(r.cells, { [task.id]: { absPath: '/abs/img/Doc/' + task.file, size: { w: 360, h: 221 } } }, 'img/Doc');
    assert.strictEqual(res.applied, 1);
    assert.strictEqual(res.missing, 0);
    const out = r.cells.find(c => c.kind === 2).outputs[0];
    assert.strictEqual(out.items[0].mime, 'x-application/wolfram-language-html');
    const html = out.items[0].data;
    assert.ok(html.includes('src="img/Doc/' + task.file + '"'), html);
    assert.ok(html.includes('data-wl-img="/abs/img/Doc/' + task.file + '"'), 'absolute path or the GC deletes the png');
    assert.ok(html.includes('vscode-wolfram-png-output'));
    assert.ok(html.includes('vscode-wolfram-gfx-marker'), 'marks the output as graphics');
    assert.ok(html.includes('width="360" height="221"'), 'dimensions avoid layout jump');
    assert.ok(!html.includes('data-session-epoch'));
    const meta = r.cells.find(c => c.kind === 2).metadata.nbImport;
    assert.ok(!meta || !meta.graphics, 'applied entries are cleared');
});

test('a picture pasted into an Input cell becomes a markdown image', () => {
    const src = nb(' Cell[BoxData[GraphicsBox[TagBox[RasterBox["zz", {{0, 227.}, {405., 0}}], ' +
                   'Selectable -> False], ImageSizeRaw -> {405., 227.}]], "Input", Evaluatable -> False]');
    const r = M.importNb(src, deps, { mode: 'save' });
    const cell = r.cells[0];
    assert.strictEqual(cell.kind, 1, 'a stored raster is not code');
    assert.ok(/^<!--WBIMG:g\d+-->$/.test(cell.value), 'placeholder token: ' + cell.value);
    assert.strictEqual(r.graphicsTasks.length, 1);
    M.applyGraphics(r.cells, { g1: { absPath: '/abs/x.png', size: { w: 405, h: 227 } } }, 'img/Doc');
    assert.ok(r.cells[0].value.startsWith('<img class="vscode-wolfram-png-output"'), r.cells[0].value);
    assert.ok(r.cells[0].value.includes('width="405" height="227"'));
});

test('the placeholder is invisible markdown, never visible marker text', () => {
    const r = M.importNb(nb(' Cell[BoxData[GraphicsBox[{}]], "Input"]'), deps, { mode: 'save' });
    // An HTML comment renders as nothing, so a reader never sees the token
    // itself while the kernel is still rasterising.
    assert.ok(/^<!--[^>]*-->$/.test(r.cells[0].value), r.cells[0].value);
});

test('an already-rendered PNG is emitted directly, with no placeholder at all', () => {
    const seen = [];
    const withImages = Object.assign({}, deps, {
        resolveImage: (file) => {
            seen.push(file);
            return { absPath: '/abs/img/Doc/' + file, relPath: 'img/Doc/' + file, size: { w: 360, h: 221 } };
        },
    });
    const r = M.importNb(GFX_NB, withImages, { mode: 'save' });
    assert.strictEqual(r.graphicsTasks.length, 0, 'nothing left for the kernel to do');
    assert.strictEqual(seen.length, 1);
    const out = r.cells.find(c => c.kind === 2).outputs[0];
    assert.strictEqual(out.items[0].mime, 'x-application/wolfram-language-html');
    assert.ok(out.items[0].data.includes('src="img/Doc/' + seen[0] + '"'));
    const meta = r.cells.find(c => c.kind === 2).metadata.nbImport;
    assert.ok(!meta || !meta.graphics, 'no patching bookkeeping is needed');
});

test('a cached pasted image resolves straight to an <img> cell', () => {
    const src = nb(' Cell[BoxData[GraphicsBox[TagBox[RasterBox["zz", {{0, 9.}, {9., 0}}]]]], "Input"]');
    const withImages = Object.assign({}, deps, {
        resolveImage: (file) => ({ absPath: '/abs/' + file, relPath: 'img/Doc/' + file, size: { w: 9, h: 9 } }),
    });
    const r = M.importNb(src, withImages, { mode: 'save' });
    assert.strictEqual(r.graphicsTasks.length, 0);
    assert.ok(r.cells[0].value.startsWith('<img class="vscode-wolfram-png-output"'), r.cells[0].value);
});

test('live widgets stay placeholders — there is nothing static to render', () => {
    const src = nb(
        ' Cell[CellGroupData[{\n' +
        '  Cell[BoxData["Manipulate[x,{x,0,1}]"], "Input"],\n' +
        '  Cell[BoxData[DynamicModuleBox[{}, GraphicsBox[{}]]], "Output"]\n' +
        ' }, Open]]'
    );
    const r = M.importNb(src, deps, { mode: 'save' });
    assert.strictEqual(r.graphicsTasks.length, 0, 'must not try to rasterise a widget');
    assert.strictEqual(r.warnings.dynamicOutputs, 1);
    assert.ok(/dynamic/i.test(r.cells.find(c => c.kind === 2).outputs[0].items[0].data));
});

test('unrendered placeholders are replaced with honest prose', () => {
    const r = M.importNb(nb(' Cell[BoxData[GraphicsBox[{}]], "Input"]'), deps, { mode: 'save' });
    M.clearGraphicsPlaceholders(r.cells);
    assert.ok(!/WBIMG:/.test(r.cells[0].value), r.cells[0].value);
    assert.ok(/could not be rendered/.test(r.cells[0].value));
});

test('without the LaTeX addon outputs stay readable text', () => {
    const r = M.importNb(GROUPED, noDeps, { mode: 'save' });
    const code = r.cells.find(c => c.kind === 2);
    assert.strictEqual(code.outputs[0].items.length, 1);
    assert.strictEqual(code.outputs[0].items[0].mime, 'text/plain');
    assert.ok(r.warnings.latexUnavailable >= 1);
    assert.ok(/LaTeX renderer is unavailable/.test(r.cells[0].value), 'banner must say so');
});

// ---------------------------------------------------------------------------
console.log('\n── banner, metadata and failure paths ──');

test('view mode always banners and tags the notebook read-only', () => {
    const r = M.importNb(GROUPED, deps, { mode: 'view' });
    assert.strictEqual(r.cells[0].kind, 1);
    assert.ok(/read-only view/.test(r.cells[0].value));
    assert.ok(/Save .nb copy as .wb/.test(r.cells[0].value));
    assert.ok(r.metadata.wolfbookNbImport, 'save guard marker must be present');
});

test('a clean save-mode import has no banner', () => {
    const r = M.importNb(GROUPED, deps, { mode: 'save' });
    assert.strictEqual(r.cells[0].kind, 2, 'first cell should be the code, not a banner');
});

test('garbage still yields a readable notebook, never a blank one', () => {
    const r = M.importNb('(*^ ancient V2 notebook ^*)\nnot an expression at all', deps, { mode: 'view' });
    assert.strictEqual(r.cells.length, 2);
    assert.ok(/Could not parse/.test(r.cells[0].value));
    assert.ok(r.cells[1].value.includes('ancient V2 notebook'), 'raw source is preserved');
    assert.strictEqual(r.metadata.wolfbookNbImport.failed, true);
    assert.ok(r.metadata.wolfbookNbImport, 'guard marker present even on failure');
});

test('importNb never throws on hostile input', () => {
    for (const bad of ['', 'Notebook[', 'Notebook[{Cell[', NB_HEADER, 'Notebook[{}]',
                       nb(' Cell[]'), nb(' Cell[BoxData[], "Input"]')]) {
        const r = M.importNb(bad, deps, { mode: 'view' });
        assert.ok(Array.isArray(r.cells), 'cells array for input ' + JSON.stringify(bad.slice(0, 20)));
    }
});

test('deep nesting is bounded instead of blowing the stack', () => {
    const deep = 'RowBox[{'.repeat(6000) + '"x"' + '}]'.repeat(6000);
    const r = M.importNb(nb(' Cell[BoxData[' + deep + '], "Input"]'), deps, { mode: 'view' });
    assert.ok(Array.isArray(r.cells));
});

// ---------------------------------------------------------------------------
console.log('\n── serializer guard ──');

function withStubbedVscode(fn) {
    // serializer.js pulls in vscode transitively; stub it before requiring.
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    const stubPath = path.join(__dirname, '__vscode_stub.js');
    fs.writeFileSync(stubPath, 'module.exports = { NotebookCellKind: { Markup: 1, Code: 2 } };\n');
    Module._resolveFilename = function (request, ...rest) {
        if (request === 'vscode') return stubPath;
        return origResolve.call(this, request, ...rest);
    };
    try { return fn(); }
    finally {
        Module._resolveFilename = origResolve;
        try { fs.unlinkSync(stubPath); } catch (_) {}
    }
}

test('saving an imported .nb writes the original bytes back, unchanged', () => {
    return withStubbedVscode(() => {
        const { VSNBContentSerializer } = require('../../serializer');
        const ser = new VSNBContentSerializer();
        const source = NB_HEADER + 'Notebook[{\n Cell["hi", "Text"]\n}]\n';
        // Cells deliberately mutated: a save must NOT persist them over the .nb.
        return ser.serializeNotebook({
            cells: [{ kind: 2, value: 'user edited this', languageId: 'wolfram', outputs: [], metadata: {} }],
            metadata: { wolfbookNbImport: { version: 1, source } },
        }).then(bytes => {
            assert.strictEqual(new (require('util').TextDecoder)().decode(bytes), source,
                              'the .nb must be byte-identical after a save');
        });
    });
});

test('without the original source, saving is refused rather than guessed', () => {
    return withStubbedVscode(() => {
        const { VSNBContentSerializer } = require('../../serializer');
        const ser = new VSNBContentSerializer();
        let threw = false;
        return ser.serializeNotebook({ cells: [], metadata: { wolfbookNbImport: { version: 1 } } })
            .catch(() => { threw = true; })
            .then(() => { assert.ok(threw, 'must reject — never write .wb JSON over a .nb'); });
    });
});

test('importNb keeps the original source for that round trip', () => {
    const src = nb(' Cell["x", "Text"]');
    const r = M.importNb(src, deps, { mode: 'view' });
    assert.strictEqual(r.metadata.wolfbookNbImport.source, src);
    assert.ok(r.metadata.wolfbookNbImport.importId, 'importId keys the graphics side table');
});

test('tested modules stay free of vscode', () => {
    const loaded = Object.keys(require.cache).filter(k => /[\\/]nb-import[\\/](wlParser|nbModel)\.js$/.test(k));
    assert.strictEqual(loaded.length, 2, 'both modules loaded');
    for (const k of loaded) {
        const mod = require.cache[k];
        assert.ok(!mod.children.some(c => /vscode/.test(c.id)), k + ' must not require vscode');
    }
});

// ---------------------------------------------------------------------------
console.log('\n── real files (skipped when absent) ──');

const REAL = [
    { p: '/Users/k0959535/Dropbox/MY/MSSTP2014/baxter.nb', check: (r) => {
        const withOut = r.cells.filter(c => c.outputs && c.outputs.length);
        assert.ok(withOut.length >= 3, 'expected several outputs, got ' + withOut.length);
        assert.ok(!r.warnings.cellErrors, 'no cell errors');
        assert.ok(r.cells.some(c => c.value.includes('->')), 'rules must survive as ->');
        for (const c of r.cells) assert.ok(!/[-]/.test(c.value), 'no PUA leaked into cell text');
    } },
    { p: '/Users/k0959535/Dropbox/MY/Programming/VSCodeWolframExtension/Wolfbook Presentations/2026 Porto/live_presentation/Practice/Part1.nb',
      check: (r) => {
        assert.strictEqual(r.cells[1].value, '# ACT 1 — "Almost Mathematica"');
        assert.ok(!r.warnings.cellErrors);
    } },
];
for (const { p: fp, check } of REAL) {
    const name = 'real: ' + path.basename(fp);
    if (!fs.existsSync(fp)) { results.push('  – ' + name + ' (not present)'); continue; }
    test(name, () => check(M.importNb(fs.readFileSync(fp, 'utf8'), deps, { mode: 'view' })));
}

test('perf: a 4 MB CompressedData notebook imports quickly', () => {
    const blob = 'x'.repeat(4 * 1024 * 1024);
    const src = nb(' Cell[BoxData[RowBox[{"g", "=", "\\"' + blob + '\\""}]], "Input"]');
    const t0 = Date.now();
    const r = M.importNb(src, deps, { mode: 'view' });
    const ms = Date.now() - t0;
    assert.ok(Array.isArray(r.cells));
    assert.ok(ms < 4000, 'took ' + ms + 'ms');
});

// ---------------------------------------------------------------------------
setTimeout(() => {
    console.log('\n' + results.join('\n'));
    console.log('\n' + (fail === 0 ? '✅' : '❌') + `  ${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
}, 200);
