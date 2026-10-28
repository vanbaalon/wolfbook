'use strict';
const {fixtureTex}=require('./tex-webview-bugs.spec.cjs');
async function instrument(t){
    await t.eval(base64=>{
        const raw=atob(base64),proto=window.WPaperPdfRanges.prototype,create=proto.create;
        proto.create=function(pdfjs,descriptor){this.timeoutMs=40;const transport=create.call(this,pdfjs,descriptor);window.__rangeTransport=transport;return transport;};
        const answered=new Set();
        window.__rangeResponder=setInterval(()=>{
            for(const m of window.__all.filter(m=>m.type==='pdfRangeRequest')){
                const key=`${m.token}:${m.request}`;if(answered.has(key)||window.__dropRanges)continue;
                answered.add(key);window.postMessage({type:'pdfRange',token:m.token,request:m.request,begin:m.begin,data:btoa(raw.slice(m.begin,m.end))},'*');
            }
        },2);
    },t.fixture.base64);
}
async function rangeOpen(t,token){await t.post({type:'open',generation:2,pdfHash:'range-pdf',base:`${t.origin}/pdfjs`,pdfRange:{token,length:Buffer.from(t.fixture.base64,'base64').length}});}
async function fullOpen(t){await t.post({type:'open',generation:2,pdfHash:'range-pdf',base:`${t.origin}/pdfjs`,pdfBase64:t.fixture.base64});await t.waitPosted('opened',m=>m.generation===2,3000);}
module.exports={fixtureTex,tests:[{
    id:'late-byte-failure-recovery',name:'a byte timeout after parsing recovers without losing the mini-editor draft or selection',
    async run(t){await instrument(t);
        try{
            await t.clear();await rangeOpen(t,'late-byte-failure');await t.waitPosted('opened',m=>m.generation===2,3000);
            const w=t.word('paragraph'),rect={page:1,x:w.x,y:w.y,w:w.w,h:w.h};
            await t.post({type:'editOpen',editId:91,text:'Draft remains editable.',rects:[rect],page:1});
            await t.waitFor(()=>document.activeElement===document.querySelector('.editcard textarea'),null,{what:'editor focus'});
            await t.eval(()=>{const ta=document.querySelector('.editcard textarea');window.__originalEditor=ta;ta.setSelectionRange(6,13);window.__dropRanges=true;window.__rangeTransport.requestDataRange(0,3);});
            await t.clear();const failed=await t.waitPosted('pdfRangeFailed',m=>m.token==='late-byte-failure',1000);
            t.assert(failed.generation===2,'the failure names the current parsed document');
            await fullOpen(t);
            t.assert(await t.eval(()=>{const ta=document.querySelector('.editcard textarea');return ta===window.__originalEditor&&ta.value==='Draft remains editable.'&&ta.selectionStart===6&&ta.selectionEnd===13;}),'same editor DOM, draft and selection survive recovery');
            await t.clear();await t.page.keyboard.type('X');const change=await t.waitPosted('editChange');t.assert(change.text==='Draft X editable.','typing continues at the preserved selection');
            await t.post({type:'viewerProbe',requestId:'recovered',generation:2,page:1});const probe=await t.waitPosted('viewerProbeResult',m=>m.requestId==='recovered');t.assert(probe.ok,'page queries work after recovery');
        }finally{await t.eval(()=>clearInterval(window.__rangeResponder));}
    },
},{
    id:'initial-byte-failure-recovery',name:'an unanswered initial range load asks for recovery and opens full bytes',
    async run(t){await instrument(t);
        try{await t.eval(()=>{window.__dropRanges=true;});await t.clear();await rangeOpen(t,'initial-byte-failure');
            await t.waitPosted('pdfRangeFailed',m=>m.token==='initial-byte-failure',1000);
            await fullOpen(t);t.assert(await t.eval(()=>!!document.querySelector('.page canvas:not(.txdl-overlay)')),'page remains painted');
        }finally{await t.eval(()=>clearInterval(window.__rangeResponder));}
    },
}]};
