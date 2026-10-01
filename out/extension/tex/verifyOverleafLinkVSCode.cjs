// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchOverleafLinkVSCodeCheck.cjs): the paper's folder linked to a
// model Overleaf project holding the same text; the reader types real
// keystrokes (the `type` command, at the caret) while a collaborator edits
// here and there, the paper's editor open. The editor and the project must
// end with the same text, and nothing the reader typed may be lost.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { OverleafLink, LINKS_KEY, cookieKey } = require('./overleafLink');
const { FakeOverleaf } = require('./overleafFakeService.cjs');
const memento = () => { const values = new Map(); return {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => { values.set(key, value); },
}; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { paper: main };
    let link = null;
    try {
        const file = path.join(folder, main);
        const text = fs.readFileSync(file, 'utf8');
        const server = new FakeOverleaf({ [main]: text });
        const secrets = new Map();
        const context = { globalState: memento(), secrets: { get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); } } };
        await context.globalState.update(LINKS_KEY, { [folder]: { url: 'https://www.overleaf.com/project/0123456789abcdef01234567', projectName: 'Fishnets', main, prefix: '' } });
        secrets.set(cookieKey('https://www.overleaf.com'), 'overleaf_session2=good');
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc);
        link = new OverleafLink({ vscode, context, deps: server.deps() });
        report.connected = await link.connect(folder);
        if (!report.connected) throw Error(`not connected: ${link.state.detail}`);
        // The caret in a prose line in the middle.
        const lines = text.split('\n');
        const at = lines.findIndex((l, i) => i > lines.length / 2 && /^[A-Z][a-z]+ [a-z]+ [a-z]+/.test(l));
        editor.selection = new vscode.Selection(at, 3, at, 3);
        let s = 7, typed = 0, theirs = 0;
        const rand = n => ((s = (s * 1103515245 + 12345) & 0x7fffffff) >> 16) % n;
        const t0 = Date.now();
        for (let k = 0; k < 120; k++) {
            if (rand(2)) { await vscode.commands.executeCommand('type', { text: 'k' }); typed++; }
            else {
                const t = server.text(main);
                // Near the caret half the time: the case that matters.
                const caret = doc.offsetAt(editor.selection.active);
                const p = rand(2) ? Math.max(0, Math.min(t.length, caret + rand(40) - 20)) : rand(t.length + 1);
                server.collaborator(main, [{ p, i: 'R' }]);
                theirs++;
            }
            if (rand(3) === 0) await sleep(rand(15));
        }
        for (let i = 0; i < 600 && ((link.unapplied.get(main) || []).length || !link.client.idle()); i++) await sleep(10);
        await sleep(100);
        report.ms = Date.now() - t0;
        report.typed = typed; report.theirs = theirs;
        const mine = doc.getText(), remote = server.text(main);
        report.same = mine === remote;
        report.kInEditor = (mine.match(/k/g) || []).length - (text.match(/k/g) || []).length;
        report.RInEditor = (mine.match(/R/g) || []).length - (text.match(/R/g) || []).length;
        report.state = link.state.status;
        // An agent rewrites a line on disk while the file is open (and saved):
        // VS Code reloads it, and that reaches Overleaf too.
        await sleep(2000);                       // the link has saved the file
        report.savedBeforeAgent = !doc.isDirty;
        const disk = fs.readFileSync(file, 'utf8').split('\n');
        disk[at + 3] = `AGENT ${disk[at + 3]}`;
        fs.writeFileSync(file, disk.join('\n'));
        const t1 = Date.now();
        while (!doc.getText().includes('AGENT ') && Date.now() - t1 < 10000) await sleep(50);
        report.editorReloaded = doc.getText().includes('AGENT ');
        for (let i = 0; i < 200 && !server.text(main).includes('AGENT '); i++) await sleep(20);
        report.agentEditOnOverleaf = server.text(main).includes('AGENT ') && server.text(main) === doc.getText();
        report.result = report.agentEditOnOverleaf && report.same && report.kInEditor === typed && report.RInEditor === theirs && report.state === 'connected' ? 'PASS' : 'FAIL';
    } catch (error) {
        report.result = 'FAIL';
        report.error = error.stack || error.message;
    } finally {
        try { link?.disconnect(); } catch (_) {}
        fs.writeFileSync(path.join(folder, '../vscode-overleaf-link.json'), JSON.stringify(report, null, 2));
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor').then(undefined, () => {});
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
};
