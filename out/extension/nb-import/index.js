'use strict';
/**
 * nb-import/index.js — VS Code wiring for opening Mathematica .nb files.
 *
 * This is the only module in nb-import/ that touches vscode, and it requires it
 * lazily so that deserializeNbNotebook() stays usable (and testable) headlessly.
 *
 *   serializer.js   -> isNbSource() / deserializeNbNotebook() / originalSourceOf()
 *   extension.js    -> registerNbImport(context)
 *
 * Saving: an imported .nb is a view, so Cmd-S does not write JSON over the
 * original — it saves an editable .wb copy beside it and swaps the editor to it
 * (saveNbCopyAsWb). Any other save path VS Code initiates rewrites the original
 * bytes unchanged, so the file can never be corrupted.
 */

const fs   = require('fs');
const path = require('path');
const util = require('util');

const nbModel      = require('./nbModel');
const kernelAssist = require('./kernelAssist');
const gfx          = require('./graphicsRender');

const NOTEBOOK_TYPE = 'extended-wolfram-notebook';

// ---------------------------------------------------------------------------
// BoxToLatex addon (optional — same lazy load as output/renderer.js)

const _BTL_DIR              = path.join(__dirname, '../../../wllatex-addon');
const _KATEX_PRERENDER_PATH = path.join(__dirname, '../../../wllatex-addon/katexPrerender.js');
let _deps = null;

function getDeps() {
    if (_deps) return _deps;
    const NC = (() => { try { return require('../namedchars'); } catch (_) { return {}; } })();
    let boxToLatex = null, prerenderLatex = null;
    try {
        const prebuilt = path.join(_BTL_DIR, 'prebuilt', `wolfbook_btl-${process.platform}-${process.arch}.node`);
        const fallback = path.join(_BTL_DIR, 'wolfbook_btl.node');
        const addon = require(fs.existsSync(prebuilt) ? prebuilt : fallback);
        boxToLatex = (s, o) => addon.boxToLatex(s, o || {});
        prerenderLatex = require(_KATEX_PRERENDER_PATH).prerenderLatex;
    } catch (_) {
        // No native addon on this platform — outputs degrade to plain text.
    }
    _deps = {
        boxToLatex,
        prerenderLatex,
        wlUTFtoNames: NC.wlUTFtoNames || (s => s),
        namedChars: NC.NAMED_CHARS || null,
    };
    return _deps;
}

// ---------------------------------------------------------------------------
// Pending graphics
//
// Box sources run to tens of KB, so they are held here rather than in notebook
// metadata; the notebook only carries the small importId that keys this map.

const _pendingGraphics = new Map();
const MAX_PENDING = 12;

function rememberGraphics(importId, tasks) {
    if (!importId || !tasks || !tasks.length) return;
    _pendingGraphics.set(importId, tasks);
    while (_pendingGraphics.size > MAX_PENDING) {
        _pendingGraphics.delete(_pendingGraphics.keys().next().value);
    }
}

/** `img/<name>/` beside the notebook — the folder the live kernel also uses. */
function imgPathsFor(nbFsPath) {
    const base = path.basename(nbFsPath, path.extname(nbFsPath));
    return { imgDir: path.join(path.dirname(nbFsPath), 'img', base), imgRel: 'img/' + base };
}

// ---------------------------------------------------------------------------
// Serializer entry points

/**
 * Convert .nb source into the object shape deserializeNotebook must return.
 * Output item data is encoded exactly as serializer.js does for .wb files.
 */
/**
 * Which .nb is VS Code opening right now?
 *
 * deserializeNotebook is handed bytes and no URI, but by the time it runs the
 * tab already exists — so look for a .nb tab with no NotebookDocument yet and
 * confirm it by comparing file contents. Knowing the path lets already-rendered
 * graphics be emitted as final <img> tags instead of placeholders that have to
 * be patched in afterwards (which makes them flash on open).
 *
 * Returns null whenever it cannot be certain; the patching path then handles it.
 */
function identifySourceUri(text) {
    let vscode;
    try { vscode = require('vscode'); } catch (_) { return null; }
    try {
        const alreadyOpen = new Set(vscode.workspace.notebookDocuments.map(d => d.uri.toString()));
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const uri = tab.input && tab.input.uri;
                if (!isNbUri(uri) || alreadyOpen.has(uri.toString())) continue;
                try {
                    if (fs.readFileSync(uri.fsPath, 'utf8') === text) return uri;
                } catch (_) { /* unreadable — not our file */ }
            }
        }
    } catch (_) { /* tab API unavailable */ }
    return null;
}

/** deps.resolveImage for a known notebook path: report PNGs already on disk. */
function imageResolverFor(nbFsPath) {
    const { imgDir, imgRel } = imgPathsFor(nbFsPath);
    return (file) => {
        const absPath = path.join(imgDir, file);
        if (!fs.existsSync(absPath)) return null;
        return { absPath, relPath: imgRel + '/' + file, size: gfx.displaySize(absPath) };
    };
}

function deserializeNbNotebook(text, opts) {
    const encoder = new util.TextEncoder();
    let result;
    try {
        const deps = getDeps();
        const uri = (opts && opts.nbFsPath) ? { fsPath: opts.nbFsPath } : identifySourceUri(text);
        const withImages = uri
            ? Object.assign({}, deps, { resolveImage: imageResolverFor(uri.fsPath) })
            : deps;
        result = nbModel.importNb(text, withImages, Object.assign({ mode: 'view' }, opts || {}));
    } catch (e) {
        // importNb is written not to throw; this is belt-and-braces so that a
        // .nb can never fall through to the empty-notebook path.
        result = {
            cells: [
                { kind: 1, value: '> ❌ **Could not import this Mathematica notebook.**\n> ' + String(e && e.message || e), languageId: 'markdown', outputs: [], metadata: {} },
                { kind: 2, value: text, languageId: 'wolfram', outputs: [], metadata: {} },
            ],
            metadata: { wolfbookNbImport: { version: 1, failed: true, source: text, error: String(e && e.message || e) } },
        };
    }

    const marker = result.metadata && result.metadata.wolfbookNbImport;
    if (marker) rememberGraphics(marker.importId, result.graphicsTasks);

    for (const cell of result.cells) {
        for (const output of (cell.outputs || [])) {
            for (const item of output.items) {
                if (typeof item.data === 'string') item.data = encoder.encode(item.data);
            }
        }
    }
    return { cells: result.cells, metadata: result.metadata };
}

/**
 * Import .nb source for inlining into another notebook (WBInclude).
 *
 * Graphics go into the HOST notebook's img/ folder, because that is what the
 * relative src of the inserted cells resolves against. Fully resolved: no
 * placeholders are left behind for a later pass to patch.
 *
 * @param {string} source
 * @param {object} opts { sourceName, hostNbFsPath }
 * @returns {Promise<{cells: Array, metadata: object}>}
 */
async function importForHost(source, opts) {
    opts = opts || {};
    const host = opts.hostNbFsPath;
    const deps = host
        ? Object.assign({}, getDeps(), { resolveImage: imageResolverFor(host) })
        : getDeps();

    const result = nbModel.importNb(source, deps, { mode: 'save', sourceName: opts.sourceName });

    if (host && result.graphicsTasks && result.graphicsTasks.length) {
        const { imgDir, imgRel } = imgPathsFor(host);
        try {
            const res = await gfx.renderGraphics(result.graphicsTasks, { imgDir });
            nbModel.applyGraphics(result.cells, res.rendered, imgRel);
        } catch (_) { /* fall through to the placeholder cleanup */ }
    }
    nbModel.clearGraphicsPlaceholders(result.cells);

    const encoder = new util.TextEncoder();
    for (const cell of result.cells) {
        if (cell.metadata) delete cell.metadata.nbImport;
        for (const output of (cell.outputs || [])) {
            for (const item of output.items) {
                if (typeof item.data === 'string') item.data = encoder.encode(item.data);
            }
        }
    }
    return { cells: result.cells, metadata: result.metadata };
}

/**
 * The original .nb bytes for an imported notebook, or null if this is not one.
 * serializeNotebook writes these back verbatim so a save is a no-op instead of
 * an error — and can never replace the notebook with .wb JSON.
 */
function originalSourceOf(notebookData) {
    const m = notebookData && notebookData.metadata && notebookData.metadata.wolfbookNbImport;
    return (m && typeof m.source === 'string') ? m.source : null;
}

// ---------------------------------------------------------------------------
// Live document <-> plain cell model

function docToPlainCells(doc) {
    const decoder = new util.TextDecoder();
    return doc.getCells().map(c => ({
        kind: c.kind === 1 ? 1 : 2,
        value: c.document.getText(),
        languageId: c.kind === 1 ? 'markdown' : (c.document.languageId || 'wolfram'),
        outputs: (c.outputs || []).map(o => ({
            items: o.items.map(it => ({
                data: typeof it.data === 'string' ? it.data : decoder.decode(it.data),
                mime: it.mime,
            })),
            id: o.id,
        })),
        metadata: Object.assign({}, c.metadata),
    }));
}

function plainOutputToVscode(vscode, out) {
    const encoder = new util.TextEncoder();
    return new vscode.NotebookCellOutput(
        out.items.map(it => new vscode.NotebookCellOutputItem(
            typeof it.data === 'string' ? encoder.encode(it.data) : it.data, it.mime)),
        undefined
    );
}

// ---------------------------------------------------------------------------
// Graphics pass

function collectTasks(cells, importId) {
    const known = _pendingGraphics.get(importId) || [];
    const byId = new Map(known.map(t => [t.id, t]));
    const needed = [];
    for (const cell of cells) {
        const entries = cell.metadata && cell.metadata.nbImport && cell.metadata.nbImport.graphics;
        for (const e of (entries || [])) {
            const t = byId.get(e.id);
            if (t) needed.push(t);
        }
    }
    return needed;
}

/**
 * Rasterise this notebook's graphics and patch them into the open document.
 * Cheap and kernel-free when the PNGs already exist (names are content hashes).
 */
async function runGraphicsPass(vscode, doc, opts) {
    opts = opts || {};
    const marker = doc.metadata && doc.metadata.wolfbookNbImport;
    if (!marker) return { applied: 0 };

    const plain = docToPlainCells(doc);
    const tasks = collectTasks(plain, marker.importId);
    if (!tasks.length) return { applied: 0 };

    const { imgDir, imgRel } = imgPathsFor(doc.uri.fsPath);
    const allCached = tasks.every(t => fs.existsSync(path.join(imgDir, t.file)));

    let res;
    if (allCached || !kernelAssist.kernelAvailable()) {
        res = await gfx.renderGraphics(tasks, { imgDir });
    } else {
        res = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Wolfbook: rendering ${tasks.length} graphic(s) from ${path.basename(doc.uri.fsPath)}…`,
                cancellable: true,
            },
            async (_p, token) => {
                const controller = new AbortController();
                token.onCancellationRequested(() => controller.abort());
                return gfx.renderGraphics(tasks, { imgDir, signal: controller.signal });
            }
        );
    }

    const applied = nbModel.applyGraphics(plain, res.rendered, imgRel);
    if (!applied.changed.length) {
        if (!opts.silent && res.error) {
            vscode.window.showWarningMessage('Wolfbook: could not render graphics — ' + res.error);
        }
        return { applied: 0, error: res.error };
    }

    const edit = new vscode.WorkspaceEdit();
    const nbEdits = [];
    for (const idx of applied.changed) {
        const cell = plain[idx];
        const live = doc.cellAt(idx);
        if (!live) continue;
        if (cell.kind === 1) {
            // Replace the cell rather than edit its text: a markdown cell that is
            // showing its rendered preview does not re-render on a programmatic
            // text edit, so the reader would keep seeing the placeholder until
            // they clicked into the cell.
            const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, cell.value, 'markdown');
            data.metadata = cell.metadata;
            nbEdits.push(vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(idx, idx + 1), [data]));
        } else {
            nbEdits.push(vscode.NotebookEdit.updateCellOutputs(
                idx, cell.outputs.map(o => plainOutputToVscode(vscode, o))));
            nbEdits.push(vscode.NotebookEdit.updateCellMetadata(idx, cell.metadata));
        }
    }
    if (nbEdits.length) edit.set(doc.uri, nbEdits);
    await vscode.workspace.applyEdit(edit);

    // Patching dirties the document; saving writes the original .nb bytes back
    // unchanged (see serializer.js), which clears the dirty flag without
    // touching the user's file content.
    try { await doc.save(); } catch (_) { /* a dirty tab is not worth an error */ }

    if (!opts.silent && res.error) {
        vscode.window.showWarningMessage('Wolfbook: some graphics could not be rendered — ' + res.error);
    }
    return { applied: applied.applied, error: res.error };
}

// ---------------------------------------------------------------------------
// Commands

function isNbUri(uri) {
    return !!uri && typeof uri.fsPath === 'string' && uri.fsPath.toLowerCase().endsWith('.nb');
}

/** The sibling .wb path, plus the first free variant (base-2.wb, base-3.wb, …). */
function wbPathsFor(nbFsPath) {
    const dir  = path.dirname(nbFsPath);
    const base = path.basename(nbFsPath).replace(/\.nb$/i, '');
    const preferred = path.join(dir, base + '.wb');
    let free = preferred, n = 2;
    while (fs.existsSync(free) && n < 100) {
        free = path.join(dir, base + '-' + n + '.wb');
        n++;
    }
    return { preferred, free };
}

/** Collect cells that the JS flattener marked approximate. */
function collectApprox(cells) {
    const out = [];
    cells.forEach((c, i) => {
        const meta = c.metadata && c.metadata.nbImport;
        if (meta && meta.approx && meta.boxSource) out.push({ index: i, boxSource: meta.boxSource });
    });
    return out;
}

/** Overwrite approximate cell values with kernel-exact code. */
function applyRefinements(cells, results) {
    for (const r of results) {
        const cell = cells[r.index];
        if (!cell || cell.kind !== 2) continue;
        cell.value = r.code;
        if (cell.metadata && cell.metadata.nbImport) delete cell.metadata.nbImport.approx;
    }
}

function findOpenNbDoc(vscode, uri) {
    return vscode.workspace.notebookDocuments.find(
        d => d.notebookType === NOTEBOOK_TYPE && d.uri.toString() === uri.toString()) || null;
}

async function saveNbCopyAsWb(vscode, arg) {
    const forceDialog = !!(arg && arg.forceDialog);

    let uri = isNbUri(arg) ? arg : null;
    if (!uri) {
        const ed = vscode.window.activeNotebookEditor;
        if (ed && isNbUri(ed.notebook.uri)) uri = ed.notebook.uri;
    }
    if (!uri) {
        vscode.window.showWarningMessage('Wolfbook: open a Mathematica .nb file first, or right-click one in the Explorer.');
        return;
    }

    // Prefer the open document: it carries the user's edits and any graphics
    // already rendered. Fall back to converting the file from disk.
    const openDoc = findOpenNbDoc(vscode, uri);
    let cells, metadata, importId;
    if (openDoc) {
        await runGraphicsPass(vscode, openDoc, { silent: true });
        const fresh = findOpenNbDoc(vscode, uri) || openDoc;
        cells    = docToPlainCells(fresh);
        metadata = Object.assign({}, fresh.metadata);
        importId = metadata.wolfbookNbImport && metadata.wolfbookNbImport.importId;
    } else {
        let converted;
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const deps = Object.assign({}, getDeps(), { resolveImage: imageResolverFor(uri.fsPath) });
            converted = nbModel.importNb(new util.TextDecoder().decode(bytes), deps,
                { mode: 'save', sourceName: path.basename(uri.fsPath) });
        } catch (e) {
            vscode.window.showErrorMessage('Wolfbook: could not read ' + path.basename(uri.fsPath) + ' — ' + (e.message || e));
            return;
        }
        cells    = converted.cells;
        metadata = converted.metadata;
        importId = metadata.wolfbookNbImport && metadata.wolfbookNbImport.importId;
        rememberGraphics(importId, converted.graphicsTasks);

        const { imgDir, imgRel } = imgPathsFor(uri.fsPath);
        const tasks = collectTasks(cells, importId);
        if (tasks.length) {
            const res = await gfx.renderGraphics(tasks, { imgDir });
            nbModel.applyGraphics(cells, res.rendered, imgRel);
        }
    }

    // Exactness pass for cells the flattener could not model.
    const approx = collectApprox(cells);
    if (approx.length && kernelAssist.kernelAvailable()) {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Wolfbook: refining ${approx.length} cell(s) with the Wolfram kernel…`, cancellable: true },
            async (_progress, token) => {
                const controller = new AbortController();
                token.onCancellationRequested(() => controller.abort());
                const res = await kernelAssist.refineCells(approx, { signal: controller.signal });
                if (res.ok) applyRefinements(cells, res.results);
            }
        );
    }

    nbModel.clearGraphicsPlaceholders(cells);
    for (const c of cells) {
        if (c.metadata) delete c.metadata.nbImport;   // import bookkeeping, not user data
    }

    // The copy is a real .wb: it must be saveable, so drop the read-only marker
    // (which also drops the embedded original .nb source).
    const outMeta = Object.assign({}, metadata);
    delete outMeta.wolfbookNbImport;
    outMeta.importedFromNb = uri.fsPath;

    // Never silently clobber an existing .wb — let the user confirm the name.
    const { preferred, free } = wbPathsFor(uri.fsPath);
    let target = preferred;
    if (forceDialog || fs.existsSync(preferred)) {
        const picked = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(fs.existsSync(preferred) ? free : preferred),
            filters: { 'Wolfbook Notebook': ['wb'] },
            title: fs.existsSync(preferred)
                ? path.basename(preferred) + ' already exists — choose a name'
                : 'Save as Wolfbook notebook',
        });
        if (!picked) return;
        target = picked.fsPath;
    }

    try {
        const json = JSON.stringify({ cells, metadata: outMeta }, null, 1);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(target), new util.TextEncoder().encode(json));
    } catch (e) {
        vscode.window.showErrorMessage('Wolfbook: could not write ' + path.basename(target) + ' — ' + (e.message || e));
        return;
    }

    // Hand the user the editable copy in place of the read-only view.
    const active = vscode.window.activeNotebookEditor;
    if (active && active.notebook.uri.toString() === uri.toString()) {
        try { await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); } catch (_) {}
    }
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(target), NOTEBOOK_TYPE);
    vscode.window.showInformationMessage('✅ Wolfbook: saved ' + path.basename(target));
}

async function refineOpenNotebook(vscode) {
    const ed = vscode.window.activeNotebookEditor;
    if (!ed) { vscode.window.showWarningMessage('Wolfbook: no notebook is active.'); return; }
    const doc = ed.notebook;

    const approx = collectApprox(docToPlainCells(doc));
    if (!approx.length) {
        vscode.window.showInformationMessage('Wolfbook: no approximate cells to refine in this notebook.');
        return;
    }
    if (!kernelAssist.kernelAvailable()) {
        vscode.window.showWarningMessage('Wolfbook: no Wolfram kernel found, so imported cells cannot be refined.');
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Wolfbook: refining ${approx.length} cell(s) with the Wolfram kernel…`, cancellable: true },
        async (_progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            const res = await kernelAssist.refineCells(approx, { signal: controller.signal });
            if (!res.ok) {
                vscode.window.showWarningMessage('Wolfbook: kernel refinement failed — ' + (res.error || 'unknown error'));
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            const metaEdits = [];
            for (const r of res.results) {
                const cell = doc.cellAt(r.index);
                if (!cell || cell.kind !== vscode.NotebookCellKind.Code) continue;
                const full = cell.document.validateRange(
                    new vscode.Range(0, 0, cell.document.lineCount, 0));
                edit.replace(cell.document.uri, full, r.code);
                const meta = Object.assign({}, cell.metadata);
                if (meta.nbImport) { meta.nbImport = Object.assign({}, meta.nbImport); delete meta.nbImport.approx; }
                metaEdits.push(vscode.NotebookEdit.updateCellMetadata(r.index, meta));
            }
            // set() replaces every edit recorded for a URI, so it goes in once.
            if (metaEdits.length) edit.set(doc.uri, metaEdits);
            await vscode.workspace.applyEdit(edit);
            vscode.window.showInformationMessage(`✅ Wolfbook: refined ${res.results.length} cell(s) with the Wolfram kernel.`);
        }
    );
}

// ---------------------------------------------------------------------------

function registerNbImport(context) {
    const vscode = require('vscode');

    context.subscriptions.push(
        vscode.commands.registerCommand('wolfbook.saveNbCopyAsWb', (arg) => saveNbCopyAsWb(vscode, arg)),
        vscode.commands.registerCommand('wolfbook.refineNbImportWithKernel', () => refineOpenNotebook(vscode)),
    );

    context.subscriptions.push(vscode.workspace.onDidOpenNotebookDocument((doc) => {
        if (doc.notebookType !== NOTEBOOK_TYPE || !isNbUri(doc.uri)) return;

        // Rasterise plots and pasted images into img/<name>/ and patch them in.
        // Anything already on disk was resolved during deserialisation, so this
        // only runs when a graphic is genuinely being rendered for the first time.
        runGraphicsPass(vscode, doc, {}).catch(() => {});

        // One-time explanation the first time a .nb is opened.
        if (context.globalState.get('wolfbook.nbImportNoticeSeen')) return;
        setTimeout(() => {
            vscode.window.showInformationMessage(
                'Wolfbook opened this Mathematica notebook as a read-only view. Saving it (⌘S) writes an editable .wb copy beside it.',
                'Save .wb copy now', 'Dismiss'
            ).then(choice => {
                context.globalState.update('wolfbook.nbImportNoticeSeen', true);
                if (choice === 'Save .wb copy now') saveNbCopyAsWb(vscode, doc.uri);
            });
        }, 900);
    }));
}

module.exports = {
    isNbSource: nbModel.isNbSource,
    deserializeNbNotebook,
    importForHost,
    originalSourceOf,
    registerNbImport,
};
