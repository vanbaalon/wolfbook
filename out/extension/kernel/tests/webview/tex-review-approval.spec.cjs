'use strict';
const {fixtureTex}=require('./tex-webview-bugs.spec.cjs');
module.exports={fixtureTex,tests:[{
 id:'approval-reuses-ink',name:'approving one correction keeps unchanged ink without remapping or reloading the PDF',
 async run(t){
  const make=(id,word)=>{const w=t.word(word);return {id,ready:true,verb:'change',startLine:7,theirText:'Old '+word,ourText:'New '+word,
   rects:[{page:1,x:w.x,y:w.y,w:w.w,h:w.h}],words:{ours:[{line:0,col:4,len:word.length}],theirs:[{line:0,col:4,len:word.length}]}};};
  const a=make('a','velocity'),b=make('b','particle');
  await t.post({type:'nativeMapState',generation:1,available:true});
  const session={file:'fx.tex',generation:1,renderRevision:'before-keep',focus:null,pending:2,groups:[{id:'batch',hunks:[a,b]}]};
  await t.post({type:'review',session});
  await t.waitFor(()=>window.__posted.filter(m=>m.type==='reviewPageMap').length===2,null,{what:'initial ink mapping'});
  for(const request of await t.posted('reviewPageMap')){
   const h=request.id==='a'?a:b;
   await t.post({type:'reviewPageMarks',requestId:request.requestId,id:h.id,generation:1,revision:'before-keep',marks:h.rects});
  }
  await t.waitFor(()=>document.querySelectorAll('.runderline').length===2,null,{what:'both corrections marked'});
  await t.clear();
  await t.post({type:'review',session:{...session,renderRevision:'after-keep',pending:1,groups:[{id:'batch',hunks:[b]}]}});
  await t.sleep(100);
  t.assert(await t.eval(()=>document.querySelectorAll('.runderline').length===1 && document.querySelector('.runderline').dataset.hunk==='b'),
   'the undecided correction keeps its completed word marks');
  t.assert((await t.posted('reviewPageMap')).length===0,'approval does not redo the unchanged map');
  t.assert((await t.posted('opened')).length===0,'approval does not reload the PDF');
  // A genuine source/rectangle change must still get fresh mapping.
  await t.post({type:'review',session:{...session,renderRevision:'real-edit',pending:1,
   groups:[{id:'batch',hunks:[{...b,ourText:'Actually changed',rects:[{...b.rects[0],y:b.rects[0].y+20}]}]}]}});
  await t.waitPosted('reviewPageMap',m=>m.id==='b' && m.revision==='real-edit');
 }
}]};
