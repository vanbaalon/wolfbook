'use strict';
const {fixtureTex}=require('./tex-webview-bugs.spec.cjs');
module.exports={fixtureTex,tests:['standard','Pro'].map(mode=>({
 id:`edit-reopen-${mode}`,name:`${mode}: closing after typing leaves right-click editing available during map recovery and a background compile`,
 async run(t){
  await t.post({type:'engine',state:mode==='Pro'?'live':'disabled',interactive:mode==='Pro'});
  const word=t.word('velocity'),rect={page:1,x:word.x,y:word.y,w:word.w,h:word.h};
  const text='The velocity of the particle appears here.';
  await t.post({type:'editOpen',editId:1,text,file:'paper.tex',startLine:7,endLine:7,rects:[rect]});
  await t.waitFor(()=>!!document.querySelector('.editcard textarea'),null,{what:'first card'});
  const edited=text+' More editing on the same page.';
  await t.page.locator('.editcard textarea').fill(edited);
  await t.waitPosted('editChange',m=>m.text===edited);
  await t.page.locator('.editcard textarea').press('Escape');await t.waitPosted('editClose');
  await t.post({type:'nativeMapState',generation:1,available:false});
  await t.post({type:'traceState',paused:true,compiling:true,source:'mini-editor'});
  await t.post({type:'compileState',compiling:true});await t.clear();
  const point=await t.toClient(1,word.x+word.w/2,word.y+word.h/2);
  await t.page.mouse.click(point.x,point.y,{button:'right'});
  const request=await t.waitPosted('editHere');
  t.assert(request.generation===1 && request.page===1,'right-click reaches the host for the displayed page');
  t.assert((await t.posted('traceRetry')).length===0,'editing is not replaced by a global-map recovery request');
  await t.post({type:'editOpen',editId:2,text:edited,file:'paper.tex',startLine:7,endLine:7,rects:[rect]});
  await t.waitFor(()=>!!document.querySelector('.editcard textarea'),null,{what:'reopened card while map remains unavailable'});
  t.assert(await t.page.locator('.editcard textarea').inputValue()===edited,'the reopened card contains the latest source');
  await t.page.keyboard.insertText('Still editing. ');
  await t.waitPosted('editChange',m=>m.editId===2 && m.text.includes('Still editing.'));
 },
}))};
