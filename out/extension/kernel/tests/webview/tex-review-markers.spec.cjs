'use strict';

const fixtureTex=String.raw`\documentclass{article}
\begin{document}
First page with a correction.
\newpage
Second page with more corrections.
\newpage
Third page with further corrections.
\end{document}`;

const tests=[{
    id:'review-navigation-markers',
    name:'every ready correction with a known page gets a navigation marker in both modes',
    async run(t) {
        for(const pro of [false,true]) {
            await t.post({type:'engine',state:pro?'live':'off',keyMs:18});
            const hunks=Array.from({length:21},(_,i)=>({id:`approx-${i}`,page:i%3+1,rects:[],ready:true,
                verb:'change',name:`Correction ${i}`,startLine:i+1,endLine:i+2,
                section:{number:`${i+1}`},ourText:'new',theirText:'old'}));
            const word=t.word('Third');
            hunks.push({id:'exact',page:3,ready:true,verb:'change',ourText:'Third',theirText:'Last',
                rects:[{page:3,x:word.x,y:word.y,w:word.w,h:word.h}]},
                {id:'arriving',page:2,ready:false,rects:[],ourText:'pending',theirText:'old'},
                {id:'unknown',ready:true,rects:[],ourText:'unknown',theirText:'old'});
            await t.post({type:'review',session:{file:'fx.tex',pending:hunks.length,generation:1,
                groups:[{id:'changes',hunks}]}});
            await t.waitFor(()=>document.querySelectorAll('.bookmark-rail .bookmark-revision').length===22,
                null,{what:'all 22 located correction chips'});
            t.assert(await t.eval(()=>[...document.querySelectorAll('.bookmark-revision button:first-child')]
                .filter(b=>b.textContent.includes('≈')).length)===21,'page-only chips are clearly approximate');
            t.assert(await t.eval(()=>!document.querySelector('[data-bookmark="revision:arriving"]') &&
                !document.querySelector('[data-bookmark="revision:unknown"]')),'unready and unknown locations are not guessed');
            t.assert(await count(t,'.bookmark-marker')===0,'correction navigation is not a saved personal bookmark');
            await t.clear();
            await t.page.locator('[data-bookmark="revision:approx-0"] button').click();
            await t.waitPosted('reviewAction',m=>m.action==='show' && m.id==='approx-0');
            t.assert(!(await t.posted('reviewAction')).some(m=>m.action.startsWith('keep')),'navigation never accepts a change');
            if(pro)await t.page.screenshot({path:'/Users/k0959535/Wolfbook Audits/2026-10-09-review-markers/navigation-chips.png'});
            await t.post({type:'review',session:{file:'fx.tex',pending:hunks.length,generation:999,groups:[{id:'changes',hunks}]}});
            await t.waitFor(()=>document.querySelectorAll('.bookmark-revision').length===0,null,{what:'stale locations leave navigation'});
            await t.post({type:'review',session:{file:'fx.tex',pending:0,generation:1,groups:[]}});
            await t.waitFor(()=>document.querySelectorAll('.bookmark-revision').length===0,null,{what:'accepted corrections leave navigation'});
        }
    },
},{
    id:'six-approximate-markers',
    name:'six approximate corrections remain bookmarked beyond the displayed page at 208 percent zoom',
    async run(t) {
        await t.post({type:'blank'});
        await t.open(185,{restoreView:{scale:2.08,fit:false}});
        t.assert(await t.eval(()=>document.querySelector('#zoom').textContent)==='208%','reproduce the screenshot zoom');
        const hunks=Array.from({length:6},(_,i)=>({id:`six-${i}`,ready:true,page:i<2?2:3,rects:[],
            where:'page',verb:i===0?'del':i===2?'add':'change',name:'paragraph',startLine:i+1,endLine:i+2,
            section:{number:i<2?'5.3':`5.${i+2}`},ourText:i===0?'':'New text.',theirText:i===2?'':'Old text.'}));
        await t.post({type:'review',session:{file:'fx.tex',generation:185,pending:6,
            census:'6 changes · 6 approximate',groups:[{id:'six',hunks}]}});
        await t.waitFor(()=>document.querySelectorAll('#bookmark-below .bookmark-revision').length===6,
            null,{what:'six approximate correction links in the lower rail'});
        t.assert(await t.eval(()=>document.querySelector('#bookmark-below .bookmark-direction').textContent==='↓ 6'),
            'the arrow counts all six corrections');
        await t.page.locator('[data-bookmark="revision:six-0"] button').click();
        await t.waitPosted('reviewAction',m=>m.action==='show'&&m.id==='six-0');
    },
}];
async function count(t,selector){return t.eval(s=>document.querySelectorAll(s).length,selector);}
module.exports={fixtureTex,tests};
