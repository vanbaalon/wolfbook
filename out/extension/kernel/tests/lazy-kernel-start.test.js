'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {KernelManager}=require('../manager');
const source=fs.readFileSync(path.join(__dirname,'../../extension.js'),'utf8');

test('reload restores all saved identities and bindings without launching any processes',async()=>{
    const saved={}; let launches=0;
    const context={workspaceState:{get:(k,d)=>saved[k]??d,update:async(k,v)=>{saved[k]=v;}}};
    const controller=()=>({kernelStatusString:'unresolved',_controller:{},
        launchKernel:async()=>{launches++;},quitKernel:async()=>{},dispose(){}});
    const manager=new KernelManager(context,{factory:async()=>controller()});
    manager.addDefault(controller());
    for(let i=0;i<5;i++) {
        const entry=await manager.create({launch:false,label:`Private ${i}`});
        await manager.bind(`/tmp/lazy-${i}.wb`,entry.id);
    }
    const reloaded=new KernelManager(context,{factory:async()=>controller()});
    reloaded.addDefault(controller());
    const entries=await reloaded.restore();
    assert.equal(entries.length,5);assert.equal(launches,0);
    for(let i=0;i<5;i++)assert.equal(reloaded.bindingFor(`/tmp/lazy-${i}.wb`).label,`Private ${i}`);
    assert.equal((await reloaded.restore()).length,0,'repeated restore is idempotent');
    await reloaded.resolveController({notebook:'/tmp/lazy-3.wb'}).launchKernel();
    assert.equal(launches,1,'only the requested slot starts');
});

test('activation registers readiness without eagerly launching the default kernel',()=>{
    let launches=0,refreshes=0,lsp=0;
    const controller={launchKernel:()=>{launches++;return Promise.resolve();}};
    const start=source.indexOf('    controller._onKernelReady =');
    const end=source.indexOf('    // Late-bind the Oberon',start);
    vm.runInNewContext(source.slice(start,end),{controller,nbKernelenabled:true,kernelAvailable:true,
        _startLanguageServer:()=>lsp++,_debugCtrl:{refreshLiveWatch:()=>refreshes++},_refreshKernelIdentity(){}});
    assert.equal(launches,0);assert.equal(lsp,0);
    controller._onKernelReady();assert.equal(lsp,1);assert.equal(refreshes,1);
});

test('LSP setup is dormant until first requested launch and coalesces simultaneous ready callbacks',async()=>{
    let starts=0,timers=0,notifications=0;
    const start=source.indexOf('    const lspLifecycle =');
    const end=source.indexOf('    // Register the .wslide',start);
    const scope={_startLanguageServer:null,_activeLspLifecycle:null,_windowClosing:false,context:{subscriptions:[]},
        kernelManager:{_entries:new Map()},config:{get:()=>true},lspcommand:['kernel'],
        require:()=>({createLspLifecycle:(client,options)=>require('../../syntax/lsp-lifecycle').createLspLifecycle(client,{...options,setTimer:()=>{timers++;return 1;},clearTimer(){}})}),
        client:{start:async()=>{starts++;},onNotification:()=>{notifications++;},outputChannel:{appendLine(){}}}};
    vm.runInNewContext(source.slice(start,end),scope);
    assert.equal(starts,0);assert.equal(timers,0);
    await Promise.all([scope._startLanguageServer(),scope._startLanguageServer()]);
    assert.equal(starts,1);assert.equal(timers,1);assert.equal(notifications,1);
    await scope._startLanguageServer();assert.equal(starts,1);
});

test('opening or selecting a visible notebook never launches its dormant controller',async()=>{
    const h=require('./_stub-controller').makeControllerHarness();
    const nb=h.notebook('/tmp/dormant.wb'),k=h.kernel({owns:doc=>doc===nb});
    h.stub.window.visibleNotebookEditors=[h.editor(nb)];
    h.stub.workspace.notebookDocuments=[nb];
    h.fire('workspace.onDidOpenNotebookDocument',nb);
    h.fire('window.onDidChangeVisibleNotebookEditors');
    h.fire('controller.onDidChangeSelectedNotebooks',{notebook:nb,selected:true});
    await h.tick(850);
    assert.equal(k.launches,0);k.dispose();
});

test('concurrent UI and agent startup share one launch and failure permits retry',async()=>{
    const {ensureKernelReady}=require('../ensure-ready');
    const controllerSource=fs.readFileSync(path.join(__dirname,'../../controller.js'),'utf8');
    const begin=controllerSource.indexOf('    launchKernel() {');
    const end=controllerSource.indexOf('\n    }',begin)+6;
    let finish,launches=0;
    const scope={WstpSession:null,_lifecycle:{launchKernel:ctrl=>{
        launches++;ctrl.kernelStatusString='launching';
        return new Promise(resolve=>{finish=()=>{ctrl.kernelStatusString='resolved';resolve();};});
    }}};
    const ctrl=vm.runInNewContext(`({${controllerSource.slice(begin,end)}})`,scope);
    ctrl.kernelStatusString='unresolved';
    const ui=ctrl.launchKernel(),agent=ensureKernelReady(ctrl);
    assert.equal(launches,1);finish();await Promise.all([ui,agent]);
    assert.equal(ctrl._launchPromise,null);
    await ensureKernelReady(ctrl);assert.equal(launches,1,'resolved kernel is reused');
    ctrl.kernelStatusString='unresolved';
    scope._lifecycle.launchKernel=async()=>{throw Error('launch failed');};
    await assert.rejects(ensureKernelReady(ctrl),/launch failed/);
    assert.equal(ctrl._launchPromise,null);
    scope._lifecycle.launchKernel=async c=>{c.kernelStatusString='resolved';};
    assert.equal(await ensureKernelReady(ctrl),true);
});

test('agent cell pipeline starts a dormant target before dispatch and confirms actual output',async()=>{
    const {runCellViaPipeline}=require('../../tools/cell-pipeline');
    const notebook={uri:{fsPath:'/tmp/first-agent-eval.wb'},cellAt:()=>cell};
    const cell={index:0,notebook,document:{uri:{toString:()=> 'cell://first'},getText:()=> '2+2'},outputs:[]};
    let launches=0,dispatches=0;
    const ctrl={kernelStatusString:'unresolved',executionQueue:{queueLength:()=>0},
        launchKernel:async()=>{launches++;ctrl.kernelStatusString='resolved';},
        execute:async()=>{
            assert.equal(ctrl.kernelStatusString,'resolved');dispatches++;
            cell.executionSummary={success:true,timing:{endTime:Date.now()}};
            cell.outputs=[{items:[{mime:'text/plain',data:Buffer.from('4')}]}];
            return {dispatched:[{index:0}],skipped:[]};
        }};
    const result=await runCellViaPipeline(ctrl,{notebook},0,{timeoutMs:500});
    assert.equal(launches,1);assert.equal(dispatches,1);assert.equal(result.dispatched,true);
    assert.equal(result.plain,'4');assert.equal(result.timedOut,false);
});
