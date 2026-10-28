'use strict';
const fixtureTex=String.raw`\documentclass{article}
\begin{document}
\section{First}
First body.
\newpage
\section{Second}
Second body.
\newpage
\section{Third}
Third body.
\end{document}`;
const tests=[{
    id:'contents-navigation',name:'Contents clicks navigate distant headings even when editor follow is paused',
    async run(t){
        const first=t.word('First'),third=t.word('Third');
        await t.post({type:'navigationOwner',owner:'review'});
        const items=[{kind:'section',key:'first',file:'fx.tex',line:3,headEnd:3,spanEnd:6,title:'First',number:'1',level:2,
            page:1,x:first.x,y:first.y,w:first.w,h:first.h},
            {kind:'section',key:'third',file:'fx.tex',line:9,headEnd:9,spanEnd:11,title:'Third',number:'3',level:2,
                page:3,startPage:3,pageApproximate:true,x:0,y:null,w:0,h:0}];
        await t.post({type:'sections',generation:1,items,pageWidth:t.fixture.pages[0].width});
        await t.page.locator('#outline').click();
        await t.waitFor(()=>!!document.querySelector('.np-row[data-line="9"]'),null,{what:'Contents entry'});
        t.assert(await t.eval(()=>document.querySelector('.np-row[data-line="9"] .np-page').textContent)==='p.3 ≈',
            'page-only heading entries disclose their precision');
        await t.page.locator('.np-row[data-line="9"] .np-title').click();
        await t.waitPosted('revealSection',m=>m.line===9&&m.file==='fx.tex');
        const rect={page:3,x:third.x,y:third.y,w:third.w,h:third.h};
        await t.post({type:'navigateTo',generation:1,page:3,rects:[rect],label:'section · p.3'});
        await t.waitFor(()=>document.querySelector('main').scrollTop>document.querySelector('.page[data-page="2"]').offsetTop,
            null,{what:'explicit navigation past page two'});
        t.assert(await t.eval(()=>document.querySelector('#where').textContent)==='section · p.3','the destination is reported');
        await t.post({type:'navigateTo',generation:1,page:1,rects:[],label:'section · p.1 ≈'});
        await t.waitFor(()=>document.querySelector('main').scrollTop<50,null,{what:'page-only destination remains navigable'});
        await t.post({type:'navigateTo',generation:999,page:3,rects:[rect],label:'wrong generation'});
        await t.sleep(150);
        t.assert(await t.eval(()=>document.querySelector('main').scrollTop)<50,'stale navigation cannot move the page');
    },
}];
module.exports={fixtureTex,tests};
