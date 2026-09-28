'use strict';

// Machine-local leases for compact K1/K2 labels. Opaque kernel IDs remain the
// routing identity; these leases prevent two live extension hosts from showing
// the same number for different Wolfram processes.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.wolfbook-kernel-labels.json');
function createLabelRegistry(file = FILE) {
    const lock = `${file}.lock`;

    function alive(pid) {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try { process.kill(pid, 0); return true; }
        catch (error) { return error?.code === 'EPERM'; }
    }

    function read() {
        try {
            const value = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(value)) throw new Error('Invalid kernel label registry.');
            return value;
        } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }

    function withLock(action) {
        let fd;
        for (let attempt = 0; attempt < 50; attempt++) {
            try { fd = fs.openSync(lock, 'wx'); break; }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch {}
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
        }
        if (fd === undefined) throw new Error('Timed out allocating a global Wolfram kernel label.');
        try { return action(); }
        finally {
            try { fs.closeSync(fd); } catch {}
            try { fs.unlinkSync(lock); } catch {}
        }
    }

    function save(entries) {
        const temp = `${file}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(temp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(temp, file);
        } finally { try { fs.unlinkSync(temp); } catch (_) {} }
    }

    function reserveKernelLabel(kernelId, preferredLabel = null) {
        return withLock(() => {
            const entries = read().filter(item => item?.kernelId && alive(item.pid));
            const existing = entries.find(item => item.kernelId === kernelId);
            if (existing) {
                if (existing.pid !== process.pid) throw new Error('Kernel label belongs to another extension host.');
                if (!entries.some(item => item !== existing && String(item.label).toLowerCase() === String(existing.label).toLowerCase())) return existing.label;
                // Repair a duplicate left by an older extension host.
                preferredLabel = existing.label;
                entries.splice(entries.indexOf(existing), 1);
            }
            const used = new Set(entries.map(item => String(item.label).toLowerCase()));
            let label = preferredLabel ? String(preferredLabel) : null;
            if (!label || used.has(label.toLowerCase())) {
                let number = 1;
                while (used.has(`k${number}`)) number++;
                label = `K${number}`;
            }
            entries.push({ kernelId, pid: process.pid, label, createdAt: Date.now() });
            save(entries);
            return label;
        });
    }

    function releaseKernelLabel(kernelId) {
        try {
            withLock(() => {
                const entries = read().filter(item => (item?.kernelId !== kernelId || item.pid !== process.pid) && item?.kernelId && alive(item.pid));
                save(entries);
            });
        } catch {}
    }

    function renameKernelLabel(kernelId, label) {
        return withLock(() => {
            const entries = read().filter(item => item?.kernelId && alive(item.pid));
            const entry = entries.find(item => item.kernelId === kernelId && item.pid === process.pid);
            if (!entry) throw new Error('Kernel label reservation is missing or belongs to another window.');
            if (entries.some(item => item.kernelId !== kernelId && String(item.label).toLowerCase() === label.toLowerCase())) {
                throw new Error(`Kernel name “${label}” is already in use in another kernel. Choose a unique name.`);
            }
            entry.label = label;
            save(entries);
            return label;
        });
    }
    return { reserveKernelLabel, releaseKernelLabel, renameKernelLabel };
}

module.exports = { ...createLabelRegistry(), createLabelRegistry, FILE };
