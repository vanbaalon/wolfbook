'use strict';

// Installed as the Claude extension's process wrapper. Never read credentials:
// select a configuration directory and let the bundled CLI authenticate itself.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function selectRoute(routes, parentPid) {
    // Claude spawns its wrapper directly from the window's extension host.
    // This also handles a panel running in a nested repo or a worktree.
    // Do not guess from cwd: two windows may work in overlapping folders while
    // intentionally choosing different accounts. Unregistered hosts pass through.
    return routes.find(route => route.pid === parentPid);
}

function applyEnvironment(base, patch) {
    const env = { ...base };
    for (const [key, value] of Object.entries(patch || {})) {
        if (value === null) delete env[key];
        else env[key] = value;
    }
    return env;
}

function run(directory, argv) {
    const [binary, ...args] = argv;
    if (!binary || !path.isAbsolute(binary)) throw new Error('Claude did not supply its bundled executable to the account launcher.');
    const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
    const routes = fs.readdirSync(directory).filter(name => /^host-\d+\.json$/.test(name)).flatMap(name => {
        try {
            const route = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
            try { process.kill(route.pid, 0); } catch (error) { if (error.code !== 'EPERM') return []; }
            return [route];
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error; // Never silently fall back to the wrong account.
        }
    });
    const route = selectRoute(routes, process.ppid, process.cwd());
    const env = applyEnvironment(process.env, route?.env);
    const executable = config.previousWrapper || binary;
    const childArgs = config.previousWrapper ? [binary, ...args] : args;
    const child = spawn(executable, childArgs, { env, cwd: process.cwd(), stdio: 'inherit' });
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(`Wolfbook Claude launcher: ${error.message}`); process.exitCode = 1; });
    child.on('exit', (code, signal) => {
        if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
        else process.exitCode = code ?? 1;
    });
}

if (require.main === module) {
    try { run(__dirname, process.argv.slice(2)); }
    catch (error) { console.error(`Wolfbook Claude launcher: ${error.message}`); process.exitCode = 1; }
}
module.exports = { selectRoute, applyEnvironment, run };
