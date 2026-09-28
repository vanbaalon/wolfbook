'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createProfileStore } = require('../../account-profile-store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-shared-accounts-'));
try {
    const legacy = { id: crypto.randomUUID(), provider: 'claude', name: 'Personal' };
    const context = profiles => ({ globalStorageUri: { fsPath: tmp }, globalState: { get: () => profiles } });
    const a = createProfileStore(context([legacy]));
    // Window B deliberately holds a stale/empty VS Code globalState snapshot.
    const b = createProfileStore(context([]));
    assert.deepStrictEqual(b.list(), [legacy]);
    const kcl = { id: crypto.randomUUID(), provider: 'claude', name: 'kcl' };
    const gmail = { id: crypto.randomUUID(), provider: 'codex', name: 'gmail' };
    a.save(kcl);
    b.save(gmail);
    assert.strictEqual(a.list().length, 3);
    assert.deepStrictEqual(a.list(), b.list(), 'both open windows see registrations immediately');
    b.save({ ...legacy, name: 'Renamed' });
    const stale = createProfileStore(context([legacy]));
    assert.strictEqual(stale.list().find(p => p.id === legacy.id).name, 'Renamed', 'legacy migration never overwrites newer metadata');
    a.remove(kcl);
    const staleAfterDelete = createProfileStore(context([legacy, kcl]));
    assert(!staleAfterDelete.list().some(p => p.id === kcl.id), 'stale windows cannot reimport forgotten accounts');
    assert(!b.list().some(p => p.id === kcl.id));
    assert.throws(() => a.save({ ...legacy, id: '../escape' }), /Invalid/);
    const stored = fs.readFileSync(path.join(tmp, 'agent-accounts', 'registrations', `${legacy.id}.json`), 'utf8');
    assert.deepStrictEqual(Object.keys(JSON.parse(stored)).sort(), ['id', 'name', 'provider']);
    console.log('Shared accounts: migration, stale windows, independent additions, rename, deletion tombstones, metadata validation passed.');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
