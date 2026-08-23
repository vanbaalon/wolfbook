// The vendored editor modules must match the repo they came from.
//
//   node out/extension/kernel/tests/tex-mma-vendor.test.js
//
// out/client/wb/ is a COPY of files owned by WolfbookChromeExtension, brought
// across by that repo's sync-editor-to-vscode.sh. A copy nobody checks is a
// copy that drifts, and this project has already paid for that once: the 3D
// viewer harness kept its own wl3d-viewer.js, so a camera change measured as
// having no effect at all because the harness was running code that did not
// ship.
//
// SKIPS when the Chrome repo is not beside this one — a release build, or a
// clone of just the extension, must not fail for want of a sibling checkout.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0; let fail = 0; let skip = 0;
const results = [];
function test(name, fn) {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) {
        if (e && e.__skip) { skip++; results.push('  skip ' + name + ' — ' + e.message); return; }
        fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         '));
    }
}
function skipIf(cond, why) { if (cond) { const e = new Error(why); e.__skip = true; throw e; } }

const WB = path.join(__dirname, '../../../../out/client/wb');
const CHROME = path.join(__dirname, '../../../../../WolfbookChromeExtension');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('the vendored directory carries a provenance record', () => {
    assert.ok(fs.existsSync(path.join(WB, 'PROVENANCE.json')),
        'out/client/wb/PROVENANCE.json is missing — run sync-editor-to-vscode.sh');
    const prov = JSON.parse(fs.readFileSync(path.join(WB, 'PROVENANCE.json'), 'utf8'));
    assert.ok(prov.files && Object.keys(prov.files).length, 'it names no files');
    for (const [name, rec] of Object.entries(prov.files)) {
        assert.ok(fs.existsSync(path.join(WB, name)), `${name} is recorded but not present`);
        assert.ok(/^[0-9a-f]{64}$/.test(rec.sha256), `${name} has no usable hash`);
        assert.ok(rec.from, `${name} does not say where it came from`);
    }
});

test('every vendored file still matches its upstream, byte for byte', () => {
    skipIf(!fs.existsSync(CHROME), 'the Chrome extension repo is not checked out beside this one');
    const prov = JSON.parse(fs.readFileSync(path.join(WB, 'PROVENANCE.json'), 'utf8'));
    const drifted = [];
    for (const [name, rec] of Object.entries(prov.files)) {
        const upstream = path.join(CHROME, rec.from);
        if (!fs.existsSync(upstream)) { drifted.push(`${name}: upstream ${rec.from} is gone`); continue; }
        const now = sha256(fs.readFileSync(upstream));
        if (now !== rec.sha256) drifted.push(`${name}: upstream changed since the last sync`);
    }
    assert.strictEqual(drifted.join('; '), '',
        'run WolfbookChromeExtension/sync-editor-to-vscode.sh — ' + drifted.join('; '));
});

test('the import patch is applied, so the copy resolves beside itself', () => {
    const src = fs.readFileSync(path.join(WB, 'wl-highlight.js'), 'utf8');
    assert.ok(src.includes("from './wl-builtins.js'"), 'the builtin list is imported from beside the file');
    assert.ok(!src.includes("from '../vendor/"), 'no path from the other repo survived the copy');
});

test('the highlighter exports what the card calls, and nothing chrome-shaped', () => {
    const src = fs.readFileSync(path.join(WB, 'wl-highlight.js'), 'utf8');
    assert.ok(/export function highlightWolfram\b/.test(src));
    assert.ok(!/\bchrome\./.test(src), 'a chrome.* call would not survive a VS Code webview');
});

console.log('\ntex-mma-vendor.test.js');
console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
