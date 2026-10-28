'use strict';
const base=require('./tex-webview-bugs.spec.cjs');
const fixtureTex=base.fixtureTex.replace('\\end{document}',String.raw`\newpage
\section{Return passage}
`+Array.from({length:22},(_,i)=>String.raw`Original reading location ${i+1}. A paragraph to return to after reviewing corrections.\par`+'\n').join('')+String.raw`
\newpage
\section{Distant change}
Distant correction in a later section.
\end{document}`);
module.exports={fixtureTex,tests:[{
 id:'review-return-bookmark',name:'review saves its start before navigation and returns there after a distant correction',async run(t){
  const rect=w=>({page:w.page,x:w.x,y:w.y,w:w.w,h:w.h});
  const make=(id,w)=>({id,ready:true,verb:'change',name:'paragraph',startLine:7,endLine:7,page:w.page,
   theirText:'Old text.',ourText:'New text.',rects:[rect(w)]});
  const a=make('first',t.word('velocity')),b=make('distant',t.word('Distant'));
  const session={file:'fx.tex',generation:1,renderRevision:'initial',pending:2,groups:[{id:'batch',hunks:[a,b]}]};
  await t.post({type:'review',session});
  await t.eval(async()=>{
   await window.__wbTexViewerTest.renderPage(2);
   const main=document.querySelector('main');main.scrollTop=document.querySelector('.page[data-page="2"]').offsetTop+140;
  });
  await t.sleep(180);
  const start=await t.eval(()=>document.querySelector('main').scrollTop);
  await t.clear();await t.page.locator('.rh[data-hunk="first"] .name').click();
  const saved=await t.waitPosted('viewstate',m=>m.bookmarks?.some(b=>b.id.startsWith('review-start-')));
  const bookmark=saved.bookmarks.find(b=>b.id.startsWith('review-start-'));
  t.assert(bookmark.page===2,'the bookmark names the original reading page');
  const messages=await t.posted();
  t.assert(messages.findIndex(m=>m.type==='viewstate')<messages.findIndex(m=>m.type==='reviewAction'),
   'the return place is saved before navigation can begin');
  await t.post({type:'reviewFocus',id:a.id,generation:1,page:a.page,rects:a.rects});
  await t.waitFor(start=>document.querySelector('main').scrollTop<start-400,start,{what:'first correction reached'});
  await t.clear();await t.page.locator('.rh[data-hunk="first"] [data-keep]').click();
  await t.waitPosted('reviewAction',m=>m.action==='keep');
  await t.post({type:'review',session:{...session,pending:1,focus:b.id,renderRevision:'kept-first',groups:[{id:'batch',hunks:[b]}]}});
  await t.post({type:'reviewFocus',id:b.id,generation:1,page:b.page,rects:b.rects});
  await t.waitFor(start=>document.querySelector('main').scrollTop>start+400,start,{what:'distant correction reached'});
  const selector=`#bookmark-above [data-bookmark="${bookmark.id}"] button:not(.bookmark-delete)`;
  await t.page.locator(selector).click();
  await t.waitFor(start=>Math.abs(document.querySelector('main').scrollTop-start)<3,start,{what:'original reading position restored'});
  t.assert((await t.posted('viewstate')).every(m=>!m.bookmarks?.some(b=>b.id.startsWith('review-start-') && b.id!==bookmark.id)),
   'continuing a review does not replace its starting point');
  t.assert((await t.posted('viewerNavigation')).length>0,'returning claims navigation from pending review replays');
 },
},{id:'review-return-session-boundary',name:'closing a review allows a fresh return point without accumulating bookmarks',async run(t){
 const w=t.word('velocity'),h={id:'first',ready:true,verb:'change',name:'paragraph',startLine:7,endLine:7,page:1,
  ourText:'New text.',theirText:'Old text.',rects:[{page:1,x:w.x,y:w.y,w:w.w,h:w.h}]};
 const session={file:'fx.tex',generation:1,pending:1,groups:[{id:'batch',hunks:[h]}]};
 await t.post({type:'review',session});await t.clear();
 await t.page.locator('.rh .name').click();
 const first=await t.waitPosted('viewstate',m=>m.bookmarks?.some(b=>b.id.startsWith('review-start-')));
 await t.page.locator('#reviewclose').click();await t.post({type:'review',session:null});
 await t.post({type:'review',session});await t.clear();await t.page.locator('.rh .name').click();
 const second=await t.waitPosted('viewstate',m=>m.bookmarks?.some(b=>b.id.startsWith('review-start-')));
 t.assert(second.bookmarks.length===1 && second.bookmarks[0].id!==first.bookmarks[0].id,
  'a new review visit replaces only its automatic return bookmark');
}}]};
