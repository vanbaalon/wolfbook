'use strict';
const fixtureTex=String.raw`\documentclass{article}
\begin{document}
\section{Introduction}
First paragraph.
\subsection{Numbered child}
Second paragraph.
\subsection*{Unnumbered child}
Third paragraph.
\end{document}`;
async function show(t){
    await t.post({type:'sections',generation:1,items:[
        {kind:'section',key:'intro',file:'fx.tex',line:3,title:'Introduction',number:'1',level:2,page:1,foldable:true},
        {kind:'section',key:'child',file:'fx.tex',line:5,title:'Numbered child',number:'1.1',level:3,page:1,foldable:true},
        {kind:'section',key:'starred',file:'fx.tex',line:7,title:'Unnumbered child',number:null,level:3,page:1,foldable:true}
    ]});
    await t.page.locator('#outline').click();
    await t.waitFor(()=>!document.querySelector('#navpanel').hidden,null,{what:'Contents panel'});
}
module.exports={fixtureTex,tests:[{
    id:'contents-outside-dismiss',name:'outside presses dismiss Contents without swallowing toolbar actions',async run(t){
        await show(t);
        const p=await t.eval(()=>{const m=document.querySelector('main').getBoundingClientRect();return{x:m.left+8,y:m.top+30};});
        await t.clear();await t.page.mouse.click(p.x,p.y);
        t.assert(await t.eval(()=>document.querySelector('#navpanel').hidden),'clicking outside closes Contents');
        t.assert(await t.eval(()=>document.querySelector('#outline').getAttribute('aria-pressed')==='false'),'toolbar state follows dismissal');
        await t.page.locator('#outline').click();await t.page.locator('#findtool').click();
        t.assert(await t.eval(()=>document.querySelector('#navpanel').hidden),'a toolbar press also dismisses Contents');
        t.assert(await t.eval(()=>!document.querySelector('#findbar').hidden),'the same press opens Find normally');
    }
},{
    id:'contents-inside-controls',name:'inside controls and resize do not dismiss Contents; the toggle still closes it',async run(t){
        await show(t);await t.clear();
        await t.page.locator('.np-row[data-line="3"] [data-nav-act="fold"]').click();
        await t.waitPosted('sectionFold',m=>m.key==='intro');
        t.assert(await t.eval(()=>!document.querySelector('#navpanel').hidden),'folding leaves the panel open');
        await t.page.locator('.np-head').click();
        t.assert(await t.eval(()=>!document.querySelector('#navpanel').hidden),'clicking the title stays inside');
        const p=await t.eval(()=>{const r=document.querySelector('#navpanel').getBoundingClientRect();return {x:r.right-4,y:r.bottom-4};});
        await t.page.mouse.move(p.x,p.y);await t.page.mouse.down();await t.page.mouse.move(p.x-20,p.y+10);await t.page.mouse.up();
        t.assert(await t.eval(()=>!document.querySelector('#navpanel').hidden),'resizing retains the panel');
        await t.page.locator('#outline').click();
        t.assert(await t.eval(()=>document.querySelector('#navpanel').hidden),'toggle closes instead of dismissing and reopening');
    }
},{
    id:'contents-printed-numbers',name:'Contents retains printed section numbers while starred headings stay unnumbered',async run(t){
        await show(t);
        const nums=await t.eval(()=>[...document.querySelectorAll('.np-num')].map(e=>e.textContent));
        t.assert(JSON.stringify(nums)===JSON.stringify(['1','1.1','·']),'numbered headings carry their actual hierarchy: '+JSON.stringify(nums));
    }
}]};
