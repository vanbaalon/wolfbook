const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyNativePackage, required } = require('../../tex/verifyNativePackage.cjs');
test('package admission requires every host/client asset for the optional native path', () => {
    assert.equal(verifyNativePackage(required.join('\n')).result,'PASS');
    for (const omitted of required)
        assert.throws(()=>verifyNativePackage(required.filter(file=>file!==omitted).join('\n')),/Missing/);
});
test('package admission rejects separate runtimes and caches on every platform', () => {
    for (const path of ['runtime/wlatex/darwin-arm64/runtime.json', 'runtime/wlatex/darwin-x64/wlatex-lab',
        'runtime/wlatex/linux-x64/wlatex-native-lab','runtime\\wlatex\\win32-x64\\runtime.json',
        'prebuilt/wlatex-engine','prebuilt/wlatex-engine.exe','bin/wlatex-lab','bin/wlatex-lab.exe',
        'bin/wlatex-native-lab','bin/wlatex-native-lab.exe','paper/.wlatex/native/paper.pdf'])
        assert.throws(()=>verifyNativePackage([...required,path].join('\n')),/must not ship/);
    assert.equal(verifyNativePackage([...required,'wstp/wstp.node','wllatex-addon/prebuilt/other.node'].join('\r\n')).result,'PASS');
});
