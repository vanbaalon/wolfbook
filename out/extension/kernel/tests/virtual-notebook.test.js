'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs/promises'),path=require('path'),os=require('os');
const {VirtualNotebooks}=require('../../nb-import/virtual');
const {ReadNotebookFileTool}=require('../../tools/read-notebook-file');
const {makeVscodeStub}=require('./_stub-vscode');
const nb=body=>'(* Content-type: application/vnd.wolfram.mathematica *)\nNotebook[{'+body+'}]';
async function fixture(t,source,ext='.nb') {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wolfbook-virtual-')),file=path.join(dir,'Example'+ext);
 await fs.writeFile(file,source);t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {file,dir};
}
const sample=nb('Cell["A notebook", "Title"],Cell[CellGroupData[{Cell["Calculations", "Section"],Cell[BoxData[RowBox[{"x","=","2"}]],"Input",InitializationCell->True],Cell[BoxData["2"],"Output"]},Closed]],Cell["Explanation", "Text"]');

test('NB converts into ordinary WB cells with grouped code and stored output, without files or evaluation',async t=>{
 const {file,dir}=await fixture(t,sample),reader=new VirtualNotebooks(),before=await fs.readFile(file);
 const s=await reader.load({file});assert.equal(s.failed,false);assert.equal(s.notebook.cells.length,4);
 assert.equal(s.notebook.cells[0].value,'# A notebook');assert.equal(s.notebook.cells[1].value,'## Calculations');
 assert.equal(s.notebook.cells[2].value,'x=2');assert.match(s.notebook.cells[2].outputs[0].items[0].data,/2/);
 const wb=reader.project(s,{view:'wb',limit:100});assert.deepEqual(wb.notebook.cells,s.notebook.cells);
 assert.equal(wb.conversion.evaluated,false);assert.equal(wb.read_only,true);
 assert.equal(wb.notebook.metadata.wolfbookNbImport,undefined,'no duplicate raw notebook source');
 assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readdir(dir),['Example.nb']);
});

test('overview, precise ranges, stable cell IDs and literal search use one cached conversion',async t=>{
 const {file}=await fixture(t,sample),r=new VirtualNotebooks();let conversions=0;const convert=r._convert.bind(r);
 r._convert=f=>{conversions++;return convert(f);};const s=await r.load({file});
 const page=r.project(s,{limit:2});assert.equal(page.next_startCell,3);
 const again=await r.load({virtual_notebook_id:s.id});assert.equal(again,s);
 assert.deepEqual(r.project(again,{view:'cells',startCell:3,limit:1}).cells.map(c=>c.value),['x=2']);
 const byId=r.project(s,{view:'cells',cell_ids:[s.notebook.cells[2].metadata.virtualCellId]});assert.equal(byId.cells[0].cellNumber,3);
 assert.equal(r.project(s,{view:'search',query:'CALCULATIONS'}).cells[0].cellNumber,2);
 assert.equal(conversions,1);
});

test('stored output is searchable but never regenerated, and output omission affects only the response',async t=>{
 const {file}=await fixture(t,nb('Cell[BoxData["1+1"],"Input"],Cell[BoxData["uniqueOutput"],"Output"]'));
 const r=new VirtualNotebooks(),s=await r.load({file});
 assert.equal(r.project(s,{view:'search',query:'uniqueOutput'}).cells.length,1);
 assert.equal(r.project(s,{view:'search',query:'uniqueOutput',include_outputs:false}).cells.length,0);
 assert.deepEqual(r.project(s,{view:'cells',include_outputs:false}).cells[0].outputs,[]);
 assert.equal(s.notebook.cells[0].outputs.length,1);
});

test('snapshot ID stays immutable after disk changes, while a file read creates a fresh revision',async t=>{
 const {file}=await fixture(t,sample),r=new VirtualNotebooks(),a=await r.load({file});
 await fs.writeFile(file,nb('Cell["Replacement text", "Text"]'));
 assert.equal((await r.load({virtual_notebook_id:a.id})).notebook.cells[0].value,'# A notebook');
 const b=await r.load({file});assert.notEqual(a.id,b.id);assert.equal(b.notebook.cells[0].value,'Replacement text');
 const fresh=new VirtualNotebooks();await assert.rejects(()=>fresh.load({file,virtual_notebook_id:a.id}),/source changed/);
 assert.equal((await fresh.load({file,virtual_notebook_id:b.id})).id,b.id);
});

test('concurrent requests share the same conversion and LRU eviction is recoverable by unchanged file',async t=>{
 const {file,dir}=await fixture(t,sample),r=new VirtualNotebooks({maximum:1});let n=0,original=r._convert.bind(r);
 r._convert=f=>{n++;return original(f);};const [a,b]=await Promise.all([r.load({file}),r.load({file})]);assert.equal(n,1);assert.equal(a.id,b.id);
 const second=path.join(dir,'Second.nb');await fs.writeFile(second,nb('Cell["Second", "Text"]'));await r.load({file:second});
 await assert.rejects(()=>r.load({virtual_notebook_id:a.id}),/unavailable/);
 assert.equal((await r.load({file,virtual_notebook_id:a.id})).id,a.id);
});

test('virtual WB reads preserve exact stored code and metadata in the normal JSON model',async t=>{
 const source={cells:[{kind:2,value:String.raw`f[x_] := "\[Alpha]"`,languageId:'wolfram',outputs:[],metadata:{cellId:'original'}}],metadata:{title:'Saved WB'}};
 const {file}=await fixture(t,JSON.stringify(source),'.wb'),r=new VirtualNotebooks(),s=await r.load({file});
 const result=r.project(s,{view:'wb'});assert.equal(result.notebook.cells[0].value,source.cells[0].value);
 assert.equal(result.notebook.cells[0].metadata.cellId,'original');assert.deepEqual(result.notebook.metadata,source.metadata);
});

test('graphics and live dynamics report their limitations instead of claiming a pending rendering job',async t=>{
 const {file,dir}=await fixture(t,nb('Cell[BoxData["Plot[x,{x,0,1}]"],"Input"],Cell[BoxData[GraphicsBox[{}]],"Output"],Cell[BoxData[DynamicBox["live"]],"Output"]'));
 const r=new VirtualNotebooks(),s=await r.load({file});assert.equal(s.unrendered_graphics,1);assert.ok(s.warnings.dynamicOutputs);
 const result=r.project(s,{view:'cells'});assert.doesNotMatch(JSON.stringify(result),/rendering to/);
 assert.deepEqual(await fs.readdir(dir),['Example.nb']);
});

test('malformed notebooks return explicit failed conversion evidence and retain raw source for inspection',async t=>{
 const {file}=await fixture(t,'Notebook['),r=new VirtualNotebooks(),s=await r.load({file});
 assert.equal(s.failed,true);assert.ok(s.notebook.cells.some(c=>c.value.includes('Notebook[')));
 assert.equal(r.project(s).conversion.failed,true);
});

test('untrusted notebook initialization and event actions are parsed as data, never executed',async t=>{
 const {file,dir}=await fixture(t,nb('Cell[BoxData["Run[\\\"touch NEVER_CREATE\\\"]"],"Input",InitializationCell->True]'));
 const r=new VirtualNotebooks(),s=await r.load({file});assert.match(s.notebook.cells[0].value,/Run/);
 assert.deepEqual(await fs.readdir(dir),['Example.nb']);
});

test('large conversions leave the host event loop responsive',async t=>{
 const {file}=await fixture(t,nb(Array.from({length:15000},(_,i)=>'Cell[BoxData["x'+i+'=1"],"Input"]').join(',')));
 const r=new VirtualNotebooks();let ticks=0;const timer=setInterval(()=>ticks++,1);
 try{const s=await r.load({file});assert.equal(s.notebook.cells.length,15000);assert.ok(ticks>=3,`main thread ticked ${ticks} times`);}finally{clearInterval(timer);}
});

test('timeout terminates only its conversion worker and cancellation does not yield a snapshot',async t=>{
 const {file}=await fixture(t,sample),r=new VirtualNotebooks({timeoutMs:1});await assert.rejects(()=>r.load({file}),/exceeded/);
 const cancelled=new VirtualNotebooks();await assert.rejects(()=>cancelled.load({file},undefined,{isCancellationRequested:true}),/cancelled/);
 assert.equal((await new VirtualNotebooks().load({file})).notebook.cells.length,4);
});

test('tool wrapper reads files without asking VS Code to open a document, bind a kernel or edit',async t=>{
 const {file,dir}=await fixture(t,sample),v=makeVscodeStub();
 v.workspace.workspaceFolders=[{uri:{fsPath:dir}}];v.workspace.openNotebookDocument=()=>{throw Error('Must not open a notebook');};
 v.workspace.applyEdit=()=>{throw Error('Must not edit');};v.commands.executeCommand=()=>{throw Error('Must not invoke commands');};
 const tool=new ReadNotebookFileTool(v),response=await tool.invoke({input:{file:path.basename(file),view:'overview'}});
 const payload=JSON.parse(response.content[0].value);assert.equal(payload.cell_count,4);assert.equal(payload.read_only,true);
 const result=await tool.invoke({input:{virtual_notebook_id:payload.virtual_notebook_id,view:'cells',startCell:3,limit:1}});
 assert.equal(JSON.parse(result.content[0].value).cells[0].value,'x=2');
});

test('invalid file/range/search requests fail explicitly without falling back to the active notebook',async t=>{
 const {file}=await fixture(t,sample),r=new VirtualNotebooks(),s=await r.load({file});
 await assert.rejects(()=>r.load({file:'/tmp/wrong.tex'}),/Expected/);
 for(const input of [{startCell:0},{limit:101},{limit:1.5},{view:'search',query:''},{view:'edit'},{cell_ids:'not-an-array'}])assert.throws(()=>r.project(s,input));
 const v=makeVscodeStub(),tool=new ReadNotebookFileTool(v);const reply=JSON.parse((await tool.invoke({input:{}})).content[0].value);
 assert.equal(reply.ok,false);assert.match(reply.error,/Provide file/);
});

test('declared repository routing never injects a live notebook or kernel into an offline read',async t=>{
 const {AgentSessions}=require('../../claude-mcp/agent-sessions');const {file,dir}=await fixture(t,sample),sessions=new AgentSessions();
 const clients=[{clientId:'reader',workspaceRoots:[dir],notebooks:[],kernels:[]}];
 sessions.declare({working_directory:dir,client_id:'reader'},'session',clients);
 const args=sessions.route('wolfbook_readNotebookFile',{file:path.basename(file)},'session',
  {clientId:'reader',notebook:'/unrelated/busy.wb',kernelId:'dead-kernel'},clients);
 assert.equal(args.file,await fs.realpath(file));assert.equal(args.notebook,undefined);assert.equal(args.kernel_id,undefined);
});

test('MCP exposes a read-only tool and can read despite a stale session kernel binding',async t=>{
 const {withVscodeStub}=require('./_stub-vscode');const {WolframMCPServer,loadMCPSchemas}=withVscodeStub(()=>require('../../claude-mcp/server'));
 const {file}=await fixture(t,sample),v=makeVscodeStub(),tool=new ReadNotebookFileTool(v);
 const schemas=loadMCPSchemas(path.resolve(__dirname,'../../../../package.json'));
 const schema=schemas.find(t=>t.name==='wolfbook_readNotebookFile');assert.ok(schema);assert.equal(require('../../claude-mcp/tool-annotations').toolAnnotations(schema.name).readOnlyHint,true);
 const server=new WolframMCPServer(new Map([['wolfbook_readNotebookFile',tool]]),schemas);
 server._ownClientId='reader';server._workers.clear();server._sessionTargets.set('session',{clientId:'reader',notebook:'/missing.wb',kernelId:'gone'});
 server._resolveNotebookKernel=()=>{throw Error('Offline reads must not inspect kernel bindings');};
 const response=await server._dispatch('tools/call',{name:'wolfbook_readNotebookFile',arguments:{file}},'session');
 const text=response.content.map(p=>p.text || p.value || '').join('\n');assert.match(text,/virtual_nb_/);assert.doesNotMatch(text,/target-changed|notebook-not-open/);
});
