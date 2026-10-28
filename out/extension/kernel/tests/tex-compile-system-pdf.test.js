'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeVscodeStub,withVscodeStub}=require('./_stub-vscode');
const stub=makeVscodeStub();
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'),stub);
function fixture(){
 const v=Object.create(TexViewer.prototype),order=[],messages=[];
 Object.assign(v,{root:'/paper/My résumé.tex',_post:m=>messages.push(m),
  refresh:async()=>order.push('refresh'),coord:{build:async(doc,opts)=>{assert.deepEqual(opts,{force:true,firstPass:true});order.push('compile');return {generation:{pageCount:2,errors:0,warnings:0}};}}});
 stub.workspace.openTextDocument=async()=>({});
 stub.commands.executeCommand=async(name,opts)=>{assert.equal(name,'wolfbook.tex.exportPdf');assert.equal(opts.force,true);assert.equal(opts.firstPass,undefined);order.push('export');return {ok:true,target:opts.target};};
 stub.env.openExternal=async uri=>{order.push('system');assert.equal(uri.fsPath,'/paper/My résumé.pdf');assert.equal(uri.scheme,'file');return true;};
 return {v,order,messages};
}
test('modifier Compile opens the completed exported PDF in the OS application',async()=>{
 const {v,order,messages}=fixture();await v.rebuild({exportPdf:true});
 assert.deepEqual(order,['export','system','refresh']);assert.ok(messages.some(m=>m.kind==='ok'&&/system viewer/.test(m.text)));
});
test('normal Compile updates WPaper without launching an external application',async()=>{
 const {v,order}=fixture();await v.rebuild();assert.deepEqual(order,['compile','refresh']);
});
test('failed/cancelled exports and a changed paper never open a previous PDF',async()=>{
 for(const mode of ['failed','cancelled','switched']) {
  const {v,order}=fixture();stub.commands.executeCommand=async()=>{
   order.push('export');if(mode==='switched')v.root='/other.tex';
   return mode==='failed' ? {ok:false} : mode==='cancelled' ? undefined : {ok:true,target:'/paper/My résumé.pdf'};
  };
  await v.rebuild({exportPdf:true});assert.ok(!order.includes('system'));
 }
});
test('OS launch refusal or error preserves a successful export and reports only the opening failure',async()=>{
 for(const throwing of [false,true]) {
  const {v,order,messages}=fixture();stub.env.openExternal=async()=>{order.push('system');if(throwing)throw Error('No PDF app');return false;};
  await v.rebuild({exportPdf:true});assert.deepEqual(order,['export','system','refresh']);
  assert.ok(messages.some(m=>m.kind==='warn'&&/PDF written:.*could not open in system viewer/.test(m.text)));
  assert.ok(!messages.some(m=>/could not compile/.test(m.text)));
 }
});
