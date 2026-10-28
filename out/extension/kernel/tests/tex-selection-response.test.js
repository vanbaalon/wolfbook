'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {NativeMap}=require('../../tex/nativeMap');
const {makeVscodeStub,withVscodeStub}=require('./_stub-vscode');
class Position {constructor(line,character){Object.assign(this,{line,character});}}
class Range {constructor(start,end){Object.assign(this,{start,end});}}
class Selection extends Range {constructor(start,end){super(start,end);this.anchor=start;this.active=end;}}
const stub=makeVscodeStub({Position,Range,Selection});
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'),stub);
function fixture(live=false){
 const file='/selection-response/main.tex',initial='Alpha beta gamma.',posts=[],queries=[];let text=initial;
 const hits=[...initial].map((c,i)=>{
  const location={accuracy:'Exact',start:{line:1,column_utf16:i},end:{line:1,column_utf16:i+1}};
  const span={tag:1,line:1,column:i,length:1},source={file:'main.tex',location};
  return {item_id:i,preferred_source:source,mapped_origins:[{span,source}],box_path:[],
   item:{page:1,kind:'Glyph',provenance:{definition:span},glyph:{font:1,code:c.charCodeAt(0)},
    geometry:{position:{x:i*6*65536,y:20*65536},width:6*65536,height:8*65536,depth:2*65536}}};
 });
 const view={artifact:{pdf_hash:'pdf',page_count:1},pages:[{page:1,header:{magnification:1000},hits}]};
 const source={files:new Map([['main.tex',{text:initial}]]),isCurrentView:()=>true,
  forward(){queries.push('forward');return new Promise(()=>{});},
  inverse(){queries.push('inverse');return new Promise(()=>{});}};
 const map=new NativeMap({nativeSource:source,nativeView:view,projectDir:'/selection-response'});map.live=live;
 const d={uri:stub.Uri.file(file),version:1,lineCount:1,getText:r=>r?text.slice(r.start.character,r.end.character):text,
  lineAt:()=>({text}),offsetAt:p=>p.character,positionAt:n=>new Position(0,n)};
 stub.workspace.textDocuments=[d];stub.workspace.openTextDocument=async()=>d;stub.window.visibleTextEditors=[];
 stub.WorkspaceEdit=class{delete(uri,range){this.range=range;}};
 stub.workspace.applyEdit=async edit=>{text=text.slice(0,edit.range.start.character)+text.slice(edit.range.end.character);d.version++;return true;};
 const st={root:file,map:live?{native:true,available:false}:map};
 const v=Object.assign(Object.create(TexViewer.prototype),{root:file,panel:{},followMode:'scroll',_fsActions:{},
  _openedPdfHash:'pdf',_openedGeneration:1,_nativeInverseRequest:0,coord:{roots:new Map([[file,st]]),stateFor:()=>st},
  _liveMap:live?map:null,_liveOverlays:new Map(live?[[1,'live-page']]:[]),_liveMapIdentities:new Map([[1,'live-page']]),
  _setTracePaused(){},_rememberCursor(){},_postEditSelection(){},_post:m=>posts.push(m),_log(){}});
 const glyph=i=>map.entriesOnPage(1)[i];
 const point=i=>{const g=glyph(i);return {page:1,xBp:g.x+g.w/2,yTopBp:g.y+g.boxHeight/2};};
 async function select(){
  const p=point(9),m={...p,generation:1,pick:true,from:point(6)};
  v._nativeInverseRequest++;
  await TexViewer.prototype._jumpToNativeSource.call(v,st,m,v._nativeInverseRequest,map);
 }
 return {v,st,d,map,source,posts,queries,select};
}
async function bounded(promise){
 let timer;try{return await Promise.race([promise,new Promise((_,r)=>{timer=setTimeout(()=>r(Error('waited on the blocked mapping worker')),200);})]);}
 finally{clearTimeout(timer);}
}
for(const live of [false,true])test(`${live?'live overlay with stale cold map':'settled PDF'}: drag and delete complete while mapping worker is blocked`,async()=>{
 const f=fixture(live);await bounded(f.select());
 const span=f.posts.find(m=>m.type==='selection' && m.span?.rows.length)?.span;
 assert.ok(span,'selection is painted before worker or full compile completes');
 assert.equal(f.d.getText(new Range(f.v._lastSelection.start,f.v._lastSelection.end)),'beta');
 assert.equal(span.geometry.livePages[1],live?'live-page':null);
 await bounded(f.v._selectionAction({action:'delete'}));
 assert.equal(f.d.getText(),'Alpha  gamma.');assert.equal(f.v._lastSelection,null);
 assert.deepEqual(f.queries,[],'no inverse or bracket query waits behind the compiler');
 assert.ok(f.posts.some(m=>m.type==='selection' && m.span===null));
});
test('Delete immediately after mouse-up uses the final drag range',async()=>{
 const f=fixture();let release;
 f.v._jumpToSource=async()=>{await new Promise(r=>release=r);await f.select();};
 const picking=f.v._onMessage({type:'click',pick:true}),deleting=f.v._selectionAction({action:'delete'});
 await Promise.resolve();assert.equal(f.d.getText(),'Alpha beta gamma.');
 release();await bounded(Promise.all([picking,deleting]));assert.equal(f.d.getText(),'Alpha  gamma.');
});
test('a pending drag action cannot follow navigation into another paper or revive cancelled typing',async()=>{
 for(const action of ['delete','replace']){
  const f=fixture();let release;f.v._selectionPick=new Promise(r=>release=r);
  const pending=f.v._selectionAction({action,typingRequest:3,text:'X',key:'X'});
  if(action==='delete')f.v.root='/another/paper.tex';
  else await f.v._onMessage({type:'selectionTypingCancel',typingRequest:3});
  release();await bounded(pending);assert.equal(f.d.getText(),'Alpha beta gamma.');
 }
});
test('exact in-memory brackets refuse displaced membership and invalidated views',()=>{
 const f=fixture();assert.equal(f.map.forwardAtFromMemory(f.d.uri.fsPath,1,6).length,1);
 f.map.entriesOnPage(1)[6].hit.mapped_origins[0].source.location.accuracy='Displaced';
 assert.equal(f.map.forwardAtFromMemory(f.d.uri.fsPath,1,6),null);
 f.map.noteEdit();assert.equal(f.map.forwardAtFromMemory(f.d.uri.fsPath,1,7),null);
});
test('new source bytes during drag admission never become a deletable source selection',async()=>{
 const f=fixture();stub.workspace.openTextDocument=async()=>{f.d.version++;return {...f.d,getText:()=> 'different source'};};
 await bounded(f.select());assert.equal(f.v._lastSelection,undefined);
 assert.equal(f.posts.some(m=>m.type==='selection' && m.span?.rows.length),false);
});
