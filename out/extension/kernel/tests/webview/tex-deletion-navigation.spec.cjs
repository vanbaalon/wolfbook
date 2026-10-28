'use strict';
const base=require('./tex-webview-bugs.spec.cjs');
const fixtureTex=base.fixtureTex.replace('\\end{document}',String.raw`\newpage Middle page.
\newpage Destination paragraph after a deletion.
\par\vspace*{14cm}\noindent Tail paragraph before an EOF deletion.
\end{document}`);
module.exports={fixtureTex,tests:[{
 id:'deleted-correction-scroll',name:'clicking a deleted correction reveals its distant seam and its EOF seam',async run(t){
  const page=t.fixture.pages[2],start=page.words.find(w=>w.text==='Destination'),tail=page.words.find(w=>w.text==='Tail');
  t.assert(start && tail,'fixture has two distant deletion seams');
  const h=(id,w)=>({id,ready:true,verb:'del',name:'line '+(id==='middle'?1248:1291),startLine:20,endLine:20,
   ourText:'',theirText:'A paragraph that was removed.',page:3,where:'gap',
   rects:[{page:3,x:w.x,y:w.y,w:w.w,h:0,caret:true}]});
  const first=h('middle',start),last=h('eof',{...tail,y:tail.y+tail.h});
  await t.post({type:'review',session:{file:'fx.tex',generation:1,renderRevision:'deletions',pending:2,
   groups:[{id:'batch',hunks:[first,last]}]}});
  for(const change of [first,last]){
   await t.clear();
   await t.page.locator(`.rh[data-hunk="${change.id}"] .name`).click();
   await t.waitPosted('reviewAction',m=>m.action==='show' && m.id===change.id);
   await t.post({type:'reviewFocus',id:change.id,generation:1,page:3,rects:change.rects});
   await t.waitFor(id=>{
    const main=document.querySelector('main'),badge=document.querySelector(`.page[data-page="3"] .rremoved[data-review-hunk="${id}"]`);
    if(!badge || main.scrollTop<1000)return false;
    const a=main.getBoundingClientRect(),b=badge.getBoundingClientRect();return b.top>=a.top && b.bottom<=a.bottom;
   },change.id,{what:'deletion seam visible on page 3'});
   t.assert(await t.eval(id=>document.querySelector('.rh.on').dataset.hunk===id,change.id),'the selected deletion remains focused');
   t.assert((await t.posted('opened')).length===0,'navigation uses the existing PDF');
  }
 }
}]};
