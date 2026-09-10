'use strict';

/**
 * Lifecycle owner for the short-lived Wolfram helpers used by .nb import.
 *
 * Child processes do not die automatically when the VS Code extension host is
 * reloaded. Keep every helper in one registry, put it in a process group on
 * POSIX, and terminate the whole group on cancellation, timeout, or disposal.
 */

const childProcess = require('child_process');

const active = new Map();
const stopping = new WeakMap();

function spawn(command, args, options = {}, metadata = {}) {
    const detached = process.platform !== 'win32';
    const child = childProcess.spawn(command, args, { ...options, detached });
    const record = {
        child,
        pid: child.pid || null,
        stage: metadata.stage || 'nb-import',
        notebook: metadata.notebook || null,
        key: metadata.key || null,
        startedAt: Date.now(),
    };
    active.set(child, record);
    const forget = () => active.delete(child);
    child.once('close', forget);
    child.once('error', forget);
    return child;
}

function signalTree(child, signal) {
    if (!child || child.exitCode != null || child.signalCode != null) return false;
    try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
        return true;
    } catch (_) {
        try { return child.kill(signal); } catch (_) { return false; }
    }
}

/** Graceful stop followed by a bounded hard kill. */
function terminate(child, graceMs = 750) {
    if (!child || child.exitCode != null || child.signalCode != null) {
        active.delete(child);
        return Promise.resolve(true);
    }
    const existing = stopping.get(child);
    if (existing) return existing;

    const promise = new Promise(resolve => {
        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            clearTimeout(hardTimer);
            clearTimeout(giveUpTimer);
            active.delete(child);
            resolve(value);
        };
        child.once('close', () => finish(true));
        signalTree(child, 'SIGTERM');
        const hardTimer = setTimeout(() => signalTree(child, 'SIGKILL'), Math.max(25, graceMs));
        const giveUpTimer = setTimeout(() => finish(false), Math.max(250, graceMs + 1000));
        hardTimer.unref?.();
        giveUpTimer.unref?.();
    });
    stopping.set(child, promise);
    return promise;
}

function terminateKey(key) {
    if (!key) return Promise.resolve([]);
    return Promise.all([...active.values()]
        .filter(record => record.key === key)
        .map(record => terminate(record.child)));
}

function dispose() {
    for (const record of active.values()) signalTree(record.child, 'SIGKILL');
    active.clear();
}

function snapshot() {
    return [...active.values()].map(({ pid, stage, notebook, key, startedAt }) => ({
        pid, stage, notebook, key, startedAt,
    }));
}

// Covers normal extension-host shutdown in addition to the VS Code Disposable.
process.once('exit', dispose);

module.exports = { spawn, terminate, terminateKey, dispose, snapshot, signalTree };
