// A paper linked to an Overleaf project, edited in real time in real VS
// Code against a model of Overleaf's service (no network): the reader types
// (real keystrokes) while a collaborator edits. Writes vscode-overleaf-link.json.
//
//   node launchOverleafLinkVSCodeCheck.cjs WLATEX CODE_CLI PAPER_DIR MAIN
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnCode } = require('./vscodeTestLaunch.cjs');
async function main() {
    const [runtime, code, paper, entry, pace = '120'] = process.argv.slice(2);
    if (!runtime || !code || !paper || !entry || ![runtime, code, paper].every(p => path.isAbsolute(p)))
        throw Error('usage: launchNativeTypingVSCodeCheck.cjs WLATEX CODE_CLI PAPER_DIR MAIN [PACE_MS] (absolute paths)');
    const run = await fs.mkdtemp(path.join(os.tmpdir(), 'wpaper-ui-'));
    const folder = path.join(run, 'paper'), profile = path.join(run, 'profile');
    await fs.cp(paper, folder, { recursive: true });
    await fs.writeFile(path.join(run, 'acceptance-mode.json'), JSON.stringify({ mode: 'native', main: entry, paceMs: Number(pace) }));
    await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
        'wolfbook.tex.mapEngine': 'wlatex', 'wolfbook.tex.wlatexDirectory': runtime,
        'wolfbook.tex.liveRender': true,   // the reader's defaults otherwise (settle delays included)
        'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false, 'update.mode': 'none',
    }, null, 2));
    console.log(`Isolated VS Code Overleaf-link check: ${run}`);
    // Its own artifact cache: the first session finds nothing kept.
    const child = spawnCode(code, ['--wait', '--new-window', '--user-data-dir', profile,
        '--extensions-dir', path.join(run, 'extensions'),
        '--extensionDevelopmentPath', path.resolve(__dirname, '../../..'),
        '--extensionTestsPath', path.join(__dirname, 'verifyOverleafLinkVSCode.cjs'),
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', folder],
        { stdio: 'inherit', env: { ...process.env, WLATEX_ARTIFACT_CACHE: path.join(run, 'artifact-cache') } });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const report = JSON.parse(await fs.readFile(path.join(run, 'vscode-overleaf-link.json'), 'utf8'));
    console.log(JSON.stringify({ ...report, run }, null, 2));
    if (report.result !== 'PASS') process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
