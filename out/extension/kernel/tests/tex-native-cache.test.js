const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { NativeArtifactCache } = require('../../tex/nativeArtifactCache');

test('artifact cache rejects foreign paths and symlinked resources', async () => {
    const parent=fs.mkdtempSync(path.join(os.tmpdir(),'native-cache-'));
    const cache=new NativeArtifactCache(parent);
    await cache.begin();
    try {
        assert.throws(()=>cache.lease({ source_directory:parent }),/outside/);
        assert.throws(()=>cache.lease({ source_directory:cache.directory }),/outside/);
        if (process.platform!=='win32') {
            fs.symlinkSync(parent,path.join(cache.directory,'link'));
            assert.throws(()=>cache.lease({ log:path.join(cache.directory,'link','outside.log') }),/symlink/);
        }
    } finally { await cache.end(); await cache.close(); fs.rmSync(parent,{ recursive:true,force:true }); }
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
            await cache.begin();
            const owners={ first:cache.lease({ source_directory:shared,pdf }),second:cache.lease({ source_directory:shared,log:pdf }) };
            const resource=store.open(pdf,owners.second);
            await cache.end();
            const gc=async()=>{ await new Promise(r=>setImmediate(r)); global.gc(); await new Promise(r=>setImmediate(r)); await cache.collect(); };
            try {
                delete owners.first; await gc(); await gc();
                assert.ok(fs.existsSync(shared),'other generation retains shared sources');
                delete owners.second; await gc(); await gc();
                assert.ok(fs.existsSync(pdf),'open viewer handle retains the artifact lease');
                await cache.begin(); store.release(resource.token);
                await gc(); await gc();
                assert.ok(fs.existsSync(pdf),'active producer blocks collection');
                await cache.end();
                for(let i=0;i<30 && fs.existsSync(pdf);i++) await gc();
                assert.ok(!fs.existsSync(pdf)); assert.ok(!fs.existsSync(shared));
                await cache.close(); assert.ok(!fs.existsSync(cache.directory));
                assert.ok(fs.existsSync(unrelated),'never remove foreign cache directories');
            } finally { store.close(); await cache.close(); fs.rmSync(parent,{recursive:true,force:true}); }
        })().catch(e=>{console.error(e);process.exitCode=1});
    `;
    execFileSync(process.execPath,['--expose-gc','-e',script],{ timeout:10000 });
});

test('a build waits for asynchronous deletion and cannot register a lease outside its reservation', async () => {
    const parent=fs.mkdtempSync(path.join(os.tmpdir(),'native-cache-lock-'));
    const cache=new NativeArtifactCache(parent), file=path.join(cache.directory,'old.log');
    fs.writeFileSync(file,'old');
    cache.entries.set(1,{ reference:{ deref:()=>undefined },paths:[file] });
    const rm=fs.promises.rm; let release, started;
    const deleting=new Promise(resolve=>{ started=resolve; });
    fs.promises.rm=async (target,options)=>{
        if (target===file) { started(); await new Promise(resolve=>{ release=resolve; }); }
        return rm(target,options);
    };
    let collection, build;
    try {
        assert.throws(()=>cache.lease({ log:file }),/active build/);
        collection=cache.collect(); await deleting;
        let entered=false;
        build=cache.begin().then(()=>{ entered=true; });
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(entered,false,'event loop runs while cleanup holds the build boundary');
        release(); await collection; await build;
        assert.equal(entered,true);
        assert.equal(fs.existsSync(file),false);
    } finally {
        release?.(); await collection; await build;
        fs.promises.rm=rm;
        if (cache.busy) await cache.end();
        await cache.close(); fs.rmSync(parent,{recursive:true,force:true});
    }
});
