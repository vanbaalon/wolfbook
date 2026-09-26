// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE.
// Use an isolated --user-data-dir and a workspace containing only paper.tex.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { RenderCoordinator } = require('./renderUi');
const { Projection } = require('./index');
const { TexViewer } = require('./texViewer');
const memento = () => { const values = new Map(); return {
    get:(key, fallback) => values.has(key) ? values.get(key) : fallback,
    update:async (key, value) => { values.set(key,value); },
}; };
async function until(predicate, label) {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}
exports.run = async function() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-'))
        throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { mode = 'native', eol = 'lf' } = JSON.parse(await fs.readFile(path.join(folder, '../acceptance-mode.json'),'utf8'));
    const output = vscode.window.createOutputChannel('WPaper native acceptance');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri:vscode.Uri.file(path.resolve(__dirname, '../../..')),
        workspaceState:memento(), globalState:memento(), subscriptions:[] };
    const viewer = new TexViewer(context, coord, projection);
    let subscription, messagesSubscription;
    let workerCrashRecovered = false;
    let liveClickVerified = false;
    let tikzEditVerified = false;
    const keystrokeToPreviewMs = [];
    const messages = [];
    try {
        const doc = await vscode.workspace.openTextDocument(path.join(folder,'paper.tex'));
        const editor = await vscode.window.showTextDocument(doc);
        await coord.build(doc, { quiet:true });
        const st = coord.stateFor(doc);
        assert.equal(st.generation.ok, true, st.lastError || st.nativeUnavailable);
        if (mode === 'native') {
            assert.equal(st.generation.runner, 'wlatex', st.lastError || st.nativeUnavailable);
            assert.equal(st.map.native, true);
        } else {
            assert.notEqual(st.generation.runner, 'wlatex');
            assert.ok(!st.nativeLane);
            assert.ok(!st.map.native && st.map.available);
            if (mode === 'missing') assert.match(st.nativeUnavailable, /not installed or configured/);
            else assert.ok(!st.nativeUnavailable);
        }
        // Record every webview message from the panel's creation: the first
        // paint's timing is sent once, and a fast native build can deliver it
        // before open() returns.
        const onMessage = viewer._onMessage.bind(viewer);
        viewer._onMessage = message => { messages.push(message); return onMessage(message); };
        await viewer.open(doc);
        await viewer.refresh({ force:true });
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'PDF.js opened acknowledgement');
        assert.equal(viewer._openedGeneration, st.generation.generation);
        if (mode === 'native') {
            await until(() => messages.some(message => message.type === 'timing' && message.worker), 'initial page paint');
            assert.equal(messages.find(m => m.type === 'timing' && m.kind === 'open').transport, 'range');
            await until(() => messages.some(m => m.type === 'textLayerDone' && m.generation === st.generation.generation), 'initial PDF text sweep');
            assert.equal(st.generation.pageCount, 2);
            const firstPageHash = st.generation.nativeReport.build.pages[0].pdf_page_hash;
            await editor.edit(builder => builder.replace(doc.lineAt(4).range, 'Second page. Second page.'));
            await coord.build(doc, { quiet:true, live:true });
            assert.equal(st.generation.nativeReport.build.pages[0].pdf_page_hash, firstPageHash);
            await viewer.refresh();
            await until(() => messages.some(message => message.type === 'timing' && message.kind === 'open' &&
                message.generation === st.generation.generation), 'page reuse report');
            const opened = messages.find(message => message.type === 'timing' && message.kind === 'open' &&
                message.generation === st.generation.generation);
            assert.ok(opened.reusedPages.includes(1), 'unchanged first-page canvas should be retained');
            assert.ok(!opened.reusedPages.includes(2), 'changed second page must be redrawn');
            await until(() => messages.some(m => m.type === 'textLayerDone' && m.generation === st.generation.generation), 'updated PDF text sweep');
            const sweep=messages.find(m => m.type === 'textLayerDone' && m.generation === st.generation.generation);
            assert.deepEqual(sweep.reusedPages,[1],'only unchanged first-page text should be reused');
            await until(() => viewer._openedGeneration === st.generation.generation, 'changed PDF acknowledgement');
        }
        subscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === doc) coord.noteChange(event);
        });
        await editor.edit(builder => builder.insert(new vscode.Position(0,0), '% unsaved UI acceptance\n'));
        assert.equal(doc.isDirty, true);
        assert.equal(st.sourceAhead, true);
        if (mode === 'native') {
            // A LIVE PAGE ANSWERS FROM ITS OWN MAP. The interactive preview
            // runs through the real coordinator and viewer; the click carries
            // the overlay identity the webview would send, and must land on
            // the line typed live, not where the PDF under the overlay has it.
            const lane = st.nativeLane;
            assert.equal(await lane.warmInteractive(), true, lane.interactiveUnavailable);
            const liveLine = [...Array(doc.lineCount).keys()].find(n => doc.lineAt(n).text.startsWith('Second page.'));
            assert.ok(liveLine !== undefined, 'the second-page line is present');
            await editor.edit(builder => builder.replace(doc.lineAt(liveLine).range, 'Second page, typed live.'));
            await coord._runInteractive(st, lane, doc.uri.fsPath, { sourceFiles:[doc.uri.fsPath],
                overlay:new Map([[doc.uri.fsPath, doc.getText()]]), wait:true });
            // The first preview of a lane delivers every page as changed; the
            // typed line's glyphs say which live page holds it.
            const liveGlyph = () => viewer._liveMap?.available
                ? viewer._liveMap.glyphsForLine(doc.uri.fsPath, liveLine + 1).find(e => viewer._liveOverlays?.has(e.page)) : null;
            await until(() => liveGlyph(), 'live page map holding the typed line');
            const glyph = liveGlyph(), page = glyph.page;
            editor.selection = new vscode.Selection(0, 0, 0, 0);
            await viewer._jumpToSource({ generation:viewer._openedGeneration, page,
                xBp:glyph.x + glyph.w / 2, yTopBp:glyph.y + glyph.boxHeight / 2, overlay:viewer._liveOverlays.get(page) });
            assert.equal(editor.selection.start.line, liveLine, 'a click on the live page lands on the typed line');
            liveClickVerified = true;
            // KEYSTROKE → PREVIEW, through the preview scheduler scheduleLive
            // uses (live rendering is off in this harness so that it drives
            // the cold builds itself): the time until the host posts the
            // recomputed page to the webview.
            for (let n = 0; n < 5; n++) {
                const before = new Map(viewer._previewPages || []);
                const t0 = Date.now();
                await editor.edit(builder => builder.insert(doc.lineAt(liveLine).range.end, ' More.'));
                coord._schedulePreview(doc.uri.fsPath, st);
                await until(() => [...(viewer._previewPages || new Map())].some(([p, m]) => before.get(p) !== m),
                    'preview after a keystroke');
                keystrokeToPreviewMs.push(Date.now() - t0);
            }
            const median = [...keystrokeToPreviewMs].sort((a, b) => a - b)[2];
            assert.ok(median < 500, `keystroke to preview ${keystrokeToPreviewMs.join(', ')} ms`);
        }
        if (mode === 'native') {
            await until(() => st.map.available, 'translated native map');
            const rects = await st.map.forwardAt(doc.uri.fsPath, 4, 0);
            assert.ok(rects?.length);
            await viewer._jumpToSource({ generation:viewer._openedGeneration,
                page:rects[0].page, xBp:rects[0].x+rects[0].w/2, yTopBp:rects[0].y+rects[0].h/2 });
            assert.equal(editor.selection.start.line, 3);
            const point = { generation:viewer._openedGeneration, page:rects[0].page,
                xBp:rects[0].x+rects[0].w/2, yTopBp:rects[0].y+rects[0].h/2 };
            const card = await viewer._openEditSession(point);
            assert.ok(card?.native);
            const before = card.lastText;
            assert.ok(before.startsWith('Alpha'));
            const text = before.slice(0,1) + 'NEW' + before.slice(1);
            assert.equal(await viewer._applyEditChange({ editId:card.id, text,
                operation:{ before, start:1, end:1, text:'NEW' } }), true);
            await until(() => st.map.available, 'map after precise mini-editor edit');
            assert.ok(doc.lineAt(3).text.startsWith('ANEWlpha'));
            assert.ok((await st.map.forwardAt(doc.uri.fsPath, 4, 4))?.length,
                'unchanged letter must retain its native provenance');
            assert.deepEqual(await st.map.forwardAt(doc.uri.fsPath, 4, 2), [],
                'inserted text must not inherit old glyphs');
            await viewer._onEditCaret({ editId:card.id, start:4, end:5 });
            assert.equal(editor.selection.start.character, 4);
            assert.equal(editor.selection.end.character, 5);
            // Simulate textarea LF messages against the actual VS Code CRLF document.
            const wireBefore = card.lastText.replace(/\r\n?/g, '\n');
            const multilineText = wireBefore.slice(0,5) + '\nNext ' + wireBefore.slice(5);
            assert.equal(await viewer._applyEditChange({ editId:card.id, text:multilineText,
                beforeText:wireBefore, operation:{ before:wireBefore,start:5,end:5,text:'\nNext ' } }),true);
            assert.equal(doc.eol, eol === 'crlf' ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF);
            assert.ok(card.lastText.includes(eol === 'crlf' ? '\r\nNext ' : '\nNext '));
            await viewer._onEditCaret({ editId:card.id,start:6,end:10 });
            assert.equal(editor.selection.start.line,4);
            assert.equal(editor.selection.start.character,0);
            assert.equal(editor.selection.end.character,4);
            const rawBefore = card.lastText;
            const nextWire = rawBefore.replace(/\r\n?/g, '\n');
            assert.equal(await viewer._applyEditChange({ editId:card.id,text:nextWire.slice(0,10)+'!'+nextWire.slice(10),
                beforeText:nextWire,operation:{ before:nextWire,start:10,end:10,text:'!' } }),true);
            assert.ok(doc.lineAt(4).text.startsWith('Next! '));
            const oldCardText = card.lastText;
            await editor.edit(builder => builder.insert(doc.positionAt(card.startOffset + 1), 'EXTERNAL'));
            await until(() => card.lastText !== oldCardText, 'external source update in card');
            const externalText = doc.getText();
            assert.equal(await viewer._applyEditChange({ editId:card.id, text:oldCardText + 'stale',
                operation:{ before:oldCardText, start:oldCardText.length, end:oldCardText.length, text:'stale' } }), false);
            assert.equal(card.conflict, true);
            assert.equal(doc.getText(), externalText);
            assert.equal(await viewer._applyEditChange({ editId:card.id, text:oldCardText + 'stale' }), false);
            assert.equal(doc.getText(), externalText);
            const nativeGeneration = st.generation.generation;
            // A settled native build stays native on save; an explicit
            // Compile (`force`) is what still hands over to the configured
            // compiler.
            await coord.build(doc, { force:true, quiet:true });
            assert.equal(st.generation.ok, true, st.lastError);
            assert.notEqual(st.generation.runner, 'wlatex');
            assert.equal(st.generation.engine, 'pdflatex');
            assert.ok(!st.map.native);
            assert.equal(st.sourceAhead, false);
            assert.ok(st.generation.generation > nativeGeneration);
            await viewer.refresh({ force:true });
            await until(() => viewer._openedGeneration === st.generation.generation &&
                viewer._openedPdfHash === st.generation.pdfHash, 'authoritative handoff');
            await until(() => viewer._pdfRanges.files.size === 0, 'native PDF handles released on conventional handoff');
            const authoritativeGeneration = st.generation.generation;
            await coord.build(doc, { quiet:true });
            assert.equal(st.generation.runner, 'wlatex', st.lastError || st.nativeUnavailable);
            assert.equal(st.map.native, true);
            assert.ok(st.generation.generation > authoritativeGeneration);
            assert.equal(doc.getText(), externalText);
            assert.equal(doc.isDirty, true, 'handoff must not save the source buffer');
            await viewer.refresh();
            await until(() => viewer._openedGeneration === st.generation.generation &&
                viewer._openedPdfHash === st.generation.pdfHash, 'return to native preview');
            const returned = messages.find(message => message.type === 'timing' && message.kind === 'open' &&
                message.generation === st.generation.generation);
            assert.deepEqual(returned.reusedPages, [], 'conventional canvases have no native page identity');
            if (process.platform !== 'win32') {
                // Identify only this isolated host's direct child by its exact
                // executable/command, without reaching into SDK worker internals.
                const lane = st.nativeLane, oldMap = st.map, oldGeneration = st.generation;
                const oldPdf = await fs.readFile(oldGeneration.pdfPath);
                const diskText = await fs.readFile(doc.uri.fsPath, 'utf8');
                const { stdout } = await execFile('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
                const workers = stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
                    .filter(m => m && Number(m[2]) === process.pid && m[3] === `${lane.runtime.labBinary} serve`);
                assert.equal(workers.length, 1, 'identify exactly one source worker owned by this test host');
                process.kill(Number(workers[0][1]), 'SIGKILL');
                await assert.rejects(oldMap.forwardAt(doc.uri.fsPath, 4, 0));
                assert.equal(oldMap.available, false, 'failed query must disable cached source actions');
                await editor.edit(builder => builder.insert(new vscode.Position(0,0), '% recovery edit\n'));
                await until(() => st.nativeLane === null, 'failed source lane retirement');
                assert.equal(oldMap.available, false);
                assert.equal(st.generation, oldGeneration, 'keep the last PDF while rebuilding the worker');
                assert.deepEqual(await fs.readFile(oldGeneration.pdfPath), oldPdf);
                const recoveryText = doc.getText();
                await coord.build(doc, { quiet:true });
                assert.equal(st.generation.runner, 'wlatex', st.lastError || st.nativeUnavailable);
                assert.notEqual(st.nativeLane, lane);
                assert.notEqual(st.generation.nativeSource, oldGeneration.nativeSource);
                assert.equal(st.generation.nativeSource.files.get('paper.tex').text, recoveryText);
                assert.ok(st.generation.generation > oldGeneration.generation);
                assert.equal(st.map.available, true);
                assert.ok((await st.map.forwardAt(doc.uri.fsPath, 5, 0))?.length);
                await viewer.refresh({ force:true });
                await until(() => viewer._openedGeneration === st.generation.generation &&
                    viewer._openedPdfHash === st.generation.pdfHash, 'recovered native PDF acknowledgement');
                assert.equal(doc.isDirty, true);
                assert.equal(doc.getText(), recoveryText);
                assert.equal(await fs.readFile(doc.uri.fsPath, 'utf8'), diskText);
                assert.deepEqual(await fs.readFile(oldGeneration.pdfPath), oldPdf);
                workerCrashRecovered = true;
            }

        } else {
            await coord.build(doc, { quiet:true, authoritative:true });
            assert.equal(st.generation.ok, true, st.lastError);
            assert.equal(st.sourceAhead, false);
            assert.notEqual(st.generation.runner, 'wlatex');
            assert.ok(!st.nativeLane);
            await viewer.refresh({ force:true });
            await until(() => viewer._openedPdfHash === st.generation.pdfHash &&
                viewer._openedGeneration === st.generation.generation, 'rebuilt conventional PDF');
            await assert.rejects(fs.access(path.join(folder,'.wlatex')), { code:'ENOENT' });
        }
        if (mode === 'native') {
            // THE TIKZ TOOLBAR, as the webview drives it (tikzResolve,
            // tikzEdit): a live picture's path resolves through the live page
            // map to the \draw in the open document, a move edits that command,
            // and the next live page draws it moved.
            const nl = eol === 'crlf' ? '\r\n' : '\n';
            const tikzFile = path.join(folder, 'tikz.tex');
            await fs.writeFile(tikzFile, ['\\documentclass{article}', '\\usepackage{tikz}', '\\begin{document}',
                '\\begin{tikzpicture}', '  \\draw[red] (0,0) -- (2,1);', '\\end{tikzpicture}', '\\end{document}', ''].join(nl));
            const tdoc = await vscode.workspace.openTextDocument(tikzFile);
            await vscode.window.showTextDocument(tdoc);
            await coord.build(tdoc, { quiet:true });
            const tst = coord.stateFor(tdoc);
            assert.equal(tst.generation.runner, 'wlatex', tst.lastError || tst.nativeUnavailable);
            const tlane = tst.nativeLane;
            assert.equal(await tlane.warmInteractive(), true, tlane.interactiveUnavailable);
            const tpages = [];
            const pagesSub = coord.onDidInteractive(e => { if (e.kind === 'page' && e.root === tikzFile && e.txdl) tpages.push(e); });
            const changesSub = vscode.workspace.onDidChangeTextDocument(e => { if (e.document === tdoc) coord.noteChange(e); });
            const preview = () => coord._runInteractive(tst, tlane, tikzFile, { sourceFiles:[tikzFile],
                overlay:new Map([[tikzFile, tdoc.getText()]]), wait:true });
            try {
                await preview();
                const cm = 72 / 2.54;
                const posts = [];
                const host = Object.assign(Object.create(TexViewer.prototype), { root:tikzFile, coord, panel:{}, _post:m => posts.push(m) });
                const lastPage = () => tpages.at(-1).txdl.ops.filter(op => op.op === 'path');
                const resolve = async () => {
                    const paths = lastPage();
                    await host._tikzResolve({ key:'k', page:1, specials:paths.map(p => p.special), pictures:[...new Set(paths.map(p => p.picture.special))] });
                    const r = posts.pop();
                    assert.equal(r.error, null);
                    const [pic] = Object.values(r.pictures);
                    return { r, pic, paths, picture:{ file:pic.file, begin:pic.begin } };
                };
                const edit = async op => {
                    await host._tikzEdit({ key:Math.random(), ...op });
                    const done = posts.filter(m => m.type === 'tikzEdited').pop();
                    assert.equal(done.ok, true, done.error);
                    // The latest display list stays: a page the engine finds unchanged is not delivered again.
                    await preview();
                };
                const ref = s => ({ start:s.start, text:s.text });
                let { r, pic, picture } = await resolve();
                const draw = pic.statements[0];
                assert.equal(draw.text, '\\draw[red] (0,0) -- (2,1);');
                assert.deepEqual(Object.values(r.paths).map(p => p.stmt), [draw.start], 'the path belongs to the \\draw');
                // A move of the \draw: a leading shift.
                await edit({ op:'move', picture, refs:[ref(draw)], dx:cm, dy:0, snap:false });
                assert.ok(tdoc.getText().includes('\\draw[shift={(1,0)}, red] (0,0) -- (2,1);'), tdoc.getText());
                // Two circle nodes and an arrow edge between them.
                await edit({ op:'add', item:'circle-node', picture, points:[[0, 2 * cm]] });
                await edit({ op:'add', item:'circle-node', picture, points:[[3 * cm, 2.5 * cm]] });
                ({ pic, picture } = await resolve());
                const [n1, n2] = pic.statements.filter(s => s.kind === 'node');
                assert.deepEqual([n1.name, n1.at, n2.name, n2.at], ['n1', { x:0, y:2 }, 'n2', { x:3, y:2.5 }]);
                await edit({ op:'edge', item:'edge-arrow', picture, refs:[ref(n1), ref(n2)] });
                assert.ok(tdoc.getText().includes('\\draw[->] (n1) -- (n2);'));
                // Moving a node moves its coordinates, and the live page's edge follows it.
                // The edge's line (its arrow tip is drawn in a frame of its own), found through the resolver.
                const edgeEnd = async () => {
                    const { r: res, pic: p, paths } = await resolve();
                    const edgeStmt = p.statements.find(st => st.text === '\\draw[->] (n1) -- (n2);');
                    const line = paths.find(op => res.paths[op.special]?.stmt === edgeStmt.start && op.segments.some(sg => sg[0] === 'l'));
                    return (line.x - line.picture.x) / 65781.76 + line.segments.filter(sg => sg[0] === 'l').at(-1)[1];
                };
                const before = await edgeEnd();
                ({ pic, picture } = await resolve());
                await edit({ op:'move', picture, refs:[ref(pic.statements.find(s => s.name === 'n2'))], dx:cm, dy:0, snap:false });
                assert.ok(tdoc.getText().includes('(n2) at (4,2.5)'));
                const after = await edgeEnd();
                assert.ok(Math.abs(after - before - cm) < 0.5, `the edge's end moved ${after - before} bp`);
                // Align: the second node to the first node's vertical centre.
                ({ pic, picture } = await resolve());
                const m2 = pic.statements.find(s => s.name === 'n2');
                await edit({ op:'move', picture, refs:[ref(m2)], deltas:[[0, -0.5 * cm]], snap:false });
                assert.ok(tdoc.getText().includes('(n2) at (4,2)'));
                // The editor's undo restores the source, gesture by gesture.
                await edit({ op:'undo' });
                assert.ok(tdoc.getText().includes('(n2) at (4,2.5)'));
                // Copy two nodes and their edge; paste renames them and keeps the edge between the copies.
                ({ pic, picture } = await resolve());
                const trio = ['n1', 'n2'].map(n => pic.statements.find(st => st.name === n)).concat(pic.statements.filter(st => st.text === '\\draw[->] (n1) -- (n2);'));
                await host._tikzEdit({ key:'c', op:'copy', picture, refs:trio.map(ref) });
                assert.equal(posts.filter(m => m.type === 'tikzEdited').pop().ok, true);
                assert.ok((await vscode.env.clipboard.readText()).includes('(n1) -- (n2)'));
                await edit({ op:'paste', picture, dx:0, dy:-cm });
                assert.ok(tdoc.getText().includes('\\draw[->] (n3) -- (n4);'), tdoc.getText());
                tikzEditVerified = true;
            } finally { pagesSub.dispose(); changesSub.dispose(); }
            await until(() => viewer._pdfRanges.files.size === 1, 'only the displayed PDF handle remains');
            const store=viewer._pdfRanges;
            viewer.panel.dispose();
            await until(() => store.files.size === 0, 'PDF handles released on panel disposal');
        }
        await fs.writeFile(path.join(folder, '../vscode-acceptance.json'), JSON.stringify({
            result:'PASS', vscode:vscode.version, node:process.version,
            platform:process.platform, arch:process.arch, mode, eol, multiline_card_verified:mode === 'native', native_preview:mode === 'native', mini_editor_precise_edit:mode === 'native', mini_editor_conflict_rejected:mode === 'native', unchanged_canvas_reused:mode === 'native',
            default_without_wlatex:mode === 'default', unavailable_wlatex_fallback:mode === 'missing',
            conventional_unsaved_rebuild:mode !== 'native', authoritative_native_handoff:mode === 'native',
            real_pdfjs_opened:true, unsaved_source_edit:true, translated_inverse_navigation:mode === 'native',
            actual_source_worker_crash_recovered:workerCrashRecovered, live_page_click_verified:liveClickVerified, keystroke_to_preview_ms:keystrokeToPreviewMs, tikz_toolbar_edit_verified:tikzEditVerified, native_pdf_range_transport:mode === 'native', native_pdf_handles_released:mode === 'native', unchanged_page_text_reused:mode === 'native',
            pointer_gestures_verified:false, visual_acceptance_verified:false,
        }, null, 2));
    } catch (error) {
        await fs.writeFile(path.join(folder, '../vscode-acceptance.json'), JSON.stringify({
            result:'FAIL', error:error.stack || String(error), vscode:vscode.version, node:process.version,
            messages:messages.map(m => m.type === 'timing' ? `timing:${m.kind || 'marks'}:${m.worker || ''}` : m.type),
        }, null, 2));
        throw error;
    } finally {
        subscription?.dispose(); messagesSubscription?.dispose(); viewer.panel?.dispose(); coord.dispose(); projection.dispose(); output.dispose();
    }
};
