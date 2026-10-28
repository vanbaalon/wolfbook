'use strict';
const { fixtureTex }=require('./tex-webview-bugs.spec.cjs');
module.exports={fixtureTex,tests:[{
    id:'pdf-teardown-editor-ready',name:'a hung old PDF teardown cannot block the new PDF, corrections or mini-editor',
    async run(t){
        await t.eval(async base64=>{
            const pdf=await import('/pdfjs/pdf.min.mjs');
            const worker=pdf.PDFWorker.create({port:pdf.GlobalWorkerOptions.workerPort});
            const doc=await pdf.getDocument({data:Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),worker}).promise;
            const proto=Object.getPrototypeOf(doc),original=proto.destroy;await doc.destroy();
            let blocked=false;
            proto.destroy=function(){
                if(blocked)return original.call(this);
                blocked=true;window.__oldPdfTeardownBlocked=true;
                return new Promise(resolve=>{window.__releasePdfTeardown=()=>resolve(original.call(this));});
            };
        },t.fixture.base64);
        await t.clear();
        await t.post({type:'open',base:`${t.origin}/pdfjs`,pdfBase64:t.fixture.base64,generation:2});
        await t.waitPosted('opened',m=>m.generation===2,2000);
        t.assert(await t.eval(()=>window.__oldPdfTeardownBlocked),'the old cleanup really is stalled');
        const w=t.word('paragraph');
        const rect={page:1,x:w.x,y:w.y,w:w.w,h:w.h};
        await t.post({type:'review',session:{generation:2,pending:1,groups:[{id:'batch',hunks:[{
            id:'change',ready:true,verb:'change',startLine:7,rects:[rect],theirText:'Old.',ourText:'New.'}]}]}});
        await t.waitFor(()=>document.querySelector('.rh')?.getAttribute('aria-disabled')==='false',null,{what:'enabled correction'});
        await t.post({type:'editOpen',editId:1,text:'Editable paragraph.',rects:[rect],page:1});
        await t.waitFor(()=>document.activeElement===document.querySelector('.editcard textarea'),null,{what:'focused mini-editor'});
        await t.page.keyboard.type('X');await t.waitPosted('editChange');
        await t.eval(()=>window.__releasePdfTeardown());
    },
},{
    id:'retire-preview-readiness',name:'retiring a settled overlay restores review and right-click while preserving newer typing',
    async run(t){
        const w=t.word('paragraph'),rect={page:1,x:w.x,y:w.y,w:w.w,h:w.h};
        const paint=async identity=>{
            await t.post({type:'txdlPage',generation:10,page:1,changed:true,identity,
                txdl:{fonts:[],ops:[{op:'rule',x:72*65536,y:100*65536,w:50*65536,h:2*65536}]}});
            await t.waitFor(()=>!!document.querySelector('canvas.txdl-overlay'),null,{what:'live overlay'});
        };
        await paint('settled-preview');
        await t.post({type:'review',session:{generation:1,pending:1,groups:[{id:'batch',hunks:[{
            id:'change',ready:true,verb:'change',startLine:7,rects:[rect],theirText:'Old.',ourText:'New.'}]}]}});
        t.assert(await t.eval(()=>document.querySelector('.rh').getAttribute('aria-disabled')==='true'),
            'the mismatched overlay reproduces the stuck Preparing state');
        await t.post({type:'retireLivePreview',generation:1,pages:{1:'settled-preview'}});
        await t.waitFor(()=>document.querySelector('.rh')?.getAttribute('aria-disabled')==='false',null,{what:'correction readiness restored'});
        const p=await t.toClient(1,w.x+w.w/2,w.y+w.h/2);await t.clear();
        await t.page.mouse.click(p.x,p.y,{button:'right'});
        const click=await t.waitPosted('editHere');t.assert(click.overlay==null,'right-click names the available PDF map');
        await paint('new-typing');
        await t.post({type:'retireLivePreview',generation:1,pages:{1:'settled-preview'}});
        t.assert(await t.eval(()=>!!document.querySelector('canvas.txdl-overlay')),'a delayed retirement cannot erase newer typing');
    },
}]};
