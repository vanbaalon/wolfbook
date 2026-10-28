'use strict';
const assert=require('assert');
const fs=require('fs'),os=require('os'),path=require('path'),Module=require('module');
const {KernelManager,BINDINGS_KEY}=require('../manager');
const {canonicalPath,within,kernelAllowed,kernelRecommended}=require('../agentScope');
const {AgentSessions}=require('../../claude-mcp/agent-sessions');
const stub=require('./_stub-vscode').makeVscodeStub();
const load=Module._load;
Module._load=function(name){return name==='vscode' ? stub : load.apply(this,arguments);};
const {WolframMCPServer}=require('../../claude-mcp/server');
const {NewNotebookTool,KernelManagerTool}=require('../../tools/index');
Module._load=load;
function controller(busy=false){return {_controller:{label:'',selectedNotebooks:new Set(),updateNotebookAffinity(){},onDidChangeSelectedNotebooks(){return {dispose(){}};}},
    kernelStatusString:'resolved',arbiter:{status:()=>({lifecycle:busy?'busy':'idle',busy})},
    launchKernel:async()=>{},quitKernel:async()=>{},dispose(){}};}
(async()=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wb-kernel-scope-'));
    try {
        const folder=canonicalPath(path.join(temp,'project')),other=canonicalPath(path.join(temp,'project-other'));
        fs.mkdirSync(folder);fs.mkdirSync(other);
        const nb=path.join(folder,'agent.wb');
        // Concurrent explicit allocations can exceed the advisory count.
        let factories=0;
        const capacity=new KernelManager(null,{maximum:2,factory:async()=>{factories++;await new Promise(r=>setTimeout(r,5));return controller();}});
        capacity.addDefault(controller());
        const reservations=await Promise.allSettled([capacity.create(),capacity.create()]);
        assert.strictEqual(factories,2);assert.strictEqual(reservations.filter(r=>r.status==='fulfilled').length,2);assert.strictEqual(capacity.size,3);
        assert.strictEqual(capacity._allocating,0);assert.strictEqual(capacity.capacity().above_recommended,true);
        // A busy shared kernel doing unrelated work cannot block a new private binding.
        const manager=new KernelManager(null,{maximum:5,factory:async()=>controller()});
        const shared=manager.addDefault(controller(true));
        const clients=()=>[{clientId:'one',generation:'g1',workspaceRoots:[folder],notebooks:[nb],kernels:manager.list([nb])},
            {clientId:'two',generation:'g2',workspaceRoots:[other],notebooks:[path.join(other,'agent.wb')],kernels:[]}];
        const scopes=new AgentSessions(path.join(temp,'tokens.json'));
        const {scope}=scopes.declare({working_directory:folder},'agent-a',clients());
        const privateKernel=await manager.createAndBind(nb,{owner_folder:folder,owner_scope_id:scope.scope_id,sharing:'private'});
        assert.strictEqual(manager.bindingFor(nb),privateKernel);
        assert.strictEqual(manager.acceptSelection(nb,shared.id),false,'automatic K1 selection cannot overwrite private assignment');
        assert.strictEqual(manager.acceptSelection(nb,privateKernel.id),true);
        await manager.bind(path.join(folder,'shared.wb'),shared.id); // busy same-kernel no-op
        manager.resolve({notebook:nb,kernel_id:privateKernel.id,_agentScope:scope});
        await Promise.all([
            manager.withToolInput({notebook:nb,kernel_id:privateKernel.id,_agentScope:scope},async()=>{
                await new Promise(r=>setTimeout(r,3));
                assert.strictEqual(manager.resolve({}).id,privateKernel.id,'helper calls retain their scoped target');
                assert.strictEqual(manager.toolInput({_kernelOnly:true}).notebook,undefined);
            }),
            manager.withToolInput({kernel_id:shared.id},async()=>{
                await new Promise(r=>setTimeout(r,1));
                assert.strictEqual(manager.resolve({}).id,shared.id,'concurrent calls do not leak targets');
            }),
        ]);
        assert.strictEqual(manager.toolInput({})._agentScope,undefined,'scope leaves no ambient state after completion');
        assert.strictEqual(manager.resolve({kernel_id:shared.id,_agentScope:scope}),shared);
        assert.throws(()=>manager.assertToolScope('wolfbook_runCell',{_agentScope:scope,kernel_id:privateKernel.id}),e=>e.code==='SCOPED_TARGET_REQUIRED');
        await manager.bind(path.join(other,'wrong.wb'),privateKernel.id);
        const scopeB=scopes.declare({working_directory:folder},'agent-b',clients()).scope;
        assert.strictEqual(kernelAllowed(scopeB,manager.describe(privateKernel)),true);
        assert.strictEqual(kernelRecommended(scopeB,manager.describe(privateKernel)),true);
        const folderKernel=await manager.create({owner_folder:folder,sharing:'folder'});
        assert.strictEqual(kernelAllowed(scopeB,manager.describe(folderKernel)),true);
        // Folder boundary checks include symlinks and absent descendants.
        assert.strictEqual(within(folder,other),false);
        fs.symlinkSync(other,path.join(folder,'escape'),'dir');
        assert.strictEqual(scopes.route('wolfbook_newNotebook',{path:'escape/new.wb'},'agent-a',null,clients()).path,path.join(other,'new.wb'));
        assert.strictEqual(scopes.route('wolfbook_runCell',{client_id:'two'},'agent-a',null,clients()).client_id,'two');
        assert.strictEqual(scopes.route('wolfbook_newNotebook',{kernel_id:shared.id,path:'x.wb'},'agent-a',null,clients()).kernel_id,shared.id);
        assert.strictEqual(scopes.declare({working_directory:folder,sharing:'shared'},'shared',clients()).scope.sharing,'shared');
        assert.strictEqual(scopes.inventory(clients(),'agent-a')[0].kernels.length,3);
        assert.strictEqual(scopes.inventory(clients(),'agent-a',true).length,2);
        assert.throws(()=>scopes.declare({working_directory:folder},'ambiguous',[...clients(),{clientId:'duplicate',workspaceRoots:[folder]}]),e=>e.code==='WORKSPACE_SCOPE_AMBIGUOUS');
        // A token, rather than the common product name, restores the durable slot.
        const target={clientId:'one',notebook:nb,kernelId:privateKernel.id,kernelSlot:privateKernel.slotKey};
        scopes.saveTarget('agent-a',target);
        assert.throws(()=>scopes.declare({resume_token:scope.resume_token},'concurrent',clients()),e=>e.code==='RESUME_TOKEN_IN_USE');
        scopes.release('agent-a');
        const restarted=new AgentSessions(path.join(temp,'tokens.json'));
        const resumed=restarted.declare({resume_token:scope.resume_token},'reconnected',clients());
        assert.strictEqual(resumed.scope.scope_id,scope.scope_id);assert.strictEqual(resumed.target.kernelId,privateKernel.id);
        assert.strictEqual(fs.statSync(path.join(temp,'tokens.json')).mode&0o777,0o600);
        restarted.release('reconnected');
        const changedClients=clients();changedClients[0].kernels=changedClients[0].kernels.filter(k=>k.kernel_id!==privateKernel.id);
        assert.strictEqual(restarted.declare({resume_token:scope.resume_token},'later',changedClients).target,null);
        // Launch and bind failure clean up the newly allocated process.
        let quit=0,dispose=0;
        const failed=new KernelManager(null,{maximum:2,factory:async()=>({...controller(),launchKernel:async()=>{throw new Error('license exhausted');},quitKernel:async()=>{quit++;},dispose(){dispose++;}})});
        failed.addDefault(controller());
        await assert.rejects(failed.create(),/license exhausted/);assert.strictEqual(failed.size,1);assert.strictEqual(quit,1);assert.strictEqual(dispose,1);assert.strictEqual(failed._allocating,0);
        const bindFail=new KernelManager(null,{maximum:2,factory:async()=>controller()});
        bindFail.addDefault(controller());
        const originalBind=bindFail.bind;bindFail.bind=async()=>{throw Error('storage failed');};
        await assert.rejects(bindFail.createAndBind(path.join(other,'x.wb'),{owner_folder:folder}),/storage failed/);assert.strictEqual(bindFail.size,1);
        bindFail.bind=originalBind;
        const savedState={};
        const context={workspaceState:{get:(key,fallback)=>savedState[key] ?? fallback,update:async(key,value)=>{savedState[key]=value;}}};
        const beforeReload=new KernelManager(context,{maximum:2,factory:async()=>controller()});
        beforeReload.addDefault(controller());
        const reloadNb=path.join(folder,'reload.wb');
        const oldEntry=await beforeReload.createAndBind(reloadNb,{owner_folder:folder,owner_scope_id:scope.scope_id,sharing:'private'});
        const afterReload=new KernelManager(context,{maximum:2,factory:async()=>controller()});
        afterReload.addDefault(controller());
        assert.strictEqual(afterReload.annotateNotebook(reloadNb).binding_state,'unavailable');
        const [replacement]=await afterReload.restore();
        assert.notStrictEqual(replacement.id,oldEntry.id);
        assert.strictEqual(replacement.slotKey,oldEntry.slotKey);
        assert.strictEqual(replacement.ownerScopeId,scope.scope_id);
        assert.strictEqual(replacement.ownerFolder,folder);
        assert.strictEqual(kernelAllowed(scope,afterReload.describe(replacement)),true);
        scopes.saveTarget('agent-b',{clientId:'one',notebook:reloadNb,kernelId:oldEntry.id,kernelSlot:oldEntry.slotKey});
        // Resume into the same logical owner scope with the new process ID.
        const tokenScope={...scope,resume_token:'reload-token'};
        scopes.tokens.set('reload-token',{scope:tokenScope,target:{clientId:'one',notebook:reloadNb,kernelId:oldEntry.id,kernelSlot:oldEntry.slotKey},expires:Date.now()+60000});
        const resumedReload=scopes.declare({resume_token:'reload-token'},'reload-session',[{clientId:'one',generation:'g-new',workspaceRoots:[folder],notebooks:[reloadNb],kernels:afterReload.list([reloadNb])}]);
        assert.strictEqual(resumedReload.target.kernelId,replacement.id);
        await manager.stop(privateKernel.id);
        assert.strictEqual(manager.bindingFor(nb),null);
        assert.throws(()=>manager.resolve({notebook:nb}),e=>e.code==='KERNEL_BINDING_UNAVAILABLE');
        // Failed restoration preserves unavailable bindings instead of assigning K1.
        const persisted={[BINDINGS_KEY]:{[nb]:'missing-slot'}};
        const restored=new KernelManager({workspaceState:{get:(k,d)=>persisted[k]??d}});
        restored.addDefault(controller());assert.strictEqual(restored.bindingFor(nb),null);
        assert.strictEqual(restored.annotateNotebook(nb).binding_state,'unavailable');
        // Background notebook creation uses the real manager, with no shared fallback.
        stub.workspace.workspaceFolders=[{uri:{fsPath:folder}}];
        stub.workspace.notebookDocuments=[];
        stub.workspace.openNotebookDocument=async uri=>{const doc={uri,notebookType:'extended-wolfram-notebook',metadata:{},cellCount:0};stub.workspace.notebookDocuments.push(doc);return doc;};
        stub.window.activeNotebookEditor=undefined;
        stub.window.visibleNotebookEditors=[];
        stub.window.showInformationMessage=async()=>undefined;
        const resolver=()=>bindFail.defaultEntry.controller;resolver.manager=bindFail;
        const tool=new NewNotebookTool(resolver);
        await assert.rejects(tool.invoke({input:{path:path.join(folder,'without-ack.wb'),isolation:'kernel'}}),/acknowledge_resource_cost/);
        assert.strictEqual(fs.existsSync(path.join(folder,'without-ack.wb')),false);
        const created=await tool.invoke({input:{path:path.join(folder,'created.wb'),isolation:'kernel',acknowledge_resource_cost:true,_agentScope:scope}});
        const receipt=JSON.parse(created.content[1].value);
        assert.strictEqual(receipt.ok,true);assert.strictEqual(receipt.notebook,path.join(folder,'created.wb'));
        assert.strictEqual(receipt.sharing,'private');assert.strictEqual(receipt.owner_scope_id,scope.scope_id);assert.strictEqual(receipt.evaluation_ready,false);
        const failedResolver=()=>failed.defaultEntry.controller;failedResolver.manager=failed;
        const failure=await new NewNotebookTool(failedResolver).invoke({input:{path:path.join(folder,'failed.wb'),isolation:'kernel',acknowledge_resource_cost:true}});
        assert.strictEqual(JSON.parse(failure.content[0].value).ok,false);assert.strictEqual(failed.explicitBindingFor(path.join(folder,'failed.wb')),null);
        // The router accepts the structured receipt immediately, even before a worker heartbeat.
        const server=new WolframMCPServer(new Map(),[]);
        server._ownClientId='one';server._buildClientList=clients;
        server._agentScopes.sessions.set('s',scope);
        const result={content:created.content.map(p=>({type:'text',text:p.value})),isError:false};
        const receiptTarget=server._maybeTargetNewNotebook('wolfbook_newNotebook',{},'s','one',result);
        assert.strictEqual(receiptTarget.notebook,receipt.notebook);assert.strictEqual(receiptTarget.kernelId,receipt.kernel_id);
        assert.strictEqual(result.structuredContent.data.evaluation_ready,false);
        const dormantSelected={content:[{type:'text',text:JSON.stringify({...receipt,controller_selected:true,evaluation_ready:false})}]};
        server._maybeTargetNewNotebook('wolfbook_newNotebook',{},'s','one',dormantSelected);
        assert.deepStrictEqual(dormantSelected.structuredContent.warnings,[], 'a selected dormant controller needs no selection warning');
        server._lastTargetByClient.set('claude-code',{target,ts:Date.now()});server._sessionClientNames.set('stranger','claude-code');
        assert.strictEqual(server._adoptLastTarget('stranger'),null);
        assert.deepStrictEqual(server._findClientsByNotebook(path.join(temp,'missing','agent.wb')),[],'missing absolute paths never match a basename in another folder');
        // Explicit cross-folder calls route to the chosen worker without old target injection.
        let calls=0;
        server._workers.set('two',{port:27190,lastSeen:Date.now()});
        server._invokeWorker=async(_port,_name,input)=>{calls++;assert.strictEqual(input.notebook,undefined);assert.strictEqual(input.kernel_id,undefined);return {content:[],isError:false};};
        await server._dispatch('tools/call',{name:'wolfbook_runCell',arguments:{client_id:'two',cellNumber:1}},'s');assert.strictEqual(calls,1);
        // Folder inventory exposes exact roots, paths, ownership, and readiness.
        const listing=await server._dispatch('tools/call',{name:'wolfbook_list_clients',arguments:{}},'s');
        assert.strictEqual(listing.structuredContent.data.clients.length,2);
        const failedResult={content:failure.content.map(p=>({type:'text',text:p.value})),isError:false};
        assert.strictEqual(server._maybeTargetNewNotebook('wolfbook_newNotebook',{},'s','one',failedResult),null);
        assert.strictEqual(failedResult.isError,true);
        const decorated=server._appendTargetFooter(failedResult,receiptTarget);
        assert.strictEqual(JSON.parse(decorated.content[0].text).ok,false,'target footer preserves structured errors');
        assert.strictEqual(server._finalizeToolResult(decorated,'wolfbook_newNotebook','s').structuredContent.ok,false);
        server._buildClientList=()=>[{clientId:'one',generation:'g1',workspaceRoots:[folder],notebooks:[receipt.notebook],kernels:bindFail.list([receipt.notebook])}];
        let finish;
        const gate=new Promise(resolve=>{finish=resolve;});
        server._operationFastWaitMs=1;
        server._tools.set('wolfbook_evaluateExpression',{invoke:async({input})=>{
            bindFail.assertToolScope('wolfbook_evaluateExpression',input);
            assert.strictEqual(input.kernel_id,receipt.kernel_id);
            await gate;
            return {content:[new stub.LanguageModelTextPart('answer')]};
        }});
        await server._runManagedToolCall({name:'wolfbook_evaluateExpression',arguments:{expression:'1',wait_mode:'async'}},'s');
        const op=[...server._operations.values()][0];
        assert.strictEqual(op.agentScopeId,scope.scope_id);
        const pending=await server._dispatch('tools/call',{name:'wolfbook_operationStatus',arguments:{operation_id:op.id}},'s');
        assert.strictEqual(pending.structuredContent.state,'running');
        server._agentScopes.sessions.set('other',scopeB);
        assert.strictEqual((await server._dispatch('tools/call',{name:'wolfbook_operationStatus',arguments:{operation_id:op.id}},'other')).structuredContent.state,'running');
        finish();await op.promise;
        const complete=await server._dispatch('tools/call',{name:'wolfbook_operationStatus',arguments:{operation_id:op.id}},'s');
        assert.match(complete.content[0].text,/answer/);
        assert.strictEqual(server._operations.size,0);
        const bounded=server._boundResult({content:[{type:'text',text:'x'.repeat(20000)}]},'wolfbook_evaluateExpression',receipt.kernel_id,'s');
        const handle=JSON.parse(bounded.content[0].text).result_handle;
        const ownResult=await server._runManagedToolCall({name:'wolfbook_getResult',arguments:{handle}},'s');
        assert.strictEqual(ownResult.isError,false);
        assert.strictEqual((await server._runManagedToolCall({name:'wolfbook_getResult',arguments:{handle}},'other')).isError,false);
        // The kernel manager tool itself returns a binding receipt and scopes reuse.
        const binding=await new KernelManagerTool(resolver).invoke({input:{action:'bind',notebook:receipt.notebook,kernel_id:receipt.kernel_id,_agentScope:scope}});
        assert.strictEqual(JSON.parse(binding.content[0].value).receipt,'notebook-binding');
        console.log('agent kernel workflow: allocation, ownership, routing, resume, isolation and receipt tests OK');
    } finally {fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
