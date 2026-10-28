'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {KernelManager}=require('../manager');
const controller=()=>({selectedNotebooks:new Set(),launchKernel:async()=>{},quitKernel:async()=>{},dispose(){},
    arbiter:{status:()=>({busy:false,lifecycle:'idle'})},_controller:{updateNotebookAffinity(){}}});

test('workspace defaults apply to new notebooks while explicit assignments and unavailable slots are preserved',async()=>{
    const manager=new KernelManager(null,{factory:async()=>controller()});
    const first=manager.addDefault(controller()),second=await manager.create();
    await manager.bind('/tmp/assigned.wb',first.id);
    manager.setNewNotebookDefaultSlot(second.slotKey);
    assert.equal(manager.bindingFor('/tmp/new.wb'),second);
    assert.equal(manager.bindingFor('/tmp/assigned.wb'),first);
    assert.equal(manager.resolve({notebook:'/tmp/new.wb'}),second);
    assert.equal(manager.describe(second).is_new_notebook_default,true);
    assert.equal(manager.acceptSelection('/tmp/new.wb',first.id),false,'automatic K1 cannot steal the preferred slot');
    assert.equal(manager.acceptSelection('/tmp/new.wb',first.id,{fromKernelId:second.id}),true,'an explicit picker choice can override it');
    manager._entries.delete(second.id);
    assert.equal(manager.bindingFor('/tmp/new.wb'),null);
    assert.throws(()=>manager.resolve({notebook:'/tmp/new.wb'}),e=>e.code==='KERNEL_BINDING_UNAVAILABLE');
    assert.equal(manager.bindingFor('/tmp/assigned.wb'),first);
    manager.setNewNotebookDefaultSlot('');assert.equal(manager.bindingFor('/tmp/new.wb'),first);
});
test('a durable preferred slot survives controller recreation and kernel rename, scoped to its workspace',async()=>{
    const storage={};const context={workspaceState:{get:(k,d)=>storage[k]??d,update:async(k,v)=>{storage[k]=v;}}};
    const a=new KernelManager(context,{factory:async()=>controller()});a.addDefault(controller());
    const selected=await a.create({label:'Repo work'});const slot=selected.slotKey;
    a.setNewNotebookDefaultSlot(slot);a.rename(selected.id,'Renamed');
    const b=new KernelManager(context,{newNotebookDefaultSlot:slot,factory:async()=>controller()});b.addDefault(controller());
    assert.equal(b.bindingFor('/tmp/next.wb'),null,'a restoring slot must not fall back');
    await b.restore();
    assert.notEqual(b.newNotebookDefaultEntry.id,selected.id);
    assert.equal(b.newNotebookDefaultEntry.slotKey,slot);assert.equal(b.newNotebookDefaultEntry.label,'Renamed');
    assert.equal(b.bindingFor('/tmp/next.wb'),b.newNotebookDefaultEntry);
    const other=new KernelManager(null);const own=other.addDefault(controller());
    assert.equal(other.bindingFor('/tmp/next.wb'),own);assert.equal(other.newNotebookDefaultSlot,'');
});
