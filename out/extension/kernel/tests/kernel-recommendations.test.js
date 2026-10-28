'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const {KernelManager}=require('../manager');
const {AgentSessions}=require('../../claude-mcp/agent-sessions');
const {canonicalPath,kernelAllowed,kernelRecommended}=require('../agentScope');
const stub=require('./_stub-vscode').makeVscodeStub();
const load=Module._load;
Module._load=function(name){return name==='vscode' ? stub : load.apply(this,arguments);};
const {WolframMCPServer}=require('../../claude-mcp/server');
const {KernelManagerTool}=require('../../tools/index');
Module._load=load;
function controller(){const c={busy:false,kernelStatusString:'resolved',_controller:{label:'',selectedNotebooks:new Set(),updateNotebookAffinity(){}},
    launchKernel:async()=>{},quitKernel:async()=>{},dispose(){}};
    c.arbiter={status:()=>({busy:c.busy,lifecycle:c.busy?'busy':'idle'})};return c;}
function folders(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'wb-recommendations-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
    const a=path.join(base,'repo-a'),b=path.join(base,'repo-b');fs.mkdirSync(a);fs.mkdirSync(b);return {a:canonicalPath(a),b:canonicalPath(b)};}
function clients(a,b){return [
    {clientId:'two',workspaceRoots:[b],notebooks:[path.join(b,'other.wb')],kernels:[{kernel_id:'other',kernel_slot:'s2',owner_folder:b,owner_scope_id:'old-session',sharing:'private',notebooks:[path.join(b,'other.wb')]}]},
    {clientId:'one',workspaceRoots:[a],notebooks:[path.join(a,'mine.wb')],kernels:[{kernel_id:'global',sharing:'shared',notebooks:[]},
        {kernel_id:'mine',kernel_slot:'s1',owner_folder:a,owner_scope_id:'earlier-session',sharing:'private',notebooks:[path.join(a,'mine.wb')]}]}];}

test('inventory recommends repository kernels without hiding other private kernels',t=>{
    const {a,b}=folders(t),list=clients(a,b),sessions=new AgentSessions();
    const {scope}=sessions.declare({working_directory:a},'new',list);
    assert.equal(scope.policy,'repository-recommendation');
    const inventory=sessions.inventory(list,'new');assert.equal(inventory.length,2);
    assert.equal(inventory[0].clientId,'one');assert.equal(inventory[0].kernels[0].kernel_id,'mine');
    assert.equal(inventory[0].kernels[0].recommended,true);assert.equal(inventory[1].kernels[0].recommended,false);
    assert.equal(kernelAllowed(scope,list[0].kernels[0]),true);assert.equal(kernelRecommended(scope,list[0].kernels[0]),false);
    assert.equal(kernelAllowed(scope,{owner_unavailable:true}),false);
    assert.equal(list[0].clientId,'two');assert.equal(list[1].kernels[0].kernel_id,'global','inventory never mutates source');
    assert.equal(sessions.declare({working_directory:a,client_id:'two',sharing:'shared'},'explicit',list).scope.client_id,'two');
    assert.equal(sessions.declare({working_directory:b},'single',[list[1]]).scope.client_id,'one','unmatched repository does not exclude sole window');
});

test('explicit cross-window notebook/kernel choices never inherit a stale target',t=>{
    const {a,b}=folders(t),list=clients(a,b),sessions=new AgentSessions();sessions.declare({working_directory:a},'s',list);
    const target={clientId:'one',notebook:path.join(a,'mine.wb'),kernelId:'mine'};
    for(const args of [{client_id:'two'},{kernel_id:'other'},{notebook:path.join(b,'other.wb')}]){
        const routed=sessions.route('wolfbook_evaluateExpression',args,'s',target,list);
        assert.equal(routed.client_id,'two');assert.notEqual(routed.notebook,target.notebook);assert.notEqual(routed.kernel_id,target.kernelId);
    }
    const created=sessions.route('wolfbook_newNotebook',{path:path.join(b,'new.wb'),kernel_id:'other'},'s',target,list);
    assert.equal(created.client_id,'two');assert.equal(created.path,path.join(b,'new.wb'));assert.equal(created.notebook,undefined);
    const nbRoute=sessions.route('wolfbook_runCell',{notebook:'mine.wb'},'s',target,list);assert.equal(nbRoute.notebook,target.notebook);
    sessions.saveTarget('s',{clientId:'two',notebook:path.join(b,'other.wb'),kernelId:'other',kernelSlot:'s2'});
    const token=sessions.get('s').resume_token;sessions.release('s');
    const resumed=sessions.declare({resume_token:token},'reconnected',list);assert.equal(resumed.target.clientId,'two');assert.equal(resumed.target.kernelId,'other');
});

test('two sessions can deliberately target the same notebook without force or ownership recovery',t=>{
    const {a,b}=folders(t),list=clients(a,b),server=new WolframMCPServer(new Map(),[]);
    server._ownClientId='one';server._buildClientList=()=>list;server._pruneWorkers=()=>{};
    server._workers.set('two',{port:27190});server._notifyNotebookTarget=()=>{};
    server._agentScopes.declare({working_directory:a},'a',list);server._agentScopes.declare({working_directory:b},'b',list);
    const args={notebook:path.join(a,'mine.wb'),kernel_id:'mine'};
    const first=server._handleSetTarget(args,'a'),second=server._handleSetTarget(args,'b');
    assert.equal(first.isError,false);assert.equal(second.isError,false);assert.equal(server._sessionTargets.size,2);
    assert.equal(second.structuredContent.target.clientId,'one');assert.equal(second.structuredContent.data.recommended,false);
    assert.equal(second.structuredContent.data.attached_sessions,2);assert.equal(server._sessionTargets.get('a').kernelId,'mine');
    const other=server._handleSetTarget({kernel_id:'other'},'a');assert.equal(other.isError,false);assert.equal(other.structuredContent.target.clientId,'two');
    assert.equal(server._handleSetTarget({...args,kernel_id:'other'},'b').isError,true,'exact binding assertion is still enforced');
});

test('counts above recommendation survive reload while busy moves and wrong binding remain errors',async t=>{
    const {a,b}=folders(t),saved={};const context={workspaceState:{get:(k,d)=>saved[k]??d,update:async(k,v)=>{saved[k]=v;}}};
    const manager=new KernelManager(context,{maximum:1,factory:async()=>controller()});const base=manager.addDefault(controller());
    const entries=await Promise.all([manager.create(),manager.create(),manager.create()]);
    for(let i=0;i<entries.length;i++)await manager.bind(path.join(b,`${i}.wb`),entries[i].id);
    assert.equal(manager.capacity().local_kernels,4);assert.equal(manager.capacity().hard_limit,null);assert.equal(manager._allocating,0);
    const scope={directory:a,scope_id:'new-session'};const notebook=path.join(b,'0.wb');
    assert.equal(manager.resolve({notebook,_agentScope:scope}),entries[0]);
    assert.throws(()=>manager.assertToolScope('wolfbook_runCell',{notebook,kernel_id:base.id,_agentScope:scope}),e=>e.code==='KERNEL_TARGET_CHANGED');
    entries[0].controller.busy=true;await assert.rejects(manager.bind(notebook,entries[1].id),/busy/);
    assert.equal(manager.bindingFor(notebook),entries[0]);await manager.bind(notebook,entries[0].id); // same binding is harmless
    const reloaded=new KernelManager(context,{maximum:1,factory:async()=>controller()});reloaded.addDefault(controller());
    const restored=await reloaded.restore();assert.equal(restored.length,3);assert.equal(reloaded.capacity().local_kernels,4);
    assert.equal(reloaded.explicitBindingFor(notebook).slotKey,entries[0].slotKey);
});

test('tool creation exceeds advisory count but still requires acknowledgement for a new process',async()=>{
    const manager=new KernelManager(null,{maximum:1,factory:async()=>controller()});manager.addDefault(controller());
    const resolver=()=>manager.defaultEntry.controller;resolver.manager=manager;const tool=new KernelManagerTool(resolver);
    await assert.rejects(tool.invoke({input:{action:'create'}}),/acknowledge_resource_cost/);
    assert.equal(manager.size,1);
    const result=await tool.invoke({input:{action:'create',acknowledge_resource_cost:true}});
    const data=JSON.parse(result.content[0].value);assert.equal(manager.size,2);assert.equal(data.capacity.above_recommended,true);assert.equal(data.capacity.hard_limit,null);
});


test('an explicit kernel never inherits a notebook that was rebound since setTarget',t=>{
    const {a,b}=folders(t),list=clients(a,b),sessions=new AgentSessions();
    sessions.declare({working_directory:a},'s',list);
    const target={clientId:'one',notebook:path.join(a,'mine.wb'),kernelId:'mine'};
    // The user has moved mine.wb elsewhere, but the session receipt is old.
    const result=sessions.route('wolfbook_evaluateExpression',{client_id:'one',kernel_id:'mine'},'s',target,list);
    assert.equal(result.kernel_id,'mine');
    assert.equal(result.notebook,undefined,'explicit kernel means its process, not a stale notebook assertion');
    const implicit=sessions.route('wolfbook_evaluateExpression',{},'s',target,list);
    assert.equal(implicit.notebook,target.notebook,'implicit target still asserts its notebook binding');
});
