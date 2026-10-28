'use strict';
const { fixtureTex }=require('./tex-webview-bugs.spec.cjs');
const math=String.raw`\begin{equation}
  E = m c^2
\end{equation}`;
const rect={page:1,x:110,y:240,w:340,h:26};

const snapshot=t=>t.eval(()=>{
    const c=document.querySelector('.editcard'),ta=c.querySelector('textarea');
    return {top:parseFloat(c.style.top),left:parseFloat(c.style.left),width:c.style.width,
        scroll:document.querySelector('main').scrollTop,start:ta.selectionStart,end:ta.selectionEnd,
        focus:document.activeElement===ta};
});

const tests=['below','above','overlap'].map(side=>({
    id:`equation-still-${side}`,name:`the equation editor ${side} stays in place through typing, partial math maps and full PDF anchors`,
    async run(t){
        const k=await t.pxPerBp(1);
        const pageHeight=await t.eval(()=>document.querySelector('.page[data-page="1"]').clientHeight);
        const top=side==='above' ? 90*k : side==='overlap' ? 230*k : 286*k;
        await t.post({type:'editOpen',editId:12,label:'display-equation eq:x',file:'fx.tex',text:math,
            rects:[rect],page:1,pos:{fx:0.1,fy:top/pageHeight}});
        await t.waitFor(()=>!!document.querySelector('.editcard textarea'),null,{what:'equation editor'});
        await t.page.locator('.editcard textarea').focus();await t.page.keyboard.press('ArrowDown');
        const first=await snapshot(t);
        for(let i=0;i<6;i++){
            await t.page.keyboard.type('x');
            const before=await snapshot(t);
            t.near(before.top,first.top,0.5,'the keystroke itself keeps the card still');
            t.near(before.scroll,first.scroll,0.5,'the keystroke itself does not move the paper');
            // A partial equation exposes different glyph/row bounds while a
            // command is typed; a completed fraction can be much taller too.
            await t.post({type:'editAnchor',editId:12,live:true,
                rects:[{...rect,y:rect.y+(i%2 ? 40 : -25),h:i%2 ? 12 : 90}]});
            await t.sleep(30);const after=await snapshot(t);
            t.near(after.top,first.top,0.5,'equation ink changes do not move the card');
            t.near(after.left,first.left,0.5,'the horizontal placement is steady');
            t.near(after.scroll,before.scroll,0.5,'typing and redraw do not scroll the viewer');
            t.assert(after.start===before.start && after.end===before.end && after.focus,'typing keeps its caret and focus');
        }
        await t.open(2);
        await t.post({type:'editAnchor',editId:12,rects:[{...rect,y:300,h:65}]});await t.sleep(40);
        t.near((await snapshot(t)).top,first.top,0.5,'the full compile also preserves the active equation editor');
    },
}));

tests.push({id:'equation-modes-still',name:'align, starred display math and bracket forms keep their placement during temporarily incomplete syntax',
    async run(t){
        for(const [i,text] of [String.raw`\begin{align*}a&=b\\c&=d\end{align*}`,
            String.raw`% a display with a comment
\[\frac{a}{b}\]`,String.raw`$$ a = b $$`].entries()){
            await t.post({type:'editClosed'});
            await t.post({type:'editOpen',editId:20+i,label:'blocks',file:'fx.tex',text,rects:[rect],page:1});
            await t.waitFor(()=>!!document.querySelector('.editcard textarea'),null,{what:'math editor'});
            const before=await snapshot(t);
            await t.eval(()=>{const ta=document.querySelector('.editcard textarea');ta.focus({preventScroll:true});ta.setSelectionRange(0,ta.value.length);});
            await t.page.keyboard.type('\\fra');
            await t.post({type:'editAnchor',editId:20+i,live:true,rects:[{...rect,y:330,h:90}]});await t.sleep(30);
            t.near((await snapshot(t)).top,before.top,0.5,'incomplete source still belongs to the same equation editor');
        }
    },
});

tests.push({id:'equation-drag-still',name:'dragging an equation editor changes its chosen position without subsequent redraws overriding it',
    async run(t){
        await t.post({type:'editOpen',editId:40,label:'equation',file:'fx.tex',text:math,rects:[rect],page:1});
        await t.waitFor(()=>!!document.querySelector('.editcard textarea'),null,{what:'equation editor'});
        const p=await t.eval(()=>{const r=document.querySelector('.ec-title').getBoundingClientRect();return {x:r.left+20,y:r.top+r.height/2};});
        const before=await snapshot(t);
        await t.page.mouse.move(p.x,p.y);await t.page.mouse.down();
        await t.page.mouse.move(p.x,p.y-30,{steps:4});await t.page.mouse.up();
        const placed=await snapshot(t);t.near(placed.top,before.top-30,0.5,'the editor can still be moved by hand');
        await t.post({type:'editAnchor',editId:40,live:true,rects:[{...rect,y:310,h:90}]});await t.sleep(30);
        t.near((await snapshot(t)).top,placed.top,0.5,'fresh math bounds preserve the chosen position');
    },
});

module.exports={fixtureTex,tests};
