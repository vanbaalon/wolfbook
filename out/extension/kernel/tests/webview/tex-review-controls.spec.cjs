'use strict';
const fixtureTex=String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
First corrected paragraph.

Second corrected paragraph.

\begin{equation}a=b+c\end{equation}
\newpage
Continuation corrected paragraph.
\end{document}`;
const rect=(t,word,page=1)=>{const w=t.word(word);return {page,x:w.x,y:w.y,w:w.w,h:w.h};};
function payload(t){return {type:'review',session:{file:'fx.tex',pending:4,generation:1,focus:'one',
 groups:[{id:'batch',hunks:[
  {id:'one',verb:'change',ready:true,startLine:4,rects:[rect(t,'First')],theirText:'Old.',ourText:'First.'},
  {id:'two',verb:'add',ready:true,startLine:6,rects:[rect(t,'Second')],theirText:'',ourText:'Second.'},
  {id:'mine',verb:'change',ready:true,editedByYou:true,startLine:8,rects:[{page:1,x:220,y:150,w:180,h:25}],theirText:'Old.',ourText:'My equation.'},
  {id:'pending',verb:'change',ready:false,startLine:9,rects:[{page:1,x:72,y:200,w:300,h:12}],theirText:'Old.',ourText:'Pending.'}
 ]}]}};}
async function away(t){await t.page.mouse.move(3,3);await t.sleep(260);}
async function hover(t,id,page=1){
 const p=await t.eval(([id,page])=>{
  const band=[...document.querySelectorAll('.page[data-page="'+page+'"] .rband')].find(e=>e.dataset.hunk===id);
  const r=band.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+Math.max(r.height/2,1)};
 },[id,page]);
 const at=await t.eval(p=>{const e=document.elementFromPoint(p.x,p.y),m=document.querySelector('main').getBoundingClientRect();return {tag:e?.tagName,class:e?.className,page:e?.closest('.page')?.dataset.page,point:p,main:m.toJSON()};},p);
 t.assert(at.page===String(page),'the hover point reaches the visible page: '+JSON.stringify(at));
 await t.page.mouse.move(p.x,p.y);
 await t.waitFor(id=>[...document.querySelectorAll('.rchip:not([hidden])')].some(c=>c.dataset.reviewControls===id),id,{what:'hover controls for '+id});
}
const tests=[{
 id:'review-hover-controls',name:'every ready correction offers hover-only controls in both modes, including reader-edited corrections',
 async run(t){
  for(const pro of [false,true]){
   await away(t);await t.post({type:'engine',state:pro?'live':'off',keyMs:18});await t.post(payload(t));
   t.assert(await t.eval(()=>document.querySelectorAll('.rchip:not([hidden])').length===0),'even the focused correction stays unobtrusive before hover');
   await hover(t,'one');
   t.assert(await t.eval(()=>document.querySelectorAll('.rchip:not([hidden])').length===1),'only the hovered correction has visible buttons');
   // Crossing the gap must not hide the controls before the pointer gets to them.
   const b=await t.eval(()=>{const r=document.querySelector('.rchip:not([hidden]) .keep').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
   await t.page.mouse.move(b.x,b.y,{steps:4});await t.sleep(280);
   t.assert(await t.eval(()=>document.querySelectorAll('.rchip:not([hidden])').length===1),'buttons remain while the pointer is over them');
   await t.clear();await t.page.locator('.rchip:not([hidden]) [data-keep="one"]').click();
   await t.waitPosted('reviewAction',m=>m.action==='keep'&&m.id==='one');
   t.assert((await t.posted('reviewAction')).length===1,'one click decides only its correction');
   await hover(t,'two');await t.clear();await t.page.locator('.rchip:not([hidden]) [data-undo="two"]').click();
   await t.waitPosted('reviewAction',m=>m.action==='undo'&&m.id==='two');
   t.assert((await t.posted('click')).length===0,'deciding a correction does not move the source cursor');
   await hover(t,'mine');
   const mine=await t.eval(()=>{const c=document.querySelector('.rchip:not([hidden])'),u=c.querySelector('.undo');return {keep:c.querySelector('.keep').dataset.keep,disabled:u.disabled,title:u.title};});
   t.assert(mine.keep==='mine' && mine.disabled && /your|typed/.test(mine.title),'own edits retain Keep and a disabled, explained Undo');
   await away(t);t.assert(await t.eval(()=>document.querySelectorAll('.rchip:not([hidden])').length===0),'leaving the highlight and buttons hides them');
   const p=await t.toClient(1,80,205);await t.page.mouse.move(p.x,p.y);await t.sleep(260);
   t.assert(await t.eval(()=>document.querySelectorAll('.rchip:not([hidden])').length===0),'unready corrections cannot reveal decision controls');
  }
 }
},{
 id:'review-hover-continuation',name:'hover controls work on page continuations and stay inside the viewport at high zoom',
 async run(t){
  const h={id:'long',verb:'change',ready:true,startLine:4,theirText:'Old.',ourText:'New.',rects:[rect(t,'First'),rect(t,'Continuation',2)]};
  await t.post({type:'review',session:{file:'fx.tex',pending:1,generation:1,focus:null,groups:[{id:'batch',hunks:[h]}]}});
  await t.post({type:'highlight',page:2,rects:[h.rects[1]],reveal:true});
  await t.waitFor(()=>!!document.querySelector('.page[data-page="2"] canvas'),null,{what:'continuation page'});
  await t.eval(()=>{document.querySelector('main').scrollTop=document.querySelector('.page[data-page="2"]').offsetTop;});await t.sleep(80);
  await hover(t,'long',2);
  await t.page.locator('#zoomin').click();await t.page.locator('#zoomin').click();await t.sleep(350);
  await t.eval(()=>{const m=document.querySelector('main');m.scrollLeft=80;m.scrollTop=document.querySelector('.page[data-page="2"]').offsetTop;});
  await t.sleep(80);await hover(t,'long',2);
  const g=await t.eval(()=>{const c=document.querySelector('.page[data-page="2"] .rchip:not([hidden])'),r=c.getBoundingClientRect(),m=document.querySelector('main').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,view:m.toJSON()};});
  t.assert(g.left>=g.view.left && g.right<=g.view.right && g.top>=g.view.top && g.bottom<=g.view.bottom,'the hover controls fit inside the viewport');
  await t.clear();await t.page.locator('.page[data-page="2"] .rchip:not([hidden]) [data-undo="long"]').click();
  await t.waitPosted('reviewAction',m=>m.action==='undo'&&m.id==='long');
 }
},{
 id:'review-hover-stale',name:'decided and stale corrections cannot leave actionable hover controls',
 async run(t){
  const p=payload(t);await t.post(p);await hover(t,'one');
  p.session.groups[0].hunks=p.session.groups[0].hunks.filter(h=>h.id!=='one');p.session.pending--;await t.post(p);
  t.assert(await t.eval(()=>!document.querySelector('.rchip [data-keep="one"]')),'decided controls leave the page');
  await hover(t,'two');p.session.generation=999;await t.post(p);
  t.assert(await t.eval(()=>document.querySelectorAll('.rchip').length===0),'stale controls disappear');
 }
}];
module.exports={fixtureTex,tests};
