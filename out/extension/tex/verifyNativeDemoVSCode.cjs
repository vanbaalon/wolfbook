// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeDemoCapture.cjs, which films the window): the WLaTeX Pro
// demo on a real paper, driven through the viewer's own handlers at a human
// pace. The paper opens beside its source (live pages first, the "WLaTeX Pro
// is on" card), a word is clicked and a phrase typed on the page, a word is
// made bold, a cross-reference and a citation (from INSPIRE) are inserted
// with the pickers — whose search boxes the recorder types into, as a reader
// would — and the paper settles. Steps are logged to demo-steps.json.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { RenderCoordinator } = require('./renderUi');
const { Projection } = require('./index');
const { TexViewer } = require('./texViewer');
const memento = (initial = []) => { const values = new Map(initial); return {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => { values.set(key, value); },
}; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, label, timeoutMs = 60000, intervalMs = 20) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
        await sleep(intervalMs);
    }
}

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const run = path.dirname(folder);
    const { main, phrase = 'The page follows every keystroke ', bold = 'exactly', refQuery = 'sec', citeQuery = 'two-dimensional fishnet' } =
        JSON.parse(fs.readFileSync(path.join(run, 'acceptance-mode.json'), 'utf8'));
    const steps = [];
    const t0 = Date.now();
    const step = what => { steps.push({ at: Date.now() - t0, what }); fs.writeFileSync(path.join(run, 'demo-steps.json'), JSON.stringify(steps, null, 1)); };
    // The recorder types into the webview's pickers: it is asked, and answers, through this file.
    const phaseFile = path.join(run, 'demo-phase.json');
    const phase = (name, extra = {}) => fs.writeFileSync(phaseFile, JSON.stringify({ phase: name, ...extra }));
    const answered = name => { try { return JSON.parse(fs.readFileSync(phaseFile, 'utf8')).done === name; } catch (_) { return false; } };
    const output = vscode.window.createOutputChannel('WPaper demo');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    // The first-run tour is not part of this film.
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(),
        globalState: memento([['wolfbook.tex.tour', { done: true, started: true, at: 0 }]]), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    let subscription;
    const report = { paper: main };
    try {
        for (const c of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel', 'notifications.toggleDoNotDisturbMode'])
            await vscode.commands.executeCommand(c).then(() => {}, () => {});
        phase('opening');
        await sleep(2500);                                   // the recorder starts
        const file = path.join(folder, main);
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        step('open the paper beside its source');
        await viewer.open(doc);
        subscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== doc) return;
            coord.noteChange(event);
            coord.scheduleLive(doc);
        });
        const st = coord.stateFor(doc);
        // As the extension wires them: a build's new state reaches the viewer.
        const changes = coord.onDidChange(() => { viewer.refresh().catch(() => {}); });
        context.subscriptions.push(changes);
        await coord.build(doc, { quiet: true });
        await until(() => viewer._openedPdfHash === st.generation?.pdfHash, 'the PDF', 120000);
        await sleep(2500);                                   // the intro card, read
        viewer._onMessage({ type: 'proIntro', action: 'ok' });
        viewer._postEngine(st);
        step('WLaTeX Pro is on');
        // A prose line in the middle, brought into view the way the editor does it.
        const lines = doc.getText().split('\n');
        const begin = lines.findIndex(l => l.includes('\\begin{document}'));
        // A sentence that starts inside a prose line: the new one goes before it.
        const candidates = lines.map((l, i) => i).filter(i => i > begin + 20 && lines[i].length > 60 && !/[\\$%{}]/.test(lines[i]) && /\. [A-Z][a-z]/.test(lines[i]));
        const line = candidates[Math.floor(candidates.length / 3)];
        const wordAt = lines[line].search(/\. [A-Z][a-z]/) + 2;
        editor.selection = new vscode.Selection(line, wordAt, line, wordAt);
        editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
        viewer.followMode = 'scroll';
        viewer.syncFromEditor(editor);
        await sleep(1500);
        await until(() => st.map?.available && st.map.glyphsForLine(file, line + 1).length, 'the line on the page', 30000);
        const glyph = st.map.glyphsForLine(file, line + 1).find(e => e.hit.preferred_source.location.start.column_utf16 === wordAt);
        await viewer._jumpToSource({ generation: viewer._openedGeneration, page: glyph.page, xBp: glyph.x + 0.5, yTopBp: glyph.y + glyph.boxHeight / 2 });
        step('click a word: the caret is on the page');
        await sleep(1200);
        const key = async (k, extra = {}, pace = 115) => { viewer._onMessage({ type: 'inkKey', key: k, ...extra }); await viewer._inkQueue; await sleep(pace); };
        step('type on the page');
        for (const ch of phrase) await key(ch);
        await sleep(900);
        step('⌘B: bold');
        await key('format:bold', {}, 250);
        for (const ch of bold) await key(ch);
        await key('format:bold', {}, 250);
        await sleep(1000);
        step('⌘⇧R: a cross-reference');
        for (const ch of ', as in Section ') await key(ch);
        const count = re => (doc.getText().match(re) || []).length;
        const refs = count(/\\(eq)?ref\{/g);
        await key('picker:ref', {}, 400);
        phase('picker', { query: refQuery, pick: 0 });
        await until(() => answered('picker'), 'the recorder to choose a reference', 30000);
        // The choice reaches the host from the webview: wait for it in the source.
        await until(() => count(/\\(eq)?ref\{/g) > refs, 'the reference in the source', 20000);
        await viewer._inkQueue;
        await sleep(1500);
        step('⌘⇧C: a citation from INSPIRE');
        for (const ch of ' and ') await key(ch);
        const cites = count(/\\cite\{/g);
        await key('picker:cite', {}, 400);
        phase('picker', { query: citeQuery, inspire: true, pick: 0 });
        await until(() => answered('picker'), 'the recorder to choose a citation', 60000);
        await until(() => count(/\\cite\{/g) > cites, 'the citation in the source', 30000);
        await viewer._inkQueue;
        await key('.'); await key(' ');
        await sleep(2000);
        step('pause: the paper settles');
        viewer._onMessage({ type: 'inkKey', key: 'Escape' });
        // Settled as the Pro badge says it (texViewer._postEngine): the PDF of
        // this text, BibTeX run on the new .bib entry, every citation numbered.
        const settled = () => !st.compiling && !st.authoritativeRunning && !st.sourceAhead &&
            st.generation?.runner === 'wlatex' && !st.generation.rerunWanted && viewer._openedPdfHash === st.generation.pdfHash;
        await until(settled, 'the settle', 40000).then(() => step('settled'), () => step('not settled in 40 s'));
        report.settle_state = { compiling: !!st.compiling, authoritative: !!st.authoritativeRunning, sourceAhead: !!st.sourceAhead,
            runner: st.generation?.runner, rerunWanted: !!st.generation?.rerunWanted, opened: viewer._openedPdfHash === st.generation?.pdfHash,
            generationAgeMs: st.generation?.finishedAt ? Date.now() - st.generation.finishedAt : null, lastError: st.lastError || null,
            dirty: doc.isDirty, liveTimer: coord._liveTimers?.has(doc.uri.fsPath) };
        await sleep(3000);
        step('end');
        report.result = 'PASS';
    } catch (error) {
        report.result = 'FAIL';
        report.error = String(error?.stack || error);
    } finally { subscription?.dispose(); }
    phase('finished');
    report.steps = steps;
    fs.writeFileSync(path.join(run, 'vscode-demo.json'), JSON.stringify(report, null, 2));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
};
