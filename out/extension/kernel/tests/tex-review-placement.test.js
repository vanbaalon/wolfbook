'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {withVscodeStub}=require('./_stub-vscode');
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'));
const {locateSourcePage,sourceProbes}=require('../../tex/reviewPlacement');
const {placeHunk}=require('../../tex/texCompare');

test('review location probes printed list and heading text instead of nonprinting commands',async()=>{
    for (const line of [' \\item \\textbf{Changed result}', '\\paragraph{Changed result}']) {
        const columns=[];
        const source={forward:async(file,row,column)=>{
            columns.push(column);assert.equal(file,'paper.tex');assert.equal(row,2);
            return {hits:column===line.indexOf('Changed') ? [{item:{page:90}}] : []};
        }};
        const hit=await locateSourcePage(source,'paper.tex','header\n'+line+'\nNeighbour',2,3);
        assert.equal(hit.page,90);assert.deepEqual(columns,[line.indexOf('Changed')]);
    }
    assert.ok(sourceProbes('header\n% comment\nNext paragraph',2,3).length===0,
        'a source-only correction must not borrow the next paragraph');
});

function fixture(){
    const file='/paper/paper.tex',v=Object.create(TexViewer.prototype),text='header\n \\item \\textbf{Changed result}\n';
    const lane={relative:()=> 'paper.tex',source:{files:new Map([['paper.tex',{text}]]),
        forward:async()=>({hits:[{item:{page:90}}]})}};
    const st={sourceRevision:2,generation:{generation:4,pdfHash:'pdf'},nativeLane:lane,
        map:{native:true,available:true,exact:false,lineRows:()=>[],objectAtLine:()=>null,
            sourceToRender:()=>({page:null})}};
    const h={id:'distant',startLine:2,endLine:3,ourRange:{startLine:2,endLine:3},rects:[]};
    Object.assign(v,{root:file,panel:{},_openedPdfHash:'pdf',_openedGeneration:4,
        coord:{roots:new Map([[file,st]]),build:()=>{throw Error('page discovery must not compile');}},
        _log:()=>{},_post:()=>{},_scheduleReviewPreload:()=>{},_replayReviewFocus:()=>{},
        _reviewRenderRevision:()=> 'current',_reviewGenerationReady:()=>true});
    return {v,st,lane,h,file};
}

test('windowed native maps discover distant corrections without loading maps or compiling',async()=>{
    const {v,st,h,file}=fixture();let refreshes=0;
    const payload={file,pending:1,generation:4,groups:[{hunks:[h]}]};
    v._review={refresh:async()=>{refreshes++;}};let posted;
    v._post=m=>{if(m.type==='review')posted=m;};
    v.showReview(payload);
    assert.equal(posted.session.groups[0].hunks[0].ready,false,'unlocated arrivals are clocked');
    await v._reviewLocationWork;
    assert.equal(refreshes,1);
    const hit=v._reviewMap(st,file).locate(2,2);
    assert.equal(hit.page,90,'the worker page hint survives a missing viewport row');
    v.showReview({...payload,groups:[{hunks:[{...h,page:90,where:'page'}]}]});
    assert.equal(posted.session.groups[0].hunks[0].ready,true);
    st.sourceRevision++;
    assert.equal(v._reviewMap(st,file).locate(2,2),null,'new source cannot reuse the old page hint');
});

test('a page-only correction loads its target window before navigating',async()=>{
    const {v,st,lane,h,file}=fixture();h.page=90;
    lane.source.forward=()=>{throw Error('the page is already known');};
    let page,refreshed=0;
    v.coord.ensureNativeMap=async(s,timeout,p)=>{assert.equal(s,st);page=p;return true;};
    v._review={refresh:async()=>{refreshed++;}};
    assert.equal(await v.ensureReviewPlacement(file,h),true);
    assert.equal(page,90);assert.equal(refreshed,1);
});

test('source edits during a correction lookup cannot publish stale page numbers',async()=>{
    const {v,st,lane,h,file}=fixture();let release;
    lane.source.forward=()=>new Promise(resolve=>{release=resolve;});
    let refreshes=0;v._review={refresh:async()=>{refreshes++;}};
    const payload={file,pending:1,generation:4,groups:[{hunks:[h]}]};
    v.showReview(payload);const work=v._reviewLocationWork;
    st.sourceAhead=true;st.sourceRevision++;
    release({hits:[{item:{page:90}}]});await work;
    assert.equal(refreshes,0);
    assert.equal(v._reviewLocations.entries.size,0);
});

test('a whole-block deletion retains its page hint until its seam map arrives',()=>{
    const {v,st,file}=fixture();
    v._reviewLocationCache(st).entries.set(`${file}|2|2`,{page:90,matchedLine:2,exact:true});
    const placement=placeHunk(v._reviewMap(st,file),{aStart:2,aEnd:2});
    assert.equal(placement.page,90);assert.equal(placement.where,'page');
    assert.deepEqual(placement.rects,[],'page discovery cannot invent a deletion rectangle');
});

test('many correction lookups publish in batches without mapping every page',async()=>{
    const {v,st,lane,file}=fixture();let refreshes=0,lookups=0;
    lane.source.files.get('paper.tex').text=Array.from({length:50},(_,i)=>`Changed result ${i}`).join('\n');
    lane.source.forward=async()=>{lookups++;return {hits:[{item:{page:90}}]};};
    v._review={refresh:async()=>{refreshes++;}};
    v._scheduleReviewLocations({file,pending:50,groups:[{hunks:Array.from({length:50},(_,i)=>
        ({id:`change-${i}`,startLine:i+1,endLine:i+2,rects:[]}))}]},st);
    await v._reviewLocationWork;
    assert.equal(lookups,50);assert.equal(v._reviewLocations.entries.size,50);
    assert.ok(refreshes>1 && refreshes<=5,`${refreshes} updates for 50 changes`);
});

test('a timed-out lookup does not prevent later corrections getting page hints',async()=>{
    const {v,st,lane,file}=fixture();let refreshes=0;
    lane.source.files.get('paper.tex').text='Unresponsive lookup\nChanged result\n';
    lane.source.forward=async(f,line)=>line===1 ? new Promise(()=>{}) : {hits:[{item:{page:90}}]};
    v._review={refresh:async()=>{refreshes++;}};
    v._scheduleReviewLocations({file,pending:2,groups:[{hunks:[
        {id:'slow',startLine:1,endLine:2},{id:'next',startLine:2,endLine:3},
    ]}]},st);
    await v._reviewLocationWork;
    assert.equal(v._reviewLocations.entries.get(`${file}|1|2`),null);
    assert.equal(v._reviewLocations.entries.get(`${file}|2|3`).page,90);
    assert.ok(refreshes);
});

test('own-source page hints override borrowed viewport locations',async()=>{
    const {v,st,h,file}=fixture();
    st.map.sourceToRender=()=>({page:2,matchedLine:1,exact:false});
    v._reviewLocationCache(st).entries.set(v._reviewLocationKey(file,h),{page:90,matchedLine:2,exact:true});
    const placed=placeHunk(v._reviewMap(st,file),{aStart:2,aEnd:3});
    assert.equal(placed.page,90);assert.deepEqual(placed.rects,[]);
});

test('discovery resumes when a new review payload adds work to the same cache',async()=>{
    const {v,st,lane,h,file}=fixture();let release;
    lane.source.forward=()=>new Promise(resolve=>{release=resolve;});
    v._review={refresh:async()=>{}};
    const payload={file,pending:1,groups:[{hunks:[h]}]};
    v._scheduleReviewLocations(payload,st);const work=v._reviewLocationWork;
    release({hits:[{item:{page:90}}]});
    lane.source.forward=async()=>({hits:[{item:{page:90}}]});
    v._scheduleReviewLocations({...payload,pending:2,groups:[{hunks:[h,{id:'new',startLine:1,endLine:2}]}]},st);
    await work;
    if(v._reviewLocationWork)await v._reviewLocationWork;
    assert.equal(v._reviewLocations.entries.get(v._reviewLocationKey(file,h)).page,90);
    assert.equal(v._reviewLocations.entries.get(`${file}|1|2`).page,90);
});

test('a correction whose source is absent finishes discovery instead of preparing forever',async()=>{
    const {v,st,lane,h,file}=fixture();let refreshes=0;
    lane.source.files.clear();v._review={refresh:async()=>{refreshes++;}};
    v._scheduleReviewLocations({file,pending:1,groups:[{hunks:[h]}]},st);
    await v._reviewLocationWork;
    assert.equal(v._reviewLocationPending(st,file,h),false);
    assert.equal(v._reviewLocations.entries.get(v._reviewLocationKey(file,h)),null);
    assert.equal(refreshes,1);
});

test('PDF acknowledgement refreshes corrections before a stalled cursor restoration',async()=>{
    const {v,st}=fixture();let refreshed=0,tracing=0;
    Object.assign(v,{shownGeneration:4,shownPdfHash:'pdf',_crops:new Map(),
        _postNativeMapState(){},_postErrorAnnotations(){},_setTracePaused(){},
        _resumeTracing:()=>{tracing++;return new Promise(()=>{});},
        _review:{refreshPlacement:()=>{refreshed++;}}});
    st.sourceAhead=false;
    v._onMessage({type:'opened',generation:4,pdfHash:'pdf'});
    assert.equal(tracing,1);assert.equal(refreshed,1,'the review must not wait behind a worker cursor query');
});

test('deletion discovery finds the surviving paragraph across blank and comment-only seam lines',async()=>{
    const text='Previous paragraph\n\n% retained comment\n\nFollowing paragraph\n';
    const source={forward:async(f,line)=>({hits:line===5 ? [{item:{page:90}}] : []})};
    const hit=await locateSourcePage(source,'paper.tex',text,3,3);
    assert.equal(hit?.page,90);assert.equal(hit.matchedLine,5);assert.equal(hit.seam,true);
    assert.equal(await locateSourcePage(source,'paper.tex',text,3,4),null,'ordinary nonprinting changes cannot borrow a neighbouring paragraph');
});

test('deletion at EOF locates the final surviving ink, including trailing blank lines',async()=>{
    const text='Last paragraph\n\n% trailing comment\n';
    const source={forward:async(f,line)=>({hits:line===1 ? [{item:{page:94}}] : []})};
    const hit=await locateSourcePage(source,'paper.tex',text,5,5);
    assert.equal(hit?.page,94);assert.equal(hit.matchedLine,1);
});

test('a discovered deletion neighbour becomes a seam above or below its surviving ink',()=>{
    const row={page:90,x:70,y:220,w:150,h:12};
    for (const line of [2,5]) {
        const placed=placeHunk({rowsFor:n=>n===line ? [row] : [],
            locate:()=>({page:90,matchedLine:line,seam:true})},{aStart:4,aEnd:4});
        assert.equal(placed.where,'gap');assert.equal(placed.rects[0].caret,true);
        assert.equal(placed.rects[0].y,line<4 ? 232 : 220);
    }
});

test('clicking an undiscovered deletion remembers its location hint before loading the map window',async()=>{
    const {v,st,lane,file}=fixture();lane.source.files.get('paper.tex').text='Previous\n\n% comment\n\nFollowing';
    lane.source.forward=async(f,line)=>({hits:line===5 ? [{item:{page:90}}] : []});
    const h={id:'removed',verb:'del',startLine:3,endLine:3,ourRange:{startLine:3,endLine:3},rects:[]};
    let placed;
    v.coord.ensureNativeMap=async(s,timeout,page)=>{assert.equal(page,90);st.map.lineRows=(f,line)=>line===5 ? [{page:90,x:70,y:220,w:150,h:12}] : [];return true;};
    v._review={refresh:async()=>{placed=placeHunk(v._reviewMap(st,file),{aStart:3,aEnd:3});}};
    assert.equal(await v.ensureReviewPlacement(file,h),true);
    assert.equal(placed.where,'gap');assert.equal(placed.rects[0].page,90);
});

test('unlocated deletion focus remains pending instead of silently consuming the click',()=>{
    const {v}=fixture();let posted;
    delete v._replayReviewFocus;v._post=m=>{posted=m;};v.status=()=>{};
    v._reviewFocus={id:'removed',generation:4,pending:true,page:null,rects:[]};
    assert.equal(v._replayReviewFocus(),false);assert.equal(v._reviewFocus.pending,true);
    assert.equal(posted,undefined);
    v._reviewFocus.page=90;v._reviewFocus.rects=[{page:90,x:70,y:220,w:150,h:0,caret:true}];
    assert.equal(v._replayReviewFocus(),true);assert.equal(posted.page,90);assert.equal(v._reviewFocus.pending,false);
});

test('deletion seams sit below the last row at EOF and above the next row across a page break',()=>{
    const before={page:89,x:70,y:720,w:100,h:12},after={page:90,x:70,y:80,w:100,h:12};
    const end=placeHunk({rowsFor:line=>line===3 ? [before] : []},{aStart:4,aEnd:4});
    assert.equal(end.rects[0].page,89);assert.equal(end.rects[0].y,732);
    const boundary=placeHunk({rowsFor:line=>line===3 ? [before] : line===4 ? [after] : []},{aStart:4,aEnd:4});
    assert.equal(boundary.rects[0].page,90);assert.equal(boundary.rects[0].y,80);
});

test('deletions retaining blank source lines keep their seam through placement refresh',async()=>{
    const {ReviewSession}=require('../../tex/reviewSession');
    const {v,st,lane,file}=fixture();
    const before='Previous paragraph.\n\nDeleted paragraph.\n\nFollowing paragraph.';
    const current='Previous paragraph.\n\n\n\nFollowing paragraph.';
    lane.source.files.get('paper.tex').text=current;
    const s=new ReviewSession({file,baseText:before});s.recordArrival({text:current});s.update({currentText:current});
    assert.equal(s.hunks.length,1);const h=s.hunks[0];assert.equal(h.verb,'del');
    assert.ok(h.ourRange.endLine>h.ourRange.startLine,'a retained blank line makes a nonzero raw range');
    lane.source.forward=async(f,line)=>({hits:line===5 ? [{item:{page:90}}] : []});
    v.coord.ensureNativeMap=async()=>{st.map.lineRows=(f,line)=>line===5 ? [{page:90,x:70,y:220,w:150,h:12}] : [];return true;};
    v._review={refresh:async()=>s.update({currentText:current,map:v._reviewMap(st,file)})};
    assert.equal(await v.ensureReviewPlacement(file,h),true);
    assert.equal(s.hunks[0].where,'gap');assert.equal(s.hunks[0].rects[0].caret,true);
    s.update({currentText:current,map:v._reviewMap(st,file)});
    assert.equal(s.hunks[0].where,'gap','cached comparisons also preserve the deletion seam');
});


test('124 slow correction lookups publish bounded batches rather than repainting each label',async t=>{
    const {v,st,lane,file}=fixture();let refreshes=0,clock=10000;
    t.mock.method(Date,'now',()=>clock);
    lane.source.files.get('paper.tex').text=Array.from({length:124},(_,i)=>`Changed result ${i}`).join('\n');
    lane.source.forward=async()=>{clock+=200;return {hits:[{item:{page:58}}]};};
    v._review={refresh:async(f,opts)=>{assert.equal(opts.placementOnly,true);refreshes++;}};
    v._scheduleReviewLocations({file,pending:124,groups:[{hunks:Array.from({length:124},(_,i)=>
        ({id:`change-${i}`,startLine:i+1,endLine:i+2,rects:[]}))}]},st);
    await v._reviewLocationWork;
    assert.equal(v._reviewLocations.entries.size,124);assert.ok(refreshes<=9,`${refreshes} refreshes`);
});
