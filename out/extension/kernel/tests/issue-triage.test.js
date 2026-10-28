'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeVscodeStub,withVscodeStub}=require('./_stub-vscode');
const stub=makeVscodeStub();
const configs={};
stub.workspace.getConfiguration=ns=>configs[ns] || {get:(_key,fallback)=>fallback,inspect:()=>undefined};
const compat=withVscodeStub(()=>require('../../config-compat'),stub);
test('registered defaults win over call-site defaults, while explicit legacy settings still migrate',()=>{
 const primary={defaultValue:false},legacy={};
 const config=values=>({inspect:()=>values,get:(_name,fallback)=>values.globalLanguageValue??values.workspaceValue??values.defaultValue??fallback});
 configs.wolfbook=config(primary);configs.wolfram=config(legacy);
 assert.equal(compat.getSetting('notebook.kernelEnabled',true),false);
 legacy.workspaceValue=true;assert.equal(compat.getSetting('notebook.kernelEnabled',false),true);
 primary.globalLanguageValue=false;assert.equal(compat.getSetting('notebook.kernelEnabled',true),false);
 delete configs.wolfbook;delete configs.wolfram;
});
test('pretty JSON responses have meaningful messages and retain the complete payload',()=>{
 const {WolframMCPServer}=withVscodeStub(()=>require('../../claude-mcp/server'),stub);
 const server=new WolframMCPServer(new Map(),[]);
 for(const name of ['wolfbook_getNotebookContext','wolfbook_saveNotebook','wolfbook_operationStatus']){
  const data={ok:true,cells:[{cell_id:'c1',source:'x = 37',resultPreview:'37'}],progress:[{message:'saved'}]};
  const result=server._finalizeToolResult({content:[{type:'text',text:JSON.stringify(data,null,2)}]},name,'test');
  assert.equal(result.structuredContent.message,`${name} completed.`);
  assert.deepEqual(result.structuredContent.data,data);
  assert.deepEqual(JSON.parse(result.content[0].text).data,data);
 }
});
test('notebook LSP URIs round-trip without collisions; real file URIs are unchanged',()=>{
 class URI {
  constructor(value){this.url=new URL(value);this.scheme=this.url.protocol.slice(0,-1);this.path=decodeURI(this.url.pathname);}
  static parse(value){return new URI(value);}
  static file(value){return new URI(`file://${value}`);}
  toString(){return this.url.href;}
  with(parts){const u=new URL((parts.scheme||this.scheme)+':'+this.url.href.slice(this.url.protocol.length));if(parts.path!==undefined)u.pathname=parts.path;if(parts.query!==undefined)u.search=parts.query;if(parts.fragment!==undefined)u.hash=parts.fragment;return new URI(u.href);}
 }
 const converters=require('../../syntax/lsp-uris').notebookUriConverters({Uri:URI});
 const first=URI.parse('vscode-notebook-cell:/tmp/a%20b.wb#cell-one'),second=first.with({fragment:'cell-two'});
 const a=converters.code2Protocol(first),b=converters.code2Protocol(second);
 assert.notEqual(a,b);assert.equal(URI.parse(a).scheme,'file');assert.match(URI.parse(a).path,/\.wl$/);
 assert.equal(converters.protocol2Code(a).toString(),first.toString());
 const real=URI.file('/tmp/normal.wl');assert.equal(converters.code2Protocol(real),real.toString());
 assert.equal(converters.protocol2Code(real.toString()).toString(),real.toString());
});
test('slow LSP readiness is logged honestly, coalesces starts and clears its timer',async()=>{
 const {createLspLifecycle}=require('../../syntax/lsp-lifecycle');let finish,timer,starts=0,ready=0,cleared=0;const logs=[];
 const lifecycle=createLspLifecycle({start:()=>{starts++;return new Promise(r=>finish=r);},stop:async()=>{}},
  {onReady:()=>ready++,log:x=>logs.push(x),setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>cleared++});
 const a=lifecycle.start(),b=lifecycle.start();await Promise.resolve();assert.equal(starts,1);
 timer();assert.match(logs[0],/still waiting/);assert.doesNotMatch(logs[0],/^Cannot|failed to start/);
 finish();await Promise.all([a,b]);assert.equal(ready,1);assert.match(logs[1],/ready after/);
 await lifecycle.start();assert.equal(starts,1);await lifecycle.stop();
});
test('stopping a starting LSP awaits it, suppresses warnings and prevents late ready callbacks',async()=>{
 const {createLspLifecycle}=require('../../syntax/lsp-lifecycle');let finish,timer,stops=0,ready=0,cleared=0;const logs=[];
 const lifecycle=createLspLifecycle({start:()=>new Promise(r=>finish=r),stop:async()=>stops++},
  {onReady:()=>ready++,log:x=>logs.push(x),setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>cleared++});
 const a=lifecycle.start();await Promise.resolve();const stopping=lifecycle.stop();
 assert.equal(stops,0);timer();finish();await Promise.all([a,stopping]);
 assert.equal(stops,1);assert.equal(ready,0);assert.deepEqual(logs,[]);assert.ok(cleared>0);
});

test('explicit launch works with notebook startup disabled and no LSP client',async()=>{
 const fs=require('fs'),path=require('path'),vm=require('vm');
 const source=fs.readFileSync(path.join(__dirname,'../../extension.js'),'utf8');
 const start=source.indexOf('    context.subscriptions.push(vscode_1.commands.registerCommand("wolfbook.launchKernel"');
 const end=source.indexOf("    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.openWolframDesktop'",start);
 let command,launches=0,refreshes=0;const errors=[];
 const controller={kernelStatusString:'resolved',launchKernel:async()=>launches++};
 const vscode={commands:{registerCommand:(_id,fn)=>{command=fn;}},window:{showErrorMessage:s=>errors.push(s)}};
 vm.runInNewContext(source.slice(start,end),{context:{subscriptions:[]},vscode,vscode_1:vscode,nbKernelenabled:false,client:undefined,_resolveController:()=>controller,_debugCtrl:{refreshLiveWatch:()=>refreshes++}});
 await command();assert.equal(launches,1);assert.equal(refreshes,1);assert.deepEqual(errors,[]);
 controller.launchKernel=async()=>{throw Error('test failure');};await command();assert.match(errors[0],/test failure/);
});
test('desktop launch bypasses existing service instances without a shell or process termination',async()=>{
 const {openDesktop}=require('../desktop');let call;
 const bundle=await openDesktop('/Applications/Wolfram 2.app/Contents/MacOS/WolframKernel',{platform:'darwin',execFile:(...args)=>{call=args.slice(0,3);args[3](null);}});
 assert.equal(bundle,'/Applications/Wolfram 2.app');assert.deepEqual(call,['/usr/bin/open',['-n','-a',bundle],{timeout:15000}]);
 await assert.rejects(openDesktop('/usr/bin/kernel',{platform:'darwin'}),/application bundle/);
});
