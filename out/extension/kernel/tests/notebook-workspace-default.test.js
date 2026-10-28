'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {makeVscodeStub,withVscodeStub}=require('./_stub-vscode');
const {KernelManager,canonicalNotebook}=require('../manager');
const stub=makeVscodeStub();stub.window.visibleNotebookEditors=[];stub.workspace.notebookDocuments=[];
const {NewNotebookTool}=withVscodeStub(()=>require('../../tools/index'),stub);
function fixture(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wolfbook-default-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    let created=0;
    const controller=()=>({selectedNotebooks:new Set(),kernelStatusString:'resolved',
        _controller:{updateNotebookAffinity(){}},arbiter:{status:()=>({busy:false,lifecycle:'idle'})},
        launchKernel:async()=>{},quitKernel:async()=>{},dispose(){}});
    const manager=new KernelManager(null,{factory:async()=>{created++;return controller();}});
    const shared=manager.addDefault(controller());manager.setNewNotebookDefaultSlot('default');
    stub.workspace.openNotebookDocument=async uri=>{
        const data=JSON.parse(fs.readFileSync(uri.fsPath,'utf8'));
        const doc={uri,notebookType:'extended-wolfram-notebook',metadata:data.metadata,cellCount:data.cells.length,
            cellAt:index=>data.cells[index]};
        return doc;
    };
    const resolver=()=>shared.controller;resolver.manager=manager;const tool=new NewNotebookTool(resolver);
    const invoke=input=>tool.invoke({input:{path:path.join(dir,'new.wb'),...input}});
    const receipt=result=>JSON.parse(result.content.at(-1).value);
    return {dir,manager,shared,invoke,receipt,created:()=>created};
}
test('agent-created notebooks inherit the configured workspace kernel without allocating a private process',async t=>{
    const f=fixture(t);const result=await f.invoke({_agentScope:{directory:f.dir,scope_id:'test-agent'}});
    const receipt=f.receipt(result);assert.equal(receipt.ok,true);assert.equal(receipt.kernel_id,f.shared.id);
    assert.equal(f.created(),0);assert.equal(receipt.is_new_notebook_default,true);
    assert.equal(f.manager.explicitBindingFor(path.join(f.dir,'new.wb')),f.shared);
});
test('a workspace default can select a dedicated existing kernel and explicit kernel IDs override it',async t=>{
    const f=fixture(t),preferred=await f.manager.create({label:'Preferred'});
    f.manager.setNewNotebookDefaultSlot(preferred.slotKey);
    assert.equal(f.receipt(await f.invoke({})).kernel_id,preferred.id);
    assert.equal(f.receipt(await f.invoke({path:path.join(f.dir,'explicit.wb'),kernel_id:f.shared.id})).kernel_id,f.shared.id);
    assert.equal(f.created(),1,'both notebook creations reuse available processes');
});
test('an existing explicit notebook binding is preserved when the workspace default changes',async t=>{
    const f=fixture(t);await f.invoke({});
    const preferred=await f.manager.create();f.manager.setNewNotebookDefaultSlot(preferred.slotKey);
    const file=path.join(f.dir,'new.wb'),before=fs.readFileSync(file);
    assert.equal(f.receipt(await f.invoke({})).kernel_id,f.shared.id);
    assert.deepEqual(fs.readFileSync(file),before,'reopening preserves the saved notebook');
});
test('explicit kernel isolation still allocates a separate process when its cost is acknowledged',async t=>{
    const f=fixture(t);const receipt=f.receipt(await f.invoke({isolation:'kernel',acknowledge_resource_cost:true}));
    assert.equal(receipt.ok,true);assert.notEqual(receipt.kernel_id,f.shared.id);assert.equal(f.created(),1);
});
test('an unavailable preferred or explicitly assigned slot never silently falls back or writes a notebook',async t=>{
    for(const explicit of [false,true]){
        const f=fixture(t);const file=path.join(f.dir,'new.wb');
        if(explicit)f.manager._bindings.set(canonicalNotebook(file),'slot-missing');
        else f.manager.setNewNotebookDefaultSlot('slot-missing');
        await assert.rejects(f.invoke({}),/unavailable/);assert.equal(fs.existsSync(file),false);
        assert.equal(f.created(),0);
        const receipt=f.receipt(await f.invoke({kernel_id:f.shared.id}));assert.equal(receipt.ok,true);
    }
});
