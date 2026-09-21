// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE.
// Use an isolated --user-data-dir and a workspace containing only paper.tex.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
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
    const { mode = 'native' } = JSON.parse(await fs.readFile(path.join(folder, '../acceptance-mode.json'),'utf8'));
    const output = vscode.window.createOutputChannel('WPaper native acceptance');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri:vscode.Uri.file(path.resolve(__dirname, '../../..')),
        workspaceState:memento(), globalState:memento(), subscriptions:[] };
    const viewer = new TexViewer(context, coord, projection);
    let subscription;
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
        await viewer.open(doc);
        await viewer.refresh({ force:true });
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'PDF.js opened acknowledgement');
        assert.equal(viewer._openedGeneration, st.generation.generation);
        subscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === doc) coord.noteChange(event);
        });
        await editor.edit(builder => builder.insert(new vscode.Position(0,0), '% unsaved UI acceptance\n'));
        assert.equal(doc.isDirty, true);
        assert.equal(st.sourceAhead, true);
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
        await fs.writeFile(path.join(folder, '../vscode-acceptance.json'), JSON.stringify({
            result:'PASS', vscode:vscode.version, node:process.version,
            platform:process.platform, arch:process.arch, mode, native_preview:mode === 'native', mini_editor_precise_edit:mode === 'native',
            default_without_wlatex:mode === 'default', unavailable_wlatex_fallback:mode === 'missing',
            conventional_unsaved_rebuild:mode !== 'native',
            real_pdfjs_opened:true, unsaved_source_edit:true, translated_inverse_navigation:mode === 'native',
            pointer_gestures_verified:false, visual_acceptance_verified:false,
        }, null, 2));
    } catch (error) {
        await fs.writeFile(path.join(folder, '../vscode-acceptance.json'), JSON.stringify({
            result:'FAIL', error:error.stack || String(error), vscode:vscode.version, node:process.version,
        }, null, 2));
        throw error;
    } finally {
        subscription?.dispose(); viewer.panel?.dispose(); coord.dispose(); projection.dispose(); output.dispose();
    }
};
