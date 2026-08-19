'use strict';

// Machine-local leases for compact K1/K2 labels. Opaque kernel IDs remain the
// routing identity; these leases prevent two live extension hosts from showing
// the same number for different Wolfram processes.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.wolfbook-kernel-labels.json');
const LOCK = `${FILE}.lock`;

function alive(pid) {
    try { process.kill(Number(pid), 0); return true; }
    catch (error) { return error?.code === 'EPERM'; }
}

function read() {
    try {
        const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return Array.isArray(value) ? value : [];
    } catch { return []; }
}

function withLock(action) {
    let fd;
    for (let attempt = 0; attempt < 50; attempt++) {
        try { fd = fs.openSync(LOCK, 'wx'); break; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 5000) fs.unlinkSync(LOCK); } catch {}
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }
    if (fd === undefined) throw new Error('Timed out allocating a global Wolfram kernel label.');
    try { return action(); }
    finally {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(LOCK); } catch {}
    }
}

function reserveKernelLabel(kernelId, preferredLabel = null) {
    return withLock(() => {
        const entries = read().filter(item => item?.kernelId && alive(item.pid));
        const existing = entries.find(item => item.kernelId === kernelId);
        if (existing) return existing.label;
        const used = new Set(entries.map(item => Number(String(item.label).replace(/^K/, ''))).filter(Number.isInteger));
        const preferred = Number(String(preferredLabel || '').replace(/^K/, ''));
        let number = Number.isInteger(preferred) && preferred > 0 && !used.has(preferred) ? preferred : 1;
        while (used.has(number)) number++;
        const label = `K${number}`;
        entries.push({ kernelId, pid: process.pid, label, createdAt: Date.now() });
        fs.writeFileSync(FILE, JSON.stringify(entries, null, 2), 'utf8');
        return label;
    });
}

function releaseKernelLabel(kernelId) {
    try {
        withLock(() => {
            const entries = read().filter(item => item?.kernelId !== kernelId && item?.kernelId && alive(item.pid));
            fs.writeFileSync(FILE, JSON.stringify(entries, null, 2), 'utf8');
        });
    } catch {}
}

module.exports = { reserveKernelLabel, releaseKernelLabel, FILE };
