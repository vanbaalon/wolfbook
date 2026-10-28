'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeControllerHarness}=require('./_stub-controller');
const manifest=require('../../../../package.json');

test('output hover only paints source, deduplicates repeat requests, and stays with the owning notebook',async()=>{
 const h=makeControllerHarness(),decorations=[];
 const create=h.stub.window.createTextEditorDecorationType;
 h.stub.window.createTextEditorDecorationType=options=>{const decoration=create(options);decorations.push({options,decoration});return decoration;};
 h.stub.Position=class{constructor(line,character){Object.assign(this,{line,character});}};
 h.stub.Range=class{constructor(start,end){Object.assign(this,{start,end});}};
 const a=h.notebook('/tmp/hover-a.wb'),b=h.notebook('/tmp/hover-b.wb');
 const cells=[0,1].map(i=>({document:{uri:{toString:()=>`vscode-notebook-cell:/hover-a/${i}`}}}));
 a.cellAt=i=>cells[i];a.cellCount=2;
 const writes=[];h.stub.window.visibleTextEditors=cells.map((cell,i)=>({document:cell.document,setDecorations:(kind,ranges)=>writes.push({i,kind,ranges})}));
 const owner=h.kernel({owns:nb=>nb===a}),other=h.kernel({owns:nb=>nb===b});
 try{
  const highlight=decorations.find(d=>d.options.backgroundColor==='rgba(100, 160, 255, 0.08)');
  assert.ok(highlight);assert.equal(highlight.options.isWholeLine,true);
  assert.equal(Object.keys(highlight.options).some(k=>/border|margin|padding|font|width|height/i.test(k)),false,
   'highlight cannot add a border or alter measured text geometry');
  const editor=h.editor(a),message={type:'hover-output',cellIdx:0,start:1,end:3};
  h.reset();
  for(let i=0;i<20;i++)h.fire('renderer.onDidReceiveMessage',{editor,message});
  assert.equal(writes.length,1,'repeat hover notifications do not retrigger Monaco layout');
  assert.deepEqual({...writes[0].ranges[0].start},{line:1,character:0});
  await h.rendererMessage({type:'hover-output-end'},h.editor(b));
  assert.equal(writes.length,1,'another notebook cannot clear this highlight');
  await h.rendererMessage({...message,cellIdx:1},editor);
  assert.equal(writes[1].i,0);assert.equal(writes[1].ranges.length,0,'moving to a different input clears the old paint');
  assert.equal(writes[2].i,1);assert.equal(writes[2].ranges.length,1);
  await h.rendererMessage({type:'hover-output-end'},editor);assert.equal(writes.at(-1).ranges.length,0);
  const count=writes.length;await h.rendererMessage({type:'hover-output-end'},editor);assert.equal(writes.length,count);
  await h.rendererMessage({...message,cellIdx:1},editor);assert.equal(writes.at(-1).ranges.length,1,'re-entering still paints normally');
  assert.equal(h.calls.commands.length,0,'hover never focuses, reveals, scrolls or evaluates a cell');
 }finally{owner.dispose();other.dispose();}
});

test('notebook scrollbars do not contribute to the input cell content height',()=>{
 const defaults=manifest.contributes.configurationDefaults;
 assert.equal(defaults['notebook.editorOptionsCustomizations']['editor.scrollbar'].ignoreHorizontalScrollbarInContentHeight,true);
 assert.equal(defaults['editor.scrollbar.ignoreHorizontalScrollbarInContentHeight'],undefined,
  'the height override is notebook-specific, without changing ordinary text editors');
});
