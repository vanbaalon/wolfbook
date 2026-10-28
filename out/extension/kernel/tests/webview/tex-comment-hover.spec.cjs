'use strict';
const fixtureTex=String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\noindent A short first line.
\par\bigskip\noindent Another short paragraph.
\end{document}`;
async function offer(t,word) {
    if (!(await t.eval(()=>document.body.classList.contains('comments-open')))) await t.page.locator('#commentsbutton').click();
    const w=t.word(word),p=await t.toClient(1,w.x+w.w/2,w.y+w.h/2);
    await t.page.mouse.move(p.x,p.y);
    await t.waitFor(()=>!!document.querySelector('.comment-marker.add'),null,{what:'comment affordance'});
    return p;
}
async function markerPoint(t){return t.eval(()=>{const e=document.querySelector('.comment-marker.add'),r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});}
module.exports={fixtureTex,tests:[{
 id:'comment-hover-cross-gap',name:'a short paragraph comment button stays reachable across the long blank margin',async run(t){
    const origin=await offer(t,'first'),button=await markerPoint(t);
    t.assert(button.x-origin.x>150,'fixture has a substantial whitespace gap');
    await t.eval(()=>{window.__commentOffered=document.querySelector('.comment-marker.add');});
    const mid={x:origin.x+(button.x-origin.x)*.75,y:origin.y+(button.y-origin.y)*.75};
    await t.page.mouse.move(mid.x,mid.y,{steps:20});await t.sleep(350);
    t.assert(await t.eval(()=>window.__commentOffered.isConnected),'the button survives crossing whitespace beyond the text hit threshold');
    await t.page.mouse.move(button.x,button.y,{steps:10});await t.sleep(350);
    t.assert(await t.eval(()=>window.__commentOffered===document.querySelector('.comment-marker.add')&&window.__commentOffered.matches(':hover')),'the original button remains hovered, without relocating or being replaced');
    await t.clear();await t.page.mouse.click(button.x,button.y);
    const click=await t.waitPosted('click',m=>m.commentTarget);
    const word=t.word('first');
    t.assert(Math.abs(click.yTopBp-(word.y+word.h/2))<4,'the click targets the original line, not the right-hand margin');
    t.assert(await t.eval(()=>document.querySelector('.comment-marker.add.pending')?.isConnected),'the pending composer keeps its anchor');
 }
},{
 id:'comment-hover-retarget',name:'moving onto another paragraph updates the button and hiding comments clears it',async run(t){
    await offer(t,'first');const before=await markerPoint(t);
    const word=t.word('Another'),p=await t.toClient(1,word.x+word.w/2,word.y+word.h/2);
    await t.page.mouse.move(p.x,p.y,{steps:4});
    await t.waitFor(y=>{const e=document.querySelector('.comment-marker.add');return e&&Math.abs(e.getBoundingClientRect().top+e.offsetHeight/2-y)<3;},p.y,{what:'next paragraph marker'});
    const after=await markerPoint(t);t.assert(after.y>before.y+10,'the marker follows the next paragraph');
    await t.page.locator('#commentsbutton').click();
    t.assert(await t.eval(()=>!document.querySelector('.comment-marker.add')),'hiding comments removes the affordance');
 }
},{
 id:'comment-hover-queued-frame',name:'entering the button cancels a queued hover before it can replace the target',async run(t){
    await offer(t,'first');
    const w=t.word('Another'),p=await t.toClient(1,w.x+w.w/2,w.y+w.h/2);
    await t.eval(p=>{
        const button=document.querySelector('.comment-marker.add');window.__commentOffered=button;
        const page=document.querySelector('.page[data-page="1"]');
        page.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:p.x,clientY:p.y}));
        button.dispatchEvent(new PointerEvent('pointerenter',{clientX:button.getBoundingClientRect().left+4,clientY:button.getBoundingClientRect().top+4}));
    },p);
    await t.sleep(200);
    t.assert(await t.eval(()=>window.__commentOffered===document.querySelector('.comment-marker.add')),'an older hover cannot replace the button under the pointer');
 }
},{
 id:'comment-hover-inset',name:'the comment button remains reachable at high zoom when pinned inside the viewport',async run(t){
    await t.post({type:'engine',state:'live',keyMs:18});
    for(let i=0;i<4;i++) await t.page.locator('#zoomin').click();
    await t.sleep(400);
    const origin=await offer(t,'first'),button=await markerPoint(t);
    t.assert(await t.eval(()=>document.querySelector('.comment-marker.add').classList.contains('inset')),'high zoom places the button inside the reader edge');
    await t.eval(()=>{window.__commentOffered=document.querySelector('.comment-marker.add');});
    await t.page.mouse.move(button.x,button.y,{steps:30});await t.sleep(250);
    t.assert(await t.eval(()=>window.__commentOffered===document.querySelector('.comment-marker.add')&&window.__commentOffered.matches(':hover')),'the inset button is reachable in live mode');
    const bounds=await t.eval(()=>{const b=document.querySelector('.comment-marker.add').getBoundingClientRect(),m=document.querySelector('main').getBoundingClientRect();return {button:b.toJSON(),main:m.toJSON()};});
    t.assert(bounds.button.right<=bounds.main.right,'the button fits in the viewport');
 }
}]};
