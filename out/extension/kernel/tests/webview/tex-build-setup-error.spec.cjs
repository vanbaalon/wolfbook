'use strict';
const {fixtureTex}=require('./tex-webview-bugs.spec.cjs');
module.exports={fixtureTex,tests:[{
    id:'setup-error-without-pdf',name:'a compiler setup failure is visible when WPaper has no PDF or source map',async run(t){
        await t.page.reload();
        await t.waitFor(()=>window.__all?.some(m=>m.type==='ready'),null,{what:'empty viewer ready'});
        const message='latexmk failed its availability check (ETIMEDOUT). Compilation did not start. Press Compile to retry.';
        await t.post({type:'compileState',compiling:false});
        await t.post({type:'errorAnnotations',items:[{id:'setup',file:'/paper/main.tex',name:'main.tex',line:null,page:null,
            rects:[],exact:false,messages:[message]}]});
        await t.post({type:'status',kind:'err',text:message});
        await t.waitFor(()=>document.querySelector('#compileerrorlist .compile-error'),null,{what:'visible setup error'});
        t.assert(await t.page.locator('#compileerrorlist').isVisible(),'the setup failure is not hidden behind an empty page area');
        t.assert(await t.page.locator('#compileerrorlist').innerText().then(s=>s.includes('latexmk failed')),'the banner names the failed tool');
        t.assert(await t.eval(()=>!document.querySelector('#pages canvas')),'no successful PDF is required to display the failure');
    },
}]};
