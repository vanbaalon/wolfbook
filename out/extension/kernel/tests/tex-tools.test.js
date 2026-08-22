// Stage 1, vscode-facing half: the paper_* tools and the diagnostics.
//
//   node out/extension/kernel/tests/tex-tools.test.js
//
// Uses the shared fake vscode from _stub-vscode.js. The stub does not model
// TextDocuments (it was written for notebooks), so this suite extends it with
// the small text-document surface these tools actually touch — which is itself
// the useful constraint: if a tool needs more of vscode than can be faked in
// forty lines, it is doing too much in the wrong place.

const assert = require('assert');
const { withVscodeStub, makeVscodeStub } = require('./_stub-vscode');

let pass = 0; let fail = 0;
const results = [];
function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { pass++; results.push('  ok   ' + name); })
        .catch((e) => { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); });
}

// --- a text-document world on top of the notebook stub ----------------------

function makeTextDoc(fsPath, text) {
    let version = 1;
    const doc = {
        uri: { fsPath, scheme: 'file', path: fsPath, toString: () => 'file://' + fsPath },
        languageId: 'latex',
        get version() { return version; },
        get lineCount() { return text.split('\n').length; },
        getText: () => text,
        positionAt: (off) => {
            const before = text.slice(0, off).split('\n');
            return { line: before.length - 1, character: before[before.length - 1].length };
        },
        offsetAt: (pos) => {
            const lines = text.split('\n');
            let o = 0;
            for (let i = 0; i < pos.line; i++) o += lines[i].length + 1;
            return o + pos.character;
        },
        lineAt: (n) => ({ range: { start: { line: n, character: 0 }, end: { line: n, character: 999 } } }),
        save: async () => true,
        _apply(range, newText) {
            const from = doc.offsetAt(range.start);
            const to = doc.offsetAt(range.end);
            text = text.slice(0, from) + newText + text.slice(to);
            version++;
        },
    };
    return doc;
}

function texStub(docs) {
    const applied = [];
    const stub = makeVscodeStub({
        workspace: {
            textDocuments: docs,
            workspaceFolders: [{ uri: { fsPath: '/proj', path: '/proj' } }],
            getConfiguration: () => ({ get: (_k, d) => d }),
            applyEdit: async (we) => {
                for (const e of we._edits) {
                    const doc = docs.find(d => d.uri.fsPath === e.uri.fsPath);
                    if (!doc) return false;
                    doc._apply(e.range, e.newText);
                    applied.push(e);
                }
                return true;
            },
            fs: { readFile: async () => { throw new Error('ENOENT'); } },
            onDidOpenTextDocument: () => ({ dispose() {} }),
            onDidSaveTextDocument: () => ({ dispose() {} }),
            onDidCloseTextDocument: () => ({ dispose() {} }),
            onDidChangeTextDocument: () => ({ dispose() {} }),
        },
        window: { activeTextEditor: undefined },
    });
    stub.Range = class { constructor(start, end) { this.start = start; this.end = end; } };
    stub.Position = class { constructor(line, character) { this.line = line; this.character = character; } };
    stub.Selection = stub.Range;
    stub.MarkdownString = class { constructor(v) { this.value = v; } };
    stub.WorkspaceEdit = class {
        constructor() { this._edits = []; }
        replace(uri, range, newText) { this._edits.push({ uri, range, newText }); }
    };
    // The notebook stub predates .tex support and has no Uri.joinPath.
    stub.Uri = { ...stub.Uri, joinPath: (base, ...bits) => {
        const path = require('path');
        const p = path.join(base.fsPath ?? base.path, ...bits);
        return { fsPath: p, scheme: 'file', path: p, toString: () => 'file://' + p };
    } };
    stub.SymbolKind = { Namespace: 2, Operator: 24, File: 0, Struct: 22, Interface: 10,
        Constant: 13, String: 14, Array: 17, Object: 18 };
    stub.DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
    stub.Diagnostic = class { constructor(range, message, severity) {
        this.range = range; this.message = message; this.severity = severity; } };
    stub.FoldingRange = class { constructor(s, e, k) { this.start = s; this.end = e; this.kind = k; } };
    stub.FoldingRangeKind = { Comment: 1 };
    stub.DocumentSymbol = class { constructor(name, detail, kind, range, sel) {
        this.name = name; this.detail = detail; this.kind = kind;
        this.range = range; this.selectionRange = sel; this.children = []; } };
    stub.CodeLens = class { constructor(range, command) { this.range = range; this.command = command; } };
    // Stage 2 surfaces (status bar, decorations, output channel).
    stub.ThemeColor = class { constructor(id) { this.id = id; } };
    stub.StatusBarAlignment = { Left: 1, Right: 2 };
    stub.DecorationRangeBehavior = { ClosedClosed: 1 };
    stub.TextEditorRevealType = { InCenter: 2 };
    stub.EventEmitter = stub.EventEmitter || class {
        constructor() { this._h = []; this.event = (fn) => { this._h.push(fn); return { dispose() {} }; }; }
        fire(v) { for (const f of this._h) { try { f(v); } catch (_) {} } }
        dispose() { this._h = []; }
    };
    stub.__applied = applied;
    return stub;
}

// EVERY test must get a module bound to ITS OWN stub. Node caches by resolved
// path, so without this the second test onwards silently runs against the FIRST
// test's fake vscode — which showed up as edits landing in the wrong document
// and an ambiguity check reporting a file from a previous case.
// Every vscode-touching module under test, not just the entry points: a module
// left in the cache stays bound to whichever stub first loaded it. renderUi was
// missing here and reported `createTextEditorDecorationType is not a function`
// against a stub that plainly defines it.
const UNDER_TEST = ['../../tools/tex-tools', '../../tex/index', '../../tex/renderUi', '../../tex/texViewer'];
function freshRequire(mod, stub) {
    for (const m of UNDER_TEST) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
    return withVscodeStub(() => require(mod), stub);
}

const PAPER = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\section{Strong coupling}
\\label{sec:strong}
The dressed dispersion relation is recorded here, with enough words in this
paragraph that it registers as prose rather than as markup.
\\begin{equation}
\\label{eq:dispersion}
E(p) = \\sqrt{1 + 16 g^2 \\sin^2 \\tfrac{p}{2}}
\\end{equation}
which reduces to \\eqref{eq:uniform} in the weak-coupling limit, as shown
in \\cite{Gromov:2013pga}.
\\section{Numerics}
\\begin{figure}[t]
\\centering
\\rule{4cm}{3cm}
\\caption{Branch structure.}
\\label{fig:branch}
\\end{figure}
\\end{document}`;

// The stub's LanguageModelToolResult stores its parts on `.content` (see
// _stub-vscode.js); real vscode exposes them the same way.
const text = (res) => (res && Array.isArray(res.content))
    ? res.content.map(p => (p && p.value != null ? p.value : String(p))).join('')
    : String(res);
const json = (res) => JSON.parse(text(res));

async function main() {
    // ---- paper_* tools ----------------------------------------------------
    await test('paper_getOutline reports sections, counts and warnings', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const stub = texStub([doc]);
        const T = freshRequire('../../tools/tex-tools', stub);
        const r = json(await new T.PaperGetOutlineTool().invoke({ input: { file: '/proj/paper.tex' } }));
        assert.strictEqual(r.outline.length, 2, 'two sections');
        assert.strictEqual(r.outline[0].title, 'Strong coupling');
        assert.ok(r.counts['display-equation'] >= 1);
        assert.ok(r.counts.figure >= 1);
    });

    await test('paper_getObject addresses an equation by its \\label', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const stub = texStub([doc]);
        const T = freshRequire('../../tools/tex-tools', stub);
        const r = json(await new T.PaperGetObjectTool().invoke({
            input: { file: '/proj/paper.tex', selector: 'eq:dispersion' },
        }));
        assert.strictEqual(r.kind, 'display-equation');
        assert.strictEqual(r.label, 'eq:dispersion');
        assert.ok(/E\(p\)/.test(r.text), 'returns the source');
        assert.ok(/^[0-9a-f]{64}$/.test(r.sourceHash), 'and a full sha256 to guard with');
    });

    await test('paper_getObject on a miss lists real keys instead of just failing', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const T = freshRequire('../../tools/tex-tools', texStub([doc]));
        const t = text(await new T.PaperGetObjectTool().invoke({
            input: { file: '/proj/paper.tex', selector: 'eq:nope' },
        }));
        assert.ok(/^Error:/.test(t));
        assert.ok(/Some keys in this file/.test(t), 'the error is actionable');
    });

    await test('paper_getSection returns the section and what is inside it', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const T = freshRequire('../../tools/tex-tools', texStub([doc]));
        const r = json(await new T.PaperGetSectionTool().invoke({
            input: { file: '/proj/paper.tex', selector: 'Numerics' },
        }));
        assert.strictEqual(r.section.title, 'Numerics');
        assert.ok(r.objects.some(o => o.kind === 'figure'), 'the figure is inside Numerics');
        assert.ok(!r.objects.some(o => o.label === 'eq:dispersion'), 'the equation is NOT');
    });

    await test('paper_findReferences finds an unresolved \\ref', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const T = freshRequire('../../tools/tex-tools', texStub([doc]));
        const r = json(await new T.PaperFindReferencesTool().invoke({ input: { file: '/proj/paper.tex' } }));
        assert.ok(r.unresolvedRefs.some(x => x.target === 'eq:uniform'),
            'eq:uniform is referenced but never declared');
        assert.deepStrictEqual(r.duplicateLabels, []);
    });

    await test('paper_findReferences on one name reports who uses it', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const T = freshRequire('../../tools/tex-tools', texStub([doc]));
        const r = json(await new T.PaperFindReferencesTool().invoke({
            input: { file: '/proj/paper.tex', name: 'eq:dispersion' },
        }));
        assert.strictEqual(r.declaredIn.length, 1);
        assert.ok(r.attachedTo && r.attachedTo.kind === 'display-equation');
    });

    await test('paper_search finds objects by text and returns their keys', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const T = freshRequire('../../tools/tex-tools', texStub([doc]));
        const r = json(await new T.PaperSearchTool().invoke({
            input: { file: '/proj/paper.tex', query: 'dispersion' },
        }));
        assert.ok(r.matches >= 1);
        assert.ok(r.hits[0].stableKey, 'hits carry an address');
        assert.ok(r.hits[0].excerpt);
    });

    await test('paper_search reports a bad regex instead of throwing', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const T = freshRequire('../../tools/tex-tools', texStub([doc]));
        const t = text(await new T.PaperSearchTool().invoke({
            input: { file: '/proj/paper.tex', query: '([', regex: true },
        }));
        assert.ok(/bad regex/.test(t));
    });

    // ---- the guard, which is the point of the write side ------------------
    await test('paper_previewEdit writes nothing and hands back the guard hash', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const stub = texStub([doc]);
        const T = freshRequire('../../tools/tex-tools', stub);
        const r = json(await new T.PaperPreviewEditTool().invoke({
            input: {
                file: '/proj/paper.tex', selector: 'eq:dispersion',
                new_text: '\\begin{equation}\\label{eq:dispersion}\nE = 1\n\\end{equation}',
            },
        }));
        assert.strictEqual(r.applied, false);
        assert.strictEqual(doc.getText(), PAPER, 'the document is untouched');
        assert.ok(/^[0-9a-f]{64}$/.test(r.sourceHash));
        assert.ok(r.before.includes('E(p)') && r.after.includes('E = 1'));
        assert.strictEqual(stub.__applied.length, 0);
    });

    await test('paper_previewEdit warns when a replacement would break the structure', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const T = freshRequire('../../tools/tex-tools', texStub([doc]));
        const r = json(await new T.PaperPreviewEditTool().invoke({
            input: {
                file: '/proj/paper.tex', selector: 'eq:dispersion',
                new_text: '\\begin{equation}\nE = 1\n',   // no \end
            },
        }));
        assert.ok(r.introducesWarnings.length >= 1,
            'an unbalanced environment must be visible BEFORE it is written');
    });

    await test('AN EDIT IS REFUSED WHEN THE FILE CHANGED ON DISK', async () => {
        // The object hash guard proves the OBJECT still looks right. It says
        // nothing about a copy on disk that Dropbox or a collaborator replaced
        // while the agent was thinking, and applying on top of that silently
        // destroys their change. This uses a REAL file so the guard is
        // exercised through the same fs it uses in production.
        const nodeFs = require('fs');
        const nodeOs = require('os');
        const nodePath = require('path');
        const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wbtex-tools-'));
        const file = nodePath.join(dir, 'paper.tex');
        try {
            // Disk holds something DIFFERENT from what the agent read.
            nodeFs.writeFileSync(file, PAPER.replace('E(p)', 'SOMEONE ELSE WROTE THIS'));
            const doc = makeTextDoc(file, PAPER);           // clean buffer, stale content
            const stub = texStub([doc]);
            const T = freshRequire('../../tools/tex-tools', stub);
            const before = json(await new T.PaperGetObjectTool().invoke({
                input: { file, selector: 'eq:dispersion' },
            }));
            const r = json(await new T.PaperApplyEditTool().invoke({
                input: {
                    file, selector: 'eq:dispersion',
                    new_text: '\\begin{equation}\\label{eq:dispersion}\nE = 1\n\\end{equation}',
                    expected_source_hash: before.sourceHash,
                },
            }));
            assert.strictEqual(r.conflict, 'file-changed-on-disk', JSON.stringify(r).slice(0, 200));
            assert.ok(/changed on disk/.test(r.reason), r.reason);
            assert.ok(/^[0-9a-f]{64}$/.test(r.disk_hash), 'it says what disk holds now');
            assert.strictEqual(stub.__applied.length, 0, 'and NOTHING was written');
            assert.strictEqual(doc.getText(), PAPER, 'the buffer is untouched too');

            // With disk and buffer in agreement the very same edit goes through.
            nodeFs.writeFileSync(file, PAPER);
            const doc2 = makeTextDoc(file, PAPER);
            const stub2 = texStub([doc2]);
            const T2 = freshRequire('../../tools/tex-tools', stub2);
            const ok2 = json(await new T2.PaperApplyEditTool().invoke({
                input: {
                    file, selector: 'eq:dispersion',
                    new_text: '\\begin{equation}\\label{eq:dispersion}\nE = 1\n\\end{equation}',
                    expected_source_hash: before.sourceHash,
                },
            }));
            assert.strictEqual(ok2.applied, true, JSON.stringify(ok2).slice(0, 200));
        } finally {
            try { nodeFs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* fine */ }
        }
    });

    await test('paper_applyEdit applies through WorkspaceEdit and reports the range', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const stub = texStub([doc]);
        const T = freshRequire('../../tools/tex-tools', stub);
        const before = json(await new T.PaperGetObjectTool().invoke({
            input: { file: '/proj/paper.tex', selector: 'eq:dispersion' },
        }));
        const r = json(await new T.PaperApplyEditTool().invoke({
            input: {
                file: '/proj/paper.tex', selector: 'eq:dispersion',
                new_text: '\\begin{equation}\\label{eq:dispersion}\nE = 1\n\\end{equation}',
                expected_source_hash: before.sourceHash,
            },
        }));
        assert.strictEqual(r.applied, true);
        assert.ok(!r.unguarded, 'a guarded edit is not flagged');
        assert.ok(doc.getText().includes('E = 1'), 'the document changed');
        assert.ok(!doc.getText().includes('16 g^2'), 'the old body is gone');
        assert.strictEqual(stub.__applied.length, 1, 'exactly one WorkspaceEdit');
    });

    await test('A STALE EDIT IS REJECTED — the Stage 1 exit criterion', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const stub = texStub([doc]);
        const T = freshRequire('../../tools/tex-tools', stub);

        // Agent reads the object...
        const seen = json(await new T.PaperGetObjectTool().invoke({
            input: { file: '/proj/paper.tex', selector: 'eq:dispersion' },
        }));
        // ...someone else edits it underneath...
        await new T.PaperApplyEditTool().invoke({
            input: {
                file: '/proj/paper.tex', selector: 'eq:dispersion',
                new_text: '\\begin{equation}\\label{eq:dispersion}\nE = 999\n\\end{equation}',
                expected_source_hash: seen.sourceHash,
            },
        });
        // ...and the agent now tries to write what it planned against the OLD text.
        const r = json(await new T.PaperApplyEditTool().invoke({
            input: {
                file: '/proj/paper.tex', selector: 'eq:dispersion',
                new_text: '\\begin{equation}\\label{eq:dispersion}\nE = 2\n\\end{equation}',
                expected_source_hash: seen.sourceHash,
            },
        }));
        assert.strictEqual(r.state, 'conflict', 'the stale edit is refused');
        assert.ok(doc.getText().includes('E = 999'), "the other change survived");
        assert.ok(!doc.getText().includes('E = 2'), 'ours was not written');
        assert.ok(/^[0-9a-f]{64}$/.test(r.source_hash), 'and the CURRENT hash is handed back');
        assert.ok(r.first_line, 'with something to re-orient on');
    });

    await test('an unguarded edit still works but says so', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const T = freshRequire('../../tools/tex-tools', texStub([doc]));
        const r = json(await new T.PaperApplyEditTool().invoke({
            input: {
                file: '/proj/paper.tex', selector: 'eq:dispersion',
                new_text: '\\begin{equation}\\label{eq:dispersion}\nE = 3\n\\end{equation}',
            },
        }));
        assert.strictEqual(r.applied, true);
        assert.strictEqual(r.unguarded, true);
        assert.ok(/expected_source_hash/.test(r.unguarded_note));
    });

    await test('expected_stable_key and expected_object_id also guard', async () => {
        const doc = makeTextDoc('/proj/paper.tex', PAPER);
        const T = freshRequire('../../tools/tex-tools', texStub([doc]));
        const r = json(await new T.PaperApplyEditTool().invoke({
            input: {
                file: '/proj/paper.tex', selector: 'eq:dispersion',
                new_text: 'x', expected_stable_key: 'not/the/right/key',
            },
        }));
        assert.strictEqual(r.state, 'conflict');
        assert.strictEqual(doc.getText(), PAPER, 'nothing was written');
    });

    await test('paper_applyEdit refuses a file that is not open, and explains why', async () => {
        const T = freshRequire('../../tools/tex-tools', texStub([]));
        const t = text(await new T.PaperApplyEditTool().invoke({
            input: { file: '/proj/absent.tex', selector: 'x', new_text: 'y' },
        }));
        assert.ok(/^Error:/.test(t));
    });

    await test('an ambiguous bare filename is reported, not guessed', async () => {
        const a = makeTextDoc('/proj/one/paper.tex', PAPER);
        const b = makeTextDoc('/proj/two/paper.tex', PAPER);
        const T = freshRequire('../../tools/tex-tools', texStub([a, b]));
        const t = text(await new T.PaperGetOutlineTool().invoke({ input: { file: 'paper.tex' } }));
        assert.ok(/ambiguous/.test(t), t.slice(0, 120));
        assert.ok(t.includes('/proj/one/paper.tex') && t.includes('/proj/two/paper.tex'));
    });

    await test('paper_mathematicaBlocks classifies without executing', async () => {
        const { sha256 } = require('../../tex/texModel');
        const code = 'Plot[x, {x, 0, 1}]';
        const body = '\\begin{figure}\\rule{1cm}{1cm}\\end{figure}';
        const src = [
            '\\documentclass{article}', '\\begin{document}',
            '%Mathematica[figure]', '% ' + code, '%EndMathematica',
            `%WolfbookOutputBegin[CellID: c1, SourceHash: ${sha256(code).slice(0, 8)}, OutputHash: ${sha256(body).slice(0, 8)}]`,
            body, '%WolfbookOutputEnd',
            '%Mathematica[expression]', '% 1 + 1', '%EndMathematica',
            '\\end{document}',
        ].join('\n');
        const doc = makeTextDoc('/proj/mma.tex', src);
        const T = freshRequire('../../tools/tex-tools', texStub([doc]));
        const r = json(await new T.PaperMathematicaBlocksTool().invoke({ input: { file: '/proj/mma.tex' } }));
        assert.strictEqual(r.total, 2);
        assert.strictEqual(r.byState.fresh, 1);
        assert.strictEqual(r.byState['no-output'], 1);
        assert.ok(/Stage 4/.test(r.note), 'the tool says execution is not available');
        assert.strictEqual(r.blocks[0].code, undefined, 'code is opt-in');
    });

    // ---- diagnostics ------------------------------------------------------
    await test('diagnostics flag unresolved refs, duplicate labels and stale blocks', async () => {
        const src = PAPER
            .replace('\\label{fig:branch}', '\\label{eq:dispersion}')       // duplicate
            + '\n%Mathematica\n% 1+1\n%EndMathematica\n'
            + '%WolfbookOutputBegin[CellID: z, SourceHash: deadbeef, OutputHash: deadbeef]\nq\n%WolfbookOutputEnd\n';
        const doc = makeTextDoc('/proj/diag.tex', src);
        const stub = texStub([doc]);
        const M = freshRequire('../../tex/index', stub);
        const proj = new M.Projection();
        const ds = M.computeDiagnostics(doc, proj, {});
        const codes = ds.map(d => d.code);
        assert.ok(codes.includes('unresolved-ref'), 'eq:uniform');
        assert.ok(codes.includes('duplicate-label'), 'eq:dispersion declared twice');
        assert.ok(codes.includes('stale-output'), 'the managed block is stale');
        assert.ok(ds.every(d => d.source === 'wolfbook-tex'), 'all attributed to us');
    });

    await test('citations are NOT flagged when the bibliography cannot be read', async () => {
        // Every paper with an external .bib would otherwise light up red.
        const doc = makeTextDoc('/proj/diag.tex', PAPER);
        const M = freshRequire('../../tex/index', texStub([doc]));
        const ds = M.computeDiagnostics(doc, new M.Projection(), { bibKeys: null });
        assert.ok(!ds.some(d => d.code === 'unresolved-cite'));
    });

    await test('citations ARE flagged when the keys are known', async () => {
        const doc = makeTextDoc('/proj/diag.tex', PAPER);
        const M = freshRequire('../../tex/index', texStub([doc]));
        const ds = M.computeDiagnostics(doc, new M.Projection(), { bibKeys: new Set(['Someone:Else']) });
        assert.ok(ds.some(d => d.code === 'unresolved-cite' && /Gromov:2013pga/.test(d.message)));
    });

    await test('the projection reuses its model until the document version moves', async () => {
        const doc = makeTextDoc('/proj/p.tex', PAPER);
        const M = freshRequire('../../tex/index', texStub([doc]));
        const proj = new M.Projection();
        const a = proj.get(doc);
        const b = proj.get(doc);
        assert.strictEqual(a, b, 'same version -> same object, no re-scan');
        const id = a.model.objects.find(o => o.label === 'eq:dispersion').objectId;
        doc._apply({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, '% touched\n');
        const c = proj.get(doc);
        assert.notStrictEqual(c, a, 'a new version re-scans');
        assert.strictEqual(
            c.model.objects.find(o => o.label === 'eq:dispersion').objectId, id,
            'and identity is carried across the edit');
    });

    // ---- registration surface --------------------------------------------
    await test('registerTexSupport wires providers and honours the enable flag', async () => {
        const doc = makeTextDoc('/proj/p.tex', PAPER);
        const stub = texStub([doc]);
        const registered = [];
        stub.languages = {
            createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }),
            registerDocumentSymbolProvider: (...a) => { registered.push('symbols'); return { dispose() {} }; },
            registerFoldingRangeProvider: (...a) => { registered.push('folding'); return { dispose() {} }; },
            registerCodeLensProvider: (...a) => { registered.push('codelens'); return { dispose() {} }; },
            // Reference intelligence: what a \ref/\cite actually points at.
            registerHoverProvider: (...a) => { registered.push('hover'); return { dispose() {} }; },
            registerDefinitionProvider: (...a) => { registered.push('definition'); return { dispose() {} }; },
            registerReferenceProvider: (...a) => { registered.push('references'); return { dispose() {} }; },
            // Paste a picture, get a figure. Guarded on the host having the
            // API at all, so the stub must offer both halves of that guard.
            registerDocumentPasteEditProvider: (...a) => { registered.push('paste'); return { dispose() {} }; },
        };
        stub.DocumentPasteEditKind = { Text: 'text' };
        stub.extensions = { getExtension: () => undefined };
        stub.window = {
            ...stub.window,
            createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
            createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '' }),
            createTextEditorDecorationType: () => ({ dispose() {} }),
            onDidChangeActiveTextEditor: () => ({ dispose() {} }),
            onDidChangeTextEditorSelection: () => ({ dispose() {} }),
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            setStatusBarMessage: () => ({ dispose() {} }),
            showInputBox: async () => undefined,
            activeTextEditor: undefined,
        };
        const cmds = [];
        stub.commands = { registerCommand: (id) => { cmds.push(id); return { dispose() {} }; }, executeCommand: async () => {} };
        stub.EventEmitter = class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} };
        stub.SymbolKind = new Proxy({}, { get: () => 1 });
        stub.DiagnosticSeverity = { Warning: 1, Information: 2 };

        const M = freshRequire('../../tex/index', stub);
        const ctx = { subscriptions: [] };
        const api = M.registerTexSupport(ctx);
        assert.ok(api, 'returns its handles');
        assert.deepStrictEqual(registered.sort(),
            ['codelens', 'definition', 'folding', 'hover', 'paste', 'references', 'symbols']);
        assert.ok(cmds.includes('wolfbook.tex.showProjection'));
        assert.ok(ctx.subscriptions.length > 0, 'everything is disposable');
    });

    await test('registerTexSupport is a no-op when disabled', async () => {
        const stub = texStub([]);
        stub.workspace.getConfiguration = () => ({ get: (k, d) => (k === 'enable' ? false : d) });
        const M = freshRequire('../../tex/index', stub);
        const ctx = { subscriptions: [] };
        assert.strictEqual(M.registerTexSupport(ctx), null);
        assert.strictEqual(ctx.subscriptions.length, 0);
    });

    // ---- package.json contract -------------------------------------------
    await test('every registered paper_* tool is declared in package.json', () => {
        const pkg = require('../../../../package.json');
        const declared = new Set(pkg.contributes.languageModelTools.map(t => t.name));
        const expected = ['paper_getOutline', 'paper_getObject', 'paper_getSection',
            'paper_findReferences', 'paper_search', 'paper_mathematicaBlocks',
            'paper_previewEdit', 'paper_applyEdit'];
        for (const n of expected) assert.ok(declared.has(n), `${n} is not contributed`);
    });

    await test('no paper_* inputSchema uses oneOf/allOf/anyOf', () => {
        // sanitizeInputSchema (claude-mcp/server.js) strips them recursively,
        // so a schema that relies on them is silently different over MCP than
        // it is in the chat panel.
        const pkg = require('../../../../package.json');
        const bad = [];
        const walk = (name, node) => {
            if (!node || typeof node !== 'object') return;
            for (const k of ['oneOf', 'allOf', 'anyOf']) if (k in node) bad.push(`${name}.${k}`);
            for (const v of Object.values(node)) walk(name, v);
        };
        for (const t of pkg.contributes.languageModelTools) {
            if (t.name.startsWith('paper_')) walk(t.name, t.inputSchema);
        }
        assert.deepStrictEqual(bad, []);
    });

    await test('activation can actually reach a .tex file', () => {
        const pkg = require('../../../../package.json');
        const ae = pkg.activationEvents || [];
        assert.ok(ae.includes('onLanguage:latex') || ae.includes('workspaceContains:**/*.tex'),
            'the extension would never wake for a .tex without this');
    });

    await test('we do NOT contribute a latex language (LaTeX Workshop owns it)', () => {
        const pkg = require('../../../../package.json');
        const ids = (pkg.contributes.languages || []).map(l => l.id);
        assert.ok(!ids.includes('latex') && !ids.includes('tex'),
            'contributing it would start a grammar fight with LaTeX Workshop');
        const exts = (pkg.contributes.languages || []).flatMap(l => l.extensions || []);
        assert.ok(!exts.includes('.tex'), '.tex must not be claimed by a Wolfbook language');
    });

    // ---------------------------------------------------------------------
    console.log('tex tools + providers (vscode-facing)\n');
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

main();
