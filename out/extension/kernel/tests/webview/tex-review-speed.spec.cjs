'use strict';
const spec=require('./tex-webview-bugs.spec.cjs');
module.exports={fixtureTex:spec.fixtureTex,tests:[{
 id:'review-visible-first',name:'page marks and the after snippet appear before an older version returns, with compact safe attribution',async run(t){
  const w=t.fixture.pages[0].words.find(w=>w.text==='paragraph');t.assert(w,'fixture paragraph is present');
  for(const pro of [false,true]){
   await t.clear();await t.post({type:'nativeMapState',generation:1,available:pro});
   const h={id:'quick-'+pro,verb:'change',name:'paragraph',startLine:7,beforeLine:7,endLine:8,
    theirText:'Old paragraph.',ourText:'New paragraph.',rects:[{page:1,x:w.x,y:w.y,w:w.w,h:w.h}],
    words:{ours:[{line:0,col:0,len:3}],theirs:[{line:0,col:0,len:3}]},
    author:{name:'Alice with a deliberately very long name',source:'git',scope:'lines',contributors:[{name:'Alice "<safe>"',email:'a@example.test',commit:'a'.repeat(40)}]}};
   const author=h.author;delete h.author;
   const payload=()=>({type:'review',session:{file:t.fixture.pdf,pending:1,focus:h.id,generation:1,renderRevision:'fast-'+pro,
    groups:[{id:'batch',at:1,hunks:[h]}]}});
   const started=Date.now();await t.post(payload());
   await t.waitFor(()=>!!document.querySelector('[data-reviewside="after"] .rd-fast canvas'),null,{what:'current-page crop without any snapshot reply',timeout:1200});
   t.assert(Date.now()-started<1200,'the already-painted ink is reused promptly');
   h.author=author;await t.post(payload());
   await t.waitFor(()=>!!document.querySelector('.rd-author'),null,{what:'Git attribution arriving after ink without a source change'});
   const ink=await t.waitPosted('reviewPageMap',m=>m.id===h.id);
   await t.post({...ink,type:'reviewPageMarks',marks:[{page:1,x:w.x,y:w.y,w:w.w,h:w.h}]});
   await t.waitFor(()=>!!document.querySelector('.runderline'),null,{what:'on-page marking before old snapshot'});
   const request=await t.waitPosted('reviewRender',m=>m.id===h.id);t.assert(request.pagePreview===true,'no current-version compilation is requested');
   const authored=await t.eval(()=>{const a=document.querySelector('.rd-author');return {title:a.title,width:a.getBoundingClientRect().width,bad:!!document.querySelector('#reviewdiff safe'),fast:!!document.querySelector('[data-reviewside="after"] .rd-fast canvas')};});
   t.assert(authored.width<=112 && authored.title.includes('a@example.test') && !authored.bad,'the bounded name has the full safe Git details on hover');
   await t.post({...request,type:'reviewRendered',before:{error:'Old version unavailable'}});
   t.assert(await t.eval(()=>!!document.querySelector('[data-reviewside="after"] .rd-fast canvas')),'a failed older version preserves the current fast crop');
   await t.post({type:'review',session:{file:t.fixture.pdf,pending:1,focus:h.id,generation:999,renderRevision:'new-'+pro,groups:[{id:'batch',at:1,hunks:[h]}]}});
   t.assert(await t.eval(()=>document.querySelectorAll('.runderline,[data-reviewside="after"] .rd-fast').length)===0,'obsolete PDF geometry is never reused');
  }
 }
},{
 id:'review-live-page-first',name:'live review ink and crops follow the painted page identity without waiting for a full PDF',async run(t){
  const w=t.fixture.pages[0].words.find(w=>w.text==='paragraph');
  const txdl={fonts:[],ops:[{op:'rule',x:0,y:0,w:60*65536,h:6*65536}]};
  await t.post({type:'txdlPage',generation:20,page:1,changed:true,identity:'review-page-20',txdl});
  const h={id:'live-review',verb:'change',name:'paragraph',startLine:7,beforeLine:7,endLine:8,
   theirText:'Old paragraph.',ourText:'New paragraph.',rects:[{page:1,x:w.x,y:w.y,w:w.w,h:w.h}],
   words:{ours:[{line:0,col:0,len:3}],theirs:[{line:0,col:0,len:3}]}};
  const payload=identity=>({type:'review',session:{file:t.fixture.pdf,pending:1,focus:h.id,generation:1,
   livePages:{1:identity},renderRevision:identity,groups:[{id:'live',at:1,hunks:[h]}]}});
  await t.clear();await t.post(payload('review-page-20'));
  await t.waitFor(()=>!!document.querySelector('[data-reviewside="after"] .rd-fast canvas'),null,{what:'current live-page crop'});
  const request=await t.waitPosted('reviewPageMap',m=>m.id===h.id);
  t.assert(request.livePages[1]==='review-page-20' && request.items.length===0,'native origins own live marking');
  await t.post({...request,type:'reviewPageMarks',marks:[{page:1,x:w.x,y:w.y,w:w.w,h:w.h}]});
  await t.waitFor(()=>!!document.querySelector('.runderline'),null,{what:'live ink before full PDF'});
  await t.post({type:'txdlPage',generation:21,page:1,changed:true,identity:'review-page-21',txdl});
  t.assert(await t.eval(()=>document.querySelectorAll('.runderline,[data-reviewside="after"] .rd-fast').length)===0,
   'a live redraw hides obsolete review ink even when no viewer selection exists');
  await t.post({...request,type:'reviewPageMarks',marks:[{page:1,x:w.x,y:w.y,w:w.w,h:w.h}]});
  t.assert(await t.eval(()=>document.querySelectorAll('.runderline').length)===0,'late old-page replies cannot restore stale ink');
  await t.post(payload('review-page-21'));
  await t.waitFor(()=>!!document.querySelector('[data-reviewside="after"] .rd-fast canvas'),null,{what:'new live crop'});
 }
}]};
