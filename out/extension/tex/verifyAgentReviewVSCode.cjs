// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchAgentReviewVSCodeCheck.cjs). Writes vscode-review.json.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { RenderCoordinator } = require('./renderUi');
const { Projection } = require('./index');
const { TexViewer } = require('./texViewer');
const { ReviewUi } = require('./reviewUi');
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
    const output = vscode.window.createOutputChannel('WPaper agent review');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    const timeline = [];
    const T0 = Date.now(), note = what => timeline.push(`${Date.now() - T0} ${what}`);
    const subs = [];
    let review_ = null, file_ = null;
    try {
        const file = file_ = path.join(folder, main);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        // As index.js wires the review.
        const review = review_ = new ReviewUi({ coord, viewer, output,
            mapView: (f) => viewer._reviewMap(coord.roots.get(coord.rootFor({ uri: { fsPath: f } }) || f) || coord.roots.get(f), f) });
        const register = vscode.commands.registerCommand;
        vscode.commands.registerCommand = (id, fn) => { try { return register(id, fn); } catch (_) { return { dispose() {} }; } };
        try { review.register(context); } finally { vscode.commands.registerCommand = register; }
        viewer.attachReview(review);
        subs.push(coord.onDidChange(() => {
            try { const p = viewer.refresh(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
            try { review.refreshPlacement(); } catch (_) {}
        }));
        await viewer.open(doc);
        await coord.build(doc);
        const st = coord.stateFor(doc);
        if (st.generation?.runner !== 'wlatex') throw Error('not on the WLaTeX lane');
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'the PDF open in the viewer');
        await sleep(1500);
        const post = viewer._post.bind(viewer);
        viewer._post = m => {
            if (m && m.type === 'compileState') note(`compileState ${!!m.compiling}`);
            if (m && m.type === 'open') {
                note(`open generation ${m.generation}`);
                // A hidden window's panel never finishes drawing a re-opened
                // PDF: answer for it, as a shown panel does once it has.
                setTimeout(() => viewer._onMessage({ type: 'opened', generation: m.generation, pdfHash: m.pdfHash || null }).catch(() => {}), 50);
            }
            if (m && m.type === 'reviewFocus') note(`reviewFocus generation ${m.generation} page ${m.page} rects ${(m.rects || []).length}`);
            return post(m);
        };
        const opened0 = viewer._openedGeneration;
        // The agent rewrites a sentence well into the paper, on disk.
        const before = fs.readFileSync(file, 'utf8');
        const lines = before.split('\n');
        const at = lines.findIndex((l, i) => i > lines.length * 0.6 && /^[A-Z][a-z]+ [a-z]+ [a-z]+ [a-z]+/.test(l));
        lines[at] = `The agent rewrote this sentence. ${lines[at]}`;
        fs.writeFileSync(file, lines.join('\n'));
        await until(() => doc.getText().includes('The agent rewrote this sentence.'), 'the editor to take the disk change', 20000);
        await review.noteAgentChange({ file, baseText: before, source: 'disk' });
        // As index.js does for an agent's disk write: the waited-for build, with the glow.
        note('agent change noted');
        viewer.compileForAgent(file);
        await until(() => timeline.some(l => / open generation /.test(l)) && !st.compiling, 'the build after the agent\'s change', 180000);
        await sleep(300);
        const i = (re) => timeline.findIndex(l => re.test(l));
        report.agentBuild = { glow: i(/compileState true/), glowOff: i(/compileState false/), open: i(/ open generation /) };
        report.agentGlowed = report.agentBuild.glow >= 0 && report.agentBuild.glow < report.agentBuild.open;
        const s = review.sessionFor(file);
        if (!s || !s.hunks.length) throw Error('no change to review');
        note('step to the change');
        report.behind = viewer.reviewPageBehind(s.generation);
        await review.step(file, 1);
        await until(() => timeline.some(l => / reviewFocus generation /.test(l) && Number(/generation (\d+)/.exec(l)[1]) > opened0), 'the focus on the new PDF', 180000);
        report.order = { glow: i(/compileState true/), open: i(/ open generation /), focus: i(/ reviewFocus /) };
        report.timeline = timeline;
        report.nativeMapAfter = !!st.map?.native;
        // The agent's build already brought the page up to date: stepping needs no second compile.
        report.result = report.agentGlowed && report.nativeMapAfter && !report.behind && report.order.glow >= 0 && report.order.glow < report.order.open && report.order.open < report.order.focus ? 'PASS' : 'FAIL';
    } catch (error) {
        try {
            const s = review_ && review_.sessionFor(file_);
            report.debug = { focus: viewer._reviewFocus && { id: viewer._reviewFocus.id, generation: viewer._reviewFocus.generation, pending: viewer._reviewFocus.pending },
                opened: viewer._openedGeneration, focused: review_ && review_.focused.get(file_),
                session: s && { generation: s.generation, ids: s.hunks.map(h => h.id) } };
        } catch (_) {}
        report.result = 'FAIL';
        report.error = error.stack || error.message;
        report.timeline = timeline;
    } finally {
        for (const s of subs) s.dispose();
        fs.writeFileSync(path.join(folder, '../vscode-review.json'), JSON.stringify(report, null, 2));
        try { viewer.dispose?.(); coord.dispose?.(); } catch (_) {}
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
};
