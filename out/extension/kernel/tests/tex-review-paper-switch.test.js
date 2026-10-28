'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {withVscodeStub}=require('./_stub-vscode');
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'));
function fixture(){
 const v=Object.create(TexViewer.prototype),messages=[],root='/paper/current.tex';
 Object.assign(v,{root,panel:{viewColumn:2,reveal(){}},coord:{roots:new Map([[root,{files:[root,'/paper/chapter.tex']}]]),rootFor:d=>d.uri.fsPath},
  _objMaps:new Map(),_post:m=>messages.push(m),_reviewFocus:{id:'previous',pending:true},_reviewShown:true,
  _reviewWaiting:true,_reviewLocationPayload:{file:'/paper/previous.tex',pending:23},
  _reviewLocations:{key:'previous',entries:new Map()},_reviewRenderTicket:{root:'/paper/previous.tex'},
  _reviewNavigation:{owner:'review'},_webviewReady:false,_reviewGenerationReady:()=>false,
  _reviewRenderRevision:()=> 'current',_scheduleReviewPreload(){},_replayReviewFocus(){}});
 return {v,messages,root};
}
test('switching papers resets old review state and publishes the new paper before PDF refresh completes',async()=>{
 const {v,messages}=fixture();v.root='/paper/previous.tex';let release,cancelled=0;
 v._reviewRenderer={cancel:()=>{cancelled++;}};
 for(const name of ['_clearSourceSaveTimer','_flushCursorState','_rememberRoot','_restoreCursor','_postTheme','_postSourceDirty','_scheduleSourceSave'])v[name]=()=>{};
 v._viewFor=()=>null;v.refresh=()=>new Promise(resolve=>{release=resolve;});
 let pushed;v._review={push:file=>{pushed=file;v.showReview(null);}};
 const pending=v.open({uri:{fsPath:'/paper/current.tex'}});
 assert.equal(pushed,'/paper/current.tex','the new list must not wait behind capture/render/layout work');
 assert.equal(v._reviewFocus,null);assert.equal(v._reviewWaiting,false);assert.equal(v._reviewShown,false);
 assert.equal(v._reviewLocationPayload,null);assert.equal(v._reviewLocations,null);assert.equal(v._reviewRenderTicket,null);
 assert.equal(cancelled,1);assert.equal(messages[0].type,'blank');assert.equal(messages[0].paperRoot,'/paper/current.tex');
 assert.equal(messages.at(-1).type,'review');assert.equal(messages.at(-1).session,null);
 release();await pending;
});
test('a late review payload cannot paint a different paper even when generations collide',()=>{
 const {v,messages,root}=fixture();
 v.showReview({file:'/paper/previous.tex',pending:23,generation:1,groups:[]});
 assert.equal(messages.length,0);
 v.showReview({file:root,pending:1,generation:1,groups:[]});assert.equal(messages.at(-1).session.file,root);
 assert.equal(messages.at(-1).paperRoot,root);
 v.showReview({file:'/paper/chapter.tex',pending:1,generation:1,groups:[]});
 assert.equal(messages.at(-1).session.file,'/paper/chapter.tex','a project include still belongs to this paper');
});
test('an old-paper Keep all click cannot approve the current paper',async()=>{
 const {v,root}=fixture();let kept=0,pushed;
 v._review={keepAll:()=>{kept++;},push:file=>{pushed=file;}};
 await v._onReviewAction({action:'keepAll',file:'/paper/previous.tex',paperRoot:'/paper/previous.tex'});
 assert.equal(kept,0);assert.equal(pushed,root);
 await v._onReviewAction({action:'keepAll',file:root,paperRoot:root});assert.equal(kept,1);
});

test('a PDF refresh waiting for scroll capture cannot ship the previous paper after switching',async()=>{
 const fs=require('fs'),os=require('os'),path=require('path'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'paper-switch-pdf-'));
 try{
  const {v,messages,root}=fixture(),st=v.coord.roots.get(root),pdfPath=path.join(dir,'paper.pdf');
  fs.writeFileSync(pdfPath,'%PDF-1.7\n');st.generation={generation:1,pdfHash:'old-pdf',pdfPath,runner:'pdflatex'};
  for(const name of ['_postNativeMapState','_postEngine','_postErrorAnnotations'])v[name]=()=>{};
  v._webviewReady=true;let release;v._captureReaderView=()=>new Promise(resolve=>{release=resolve;});
  const pending=v._refreshNow();assert.equal(typeof release,'function');v.root='/paper/new.tex';release();await pending;
  assert.ok(!messages.some(m=>m.type==='open'),'old bytes must not be labelled as the new paper');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
