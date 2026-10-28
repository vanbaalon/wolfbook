'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EditAccess}=require('../../tex/editAccess');
const {bpToSp}=require('../../tex/texGeometry');
const {makeVscodeStub,withVscodeStub}=require('./_stub-vscode');
class Position{constructor(line,character){this.line=line;this.character=character;}}
class Range{constructor(start,end){this.start=start;this.end=end;}}
const stub=makeVscodeStub({Position,Range});
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'),stub);
const file='/paper/main.tex',initial='First paragraph here.\n\nSecond paragraph here.';
function doc(text=initial){return {uri:{fsPath:file},version:1,text,
 getText(r){return r ? this.text.slice(this.offsetAt(r.start),this.offsetAt(r.end)) : this.text;},
 offsetAt(p){return this.text.split('\n').slice(0,p.line).reduce((n,l)=>n+l.length+1,0)+p.character;},
 positionAt(n){const lines=this.text.slice(0,n).split('\n');return new Position(lines.length-1,lines.at(-1).length);},
};}
function fixture(){
 const d=doc(),posts=[];let listener;
 stub.workspace.textDocuments=[d];stub.workspace.openTextDocument=async()=>d;
 stub.workspace.onDidChangeTextDocument=fn=>{listener=fn;return {dispose(){}};};
 const entries=[0,2].map((line,i)=>({file,page:1,x:72,y:100+i*40,w:160,h:10,boxHeight:12,
  hit:{preferred_source:{location:{accuracy:'Exact',start:{line:line+1,column_utf16:0},end:{line:line+1,column_utf16:5}}}}}));
 const map={native:true,available:true,projectDir:'/paper',hasPage:()=>true,entriesOnPage:()=>entries,
  view:{artifact:{pdf_hash:'pdf'}},source:{files:new Map([['main.tex',{text:initial}]])}};
 const st={map,sourceAhead:false};
 const v=Object.assign(Object.create(TexViewer.prototype),{root:file,panel:{},_disposables:[],_editSeq:0,
  _openedGeneration:1,_openedPdfHash:'pdf',_modelFor:()=>({objects:[]}),_rememberEditState(){},
  _post:m=>posts.push(m),_editCellStarts:()=>[0],coord:{roots:new Map([[file,st]]),
   ensureNativeMap(){throw Error('cached editing must never wait for a full map');}},
  _ensureLiveMap(){throw Error('cached editing must never wait for the live worker');}});
 v._rememberEditPage(map,1,'pdf:pdf');
 function change(start,end,text,own=true){
  const range={start:d.positionAt(start),end:d.positionAt(end)};
  d.text=d.text.slice(0,start)+text+d.text.slice(end);d.version++;
  if(own){v._miniApplyingFile=file;if(v._edit)v._edit.lastText=d.text.slice(v._edit.startOffset,v._edit.endOffset+text.length-(end-start));}
  listener({document:d,contentChanges:[{rangeOffset:start,rangeLength:end-start,text,range}]});v._miniApplyingFile=null;
  map.available=false;st.sourceAhead=true;st.compiling=true;v._tracePaused=true;
 }
 const click=(y=103,extra={})=>v._openEditSession({page:1,generation:1,xBp:80,yTopBp:y,...extra});
 return {v,d,map,st,posts,click,change};
}
test('repeated edit/close/reopen uses current source while compilation and the worker are unavailable',async()=>{
 const f=fixture();
 for(let i=0;i<12;i++){
  const s=await f.click();assert.ok(s.cached);assert.equal(s.lastText,f.d.text.split('\n\n')[0]);
  f.change(s.endOffset,s.endOffset,`\nnew line ${i}`);
  await f.v._closeEditSession({editId:s.id});assert.equal(f.v._edit,null);
 }
 const s=await f.click();assert.match(s.lastText,/new line 11/);
 assert.equal(f.posts.filter(m=>m.type==='editOpen').length,13);
});
test('other blocks on the same displayed page follow source edits above them without a map rebuild',async()=>{
 const f=fixture(),s=await f.click();f.change(0,0,'Inserted\n');await f.v._closeEditSession({editId:s.id});
 const next=await f.click(143);assert.equal(next.lastText,'Second paragraph here.');
 assert.equal(next.startOffset,f.d.text.indexOf('Second'));assert.ok(next.cached);
});
test('retained targets reject missed events, deleted blocks, another paper and another display identity',async()=>{
 const f=fixture();f.change(0,'First paragraph here.'.length,'',false);
 assert.equal(f.v._openCachedEditSession({page:1,generation:1,xBp:80,yTopBp:103}),null,
  'deleted ink cannot redirect editing to another paragraph');
 f.d.text='reloaded without an event';assert.equal(f.v._openCachedEditSession({page:1,generation:1,xBp:80,yTopBp:143}),null);
 f.d.text=initial;
 assert.equal(f.v._openCachedEditSession({page:1,generation:2,xBp:80,yTopBp:143}),null);
 assert.equal(f.v._openCachedEditSession({page:1,generation:1,overlay:'new-pixels',xBp:80,yTopBp:143}),null);
 f.v.root='/other.tex';assert.equal(f.v._openCachedEditSession({page:1,generation:1,xBp:80,yTopBp:143}),null);
});
test('fragment placements translate cached blocks from the base geometry, without cumulative drift',async()=>{
 const f=fixture(),s=await f.click();f.change(s.endOffset,s.endOffset,' extra');await f.v._closeEditSession({editId:s.id});
 const placement={clear:[-2,26,168,43].map(bpToSp),below:[-72,48,528,728].map(bpToSp),shift:bpToSp(20)};
 f.v._editAccess.fragment(1,'pdf:pdf','live:fragment-1',placement);
 const first=await f.click(123,{overlay:'fragment-1'});assert.match(first.lastText,/extra/);
 await f.v._closeEditSession({editId:first.id});
 const second=await f.click(163,{overlay:'fragment-1'});assert.equal(second.lastText,'Second paragraph here.');
 f.v._editAccess.fragment(1,'pdf:pdf','live:fragment-2',{...placement,shift:bpToSp(30)});
 await f.click(173,{overlay:'fragment-2'});assert.equal(f.posts.at(-1).rects[0].y,170);
});
test('live fragment events retain their original display binding across repeated redraws',async()=>{
 const f=fixture();f.v.shownAnything=true;
 const placement={page:1,clear:[-2,26,168,43].map(bpToSp),below:[-72,48,528,728].map(bpToSp),shift:bpToSp(20)};
 const event={root:file,kind:'fragment',txdl:{},placement,mapIdentity:'first-fragment'};
 f.v._onInteractive(event);assert.equal(f.v._editFragmentBases.get(1).base,'pdf:pdf');
 f.v._onInteractive({...event,mapIdentity:'second-fragment'});
 assert.equal(f.v._editFragmentBases.get(1).base,'pdf:pdf','placements remain relative to the base page');
 assert.equal((await f.click(163,{overlay:'second-fragment'})).lastText,'Second paragraph here.');
 f.v._liveOverlays.set(1,'unknown-full-page');f.v._onInteractive({...event,mapIdentity:'unbound-fragment'});
 assert.equal(f.v._openCachedEditSession({page:1,generation:1,overlay:'unbound-fragment',xBp:80,yTopBp:103}),null,
  'an unknown underlying page never borrows older geometry');
});
test('blank-line/CRLF edits and multi-change transactions preserve exact source ranges',()=>{
 const access=new EditAccess(),d=doc('a\r\n\r\nb');
 access.remember(1,'pdf',[{file,start:5,end:6,rects:[{x:10,y:20,w:5,h:8}],glyphs:[{offset:5,end:6,x:10,y:20,w:5,h:8}]}],[[file,d.text]]);
 const changes=[{rangeOffset:3,rangeLength:0,text:'\r\n'},{rangeOffset:0,rangeLength:0,text:'prefix'}];
 d.text='prefixa\r\n\r\n\r\nb';access.change(file,d.text,changes);
 const hit=access.target(1,'pdf',11,22,()=>d);assert.equal(hit.start,13);assert.equal(hit.offset,13);
});
test('a click reopening during the last source write waits for that write, not map recovery',async()=>{
 const f=fixture();let release;f.v._editApplyQueue=new Promise(r=>release=r);
 const opening=f.click();await Promise.resolve();assert.equal(f.posts.length,0);
 f.change(0,0,'prefix ');release();const s=await opening;assert.match(s.lastText,/^prefix First/);
});
test('a pending source write cannot replay an old editor request into another paper',async()=>{
 const f=fixture();let release;f.v._editApplyQueue=new Promise(r=>release=r);
 const opening=f.click();f.v.root='/other.tex';release();assert.equal(await opening,undefined);assert.equal(f.posts.length,0);
});
test('the full right-click handler uses retained access without starting inverse-map recovery',async()=>{
 const f=fixture();f.v._jumpToSource=()=>{throw Error('a cached source range must not wait for inverse mapping');};
 await f.v._onMessage({type:'editHere',page:1,generation:1,xBp:80,yTopBp:103});
 assert.ok(f.posts.some(m=>m.type==='editOpen'));
 assert.equal(f.posts.some(m=>m.kind==='err'),false);
});
test('paragraph comments use retained current source while glyph provenance is stale',async()=>{
 const f=fixture(),s=await f.click();f.change(0,0,'Added line\n');await f.v._closeEditSession({editId:s.id});
 let target;f.v._postCommentTarget=(doc,hit)=>{target={text:doc.getText(),...hit};};
 await f.v._jumpToSource({commentTarget:true,page:1,generation:1,xBp:80,yTopBp:143});
 assert.equal(target.file,file);assert.equal(target.line,4);assert.equal(target.text,f.d.text);
 assert.equal(f.v._edit,null,'a comment does not open an editor or mutate the source');
});
test('standard-mode blocks reopen independently of compilation and native source maps',async()=>{
 const f=fixture();f.v._editAccess=null;f.map.native=false;
 const s={file,native:false,startOffset:0,endOffset:21,label:'paragraph'};
 f.v._rememberEditBlock(s,f.d,[{page:1,x:72,y:100,w:160,h:12}],{page:1});
 const first=await f.click();assert.equal(first.native,false);
 f.change(first.endOffset,first.endOffset,' another sentence');await f.v._closeEditSession({editId:first.id});
 const next=await f.click();assert.match(next.lastText,/another sentence/);
});
test('live card anchoring and foreground/background readers share one indexed page map',async()=>{
 const f=fixture(),{NativeMap}=require('../../tex/nativeMap'),original=NativeMap.build;let reads=0,indexes=0,release;
 const ready={...f.map,available:true,hasPage:()=>true};
 NativeMap.build=async()=>{indexes++;return ready;};
 Object.assign(f.v,{_liveOverlays:new Map([[1,'live']]),_liveMapReady:new Map([[1,'live']]),
  _postErrorAnnotations(){},_rememberEditPage(){}});
 const lane={liveView:()=>{reads++;return new Promise(r=>release=r);}};
 try{
  const first=f.v._buildLiveMap(lane,1),second=f.v._buildLiveMap(lane,1),background=f.v._buildLiveMap(lane);
  assert.equal(reads,1);release({});await Promise.all([first,second,background]);assert.equal(indexes,1);
  await f.v._buildLiveMap(lane,1);assert.equal(reads,1,'a still-current map is reused');
  f.v._edit={id:1,file,startOffset:0,endOffset:21};f.v._editRectsLast=[{page:1}];
  f.v._editRects=()=>[{page:1,x:72,y:100,w:160,h:12}];
  await f.v._editFollowLiveNow(lane);assert.equal(reads,1,'card anchoring does not read/index the same map again');
 }finally{NativeMap.build=original;}
});
