'use strict';
const {fixtureTex}=require('./tex-webview-bugs.spec.cjs');
module.exports={fixtureTex,tests:[{
 id:'large-review-selection-stable',name:'selecting among 500 corrections retains list and page nodes through host confirmations',
 async run(t){
    const w=t.word('paragraph'),rect={page:1,x:w.x,y:w.y,w:w.w,h:w.h};
    const hunks=Array.from({length:500},(_,i)=>({id:'h'+i,ready:true,verb:'change',startLine:7+i,beforeLine:7+i,
        page:1,where:'rows',rects:[rect],theirText:'Old paragraph '+i,ourText:'New paragraph '+i,
        words:{ours:[{line:0,col:0,len:3}],theirs:[{line:0,col:0,len:3}]}}));
    await t.post({type:'review',session:{file:'/paper.tex',renderRevision:'stable',generation:1,pending:hunks.length,groups:[{id:'b',hunks}]}});
    await t.waitFor(()=>document.querySelectorAll('.rh').length===500,null,{what:'large correction list'});
    await t.eval(()=>{
        window.__rows=[...document.querySelectorAll('.rh')];window.__band=document.querySelector('.rband');window.__listMutations=0;
        window.__listObserver=new MutationObserver(changes=>{window.__listMutations+=changes.filter(m=>m.type==='childList').length;});
        window.__listObserver.observe(document.getElementById('reviewlist'),{childList:true,subtree:true});
    });
    await t.clear();await t.page.locator('.rh[data-hunk="h3"] .name').click();await t.waitPosted('reviewAction',m=>m.action==='show'&&m.id==='h3');
    await t.post({type:'reviewSelection',file:'/paper.tex',id:'h3'});
    await t.post({type:'reviewFocus',id:'h3',generation:1,page:1,rects:[rect]});
    await t.page.locator('.rh[data-hunk="h5"] .name').click();await t.waitPosted('reviewAction',m=>m.action==='show'&&m.id==='h5');
    await t.post({type:'reviewSelection',file:'/paper.tex',id:'h5'});
    await t.waitFor(()=>document.querySelector('.rh.on')?.dataset.hunk==='h5',null,{what:'focused row'});
    t.assert(await t.eval(()=>window.__rows.every((node,i)=>node===document.querySelectorAll('.rh')[i])),'every list row is retained');
    t.assert(await t.eval(()=>window.__band.isConnected),'other correction ink stays on the page');
    t.assert(await t.eval(()=>window.__listMutations===0),'no list DOM rebuild on local clicks or host confirmation');
    t.assert(await t.eval(()=>document.querySelector('.rd-head b').textContent.includes('12')),'the selected correction details still change');
    await t.eval(()=>window.__listObserver.disconnect());
 },
},{
 id:'review-ink-incremental',name:'one completed word map repaints only that correction and keeps unrelated ink and controls',
 async run(t){
    const w=t.word('paragraph'),rect={page:1,x:w.x,y:w.y,w:w.w,h:w.h};
    await t.clear();await t.post({type:'review',session:{file:'/paper.tex',renderRevision:'stable',generation:1,pending:2,groups:[{id:'b',hunks:[
        {id:'a',ready:true,verb:'add',page:1,rects:[rect],startLine:1,ourText:'Added a.'},
        {id:'b',ready:true,verb:'add',page:1,rects:[rect],startLine:2,ourText:'Added b.'}]}]}});
    const request=await t.waitPosted('reviewPageMap',m=>m.id==='a');
    await t.eval(()=>{window.__neighborBand=document.querySelector('.rband[data-hunk="b"]');window.__neighborControls=document.querySelector('[data-review-controls="b"]');});
    await t.post({type:'reviewPageMarks',id:'a',requestId:request.requestId,generation:1,revision:'stable',marks:[rect]});
    await t.waitFor(()=>!!document.querySelector('.runderline[data-hunk="a"]'),null,{what:'new word mark'});
    t.assert(await t.eval(()=>window.__neighborBand.isConnected&&window.__neighborControls.isConnected),'unrelated ink and controls survive a map reply');
 },
},{
 id:'review-passive-probe',name:'a selection health check does not queue fresh PDF worker work behind previews',
 async run(t){
    await t.eval(async base64=>{
        const pdf=await import('/pdfjs/pdf.min.mjs'),doc=await pdf.getDocument({data:Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),worker:pdf.PDFWorker.create({port:pdf.GlobalWorkerOptions.workerPort})}).promise;
        const proto=Object.getPrototypeOf(doc);await doc.destroy();window.__oldGetPageIndex=proto.getPageIndex;
        proto.getPageIndex=function(){throw Error('a busy worker must not be queried for selection');};
    },t.fixture.base64);
    try{
        await t.clear();await t.post({type:'viewerProbe',requestId:'passive',generation:1,page:1,passive:true});
        const reply=await t.waitPosted('viewerProbeResult',m=>m.requestId==='passive');t.assert(reply.ok,'current DOM/document health is sufficient');
    }finally{await t.eval(async base64=>{
        const pdf=await import('/pdfjs/pdf.min.mjs'),doc=await pdf.getDocument({data:Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),worker:pdf.PDFWorker.create({port:pdf.GlobalWorkerOptions.workerPort})}).promise;
        Object.getPrototypeOf(doc).getPageIndex=window.__oldGetPageIndex;await doc.destroy();
    },t.fixture.base64);}
 },
}]};
