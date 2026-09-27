// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeFormatVSCodeCheck.cjs): formatting from the page on a real
// paper, through the viewer's own handlers. A word selected on the page is
// made bold and then plain again (a toggle, not nesting); a section heading
// goes one level down; at the ink caret, ⌘B opens a bold group that the
// typing goes into and ⌘B again steps out of it. The source is checked after
// each (the second press at once, before the map is re-read).
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
    const output = vscode.window.createOutputChannel('WPaper native format');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    let subscription;
    try {
        const file = path.join(folder, main);
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc);
        await viewer.open(doc);
        await coord.build(doc);
        const st = coord.stateFor(doc);
        if (st.generation?.runner !== 'wlatex') throw Error(`not on the WLaTeX lane: ${st.lastError || st.nativeUnavailable || st.nativeOff}`);
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'the PDF open in the viewer');
        subscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== doc) return;
            coord.noteChange(event);
            coord._schedulePreview(doc.uri.fsPath, st);
        });
        await st.nativeLane.warmInteractive();
        const lines = doc.getText().split('\n');
        const begin = lines.findIndex(l => l.includes('\\begin{document}'));
        const prose = lines.findIndex((l, i) => i > begin + 5 && l.length > 50 && !/[\\$%{}]/.test(l));
        const words = [...lines[prose].matchAll(/[A-Za-z]{5,}/g)];
        const word = words[Math.floor(words.length / 2)];
        const range = new vscode.Range(prose, word.index, prose, word.index + word[0].length);
        report.word = word[0];
        // Select the word as the page would (the editor's selection, synced to the page).
        const select = async r => {
            await until(() => st.map?.available && st.map.glyphsForLine(file, r.start.line + 1).length, 'the word in the map', 30000);
            editor.selection = new vscode.Selection(r.start, r.end);
            viewer.syncFromEditor(editor);
            await until(() => viewer._lastSelection && viewer._lastSelection.start.isEqual(r.start) && viewer._lastSelection.end.isEqual(r.end), 'the page selection', 10000);
        };
        await select(range);
        await viewer._selectionAction({ action: 'bold' });
        check(doc.lineAt(prose).text.includes(`\\textbf{${word[0]}}`), `bold: ${doc.lineAt(prose).text.slice(word.index - 5, word.index + word[0].length + 12)}`);
        // Pressed again at once, before the map is re-read: plain again.
        await viewer._selectionAction({ action: 'bold' });
        check(doc.lineAt(prose).text === lines[prose], `bold again is plain: ${doc.lineAt(prose).text.slice(word.index - 5, word.index + word[0].length + 12)}`);
        // A heading one level down.
        const sectionLine = doc.getText().split('\n').findIndex((l, i) => i > begin && /^\s*\\section\{[^}]+\}\s*$/.test(l));
        if (sectionLine > 0) {
            const text = doc.lineAt(sectionLine).text, title = /\\section\{([^}]+)\}/.exec(text);
            const s = text.indexOf(title[1]);
            await select(new vscode.Range(sectionLine, s, sectionLine, s + title[1].length));
            await viewer._selectionAction({ action: 'heading' });
            check(doc.lineAt(sectionLine).text.includes(`\\subsection{${title[1]}}`), `heading: ${doc.lineAt(sectionLine).text}`);
            report.heading_checked = true;
        }
        // ⌘B at the ink caret: type into a bold group, then step out of it.
        // After the pause the edits start the map's re-read; a click resolved
        // while the map is being replaced is dropped (a known race), so the
        // check clicks once it has been replaced.
        await new Promise(r => setTimeout(r, 600));
        await until(() => st.map?.available && !st.nativeRefreshing, 'the map', 30000);
        const glyph = st.map.glyphsForLine(file, prose + 1).find(e => e.hit.preferred_source.location.start.column_utf16 === word.index);
        await viewer._jumpToSource({ generation: viewer._openedGeneration, page: glyph.page, xBp: glyph.x + 0.5, yTopBp: glyph.y + glyph.boxHeight / 2 });
        check(!!viewer._ink, 'a caret on the page');
        const key = async k => { viewer._onMessage({ type: 'inkKey', key: k }); await viewer._inkQueue; };
        await key('format:bold'); await key('N'); await key('B'); await key('format:bold'); await key(' ');
        const now = doc.lineAt(prose).text;
        check(now.slice(word.index, word.index + 14) === '\\textbf{NB} ' + word[0].slice(0, 2), `⌘B at the caret: ${now.slice(word.index - 3, word.index + 18)}`);
        report.failures = failures;
        report.result = failures.length ? 'FAIL' : 'PASS';
    } catch (error) {
        report.result = 'FAIL';
        report.failures = failures;
        report.error = String(error?.stack || error);
    } finally { subscription?.dispose(); }
    fs.writeFileSync(path.join(folder, '../vscode-format.json'), JSON.stringify(report, null, 2));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
};
