// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchArxivVSCodeCheck.cjs): "WPaper: Prepare for arXiv…" on the open
// paper, through the registered command with a target (no dialogs). The zip
// must hold only what the paper uses, the .bbl named after it and a
// 00README.json; the .tex must have no comments and no draft mode; and the
// package must build as arXiv builds it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { paper: main };
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        const ext = vscode.extensions.getExtension('wolfbook.wolfbook');
        await ext.activate();
        const doc = await vscode.workspace.openTextDocument(path.join(folder, main));
        await vscode.window.showTextDocument(doc);
        const target = path.join(folder, '..', 'arxiv.zip');
        const t0 = Date.now();
        const r = await vscode.commands.executeCommand('wolfbook.tex.prepareArxiv', { target });
        report.ms = Date.now() - t0;
        report.lines = r && r.lines;
        report.files = r && r.files;
        check(r && r.saved === target && fs.existsSync(target), 'the zip was saved');
        const job = main.replace(/\.tex$/, '');
        const listing = execFileSync('unzip', ['-Z1', target], { encoding: 'utf8' }).trim().split('\n').sort();
        report.listing = listing;
        check(listing.includes(`${job}.bbl`), 'the .bbl is in, named after the main file');
        check(listing.includes('00README.json'), '00README.json is in');
        check(!listing.some(f => /\.bib$/.test(f)), 'no .bib');
        check(listing.includes('figs/plot.png') && !listing.includes('figs/unused.png'), 'only the used figure');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-unzip-'));
        execFileSync('unzip', ['-q', target, '-d', dir]);
        const tex = fs.readFileSync(path.join(dir, main), 'utf8');
        report.tex = tex;
        check(!/(^|[^\\])%[^\n]/.test(tex.replace(/%\n/g, '\n')), 'no comment text left');
        check(!/draft/.test(tex.split('\n')[0] + tex.split('\n').find(l => l.startsWith('\\documentclass'))), 'no draft class option');
        check(!/showkeys|lineno|\\linenumbers/.test(tex), 'showkeys and lineno gone');
        check(/\\usepackage\[colorinlistoftodos,disable\]\{todonotes\}/.test(tex), 'todonotes disabled');
        check(!/begin\{comment\}|old paragraph|Leftover notes/.test(tex), 'comment block and leftovers gone');
        check(r.check && r.check.ok && r.check.pages >= 1, 'the package builds as arXiv builds it');
        const disk = fs.readFileSync(path.join(folder, main), 'utf8');
        check(/Draft notes/.test(disk), 'the paper on disk is untouched');
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
        failures.push(`error: ${error.stack || error.message}`);
    }
    report.failures = failures;
    report.result = failures.length ? 'FAIL' : 'PASS';
    fs.writeFileSync(path.join(folder, '..', 'vscode-arxiv.json'), JSON.stringify(report, null, 2));
};
