// WPaper owns runtime selection; the WLaTeX SDK owns compiler/source protocols.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TARGETS = Object.freeze(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']);
function targetFor(platform = process.platform, arch = process.arch) {
    const target = `${platform}-${arch}`;
    if (!TARGETS.includes(target)) throw Error(`WLaTeX runtime is not supported for ${target}`);
    return target;
}
function member(root, name) {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') ||
        name.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Invalid WLaTeX runtime path');
    let file = root;
    for (const part of name.split('/')) {
        file = path.join(file, part);
        if (fs.lstatSync(file).isSymbolicLink()) throw Error('WLaTeX runtime contains a symbolic link');
    }
    if (!fs.statSync(file).isFile()) throw Error('WLaTeX runtime member is not a file');
    return file;
}
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function readInstallation(root, target) {
    const manifestFile = member(root, 'runtime.json');
    if (fs.statSync(manifestFile).size > 1024 * 1024) throw Error('WLaTeX runtime manifest is too large');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.schema !== 1 || manifest.target !== target || !TARGETS.includes(target))
        throw Error('WLaTeX runtime target or schema mismatch');
    // The current SDK needs an external TeX resource tree. A self-contained
    // runtime will need a versioned launch contract from its producer.
    if (manifest.resources !== 'external-tex') throw Error('Unsupported WLaTeX resource launch contract');
    if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000)
        throw Error('Invalid WLaTeX runtime inventory');
    const files = new Map();
    for (const entry of manifest.files) {
        if (!entry || files.has(entry.path) || !/^[0-9a-f]{64}$/.test(entry.sha256))
            throw Error('Invalid WLaTeX runtime file digest');
        const file = member(root, entry.path);
        if (digest(file) !== entry.sha256) throw Error(`WLaTeX runtime checksum mismatch: ${entry.path}`);
        files.set(entry.path, file);
    }
    const entry = key => {
        const file = files.get(manifest[key]);
        if (!file) throw Error(`WLaTeX runtime lacks ${key}`);
        return file;
    };
    const result = { sdk:entry('sdk'), labBinary:entry('labBinary'), nativeBinary:entry('nativeBinary'),
        target, installed:true, resources:manifest.resources, directory:root };
    if (!target.startsWith('win32-')) {
        fs.accessSync(result.labBinary, fs.constants.X_OK);
        fs.accessSync(result.nativeBinary, fs.constants.X_OK);
    }
    return result;
}
// The most recently built lab binary of a development checkout. A debug build
// answers a page view six times slower than a release build (349 ms against
// 55 ms for three pages of the 200-page book), so whichever profile the
// developer last built is the one they mean; the debug path remains the
// fallback when neither has been built so the error names it.
function newestBuild(location, name) {
    const candidates = ['release', 'debug'].map(profile => path.join(location, 'target', profile, name));
    let newest = null, newestTime = -Infinity;
    for (const file of candidates) {
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        if (stat.isFile() && stat.mtimeMs > newestTime) { newest = file; newestTime = stat.mtimeMs; }
    }
    return newest || candidates[1];
}
function resolveNativeRuntime(directory, options = {}) {
    const location = directory || (options.env || process.env).WLATEX_HOME;
    if (!location) return null;
    const target = targetFor(options.platform, options.arch);
    if (!path.isAbsolute(location)) throw Error('WLaTeX installation path must be absolute');
    if (fs.existsSync(path.join(location, 'runtime.json'))) return readInstallation(location, target);
    // Retain the explicit development-checkout override. Ordinary extension
    // installs never search for or load an SDK from their own directory.
    const suffix = target.startsWith('win32-') ? '.exe' : '';
    const result = { directory:location, target, installed:false, resources:'external-tex',
        sdk:path.join(location, 'integrations/wpaper'),
        labBinary:newestBuild(location, `wlatex-lab${suffix}`),
        nativeBinary:path.join(location, `native-lab/target/release/wlatex-native-lab${suffix}`) };
    fs.accessSync(path.join(result.sdk, 'index.cjs'), fs.constants.R_OK);
    for (const file of [result.labBinary, result.nativeBinary])
        fs.accessSync(file, target.startsWith('win32-') ? fs.constants.R_OK : fs.constants.X_OK);
    return result;
}
module.exports = { TARGETS, targetFor, readInstallation, resolveNativeRuntime, newestBuild, digest };
