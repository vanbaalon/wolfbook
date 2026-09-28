// Starts the test VS Code for the launch*VSCodeCheck.cjs harnesses WITHOUT
// SHOWING IT: on macOS a separate instance (its own --user-data-dir) opened
// hidden and in the background (`open -g -j -n`), so a test run never takes
// the screen or the focus from whoever is working. WPAPER_TEST_VISIBLE=1
// shows it (the old `code --wait`), e.g. to watch a test.
//
// The hidden instance is waited for by its report (vscode-*.json, written by
// the test in its run directory) and then closed — only processes started
// with this run's profile directory, never the reader's own VS Code.
//
// A hidden window gets no animation frames, so pdf.js in the panel does not
// finish drawing a page after the first: checks that need the panel to
// re-open a PDF belong with WPAPER_TEST_VISIBLE=1.
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

function spawnCode(code, args, options = {}) {
    const app = code.includes('.app/') ? code.slice(0, code.indexOf('.app/') + 4) : null;
    if (process.platform !== 'darwin' || process.env.WPAPER_TEST_VISIBLE === '1' || !app) return spawn(code, args, options);
    const profile = args[args.indexOf('--user-data-dir') + 1];
    const run = path.dirname(profile);
    const env = Object.entries(options.env || {}).filter(([k, v]) => v !== undefined && process.env[k] !== v)
        .flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    const child = new EventEmitter();
    const opener = spawn('open', ['-g', '-j', '-n', ...env, '-a', app, '--args', ...args.filter(a => a !== '--wait')], { stdio: 'inherit' });
    opener.once('error', e => child.emit('error', e));
    const reports = () => { try { return fs.readdirSync(run).filter(f => /^vscode-.*\.json$/.test(f)); } catch (_) { return []; } };
    const started = Date.now(), limitMs = Number(process.env.WPAPER_TEST_TIMEOUT_MS || 15 * 60 * 1000);
    const timer = setInterval(() => {
        const done = reports().length > 0;
        if (!done && Date.now() - started < limitMs) return;
        clearInterval(timer);
        // Let the test finish writing and close its window, then end the instance.
        setTimeout(() => {
            try { execFileSync('pkill', ['-f', `user-data-dir ${profile}`]); } catch (_) { /* already gone */ }
            child.emit('close', done ? 0 : 1);
        }, 1500);
    }, 500);
    return child;
}

module.exports = { spawnCode };
