'use strict';

// Production-package boundary: .vscodeignore deliberately removes the Oberon
// benchmark corpus. Runtime activation must therefore load with every require
// into oberon/tests behaving exactly as it does in a clean public VSIX.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeVscodeStub } = require('./_stub-vscode');

const EXT = path.resolve(__dirname, '..', '..', '..', '..');
const OBERON = path.join(EXT, 'out', 'extension', 'oberon');
const ignore = fs.readFileSync(path.join(EXT, '.vscodeignore'), 'utf8');
assert.ok(/^out\/extension\/oberon\/tests\/\*\*$/m.test(ignore),
    'this regression test only means something while production excludes the developer suite');

const vscode = makeVscodeStub();
const original = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    const fromOberon = parent && parent.filename && parent.filename.startsWith(OBERON + path.sep);
    const asksForTests = /(?:^|[\\/])tests(?:[\\/]|$)/.test(String(request));
    if (fromOberon && asksForTests) {
        const e = new Error(`Cannot find module '${request}'`);
        e.code = 'MODULE_NOT_FOUND';
        throw e;
    }
    return original.call(this, request, parent, isMain);
};

(async () => {
    let temp = null;
    try {
        assert.doesNotThrow(() => require('../../oberon'),
            'Oberon activation surface must not import excluded developer files eagerly');
        const postmortem = require('../../oberon/memory/postmortem');
        assert.strictEqual(typeof postmortem.writePostmortem, 'function');
        assert.strictEqual(typeof postmortem.writeErrorPostmortem, 'function');

        // The base postmortem is production functionality. It must still be
        // written when the optional research evaluator was excluded.
        temp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wolfbook-package-boundary-'));
        const project = require('../../oberon/memory/project');
        const settings = require('../../oberon/config/settings');
        project.postmortemsDir = () => temp;
        settings.postmortem = () => ({ narrativeEnabled: false });
        const result = await postmortem.writePostmortem({ runId: 'clean-vsix' });
        assert.ok(result && fs.existsSync(result.path), 'the production postmortem was written');
        assert.strictEqual(result.capabilityReport, null,
            'the absent optional evaluator degrades to no sidecar, not an activation failure');
        console.log('oberon production package boundary: OK');
    } finally {
        Module._load = original;
        if (temp) fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch((e) => {
    console.error(e && e.stack || e);
    process.exit(1);
});
