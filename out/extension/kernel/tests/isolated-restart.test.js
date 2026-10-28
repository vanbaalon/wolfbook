'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {closeSession,verifyProcess}=require('../shutdown');
const {makeVscodeStub,withVscodeStub}=require('./_stub-vscode');
const stub=makeVscodeStub();
const editor=withVscodeStub(()=>require('../../editor/commands'),stub);
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-isolated-restart-'));
process.env.WOLFBOOK_PID_FILE=path.join(dir,'pids.json');
require('../../utils/log-paths').init({globalStorageUri:{fsPath:dir}});
const lifecycle=withVscodeStub(()=>require('../lifecycle'),stub);
const {WolframNotebookKernel}=withVscodeStub(()=>require('../../controller'),stub);
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function native(){
 const calls=[];let ready=false;
 return {calls,get canClose(){return ready;},drain(){ready=true;},kernelPid:12345,
  beginClose(){calls.push('begin');},terminate(){calls.push('kill');return true;},
  close(){assert.ok(ready,'never close an active WSTP reader');calls.push('close');return true;}};
}
test('faulted kernel shutdown kills only the verified target and waits asynchronously for reader completion',async()=>{
 const target=native(),other=native(),wait=gate();let verified;
 const closing=closeSession({},target,{verify:async pid=>{verified=pid;},sleep:()=>wait.promise});
 await new Promise(r=>setImmediate(r));assert.equal(verified,12345);
 assert.deepEqual(target.calls,['begin','kill']);assert.deepEqual(other.calls,[]);
 target.drain();wait.resolve();await closing;assert.deepEqual(target.calls,['begin','kill','close']);
});
test('a reader which stays blocked is retained instead of freeing its link',async()=>{
 const session=native();let time=0;
 await assert.rejects(closeSession({},session,{verify:async()=>{},timeoutMs:100,now:()=>time,sleep:async()=>{time+=30;}}),
  {code:'kernel-reader-not-drained'});
 assert.deepEqual(session.calls,['begin','kill']);
});
test('an unverified PID or failed termination never reaches link cleanup',async()=>{
 const session=native();
 await assert.rejects(closeSession({},session,{verify:async()=>{throw Error('PID belongs to another host');}}),/another host/);
 assert.deepEqual(session.calls,[]);
 session.terminate=()=>false;
 await assert.rejects(closeSession({},session,{verify:async()=>{}}),{code:'kernel-terminate-failed'});
 assert.deepEqual(session.calls,['begin']);
 await assert.rejects(verifyProcess(process.pid),{code:'kernel-pid-unverified'});
});
test('legacy busy/faulted addons refuse unsafe close; a proven idle legacy session can close',async()=>{
 let closes=0;const old={isReady:false,close(){closes++;}};
 await assert.rejects(closeSession({_evalDispatched:true},old),{code:'safe-shutdown-unavailable'});assert.equal(closes,0);
 old.isReady=true;await assert.rejects(closeSession({_connectionLost:'dead'},old),{code:'safe-shutdown-unavailable'});
 assert.equal(closes,0);await closeSession({},old);assert.equal(closes,1);
});
function controller(){
 const shutdown=gate(),launch=gate(),events=[];
 const self={kernelIdentity:{kernel_id:'private-A'},_sessionEpoch:4,kernelMetadata:{pid:222},
  executionQueue:{forceEndAll(){events.push('force-end-this-queue');}},writeDebugLog(){},
  async quitKernel(){events.push('shutdown');await shutdown.promise;events.push('closed');},
  async launchKernel(){events.push('launch');await launch.promise;self.session={isOpen:true};self.kernelStatusString='resolved';self._sessionEpoch++;}};
 return {self,shutdown,launch,events};
}
test('restart coalesces concurrent requests and returns only when the same kernel identity is ready',async()=>{
 const f=controller(),first=editor.restartKernel(f.self),second=editor.restartKernel(f.self);
 assert.equal(first,second);assert.deepEqual(f.events,['force-end-this-queue','shutdown']);
 f.shutdown.resolve();await new Promise(r=>setImmediate(r));assert.deepEqual(f.events,['force-end-this-queue','shutdown','closed','launch']);
 let done=false;first.then(()=>done=true);await Promise.resolve();assert.equal(done,false);
 f.launch.resolve();const receipt=await first;assert.equal(receipt.kernel_id,'private-A');assert.equal(receipt.epoch,5);
});
test('failed shutdown never launches a replacement and failed initialization never returns success',async()=>{
 const f=controller();f.self.quitKernel=async()=>{throw Error('reader still active');};
 await assert.rejects(editor.restartKernel(f.self),/reader still active/);assert.ok(!f.events.includes('launch'));
 const g=controller();g.self.quitKernel=async()=>{};g.self.launchKernel=async()=>{g.self.kernelStatusString='unresolved';};
 await assert.rejects(editor.restartKernel(g.self),/did not finish initialization/);
});
test('disposing during shutdown cancels the deferred replacement launch',async()=>{
 const f=controller(),restart=editor.restartKernel(f.self);f.self._disposed=true;f.shutdown.resolve();
 await assert.rejects(restart,/disposed/);assert.ok(!f.events.includes('launch'));
});
test('closing a window during licence preflight prevents constructing a native session',async t=>{
 const diagnose=require('../diagnose'),original=diagnose.licenseGate,wait=gate();let constructed=0;
 t.after(()=>diagnose.licenseGate=original);diagnose.licenseGate=()=>wait.promise;
 const self={extensionPath:dir,findKernel:{resolveKernel:()=>process.execPath},_postToOwnedRenderers(){}};
 const starting=lifecycle.launchKernel(self,class {constructor(){constructed++;}});
 self._windowClosing=true;wait.resolve({proceed:true});
 await assert.rejects(starting,/window is closing/);assert.equal(constructed,0);
});
test('lifecycle retains a closing session, coalesces shutdown and clears it only after confirmation',async t=>{
 const shutdown=require('../shutdown'),original=shutdown.closeSession,wait=gate();
 t.after(()=>shutdown.closeSession=original);shutdown.closeSession=()=>wait.promise;
 const session={},self={session,kernelStatusString:'resolved',_postToOwnedRenderers(){}};
 const first=lifecycle.quitKernel(self,'test'),second=lifecycle.quitKernel(self,'test');
 assert.equal(first,second);assert.equal(self.session,session);assert.equal(self._shutdownSession,session);
 assert.equal(self.kernelStatusString,'stopping');wait.resolve();await first;
 assert.equal(self.session,undefined);assert.equal(self._shutdownSession,null);assert.equal(self.kernelStatusString,'unresolved');
});
test('lifecycle preserves a failed reader strongly and blocks a replacement launch',async t=>{
 const shutdown=require('../shutdown'),original=shutdown.closeSession;
 t.after(()=>shutdown.closeSession=original);shutdown.closeSession=async()=>{throw Error('reader stuck');};
 const session={},self={session,kernelStatusString:'resolved',_postToOwnedRenderers(){}};
 await assert.rejects(lifecycle.quitKernel(self,'test'),/reader stuck/);
 assert.equal(self.session,session);assert.equal(self._shutdownSession,session);assert.equal(self.kernelStatusString,'error');
 await assert.rejects(lifecycle.launchKernel(self,null),/reader stuck/);
});
test('an old abort watchdog cannot fault a replacement kernel or cancel its newer watchdog',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
 const wait=gate(),self={_abortUncertain:true,session:{subAuto:()=>wait.promise},executionQueue:{queueLength:()=>0},kernelStatusString:'resolved'};
 WolframNotebookKernel.prototype._startAbortUncertaintyWatchdog.call(self);
 t.mock.timers.tick(2000); // Probe is now awaiting the old session.
 self.session={};self._abortWatchdogToken={};self._abortWatchdogActive=true;
 t.mock.timers.tick(40000);wait.resolve(null);await new Promise(r=>setImmediate(r));
 assert.equal(self.kernelStatusString,'resolved');assert.equal(self._abortWatchdogActive,true);
});
test('abort retry timers cannot send an old abort into a replacement session',t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});let oldAborts=0,newAborts=0;
 const self={session:{closeAllDialogs(){},abort(){oldAborts++;return true;}},writeDebugLog(){},_dispatchEpoch:0,
  executionQueue:{queue:[{started:true}],queueLength(){return this.queue.length;},clear(){this.queue=[];}}};
 editor.abortEvaluation(self);assert.equal(oldAborts,1);
 self.session={abort(){newAborts++;return true;}};self.isAborting=true;
 t.mock.timers.tick(20000);assert.equal(newAborts,0);
});
test.after(async()=>{
 await require('../../utils/kernel-lifecycle-log').flush();fs.rmSync(dir,{recursive:true,force:true});
});
