// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeSettleVSCodeCheck.cjs): type a burst into a real paper on
// the WLaTeX lane, wired as index.js wires it (live previews AND the settling
// full build after the pause), then wait for the settle to land. Records the
// extension host event-loop stalls with a timeline of what ran, and a CPU
// profile across the landing. Writes vscode-settle.json (+ settle.cpuprofile).
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
    const { main, text = ' the quick brown fox', paceMs = 120 } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { paper: main };
    const output = vscode.window.createOutputChannel('WPaper native settle');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    const subs = [];
    const T0 = performance.now(), at = () => Math.round(performance.now() - T0);
    const timeline = [];
    const note = what => timeline.push(`${at()} ${what}`);
    try {
        const doc = await vscode.workspace.openTextDocument(path.join(folder, main));
        const editor = await vscode.window.showTextDocument(doc);
        // As index.js wires it.
        subs.push(vscode.workspace.onDidChangeTextDocument(e => {
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
        await new Promise(r => setTimeout(r, 1500));
        // What runs on this thread, timed: the suspects for a freeze.
        const timed = (obj, name, label = name) => {
            const f = obj[name]; if (typeof f !== 'function') return;
            obj[name] = function (...args) {
                const t = performance.now(); let out;
                try { out = f.apply(this, args); } catch (e) { note(`${label} threw`); throw e; }
                const done = () => { const ms = performance.now() - t; if (ms > 20) note(`${label} ${Math.round(ms)} ms`); };
                if (out && typeof out.then === 'function') out.then(done, done); else done();
                return out;
            };
        };
        timed(coord, 'build'); timed(coord, '_modelFor'); timed(coord, '_runNativeRefresh'); timed(coord, '_runInteractive');
        timed(viewer, 'refresh', 'viewer.refresh'); timed(viewer, '_postSections'); timed(viewer, '_postLabels'); timed(viewer, '_syncNativeCursor');
        const log = coord.log?.bind(coord);
        if (log) coord.log = (m) => { if (/compile|ok ·|superseded|render map|identical|sent generation/.test(m)) note(String(m).trim().slice(0, 90)); return log(m); };
        const post = viewer._post.bind(viewer);
        viewer._post = m => { if (m && ['open', 'txdlBuilt', 'engine', 'compileState'].includes(m.type)) note(`post ${m.type}`); return post(m); };
        // Event-loop stalls.
        const stalls = []; let tick = performance.now();
        const lagTimer = setInterval(() => { const now = performance.now(); if (now - tick > 40) { stalls.push({ at: Math.round(tick - T0), ms: Math.round(now - tick) }); note(`STALL ${Math.round(now - tick)} ms`); } tick = now; }, 5);
        let profiler = null;
        if (process.env.WPAPER_SETTLE_PROFILE !== '0') {
            profiler = new (require('node:inspector').Session)(); profiler.connect();
            await new Promise(r => profiler.post('Profiler.enable', () => profiler.post('Profiler.setSamplingInterval', { interval: 500 }, () => profiler.post('Profiler.start', r))));
        }
        // A burst of typing, a pause long enough for the settle, and a second burst during the settle.
        const line = proseLine(doc);
        const type = async (s) => { for (const ch of s) { const t = performance.now(); await editor.edit(b => b.insert(doc.lineAt(line).range.end, ch)); await new Promise(r => setTimeout(r, Math.max(0, paceMs - (performance.now() - t)))); } };
        note('typing 1'); await type(text);
        note('pause'); const gen0 = st.generation.generation;
        await until(() => coord.stateFor(doc).generation.generation > gen0 && !coord.stateFor(doc).compiling, 'the settle', 60000).catch(() => note('no settle within 60 s'));
        note('settled'); await new Promise(r => setTimeout(r, 3000));
        note('typing 2'); await type(' again');
        await new Promise(r => setTimeout(r, 9000));
        clearInterval(lagTimer);
        if (profiler) {
            const profile = await new Promise(r => profiler.post('Profiler.stop', (e, res) => r(res.profile)));
            fs.writeFileSync(path.join(folder, '../settle.cpuprofile'), JSON.stringify(profile));
            profiler.disconnect();
        }
        report.stalls = { count: stalls.length, total_ms: stalls.reduce((a, s) => a + s.ms, 0), max_ms: Math.max(0, ...stalls.map(s => s.ms)) };
        report.timeline = timeline;
        report.result = 'PASS';
    } catch (error) {
        report.result = 'FAIL';
        report.error = error.stack || error.message;
        report.timeline = timeline;
    } finally {
        for (const s of subs) s.dispose();
        fs.writeFileSync(path.join(folder, '../vscode-settle.json'), JSON.stringify(report, null, 2));
        try { viewer.dispose?.(); coord.dispose?.(); } catch (_) {}
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
};
