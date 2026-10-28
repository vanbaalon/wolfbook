'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {shutdownWindow}=require('../window-shutdown');

test('window shutdown awaits every local kernel and LSP, excludes remote owners',async()=>{
    const started=[],release=[];
    const controller=name=>({quitKernel:()=>{started.push(name);return new Promise(resolve=>release.push(resolve));}});
    const main=controller('default'),isolated=controller('isolated'),remote=controller('remote');
    let lost=0,settled=false;
    const manager={_entries:new Map([['main',{controller:main,operations:{markLost:()=>lost++}}],
        ['isolated',{controller:isolated}],['remote',{controller:remote,remote:true,operations:{markLost:()=>assert.fail('remote journal')}}]])};
    const done=shutdownWindow(manager,main,{stop:()=>{started.push('lsp');}}).then(()=>{settled=true;});
    await Promise.resolve();
    assert.deepEqual(started,['default','isolated','lsp']);
    assert.equal(settled,false);assert.equal(lost,1);
    assert.equal(main._windowClosing,true);assert.equal(isolated._windowClosing,true);assert.equal(remote._windowClosing,undefined);
    release.forEach(f=>f());await done;assert.equal(settled,true);
});

test('shutdown waits for a pending launch and closes again without starting a replacement',async()=>{
    let finish,calls=0;
    const controller={_launchPromise:new Promise(resolve=>finish=resolve),quitKernel:async()=>{calls++;}};
    const done=shutdownWindow(null,controller,null);
    await Promise.resolve();assert.equal(calls,1);
    finish();await done;assert.equal(calls,2);
    const {ensureKernelReady}=require('../ensure-ready');
    controller.kernelStatusString='resolved';
    await assert.rejects(ensureKernelReady(controller),/window is closing/);
});

test('deactivate returns the asynchronous owned-window shutdown',async()=>{
    const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
    const source=fs.readFileSync(path.join(__dirname,'../../extension.js'),'utf8');
    const start=source.indexOf('async function deactivate()'),end=source.indexOf('exports.deactivate = deactivate;',start);
    let release,done=false;
    const manager={},controller={},client={};
    const scope={_windowClosing:false,_activeKernelManager:manager,_activeController:controller,client,_activeLspLifecycle:null,
        require:name=>name==='./kernel/window-shutdown'?{shutdownWindow:(m,c,l)=>{
            assert.equal(m,manager);assert.equal(c,controller);assert.equal(l,client);
            return new Promise(resolve=>release=resolve);
        }}:{dispose(){}}};
    vm.runInNewContext(source.slice(start,end),scope);
    const work=scope.deactivate().then(()=>done=true);
    assert.equal(scope._windowClosing,true);assert.equal(done,false);
    release();await work;assert.equal(done,true);
});
