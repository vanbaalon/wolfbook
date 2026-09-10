'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Private extension storage, not the source tree. Recompiling never touches it.
class ReviewStore {
    constructor(directory) { this.directory = directory; this.hashes = new Map(); fs.mkdirSync(directory, { recursive: true }); }
    save(record) {
        const key = crypto.createHash('sha256').update(record.file).digest('hex');
        const destination = path.join(this.directory, key + '.json');
        const temporary = destination + '.' + process.pid + '.tmp';
        const content = JSON.stringify({ version: 1, ...record });
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        if (this.hashes.get(key) === hash) return;
        fs.writeFileSync(temporary, content, { mode: 0o600 });
        fs.renameSync(temporary, destination);
        this.hashes.set(key, hash);
    }
    load() {
        this.errors = [];
        return fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
            try {
            const record = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'));
            if (record.version !== 1 || typeof record.file !== 'string') throw new Error('Invalid saved review: ' + name);
            return [record];
            } catch (error) { this.errors.push({ name, message: error.message }); return []; }
        });
    }
}
module.exports = { ReviewStore };
