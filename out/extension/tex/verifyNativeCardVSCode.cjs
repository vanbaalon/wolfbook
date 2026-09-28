// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeCardVSCodeCheck.cjs): on the WLaTeX lane in real VS Code,
// how long a right-click on a table takes to open its card (and where the time
// goes), and whether the TikZ tool gets a drawing of a figure page nobody has
// edited near. Writes vscode-card.json.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { RenderCoordinator } = require('./renderUi');
const { Projection } = require('./index');
const { TexViewer } = require('./texViewer');
const memento = () => { const values = new Map(); return {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => { values.set(key, value); },
}; };
async function until(predicate, label, timeoutMs = 120000, intervalMs = 20) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { paper: main };
    const output = vscode.window.createOutputChannel('WPaper native card');
    const coord = new RenderCoordinator(new Projection(), output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, coord.projection || new Projection());
    const subs = [];
    try {
        const doc = await vscode.workspace.openTextDocument(path.join(folder, main));
        await vscode.window.showTextDocument(doc);
        subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document !== doc) return;
            coord.noteChange(e);
            viewer.noteSourceChanged(e.document);
            if (viewer.isOpen && viewer.isOpen()) coord.scheduleLive(e.document);
        }));
        subs.push(coord.onDidChange(() => { try { const p = viewer.refresh(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }));
        await viewer.open(doc);
        await coord.build(doc);
        const st = coord.stateFor(doc);
        if (st.generation?.runner !== 'wlatex') throw Error(`not on the WLaTeX lane: ${st.lastError || st.nativeUnavailable || st.nativeOff}`);
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'the PDF open in the viewer');
        await sleep(1500);
        const posts = [];
        const post = viewer._post.bind(viewer);
        viewer._post = (m) => { posts.push({ at: Date.now(), type: m && m.type, page: m && m.page, text: m && m.text, forTikz: m && m.forTikz }); return post(m); };
        // Where the time goes: the steps of opening a card, timed.
        const timings = [];
        for (const name of ['_resolvePoint', '_modelFor', '_blockAt', '_editRects', '_jumpToSource', '_openEditSession']) {
            const f = viewer[name];
            if (typeof f !== 'function') continue;
            viewer[name] = function (...args) {
                const t = Date.now(); const out = f.apply(this, args);
                if (out && typeof out.then === 'function') return out.finally(() => timings.push([name, Date.now() - t]));
                timings.push([name, Date.now() - t]); return out;
            };
        }
        const lines = doc.getText().split('\n');
        const at = async (re, offset) => {
            const line = lines.findIndex(l => re.test(l)) + 1 + offset;
            const col = Math.max(0, lines[line - 1].search(/\S/)) + 1;
            const rects = await st.map.forwardAt(doc.uri.fsPath, line, col);
            if (!rects || !rects.length) throw Error(`no printed glyph at line ${line}`);
            const r = rects[0];
            return { line, page: r.page, xBp: r.x + r.w / 2, yTopBp: r.y + r.h / 2 };
        };
        // 1. A right-click on a table cell (the webview sends editHere).
        const cell = await at(/\\begin\{tabular\}/, 2);
        report.table = { at: cell };
        for (const round of [1, 2]) {
            timings.length = 0;
            const t0 = Date.now();
            await viewer._onMessage({ type: 'editHere', page: cell.page, xBp: cell.xBp, yTopBp: cell.yTopBp, generation: st.generation.generation });
            const opened = posts.find(p => p.at >= t0 && p.type === 'editOpen');
            report.table[`round${round}`] = { openMs: opened ? opened.at - t0 : null, handlerMs: Date.now() - t0, steps: timings.slice() };
            await viewer._onMessage({ type: 'editClose', editId: viewer._edit?.id });
            await sleep(500);
        }
        // 1b. The same right-click just after a keystroke elsewhere (typing
        // invalidates the settled map until its re-read).
        {
            const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
            const prose = lines.findIndex((l, i) => i > 200 && /^[A-Za-z][a-z]+ [a-z]+ [a-z]+/.test(l));
            await editor.edit(b => b.insert(new vscode.Position(prose, lines[prose].length), ' x'));
            await sleep(200);
            timings.length = 0;
            const t0 = Date.now();
            await viewer._onMessage({ type: 'editHere', page: cell.page, xBp: cell.xBp, yTopBp: cell.yTopBp, generation: viewer._openedGeneration });
            const opened = posts.find(p => p.at >= t0 && p.type === 'editOpen');
            report.table.afterKey = { openMs: opened ? opened.at - t0 : null, handlerMs: Date.now() - t0, steps: timings.slice(),
                said: posts.filter(p => p.at >= t0 && p.type === 'status').map(p => p.text) };
            await viewer._onMessage({ type: 'editClose', editId: viewer._edit?.id });
        }
        // 2. The TikZ tool turned on over a figure page (the webview asks for
        // display lists of the pages in view it has none for).
        const fig = await at(/\\begin\{tikzpicture\}/, 1).catch(async () => at(/\\begin\{tikzpicture\}/, 2));
        const t1 = Date.now();
        await viewer._onMessage({ type: 'tikzPages', pages: [fig.page] });
        await until(() => posts.some(p => p.at >= t1 && p.type === 'txdlPage' && p.page === fig.page), 'a display list of the figure page', 20000).catch(() => {});
        const got = posts.find(p => p.at >= t1 && p.type === 'txdlPage' && p.page === fig.page);
        report.tikz = { page: fig.page, latestPages: [...(viewer._txdlLatest?.keys?.() || [])].length,
            deliveredMs: got ? got.at - t1 : null,
            // What the panel's renderer is told it cannot draw on each figure page.
            figurePages: await (async () => {
                const out = {};
                for (const [i, l] of lines.entries()) if (/\\begin\{tikzpicture\}/.test(l)) {
                    const where = await at(new RegExp('^' + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), 1).catch(() => null);
                    const msg = where && viewer._txdlLatest?.get(where.page);
                    if (where) out[`line ${i + 1} page ${where.page}`] = msg ? (msg.txdl?.unsupported || []) : 'no display list';
                }
                return out;
            })(),
            status: posts.filter(p => p.at >= t1 && p.type === 'status').map(p => p.text) };
        // The TikZ tool then asks which source drew the page's paths: that
        // needs the page's live source map.
        {
            const lane = viewer._tikzLane?.();
            const ready = await lane?.session?.ensureLiveMaps?.([fig.page]).catch(e => ({ error: e.message }));
            const specials = await lane?.liveSpecials?.(fig.page, [0, 1, 2]).catch(e => `error: ${e.message}`);
            report.tikz.liveMap = { lane: !!lane, ready, specials: specials === null ? null : Array.isArray(specials) ? specials.map(x => !!x) : specials };
        }
        // 3. What the panel asks next (tikzModel in tex-viewer.js) and what it gets back.
        report.tikz.resolve = {};
        for (const page of new Set(Object.keys(report.tikz.figurePages).map(k => Number(k.split(' page ')[1])))) {
            const txdl = viewer._txdlLatest?.get(page)?.txdl;
            const paths = (txdl?.ops || []).filter(op => op.op === 'path' && op.picture && !op.clip);
            const t = Date.now();
            let reply = null;
            const post3 = viewer._post;
            viewer._post = (m) => { if (m && m.type === 'tikzResolved') reply = m; return post3.call(viewer, m); };
            await viewer._onMessage({ type: 'tikzResolve', key: `k${page}`, page,
                specials: [...new Set(paths.map(p => p.special))], pictures: [...new Set(paths.map(p => p.picture.special))] });
            viewer._post = post3;
            const pics = [...new Set(paths.map(p => p.picture.special))];
            const origins = await viewer._tikzLane()?.liveSpecials(page, pics).catch(e => e.message);
            report.tikz.origins = { ...(report.tikz.origins || {}), [page]: { pics, root: viewer.root,
                origins: Array.isArray(origins) ? origins.map(o => o && { invocation: o.invocation && { file: o.invocation.file, start: o.invocation.location?.start },
                    definition: o.definition && { file: o.definition.file, start: o.definition.location?.start } }) : origins } };
            report.tikz.resolve[page] = { ms: Date.now() - t, paths: paths.length, pictures: Object.keys(reply?.pictures || {}).length,
                mapped: Object.keys(reply?.paths || {}).length, statements: Object.values(reply?.pictures || {}).map(p => p.statements.length),
                error: reply ? reply.error : 'no reply' };
        }
        report.result = report.table.round1.openMs != null && report.table.afterKey.openMs != null && report.tikz.deliveredMs != null
            && Object.values(report.tikz.resolve).every(r => !r.paths || r.mapped === r.paths) ? 'PASS' : 'FAIL';
    } catch (error) {
        report.result = 'FAIL';
        report.error = error.stack || error.message;
    } finally {
        for (const s of subs) s.dispose();
        fs.writeFileSync(path.join(folder, '../vscode-card.json'), JSON.stringify(report, null, 2));
        try { viewer.dispose?.(); coord.dispose?.(); } catch (_) {}
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
};
