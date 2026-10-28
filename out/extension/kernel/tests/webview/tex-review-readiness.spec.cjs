'use strict';
const base=require('./tex-webview-bugs.spec.cjs');
module.exports={fixtureTex:base.fixtureTex,tests:[{
 id:'review-arrivals-ready',name:'unready arrivals stay disabled at the end without closing the panel or stealing the current correction',async run(t){
  const w=t.fixture.pages[0].words.find(w=>w.text==='paragraph');
  const h=(id,ready,line)=>({id,ready,verb:'change',name:id,startLine:line,beforeLine:line,endLine:line+1,
   theirText:'Old paragraph.',ourText:'New paragraph.',rects:[{page:1,x:w.x,y:w.y,w:w.w,h:w.h}],
   words:{ours:[{line:0,col:0,len:3}],theirs:[{line:0,col:0,len:3}]}});
  const first=h('first',true,7),next=h('next',false,1),third=h('third',true,9);
  const payload=()=>({type:'review',session:{file:t.fixture.pdf,pending:3,focus:first.id,generation:1,renderRevision:'arrivals',
   groups:[{id:'batch',at:1,hunks:[next,first,third]}]}});
  await t.post(payload());
  await t.waitFor(()=>!!document.querySelector('[data-reviewside="after"] .rd-fast canvas'),null,{what:'current selected correction'});
  const before=await t.eval(()=>({open:document.body.classList.contains('reviewing'),height:document.querySelector('#reviewpanel').clientHeight,
   ids:[...document.querySelectorAll('.rh')].map(e=>e.dataset.hunk),selected:document.querySelector('.rh.on').dataset.hunk,
   disabled:[...document.querySelector('.rh[data-hunk="next"]').querySelectorAll('button')].every(b=>b.disabled),
   clock:document.querySelector('[data-hunk="next"] .v').textContent,keepAll:document.querySelector('#reviewkeepall').disabled}));
  t.assert(before.open && before.height>0 && before.selected==='first','the existing panel and selection remain open');
  t.assert(before.ids.join(',')==='first,third,next' && before.disabled && before.clock==='◷' && before.keepAll,'unready rows are last, clocked and cannot be accepted');
  await t.clear();
  await t.page.locator('[data-hunk="next"] .name').click();await t.sleep(40);
  t.assert(!(await t.posted()).some(m=>m.type==='reviewAction'),'a waiting row cannot trigger navigation or a compile');
  await t.page.locator('#reviewnext').click();
  await t.waitPosted('reviewAction',m=>m.action==='show' && m.id==='third');
  await t.clear();next.ready=true;await t.post(payload());
  await t.waitFor(()=>document.querySelector('.rh[data-hunk="next"]').getAttribute('aria-disabled')==='false',null,{what:'arrival becomes ready'});
  t.assert(await t.eval(h=>document.body.classList.contains('reviewing') && document.querySelector('#reviewpanel').clientHeight===h,before.height),'readiness does not close or resize the panel');
  await t.page.locator('[data-hunk="next"] .name').click();
  await t.waitPosted('reviewAction',m=>m.action==='show' && m.id==='next');
  const pending=payload();pending.session.generation=null;await t.post(pending);
  await t.waitFor(()=>document.querySelectorAll('.rh.waiting').length===3,null,{what:'new generation disables all stale corrections'});
  t.assert(await t.eval(()=>document.body.classList.contains('reviewing') && document.querySelectorAll('.rh.waiting').length===3),'a new source generation keeps the drawer and clocks the unavailable rows');
  await t.clear();await t.post({type:'reviewOpen'});
  t.assert(!(await t.posted()).some(m=>m.type==='reviewRender'),'opening the drawer does not start unavailable snippet builds');
  await t.post(payload());
  await t.waitFor(()=>document.querySelectorAll('.rh.waiting').length===0,null,{what:'automatic readiness recovery'});
 }
},{
 id:'review-load-ready',name:'PDF loading and worker restart disable rows while keeping the drawer open',async run(t){
  const w=t.fixture.pages[0].words[0],h={id:'load',ready:true,verb:'change',name:'paragraph',startLine:7,
   theirText:'Old.',ourText:'New.',rects:[{page:1,x:w.x,y:w.y,w:w.w,h:w.h}]};
  const payload={type:'review',session:{file:t.fixture.pdf,pending:1,focus:null,generation:1,groups:[{id:'batch',at:1,hunks:[h]}]}};
  await t.post(payload);
  await t.post({type:'restartPdfWorker'});
  await t.waitFor(()=>document.querySelector('.rh').getAttribute('aria-disabled')==='true',null,{what:'worker recovery disables rows'});
  t.assert(await t.eval(()=>document.body.classList.contains('reviewing') && document.querySelector('.rh').getAttribute('aria-disabled')==='true'),'worker recovery retains the panel but prevents stale clicks');
  await t.clear();await t.page.locator('.rh .name').click();await t.sleep(30);
  t.assert(!(await t.posted()).some(m=>m.type==='reviewAction'),'restart cannot launch a stale correction');
  await t.open(1);
  t.assert(await t.eval(()=>document.querySelector('.rh').getAttribute('aria-disabled')==='true'),'a reopened PDF waits for fresh host placement');
  await t.post(payload);
  await t.waitFor(()=>document.querySelector('.rh').getAttribute('aria-disabled')==='false',null,{what:'rows re-enable after PDF and worker recovery'});
 }
}]};
