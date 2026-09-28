'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// One metadata record per account avoids lost additions from concurrent windows.
// Tombstones prevent an old window's cached globalState from restoring removals.
function createProfileStore(context) {
    const directory = path.join(context.globalStorageUri.fsPath, 'agent-accounts', 'registrations');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const valid = profile => profile && /^[a-f0-9-]{36}$/.test(profile.id)
        && ['claude', 'codex'].includes(profile.provider) && typeof profile.name === 'string';
    function write(profile, onlyIfMissing = false) {
        if (!valid(profile)) throw new Error('Invalid account profile metadata.');
        const record = { id: profile.id, provider: profile.provider, name: profile.name, ...(profile.deleted ? { deleted: true } : {}) };
        const file = path.join(directory, `${profile.id}.json`);
        const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        try {
            fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
            if (onlyIfMissing) {
                try { fs.linkSync(temp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
            } else fs.renameSync(temp, file);
        } finally { try { fs.unlinkSync(temp); } catch (_) {} }
    }
    for (const profile of context.globalState.get('agentAccounts.profiles', [])) {
        if (valid(profile)) write(profile, true);
    }
    function list() {
        let names;
        try { names = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        return names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => {
            const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
            if (!valid(record)) throw new Error('Invalid saved account metadata.');
            return record;
        }).filter(profile => !profile.deleted).sort((a, b) => a.name.localeCompare(b.name));
    }
    function watch(listener) {
        const watcher = fs.watch(directory, { persistent: false }, (_, name) => {
            if (!name || String(name).endsWith('.json')) listener();
        });
        watcher.on('error', () => {}); // Pickers still read fresh records if watching is unavailable.
        return { dispose: () => watcher.close() };
    }
    return { list, save: write, remove: profile => write({ ...profile, deleted: true }), watch };
}

module.exports = { createProfileStore };
