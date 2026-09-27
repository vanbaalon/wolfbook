// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeTypingVSCodeCheck.cjs): typing into a real paper on the
// WLaTeX lane, one key at a time at a steady pace, as the editor delivers it.
// For every key: the time until the editor holds it, and until the viewer is
// sent the first live page of a build that started after it (the page that
// shows the key). Keys are typed into a prose line in the middle of the body.
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
async function until(predicate, label, timeoutMs = 120000, intervalMs = 2) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}
const quantile = (v, q) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };

/** A prose line in the middle of the body (as the corpus runner picks them). */
function proseLine(doc) {
    const lines = doc.getText().split('\n');
    const begin = lines.findIndex(l => l.includes('\\begin{document}'));
    const env = /\\(begin|end)\{(equation|align|gather|multline|eqnarray|tabular|table|figure|tikzpicture|verbatim|lstlisting|minted)/;
    const out = []; let math = 0;
    for (let i = begin + 1; i < lines.length; i++) {
        const l = lines[i], m = env.exec(l);
        if (m && m[1] === 'begin') math++;
        if (m && m[1] === 'end') { math = Math.max(0, math - 1); continue; }
        if (math || l.length < 50 || /^\s*[\\%]/.test(l) || l.includes('$') || l.includes('\\end{document}') || !l.slice(l.length / 2).includes(' ')) continue;
        out.push(i);
    }
    return out[Math.floor(out.length / 2)];
}

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main, text = ' the quick brown fox jumps', paceMs = 120 } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { paper: main, pace_ms: paceMs };
    const output = vscode.window.createOutputChannel('WPaper native typing');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    let subscription;
    try {
        const doc = await vscode.workspace.openTextDocument(path.join(folder, main));
        const editor = await vscode.window.showTextDocument(doc);
        await viewer.open(doc);
        await coord.build(doc);
        const st = coord.stateFor(doc);
        if (st.generation?.runner !== 'wlatex') throw Error(`not on the WLaTeX lane: ${st.lastError || st.nativeUnavailable || st.nativeOff}`);
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'the PDF open in the viewer');
        report.pages = st.generation.pageCount;
        const lane = st.nativeLane;
        // Every live build: when it started and when its first page reached the viewer.
        const builds = [];
        const interactiveBuild = lane.interactiveBuild.bind(lane);
        lane.interactiveBuild = async o => {
            const build = { start: performance.now(), firstPage: null, page: null };
            builds.push(build);
            const result = await interactiveBuild({ ...o, onPage: page => {
                o.onPage?.(page);
                if (build.firstPage == null && page.changed !== false && page.txdl) { build.firstPage = performance.now(); build.page = page.page; }
            } });
            build.end = performance.now();
            build.superseded = result == null;
            build.engine = result?.report ? { first_changed: result.report.first_changed_ms, total: result.report.total_ms } : null;
            return result;
        };
        // Every page read of the maps (cold and live) while typing.
        const reads = [];
        const readPages = lane.source.readPages.bind(lane.source);
        lane.source.readPages = (pages, o = {}) => {
            const r = { live: !!o.live, pages: pages.length, start: performance.now() };
            reads.push(r);
            return readPages(pages, o).then(view => { r.ms = performance.now() - r.start; r.hits = view.pages.reduce((n, p) => n + p.hits.length, 0); return view; });
        };
        // How long the extension host's event loop is held up while typing.
        const lags = [];
        let tick = performance.now();
        const stalls = [];
        const lagTimer = setInterval(() => { const now = performance.now(); lags.push(now - tick - 1); if (now - tick > 50) stalls.push({ at: tick, ms: now - tick }); tick = now; }, 1);
        subscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== doc) return;
            coord.noteChange(event);
            // What scheduleLive does on a keystroke (live rendering is off in
            // this harness so the settle builds stay out of the timing).
            coord._schedulePreview(doc.uri.fsPath, st);
        });
        // One untimed key first: the lane's first preview after the open.
        const line = proseLine(doc);
        report.line = line + 1;
        await editor.edit(b => b.insert(doc.lineAt(line).range.end, ' '));
        await until(() => builds.some(b => b.firstPage), 'the first preview');
        await new Promise(resolve => setTimeout(resolve, 500));
        const keys = [];
        // A CPU profile of the extension host while typing, when asked for.
        let inspectorSession = null;
        if (process.env.WPAPER_TYPING_PROFILE) {
            inspectorSession = new (require('node:inspector').Session)();
            inspectorSession.connect();
            await new Promise(r => inspectorSession.post('Profiler.enable', () => inspectorSession.post('Profiler.setSamplingInterval', { interval: 500 }, () => inspectorSession.post('Profiler.start', r))));
        }
        for (const ch of text) {
            const t0 = performance.now();
            await editor.edit(b => b.insert(doc.lineAt(line).range.end, ch));
            keys.push({ t0, applied: performance.now() - t0 });
            await new Promise(resolve => setTimeout(resolve, Math.max(0, paceMs - (performance.now() - t0))));
        }
        await until(() => builds.every(b => b.firstPage != null || performance.now() - b.start > 5000), 'the last preview', 20000);
        if (inspectorSession) {
            const profile = await new Promise(r => inspectorSession.post('Profiler.stop', (e, res) => r(res.profile)));
            fs.writeFileSync(process.env.WPAPER_TYPING_PROFILE, JSON.stringify(profile));
            inspectorSession.disconnect();
        }
        await new Promise(resolve => setTimeout(resolve, 300));
        // A key is on the page when a build that started after the editor
        // held it delivers its first page.
        const latency = keys.map(k => {
            const shown = builds.filter(b => b.start >= k.t0 && b.firstPage != null).map(b => b.firstPage);
            return shown.length ? Math.min(...shown) - k.t0 : null;
        });
        const shown = latency.filter(v => v != null);
        // Split: key -> the build that shows it starts, and that build's start -> its first page.
        const waits = keys.map(k => { const b = builds.filter(b => b.start >= k.t0 && b.firstPage != null).sort((x, y) => x.firstPage - y.firstPage)[0];
            return b ? { wait: b.start - k.t0, build: b.firstPage - b.start } : null; }).filter(Boolean);
        report.key_to_build_start_ms = { p50: quantile(waits.map(w => w.wait), 0.5), p90: quantile(waits.map(w => w.wait), 0.9) };
        report.showing_build_to_page_ms = { p50: quantile(waits.map(w => w.build), 0.5), p90: quantile(waits.map(w => w.build), 0.9) };
        report.keys = keys.length;
        report.shown = shown.length;
        report.edit_applied_ms = { p50: quantile(keys.map(k => k.applied), 0.5), p90: quantile(keys.map(k => k.applied), 0.9) };
        report.key_to_page_ms = { p50: quantile(shown, 0.5), p90: quantile(shown, 0.9), max: Math.max(...shown) };
        clearInterval(lagTimer);
        const typed = reads.filter(r => r.start >= keys[0].t0);
        report.map_reads = ['cold', 'live'].map(kind => { const r = typed.filter(x => x.live === (kind === 'live'));
            return { kind, reads: r.length, pages: r.reduce((n, x) => n + x.pages, 0), hits: r.reduce((n, x) => n + (x.hits || 0), 0), max_pages: Math.max(0, ...r.map(x => x.pages)) }; });
        if (process.env.WPAPER_TYPING_TIMELINE) {
            const t0 = keys[0].t0, r = v => Math.round(v - t0);
            report.timeline = [...keys.map(k => ({ at: r(k.t0), what: 'key' })),
                ...typed.map(x => ({ at: r(x.start), what: `${x.live ? 'live' : 'cold'} read ${x.pages} pages, ${Math.round(x.ms || -1)} ms` })),
                ...stalls.filter(x => x.at >= t0).map(x => ({ at: r(x.at), what: `stall ${Math.round(x.ms)} ms` })),
                ...builds.filter(b => b.start >= t0).map(b => ({ at: r(b.start), what: `build -> page ${b.firstPage ? Math.round(b.firstPage - b.start) : '-'}` }))]
                .sort((a, b) => a.at - b.at).map(e => `${e.at} ${e.what}`);
        }
        report.builds = builds.length;
        report.superseded = builds.filter(b => b.superseded).length;
        report.event_loop_lag_ms = { p50: quantile(lags, 0.5), p90: quantile(lags, 0.9), p99: quantile(lags, 0.99), max: Math.max(...lags),
            over_50ms: lags.filter(l => l > 50).length, total_over_50ms: Math.round(lags.filter(l => l > 50).reduce((a, b) => a + b, 0)) };
        const engine = builds.filter(b => b.engine);
        report.engine_first_changed_ms = { p50: quantile(engine.map(b => b.engine.first_changed), 0.5), p90: quantile(engine.map(b => b.engine.first_changed), 0.9) };
        report.build_first_page_ms = { p50: quantile(builds.filter(b => b.firstPage).map(b => b.firstPage - b.start), 0.5),
            p90: quantile(builds.filter(b => b.firstPage).map(b => b.firstPage - b.start), 0.9) };
        report.result = shown.length === keys.length ? 'PASS' : 'FAIL';
    } catch (error) {
        report.result = 'FAIL';
        report.error = String(error?.stack || error);
    } finally {
        subscription?.dispose();
    }
    fs.writeFileSync(path.join(folder, '../vscode-typing.json'), JSON.stringify(report, null, 2));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
};
