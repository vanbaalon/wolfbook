// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeDragVSCodeCheck.cjs): a selection dragged across a few
// printed lines of a real paper on the WLaTeX lane, as the page posts it (a
// pick with the press point, then a live pick every 60 ms, then the
// release). Times each step from the message to the selection posted back,
// and what it spent where. Writes vscode-drag.json.
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
async function until(predicate, label, timeoutMs = 120000, intervalMs = 5) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}
const quantile = (v, q) => { const s = [...v].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10 : null; };

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { paper: main };
    const output = vscode.window.createOutputChannel('WPaper native drag');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    try {
        const doc = await vscode.workspace.openTextDocument(path.join(folder, main));
        await vscode.window.showTextDocument(doc);
        await viewer.open(doc);
        await coord.build(doc);
        const st = coord.stateFor(doc);
        if (st.generation?.runner !== 'wlatex') throw Error('not on the WLaTeX lane');
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'the PDF open in the viewer');
        await until(() => st.map?.native && st.map.available, 'the native map');
        await new Promise(r => setTimeout(r, 2000));
        const map = st.map;
        // Four printed lines of body prose on one page: the drag's path.
        const lines = doc.getText().split('\n');
        const begin = lines.findIndex(l => l.includes('\\begin{document}'));
        let path_ = null;
        for (let i = Math.floor((begin + lines.length) / 2); i < lines.length && !path_; i++) {
            const g = map.glyphsForLine(doc.uri.fsPath, i + 1);
            if (g.length < 40) continue;
            const page = g[0].page;
            const rows = [...new Set(g.filter(x => x.page === page).map(x => Math.round(x.y)))];
            if (rows.length >= 2) path_ = g.filter(x => x.page === page);
        }
        if (!path_) throw Error('no prose paragraph to drag over');
        const first = path_[0], last = path_[path_.length - 1];
        report.page = first.page;
        // Stages, timed on this thread.
        const stages = new Map(); let current = null;
        const timed = (obj, name, label = name) => {
            const f = obj[name]; if (typeof f !== 'function') return;
            obj[name] = function (...args) {
                const t = performance.now(), step = current;
                const done = () => { if (step) step.stages[label] = (step.stages[label] || 0) + performance.now() - t; };
                let out;
                try { out = f.apply(this, args); } catch (e) { done(); throw e; }
                if (out && typeof out.then === 'function') out.then(done, done); else done();
                return out;
            };
        };
        timed(map, 'renderToSourceViaWorker', 'point → source (worker)');
        timed(map, 'renderToSource', 'point → source (local)');
        timed(map, 'nearestExact');
        timed(map, 'forwardRange', 'range → rectangles');
        timed(map, 'forwardAt', 'end glyphs');
        timed(vscode.workspace, 'openTextDocument');
        timed(vscode.window, 'showTextDocument');
        timed(viewer, '_postEditSelection');
        timed(viewer, '_syncNativeCursor', 'selection sync (total)');
        const steps = [];
        const post = viewer._post.bind(viewer);
        viewer._post = m => {
            if (m?.type === 'selection' && m.span?.native && !m.span.pendingStart && current) {
                current.painted = performance.now();
            }
            return post(m);
        };
        const send = async (x, y, extra) => {
            const step = { at: performance.now(), stages: {}, ...extra };
            steps.push(step);
            const m = { type: 'click', page: first.page, xBp: x, yTopBp: y, generation: viewer._openedGeneration,
                pick: true, from: { page: first.page, xBp: first.x + 1, yTopBp: first.y + first.boxHeight / 2 }, ...extra };
            const run = async () => { current = step; step.started = performance.now(); await viewer._onMessage(m); step.done = performance.now(); };
            return run();
        };
        // Press, then the moves (not awaited: the page does not wait), then release.
        await send(first.x + 1, first.y + first.boxHeight / 2, {});
        const moves = [];
        const n = 24;
        for (let i = 1; i <= n; i++) {
            const g = path_[Math.min(path_.length - 1, Math.floor(i * path_.length / n))];
            moves.push(send(g.x + g.w / 2, g.y + g.boxHeight / 2, { live: true }));
            await new Promise(r => setTimeout(r, 60));
        }
        await Promise.all(moves);
        await send(last.x + last.w / 2, last.y + last.boxHeight / 2, {});
        const answered = steps.filter(s => s.painted);
        report.steps = steps.length;
        report.answered = answered.length;
        report.latency_ms = { p50: quantile(answered.map(s => s.painted - s.at), 0.5), p90: quantile(answered.map(s => s.painted - s.at), 0.9) };
        report.work_ms = { p50: quantile(answered.map(s => s.painted - s.started), 0.5), p90: quantile(answered.map(s => s.painted - s.started), 0.9) };
        const names = [...new Set(answered.flatMap(s => Object.keys(s.stages)))];
        report.stages_p50_ms = Object.fromEntries(names.map(k => [k, quantile(answered.map(s => s.stages[k] || 0), 0.5)]));
        report.samples = answered.slice(0, 6).map(s => ({ live: !!s.live, latency: Math.round(s.painted - s.at), stages: Object.fromEntries(Object.entries(s.stages).map(([k, v]) => [k, Math.round(v * 10) / 10])) }));
        report.result = answered.length ? 'PASS' : 'FAIL';
    } catch (error) {
        report.result = 'FAIL';
        report.error = error.stack || error.message;
    } finally {
        fs.writeFileSync(path.join(folder, '../vscode-drag.json'), JSON.stringify(report, null, 2));
        try { viewer.dispose?.(); coord.dispose?.(); } catch (_) {}
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
};
