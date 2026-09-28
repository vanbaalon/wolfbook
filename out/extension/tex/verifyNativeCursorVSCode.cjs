// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeCursorVSCodeCheck.cjs): the caret moved by the reader in a
// real paper on the WLaTeX lane must light its word on the page and scroll to
// it, on the first build and after an edit has been typeset. The editor is
// wired as index.js wires it (edits reach the coordinator and the viewer).
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
    const report = { paper: main, moves: [] };
    const output = vscode.window.createOutputChannel('WPaper native cursor');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    const subs = [];
    try {
        const doc = await vscode.workspace.openTextDocument(path.join(folder, main));
        const editor = await vscode.window.showTextDocument(doc);
        subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document !== doc) return;
            coord.noteChange(e);
            viewer.noteSourceChanged(e.document);
            if (viewer.isOpen && viewer.isOpen()) coord.scheduleLive(e.document);
        }));
        // As index.js's paintRender: every coordinator change refreshes the viewer.
        subs.push(coord.onDidChange(() => { try { const p = viewer.refresh(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }));
        await viewer.open(doc);
        await coord.build(doc);
        let st = coord.stateFor(doc);
        if (st.generation?.runner !== 'wlatex') throw Error(`not on the WLaTeX lane: ${st.lastError || st.nativeUnavailable || st.nativeOff}`);
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'the PDF open in the viewer');
        report.pages = st.generation.pageCount;
        const posts = [];
        const post = viewer._post.bind(viewer);
        viewer._post = (m) => { if (m && (m.type === 'highlight' || m.type === 'traceState' || m.type === 'selection')) posts.push({ at: Date.now(), ...m }); return post(m); };
        // Prose lines well inside the body: a word to put the caret in.
        const lines = doc.getText().split('\n');
        const begin = lines.findIndex(l => /\\begin\{document\}/.test(l));
        const prose = [];
        for (let i = begin + 20; i < lines.length && prose.length < 6; i += 37) {
            if (/^[A-Za-z][a-z]+ [a-z]+ [a-z]+/.test(lines[i]) && !/\\/.test(lines[i].slice(0, 30))) prose.push(i);
        }
        const diagnose = () => {
            const s = coord.stateFor(doc), map = s && s.map;
            return {
                panel: !!viewer.panel, followCursor: viewer.followCursor, native: !!map?.native,
                available: !!map?.available, sameState: s === st,
                openedPdfHash: viewer._openedPdfHash?.slice(0, 12), mapPdfHash: map?.view?.artifact?.pdf_hash?.slice(0, 12),
                generationPdfHash: s?.generation?.pdfHash?.slice(0, 12), sourceAhead: !!s?.sourceAhead,
                tracePaused: !!viewer._tracePaused, compiling: !!s?.compiling,
            };
        };
        const move = async (label) => {
            for (const line of prose.slice(0, 3)) {
                // Inside the second word: a caret between two of its letters.
                const character = lines[line].indexOf(' ') + 2;
                const at = new vscode.Position(line, character);
                editor.selection = new vscode.Selection(at, at);
                const since = Date.now();
                viewer.syncFromEditor(editor, { userCursorGesture: true });
                let hit = null;
                try {
                    await until(() => (hit = posts.find(p => p.at >= since && p.type === 'highlight' && p.rects?.length)), 'a highlight', 3000);
                } catch (_) { /* recorded below */ }
                // How long the page took to answer, and what it was sent meanwhile
                // (a clear before the answer is a visible blink).
                const sent = posts.filter(p => p.at >= since && (!hit || p.at <= hit.at));
                report.moves.push({ when: label, line: line + 1, highlighted: !!hit, reveal: hit ? !!hit.reveal : null,
                    ms: hit ? hit.at - since : null,
                    blank: sent.some(p => p !== hit && p.type === 'highlight' && !p.rects?.length),
                    caret: hit ? !!hit.caret : null,
                    rects: hit ? hit.rects.length : 0, label: hit ? hit.label : (posts.filter(p => p.at >= since).map(p => p.label || p.type).join(' | ') || 'nothing posted'),
                    ...(hit ? {} : { state: diagnose() }) });
                await sleep(300);
            }
        };
        await sleep(1500);
        await move('first build');
        // Every message across the webview after the edit, for diagnosis.
        const traffic = [];
        const t0 = Date.now();
        subs.push(viewer.panel.webview.onDidReceiveMessage(m => traffic.push([Date.now() - t0, 'in', m && m.type, m && (m.type === 'pdfRangeRequest' ? `req ${m.request} ${m.begin}-${m.end} tok ${String(m.token).slice(0, 8)}` : (m.message || m.error || m.text || m.generation || ''))])));
        const post2 = viewer._post.bind(viewer);
        viewer._post = (m) => { traffic.push([Date.now() - t0, 'out', m && m.type, m && (m.type === 'pdfRange' ? `req ${m.request} ${m.error || (m.data ? m.data.length + 'b64' : '')}` : m.type === 'open' ? `gen ${m.generation} range ${JSON.stringify(m.pdfRange || null).slice(0, 80)}` : (m.generation || ''))]); return post2(m); };
        report.traffic = traffic;
        // An edit: two characters typed into a prose line, then the build it starts.
        const target = prose[3] ?? prose[0];
        const gen0 = st.generation.generation;
        await editor.edit(b => b.insert(new vscode.Position(target, lines[target].length), ' x'));
        await until(() => { st = coord.stateFor(doc); return st.generation && st.generation.generation > gen0 && !st.compiling; }, 'the build of the edit', 120000);
        await sleep(4000);
        report.afterEdit = diagnose();
        await move('after an edit');
        // An edit that prints nothing (a comment): the build's PDF is the same
        // page, so nothing is shipped — the caret must still be followed.
        const gen1 = coord.stateFor(doc).generation.generation;
        const t2 = prose[4] ?? prose[1];
        await editor.edit(b => b.insert(new vscode.Position(t2, doc.lineAt(t2).text.length), ' % a note'));
        await until(() => { st = coord.stateFor(doc); return st.generation && st.generation.generation > gen1 && !st.compiling; }, 'the build of the comment', 120000);
        await sleep(4000);
        report.afterComment = diagnose();
        await move('after a comment edit');
        const failed = report.moves.filter(m => !m.highlighted || !m.reveal || !m.caret);
        report.result = failed.length ? 'FAIL' : 'PASS';
    } catch (error) {
        report.result = 'FAIL';
        report.error = error.stack || error.message;
    } finally {
        for (const s of subs) s.dispose();
        fs.writeFileSync(path.join(folder, '../vscode-cursor.json'), JSON.stringify(report, null, 2));
        try { viewer.dispose?.(); coord.dispose?.(); } catch (_) {}
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
};
