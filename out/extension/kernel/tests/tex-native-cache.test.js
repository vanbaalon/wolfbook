const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { NativeArtifactCache } = require('../../tex/nativeArtifactCache');

test('artifact cache rejects foreign paths and symlinked resources', () => {
    const parent=fs.mkdtempSync(path.join(os.tmpdir(),'native-cache-'));
    const cache=new NativeArtifactCache(parent);
    try {
        assert.throws(()=>cache.lease({ source_directory:parent }),/outside/);
        assert.throws(()=>cache.lease({ source_directory:cache.directory }),/outside/);
        if (process.platform!=='win32') {
            fs.symlinkSync(parent,path.join(cache.directory,'link'));
            assert.throws(()=>cache.lease({ log:path.join(cache.directory,'link','outside.log') }),/symlink/);
        }
    } finally { cache.close(); fs.rmSync(parent,{ recursive:true,force:true }); }
});

test('live generations, shared source paths, active builds and viewer handles protect artifacts', () => {
    // Force GC only in this isolated child; normal extension execution never forces it.
    const script=`
        const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
        const { NativeArtifactCache }=require(${JSON.stringify(require.resolve('../../tex/nativeArtifactCache'))});
        const { PdfRangeStore }=require(${JSON.stringify(require.resolve('../../tex/pdfRanges'))});
        (async()=>{
            const parent=fs.mkdtempSync(path.join(os.tmpdir(),'native-cache-gc-'));
            const unrelated=path.join(parent,'unrelated'); fs.mkdirSync(unrelated);
            const cache=new NativeArtifactCache(parent), store=new PdfRangeStore();
            const shared=path.join(cache.directory,'sources'); fs.mkdirSync(shared);
            const pdf=path.join(cache.directory,'paper.pdf'); fs.writeFileSync(pdf,'PDF bytes');
            const owners={ first:cache.lease({ source_directory:shared,pdf }),second:cache.lease({ source_directory:shared,log:pdf }) };
            const resource=store.open(pdf,owners.second);
            const gc=async()=>{ await new Promise(r=>setImmediate(r)); global.gc(); await new Promise(r=>setImmediate(r)); cache.collect(); };
            try {
                delete owners.first; await gc(); await gc();
                assert.ok(fs.existsSync(shared),'other generation retains shared sources');
                delete owners.second; await gc(); await gc();
                assert.ok(fs.existsSync(pdf),'open viewer handle retains the artifact lease');
                cache.begin(); store.release(resource.token);
                await gc(); await gc();
                assert.ok(fs.existsSync(pdf),'active producer blocks collection');
                cache.end();
                for(let i=0;i<30 && fs.existsSync(pdf);i++) await gc();
                assert.ok(!fs.existsSync(pdf)); assert.ok(!fs.existsSync(shared));
                cache.close(); assert.ok(!fs.existsSync(cache.directory));
                assert.ok(fs.existsSync(unrelated),'never remove foreign cache directories');
            } finally { store.close(); cache.close(); fs.rmSync(parent,{recursive:true,force:true}); }
        })().catch(e=>{console.error(e);process.exitCode=1});
    `;
    execFileSync(process.execPath,['--expose-gc','-e',script],{ timeout:10000 });
});
