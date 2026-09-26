// Opening a paper on the WLaTeX lane, in real VS Code: live pages before the
// first PDF, and a reopened paper starting from the settled build kept.
//
//   node launchNativeFirstOpenVSCodeCheck.cjs WLATEX CODE_CLI PAPER_DIR MAIN
//
// Copies the paper into an isolated wpaper-ui-* run, opens it in VS Code with
// the WLaTeX lane (isolated profile) and its own artifact cache, and runs
// verifyNativeFirstOpenVSCode.cjs in the extension host: two sessions, the
// second as after a restart. Prints and writes vscode-first-open.json.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
async function main() {
    const [runtime, code, paper, entry, sample = '120'] = process.argv.slice(2);
    if (!runtime || !code || !paper || !entry || ![runtime, code, paper].every(p => path.isAbsolute(p)))
        throw Error('usage: launchNativeFirstOpenVSCodeCheck.cjs WLATEX CODE_CLI PAPER_DIR MAIN (absolute paths)');
    const run = await fs.mkdtemp(path.join(os.tmpdir(), 'wpaper-ui-'));
    const folder = path.join(run, 'paper'), profile = path.join(run, 'profile');
    await fs.cp(paper, folder, { recursive: true });
    await fs.writeFile(path.join(run, 'acceptance-mode.json'), JSON.stringify({ mode: 'native', main: entry, sample: Number(sample) }));
    await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
        'wolfbook.tex.mapEngine': 'wlatex', 'wolfbook.tex.wlatexDirectory': runtime,
        'wolfbook.tex.authoritativeDelayMs': 0, 'wolfbook.tex.liveRender': false,
        'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false, 'update.mode': 'none',
    }, null, 2));
    console.log(`Isolated VS Code first-open check: ${run}`);
    // Its own artifact cache: the first session finds nothing kept.
    const child = spawn(code, ['--wait', '--new-window', '--user-data-dir', profile,
        '--extensions-dir', path.join(run, 'extensions'),
        '--extensionDevelopmentPath', path.resolve(__dirname, '../../..'),
        '--extensionTestsPath', path.join(__dirname, 'verifyNativeFirstOpenVSCode.cjs'),
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', folder],
        { stdio: 'inherit', env: { ...process.env, WLATEX_ARTIFACT_CACHE: path.join(run, 'artifact-cache') } });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const report = JSON.parse(await fs.readFile(path.join(run, 'vscode-first-open.json'), 'utf8'));
    console.log(JSON.stringify({ ...report, run }, null, 2));
    if (report.result !== 'PASS') process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
