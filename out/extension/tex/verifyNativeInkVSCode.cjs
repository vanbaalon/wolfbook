// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeInkVSCodeCheck.cjs): typing in the ink on a real paper, through
// the viewer's own handlers as the webview drives them. A click on a word of a
// prose line in the middle of the body must put a caret on the page; keys sent
// as the webview sends them must edit the source at that point (a word, a
// Backspace, `%` as `\%`, undo, arrows, Escape); after each key the caret must
// come back from the redrawn live page, and the time that takes is reported.
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
async function until(predicate, label, timeoutMs = 60000, intervalMs = 2) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}
const quantile = (v, q) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };

function proseLine(doc) {
    const lines = doc.getText().split('\n');
    const begin = lines.findIndex(l => l.includes('\\begin{document}'));
    const env = /\\(begin|end)\{(equation|align|gather|multline|eqnarray|tabular|table|figure|tikzpicture|verbatim|lstlisting|minted)/;
    const out = []; let math = 0;
    for (let i = begin + 1; i < lines.length; i++) {
        const l = lines[i], m = env.exec(l);
        if (m && m[1] === 'begin') math++;
        if (m && m[1] === 'end') { math = Math.max(0, math - 1); continue; }
        if (math || l.length < 50 || /^\s*[\\%]/.test(l) || /[$\\{}%]/.test(l) || l.includes('\\end{document}')) continue;
        out.push(i);
    }
    return out[Math.floor(out.length / 2)];
}

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { paper: main };
    const output = vscode.window.createOutputChannel('WPaper native ink');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    const carets = [];
    const post = viewer._post.bind(viewer);
    const pagesPosted = [];
    viewer._post = message => {
        if (message?.type === 'inkCaret') carets.push({ at: performance.now(), message });
        if (message?.type === 'txdlPage') pagesPosted.push(message.page);
        if (message?.type === 'editConflict' || (message?.type === 'status' && message.kind !== 'ok' && /edit|source/i.test(message.text || ''))) failures.push(`card: ${message.type} ${message.text?.slice?.(0, 120) || ''}`);
        return post(message);
    };
    let subscription;
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        const file = path.join(folder, main);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
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
        const lane = st.nativeLane;
        await lane.warmInteractive();
        // A word in the middle of a prose line: its first letter's glyph.
        const line = proseLine(doc);
        const lineText = doc.lineAt(line).text;
        const wordAt = lineText.indexOf(' ', Math.floor(lineText.length / 2)) + 1;
        // The cold map widens as the viewer's text sweep reaches the pages.
        const find = () => st.map?.available && st.map.glyphsForLine(file, line + 1).find(e => e.hit.preferred_source.location.start.column_utf16 === wordAt);
        await until(find, `the glyph at line ${line + 1} in the map`, 30000).catch(() => {});
        const glyph = find();
        if (!glyph) throw Error(`no glyph at line ${line + 1} column ${wordAt}`);
        report.line = line + 1;
        await viewer._jumpToSource({ generation: viewer._openedGeneration, page: glyph.page,
            xBp: glyph.x + 0.5, yTopBp: glyph.y + glyph.boxHeight / 2 });
        check(viewer._ink && viewer._ink.offset === doc.offsetAt(new vscode.Position(line, wordAt)), 'a click on a word puts the caret before it');
        if (!viewer._ink) throw Error('no caret after a click on prose');
        const placed = carets.at(-1)?.message;
        check(placed && placed.page === glyph.page && Math.abs(placed.x - glyph.x) < 1.5, `the caret is drawn at the word (${JSON.stringify(placed)})`);

        // Type a word: each key, then the caret back from the live page.
        const latencies = [];
        const key = async k => {
            const before = carets.length, t0 = performance.now();
            viewer._onMessage({ type: 'inkKey', key: k });
            await viewer._inkQueue;
            await until(() => carets.slice(before).some(c => !c.message.clear), `the caret after ${k}`, 10000).catch(() => {});
            const c = carets.slice(before).find(x => !x.message.clear);
            if (c) latencies.push(c.at - t0);
            await new Promise(r => setTimeout(r, 120));
            return c?.message;
        };
        const offset0 = viewer._ink.offset;
        let last = null;
        for (const ch of 'Ink ') last = await key(ch);
        check(doc.getText().slice(offset0, offset0 + 4) === 'Ink ', `typed text in the source: ${JSON.stringify(doc.getText().slice(offset0 - 5, offset0 + 12))}`);
        check(last && (last.x > placed.x + 5 || last.row !== placed.row), 'the caret moved on with the text');
        await key('Backspace');
        await key('Backspace');
        check(doc.getText().slice(offset0, offset0 + 3) === 'In' + lineText[wordAt], `Backspace deletes: ${JSON.stringify(doc.getText().slice(offset0, offset0 + 8))}`);
        await key('%');
        check(doc.getText().slice(offset0, offset0 + 4) === 'In\\%', `% is \\% in the source: ${JSON.stringify(doc.getText().slice(offset0, offset0 + 8))}`);
        await key('undo');
        check(doc.getText().slice(offset0, offset0 + 3) === 'In' + lineText[wordAt], `undo takes the \\% back: ${JSON.stringify(doc.getText().slice(offset0, offset0 + 8))}`);
        const atBefore = viewer._ink.offset;
        await key('ArrowRight');
        check(viewer._ink.offset > atBefore, 'ArrowRight moves on');
        await key('ArrowLeft');
        check(viewer._ink.offset === atBefore, 'ArrowLeft comes back');
        const rowBefore = viewer._ink.caret.row;
        await key('ArrowDown');
        check(viewer._ink.caret.row !== rowBefore, 'ArrowDown moves to the next row');
        // Track my changes (B7): the Pro panel's toggle, and a review to see it.
        const { ReviewUi } = require('./reviewUi');
        const review = new ReviewUi({ viewer, output, mapView: () => ({}) });
        {
            // The extension's own review is registered too: its commands exist.
            const register = vscode.commands.registerCommand;
            vscode.commands.registerCommand = (id, fn) => { try { return register(id, fn); } catch (_) { return { dispose() {} }; } };
            try { review.register(context); } finally { vscode.commands.registerCommand = register; }
        }
        await viewer._onMessage({ type: 'trackMine', on: true });
        check(vscode.workspace.getConfiguration('wolfbook.tex').get('trackMyChanges') === true, 'the Pro panel turns tracking on');
        const textBefore = doc.getText();
        for (const ch of 'Tr') await key(ch);
        await until(() => review.sessionFor(file)?.pendingCount, 'the review of the typing', 5000).catch(() => {});
        const rs = review.sessionFor(file);
        const ownBatch = rs && rs.hunks[0] && rs.batches.find(b => b.id === rs.firstSeen.get(rs.hunks[0].id));
        check(rs?.pendingCount === 1 && ownBatch?.source === 'you', `the typing is one change by You in the review (${rs?.pendingCount}, ${ownBatch?.source})`);
        if (rs?.hunks[0]) {
            await review.undo(file, rs.hunks[0].id);
            check(doc.getText() === textBefore, 'Undo in the review takes the typing back');
            report.tracked = true;
        }
        await viewer._onMessage({ type: 'trackMine', on: false });
        viewer._onMessage({ type: 'inkKey', key: 'Escape' });
        check(!viewer._ink, 'Escape puts the caret away');
        report.latencies = latencies.map(Math.round);
        report.key_to_caret_ms = { p50: quantile(latencies, 0.5), p90: quantile(latencies, 0.9), max: Math.max(...latencies), keys: latencies.length };
        // Maths opens the equation card: a click in a display equation places
        // no ink caret and opens the card on the equation instead.
        const opened = [];
        { const post = viewer._post.bind(viewer); viewer._post = msg => { if (msg?.type === 'editOpen') opened.push(msg); return post(msg); }; }
        const docLines = doc.getText().split('\n');
        const mathLine = docLines.findIndex(l => /^\s*\\begin\{(equation|align|gather)\*?\}/.test(l));
        if (mathLine > 0) {
            const inside = await until(() => st.map?.available && [1, 2].map(k => st.map.glyphsForLine(file, mathLine + 1 + k)).find(g => g.length)?.[0],
                'the equation in the map', 30000).then(() => [1, 2].map(k => st.map.glyphsForLine(file, mathLine + 1 + k)).find(g => g.length)?.[0], () => null);
            if (inside) {
                await viewer._jumpToSource({ generation: viewer._openedGeneration, page: inside.page,
                    xBp: inside.x + inside.w / 2, yTopBp: inside.y + inside.boxHeight / 2 });
                await until(() => opened.length, 'the equation card', 10000).catch(() => {});
                check(!viewer._ink, 'a click in display maths places no ink caret');
                check(opened.length && /\\begin\{(equation|align|gather)/.test(opened[0].text || ''), `a click in display maths opens the card on it (${opened[0]?.label || 'none'})`);
                report.maths_checked = true;
            }
        }
        // A table opens the card with its grid at the clicked cell; what the
        // grid sends (a cell edited, the booktabs style) reaches the source,
        // the package is loaded once, and the page is drawn again.
        const tableLine = (() => {
            const ls = doc.getText().split('\n');
            let inTab = false;
            for (let i = 0; i < ls.length; i++) {
                if (/\\begin\{tabular/.test(ls[i])) { inTab = true; continue; }
                if (/\\end\{tabular/.test(ls[i])) { inTab = false; continue; }
                if (inTab && ls[i].includes('&') && !/^\s*%/.test(ls[i]) && st.map?.available && st.map.glyphsForLine(file, i + 1).length) return i;
            }
            return -1;
        })();
        if (tableLine >= 0) {
            opened.length = 0;
            const cellGlyph = st.map.glyphsForLine(file, tableLine + 1)[0];
            await viewer._jumpToSource({ generation: viewer._openedGeneration, page: cellGlyph.page,
                xBp: cellGlyph.x + cellGlyph.w / 2, yTopBp: cellGlyph.y + cellGlyph.boxHeight / 2 });
            await until(() => opened.length, 'the table card', 10000).catch(() => {});
            const card = opened[0];
            check(card && /\\begin\{tabular/.test(card.text || ''), `a click in a table opens the card on it (${card?.label || 'none'})`);
            const texTable = await import(path.resolve(__dirname, '../../client/tex-table.js'));
            const t = card && texTable.parseTabular(card.text, card.clickOffset);
            const cell = t && Number.isFinite(card.clickOffset) && texTable.cellAt(t, card.clickOffset);
            check(!!cell, `the card knows the clicked cell (offset ${card?.clickOffset})`);
            if (t && cell) {
                const edited = texTable.setBorders(texTable.setCell(t, cell.row, cell.col, `${t.rows[cell.row].cells[cell.col]} Ink`), 'booktabs');
                const text = card.text.slice(0, t.start) + texTable.serializeTabular(edited) + card.text.slice(t.end);
                const pagesBefore = pagesPosted.length, t0 = performance.now();
                viewer._onMessage({ type: 'editChange', editId: card.editId, text, caret: { start: t.start, end: t.start, direction: 'forward' } });
                viewer._onMessage({ type: 'tablePackage', editId: card.editId, name: 'booktabs' });
                await until(() => doc.getText().includes('\\toprule') && /\\usepackage(\[[^\]]*\])?\{[^}]*booktabs/.test(doc.getText()), 'the table and its package in the source', 10000).catch(() => {});
                check(doc.getText().includes(`${t.rows[cell.row].cells[cell.col]} Ink`), 'the edited cell is in the source');
                check(/\\usepackage(\[[^\]]*\])?\{[^}]*booktabs/.test(doc.getText()), 'booktabs is loaded');
                check((doc.getText().match(/\\usepackage\{booktabs\}/g) || []).length <= 1, 'and only once');
                await until(() => pagesPosted.slice(pagesBefore).some(p => p === cellGlyph.page), `page ${cellGlyph.page} drawn again`, 30000).catch(() => {});
                check(pagesPosted.slice(pagesBefore).includes(cellGlyph.page), `the table's page is drawn again live (pages ${pagesPosted.slice(pagesBefore).join(',')})`);
                report.table_ms = Math.round(performance.now() - t0);
                report.table_checked = true;
            }
        }
        report.failures = failures;
        report.result = failures.length ? 'FAIL' : 'PASS';
    } catch (error) {
        report.result = 'FAIL';
        report.failures = failures;
        report.error = String(error?.stack || error);
    } finally {
        subscription?.dispose();
    }
    fs.writeFileSync(path.join(folder, '../vscode-ink.json'), JSON.stringify(report, null, 2));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
};
