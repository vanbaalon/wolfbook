'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {ActivitySleepGuard,trackSessionActivity}=require('../sleepGuard');
function fixture(platform='darwin'){
    const children=[];const guard=new ActivitySleepGuard({platform,pid:12345,spawn:(file,args)=>{
        const child=new EventEmitter();Object.assign(child,{file,args,kills:0,kill(){this.kills++;}});children.push(child);return child;
    }});return {guard,children};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('idle kernels create no assertion and concurrent evaluation uses one host guard',async()=>{
    const {guard,children}=fixture(),first=deferred(),second=deferred(),a={},b={};
    const sa=trackSessionActivity(a,{evaluate:()=>first.promise},guard),sb=trackSessionActivity(b,{evaluate:()=>second.promise},guard);
    assert.equal(children.length,0);const pa=sa.evaluate('a'),pb=sb.evaluate('b');assert.equal(children.length,1);
    assert.deepEqual(children[0].args,['-i','-w','12345']);first.resolve('first');assert.equal(await pa,'first');assert.equal(children[0].kills,0);
    second.resolve('second');await pb;assert.equal(children[0].kills,1);assert.equal(guard.owners.size,0);
});
test('failed evaluation releases the guard and native method receivers stay bound',async()=>{
    const {guard,children}=fixture(),self={},raw={value:7,get ready(){return this===raw;},isOpen(){return this===raw;},
        evaluate(){assert.equal(this,raw);throw Error('native failure');}};
    const session=trackSessionActivity(self,raw,guard);assert.equal(session.ready,true);assert.equal(session.isOpen(),true);assert.equal(children.length,0);
    await assert.rejects(session.evaluate('x'),/native failure/);assert.equal(children[0].kills,1);assert.equal(guard.owners.size,0);
});
test('stopping or replacing a kernel releases only its own work; stale completions cannot release new work',async()=>{
    const {guard,children}=fixture(),a={},b={},old=deferred(),other=deferred(),next=deferred();
    const oldRun=trackSessionActivity(a,{subAuto:()=>old.promise},guard).subAuto('x');
    const otherRun=trackSessionActivity(b,{sub:()=>other.promise},guard).sub('y');a._releaseSleepGuard();assert.equal(children[0].kills,0);
    const nextRun=trackSessionActivity(a,{evaluateRaw:()=>next.promise},guard).evaluateRaw('z');
    old.resolve();await oldRun;other.resolve();await otherRun;assert.equal(children[0].kills,0);
    next.resolve();await nextRun;assert.equal(children[0].kills,1);
    const later=guard.acquire({});assert.equal(children.length,2);children[0].emit('exit',0);assert.equal(guard.process,children[1]);later();
});
test('non-macOS and unavailable caffeinate never interfere with evaluation',async()=>{
    const {guard,children}=fixture('linux'),session=trackSessionActivity({}, {evaluate:async()=>42},guard);
    assert.equal(await session.evaluate('x'),42);assert.equal(children.length,0);
    const failed=new ActivitySleepGuard({platform:'darwin',spawn:()=>{throw Error('unavailable');}});
    assert.equal(await trackSessionActivity({}, {evaluate:async()=>42},failed).evaluate('x'),42);assert.equal(failed.owners.size,0);
});
test('asynchronous spawn failure and diagnostic logging cannot break or leak native work',async()=>{
    const {guard,children}=fixture();guard.record=()=>{throw Error('log unavailable');};
    const gate=deferred(),self={},session=trackSessionActivity(self,{evaluate:()=>gate.promise},guard),running=session.evaluate('work');
    children[0].emit('error',Object.assign(Error('no caffeinate'),{code:'ENOENT'}));
    gate.resolve(42);assert.equal(await running,42);assert.equal(guard.owners.size,0);assert.equal(guard.process,null);
});
