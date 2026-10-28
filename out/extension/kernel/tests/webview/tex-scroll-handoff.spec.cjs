'use strict';
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const assert=require('node:assert/strict');
const texDir=process.env.WPAPER_EXT_ROOT ? path.join(process.env.WPAPER_EXT_ROOT,'out/extension/tex') : path.resolve(__dirname,'../../../tex');
const { withVscodeStub }=require('../_stub-vscode');
const { TexViewer }=withVscodeStub(()=>require(path.join(texDir,'texViewer')));
const { compile }=require(path.join(texDir,'compileService'));
const { GlyphMap }=require(path.join(texDir,'glyphMap'));
const { NativeMap }=require(path.join(texDir,'nativeMap'));
const { NativeBuildLane }=require(path.join(texDir,'nativeCompileService'));
const { scanTex }=require(path.join(texDir,'texScanner'));
const { buildModel }=require(path.join(texDir,'texModel'));
const paragraph='The reader keeps the same visible sentence while a background compilation replaces this page. A source line wraps into several printed rows, and their heights differ because mathematical symbols such as $x^2+\\sqrt{y}$ occur among the words. '.repeat(3);
const fixtureTex='\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n'+Array.from({length:12},(_,i)=>`${i+1}. ${paragraph}\n\n`).join('')+'\\end{document}\n';
const tests=[];
for (const mode of ['standard','Pro']) tests.push({
    id:`scroll-handoff-${mode}`,name:`${mode}: full compile preserves the exact visible point of a wrapped source line`,
    async run(t) {
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wpaper-scroll-handoff-')),root=path.join(dir,'paper.tex');
        fs.writeFileSync(root,fixtureTex); let lane;
        try {
            const model=buildModel(scanTex(fixtureTex,{file:root}),{file:root});
            let gen;
            if (mode === 'Pro') {
                lane=new NativeBuildLane(root,process.env.WPAPER_NATIVE_TEST_DIR || '/Users/k0959535/Dropbox/Programming/WLaTeX/wlatex');
                gen=await lane.compile({root,sourceFiles:[root],nativePages:[1,2],timeoutMs:60000});
            } else gen=await compile({root,sourceFiles:[root],engine:'lualatex',glyphMap:true,outDir:path.join(dir,'build'),timeoutMs:30000});
            assert.equal(gen.ok,true,JSON.stringify(gen.diagnostics));
            const map=mode === 'Pro' ? new NativeMap({generation:gen,model,nativeView:gen.nativeView,nativeSource:gen.nativeSource}) : new GlyphMap({generation:gen,model});
            const base64=fs.readFileSync(gen.pdfPath).toString('base64');
            await t.open(10,{pdfBase64:base64,pages:gen.pageCount});
            await t.post({type:'engine',state:mode === 'Pro' ? 'live' : 'off'});
            await t.post({type:'navigationOwner',owner:'editor'});
            // No user wheel gesture: this is the ordinary editor-follow view.
            await t.eval(()=>{document.querySelector('main').scrollTop=240;});
            await t.sleep(80); await t.clear();
            if (mode === 'Pro') {
                await t.post({type:'txdlPage',generation:90,page:1,changed:true,identity:'preview',
                    txdl:{fonts:[],ops:[{op:'rule',x:72*65536,y:600*65536,w:60*65536,h:2*65536}]}});
                await t.waitFor(()=>!!document.querySelector('canvas.txdl-overlay'),null,{what:'the live preview before its full PDF'});
            }
            await t.post({type:'requestViewState',requestId:'capture'});
            const snap=await t.waitPosted('viewstate',m=>m.requestId === 'capture');
            const v=Object.create(TexViewer.prototype);
            Object.assign(v,{root,coord:{roots:new Map([[root,{map}]])},_commentObjects:()=>model.objects});
            const saved=v._semanticViewCell({...snap,generation:gen.generation});
            assert.ok(saved,'a real PDF point resolves to its source cell');
            const rows=map.lineRows(root,model.objects.find(o=>o.objectId === saved.objectId).sourceRange.startLine+saved.lineOffset);
            assert.ok(rows.length>2,'the selected source line wraps across multiple printed rows');
            const reveal=v._viewCellPlacement(saved);
            assert.ok(reveal);
            const before=await t.eval(()=>({top:document.querySelector('main').scrollTop,left:document.querySelector('main').scrollLeft}));
            const samples=await t.eval(async msg=>{
                const main=document.querySelector('main'),values=[];
                window.postMessage(msg,'*');
                for (let i=0;i<40;i++) { await new Promise(requestAnimationFrame); values.push(main.scrollTop); }
                return values;
            },{type:'open',base:`${t.origin}/pdfjs`,pdfBase64:base64,generation:11,pages:gen.pageCount,
                live:false,navigationOwner:'editor',semanticReveal:reveal});
            await t.waitPosted('opened',m=>m.generation === 11);
            const after=await t.eval(()=>({top:document.querySelector('main').scrollTop,left:document.querySelector('main').scrollLeft}));
            t.near(after.top,before.top,0.6,'the full compile does not nudge the viewport');
            t.near(Math.min(...samples),Math.max(...samples),0.6,'no intermediate frame jumps');
            t.near(after.left,before.left,0.6,'horizontal position stays fixed');
            if (mode === 'Pro') assert.equal(await t.eval(()=>document.querySelectorAll('canvas.txdl-overlay').length),0,
                'the full PDF retires the preview without shifting scroll');

            // Preserve the point when genuine reflow moves the paragraph too.
            const oldPoint=await t.toClient(reveal.page,reveal.point.xBp,reveal.point.yTopBp);
            const reflow=fixtureTex.replace('\\begin{document}\n','\\begin{document}\nNew material before the paper.\\newpage\n');
            fs.writeFileSync(root,reflow);
            const nextModel=buildModel(scanTex(reflow,{file:root}),{file:root});
            const next=mode === 'Pro' ? await lane.compile({root,sourceFiles:[root],nativePages:[1,2,3],timeoutMs:60000})
                : await compile({root,sourceFiles:[root],engine:'lualatex',glyphMap:true,outDir:path.join(dir,'build'),timeoutMs:30000});
            assert.equal(next.ok,true,JSON.stringify(next.diagnostics));
            const nextMap=mode === 'Pro' ? new NativeMap({generation:next,model:nextModel,nativeView:next.nativeView,nativeSource:next.nativeSource})
                : new GlyphMap({generation:next,model:nextModel});
            v.coord.roots.get(root).map=nextMap; v._commentObjects=()=>nextModel.objects;
            const moved=v._viewCellPlacement(saved);
            assert.equal(moved.page,reveal.page+1,'the same text moves to the next physical page');
            await t.open(12,{pdfBase64:fs.readFileSync(next.pdfPath).toString('base64'),pages:next.pageCount,
                navigationOwner:'editor',semanticReveal:moved});
            const newPoint=await t.toClient(moved.page,moved.point.xBp,moved.point.yTopBp);
            t.near(newPoint.y,oldPoint.y,0.8,'reflow keeps the same text at the same viewport height');
        } finally { if (lane) await lane.close(); fs.rmSync(dir,{recursive:true,force:true}); }
    },
});
module.exports={fixtureTex,tests};
