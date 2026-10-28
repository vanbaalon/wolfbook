'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {texEnvironment,probeExecutable,toolchainIssue,compile}=require('../../tex/compileService');

test('MacTeX discovery preserves explicit PATH precedence and never mutates the extension host environment',()=>{
    const base={PATH:'/chosen/tex/bin:/usr/bin',OTHER:'kept'};
    const result=texEnvironment(base,'darwin');
    assert.ok(result.PATH.startsWith(base.PATH+':'));
    if(fs.existsSync('/Library/TeX/texbin'))assert.ok(result.PATH.split(':').includes('/Library/TeX/texbin'));
    assert.equal(result.OTHER,'kept');assert.deepEqual(base,{PATH:'/chosen/tex/bin:/usr/bin',OTHER:'kept'});
    assert.deepEqual(texEnvironment(base,'linux'),base);
    assert.deepEqual(texEnvironment({Path:'C:\\Chosen'},'win32'),{Path:'C:\\Chosen'});
});
test('a failed executable probe is retried after the tool is repaired, without a window restart',{skip:process.platform==='win32'},async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wpaper-probe-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const exe=path.join(dir,'repaired-tool');fs.writeFileSync(exe,'#!/bin/sh\nexit 1\n',{mode:0o755});
    assert.equal((await probeExecutable(exe)).ok,false);
    fs.writeFileSync(exe,'#!/bin/sh\necho repaired\nexit 0\n');
    assert.equal((await probeExecutable(exe)).ok,true);
});
test('timeouts and version-check errors are distinguished from an executable missing from PATH',()=>{
    const missing=toolchainIssue('latexmk',{code:'ENOENT'},{platform:'darwin'});
    assert.equal(missing.kind,'missing-latexmk');
    for(const probe of [{code:'ETIMEDOUT'},{code:1,output:'perl could not load a required module'},{code:'EACCES'}]){
        const failed=toolchainIssue('latexmk',probe,{platform:'darwin'});
        assert.equal(failed.kind,'tex-tool-check-failed');assert.ok(!failed.summary.includes('not found on PATH'));
        assert.ok(failed.summary.includes('Press Compile to retry'));
        if(probe.output)assert.ok(failed.summary.includes(probe.output));
    }
});
test('preflight failure carries the requested source identity and a visible root-level diagnostic',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wpaper-preflight-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const root=path.join(dir,'paper.tex');fs.writeFileSync(root,'\\documentclass{article}');
    const result=await compile({root,outDir:path.join(dir,'build'),engine:'wpaper-nonexistent-tex-engine',sourceSnapshotHash:'requested-source'});
    assert.equal(result.ok,false);assert.equal(result.sourceSnapshotHash,'requested-source');
    assert.equal(result.errors,1);assert.equal(result.diagnostics.length,1);
    assert.equal(result.diagnostics[0].severity,'error');assert.equal(result.diagnostics[0].file,root);
    assert.equal(result.diagnostics[0].message,result.stopReason);
});
test('a real MacTeX compile succeeds with a Dock-style PATH, including its engine subprocess',{skip:process.platform!=='darwin' || !fs.existsSync('/Library/TeX/texbin/latexmk')},async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wpaper-dock-path-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const root=path.join(dir,'paper.tex'),text='\\documentclass{article}\\begin{document}Visible output.\\end{document}\n';
    fs.writeFileSync(root,text);
    const service=require.resolve('../../tex/compileService');
    const code=`const s=require(${JSON.stringify(service)});s.compile({root:${JSON.stringify(root)},outDir:${JSON.stringify(path.join(dir,'build'))},engine:'pdflatex',timeoutMs:30000}).then(g=>{console.log(JSON.stringify({ok:g.ok,errors:g.errors,pages:g.pageCount,pdf:g.pdfPath,reason:g.stopReason}));process.exitCode=g.ok?0:1;});`;
    const {stdout}=await promisify(execFile)(process.execPath,['-e',code],{env:{...process.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},timeout:40000});
    const result=JSON.parse(stdout.trim());assert.equal(result.ok,true);assert.equal(result.pages,1);assert.equal(result.errors,0);
    assert.ok(fs.readFileSync(result.pdf).subarray(0,5).equals(Buffer.from('%PDF-')));
    assert.equal(fs.readFileSync(root,'utf8'),text,'the project source is untouched');
});
