// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeFirstOpenVSCodeCheck.cjs): opening a paper on the WLaTeX
// lane, as the Page command does it (the panel first, then the build), in two
// sessions of the same project:
//   first open:  the live pages are posted before the first PDF, and how much
//                sooner (liveStart and the first txdlPage against the PDF's
//                open and the webview's `opened`);
//   reopening:   a new coordinator and viewer (a restarted VS Code) start
//                from the settled build the first session kept: the live
//                lane reads its auxiliary files before any build of its own,
//                and the first cold build is seeded and settles in one pass.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { RenderCoordinator } = require('./renderUi');
const { Projection } = require('./index');
const { TexViewer } = require('./texViewer');
const { NativeBuildLane } = require('./nativeCompileService');
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

async function session(doc, output) {
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    const times = {};
    const t0 = performance.now();
    const stamp = name => { if (times[name] == null) times[name] = Math.round(performance.now() - t0); };
    const post = viewer._post.bind(viewer);
    viewer._post = message => {
        if (message?.type === 'liveStart') stamp('live_start_ms');
        if (message?.type === 'txdlPage') stamp('first_live_page_ms');
        if (message?.type === 'open') stamp('pdf_posted_ms');
        return post(message);
    };
    // The auxiliary files the live lane's first build is given.
    let liveAuxiliary = null;
    const auxiliaryTexts = NativeBuildLane.prototype._auxiliaryTexts;
    NativeBuildLane.prototype._auxiliaryTexts = function () {
        const texts = auxiliaryTexts.call(this);
        if (liveAuxiliary == null) liveAuxiliary = Object.keys(texts);
        return texts;
    };
    const onMessage = viewer._onMessage.bind(viewer);
    viewer._onMessage = message => { if (message?.type === 'opened') stamp('pdf_shown_ms'); return onMessage(message); };
    try {
        await viewer.open(doc);
        const st = coord.stateFor(doc);
        await coord.build(doc);
        if (st.generation?.runner !== 'wlatex') throw Error(`not on the WLaTeX lane: ${st.lastError || st.nativeUnavailable || st.nativeOff}`);
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'the PDF open in the viewer');
        const settlement = st.generation.nativeReport.build.settlement;
        return { ...times, build_ms: st.generation.ms && Math.round(st.generation.ms), pages: st.generation.pageCount,
            passes: settlement.passes, seeded: settlement.seeded, settled: settlement.settled, live_auxiliary: liveAuxiliary,
            kept_seed: fs.existsSync(path.join(st.nativeLane.settledSeed, 'build.json')) };
    } finally {
        NativeBuildLane.prototype._auxiliaryTexts = auxiliaryTexts;
        try { viewer.panel?.dispose(); } catch (_) { /* closed */ }
        coord.dispose();
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const output = vscode.window.createOutputChannel('WPaper native first open');
    const report = { paper: main };
    try {
        const doc = await vscode.workspace.openTextDocument(path.join(folder, main));
        await vscode.window.showTextDocument(doc);
        report.first_open = await session(doc, output);
        report.reopen = await session(doc, output);
        const failures = [];
        for (const [name, s] of Object.entries({ first_open: report.first_open, reopen: report.reopen })) {
            if (!(s.first_live_page_ms < s.pdf_posted_ms)) failures.push(`${name}: no live page before the PDF`);
            if (!(s.live_start_ms <= s.first_live_page_ms)) failures.push(`${name}: liveStart did not precede the first live page`);
        }
        if (report.first_open.seeded) failures.push('first open: seeded, though nothing was kept yet');
        if (report.first_open.live_auxiliary.length) failures.push('first open: the live lane had auxiliary files, though nothing was kept yet');
        if (!report.first_open.kept_seed) failures.push('first open: the settled build was not kept');
        if (!report.reopen.seeded || report.reopen.passes !== 1) failures.push(`reopen: not a one-pass seeded build (${report.reopen.passes} passes)`);
        if (!report.reopen.live_auxiliary.some(name => name.endsWith('.aux'))) failures.push('reopen: the live lane had no auxiliary files before its first build');
        report.failures = failures;
        report.result = failures.length ? 'FAIL' : 'PASS';
    } catch (error) {
        report.result = 'FAIL';
        report.error = String(error?.stack || error);
    }
    fs.writeFileSync(path.join(folder, '../vscode-first-open.json'), JSON.stringify(report, null, 2));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
};
