'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const ed=require('../../tex/tikzEditor'),model=require('../../tex/tikzModel');
const {makeVscodeStub,withVscodeStub}=require('./_stub-vscode');
const stub=makeVscodeStub();
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'),stub);
const file='/paper/main.tex',text=String.raw`\begin{tikzpicture}
  \node[draw] (a) at (0,0) {A};
  \draw (a) -- (2,0);
\end{tikzpicture}`;
const picture={file,begin:0},statement=model.parsePicture(text,0).statements[0];
const ref={start:statement.start,text:statement.text};
const plan=(value,source=text)=>ed.plan({op:'source',picture,ref,text:value},{[file]:source});
test('source editing replaces only its guarded statement and is exactly undoable',()=>{
 const value=String.raw`\node[fill=red!20] (a) at (1,2) {$\alpha$};`,r=plan(value);
 assert.equal(r.error,null);const after=ed.apply(text,r.edits[file]);
 assert.ok(after.includes(value));assert.ok(after.includes(String.raw`\draw (a) -- (2,0);`));
 assert.equal(ed.apply(after,ed.inverse(text,r.edits[file])),text);
 assert.deepEqual(r.source,{file,start:statement.start,text:value});
});
test('stale, malformed, empty or multi-statement drafts cannot overwrite the source',()=>{
 for(const value of ['',String.raw`\node {Broken;`,String.raw`\node {A};\draw (0,0)--(1,1);`,
  String.raw`\end{tikzpicture}\node {Escape};`,String.raw`\node } {Extra};`,String.raw`\node {No ending}`])
  assert.ok(plan(value).error,value);
 assert.match(plan(String.raw`\node {X};`,text.replace('{A}','{Changed elsewhere}')).error,/source changed/);
});
test('balanced LaTeX labels, escaped braces, comments and multiline CRLF statements survive',()=>{
 const value=String.raw`\node (a) at (0,0) {% keep this comment
$\{x\}$ and [a,b)
};`,r=plan(value);assert.equal(r.error,null);
 const crlf=text.replace(/\n/g,'\r\n'),p=model.parsePicture(crlf,0),s=p.statements[0];
 const result=ed.plan({op:'source',picture,ref:{start:s.start,text:s.text},text:value},{[file]:crlf});
 assert.equal(result.error,null);assert.ok(result.source.text.includes('\r\n'));
 assert.equal(plan(ref.text).noChange,true,'unchanged/trim-only source needs no edit/build');
});
test('source location is a collapsed cursor at the statement start with no edits',()=>{
 const r=ed.plan({op:'locate',picture,ref},{[file]:text});assert.equal(r.error,null);
 assert.deepEqual(r.edits,{});assert.deepEqual(r.reveal,{file,start:ref.start,end:ref.start});
});
function host(){
 const v=Object.create(TexViewer.prototype),reveals=[],doc={uri:{fsPath:file},getText:()=>text,positionAt:n=>({line:0,character:n})};
 Object.assign(v,{root:file,_isInsideProject:f=>f===file,_tikzDocument:async()=>doc,
  _tikzReveal:async(r,opts)=>{if(opts.isCurrent())reveals.push(r);},_claimViewerNavigation(){},_log(){}});
 return {v,doc,reveals};
}
test('selection locates current source and refuses stale or foreign-file references',async()=>{
 const {v,reveals}=host();await v._tikzSelectSource({picture,ref});assert.equal(reveals[0].start,ref.start);assert.equal(reveals[0].end,ref.start);
 await v._tikzSelectSource({picture,ref:{...ref,text:'stale'}});await v._tikzSelectSource({picture:{file:'/other.tex',begin:0},ref});
 assert.equal(reveals.length,1);
});
test('a late source lookup cannot replace the newer selection or another paper cursor',async()=>{
 const {v,doc,reveals}=host();let release;v._tikzDocument=()=>new Promise(r=>release=r);
 const old=v._tikzSelectSource({picture,ref});v.root='/other.tex';release(doc);await old;assert.equal(reveals.length,0);
});
test('a source change during asynchronous document loading refuses the planned offsets',async()=>{
 const {v,doc}=host();let writes=0;
 doc.getText=()=>text.replace('{A}','{Changed while applying}');
 v._guardedWrite=async()=>{writes++;return true;};
 const r=plan(String.raw`\node {New};`);
 assert.equal(await v._tikzApply(r.edits,'TikZ: source',{[file]:text}),null);
 assert.equal(writes,0);
});
test('visible main editor receives a collapsed selection; a hidden editor never opens or creates a split',async()=>{
 const {v,doc}=host();delete v._tikzReveal;
 stub.Range=class{constructor(start,end){this.start=start;this.end=end;}};
 stub.Selection=class{constructor(start,end){this.start=start;this.end=end;}};
 stub.TextEditorRevealType={InCenterIfOutsideViewport:2};
 const editor={document:doc,revealRange(){}};stub.window.visibleTextEditors=[editor];
 stub.window.showTextDocument=()=>{throw Error('source is already visible');};
 await v._tikzReveal({file,start:ref.start,end:ref.start});assert.deepEqual(editor.selection.start,editor.selection.end);
 stub.window.visibleTextEditors=[];
 stub.window.showTextDocument=()=>{throw Error('TikZ must never open a source tab or split');};
 await v._tikzReveal({file,start:ref.start,end:ref.start});
 await v._tikzSelectSource({picture,ref});
});
test('applying the TikZ panel source never opens a full editor',async()=>{
 const {v}=host();delete v._tikzReveal;
 stub.window.visibleTextEditors=[];stub.window.showTextDocument=()=>{throw Error('unexpected source editor');};
 const posts=[];v._post=m=>posts.push(m);v._tikzApply=async()=>[];
 await v._tikzEdit({op:'source',picture,ref,text:String.raw`\node[blue] (a) at (0,0) {A};`,key:'panel-edit'});
 assert.equal(posts.at(-1).type,'tikzEdited');assert.equal(posts.at(-1).ok,true);
});
