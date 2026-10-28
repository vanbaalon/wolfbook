'use strict';
const {fixtureTex}=require('./tex-webview-bugs.spec.cjs');
const p=require('../../../tex/tikzPalette');
const original=String.raw`\node[draw] (a) at (0,0) {A};`;
const updated=String.raw`\node[draw,fill=red!20] (a) at (1,0) {$\alpha$};`;
const palette={type:'tikzPalette',items:p.ITEMS.map(({id,label,icon,kind,section,text,feynman})=>({id,label,icon,kind,section,text:!!text,feynman:!!feynman})),
 catalogue:p.CATALOGUE,templates:p.TEMPLATES.map(({id,label})=>({id,label})),styles:p.STYLE_GROUPS,colors:p.COLORS,colorSets:p.COLOR_SETS};
async function seed(t,text=original,start=20){
 await t.eval(({text,start})=>{
  const api=window.__wbTikzTest,tz=api.tikz,key='1:'+start;
  const stmt={start,end:start+text.length,text,kind:'node',name:'a',at:{x:0,y:0},label:true,labelText:'A',options:['draw'],refs:[]};
  const pic={file:'/paper.tex',begin:0};const it={key,picture:1,stmt,paths:[],glyphs:[],box:[100,100,200,120]};
  tz.pages.set(1,{items:new Map([[key,it]]),pictures:new Map([[1,pic]])});tz.selection={page:1,keys:new Set([key]),primary:key};
  api.tikzInspector();
 },{text,start});
}
async function setup(t){
 await t.post({type:'engine',state:'live',keyMs:18});await t.page.locator('#tikztool').click();await t.post(palette);
 await t.waitFor(()=>!!document.querySelector('.tz-source textarea'),null,{what:'TikZ source section'});await seed(t);
}
module.exports={fixtureTex,tests:[{
 id:'tikz-source-draft',name:'source panel shows exact selected source and keeps textarea, draft, caret and focus through inspector refreshes',async run(t){
  await setup(t);const field=t.page.locator('.tz-source textarea');t.assert(await field.inputValue()===original,'raw source is shown');
  await t.waitPosted('tikzSelectSource',m=>m.ref.text===original && m.ref.start===20);
  await field.fill(updated);await t.eval(()=>{const ta=document.querySelector('.tz-source textarea');ta.setSelectionRange(8,13);window.__tikzArea=ta;});
  await t.clear();await t.eval(()=>{for(let i=0;i<10;i++)window.__wbTikzTest.tikzInspector();});
  t.assert(await t.eval(()=>{const ta=document.querySelector('.tz-source textarea');return ta===window.__tikzArea && ta.value.includes('fill=red') && ta.selectionStart===8 && ta.selectionEnd===13 && document.activeElement===ta;}),'no textarea replacement or lost typing/caret');
  t.assert((await t.posted('tikzEdit')).length===0,'typing alone does not compile');
  t.assert((await t.posted('tikzSelectSource')).length===0,'typing/refreshes do not repeatedly move the source cursor');
 },
},{
 id:'tikz-source-apply',name:'Apply sends guarded source and preserves later typing while the edit acknowledgement arrives',async run(t){
  await setup(t);const field=t.page.locator('.tz-source textarea');await field.fill(updated);await t.clear();
  await field.press('Control+Enter');const request=await t.waitPosted('tikzEdit',m=>m.op==='source');
  t.assert(request.text===updated && request.ref.text===original && request.picture.file==='/paper.tex','source edit is guarded by the exact original');
  const later=updated.replace('alpha','beta');await field.fill(later);
  await t.post({type:'tikzEdited',op:'source',key:request.key,ok:true,source:{file:'/paper.tex',start:20,text:updated},select:{file:'/paper.tex',start:20}});
  t.assert(await field.inputValue()===later,'later typing survives an older success reply');
  await seed(t,updated);await t.clear();await t.page.locator('.tz-source-apply').click();
  const next=await t.waitPosted('tikzEdit',m=>m.op==='source');t.assert(next.ref.text===updated && next.text===later,'next edit uses the acknowledged source');
 },
},{
 id:'tikz-source-conflict',name:'external changes preserve a draft and require Reload before replacing newer source',async run(t){
  await setup(t);const field=t.page.locator('.tz-source textarea');await field.fill(updated);
  const external=String.raw`\node[blue] (a) at (0,0) {External};`;await seed(t,external);
  t.assert(await field.inputValue()===updated,'external changes do not overwrite draft');
  t.assert(await t.page.locator('.tz-source-apply').isDisabled(),'conflicting source cannot be applied');
  await t.page.locator('.tz-source-reload').click();t.assert(await field.inputValue()===external,'Reload reads current source');
 },
},{
 id:'tikz-source-late-reply',name:'a late source-edit reply never reselects an older element',async run(t){
  await setup(t);await t.page.locator('.tz-source textarea').fill(updated);await t.page.locator('.tz-source-apply').click();
  const request=await t.waitPosted('tikzEdit',m=>m.op==='source');
  const other=String.raw`\draw (0,0) -- (2,0);`;await seed(t,other,100);
  await t.post({type:'tikzEdited',op:'source',key:request.key,ok:true,source:{file:'/paper.tex',start:20,text:updated},select:{file:'/paper.tex',start:20}});
  t.assert(await t.page.locator('.tz-source textarea').inputValue()===other,'current source remains selected');
  t.assert(await t.eval(()=>window.__wbTikzTest.tikz.selection.primary==='1:100' && !window.__wbTikzTest.tikz.pending),'late replies cannot change selection');
 },
}]};
