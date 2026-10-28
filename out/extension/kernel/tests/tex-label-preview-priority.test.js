'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../../client/tex-viewer.js'),'utf8');
function fixture(){
    const state={doc:{},generation:1},started=[],waiting=[];
    const context=vm.createContext({state,setTimeout,renderFragmentCrop:async msg=>{
        started.push(msg.id);return new Promise(resolve=>waiting.push(()=>resolve({dataUrl:'image:'+msg.id,w:20,h:10})));
    }});
    vm.runInContext(source.slice(source.indexOf('const fragmentCropQueue ='),source.indexOf('async function renderFragmentCrop(')),context);
    return {state,started,crop:context.cropFragment,release:()=>waiting.shift()(),
        tick:()=>new Promise(resolve=>setTimeout(resolve,8))};
}
const request=(id,x=1)=>({id,rects:[{page:1,x,y:10,w:20,h:10}]});
test('hovered equation goes ahead of queued background thumbnails',async()=>{
    const f=fixture();const first=f.crop(request('background-one'));
    const background=f.crop(request('background-two',2));const hover=f.crop(request('hover',3));
    assert.deepEqual(f.started,['background-one']);f.release();await first;await f.tick();
    assert.deepEqual(f.started,['background-one','hover']);f.release();await hover;await f.tick();
    assert.deepEqual(f.started,['background-one','hover','background-two']);f.release();await background;
});
test('moving off a queued label skips its unused thumbnail',async()=>{
    const f=fixture();let hovered=true;const first=f.crop(request('background'));
    const old=f.crop({...request('hover',2),current:()=>hovered});hovered=false;
    f.release();await first;const result=await old;
    assert.equal(result.error,'preview superseded');assert.deepEqual(f.started,['background']);
});
test('cached equation crops are reused and replies retain each request identity',async()=>{
    const f=fixture();const first=f.crop(request('first'));f.release();await first;
    const hit=await f.crop(request('hover'));
    assert.equal(hit.id,'hover');assert.equal(hit.dataUrl,'image:first');assert.deepEqual(f.started,['first']);
});
test('a changed document or generation rejects old queued crops and old finished images',async()=>{
    const f=fixture();const first=f.crop(request('first')),queued=f.crop(request('queued',2));
    f.state.doc={};f.state.generation=2;f.release();
    assert.equal((await first).error,'preview superseded');assert.equal((await queued).error,'preview superseded');
    const next=f.crop(request('next'));await f.tick();f.release();
    assert.equal((await next).dataUrl,'image:next');assert.deepEqual(f.started,['first','next']);
});
