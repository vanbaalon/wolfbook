'use strict';
const base=require('./tex-webview-bugs.spec.cjs');
async function setup(t){
 await t.post({type:'cellBoundaries',generation:1,items:[{page:1,x:72,y:140,w:400,h:0}]});
}
const visible=t=>t.page.locator('.paper-cell-boundary').count();
module.exports={fixtureTex:base.fixtureTex,tests:[
 ...base.tests.filter(t=>['shift-cells-mini','shift-cells-paper'].includes(t.id)),
 {
  id:'shift-modifier-order',name:'Command, Control and Alt cancel Shift reveal in either key order, in both engines',async run(t){
   await setup(t);
   for(const pro of [false,true]){
    await t.post({type:'engine',state:pro?'live':'disabled',interactive:pro});
    for(const modifier of ['Meta','Control','Alt']){
     await t.page.keyboard.down('Shift');t.assert(await visible(t)===1,'plain Shift reveals cell edges');
     await t.page.keyboard.down(modifier);t.assert(await visible(t)===0,`${modifier} cancels an existing reveal`);
     await t.page.keyboard.up('Shift');await t.page.keyboard.up(modifier);
     await t.clear();await t.page.keyboard.down(modifier);await t.page.keyboard.down('Shift');
     t.assert(await visible(t)===0,`Shift after ${modifier} cannot activate reveal`);
     t.assert((await t.posted('labelsWanted')).length===0,'modifier shortcuts request no label map');
     await t.page.keyboard.up('Shift');await t.page.keyboard.up(modifier);
    }
   }
  },
 },{
  id:'shift-modifier-pointer',name:'pointer modifier tracking cancels Shift and never reactivates it during a shortcut',async run(t){
   await setup(t);
   for(const type of ['pointermove','pointerdown','pointerenter']){
    for(const modifier of ['metaKey','ctrlKey','altKey']){
     const pointer=mods=>t.eval(({type,mods})=>document.querySelector('main').dispatchEvent(new PointerEvent(type,{bubbles:true,shiftKey:true,...mods})),{type,mods});
     await pointer({});t.assert(await visible(t)===1,'plain Shift over the page reveals edges');
     await pointer({[modifier]:true});t.assert(await visible(t)===0,`${type} with ${modifier} cancels reveal`);
     await pointer({[modifier]:true});t.assert(await visible(t)===0,'continued pointer motion cannot reactivate it');
    }
   }
  },
 },{
  id:'shift-modifier-textarea',name:'handled textarea shortcuts still cancel Shift without intercepting the shortcut',async run(t){
   await setup(t);
   await t.eval(()=>{
    const ta=document.createElement('textarea');ta.id='shortcut-test';document.body.appendChild(ta);
    window.__shortcutKeys=[];
    ta.addEventListener('keydown',e=>{window.__shortcutKeys.push({key:e.key,prevented:e.defaultPrevented});e.stopPropagation();});ta.focus();
   });
   await t.page.keyboard.down('Shift');t.assert(await visible(t)===1,'Shift in a textarea reveals edges');
   await t.page.keyboard.down('Meta');t.assert(await visible(t)===0,'capturing listener sees a handled Command key');
   await t.page.keyboard.up('Shift');await t.page.keyboard.up('Meta');
   t.assert(await t.eval(()=>window.__shortcutKeys.some(e=>e.key==='Meta'&&!e.prevented)),'shortcut reaches the focused editor unchanged');
  },
 },
]};
