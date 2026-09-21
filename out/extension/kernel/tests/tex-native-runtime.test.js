const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TARGETS, targetFor, resolveNativeRuntime, readInstallation, digest } = require('../../tex/nativeRuntime');
function installation(target = 'darwin-arm64') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-runtime-'));
    fs.mkdirSync(path.join(root, 'sdk')); fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'sdk/index.cjs'), 'module.exports = {};');
    const suffix = target.startsWith('win32-') ? '.exe' : '';
    const manifest = { schema:1, target, resources:'external-tex', sdk:'sdk/index.cjs',
        labBinary:`bin/wlatex-lab${suffix}`, nativeBinary:`bin/wlatex-native-lab${suffix}` };
    for (const file of [manifest.labBinary, manifest.nativeBinary]) fs.writeFileSync(path.join(root, file), 'fixture', { mode:0o755 });
    manifest.files = [manifest.sdk, manifest.labBinary, manifest.nativeBinary]
        .map(file => ({ path:file, sha256:digest(path.join(root,file)) }));
    const save = () => fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify(manifest));
    save(); return { root, manifest, save, close:() => fs.rmSync(root, { recursive:true, force:true }) };
}
test('absence is optional and never searches the extension for bundled engines', () => {
    assert.equal(resolveNativeRuntime('', { env:{}, platform:'unsupported', arch:'unknown' }), null);
});
test('separate installations resolve the four declared platform targets', () => {
    for (const target of TARGETS) {
        const [platform, arch] = target.split('-');
        assert.equal(targetFor(platform, arch), target);
        const f = installation(target);
        try {
            const runtime = resolveNativeRuntime(f.root, { platform, arch, env:{} });
            assert.equal(runtime.target, target);
            assert.equal(runtime.installed, true);
            assert.equal(runtime.directory, f.root);
        } finally { f.close(); }
    }
    assert.throws(() => targetFor('win32', 'arm64'), /not supported/);
});
test('WLATEX_HOME points to a separately installed runtime', () => {
    const f = installation();
    try {
        assert.equal(resolveNativeRuntime('', { env:{ WLATEX_HOME:f.root }, platform:'darwin', arch:'arm64' }).directory, f.root);
    } finally { f.close(); }
});
test('wrong targets and altered runtime files are rejected before loading code', () => {
    const f = installation();
    try {
        assert.throws(() => readInstallation(f.root, 'linux-x64'), /mismatch/);
        fs.appendFileSync(path.join(f.root, 'sdk/index.cjs'), '// altered');
        assert.throws(() => readInstallation(f.root, 'darwin-arm64'), /checksum mismatch/);
    } finally { f.close(); }
});
test('runtime inventory rejects traversal, missing entry points and symlinks', () => {
    for (const edit of [
        f => { f.manifest.files[0].path = '../outside'; },
        f => { f.manifest.sdk = 'missing.cjs'; },
        f => { const p = path.join(f.root, 'sdk/index.cjs'); fs.unlinkSync(p); fs.symlinkSync('../bin/wlatex-lab', p); },
    ]) {
        const f = installation();
        try { edit(f); f.save(); assert.throws(() => readInstallation(f.root, 'darwin-arm64')); }
        finally { f.close(); }
    }
});
test('explicit development checkouts require real executable paths', () => {
    const f = installation();
    try {
        fs.unlinkSync(path.join(f.root, 'runtime.json'));
        assert.throws(() => resolveNativeRuntime(f.root, { platform:'darwin', arch:'arm64', env:{} }), /ENOENT/);
        assert.throws(() => resolveNativeRuntime('relative', { env:{} }), /absolute/);
    } finally { f.close(); }
});
