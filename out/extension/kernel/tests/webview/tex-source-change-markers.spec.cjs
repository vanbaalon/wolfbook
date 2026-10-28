'use strict';
const {fixtureTex}=require('./tex-deletion-navigation.spec.cjs');
module.exports={fixtureTex,tests:[{
 id:'source-marker-navigation',name:'nonprinting corrections scroll to a distant source marker without highlighting neighbouring prose',async run(t){
  const w=t.fixture.pages[2].words.find(w=>w.text==='Destination');
  const rect={page:3,x:w.x,y:w.y,w:240,h:0,caret:true};
  const h={id:'source-only',ready:true,verb:'change',contextual:true,startLine:6594,endLine:6595,
   ourText:'Hidden new wording.',theirText:'Hidden old wording.',page:3,where:'gap',rects:[rect]};
  await t.post({type:'review',session:{file:'fx.tex',generation:1,renderRevision:'source-only',pending:1,
   groups:[{id:'batch',hunks:[h]}]}});
  await t.clear();await t.page.locator('.rh[data-hunk="source-only"] .name').click();
  await t.waitPosted('reviewAction',m=>m.action==='show' && m.id===h.id);
  await t.post({type:'reviewFocus',id:h.id,generation:1,page:3,rects:[rect]});
  await t.waitFor(()=>{
   const main=document.querySelector('main'),badge=document.querySelector('.page[data-page="3"] .rremoved.contextual');
   if(!badge || main.scrollTop<1000)return false;
   const a=main.getBoundingClientRect(),b=badge.getBoundingClientRect();return b.top>=a.top && b.bottom<=a.bottom;
  },null,{what:'source change marker visible on page 3'});
  t.assert(await t.eval(()=>document.querySelector('.rremoved.contextual').textContent==='◇ Source change'),'source marker is distinct from deletion');
  t.assert(await t.eval(()=>document.querySelector('.rh .where').textContent.includes('p.3 · source marker')),'location is explained in the list');
  t.assert(await t.eval(()=>{
   const bands=[...document.querySelectorAll('.rband[data-hunk="source-only"]')];
   return bands.length===1 && bands[0].classList.contains('contextual') && parseFloat(bands[0].style.height)===0 &&
    getComputedStyle(bands[0]).borderBottomStyle==='dashed' && !document.querySelector('.rinkfill, .runderline');
  }),'marker never paints the neighbouring printed paragraph as changed');
  t.assert((await t.posted('opened')).length===0,'navigation reuses the current PDF');
  await t.clear();await t.page.locator('.rremoved.contextual').click();
  await t.waitPosted('reviewAction',m=>m.action==='show' && m.id===h.id);
 },
}]};
