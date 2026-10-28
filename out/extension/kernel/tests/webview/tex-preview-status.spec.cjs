'use strict';
const {fixtureTex}=require('./tex-webview-bugs.spec.cjs');
module.exports={fixtureTex,tests:[{
 id:'preview-recovery-explained',name:'preview restart explains its state without crossing out Pro or disabling editing',async run(t){
  await t.post({type:'engine',state:'settling',interactive:true,previewError:'The live preview engine is restarting; retrying in 0.5 s',previewErrorKind:'producer'});
  await t.waitFor(()=>document.querySelector('#probadge').dataset.fallback==='true',null,{what:'preview failure'});
  t.assert(await t.eval(()=>{
   const badge=document.querySelector('#probadge'),label=badge.querySelector('.pro-state');
   return getComputedStyle(label).display!=='none' && label.textContent==='preview paused' &&
    !getComputedStyle(badge.querySelector('b')).textDecorationLine.includes('line-through') &&
    badge.title.includes('Pro remains on') && badge.title.includes('restarting') && !document.querySelector('#tikztool').hidden;
  }),'failure is explained and Pro editing remains on');
  await t.post({type:'engine',state:'live',interactive:true});
  await t.waitFor(()=>document.querySelector('#probadge').dataset.fallback==='false',null,{what:'preview recovered'});
  t.assert(await t.eval(()=>getComputedStyle(document.querySelector('#probadge .pro-state')).display==='none'),'healthy state returns to compact badge');
 },
},{id:'preview-source-error-explained',name:'source errors identify the reason without implying Pro is switched off',async run(t){
 await t.post({type:'engine',state:'settling',interactive:true,previewError:'Line 42: Undefined control sequence.',previewErrorKind:'source'});
 await t.waitFor(()=>document.querySelector('#probadge .pro-state').textContent==='source error',null,{what:'source error label'});
 t.assert(await t.eval(()=>document.querySelector('#probadge').title.includes('Line 42')),'line and error are retained');
}}]};
