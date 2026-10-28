'use strict';
const {fixtureTex}=require('./tex-webview-bugs.spec.cjs');
const item={id:'eq-test',role:'decl',kind:'display-equation',name:'eq:copy-without-thumbnail',
    at:{page:1,x:90,y:110,maxW:55,anchor:'right'},target:[]};
async function hover(t,chip=item){
    await t.post({type:'labels',generation:1,items:[chip]});
    await t.page.keyboard.down('Shift');
    await t.page.mouse.move(300,180);
    await t.waitFor(()=>document.querySelector('.lbc'),null,{what:'label badge'});
    await t.page.locator('.lbc').hover();
}
module.exports={fixtureTex,tests:[{
    id:'label-copy-before-preview',name:'Shift labels remain clickable before any equation thumbnail or target geometry exists',async run(t){
        await hover(t);await t.clear();
        await t.page.locator('.lbc').click({modifiers:['Shift']});
        const copied=await t.waitPosted('copyLabel');t.assert(copied.name===item.name,'copy does not wait for a preview');
        t.assert(await t.eval(()=>!document.querySelector('.lbcprev')),'no preview is required');
    },
},{id:'label-hover-survives-map-updates',name:'background label/map updates preserve the hovered badge through mouse-down and copy',async run(t){
    await hover(t);await t.eval(()=>{window.heldLabel=document.querySelector('.lbc');window.heldTop=window.heldLabel.style.top;
      window.labelEvents=[];for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,e=>window.labelEvents.push([type,e.target.className,e.target.dataset?.name]),true);});
    await t.clear();await t.page.mouse.down();
    for(let i=0;i<12;i++)await t.post({type:'labels',generation:1,items:i===3||i===8?[]:[{...item,id:'map-'+i,printed:String(i),
        at:{...item.at,y:110+i},target:i<5?[]:[{page:1,x:80,y:180,w:200,h:25}]}]});
    t.assert(await t.eval(()=>window.heldLabel.isConnected && document.querySelector('.lbc')===window.heldLabel),
        'the exact click target survives background enrichment');
    t.assert(await t.eval(()=>document.querySelector('.lbc').style.top===window.heldTop),'hovered label does not move under the pointer');
    await t.page.mouse.up();let copied;
    try{copied=await t.waitPosted('copyLabel');}catch(error){throw Error(error.message+' '+JSON.stringify(await t.eval(()=>window.labelEvents)));}
    t.assert(copied.name===item.name,'the original press still copies its label');
    await t.waitFor(()=>document.querySelector('.lbcprev img'),null,{what:'silently loaded equation preview'});
}},{id:'label-preview-jumps-queue',name:'hovered equation loads and copies while other background thumbnails are still pending',async run(t){
    await hover(t);await t.clear();
    await t.eval(()=>{
        for(let i=0;i<80;i++)window.postMessage({type:'crop',id:'background-'+i,
            rects:[{page:1,x:40+i*.01,y:100,w:500,h:250}],scale:2},'*');
    });
    await t.post({type:'labels',generation:1,items:[{...item,target:[{page:1,x:80,y:180,w:200,h:25}]}]});
    await t.waitFor(()=>document.querySelector('.lbcprev img'),null,{what:'priority equation preview'});
    const complete=(await t.posted('cropped')).filter(m=>String(m.id).startsWith('background-')).length;
    t.assert(complete<80,'the hovered equation does not wait for all background thumbnails');
    await t.page.locator('.lbc').click({modifiers:['Shift']});
    t.assert((await t.waitPosted('copyLabel')).name===item.name,'copy remains independent of pending thumbnails');
}}]};
