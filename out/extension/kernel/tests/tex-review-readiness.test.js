'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {withVscodeStub}=require('./_stub-vscode');
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'));
function fixture(){
 const v=Object.create(TexViewer.prototype),root='/paper.tex';
 const st={sourceAhead:true,sourceRevision:8,generation:{generation:4},map:{available:true},files:[]};
 Object.assign(v,{root,_openedGeneration:4,coord:{roots:new Map([[root,st]]),isCurrent:()=>!st.sourceAhead,liveOverlay:()=>null},
  _liveMap:{available:true},_liveMapSourceRevision:8,_liveMapIdentities:new Map([[1,'live-8']]),
  _liveOverlays:new Map([[1,'live-8']]),_liveMapReady:new Map([[1,'live-8']]),
  _post:()=>{},_scheduleReviewPreload:()=>{},_reviewRenderRevision:()=>'current',_replayReviewFocus:()=>{}});
 return {v,st};
}
test('host enables current live corrections individually without requiring a full compile',()=>{
 const {v,st}=fixture(),h={id:'live',rects:[{page:1}]},pending={id:'next',rects:[{page:2}]};
 assert.equal(v._reviewHunkReady(h,4),true);assert.equal(v.reviewPageBehind(4,h),false);
 assert.equal(v._reviewHunkReady(pending,4),false);assert.equal(v._reviewHunkReady(h,3),false);
 st.sourceRevision=9;assert.equal(v._reviewHunkReady(h,4),false);
 st.sourceAhead=false;assert.equal(v._reviewHunkReady(pending,4),true);
 assert.equal(v._reviewHunkReady({id:'preamble',rects:[]},4),true,'a current file can still review nonprinting source');
 st.map.available=false;assert.equal(v._reviewHunkReady(h,4),false);
});
test('host keeps the panel pending, marks unavailable arrivals and preserves review contents',()=>{
 const {v}=fixture(),h={id:'live',rects:[{page:1}]},pending={id:'next',rects:[{page:2}]};let posted;
 v._post=m=>{posted=m;};const payload={generation:4,pending:2,groups:[{hunks:[h,pending]}]};
 v.showReview(payload);
 assert.equal(v._reviewShown,true);assert.equal(posted.session.pending,2);
 assert.deepEqual(posted.session.groups[0].hunks.map(h=>h.ready),[true,false]);
 assert.equal(payload.groups[0].hunks[0].ready,undefined,'readiness is transient viewer state');
 v.showReview({...payload,generation:null});assert.equal(v._reviewShown,true);
 assert.deepEqual(posted.session.groups[0].hunks.map(h=>h.ready),[false,false]);
 let checks=0;v._reviewGenerationReady=()=>{checks++;return true;};
 v.showReview({...payload,groups:[{hunks:Array.from({length:100},(_,i)=>({...h,id:String(i)}))}]});
 assert.equal(checks,1,'a large correction list checks its file snapshot only once');
});
test('a viewer click racing a new edit refreshes its row without forcing compilation',async()=>{
 const {v}=fixture(),pending={id:'next',rects:[{page:2}]},live={id:'live',rects:[{page:1}]};
 let shown=0,refreshed=0;
 v._review={sessionFor:()=>({generation:4,hunks:[pending,live]}),refresh:async()=>{refreshed++;},show:async()=>{shown++;}};
 await v._onReviewAction({action:'show',id:'next'});assert.equal(refreshed,1);assert.equal(shown,0);
 // Keep this test on the existing viewer; no actual reveal is needed here.
 v._ensureViewerForReview=async()=>{};
 await v._onReviewAction({action:'show',id:'live'});assert.equal(shown,1);assert.equal(refreshed,1);
});
