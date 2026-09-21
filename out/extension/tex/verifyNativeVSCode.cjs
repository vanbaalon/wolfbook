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
        assert.equal(st.generation.runner, 'wlatex', st.lastError || st.nativeUnavailable);
        assert.equal(st.map.native, true);
        await viewer.open(doc);
        await viewer.refresh({ force:true });
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'PDF.js opened acknowledgement');
        assert.equal(viewer._openedGeneration, st.generation.generation);
        subscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === doc) coord.noteChange(event);
        });
        await editor.edit(builder => builder.insert(new vscode.Position(0,0), '% unsaved UI acceptance\n'));
        await until(() => st.map.available, 'translated native map');
        assert.equal(doc.isDirty, true);
        assert.equal(st.sourceAhead, true);
        const rects = await st.map.forwardAt(doc.uri.fsPath, 4, 0);
        assert.ok(rects?.length);
        await viewer._jumpToSource({ generation:viewer._openedGeneration,
            page:rects[0].page, xBp:rects[0].x+rects[0].w/2, yTopBp:rects[0].y+rects[0].h/2 });
        assert.equal(editor.selection.start.line, 3);
        await fs.writeFile(path.join(folder, '../vscode-acceptance.json'), JSON.stringify({
            result:'PASS', vscode:vscode.version, node:process.version,
            platform:process.platform, arch:process.arch, native_preview:true,
            real_pdfjs_opened:true, unsaved_source_edit:true, translated_inverse_navigation:true,
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
