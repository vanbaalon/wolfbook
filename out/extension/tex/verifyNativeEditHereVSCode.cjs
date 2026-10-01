// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeEditHereVSCodeCheck.cjs): right-clicks on a native page (the mini-editor), fresh, right after typing and after the pause.
// printed lines of a real paper on the WLaTeX lane, as the page posts it (a
// pick with the press point, then a live pick every 60 ms, then the
// release). Times each step from the message to the selection posted back,
// and what it spent where. Writes vscode-edithere.json.
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
        const lines = doc.getText().split('\n');
        const begin = lines.findIndex(l => l.includes('\\begin{document}'));
        let line = -1, glyph = null;
        for (let i = Math.floor((begin + lines.length) / 2); i < lines.length; i++) {
            const g = map.glyphsForLine(doc.uri.fsPath, i + 1);
            if (g.length > 30 && !/^\s*[\\%]/.test(lines[i])) { line = i; glyph = g[Math.floor(g.length / 2)]; break; }
        }
        if (!glyph) throw Error('no prose line');
        const posts = [];
        const post = viewer._post.bind(viewer);
        viewer._post = m => {
            if (m && ['editOpen', 'status'].includes(m.type)) posts.push({ type: m.type, text: m.text, at: Date.now() });
            // A hidden window's panel never finishes drawing a re-opened PDF
            // (vscodeTestLaunch.cjs): answer for it, as a shown panel does.
            if (m?.type === 'open') report.opens = (report.opens || 0) + 1;
            if (m?.type === 'open' && process.env.WPAPER_TEST_VISIBLE !== '1')
                setTimeout(() => viewer._onMessage({ type: 'opened', generation: m.generation, pdfHash: m.pdfHash || null }).catch(() => {}), 50);
            return post(m);
        };
        const rightClick = async (label) => {
            posts.length = 0;
            await viewer._onMessage({ type: 'editHere', page: glyph.page, xBp: glyph.x + glyph.w / 2, yTopBp: glyph.y + glyph.boxHeight / 2,
                generation: viewer._openedGeneration });
            await new Promise(r => setTimeout(r, 300));
            const opened = posts.some(p => p.type === 'editOpen');
            report.clicks = [...(report.clicks || []), { label, opened, statuses: posts.filter(p => p.type === 'status').map(p => p.text),
                mapAvailable: !!st.map?.available, sourceAhead: !!st.sourceAhead, generation: viewer._openedGeneration,
                openedHash: viewer._openedPdfHash, mapHash: st.map?.view?.artifact?.pdf_hash, genHash: st.generation?.pdfHash,
                gen: st.generation?.generation, shown: viewer.shownGeneration, opens: report.opens || 0 }];
            if (viewer._edit) { viewer._edit = null; }
            return opened;
        };
        const sub = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document !== doc) return;
            coord.noteChange(e);
            viewer.noteSourceChanged(e.document);
            coord.scheduleLive(e.document);
        });
        coord.onDidChange(() => { try { const p = viewer.refresh(); if (p && p.catch) p.catch(() => {}); } catch (_) {} });
        await rightClick('fresh');
        const editor = vscode.window.activeTextEditor || await vscode.window.showTextDocument(doc);
        for (const ch of ' and a few more words typed here') {
            await editor.edit(b => b.insert(doc.lineAt(line).range.end, ch));
            await new Promise(r => setTimeout(r, 90));
        }
        await rightClick('right after typing');
        await new Promise(r => setTimeout(r, 8000));
        await rightClick('after the pause');
        report.result = report.clicks.every(c => c.opened) ? 'PASS' : 'FAIL';

    } catch (error) {
        report.result = 'FAIL';
        report.error = error.stack || error.message;
    } finally {
        fs.writeFileSync(path.join(folder, '../vscode-edithere.json'), JSON.stringify(report, null, 2));
        try { viewer.dispose?.(); coord.dispose?.(); } catch (_) {}
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
};
