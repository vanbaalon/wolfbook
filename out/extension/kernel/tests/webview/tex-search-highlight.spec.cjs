'use strict';
const fixtureTex=String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\section{Analytic continuation and the Baxter equation}
\Large\noindent iiiii WWWWWW Baxter iiiii WWWWWW.
\par\bigskip\noindent\textit{Proportional italic Baxter with descenders gyp.}
\end{document}`;
module.exports={fixtureTex,tests:[{
 id:'search-measured-ink',name:'search boxes follow the actual ink of bold headings and proportional/italic text at multiple zooms',async run(t){
  const words=t.fixture.pages[0].words.filter(w=>w.text==='Baxter');t.assert(words.length===3,'fixture has three Baxter matches');
  await t.page.locator('#findtool').click();await t.page.locator('#findinput').fill('baxter');
  for(let zoom=0;zoom<3;zoom++){
   await t.waitFor(()=>document.querySelectorAll('.find-hit').length===3,null,{what:'three search marks'});
   for(const word of words){
    const result=await t.eval(({word,width})=>{
     const wrap=document.querySelector('.page[data-page="1"]'),canvas=wrap.querySelector('canvas');
     const sx=canvas.width/width,css=canvas.clientWidth/canvas.width;
     const ctx=canvas.getContext('2d'),data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
     let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
     for(let y=Math.max(0,Math.floor((word.y-3)*sx));y<Math.min(canvas.height,Math.ceil((word.y1+3)*sx));y++)
      for(let x=Math.max(0,Math.floor((word.x-2)*sx));x<Math.min(canvas.width,Math.ceil((word.x1+2)*sx));x++){
       const i=(y*canvas.width+x)*4;
       if(data[i]<100 && data[i+1]<100 && data[i+2]<100){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}
      }
     const ink={x:left*css,y:top*css,w:(right-left)*css,h:(bottom-top)*css};
     const hits=[...wrap.querySelectorAll('.find-hit')].map(e=>({x:parseFloat(e.style.left),y:parseFloat(e.style.top),w:parseFloat(e.style.width),h:parseFloat(e.style.height)}));
     const hit=hits.sort((a,b)=>Math.abs(a.y+a.h/2-ink.y-ink.h/2)-Math.abs(b.y+b.h/2-ink.y-ink.h/2))[0];
     return {ink,hit,scale:canvas.clientWidth/width};
    },{word,width:t.fixture.pages[0].width});
    const {ink,hit}=result;
    t.assert(Number.isFinite(ink.x),'actual word pixels are readable');
    const errors=[hit.x-(ink.x-1),hit.y-(ink.y-1),hit.x+hit.w-(ink.x+ink.w+1),hit.y+hit.h-(ink.y+ink.h+1)];
    t.assert(errors.every(e=>Math.abs(e)<2.8),`search box must hug printed ink at zoom ${zoom}: ${JSON.stringify({word,...result})}, errors ${errors}`);
   }
   if(zoom<2){
    const width=await t.eval(()=>document.querySelector('.page canvas').width);
    await t.page.locator('#zoomin').click();
    await t.waitFor(w=>document.querySelector('.page canvas')?.width>w,width,{what:'zoomed PDF canvas'});
   }
  }
 }
},{
 id:'search-live-ink',name:'live search uses proportional glyph positions and outline bounds for an ActualText run',async run(t){
  const sp=65536,adv={W:1000,i:100,B:700,a:500,x:450,t:250,e:450,r:300},text='WWiiBaxter';
  let x=20;const glyphs=Array.from(text,c=>{const result=[c.charCodeAt(0),Math.round(x*sp),80*sp];x+=adv[c]*.02;return result;});
  const font='search-ink-font',outlines={};
  for(const c of new Set(text))outlines[c.charCodeAt(0)]={text:c,units_per_em:1000,advance:adv[c],path:`M20 0L${adv[c]-40} 0L${adv[c]-40} 700L20 700Z`};
  await t.post({type:'engine',state:'live',keyMs:18});await t.clear();
  await t.post({type:'txdlPage',generation:2,page:1,changed:true,identity:'search-live',
   txdl:{fonts:[{definition_digest:font,size_sp:20*sp}],ops:[{op:'glyphs',font,text,glyphs}]}});
  const request=await t.waitPosted('txdlOutlines');await t.post({type:'txdlOutlines',id:request.id,glyphs:outlines});
  await t.waitFor(()=>!!document.querySelector('canvas.txdl-overlay'),null,{what:'live glyph canvas'});
  await t.page.locator('#findtool').click();await t.page.locator('#findinput').fill('baxter');
  await t.waitFor(()=>document.querySelectorAll('.find-hit').length===1,null,{what:'live search match'});
  const result=await t.eval(({width})=>{
   const canvas=document.querySelector('canvas.txdl-overlay'),sx=canvas.width/width,css=canvas.clientWidth/canvas.width;
   const bp=72/72.27,box={x:(72.27+64)*bp,y:(72.27+66)*bp,w:55*bp,h:14*bp};
   const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
   let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
   for(let y=Math.floor((box.y-2)*sx);y<Math.ceil((box.y+box.h+2)*sx);y++)
    for(let x=Math.floor(box.x*sx);x<Math.ceil((box.x+box.w+2)*sx);x++){
     const i=(y*canvas.width+x)*4;if(data[i]<100 && data[i+1]<100 && data[i+2]<100){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}
    }
   const e=document.querySelector('.find-hit'),hit={x:parseFloat(e.style.left),y:parseFloat(e.style.top),w:parseFloat(e.style.width),h:parseFloat(e.style.height)};
   return {ink:{x:left*css,y:top*css,w:(right-left)*css,h:(bottom-top)*css},hit};
  },{width:t.fixture.pages[0].width});
  const {ink,hit}=result,errors=[hit.x-(ink.x-1),hit.y-(ink.y-1),hit.x+hit.w-(ink.x+ink.w+1),hit.y+hit.h-(ink.y+ink.h+1)];
  t.assert(errors.every(e=>Math.abs(e)<2.8),`live search must follow the outline ink: ${JSON.stringify(result)}, errors ${errors}`);
 }
}]};
