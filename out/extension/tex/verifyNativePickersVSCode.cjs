// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativePickersVSCodeCheck.cjs): inserting a cross-reference and a
// citation from the page on a real paper, through the viewer's own handlers.
// With the ink caret on a word, ⌘⇧R must offer the paper's labels (with the
// numbers the build printed) and ⌘⇧C its bibliography; the chosen one must be
// inserted at the caret as \ref/\eqref or \cite, and the next live build must
// not find it undefined.
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
    const output = vscode.window.createOutputChannel('WPaper native pickers');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    const pickers = [];
    const statuses = [];
    { const post = viewer._post.bind(viewer); viewer._post = m => { if (m?.type === 'picker') pickers.push(m); if (m?.type === 'status') statuses.push(m.text); return post(m); }; }
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    let subscription;
    try {
        const file = path.join(folder, main);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        await viewer.open(doc);
        await coord.build(doc);
        const st = coord.stateFor(doc);
        if (st.generation?.runner !== 'wlatex') throw Error(`not on the WLaTeX lane: ${st.lastError || st.nativeUnavailable || st.nativeOff}`);
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'the PDF open in the viewer');
        // The paper as it was: its pages and the citations it left undefined.
        const undefinedCites = () => new Set((st.generation?.diagnostics || []).map(d => /Citation `([^']+)'.*undefined/.exec(d.message)?.[1]).filter(Boolean));
        const pagesBefore = st.generation.pageCount, undefinedBefore = undefinedCites();
        subscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== doc) return;
            coord.noteChange(event);
            coord._schedulePreview(doc.uri.fsPath, st);
        });
        await st.nativeLane.warmInteractive();
        const builds = [];
        const run = coord._runInteractive.bind(coord);
        coord._runInteractive = async (...a) => { const r = await run(...a); builds.push(r); return r; };
        const lines = doc.getText().split('\n');
        const begin = lines.findIndex(l => l.includes('\\begin{document}'));
        const prose = lines.findIndex((l, i) => i > begin + 5 && l.length > 50 && !/[\\$%{}]/.test(l));
        const wordAt = lines[prose].indexOf(' ', Math.floor(lines[prose].length / 2)) + 1;
        await until(() => st.map?.available && st.map.glyphsForLine(file, prose + 1).length, 'the line in the map', 30000);
        const glyph = st.map.glyphsForLine(file, prose + 1).find(e => e.hit.preferred_source.location.start.column_utf16 === wordAt);
        await viewer._jumpToSource({ generation: viewer._openedGeneration, page: glyph.page, xBp: glyph.x + 0.5, yTopBp: glyph.y + glyph.boxHeight / 2 });
        check(!!viewer._ink, 'a caret on the page');
        const key = async (k, extra = {}) => { viewer._onMessage({ type: 'inkKey', key: k, ...extra }); await viewer._inkQueue; };
        // A reference.
        await key('picker:ref');
        const refs = pickers.at(-1);
        report.labels = refs?.items.length ?? 0;
        report.numbered = refs?.items.filter(i => i.printed).length ?? 0;
        check(report.numbered > 0, 'the reference picker lists numbered labels');
        const target = refs?.items.find(i => i.printed && i.kind !== 'label') || refs?.items.find(i => i.printed);
        const n0 = builds.length, offset = viewer._ink.offset;
        await key('insert', { kind: 'ref', name: target.key, equation: target.kind === 'equation' });
        const inserted = doc.getText().slice(offset - 1, offset + target.key.length + 12);
        check(inserted.includes(`ref{${target.key}}`), `the reference is in the source: ${inserted}`);
        report.ref = { key: target.key, kind: target.kind, printed: target.printed, source: inserted.trim() };
        await until(() => builds.slice(n0).some(b => b?.ok), 'a live build with the reference', 30000);
        const refBuild = builds.slice(n0).find(b => b?.ok);
        check(!(refBuild.diagnostics || []).some(d => d.message.includes(`\`${target.key}'`) && /undefined/.test(d.message)), 'the reference is defined on the live page');
        // A citation.
        await key('picker:cite');
        const cites = pickers.at(-1);
        report.bibliography = cites?.items.length ?? 0;
        if (report.bibliography) {
            const entry = cites.items[Math.floor(cites.items.length / 2)];
            const n1 = builds.length, at = viewer._ink.offset;
            await key('insert', { kind: 'cite', name: entry.key });
            const text = doc.getText().slice(at - 1, at + entry.key.length + 10);
            check(text.includes(`cite{${entry.key}}`), `the citation is in the source: ${text}`);
            report.cite = { key: entry.key, source: text.trim() };
            await until(() => builds.slice(n1).some(b => b?.ok), 'a live build with the citation', 30000);
            const citeBuild = builds.slice(n1).find(b => b?.ok);
            check(!(citeBuild.diagnostics || []).some(d => d.message.includes(`\`${entry.key}'`) && /undefined/.test(d.message)), 'the citation is defined on the live page');
        }
        // From INSPIRE: a recent record none of these papers has.
        const answers = [];
        { const post = viewer._post.bind(viewer); viewer._post = m => { if (m?.type === 'inspireResults') answers.push(m); return post(m); }; }
        await viewer._inspireSearch({ q: '2607.01328', seq: 7 });
        const answer = answers.find(a => a.seq === 7);
        check(answer && !answer.error && answer.items.length, `INSPIRE answers: ${answer?.error || answer?.items.length}`);
        const record = answer?.items[0];
        if (record) {
            const n2 = builds.length;
            await key('insert', { kind: 'cite', name: record.key, inspire: record.recid });
            // Right after the citation just inserted, it joins it: \\cite{a,key}.
            check(new RegExp(`\\\\cite\\{[^}]*\\b${record.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`).test(doc.getText()), 'the INSPIRE citation is in the source');
            report.inspire = { key: record.key, added_to: statuses.filter(t => t.startsWith(record.key)).pop() || null };
            // The settle: the new citation defined, and nothing the paper had defined lost.
            await coord.build(doc, { quiet: true });
            const undefinedAfter = undefinedCites();
            const lost = [...undefinedAfter].filter(k => !undefinedBefore.has(k) && k !== record.key);
            check(st.generation?.ok, `the settle builds (${st.generation?.stopReason || ''})`);
            check(!undefinedAfter.has(record.key), 'the settle defines the INSPIRE citation');
            check(!lost.length, `no citation the paper had is lost: ${lost.slice(0, 5).join(', ')}`);
            check(Math.abs((st.generation?.pageCount ?? 0) - pagesBefore) <= 1, `the paper keeps its length: ${pagesBefore} -> ${st.generation?.pageCount}`);
            report.inspire.pages = [pagesBefore, st.generation?.pageCount];
            report.inspire.undefined_citations = [undefinedBefore.size, undefinedAfter.size];
        }
        report.failures = failures;
        report.result = failures.length ? 'FAIL' : 'PASS';
    } catch (error) {
        report.result = 'FAIL';
        report.failures = failures;
        report.error = String(error?.stack || error);
    } finally { subscription?.dispose(); }
    fs.writeFileSync(path.join(folder, '../vscode-pickers.json'), JSON.stringify(report, null, 2));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
};
