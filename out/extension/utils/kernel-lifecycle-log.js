'use strict';

// Small, always-on lifecycle evidence. No expressions, notebook contents or
// credentials. Async, bounded writes outside the workspace; never delays WSTP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logPaths = require('./log-paths');
const host = `${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const LIMIT = 256 * 1024;
let queue = Promise.resolve(), pending = 0, prepared = false;
const fields = ['kernelId', 'epoch', 'pid', 'state', 'reason', 'code', 'clientId', 'port'];
const directory = () => path.join(logPaths.logRoot(), 'lifecycle');
const filename = () => path.join(directory(), `host-${host}.jsonl`);

function record(event, details = {}) {
    if (pending >= 128) return; // never build an unbounded backlog on slow storage
    const row = { at: new Date().toISOString(), hostPid: process.pid, event };
    for (const key of fields) {
        const value = details[key];
        if (typeof value === 'number' || typeof value === 'boolean' || value === null) row[key] = value;
        else if (typeof value === 'string') row[key] = value.slice(0, 160);
    }
    pending++;
    queue = queue.then(async () => {
        await fs.promises.mkdir(directory(), { recursive: true });
        if (!prepared) {
            prepared = true;
            const files = (await fs.promises.readdir(directory())).filter(f => /^host-.*\.jsonl(?:\.1)?$/.test(f));
            const dated = await Promise.all(files.map(async f => ({ f, at: (await fs.promises.stat(path.join(directory(), f))).mtimeMs })));
            for (const { f } of dated.sort((a, b) => b.at - a.at).slice(20)) {
                await fs.promises.unlink(path.join(directory(), f)).catch(() => {});
            }
        }
        const file = filename();
        const size = await fs.promises.stat(file).then(s => s.size, () => 0);
        if (size >= LIMIT) {
            await fs.promises.unlink(`${file}.1`).catch(() => {});
            await fs.promises.rename(file, `${file}.1`);
        }
        await fs.promises.appendFile(file, JSON.stringify(row) + '\n');
    }).catch(() => {}).finally(() => { pending--; });
}

function readTail(lines = 150, filter) {
    const rows = [];
    try {
        // Include prior hosts: their last events survive a crash or a reload.
        const files = fs.readdirSync(directory()).filter(f => /^host-.*\.jsonl(?:\.1)?$/.test(f))
            .map(f => ({ file: path.join(directory(), f), at: fs.statSync(path.join(directory(), f)).mtimeMs }))
            .sort((a, b) => b.at - a.at).slice(0, 8);
        for (const { file } of files) {
            const fd = fs.openSync(file, 'r');
            try {
                const size = fs.fstatSync(fd).size, start = Math.max(0, size - 64 * 1024);
                const buf = Buffer.alloc(size - start);
                fs.readSync(fd, buf, 0, buf.length, start);
                const text = buf.toString('utf8');
                for (const line of (start ? text.slice(text.indexOf('\n') + 1) : text).split('\n')) {
                    try { rows.push(JSON.parse(line)); } catch (_) {}
                }
            } finally { fs.closeSync(fd); }
        }
    } catch (_) {}
    return rows.sort((a, b) => a.at.localeCompare(b.at))
        .filter(row => !filter || JSON.stringify(row).toLowerCase().includes(String(filter).toLowerCase()))
        .slice(-Math.max(1, Math.min(1000, lines))).map(row => JSON.stringify(row)).join('\n');
}

module.exports = { record, readTail, flush: () => queue };
