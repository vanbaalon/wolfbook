// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeStructureVSCodeCheck.cjs): figures and sections on a real
// paper, through the viewer's own handlers as the webview drives them.
//   1. a click on a picture (it prints no glyphs) opens its figure's card;
//   2. the width the figure bar writes reaches the source and the page is
//      drawn again live; ↑ moves the figure above the paragraph before it and
//      the card follows it;
//   3. after a settle, a section dragged in the outline moves before another;
//   4. an image dropped on the page is saved in the project and becomes a
//      figure at the drop;
//   5. the paper still settles (a full build) after all of it.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { RenderCoordinator } = require('./renderUi');
const { Projection } = require('./index');
const { TexViewer } = require('./texViewer');
const { figureAt } = require('./texStructure');
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
const DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { paper: main };
    const output = vscode.window.createOutputChannel('WPaper native structure');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    const posted = [];
    const post = viewer._post.bind(viewer);
    viewer._post = message => { posted.push({ at: performance.now(), message }); return post(message); };
    const since = (n, type) => posted.slice(n).filter(p => p.message?.type === type).map(p => p.message);
    let subscription;
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        const file = path.join(folder, main);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        await viewer.open(doc);
        await coord.build(doc);
        let st = coord.stateFor(doc);
        if (st.generation?.runner !== 'wlatex') throw Error(`not on the WLaTeX lane: ${st.lastError || st.nativeUnavailable || st.nativeOff}`);
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'the PDF open in the viewer');
        report.first = { hash: st.generation.pdfHash?.slice(0, 8), snapshot: st.generation.sourceSnapshotHash?.slice?.(0, 8) };
        subscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== doc) return;
            coord.noteChange(event);
            coord._schedulePreview(doc.uri.fsPath, st);
        });
        // As the extension wires it: a new build is shown in the viewer.
        const changes = coord.onDidChange(() => { viewer.refresh().catch(() => {}); });
        context.subscriptions.push(changes);
        await st.nativeLane.warmInteractive();
        const settle = async label => {
            await doc.save();
            const t0 = Date.now();
            await coord.build(doc, { authoritative: true, quiet: true });
            report.settles = [...(report.settles || []), { label, ms: Date.now() - t0, ok: st.generation?.ok, runner: st.generation?.runner,
                pages: st.generation?.pageCount }];
            const before = st.generation?.pdfHash;
            const same = coord.stateFor(doc) === st;
            await until(() => viewer._openedPdfHash === st.generation.pdfHash, `the settled PDF after ${label}`, 60000).catch(error => {
                throw Error(`${error.message}: built ${st.generation?.pdfHash?.slice(0, 8)} (was ${before?.slice(0, 8)}), open ${viewer._openedPdfHash?.slice(0, 8)}, now ${coord.stateFor(doc)?.generation?.pdfHash?.slice(0, 8)} same-state ${same}/${coord.stateFor(doc) === st}, runner ${st.generation?.runner}, error ${st.lastError}, dirty ${doc.isDirty}`);
            });
            // Maps are read on demand (a click asks for one).
            for (let i = 0; i < 20 && !st.map?.available; i++) await coord.ensureNativeMap(st, 3000).catch(() => {});
            check(st.map?.available, `the map after ${label}`);
            check(st.generation?.runner === 'wlatex' && !st.lastError, `settles after ${label}: ${st.lastError || ''}`);
        };

        // 1. A click on a picture opens its figure. The figure: the first with a
        // picture and a caption on a line of its own that the map shows.
        const lines = doc.getText().split('\n');
        // Only pictures above the caption: no maths, no drawing, no nested environment but center.
        const picturesOnly = body => /\\includegraphics/.test(body) && !/\$|\\begin\s*\{(?!center\}|figure)|tikz|\\put\b|\\input/.test(body.replace(/^\\begin\s*\{figure\*?\}/, ''));
        const capLine = lines.findIndex((l, i) => {
            if (!/^\s*\\caption\s*[{[]/.test(l)) return false;
            const at = doc.offsetAt(new vscode.Position(i, 0)), f = figureAt(doc.getText(), at);
            return f && picturesOnly(doc.getText().slice(f.start, at));
        });
        if (capLine < 0) throw Error('no figure with a picture above its caption');
        await until(() => st.map.glyphsForLine(file, capLine + 1).length, `the caption (line ${capLine + 1}) in the map`, 30000).catch(() => {});
        const cap = st.map.glyphsForLine(file, capLine + 1).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)[0];
        if (!cap) throw Error(`the caption at line ${capLine + 1} is not in the map`);
        report.caption_line = capLine + 1;
        // Inside the picture: 60 bp above the caption's first letter, off any text.
        let n = posted.length;
        const pointOnPicture = { page: cap.page, xBp: cap.x + 40, yTopBp: cap.y - 60 };
        const under = st.map.renderToSource(cap.page, pointOnPicture.xBp, pointOnPicture.yTopBp);
        report.picture_point = { ...pointOnPicture, flag: under?.flag, file: under?.file ? path.basename(under.file) : null };
        await viewer._jumpToSource({ generation: viewer._openedGeneration, ...pointOnPicture });
        await until(() => since(n, 'editOpen').length, 'the figure card', 10000).catch(() => {});
        const card = since(n, 'editOpen')[0];
        check(card && /\\begin\{figure/.test(card.text || '') && /\\includegraphics/.test(card.text || ''), `a click on the picture opens its figure (${card?.label || 'none'})`);
        if (!card) throw Error('no figure card');

        // 2. The width, from the card as the figure bar writes it.
        const F = await import(path.resolve(__dirname, '../../client/tex-figure.js'));
        const sized = (() => {
            const m = /\\begin\s*\{(figure\*?)\}/.exec(card.text);
            const end = card.text.indexOf(`\\end{${m[1]}}`) + `\\end{${m[1]}}`.length;
            return card.text.slice(0, m.index) + F.setFigureWidth(card.text.slice(m.index, end), 0.5) + card.text.slice(end);
        })();
        n = posted.length;
        let t0 = performance.now();
        viewer._onMessage({ type: 'editChange', editId: card.editId, text: sized });
        await until(() => /width=0\.5\\(linewidth|textwidth|columnwidth|hsize)/.test(doc.getText()), 'the width in the source', 10000).catch(() => {});
        check(/width=0\.5\\(linewidth|textwidth|columnwidth|hsize)/.test(doc.getText()), 'the width reaches the source');
        await until(() => since(n, 'txdlPage').some(p => p.page === cap.page), `page ${cap.page} drawn again`, 30000).catch(() => {});
        check(since(n, 'txdlPage').some(p => p.page === cap.page), `the figure's page is drawn again live (pages ${since(n, 'txdlPage').map(p => p.page).join(',')})`);
        report.width_to_page_ms = Math.round((posted.slice(n).find(p => p.message?.type === 'txdlPage' && p.message.page === cap.page)?.at ?? NaN) - t0);

        // ↑: above the paragraph before it; the card follows.
        const s = viewer._edit;
        const figBefore = doc.getText().slice(s.startOffset, s.endOffset);
        const startBefore = s.startOffset;
        const tryMove = async dir => {
            n = posted.length;
            viewer._onMessage({ type: 'figureMove', editId: card.editId, dir });
            await until(() => since(n, 'status').some(m => /figure moved|nothing to move/.test(m.text)), 'the move', 10000).catch(() => {});
            return since(n, 'status').find(m => /figure moved|nothing to move/.test(m.text));
        };
        // ↑, or ↓ when a heading is right above it (a wall).
        let moved = await tryMove(-1), dir = -1;
        if (moved && /nothing to move it above/.test(moved.text)) { moved = await tryMove(1); dir = 1; }
        check(moved && /figure moved (up|down)/.test(moved.text), `the figure moves (${moved?.text})`);
        if (moved && /figure moved (up|down)/.test(moved.text)) {
            report.figure_move = dir < 0 ? 'up' : 'down';
            check(viewer._edit === s && (dir < 0 ? s.startOffset < startBefore : s.startOffset > startBefore), 'the card stays open on it');
            check(doc.getText().slice(s.startOffset, s.endOffset) === figBefore, 'the card holds the moved figure, unchanged');
            check(since(n, 'editUpdate').some(m => m.editId === card.editId), 'and says where it is now');
            check(!since(n, 'editConflict').length, 'without a conflict');
            report.figure_moved = true;
        }
        viewer._edit = null;
        await settle('the figure edits');

        // 3. A section dragged in the outline: the last before the second.
        const all = viewer._sectionControls(st).filter(i => i.kind === 'section' && path.basename(i.file) === path.basename(file));
        const top = Math.min(...all.map(i => i.level));
        const sections = all.filter(i => i.level === top);
        report.outline = { sections: all.length, top_level: sections.length };
        if (sections.length >= 3) {
            const mover = sections.at(-1), target = sections[1];
            const now = doc.getText().split('\n');
            const headOf = i => now[i.headStart - 1];
            n = posted.length;
            viewer._onMessage({ type: 'sectionMove', key: mover.key, beforeKey: target.key });
            await until(() => since(n, 'status').some(m => /moved "|already there|no longer/.test(m.text)), 'the section move', 10000).catch(() => {});
            const text = doc.getText();
            const at = i => text.indexOf(headOf(i));
            check(at(mover) >= 0 && at(mover) < at(target),
                `"${mover.title}" now comes before "${target.title}" (${since(n, 'status').map(m => m.text).join(' | ')})`);
            report.section_moved = `${mover.title} → before ${target.title}`;
            await settle('the section move');
        } else check(false, `fewer than three sections (${sections.length})`);

        // 4. An image dropped on a paragraph.
        const prose = lines.findIndex((l, i) => i > lines.findIndex(x => x.includes('\\begin{document}')) + 20 && l.length > 60 && !/[\\$%{}]/.test(l) && st.map.glyphsForLine(file, i + 1).length);
        const g = prose >= 0 && st.map.glyphsForLine(file, prose + 1)[0];
        if (g) {
            n = posted.length;
            viewer._onMessage({ type: 'imageDrop', generation: viewer._openedGeneration, page: g.page, xBp: g.x + 5, yTopBp: g.y + g.boxHeight / 2,
                name: 'dot.png', mime: 'image/png', data: DOT });
            await until(() => since(n, 'status').some(m => /figure added|could not|drop the image/.test(m.text)), 'the drop', 10000).catch(() => {});
            const added = /\\includegraphics\[width=0\.8\\linewidth\]\{(img\/[^}]*paste_[0-9a-f]+\.png)\}/.exec(doc.getText());
            check(!!added, `the dropped image is a figure in the source (${since(n, 'status').map(m => m.text).join(' | ')})`);
            check(added && fs.existsSync(path.join(folder, added[1])), 'and the image is saved in the project');
            if (added) {
                const { environmentAt } = require('./inkEdit');
                const envs = environmentAt(doc.getText(), added.index);
                check(envs.length === 2 && envs[0] === 'document' && /^figure/.test(envs[1]), `the dropped figure is not inside another block (${envs.join(' > ')})`);
            }
            report.image_dropped = added?.[1] || null;
            await settle('the image drop');
        } else check(false, 'no prose line to drop on');
        report.failures = failures;
        report.result = failures.length ? 'FAIL' : 'PASS';
    } catch (error) {
        report.result = 'FAIL';
        report.failures = failures;
        report.error = String(error?.stack || error);
    } finally {
        subscription?.dispose();
    }
    fs.writeFileSync(path.join(folder, '../vscode-structure.json'), JSON.stringify(report, null, 2));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
};
