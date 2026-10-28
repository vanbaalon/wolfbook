'use strict';
const base=require('./tex-comment-hover.spec.cjs');
async function offer(t){
 if(!(await t.eval(()=>document.body.classList.contains('comments-open'))))await t.page.locator('#commentsbutton').click();
 const w=t.word('first'),p=await t.toClient(1,w.x+w.w/2,w.y+w.h/2);await t.page.mouse.move(p.x,p.y);
 await t.waitFor(()=>!!document.querySelector('.comment-marker.add'),null,{what:'comment affordance'});
 await t.clear();await t.page.locator('.comment-marker.add').click();
 return t.waitPosted('click',m=>m.commentTarget);
}
const txdl={fonts:[],ops:[{op:'rule',x:0,y:400*65536,w:40*65536,h:2*65536}]};
module.exports={fixtureTex:base.fixtureTex,tests:[...base.tests,{
 id:'comment-live-identity',name:'comments identify the live page and newer paragraph fragment even while the global map is behind',async run(t){
  await t.post({type:'engine',state:'live',interactive:true});
  await t.post({type:'txdlPage',generation:20,page:1,identity:'live-page',changed:true,txdl});
  await t.waitFor(()=>!!document.querySelector('canvas.txdl-overlay'),null,{what:'live overlay'});
  await t.post({type:'traceState',paused:true,compiling:true});await t.post({type:'nativeMapState',generation:1,available:false});
  const page=await offer(t);t.assert(page.overlay==='live-page','comments use the visible live page instead of the PDF underneath');
  await t.post({type:'commentTarget',target:null,reason:'temporary map delay'});
  await t.post({type:'txdlFragment',generation:21,page:1,index:0,mapIdentity:'live-fragment',txdl,
   placement:{page:1,identity:'live-page',clip:[0,0,400*65536,600*65536],clear:[0,300*65536,400*65536,320*65536],
    below:[0,320*65536,400*65536,600*65536],shift:0,dx:0,dy:0}});
  await t.waitFor(()=>!!document.querySelector('canvas.txdl-fragment'),null,{what:'paragraph fragment'});
  const fragment=await offer(t);t.assert(fragment.overlay==='live-fragment','a newer fragment owns the comment coordinates');
  t.assert((await t.posted('traceRetry')).length===0,'adding a comment does not trigger a full-map recovery gesture');
 },
},{
 id:'comment-warning-expiry',name:'a rejected comment is a temporary warning and cannot erase a newer status',async run(t){
  await t.page.clock.install();
  const reason='The source range changed since this glyph was compiled.';
  await t.post({type:'commentTarget',target:null,reason});
  t.assert(await t.page.locator('#status').textContent()===reason,'the rejection is explained');
  await t.page.clock.fastForward(6100);
  t.assert(await t.page.locator('#status').textContent()==='','the old rejection cannot look like minutes of ongoing work');
  await t.post({type:'commentTarget',target:null,reason});await t.post({type:'status',text:'A newer operation',kind:'busy'});
  await t.page.clock.fastForward(6100);
  t.assert(await t.page.locator('#status').textContent()==='A newer operation','expiry does not clear a later status');
 },
}]};
