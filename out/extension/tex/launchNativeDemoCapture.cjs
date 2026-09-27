// Film the WLaTeX Pro demo in real VS Code.
//
//   node launchNativeDemoCapture.cjs WLATEX CODE_CLI PAPER_DIR MAIN OUT_DIR [PLAYWRIGHT_DIR]
//
// Copies the paper into an isolated wpaper-ui-* run and opens it in VS Code
// (isolated profile, light theme) with a remote-debugging port; the extension
// host runs verifyNativeDemoVSCode.cjs, the scripted demo. This process
// attaches to the window through the Chrome DevTools protocol (Playwright's
// connectOverCDP), screenshots it about ten times a second, types into the
// pickers' search boxes when the demo asks (demo-phase.json), and assembles
// OUT_DIR/wlatex-pro-demo.mp4 and .gif with ffmpeg from the frames' real times.
// PLAYWRIGHT_DIR is a node_modules/playwright (default: WLaTeX's desktop one).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PORT = 9337;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    const [runtime, code, paper, entry, out, pw] = process.argv.slice(2);
    if (!runtime || !code || !paper || !entry || !out || ![runtime, code, paper, out].every(p => path.isAbsolute(p)))
        throw Error('usage: launchNativeDemoCapture.cjs WLATEX CODE_CLI PAPER_DIR MAIN OUT_DIR [PLAYWRIGHT_DIR] (absolute paths)');
    const { chromium } = require(pw || path.join(runtime, 'desktop/node_modules/playwright'));
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-ui-'));
    const folder = path.join(run, 'paper'), profile = path.join(run, 'profile'), frames = path.join(run, 'frames');
    fs.cpSync(paper, folder, { recursive: true });
    fs.mkdirSync(frames);
    fs.writeFileSync(path.join(run, 'acceptance-mode.json'), JSON.stringify({ mode: 'native', main: entry }));
    fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({
        'wolfbook.tex.mapEngine': 'wlatex', 'wolfbook.tex.wlatexDirectory': runtime,
        'workbench.colorTheme': 'Default Light Modern', 'editor.fontSize': 14, 'editor.minimap.enabled': false,
        'workbench.activityBar.location': 'hidden', 'chat.commandCenter.enabled': false, 'window.commandCenter': false,
        'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
        'extensions.autoUpdate': false, 'update.mode': 'none', 'workbench.tips.enabled': false,
    }, null, 2));
    console.log(`Demo capture: ${run}`);
    const child = spawn(code, ['--wait', '--new-window', '--user-data-dir', profile, '--extensions-dir', path.join(run, 'extensions'),
        `--remote-debugging-port=${PORT}`,
        '--extensionDevelopmentPath', path.resolve(__dirname, '../../..'),
        '--extensionTestsPath', path.join(__dirname, 'verifyNativeDemoVSCode.cjs'),
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', folder],
        { stdio: 'ignore', env: { ...process.env, WLATEX_ARTIFACT_CACHE: path.join(run, 'artifact-cache') } });
    const closed = new Promise(r => child.once('close', r));
    let browser = null;
    for (let i = 0; i < 120 && !browser; i++) { await sleep(500); try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch (_) { /* not yet */ } }
    if (!browser) throw Error('could not attach to VS Code');
    const window = browser.contexts().flatMap(c => c.pages()).find(p => /workbench/.test(p.url())) || browser.contexts()[0].pages()[0];
    const phaseFile = path.join(run, 'demo-phase.json');
    const readPhase = () => { try { return JSON.parse(fs.readFileSync(phaseFile, 'utf8')); } catch (_) { return null; } };
    // The webview frame that holds the picker.
    const pickerFrame = async () => {
        for (const frame of window.frames()) {
            try { if (await frame.$('.inkpicker input')) return frame; } catch (_) { /* detached */ }
        }
        return null;
    };
    let stop = false, shot = 0;
    const times = [];
    const t0 = Date.now();
    const recorder = (async () => {
        while (!stop) {
            const at = Date.now() - t0;
            try {
                await window.screenshot({ path: path.join(frames, `f${String(shot).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85, scale: 'css' });
                times.push(at); shot++;
            } catch (_) { /* a frame lost */ }
            await sleep(Math.max(0, 100 - (Date.now() - t0 - at)));
        }
    })();
    const driver = (async () => {
        let handled = 0;
        while (!stop) {
            const p = readPhase();
            if (p?.phase === 'finished') break;
            if (p?.phase === 'picker' && !p.done) {
                handled++;
                let frame = null;
                for (let i = 0; i < 100 && !frame; i++) { frame = await pickerFrame(); if (!frame) await sleep(100); }
                if (frame) {
                    await frame.type('.inkpicker input', p.query, { delay: 110 });
                    // INSPIRE answers after a pause in typing.
                    if (p.inspire) await frame.waitForSelector('.inkpicker-section', { timeout: 20000 }).catch(() => {});
                    await sleep(p.inspire ? 2500 : 900);
                    if (p.inspire) {
                        // The first INSPIRE row: below the paper's own rows.
                        const mine = await frame.$$eval('.inkpicker-row', rows => {
                            const section = document.querySelector('.inkpicker-section');
                            return section ? rows.filter(r => r.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).length : rows.length;
                        });
                        for (let i = 0; i < mine; i++) { await frame.press('.inkpicker input', 'ArrowDown'); await sleep(120); }
                        await sleep(600);
                    }
                    await frame.press('.inkpicker input', 'Enter');
                }
                fs.writeFileSync(phaseFile, JSON.stringify({ ...p, done: 'picker', handled }));
            }
            await sleep(100);
        }
    })();
    await closed;
    stop = true;
    await Promise.allSettled([recorder, driver]);
    await browser.close().catch(() => {});
    // Frames at their real times (concat demuxer with per-frame durations).
    const list = times.map((at, i) => `file 'f${String(i).padStart(5, '0')}.jpg'\nduration ${(((times[i + 1] ?? at + 100) - at) / 1000).toFixed(3)}`).join('\n');
    fs.writeFileSync(path.join(frames, 'list.txt'), `${list}\nfile 'f${String(times.length - 1).padStart(5, '0')}.jpg'\n`);
    fs.mkdirSync(out, { recursive: true });
    const mp4 = path.join(out, 'wlatex-pro-demo.mp4'), gif = path.join(out, 'wlatex-pro-demo.gif');
    const ff = args => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { cwd: frames, stdio: 'inherit' });
    // Without the window's title bar (it says Extension Development Host) and status bar.
    ff(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-vf', 'crop=in_w:in_h-60:0:36,scale=1440:-2:flags=lanczos,fps=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4]);
    ff(['-i', mp4, '-vf', 'fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', gif]);
    const report = JSON.parse(fs.readFileSync(path.join(run, 'vscode-demo.json'), 'utf8'));
    console.log(JSON.stringify({ ...report, frames: times.length, mp4, gif, run }, null, 2));
    if (report.result !== 'PASS') process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
