'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../../client/tex-viewer.js'),'utf8');
const goto=source.slice(source.indexOf('async function gotoBookmark('),source.indexOf('async function previewBookmark('));
function fixture(){
 let release;const scrolls=[],state={doc:{},pageCount:50,navigationOwner:'review',navigationEpoch:0};
 const main={scrollTop:1000,clientHeight:400,getBoundingClientRect:()=>({top:100}),scrollTo:m=>scrolls.push(m)};
 const wrap={getBoundingClientRect:()=>({top:300})};
 const context=vm.createContext({state,bookmarkPreviewToken:0,hideChipPreview(){},status(){},bookmarkLabel:()=>'',
  claimViewerNavigation(){state.navigationOwner='viewer';state.navigationEpoch++;},
  renderPage:()=>new Promise(r=>release=r),pagesEl:()=>({querySelector:()=>wrap}),
  document:{querySelector:()=>main},rectToViewport:()=>({y:200})});
 vm.runInContext(goto,context);return {context,state,scrolls,release:()=>release()};
}
test('return bookmark waits for distant page rendering and accepts the host navigation acknowledgement',async()=>{
 const f=fixture(),returning=f.context.gotoBookmark({page:20,x:72,y:200,viewportFrac:.42});
 f.state.navigationEpoch++; // The host echoes navigationOwner:viewer.
 f.release();await returning;assert.equal(f.scrolls.length,1);
 assert.equal(f.scrolls[0].top,1232,'return uses the original viewport fraction');
});
test('a delayed return cannot scroll another paper or take navigation back from a newer review action',async()=>{
 for(const change of [state=>state.doc={},state=>state.navigationOwner='review']){
  const f=fixture(),returning=f.context.gotoBookmark({page:20,x:72,y:200});
  change(f.state);f.release();await returning;assert.equal(f.scrolls.length,0);
 }
});
