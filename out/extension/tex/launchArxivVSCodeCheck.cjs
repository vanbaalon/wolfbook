// Prepare for arXiv on a real paper, in real VS Code (WPaper's own compiler).
//
//   node launchArxivVSCodeCheck.cjs CODE_CLI PAPER_DIR MAIN
//
// Copies the paper into an isolated wpaper-ui-* run, opens it with an isolated
// profile, and runs verifyArxivVSCode.cjs in the extension host. Prints and
// writes vscode-arxiv.json.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
async function main() {
    const [code, paper, entry] = process.argv.slice(2);
    if (!code || !paper || !entry || ![code, paper].every(p => path.isAbsolute(p)))
        throw Error('usage: launchArxivVSCodeCheck.cjs CODE_CLI PAPER_DIR MAIN (absolute paths)');
    const run = await fs.mkdtemp(path.join(os.tmpdir(), 'wpaper-ui-'));
    const folder = path.join(run, 'paper'), profile = path.join(run, 'profile');
    await fs.cp(paper, folder, { recursive: true });
    await fs.writeFile(path.join(run, 'acceptance-mode.json'), JSON.stringify({ main: entry }));
    await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
        'wolfbook.tex.mapEngine': 'off', 'wolfbook.tex.liveRender': false,
        'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false, 'update.mode': 'none',
    }, null, 2));
    console.log(`Isolated VS Code arXiv check: ${run}`);
    const child = spawn(code, ['--wait', '--new-window', '--user-data-dir', profile,
        '--extensions-dir', path.join(run, 'extensions'),
        '--extensionDevelopmentPath', path.resolve(__dirname, '../../..'),
        '--extensionTestsPath', path.join(__dirname, 'verifyArxivVSCode.cjs'),
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', folder],
        { stdio: 'inherit' });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const report = JSON.parse(await fs.readFile(path.join(run, 'vscode-arxiv.json'), 'utf8'));
    console.log(JSON.stringify({ ...report, run }, null, 2));
    if (report.result !== 'PASS') process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
