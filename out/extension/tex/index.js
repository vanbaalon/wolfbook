// index.js — THE ONLY MODULE IN tex/ THAT TOUCHES VSCODE.
//
// texScanner / texModel / mmaBlocks / texProject are pure and stay that way;
// kernel/tests/tex-model.test.js asserts they never pull vscode into the
// require cache. Everything vscode-shaped lives here.
//
// Wired from extension.js with a single line:
//     require('./tex/index').registerTexSupport(context);
//
// STAGE 1 SCOPE: Document Symbols, folding, CodeLens, deterministic
// diagnostics, and the projection cache the paper_* tools read. No rendering,
// no compiling, no execution.
//
// COEXISTENCE WITH LATEX WORKSHOP (vision §73): it owns the `latex` language
// id, syntax, snippets, completion and the build UI. We contribute NO language
// and NO grammar, and when it is installed we drop the diagnostics it already
// produces. Detect, do not fight.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { scanTex, preambleSpan } = require('./texScanner');
const { buildModel, reconcile, buildOutline, sectionSpans, ADDRESSABLE } = require('./texModel');
const { parseMmaBlocks, BLOCK_STATE } = require('./mmaBlocks');
const { findRoot, buildGraph } = require('./texProject');
const {
    RenderCoordinator, makeStatusItem, makePageMarkers, applyPageMarkers, renderDiagnostics,
} = require('./renderUi');
const { TexViewer, VIEW_TYPE: TEX_VIEW_TYPE } = require('./texViewer');
const { DiskWatch, VERDICT } = require('./diskGuard');
const texVersions = require('./texVersions');
const {
    PASTE_MIMES, imagePathFor, figureSnippet, insideFloat, hasGraphicx, findImageItem,
} = require('./texPaste');
const { refAt, resolveRef, hoverMarkdown } = require('./refIntel');
const { readAuxLabels } = require('./auxLabels');
const { readClipboardImage } = require('./texClipboard');

const TEX_SELECTOR = [
    { language: 'latex', scheme: 'file' },
    { language: 'tex', scheme: 'file' },
    { pattern: '**/*.tex', scheme: 'file' },
];

const DEBOUNCE_MS = 150;   // the semantic-update budget from the plan

/** Per-document projection, rebuilt on a debounce and reconciled for identity. */
class Projection {
    constructor() {
        this._models = new Map();   // fsPath -> model
        this._timers = new Map();
        this._emitter = new vscode.EventEmitter();
        this.onDidChange = this._emitter.event;
    }

    /** Synchronous, cached. Rebuilds only when the version moved. */
    get(doc) {
        const key = doc.uri.fsPath;
        const prev = this._models.get(key);
        if (prev && prev.version === doc.version) return prev;

        const text = doc.getText();
        const scan = scanTex(text, { file: key });
        const model = buildModel(scan, { file: key });
        // Carry objectIds across the edit. Without this, every keystroke would
        // hand an agent a fresh set of ids for the same equations, and a
        // hash-guarded edit would be guarding an object that no longer exists
        // by the time it was applied.
        // NOTE `prev.model`, not `prev`: the cache entry is a wrapper around
        // the model. Passing the wrapper threw `prev.objects is not iterable`
        // inside reconcile, which the debounced rebuild swallowed — so identity
        // silently never carried at all until a test looked.
        if (prev && prev.model) reconcile(prev.model, model);
        const mma = parseMmaBlocks(text, { file: key });

        const value = { version: doc.version, scan, model, mma, text, fsPath: key };
        this._models.set(key, value);
        return value;
    }

    /**
     * A model for a file VS Code does NOT have open.
     *
     * `get` needs a TextDocument, and on a split paper only the root is
     * normally open — yet a label declared in `sections/intro.tex` is still a
     * label of this paper. Uncached on purpose: the callers that need this
     * (the label overlay) do their own per-generation caching, and caching a
     * model with no version to invalidate it against would go stale silently.
     *
     * @param {string} text
     * @param {string} file  absolute path, so object ids match the open path
     */
    fromText(text, file) {
        try {
            const scan = scanTex(String(text || ''), { file });
            return buildModel(scan, { file });
        } catch (_) { return null; }
    }

    /** Debounced rebuild + notify, for the keystroke path. */
    schedule(doc) {
        const key = doc.uri.fsPath;
        clearTimeout(this._timers.get(key));
        this._timers.set(key, setTimeout(() => {
            this._timers.delete(key);
            try {
                this.get(doc);
                this._emitter.fire(doc);
            } catch (_) { /* the scanner never throws, but never say never */ }
        }, DEBOUNCE_MS));
    }

    forget(doc) {
        const key = doc.uri.fsPath;
        clearTimeout(this._timers.get(key));
        this._timers.delete(key);
        this._models.delete(key);
    }

    dispose() {
        for (const t of this._timers.values()) clearTimeout(t);
        this._timers.clear();
        this._models.clear();
        this._emitter.dispose();
    }
}

const isTex = (doc) => !!doc && /\.tex$/i.test(doc.uri.fsPath);

// --- Document Symbols -------------------------------------------------------

// Built lazily, not at module load: reading vscode.SymbolKind at require time
// makes the whole module unloadable anywhere the enum is absent, which turns a
// cosmetic dependency into a hard one for no benefit.
let _symbolKind = null;
function symbolKinds() {
    if (_symbolKind) return _symbolKind;
    const K = vscode.SymbolKind || {};
    _symbolKind = {
        'section-heading': K.Namespace ?? 2,
        'display-equation': K.Operator ?? 24,
        figure: K.File ?? 0,
        table: K.Struct ?? 22,
        tabular: K.Struct ?? 22,
        theorem: K.Interface ?? 10,
        abstract: K.Constant ?? 13,
        verbatim: K.String ?? 14,
        list: K.Array ?? 17,
        environment: K.Object ?? 18,
    };
    return _symbolKind;
}

function makeSymbolProvider(projection) {
    return {
        provideDocumentSymbols(doc) {
            const { model } = projection.get(doc);
            const range = (o) => new vscode.Range(
                doc.positionAt(o.sourceRange.startOffset),
                doc.positionAt(o.sourceRange.endOffset));

            const headings = model.objects.filter(o => o.kind === 'section-heading');
            const symbolFor = (o) => {
                const label = o.kind === 'section-heading'
                    ? (o.title || '(untitled)')
                    : `${o.envName || o.kind}${o.label ? ' · ' + o.label : ''}`;
                return new vscode.DocumentSymbol(
                    label, o.kind, symbolKinds()[o.kind] ?? (vscode.SymbolKind?.Object ?? 18),
                    range(o), range(o));
            };

            // Sections nest; everything else hangs off the section it is in, so
            // the outline reads like the paper rather than like the file.
            const roots = [];
            const stack = [];
            const attach = (sym, level) => {
                while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
                if (stack.length) stack[stack.length - 1].sym.children.push(sym);
                else roots.push(sym);
            };
            for (const o of model.objects) {
                if (o.kind === 'section-heading') {
                    const sym = symbolFor(o);
                    attach(sym, o.level ?? 0);
                    stack.push({ sym, level: o.level ?? 0 });
                } else if (ADDRESSABLE.has(o.kind) && o.kind !== 'paragraph') {
                    const sym = symbolFor(o);
                    if (stack.length) stack[stack.length - 1].sym.children.push(sym);
                    else roots.push(sym);
                }
            }
            return headings.length || roots.length ? roots : [];
        },
    };
}

// --- Folding ----------------------------------------------------------------

function makeFoldingProvider(projection) {
    return {
        provideFoldingRanges(doc) {
            const { model, mma } = projection.get(doc);
            const out = [];

            // SECTIONS FOLD OVER WHAT THEY GOVERN, not over their own command.
            // A section-heading object's range is just `\section{...}` — one
            // line — so folding it directly does nothing at all. The span runs
            // to the line before the next heading at the same or a shallower
            // level, which is what makes \part / \chapter / \section /
            // \subsection nest the way the outline does.
            const endOfBody = (() => {
                const m = /\\end\s*\{document\}/.exec(doc.getText());
                return m ? doc.positionAt(m.index).line + 1 : doc.lineCount;
            })();
            // The preamble folds as one region: a real paper spends hundreds
            // of lines on packages and macros before the document starts.
            const pre = preambleSpan(doc.getText());
            if (pre) {
                out.push(new vscode.FoldingRange(pre.startLine - 1, pre.endLine - 1,
                    vscode.FoldingRangeKind.Region));
            }

            for (const sp of sectionSpans(model.objects, doc.lineCount, endOfBody - 1)) {
                if (sp.endLine > sp.startLine) {
                    out.push(new vscode.FoldingRange(sp.startLine - 1, sp.endLine - 1,
                        vscode.FoldingRangeKind.Region));
                }
            }

            for (const o of model.objects) {
                if (!ADDRESSABLE.has(o.kind) || o.kind === 'paragraph') continue;
                const a = o.sourceRange.startLine - 1;
                const b = o.sourceRange.endLine - 1;
                if (b > a) out.push(new vscode.FoldingRange(a, b));
            }
            // Managed blocks fold as comments — they are comments, and an
            // author scrolling past a 40-line computation wants them closed.
            for (const b of mma.blocks) {
                if (b.endLine > b.startLine) {
                    out.push(new vscode.FoldingRange(b.startLine - 1, b.endLine - 1,
                        vscode.FoldingRangeKind.Comment));
                }
                if (b.output && b.output.endLine > b.output.startLine) {
                    out.push(new vscode.FoldingRange(b.output.startLine - 1, b.output.endLine - 1));
                }
            }
            return out;
        },
    };
}

// --- CodeLens ---------------------------------------------------------------

/**
 * Paste a picture into a .tex and get a figure.
 *
 * The bytes go to `img/<paper>/paste_<hash>.<ext>` — content-hashed, so pasting
 * the same screenshot twice writes one file — and the caret gets a float with
 * the caption and label as tabstops. Inside an existing figure it inserts a
 * bare \includegraphics instead, because nesting floats is a LaTeX error.
 *
 * Everything decidable without a workspace lives in texPaste.js and is tested
 * there; this is the thin vscode-shaped shell around it.
 */
function makePasteProvider(log = () => {}) {
    return {
        async provideDocumentPasteEdits(document, _ranges, dataTransfer, _ctx, token) {
            const file = document.uri.fsPath;
            if (!/\.tex$/i.test(file) || document.uri.scheme !== 'file') return;

            const hit = findImageItem(dataTransfer);
            if (!hit) { log('paste: nothing image-like in the clipboard'); return; }
            let bytes = null;
            try { bytes = await hit.file.data(); } catch (e) { bytes = null; }
            if (!bytes || !bytes.length) { log('paste: the image had no bytes'); return; }
            if (token && token.isCancellationRequested) return;

            const where = imagePathFor(bytes, file, hit.mime);
            log(`paste: ${bytes.length} bytes of ${hit.mime} -> ${where.rel}`);
            try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(where.dir));
                // Content-hashed, so an existing file with this name IS this
                // picture. Writing it again would be correct but pointless.
                let exists = false;
                try {
                    await vscode.workspace.fs.stat(vscode.Uri.file(where.abs));
                    exists = true;
                } catch (_) { exists = false; }
                if (!exists) {
                    await vscode.workspace.fs.writeFile(
                        vscode.Uri.file(where.abs), new Uint8Array(bytes));
                }
            } catch (e) {
                vscode.window.showWarningMessage(
                    `Wolfbook: could not save the pasted image — ${e.message}`);
                return;
            }

            const text = document.getText();
            const offset = document.offsetAt(
                (_ranges && _ranges[0] && _ranges[0].start) || new vscode.Position(0, 0));
            const snippet = figureSnippet({
                rel: where.rel,
                inFigure: insideFloat(text, offset),
            });

            if (!hasGraphicx(text)) {
                vscode.window.showWarningMessage(
                    'Wolfbook: this paper does not load graphicx — add ' +
                    '\\usepackage{graphicx} or the figure will not compile.');
            }

            const kind = vscode.DocumentPasteEditKind.Text;
            const edit = new vscode.DocumentPasteEdit(
                new vscode.SnippetString(snippet), 'Insert as a figure', kind);
            return [edit];
        },
    };
}

function makeCodeLensProvider(projection, emitter) {
    return {
        onDidChangeCodeLenses: emitter.event,
        provideCodeLenses(doc) {
            const cfg = vscode.workspace.getConfiguration('wolfbook.tex');
            if (!cfg.get('codeLens', true)) return [];
            const { model, mma } = projection.get(doc);
            const lenses = [];
            const at = (o) => new vscode.Range(
                doc.positionAt(o.sourceRange.startOffset),
                doc.positionAt(o.sourceRange.startOffset));

            for (const o of model.objects) {
                if (!ADDRESSABLE.has(o.kind) || o.kind === 'paragraph') continue;
                if (o.kind === 'section-heading') continue;
                const arg = [{ file: doc.uri.fsPath, selector: o.label || o.stableKey }];
                lenses.push(new vscode.CodeLens(at(o), {
                    title: '$(comment-discussion) Ask', command: 'wolfbook.tex.askAboutObject', arguments: arg,
                }));
                if (o.label) {
                    lenses.push(new vscode.CodeLens(at(o), {
                        title: '$(references) Find refs', command: 'wolfbook.tex.findReferences', arguments: arg,
                    }));
                }
                lenses.push(new vscode.CodeLens(at(o), {
                    title: '$(json) Copy key', command: 'wolfbook.tex.copyKey', arguments: arg,
                }));
            }

            // A managed block's state is the most useful thing to say about it.
            for (const b of mma.blocks) {
                const pos = new vscode.Position(b.startLine - 1, 0);
                const icon = b.state === BLOCK_STATE.FRESH ? '$(pass)'
                    : b.state === BLOCK_STATE.STALE ? '$(warning)'
                        : b.state === BLOCK_STATE.MODIFIED_BY_USER ? '$(edit)' : '$(error)';
                lenses.push(new vscode.CodeLens(new vscode.Range(pos, pos), {
                    title: `${icon} ${b.state}${b.cellId ? ' · ' + b.cellId : ''}`,
                    command: 'wolfbook.tex.explainBlockState',
                    arguments: [{ state: b.state, reason: b.stateReason, cellId: b.cellId }],
                }));
            }
            return lenses;
        },
    };
}

// --- Diagnostics ------------------------------------------------------------
// Deterministic only. Nothing here calls an LLM or a compiler, so it is safe on
// the keystroke path.

function computeDiagnostics(doc, projection, opts) {
    const { model, scan, mma } = projection.get(doc);
    const out = [];
    const lineRange = (line, len = 200) =>
        doc.lineAt(Math.max(0, Math.min(line - 1, doc.lineCount - 1))).range;

    const add = (line, message, severity, code) => {
        const d = new vscode.Diagnostic(lineRange(line), message, severity);
        d.source = 'wolfbook-tex';
        if (code) d.code = code;
        out.push(d);
    };

    // Structural warnings from the scanner — these are the ones that predicted
    // a real pdflatex failure on the corpus.
    for (const w of scan.warnings) {
        const m = /:(\d+):\s*(.*)$/.exec(w);
        add(m ? Number(m[1]) : 1, m ? m[2] : w, vscode.DiagnosticSeverity.Warning, 'structure');
    }
    for (const w of mma.warnings) {
        const m = /:(\d+):\s*(.*)$/.exec(w);
        add(m ? Number(m[1]) : 1, m ? m[2] : w, vscode.DiagnosticSeverity.Warning, 'managed-block');
    }

    const labels = model.objects.filter(o => o.kind === 'label');
    const declared = new Set(labels.map(l => l.name));

    const seen = new Map();
    for (const l of labels) {
        if (seen.has(l.name)) {
            add(l.sourceRange.startLine,
                `Duplicate \\label{${l.name}} — first declared on line ${seen.get(l.name)}.`,
                vscode.DiagnosticSeverity.Warning, 'duplicate-label');
        } else seen.set(l.name, l.sourceRange.startLine);
    }

    for (const r of model.objects) {
        if (r.kind !== 'ref' || !r.target) continue;
        if (!declared.has(r.target)) {
            add(r.sourceRange.startLine,
                `Unresolved \\${r.cmd}{${r.target}} — no \\label with that name in this file.`,
                vscode.DiagnosticSeverity.Warning, 'unresolved-ref');
        }
    }

    // A LABEL NOTHING REFERS TO is not an error — plenty of papers label every
    // equation on principle — so this is an Information with the Unnecessary
    // tag, which VS Code renders as a fade rather than a squiggle. It is worth
    // saying because the commonest cause is a typo in the \ref, which shows up
    // here as an orphaned label next to an unresolved reference.
    const used = new Set();
    for (const r of model.objects) {
        if ((r.kind === 'ref' || r.kind === 'cite') && r.target) {
            for (const t of String(r.target).split(',')) used.add(t.trim());
        }
    }
    for (const l of labels) {
        if (used.has(l.name)) continue;
        const d = new vscode.Diagnostic(lineRange(l.sourceRange.startLine),
            `\\label{${l.name}} is never referred to in this file.`,
            vscode.DiagnosticSeverity.Information);
        d.source = 'wolfbook-tex';
        d.code = 'unused-label';
        // Read defensively: the enum is absent in older hosts, and a decoration
        // hint must never break the diagnostic it decorates.
        const tag = vscode.DiagnosticTag && vscode.DiagnosticTag.Unnecessary;
        if (tag != null) d.tags = [tag];
        out.push(d);
    }

    // Citations need the .bib, which is a project-level question. Only report
    // when we could actually read the databases, or every paper with an
    // external bibliography lights up red for no reason.
    if (opts && opts.bibKeys) {
        for (const c of model.objects) {
            if (c.kind !== 'cite' || !c.target) continue;
            for (const key of String(c.target).split(',').map(s => s.trim()).filter(Boolean)) {
                if (!opts.bibKeys.has(key)) {
                    add(c.sourceRange.startLine,
                        `Unresolved \\${c.cmd}{${key}} — not found in the project bibliography.`,
                        vscode.DiagnosticSeverity.Information, 'unresolved-cite');
                }
            }
        }
    }

    for (const b of mma.blocks) {
        if (b.state === BLOCK_STATE.STALE) {
            add(b.startLine, `Managed output is stale: ${b.stateReason}.`,
                vscode.DiagnosticSeverity.Information, 'stale-output');
        } else if (b.state === BLOCK_STATE.MODIFIED_BY_USER) {
            add(b.startLine, `Managed output was edited by hand; re-running will overwrite it.`,
                vscode.DiagnosticSeverity.Information, 'modified-output');
        } else if (b.state === BLOCK_STATE.MALFORMED) {
            add(b.startLine, `Malformed managed block: ${b.stateReason}.`,
                vscode.DiagnosticSeverity.Warning, 'malformed-block');
        }
    }
    for (const o of mma.outputs) {
        add(o.startLine, 'Managed output with no %Mathematica block above it.',
            vscode.DiagnosticSeverity.Warning, 'orphaned-output');
    }
    return out;
}

/** Read every .bib the project references, so \cite can be adjudicated. */
/**
 * The raw BibTeX entry for one key, for the \cite hover.
 *
 * Reads the same databases `collectBibKeys` does — deliberately re-reading
 * rather than caching the whole file: a hover is a rare, human-paced event, and
 * a stale entry shown as fact is worse than a few milliseconds.
 */
function bibEntryFor(fsPath, key) {
    const fs = require('fs');
    if (!key) return null;
    const deps = {
        readFile: (p) => fs.readFileSync(p, 'utf8'),
        exists: (p) => { try { return fs.existsSync(p); } catch (_) { return false; } },
        listDir: (d) => { try { return fs.readdirSync(d); } catch (_) { return []; } },
    };
    let files;
    try { files = buildGraph(findRoot(fsPath, deps).root, deps).files; }
    catch (_) { files = [fsPath]; }

    for (const f of files) {
        let src;
        try { src = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
        const dir = path.dirname(f);
        const names = [];
        for (const re of [/\\bibliography\s*\{([^}]*)\}/g, /\\addbibresource\s*\{([^}]*)\}/g]) {
            let m;
            while ((m = re.exec(src)) !== null) {
                for (const n of m[1].split(',').map(x => x.trim()).filter(Boolean)) names.push(n);
            }
        }
        for (const n of names) {
            const bp = path.isAbsolute(n) ? n : path.join(dir, /\.bib$/i.test(n) ? n : n + '.bib');
            if (!deps.exists(bp)) continue;
            let bib;
            try { bib = fs.readFileSync(bp, 'utf8'); } catch (_) { continue; }
            const at = bib.search(new RegExp(`@\\\\w+\\\\s*\\\\{\\\\s*${
                key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\\\s*,`));
            if (at < 0) continue;
            // Brace-matched, so an entry containing braces comes back whole.
            let depth = 0;
            for (let i = bib.indexOf('{', at); i < bib.length; i++) {
                if (bib[i] === '{') depth++;
                else if (bib[i] === '}') {
                    depth--;
                    if (depth === 0) return bib.slice(at, i + 1);
                }
            }
            return bib.slice(at, at + 800);
        }
    }
    return null;
}

/**
 * WHAT A CROSS-REFERENCE ACTUALLY POINTS AT — hover, F12, and Find References.
 *
 * `\eqref{eq:foo}` says nothing on its own; the number it resolves to lives in
 * the `.aux`, the equation it names lives in the model, and the page lives in
 * both. Joining them is the whole feature. The resolution itself is pure and
 * lives in refIntel.js; these are the vscode-shaped shells.
 *
 * @param {(doc:vscode.TextDocument) => {printed:Map, cites:Map}} auxFor
 */
/**
 * Put a cropped fragment somewhere a hover can load it from.
 *
 * Content-addressed, like every other image this extension writes, so hovering
 * the same equation twice writes one file. It lives beside the compiled PDF —
 * a per-document temp directory that is swept with the rest of the build — and
 * never inside the reader's project, which is a Dropbox folder.
 *
 * @returns {{dir:string, name:string}|null}
 */
function writeFragmentPng(dataUrl, viewer) {
    try {
        const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
        if (!m || !viewer || !viewer.root) return null;
        const st = viewer.coord && viewer.coord.roots.get(viewer.root);
        const outDir = st && st.generation && st.generation.outDir;
        if (!outDir) return null;
        const fs2 = require('fs');
        const dir = path.join(outDir, '_wbfrag');
        const bytes = Buffer.from(m[1], 'base64');
        const name = `f_${require('crypto').createHash('sha1')
            .update(bytes).digest('hex').slice(0, 12)}.png`;
        const abs = path.join(dir, name);
        if (!fs2.existsSync(abs)) {
            fs2.mkdirSync(dir, { recursive: true });
            fs2.writeFileSync(abs, bytes);
        }
        return { dir, name };
    } catch (_) { return null; }
}

function makeRefProviders(projection, auxFor, viewer = null) {
    const resolveAt = (doc, position) => {
        const line = doc.lineAt(position.line).text;
        const ref = refAt(line, position.character);
        if (!ref || ref.kind === 'label') return null;
        const { model } = projection.get(doc);
        const aux = auxFor(doc);
        const text = doc.getText();
        return {
            ref,
            info: resolveRef({
                ref,
                objects: model.objects,
                printedFor: (n) => aux.labels.get(n) || null,
                citeFor: (n) => aux.cites.get(n) || null,
                bibEntry: (k) => bibEntryFor(doc.uri.fsPath, k),
                sourceOf: (obj) => {
                    const r = obj.sourceRange;
                    if (!r) return null;
                    return text.slice(r.startOffset, r.endOffset);
                },
            }),
        };
    };

    return {
        hover: {
            async provideHover(doc, position, token) {
                const hit = resolveAt(doc, position);
                if (!hit || !hit.info) return null;
                let md = hoverMarkdown(hit.info);
                if (!md) return null;
                let base = null;

                // THE EQUATION AS IT PRINTS, not only as it is written. The
                // crop comes from the open panel — the same pixels the reader
                // is looking at — and is skipped without a word when the panel
                // is closed, when the object has no ink, or when it does not
                // arrive quickly: a hover that hangs is worse than a hover
                // without a picture.
                const t = hit.info.target;
                if (viewer && viewer.isOpen && viewer.isOpen() && t &&
                    vscode.workspace.getConfiguration('wolfbook.tex')
                        .get('hoverRender', true)) {
                    try {
                        const rects = viewer.objectRects(t.file || doc.uri.fsPath,
                            t.startLine, t.endLine);
                        if (rects.length && !(token && token.isCancellationRequested)) {
                            const shot = await viewer.cropFragment(rects, {
                                key: `${t.file}:${t.startLine}-${t.endLine}`,
                            });
                            if (shot && shot.dataUrl) {
                                // A HOVER SHOWS AN IMAGE FROM A FILE, NOT FROM
                                // A data: URI. `MarkdownString.baseUri` is the
                                // documented way to let a hover load a local
                                // picture; whether the sanitiser accepts a
                                // base64 payload is not something to find out
                                // in production. The PNG is written beside the
                                // compiled PDF — a temp dir that is already
                                // per-document and already swept.
                                const rel = writeFragmentPng(shot.dataUrl, viewer);
                                if (rel) {
                                    // Sized in POINTS, so the fragment appears
                                    // at the size it prints, capped so a
                                    // full-width display does not fill the
                                    // screen. `|width=` is VS Code's own
                                    // markdown-image extension.
                                    const w = Math.min(shot.w || 300, 460);
                                    // THE PICTURE GOES FIRST. A hover is a
                                    // small box and the source of a display can
                                    // fill it, so a render appended below it is
                                    // a render nobody sees without scrolling —
                                    // and the whole point of it is to be the
                                    // thing you take in at a glance.
                                    md = `![](${rel.name}|width=${w})\n\n${md}`;
                                    base = rel.dir;
                                }
                            }
                        }
                    } catch (_) { /* the code half of the hover still stands */ }
                }

                const m = new vscode.MarkdownString(md);
                m.isTrusted = false;
                m.supportHtml = false;
                // Only set when a fragment was actually written: baseUri is
                // what makes the relative image above resolvable at all.
                if (base) { try { m.baseUri = vscode.Uri.file(base + path.sep); } catch (_) {} }
                return new vscode.Hover(m, new vscode.Range(
                    new vscode.Position(position.line, hit.ref.start),
                    new vscode.Position(position.line, hit.ref.end)));
            },
        },
        definition: {
            provideDefinition(doc, position) {
                const hit = resolveAt(doc, position);
                const t = hit && hit.info && hit.info.target;
                if (!t) return null;
                const uri = t.file && t.file !== doc.uri.fsPath
                    ? vscode.Uri.file(t.file) : doc.uri;
                const at = new vscode.Position(Math.max(0, t.startLine - 1), 0);
                return new vscode.Location(uri, new vscode.Range(at, at));
            },
        },
        references: {
            provideReferences(doc, position) {
                const line = doc.lineAt(position.line).text;
                // Works from EITHER end: on the \label itself, or on a \ref to
                // it — "where else is this used" is the same question.
                const here = refAt(line, position.character);
                const name = here && here.name;
                if (!name) return null;
                const { model } = projection.get(doc);
                const out = [];
                for (const o of model.objects) {
                    const isDecl = o.kind === 'label' && o.name === name;
                    const isUse = (o.kind === 'ref' || o.kind === 'cite') &&
                        String(o.target || '').split(',').map(t => t.trim()).includes(name);
                    if (!isDecl && !isUse) continue;
                    const at = new vscode.Position(Math.max(0, o.sourceRange.startLine - 1), 0);
                    out.push(new vscode.Location(doc.uri, new vscode.Range(at, at)));
                }
                return out;
            },
        },
    };
}

/**
 * ⌘V IN A .tex: A PICTURE BECOMES A FIGURE, EVERYTHING ELSE PASTES NORMALLY.
 *
 * The supported route for this is a DocumentPasteEditProvider, which is
 * registered above and stays registered. It was reported twice as doing
 * nothing at all with a screenshot in the clipboard, and there is no second
 * API — `env.clipboard` is text only — so the image is fetched from the
 * operating system instead.
 *
 * THE ORDER MATTERS, and it is what keeps this from being intrusive:
 * `readText` is in-process and instant, so an ordinary text paste never pays
 * for a subprocess and never behaves differently. Only a clipboard with NO
 * text at all — which is what a screenshot is — reaches the shell-out. And any
 * doubt anywhere falls through to VS Code's own paste, so the worst case is
 * the behaviour the reader had before.
 */
async function smartPaste(pasteLogger = () => {}) {
    const fallback = async () => {
        try { await vscode.commands.executeCommand('editor.action.clipboardPasteAction'); }
        catch (e) { pasteLogger(`default paste failed: ${e && e.message}`); }
    };
    const ed = vscode.window.activeTextEditor;
    if (!ed || !/\.tex$/i.test(ed.document.uri.fsPath)) return fallback();

    try {
        const text = await vscode.env.clipboard.readText();
        if (text && text.length) return fallback();       // a text paste, untouched
    } catch (_) { return fallback(); }

    let bytes = null;
    try {
        const fs2 = require('fs');
        const { spawnSync } = require('child_process');
        bytes = readClipboardImage({
            run: (cmd, args) => spawnSync(cmd, args, {
                encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 5000,
            }),
            readFile: (f) => fs2.readFileSync(f),
            exists: (f) => fs2.existsSync(f),
            unlink: (f) => { try { fs2.unlinkSync(f); } catch (_) { /* fine */ } },
        });
    } catch (e) { pasteLogger(`clipboard probe failed: ${e && e.message}`); }

    if (!bytes || !bytes.length) {
        pasteLogger('smartPaste: no text and no image in the clipboard');
        return fallback();
    }
    pasteLogger(`smartPaste: ${bytes.length} bytes of PNG from the clipboard`);
    try {
        await insertPastedImage(ed, bytes, 'image/png', pasteLogger);
    } catch (e) {
        pasteLogger(`smartPaste failed: ${e && e.message}`);
        return fallback();
    }
    return undefined;
}

/** Write the picture beside the paper and put a figure at the caret. */
async function insertPastedImage(editor, bytes, mime, pasteLogger = () => {}) {
    const doc = editor.document;
    const file = doc.uri.fsPath;
    const where = imagePathFor(bytes, file, mime);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(where.dir));
    let exists = false;
    try { await vscode.workspace.fs.stat(vscode.Uri.file(where.abs)); exists = true; }
    catch (_) { exists = false; }
    if (!exists) {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(where.abs), new Uint8Array(bytes));
    }
    pasteLogger(`wrote ${where.rel}${exists ? ' (already had it)' : ''}`);

    const text = doc.getText();
    const offset = doc.offsetAt(editor.selection.active);
    const snippet = figureSnippet({ rel: where.rel, inFigure: insideFloat(text, offset) });
    await editor.insertSnippet(new vscode.SnippetString(snippet));
    if (!hasGraphicx(text)) {
        vscode.window.showWarningMessage(
            'WPaper: this paper does not load graphicx — add \\usepackage{graphicx} ' +
            'or the figure will not compile.');
    }
}

function collectBibKeys(fsPath) {
    const fs = require('fs');
    const deps = {
        readFile: (p) => fs.readFileSync(p, 'utf8'),
        exists: (p) => { try { return fs.existsSync(p); } catch (_) { return false; } },
        listDir: (d) => { try { return fs.readdirSync(d); } catch (_) { return []; } },
    };
    let files;
    try {
        const root = findRoot(fsPath, deps);
        files = buildGraph(root.root, deps).files;
    } catch (_) { files = [fsPath]; }

    const keys = new Set();
    let found = 0;
    for (const f of files) {
        let src;
        try { src = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
        const dir = path.dirname(f);
        const refs = [];
        for (const re of [/\\bibliography\s*\{([^}]*)\}/g, /\\addbibresource\s*\{([^}]*)\}/g]) {
            let m;
            while ((m = re.exec(src)) !== null) {
                for (const n of m[1].split(',').map(s => s.trim()).filter(Boolean)) refs.push(n);
            }
        }
        for (const n of refs) {
            const p = path.isAbsolute(n) ? n : path.join(dir, /\.bib$/i.test(n) ? n : n + '.bib');
            if (!deps.exists(p)) continue;
            found++;
            let bib;
            try { bib = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
            let m;
            const entry = /@\w+\s*\{\s*([^,\s}]+)/g;
            while ((m = entry.exec(bib)) !== null) keys.add(m[1]);
        }
        // A shipped .bbl is the arXiv shape and is also a source of truth.
        const bbl = f.replace(/\.tex$/i, '.bbl');
        if (deps.exists(bbl)) {
            found++;
            try {
                const b = fs.readFileSync(bbl, 'utf8');
                let m;
                const item = /\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
                while ((m = item.exec(b)) !== null) keys.add(m[1].trim());
            } catch (_) { /* ignore */ }
        }
    }
    return found ? keys : null;      // null = "we could not adjudicate", not "no keys"
}

// --- repainting after a compile ---------------------------------------------

/**
 * What has to happen when a generation lands, in the order it has to happen.
 *
 * THE PAPER IS NOT A DECORATION ON THE ACTIVE EDITOR. It used to be treated as
 * one: everything here sat behind `if (!activeTextEditor is a .tex) return`,
 * with `viewer.refresh()` last. `activeTextEditor` is `undefined` whenever
 * focus is inside the webview — the same fact this file already relies on when
 * deciding not to auto-hide — so editing in the Page view's own mini-editor
 * recompiled correctly and then threw the result away: the pages only updated
 * once the reader clicked back into the text editor, which is exactly what it
 * looked like in use.
 *
 * So the viewer refreshes UNCONDITIONALLY. Page markers and render diagnostics
 * genuinely are per-editor — they decorate a specific TextEditor — and those
 * alone stay behind the guard.
 *
 * Extracted from registerTexSupport so it can be driven with no VS Code window
 * at all; a bug that only appears when nothing is focused cannot be caught by a
 * test that always has an editor.
 */
function makePaintRender({ viewer, coord, projection, status, pageMarkers, renderDiags, isTexDoc = isTex }) {
    return () => {
        if (status) status.update();
        // A new generation means a new PDF; the viewer reloads it only when the
        // generation number actually moved, so this is cheap to call always.
        if (viewer) { try { const p = viewer.refresh(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* never break the paint */ } }
        const ed = vscode.window.activeTextEditor;
        if (!ed || !isTexDoc(ed.document)) return;
        if (pageMarkers) applyPageMarkers(ed, coord, pageMarkers);
        if (renderDiags) {
            try { renderDiags.set(ed.document.uri, renderDiagnostics(ed.document, coord, projection)); }
            catch (e) { console.warn('[wolfbook-tex] render diagnostics failed:', e && e.message); }
        }
    };
}

// --- activation -------------------------------------------------------------

/**
 * The paste provider's own trail.
 *
 * A paste that quietly does nothing is the hardest kind of bug to report — the
 * reader sees no error, just an unchanged file — so every step says what it
 * saw. Buffered until the output channel exists, because registration happens
 * before it is created.
 */
const _pasteLines = [];
let _pasteChannel = null;
function pasteLog(msg) {
    const line = `[paste] ${msg}`;
    if (_pasteChannel) { try { _pasteChannel.appendLine(line); return; } catch (_) { /* gone */ } }
    _pasteLines.push(line);
    if (_pasteLines.length > 50) _pasteLines.shift();
}
function attachPasteLog(channel) {
    _pasteChannel = channel;
    for (const l of _pasteLines.splice(0)) { try { channel.appendLine(l); } catch (_) { /* gone */ } }
}

function registerTexSupport(context) {
    const cfg = () => vscode.workspace.getConfiguration('wolfbook.tex');
    if (!cfg().get('enable', true)) return null;

    const projection = new Projection();
    context.subscriptions.push({ dispose: () => projection.dispose() });

    // LaTeX Workshop owns compile diagnostics, the build UI, snippets and
    // completion. Detect it and stay out of the way rather than duplicating.
    const workshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
    const coexisting = !!workshop;

    const diagnostics = vscode.languages.createDiagnosticCollection('wolfbook-tex');
    context.subscriptions.push(diagnostics);

    const lensEmitter = new vscode.EventEmitter();
    context.subscriptions.push(lensEmitter);

    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(TEX_SELECTOR, makeSymbolProvider(projection)),
        vscode.languages.registerFoldingRangeProvider(TEX_SELECTOR, makeFoldingProvider(projection)),
        vscode.languages.registerCodeLensProvider(TEX_SELECTOR, makeCodeLensProvider(projection, lensEmitter)),
    );

    // PASTE A PICTURE, GET A FIGURE. Registered defensively: the paste API
    // arrived in 1.97 and this extension supports older hosts, where the whole
    // feature is simply absent rather than an activation failure.
    if (vscode.languages.registerDocumentPasteEditProvider && vscode.DocumentPasteEditKind) {
        try {
            // The kind must be one VS Code will actually offer for a plain ⌘V.
            // `Text` is the generic one the built-in providers use.
            const kind = vscode.DocumentPasteEditKind.Text;
            context.subscriptions.push(
                vscode.languages.registerDocumentPasteEditProvider(
                    TEX_SELECTOR, makePasteProvider((m) => pasteLog(m)), {
                        providedPasteEditKinds: [kind],
                        pasteMimeTypes: PASTE_MIMES,
                    }));
            pasteLog(`paste provider registered for ${PASTE_MIMES.join(', ')}`);
        } catch (e) {
            pasteLog(`paste provider NOT registered: ${e && e.message}`);
        }
    } else {
        pasteLog('this VS Code has no document-paste API — paste-to-figure is off');
    }

    const bibCache = new Map();   // fsPath -> Set|null
    const refresh = (doc) => {
        if (!isTex(doc)) return;
        if (cfg().get('diagnostics', 'semantic') === 'off') { diagnostics.delete(doc.uri); return; }
        try {
            const key = doc.uri.fsPath;
            if (!bibCache.has(key)) bibCache.set(key, collectBibKeys(key));
            diagnostics.set(doc.uri, computeDiagnostics(doc, projection, { bibKeys: bibCache.get(key) }));
            lensEmitter.fire();
        } catch (e) {
            console.warn('[wolfbook-tex] diagnostics failed:', e && e.message);
        }
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(refresh),
        vscode.workspace.onDidSaveTextDocument((doc) => { bibCache.delete(doc.uri.fsPath); refresh(doc); }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            if (!isTex(doc)) return;
            diagnostics.delete(doc.uri);
            bibCache.delete(doc.uri.fsPath);
            projection.forget(doc);
        }),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (!isTex(e.document)) return;
            projection.schedule(e.document);
        }),
        projection.onDidChange(refresh),
    );

    // --- commands, all read-only or clipboard-only in Stage 1 ---------------
    const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    reg('wolfbook.tex.smartPaste', () => smartPaste(pasteLog));

    reg('wolfbook.tex.copyKey', async (arg) => {
        const sel = arg?.selector;
        if (!sel) return;
        await vscode.env.clipboard.writeText(String(sel));
        vscode.window.setStatusBarMessage(`Copied ${sel}`, 2500);
    });

    reg('wolfbook.tex.findReferences', async (arg) => {
        const doc = vscode.window.activeTextEditor?.document;
        if (!isTex(doc) || !arg?.selector) return;
        const { model } = projection.get(doc);
        const name = arg.selector;
        const uses = model.objects.filter(o => (o.kind === 'ref' || o.kind === 'cite') && o.target === name);
        if (!uses.length) {
            vscode.window.showInformationMessage(`No \\ref or \\cite of "${name}" in this file.`);
            return;
        }
        const pick = await vscode.window.showQuickPick(
            uses.map(u => ({
                label: `line ${u.sourceRange.startLine}`,
                description: `\\${u.cmd}{${u.target}}`,
                line: u.sourceRange.startLine,
            })), { title: `${uses.length} reference(s) to ${name}` });
        if (!pick) return;
        const pos = new vscode.Position(pick.line - 1, 0);
        vscode.window.activeTextEditor.revealRange(new vscode.Range(pos, pos),
            vscode.TextEditorRevealType.InCenter);
        vscode.window.activeTextEditor.selection = new vscode.Selection(pos, pos);
    });

    reg('wolfbook.tex.explainBlockState', (arg) => {
        vscode.window.showInformationMessage(
            `Managed block ${arg?.cellId ? `"${arg.cellId}" ` : ''}is ${arg?.state}: ${arg?.reason}. ` +
            'Running managed blocks is not available yet.');
    });

    reg('wolfbook.tex.askAboutObject', async (arg) => {
        const sel = arg?.selector;
        // Hand the agent the address rather than the text: it can fetch what it
        // needs with paper_getObject, and the address is what stays valid.
        const prompt = `Using paper_getObject, look at \`${sel}\` in ` +
            `${path.basename(arg?.file || '')} and tell me about it.`;
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
        } catch (_) {
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage('Chat is unavailable; the prompt is on your clipboard.');
        }
    });

    reg('wolfbook.tex.showProjection', async () => {
        const doc = vscode.window.activeTextEditor?.document;
        if (!isTex(doc)) { vscode.window.showWarningMessage('Open a .tex file first.'); return; }
        const { model, mma, scan } = projection.get(doc);
        const fs = require('fs');
        const deps = {
            readFile: (p) => fs.readFileSync(p, 'utf8'),
            exists: (p) => { try { return fs.existsSync(p); } catch (_) { return false; } },
            listDir: (p) => { try { return fs.readdirSync(p); } catch (_) { return []; } },
        };
        const root = findRoot(doc.uri.fsPath, deps);
        const graph = buildGraph(root.root, deps);
        const report = {
            file: doc.uri.fsPath,
            root: root.root, rootSource: root.source,
            projectFiles: graph.files.length, missingIncludes: graph.missing,
            outline: buildOutline(model.objects),
            objects: model.objects.length,
            managedBlocks: mma.blocks.map(b => ({ cellId: b.cellId, state: b.state, line: b.startLine })),
            warnings: scan.warnings.concat(mma.warnings),
            coexistingWithLatexWorkshop: coexisting,
        };
        const out = await vscode.workspace.openTextDocument({
            language: 'json', content: JSON.stringify(report, null, 2),
        });
        vscode.window.showTextDocument(out, { preview: true });
    });

    // --- Stage 2: compile + render map ---------------------------------------
    const output = vscode.window.createOutputChannel('WPaper');
    attachPasteLog(output);
    context.subscriptions.push(output);
    const coord = new RenderCoordinator(projection, output);
    context.subscriptions.push({ dispose: () => coord.dispose() });

    const renderDiags = vscode.languages.createDiagnosticCollection('wolfbook-tex-render');
    context.subscriptions.push(renderDiags);
    const pageMarkers = makePageMarkers();
    context.subscriptions.push(pageMarkers);
    const status = makeStatusItem(coord, projection);
    context.subscriptions.push(status.item);

    const viewer = new TexViewer(context, coord, projection);

    // WHAT LATEX ITSELF NUMBERED EACH LABEL AS, for the hovers. Cached on the
    // compile generation: the .aux only changes when a compile does, and a
    // hover must never be the thing that reads a file off disk on a keystroke.
    const auxCache = new Map();          // root -> {generation, labels, cites}
    const auxFor = (doc) => {
        const empty = { labels: new Map(), cites: new Map() };
        try {
            const root = coord.rootFor(doc);
            const st = coord.roots.get(root);
            const gen = st && st.generation;
            if (!gen || !gen.outDir) return empty;
            const hit = auxCache.get(root);
            if (hit && hit.generation === gen.generation) return hit;
            const fs2 = require('fs');
            const read = readAuxLabels(gen.outDir, gen.root || root, {
                readFile: (f) => fs2.readFileSync(f, 'utf8'),
                exists: (f) => fs2.existsSync(f),
            });
            const value = { generation: gen.generation, labels: read.labels, cites: read.cites };
            auxCache.set(root, value);
            return value;
        } catch (_) { return empty; }
    };

    const refProviders = makeRefProviders(projection, auxFor, viewer);
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(TEX_SELECTOR, refProviders.hover),
        vscode.languages.registerDefinitionProvider(TEX_SELECTOR, refProviders.definition),
        vscode.languages.registerReferenceProvider(TEX_SELECTOR, refProviders.references),
    );

    const repaint = makePaintRender({
        viewer, coord, projection, status, pageMarkers, renderDiags,
    });
    const paintRender = () => {
        repaint();
        // The pages just moved; an open comparison must be re-placed against
        // the new render or its marks point at whatever now sits there.
        try { viewer.refreshComparison(); } catch (_) { /* never break the paint */ }
    };

/**
 * Ask, because only the reader can decide.
 *
 * Two versions of the same file exist and neither is disposable: unsaved edits
 * in the buffer, and somebody else's change on disk. Picking one automatically
 * destroys the other, so this is a modal — the one interruption in this feature
 * that is justified, because the alternative is silent data loss.
 */
async function offerReload(doc, diskText, output) {
    const name = path.basename(doc.uri.fsPath);
    const RELOAD = 'Reload from disk';
    const KEEP = 'Keep my edits';
    const COMPARE = 'Compare…';
    const pick = await vscode.window.showWarningMessage(
        `${name} changed on disk, and this editor has unsaved edits.`,
        {
            modal: true,
            detail: 'Reloading discards your unsaved edits. Keeping yours leaves the ' +
                'change on disk unmerged — it will be overwritten when you save.',
        },
        RELOAD, COMPARE, KEEP);

    if (pick === RELOAD) {
        await vscode.window.showTextDocument(doc, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
        if (output) output.appendLine(`${name}: reloaded from disk on request`);
        return 'reloaded';
    }
    if (pick === COMPARE) {
        // There is no API to diff a dirty buffer against its own file, so the
        // disk copy is parked under a temp name and diffed against the buffer.
        try {
            const tmpDir = path.join(os.tmpdir(), 'wolfbook-tex', 'ondisk');
            fs.mkdirSync(tmpDir, { recursive: true });
            const tmp = path.join(tmpDir, `${Date.now()}-${name}`);
            fs.writeFileSync(tmp, diskText ?? '', 'utf8');
            await vscode.commands.executeCommand(
                'vscode.diff', vscode.Uri.file(tmp), doc.uri,
                `${name} (on disk) ↔ ${name} (your unsaved edits)`);
        } catch (e) {
            vscode.window.showErrorMessage(`Could not show the comparison: ${e.message}`);
        }
        return 'compared';
    }
    if (output) output.appendLine(`${name}: kept the in-editor version; disk change not merged`);
    return 'kept';
}

    // --- the file changing underneath us ------------------------------------
    //
    // A .tex here is a shared object: Dropbox syncs it, a second editor or a
    // git checkout rewrites it, a collaborator's change lands while a buffer
    // sits open with unsaved edits. That last case is the only one worth
    // interrupting for — when the buffer is clean VS Code reloads it silently
    // and correctly, and all that is needed is to drop the caches keyed to the
    // content that just stopped being true.
    const diskWatch = new DiskWatch();
    // THE TEXT WE LAST SAW, per file.
    //
    // When the buffer is CLEAN, VS Code reloads it silently and correctly — and
    // by the time we are told, `doc.getText()` is already the new content, so
    // "compare with the file on disk" finds nothing. The interesting question
    // is not what differs from disk, it is WHAT THEY CHANGED, and answering it
    // needs the text from before the write.
    const lastSeen = new Map();
    const rememberText = (fsPath, text) => {
        if (typeof text === 'string') lastSeen.set(fsPath, text);
    };
    for (const d of vscode.workspace.textDocuments) {
        if (isTex(d)) rememberText(d.uri.fsPath, d.getText());
    }
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((d) => { if (isTex(d)) rememberText(d.uri.fsPath, d.getText()); }),
        vscode.workspace.onDidSaveTextDocument((d) => { if (isTex(d)) rememberText(d.uri.fsPath, d.getText()); }),
    );
    {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,bib}');
        const onExternal = async (uri) => {
            const fsPath = uri.fsPath;
            const doc = vscode.workspace.textDocuments
                .find(d => d.uri.fsPath === fsPath && !d.isClosed);
            let diskText = null;
            try { diskText = fs.readFileSync(fsPath, 'utf8'); } catch (_) { diskText = null; }
            if (!doc) { diskWatch.accept(fsPath, diskText); coord.invalidate(fsPath); return; }

            const { verdict, repeat } = diskWatch.classify(fsPath, {
                diskText, docText: doc.getText(), isDirty: doc.isDirty,
            });
            if (verdict === VERDICT.UNCHANGED) return;
            coord.invalidate(fsPath);
            const before = lastSeen.get(fsPath);
            rememberText(fsPath, verdict === VERDICT.CONFLICT ? doc.getText() : diskText);

            if (verdict !== VERDICT.CONFLICT) {
                output.appendLine(`${path.basename(fsPath)} changed on disk` +
                    (verdict === VERDICT.DELETED ? ' (deleted)' : '; the editor reloaded it'));
                paintRender();
                // SHOW IT, DO NOT WAIT TO BE ASKED. A clean buffer is reloaded
                // silently, so without this the only sign that a collaborator
                // rewrote a paragraph is that the pages quietly changed.
                if (verdict !== VERDICT.DELETED && before && diskText && before !== diskText
                    && viewer.isOpen() && viewer.root === coord.rootFor(doc)) {
                    await viewer.compareWith({
                        text: before,
                        label: 'the version you were looking at',
                        invert: true,       // they wrote it; we are the newer side
                    });
                }
                return;
            }
            if (repeat) return;                 // one prompt per external change
            await offerReload(doc, diskText, output);
        };
        context.subscriptions.push(
            watcher,
            watcher.onDidChange(onExternal),
            watcher.onDidCreate(onExternal),
            watcher.onDidDelete((uri) => { diskWatch.forget(uri.fsPath); coord.invalidate(uri.fsPath); }),
            { dispose: () => diskWatch.dispose() },
        );
    }


    // --- THE PAPER FOLLOWS WHATEVER TAB IS IN FRONT -------------------------
    //
    // This used to hang off `onDidChangeActiveTextEditor` alone, which fires
    // only for TEXT editors — so switching to a notebook, an image, a settings
    // page or any other non-text tab never reached the hide logic and the paper
    // just stayed there. The handler also had to bail on `undefined`, because
    // focus moving INTO the webview reports exactly the same thing as focus
    // moving away from every editor.
    //
    // The tab groups answer both questions directly: what is actually in front,
    // and is it OUR panel. Older hosts without the API keep the old behaviour.
    const activeTabKind = () => {
        const groups = vscode.window.tabGroups;
        if (!groups || !Array.isArray(groups.all)) return null;
        const group = groups.all.find(g => g.isActive) || groups.activeTabGroup;
        const tab = group && group.activeTab;
        if (!tab || !tab.input) return 'other';
        const input = tab.input;
        // Reading the viewType by duck-typing rather than instanceof: the Tab*
        // input classes are not present in every host, and a missing global
        // would throw here on every tab change.
        if (typeof input.viewType === 'string') {
            return input.viewType.includes(TEX_VIEW_TYPE) ? 'viewer' : 'other';
        }
        if (input.uri && typeof input.uri.fsPath === 'string') {
            return /\.tex$/i.test(input.uri.fsPath) ? { tex: input.uri } : 'other';
        }
        return 'other';
    };

    const followActiveTab = () => {
        if (!cfg().get('viewerFollowsTex', true)) return;
        const kind = activeTabKind();
        if (kind === null) {
            // No tab API: the old rule, which at least never hides the paper
            // the moment the reader clicks on it.
            const ed = vscode.window.activeTextEditor;
            if (!ed) return;
            if (isTex(ed.document)) viewer.autoRestore(ed.document).catch(() => {});
            else if (viewer.isOpen()) viewer.autoHide().catch(() => {});
            return;
        }
        if (kind === 'viewer') return;                 // the reader is IN the paper
        if (kind === 'other') {
            if (viewer.isOpen()) viewer.autoHide().catch(() => {});
            return;
        }
        vscode.workspace.openTextDocument(kind.tex)
            .then(d => viewer.autoRestore(d))
            .catch(() => {});
    };

    if (vscode.window.tabGroups && vscode.window.tabGroups.onDidChangeTabs) {
        context.subscriptions.push(
            vscode.window.tabGroups.onDidChangeTabs(() => followActiveTab()),
        );
    }
    if (vscode.window.tabGroups && vscode.window.tabGroups.onDidChangeTabGroups) {
        context.subscriptions.push(
            vscode.window.tabGroups.onDidChangeTabGroups(() => followActiveTab()),
        );
    }

    // A window reload restores the panel; without a serializer it comes back as
    // an empty shell the extension knows nothing about.
    if (vscode.window.registerWebviewPanelSerializer) {
        context.subscriptions.push(
            vscode.window.registerWebviewPanelSerializer(TEX_VIEW_TYPE, {
                deserializeWebviewPanel: async (panel, state) => {
                    try { await viewer.adopt(panel, state); }
                    catch (e) { output.appendLine(`could not restore the Page view: ${e.message}`); }
                },
            }),
        );
    }

    context.subscriptions.push(
        coord.onDidChange(paintRender),
        vscode.window.onDidChangeActiveTextEditor(() => {
            paintRender();
            followActiveTab();
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (!isTex(e.textEditor.document)) return;
            status.update();
            viewer.syncFromEditor(e.textEditor);
        }),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (!isTex(e.document)) return;
            // Feed the edit to the map so answers degrade to
            // `probably-current` with a known shift rather than going blank.
            coord.noteChange(e);
            status.update();
            // Keep the page view up with the buffer, not with the file: a
            // rebuild is queued from the unsaved text once typing pauses.
            if (viewer.isOpen && viewer.isOpen()) coord.scheduleLive(e.document);
        }),
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if (!isTex(doc)) return;
            const mode = cfg().get('compile', 'onSave');
            if (mode !== 'onSave') return;
            // AUTHORITATIVE: a live build may have stopped after one pass, and
            // its snapshot hash matches the saved bytes — so without this the
            // save would see "already current" and leave the paper's
            // cross-references a pass behind.
            await coord.build(doc, { authoritative: true });
            paintRender();
        }),
    );

    reg('wolfbook.tex.compile', async () => {
        // FALL BACK TO THE PAPER ON SCREEN. `activeTextEditor` is undefined
        // whenever focus is in a webview, so running this while reading the
        // Page view — the most natural moment to want a recompile — used to
        // answer "Open a .tex file first" and do nothing.
        let doc = vscode.window.activeTextEditor?.document;
        if (!isTex(doc) && viewer.root) {
            try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(viewer.root)); }
            catch (_) { /* fall through to the warning */ }
        }
        if (!isTex(doc)) { vscode.window.showWarningMessage('Open a .tex file first.'); return; }
        const st = await coord.build(doc, { force: true });
        paintRender();
        if (st.lastError) {
            const pick = await vscode.window.showErrorMessage(
                `Compile failed: ${st.lastError}`, 'Show log');
            if (pick === 'Show log') output.show(true);
        } else if (st.generation) {
            const g = st.generation;
            vscode.window.setStatusBarMessage(
                `$(pass) ${g.pageCount ?? '?'} pages · ${g.errors} error(s) · ${g.warnings} warning(s)`, 5000);
        }
    });

    reg('wolfbook.tex.compareWith', async () => {
        const doc = vscode.window.activeTextEditor?.document
            || (viewer.root ? await vscode.workspace.openTextDocument(vscode.Uri.file(viewer.root)) : null);
        if (!isTex(doc)) { vscode.window.showWarningMessage('Open a .tex file first.'); return; }

        // OFFER ONLY WHAT IS ACTUALLY THERE. This workspace has papers with no
        // repository at all and papers whose disk copy is identical to the
        // buffer; an entry that can only lead to "no differences" is a wasted
        // click, and a git entry on an untracked paper is a dead end.
        const items = [];
        let diskText = null;
        try { diskText = fs.readFileSync(doc.uri.fsPath, 'utf8'); } catch (_) { diskText = null; }
        if (diskText != null && diskText !== doc.getText()) {
            items.push({ label: '$(file) The file on disk', description: 'differs from this editor', kind: 'disk' });
        }
        const repo = texVersions.gitRepoFor(doc.uri.fsPath);
        if (repo && repo.tracked) {
            const dirty = texVersions.gitIsDirty(repo);
            items.push({
                label: '$(git-commit) The last commit (HEAD)',
                description: dirty ? 'you have uncommitted changes' : 'no uncommitted changes',
                kind: 'head',
            });
            items.push({ label: '$(history) An earlier revision…', description: 'pick from the file history', kind: 'rev' });
        }
        if (!items.length) {
            vscode.window.showInformationMessage(
                repo && repo.tracked
                    ? 'Nothing to compare: this paper matches both its file on disk and its last commit.'
                    : 'Nothing to compare: this paper matches its file on disk, and it is not tracked by git.');
            return;
        }
        const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, {
            title: `Compare ${path.basename(doc.uri.fsPath)} with…`,
        });
        if (!pick) return;
        if (!viewer.isOpen()) await viewer.open(doc);
        if (pick.kind === 'disk') {
            await viewer.compareWith({ text: diskText, label: 'the file on disk' });
        } else if (pick.kind === 'head') {
            const v = texVersions.gitVersion(repo, 'HEAD');
            if (!v) { vscode.window.showWarningMessage('Could not read HEAD from git.'); return; }
            await viewer.compareWith({ text: v.text, label: 'the last commit' });
        } else {
            await vscode.commands.executeCommand('wolfbook.tex.compareWithGit');
        }
    });

    reg('wolfbook.tex.compareWithDisk', async () => {
        const doc = vscode.window.activeTextEditor?.document
            || (viewer.root ? await vscode.workspace.openTextDocument(vscode.Uri.file(viewer.root)) : null);
        if (!isTex(doc)) { vscode.window.showWarningMessage('Open a .tex file first.'); return; }
        if (!viewer.isOpen()) await viewer.open(doc);
        let diskText = null;
        try { diskText = fs.readFileSync(doc.uri.fsPath, 'utf8'); }
        catch (e) {
            vscode.window.showWarningMessage(`Could not read ${path.basename(doc.uri.fsPath)} from disk: ${e.message}`);
            return;
        }
        if (diskText === doc.getText()) {
            vscode.window.setStatusBarMessage('$(pass) The file on disk matches this editor.', 4000);
            return;
        }
        await viewer.compareWith({ text: diskText, label: 'the file on disk' });
    });

    reg('wolfbook.tex.compareWithGit', async () => {
        const doc = vscode.window.activeTextEditor?.document
            || (viewer.root ? await vscode.workspace.openTextDocument(vscode.Uri.file(viewer.root)) : null);
        if (!isTex(doc)) { vscode.window.showWarningMessage('Open a .tex file first.'); return; }
        const repo = texVersions.gitRepoFor(doc.uri.fsPath);
        if (!repo || !repo.tracked) {
            vscode.window.showInformationMessage(
                `${path.basename(doc.uri.fsPath)} is not tracked by git.`);
            return;
        }
        const revs = texVersions.gitRevisions(repo, { limit: 40 });
        if (!revs.length) {
            vscode.window.showInformationMessage('git has no history for this file.');
            return;
        }
        // A DATED, ATTRIBUTED PICKER, not just HEAD. Measured on the Overleaf
        // mirrors in this workspace: consecutive revisions are autosave commits
        // differing by one or two lines, so "compare with HEAD" is nearly always
        // empty. What a reader wants is a revision from before their session.
        const pick = await vscode.window.showQuickPick(
            revs.map((r, i) => ({
                label: i === 0 ? `${r.rev} · latest` : r.rev,
                description: `${r.date} · ${r.author}`,
                detail: r.subject,
                rev: r.rev,
            })),
            { title: `Compare ${path.basename(doc.uri.fsPath)} with which revision?`, matchOnDescription: true });
        if (!pick) return;
        const other = texVersions.gitVersion(repo, pick.rev);
        if (!other) {
            vscode.window.showWarningMessage(`Could not read ${pick.rev} from git.`);
            return;
        }
        if (!viewer.isOpen()) await viewer.open(doc);
        await viewer.compareWith({ text: other.text, label: `${pick.rev} (${pick.description})` });
    });

    reg('wolfbook.tex.showLog', () => output.show(true));

    reg('wolfbook.tex.showTimingLog', async () => {
        const p = require('path').join(require('os').tmpdir(), 'wolfbook-tex', 'timing.log');
        if (!require('fs').existsSync(p)) {
            vscode.window.showInformationMessage(`No timings recorded yet (${p}).`);
            return;
        }
        const d = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
        await vscode.window.showTextDocument(d, { preview: false });
    });

    reg('wolfbook.tex.openViewer', async () => {
        const doc = vscode.window.activeTextEditor?.document;
        if (!isTex(doc)) { vscode.window.showWarningMessage('Open a .tex file first.'); return; }
        // THE PANEL FIRST, THE COMPILE SECOND.
        //
        // Awaiting the build before creating the panel means the reader stares
        // at nothing for the whole compile with no sign anything is happening.
        // Opening first costs nothing — the panel says "compiling the paper…",
        // and the build's own onDidChange drives the refresh when it lands.
        const t0 = Date.now();
        await viewer.open(doc);
        output.appendLine(`viewer panel opened in ${Date.now() - t0} ms`);
        const st = coord.stateFor(doc);
        if (!st || !st.generation) {
            const t1 = Date.now();
            await coord.build(doc);
            output.appendLine(`  build for Page mode took ${Date.now() - t1} ms`);
        }
        const ed = vscode.window.activeTextEditor;
        if (ed) viewer.syncFromEditor(ed);
    });

    reg('wolfbook.tex.goToPage', async () => {
        const ed = vscode.window.activeTextEditor;
        if (!isTex(ed?.document)) return;
        const map = coord.mapFor(ed.document);
        if (!map || !map.available) { vscode.window.showWarningMessage('Compile the paper first.'); return; }
        const answer = await vscode.window.showInputBox({
            prompt: `Jump to the source of which page? (1-${map.pageCount})`,
            validateInput: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= map.pageCount) ? null : 'a page number',
        });
        if (!answer) return;
        const brk = map.pageBreaks(ed.document.uri.fsPath).find(b => b.page === Number(answer));
        if (!brk) { vscode.window.showInformationMessage(`Page ${answer} has nothing from this file.`); return; }
        const pos = new vscode.Position(Math.max(0, brk.firstLine - 1), 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    });

    reg('wolfbook.tex.whereAmI', () => {
        const ed = vscode.window.activeTextEditor;
        if (!isTex(ed?.document)) return;
        const map = coord.mapFor(ed.document);
        if (!map || !map.available) { vscode.window.showWarningMessage('Compile the paper first.'); return; }
        const line = ed.selection.active.line + 1;
        const r = map.sourceToRender(ed.document.uri.fsPath, line);
        if (r.page == null) { vscode.window.showInformationMessage(`Line ${line}: ${r.reason}`); return; }
        const occ = map.pageOccupancy(r.page);
        vscode.window.showInformationMessage(
            `Line ${line} is on page ${r.page} of ${map.pageCount} ` +
            `(${Math.round(occ.fill * 100)}% full) — ${r.flag}.`);
    });

    // Prime whatever is already open.
    for (const doc of vscode.workspace.textDocuments) refresh(doc);
    paintRender();

    return { projection, diagnostics, coexisting, coord, viewer };
}

module.exports = {
    registerTexSupport,
    makePaintRender,
    computeDiagnostics,
    collectBibKeys,
    Projection,
    TEX_SELECTOR,
};
