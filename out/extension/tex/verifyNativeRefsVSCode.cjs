// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeRefsVSCodeCheck.cjs): a new reference on a real paper. A
// \ref to a new label is added in the first part of the body and the \label
// after a later \section, as one edit; reported is the time until a live build
// no longer finds the reference undefined (the page prints the section's
// number), and the reference passes that took.
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
async function until(predicate, label, timeoutMs = 60000, intervalMs = 5) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { paper: main };
    const output = vscode.window.createOutputChannel('WPaper native refs');
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
        report.settle_build_ms = Math.round(st.generation.ms);
        subscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== doc) return;
            coord.noteChange(event);
            coord._schedulePreview(doc.uri.fsPath, st);
        });
        await st.nativeLane.warmInteractive();
        const builds = [];
        const run = coord._runInteractive.bind(coord);
        coord._runInteractive = async (...a) => {
            const start = performance.now();
            const r = await run(...a);
            builds.push({ start, end: performance.now(), result: r });
            return r;
        };
        // A live build first, so the lane is warm and reads the settled .aux.
        await editor.edit(b => b.insert(doc.lineAt(doc.lineCount - 1).range.end, '\n'));
        await until(() => builds.some(b => b.result?.ok), 'a first live build', 120000);
        await new Promise(r => setTimeout(r, 1500));
        const lines = doc.getText().split('\n');
        const begin = lines.findIndex(l => l.includes('\\begin{document}'));
        const sections = lines.map((l, i) => [l, i]).filter(([l, i]) => i > begin && /^\s*\\(sub)*section\*?\{[^}]*\}\s*$/.test(l)).map(([, i]) => i);
        const target = sections[Math.floor(sections.length * 2 / 3)];
        const prose = lines.findIndex((l, i) => i > begin + 5 && l.length > 40 && !/^\s*[\\%]/.test(l) && !l.includes('$'));
        if (target === undefined || prose < 0) throw Error('no section or prose line to use');
        report.section_line = target + 1; report.ref_line = prose + 1;
        const n0 = builds.length;
        const t0 = performance.now();
        await editor.edit(b => {
            b.insert(doc.lineAt(target).range.end, '\\label{wlzz}');
            b.insert(doc.lineAt(prose).range.end, ' (see Section~\\ref{wlzz})');
        });
        const undefinedIn = r => (r?.diagnostics || []).some(d => /Reference `wlzz' on page \d+ undefined/.test(d.message));
        await until(() => builds.slice(n0).some(b => b.result?.ok && !undefinedIn(b.result)), 'the reference resolved live', 60000);
        const resolved = builds.slice(n0).find(b => b.result?.ok && !undefinedIn(b.result));
        report.resolved_ms = Math.round(resolved.end - t0);
        report.first_build_undefined = undefinedIn(builds[n0]?.result);
        report.builds_until_resolved = builds.slice(n0).indexOf(resolved) + 1;
        report.reference_pass_ms = Math.round(resolved.end - resolved.start);
        report.without_reference_pass_ms = `>= ${2500 + report.settle_build_ms} (settle delay + a settle build)`;
        report.result = 'PASS';
    } catch (error) {
        report.result = 'FAIL';
        report.error = String(error?.stack || error);
    } finally { subscription?.dispose(); }
    fs.writeFileSync(path.join(folder, '../vscode-refs.json'), JSON.stringify(report, null, 2));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
};
