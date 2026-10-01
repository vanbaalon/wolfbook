// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchChangeEventsVSCodeCheck.cjs): what an editor change event says
// when one edit changes several places — a WorkspaceEdit with several
// replacements (the review's undo), and a file rewritten on disk in several
// places while it is open and saved (an agent's write, VS Code's reload) —
// and whether overleafLink's changeOp rebuilds the new text from it.
// Writes vscode-change-events.json.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { changeOp } = require('./overleafLink');
const { apply } = require('./overleafOt');
const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { cases: [] };
    try {
        const file = path.join(folder, main);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        let mirror = doc.getText();
        const seen = [];
        const sub = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document !== doc || !e.contentChanges.length) return;
            const text = e.document.getText();
            const op = changeOp(mirror, e.contentChanges);
            let rebuilt = null, err = null;
            try { rebuilt = apply(mirror, op); } catch (x) { err = x.message; }
            seen.push({ changes: e.contentChanges.map(c => ({ off: c.rangeOffset, len: c.rangeLength, text: c.text.length })), ok: rebuilt === text, err });
            mirror = text;
        });
        const lines = doc.getText().split('\n');
        // 1. One WorkspaceEdit, several replacements (as the review's undo).
        const we = new vscode.WorkspaceEdit();
        for (const n of [10, 40, 80, 120]) we.replace(doc.uri, new vscode.Range(n, 0, n, lines[n].length), `EDIT ${n} ${lines[n]}\nand a new line`);
        seen.length = 0;
        await vscode.workspace.applyEdit(we);
        await sleep(200);
        report.cases.push({ name: 'workspace edit, 4 replacements', events: seen.slice() });
        await doc.save();
        await sleep(300);
        // 2. The file rewritten on disk in several places (open, saved): VS Code reloads it.
        const disk = fs.readFileSync(file, 'utf8').split('\n');
        disk.splice(30, 3, 'AGENT rewrote three lines', 'into two');
        disk[70] = `AGENT ${disk[70]}`;
        disk.splice(100, 0, 'AGENT inserted', 'two lines');
        disk.splice(140, 5);
        seen.length = 0;
        fs.writeFileSync(file, disk.join('\n'));
        for (let i = 0; i < 100 && !doc.getText().includes('AGENT inserted'); i++) await sleep(50);
        await sleep(300);
        report.cases.push({ name: 'disk rewrite, 4 places, reloaded', reloaded: doc.getText().includes('AGENT inserted'), events: seen.slice() });
        // 3. Undo of case 1's edit in the editor (several places again).
        sub.dispose();
        report.result = report.cases.every(c => c.events.length && c.events.every(e => e.ok)) ? 'PASS' : 'FAIL';
    } catch (error) {
        report.result = 'FAIL';
        report.error = error.stack || error.message;
    } finally {
        fs.writeFileSync(path.join(folder, '../vscode-change-events.json'), JSON.stringify(report, null, 2));
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
};
