'use strict';
const base=require('./tex-webview-bugs.spec.cjs');
module.exports={fixtureTex:base.fixtureTex,tests:[{
 id:'review-paper-switch',name:'switching papers removes the old corrections and ignores late old-paper messages',async run(t){
  const w=t.word('velocity'),old='/paper/notes.tex',current='/paper/BGKT1.tex';
  const h={id:'same-content-id',ready:true,verb:'change',name:'paragraph',startLine:400,endLine:401,
   ourText:'New paragraph.',theirText:'Old paragraph.',page:1,rects:[{page:1,x:w.x,y:w.y,w:w.w,h:w.h}]};
  const review=(file,generation=1)=>({type:'review',paperRoot:file,session:{file,generation,renderRevision:file+'-'+generation,
   pending:1,focus:null,groups:[{id:'batch',hunks:[h]}]}});
  await t.post(review(old));
  await t.waitFor(()=>document.body.classList.contains('reviewing') && document.querySelectorAll('.rh').length===1,null,{what:'previous paper review'});
  await t.post({type:'blank',paperRoot:current});
  await t.waitFor(()=>!document.body.classList.contains('reviewing') && document.querySelectorAll('.rh').length===0,null,{what:'paper switch clears old corrections'});
  t.assert(await t.eval(()=>document.querySelector('#reviewdiff').textContent.trim()==='' && document.querySelector('#editnav').hidden),'no orphan preparing panel or footer');
  // Both papers can have generation 1: the file identity is also required.
  await t.open(1,{paperRoot:current});await t.post(review(old));
  t.assert(await t.eval(()=>!document.body.classList.contains('reviewing')),'late old-paper placement cannot repopulate the drawer');
  await t.post(review(current));
  await t.waitFor(()=>document.querySelectorAll('.rh:not(.waiting)').length===1,null,{what:'current paper correction'});
  await t.clear();await t.page.locator('.rh .name').click();
  await t.waitPosted('reviewAction',m=>m.action==='show' && m.file===current && m.paperRoot===current);
  await t.post(review(old));await t.post({type:'reviewFocus',paperRoot:old,id:h.id,page:1,generation:1,rects:h.rects});
  t.assert(await t.eval(()=>document.querySelectorAll('.rh:not(.waiting)').length===1),'late old messages preserve the actual current review');
  await t.open(2,{paperRoot:current});
  t.assert(await t.eval(()=>document.body.classList.contains('reviewing') && document.querySelectorAll('.rh').length===1),'a new compile of the same paper preserves its pending review');
  await t.post(review(current,2));
  await t.waitFor(()=>document.querySelectorAll('.rh:not(.waiting)').length===1,null,{what:'same paper fresh placement'});
 }
}]};
