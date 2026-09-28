// node launchNativeVSCodeCheck.cjs WLATEX_INSTALL CODE_CLI [native|default|missing] [lf|crlf]
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnCode } = require('./vscodeTestLaunch.cjs');
async function main() {
    const [runtime, code, mode = 'native', eol = 'lf'] = process.argv.slice(2);
    if (!['lf', 'crlf'].includes(eol)) throw Error('Unknown line ending mode');
    if (!['native', 'default', 'missing'].includes(mode)) throw Error('Unknown acceptance mode');
    if (!runtime || !code || !path.isAbsolute(runtime) || !path.isAbsolute(code))
        throw Error('Supply absolute WLaTeX installation and VS Code CLI paths');
    const run = await fs.mkdtemp(path.join(os.tmpdir(), 'wpaper-ui-'));
    const folder = path.join(run,'paper'), profile = path.join(run,'profile');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(run, 'acceptance-mode.json'), JSON.stringify({ mode, eol }));
    await fs.mkdir(path.join(profile,'User'), { recursive:true });
    await fs.writeFile(path.join(folder,'paper.tex'), '\\documentclass{article}\n\\begin{document}\nAlpha Beta. Gamma Delta.\n\\newpage\nSecond page.\n\\end{document}\n'.replace(/\n/g, eol === 'crlf' ? '\r\n' : '\n'));
    // wlatexDirectory has machine scope, so configure the isolated user profile,
    // not workspace settings (which VS Code correctly ignores for this key).
    await fs.writeFile(path.join(profile,'User/settings.json'), JSON.stringify({
        'wolfbook.tex.mapEngine':mode === 'default' ? 'auto' : 'wlatex',
        'wolfbook.tex.wlatexDirectory':mode === 'native' ? runtime : '',
        'wolfbook.tex.authoritativeDelayMs':0, 'wolfbook.tex.liveRender':false,
        'telemetry.telemetryLevel':'off', 'workbench.startupEditor':'none',
        'security.workspace.trust.enabled':false, 'extensions.autoUpdate':false,
        'update.mode':'none',
    }, null, 2));
    console.log(`Isolated VS Code acceptance: ${run}`);
    const env = { ...process.env };
    if (mode !== 'native') delete env.WLATEX_HOME;
    const child = spawnCode(code, ['--wait', '--new-window', '--user-data-dir', profile,
        '--extensions-dir', path.join(run,'extensions'),
        '--extensionDevelopmentPath', path.resolve(__dirname,'../../..'),
        '--extensionTestsPath', path.join(__dirname,'verifyNativeVSCode.cjs'),
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', folder],
        { stdio:'inherit', env });
    await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',resolve); });
    const report = JSON.parse(await fs.readFile(path.join(run,'vscode-acceptance.json'),'utf8'));
    console.log(JSON.stringify({ ...report, run }, null, 2));
    if (report.result !== 'PASS') process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
