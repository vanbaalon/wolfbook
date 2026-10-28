'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const h=require('./_stub-controller').makeControllerHarness();
const {syncBindingAffinities}=require('../affinity');

test('restoring an unavailable binding clears old offline styling without restarting or rerunning',()=>{
    const notebook=h.notebook('/tmp/recovered.wb'), editor=h.editor(notebook);
    let owner=null;
    const live=h.kernel({owns:nb=>nb===notebook && owner===live});
    const foreign=h.kernel({owns:()=>false});
    live.kernelStatusString='resolved'; foreign.kernelStatusString='error';
    h.stub.window.visibleNotebookEditors=[editor]; h.stub.workspace.notebookDocuments=[notebook];
    const manager={_entries:new Map([['live',{id:'live',controller:live}],['foreign',{id:'foreign',controller:foreign}]]),
        bindingFor:()=>owner ? {id:'live',controller:owner} : null};
    h.reset(); syncBindingAffinities(h.vscode,manager);
    assert.equal(h.calls.posts.length,0,'an unavailable binding must not select an arbitrary owner');
    owner=live; syncBindingAffinities(h.vscode,manager);
    const state=h.calls.posts.filter(p=>/^kernel-/.test(p.message.type));
    assert.deepEqual(state.map(p=>p.message.type),['kernel-online']);
    assert.equal(state[0].editor,editor);
    assert.equal(live.launches,0); assert.equal(foreign.launches,0);
    live.dispose();foreign.dispose();
});

test('returning to an already running notebook replays online state; unrelated offline proxies cannot gray it',()=>{
    const notebook=h.notebook('/tmp/visible.wb'), editor=h.editor(notebook);
    const live=h.kernel({owns:nb=>nb===notebook}),foreign=h.kernel({owns:()=>false});
    live.kernelStatusString='resolved';foreign.kernelStatusString='error';
    h.stub.window.visibleNotebookEditors=[editor];h.reset();
    h.fire('window.onDidChangeVisibleNotebookEditors');
    const state=h.calls.posts.filter(p=>/^kernel-/.test(p.message.type));
    assert.deepEqual(state.map(p=>p.message.type),['kernel-online']);
    assert.equal(state[0].editor,editor);
    live.dispose();foreign.dispose();
});

test('controller reselection resets its current renderer state without touching another notebook',()=>{
    const a=h.notebook('/tmp/selected.wb'),b=h.notebook('/tmp/other.wb');
    const edA=h.editor(a),edB=h.editor(b);
    const live=h.kernel({owns:nb=>nb===a});live.kernelStatusString='resolved';
    h.stub.window.visibleNotebookEditors=[edA,edB];h.reset();
    h.fire('controller.onDidChangeSelectedNotebooks',{notebook:a,selected:true});
    assert.ok(h.calls.posts.some(p=>p.message.type==='kernel-online' && p.editor===edA));
    assert.ok(h.calls.posts.every(p=>p.editor===edA));live.dispose();
});

test('a new offline owner is shown offline; hidden and disposed controllers send nothing',()=>{
    const notebook=h.notebook('/tmp/offline.wb'),editor=h.editor(notebook);
    const offline=h.kernel({owns:nb=>nb===notebook});offline.kernelStatusString='error';
    h.stub.window.visibleNotebookEditors=[editor];h.reset();
    assert.equal(offline._syncKernelRendererState(),1);
    assert.deepEqual(h.calls.posts.map(p=>p.message.type),['kernel-offline']);
    h.stub.window.visibleNotebookEditors=[];h.reset();
    assert.equal(offline._syncKernelRendererState(),0);assert.equal(h.calls.posts.length,0);
    offline.dispose();h.stub.window.visibleNotebookEditors=[editor];h.reset();
    assert.equal(offline._syncKernelRendererState(),0);assert.equal(h.calls.posts.length,0);
});

test('several loaded notebooks sharing a kernel trigger one refresh per binding synchronization',()=>{
    const a=h.notebook('/tmp/shared-a.wb'),b=h.notebook('/tmp/shared-b.wb');
    const live=h.kernel({owns:()=>true});live.kernelStatusString='resolved';
    h.stub.window.visibleNotebookEditors=[h.editor(a),h.editor(b)];h.stub.workspace.notebookDocuments=[a,b];h.reset();
    const entry={id:'one',controller:live};
    syncBindingAffinities(h.vscode,{_entries:new Map([['one',entry]]),bindingFor:()=>entry});
    assert.equal(h.calls.posts.filter(p=>p.message.type==='kernel-online').length,2,'one targeted post per visible notebook');
    live.dispose();
});
