// Release check: vsce ls > package-files.txt && node verifyNativePackage.cjs package-files.txt
const fs = require('node:fs');
const assert = require('node:assert/strict');
const required = [
    'out/extension/tex/nativeRuntime.js', 'out/extension/tex/nativeCompileService.js',
    'out/extension/tex/nativeArtifactCache.js', 'out/extension/tex/nativeMap.js', 'out/extension/tex/pdfRanges.js',
    'out/extension/tex/texViewer.js', 'out/client/tex-viewer.js', 'out/client/pdf-ranges.js',
];
function verifyNativePackage(list) {
    const files = list.split(/\r?\n/).map(line=>line.trim().replace(/\\/g,'/')).filter(Boolean);
    const names = new Set(files);
    for (const file of required) assert.ok(names.has(file), `Missing WPaper integration asset: ${file}`);
    const bundled = files.filter(file => /(?:^|\/)runtime\/wlatex(?:\/|$)/i.test(file) ||
        /(?:^|\/)\.wlatex(?:\/|$)/i.test(file) ||
        /(?:^|\/)wlatex-(?:engine|lab|native-lab)(?:\.exe)?$/i.test(file));
    assert.deepEqual(bundled, [], 'WLaTeX engines and generated caches must not ship in WPaper');
    return { result:'PASS', files:files.length, required_integration_assets:required.length,
        bundled_wlatex_runtime:false };
}
if (require.main === module) {
    try {
        assert.ok(process.argv[2], 'Supply the file list produced by vsce ls');
        console.log(JSON.stringify(verifyNativePackage(fs.readFileSync(process.argv[2],'utf8')),null,2));
    } catch (error) { console.error(error.message); process.exitCode=1; }
}
module.exports = { verifyNativePackage, required };
