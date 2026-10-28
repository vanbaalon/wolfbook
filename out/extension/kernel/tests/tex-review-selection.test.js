'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {withVscodeStub,makeVscodeStub}=require('./_stub-vscode');
const file='/paper/main.tex';let reveals=0;const doc={uri:{fsPath:file},lineCount:10000};
const decorations=[];const editor={document:doc,setDecorations:(kind,rows)=>decorations.push({kind,rows}),revealRange:()=>{reveals++;}};
const stub=makeVscodeStub();stub.Range=class {constructor(...args){this.args=args;}};stub.TextEditorRevealType={InCenterIfOutsideViewport:0};stub.window.visibleTextEditors=[editor];stub.workspace.openTextDocument=async()=>doc;
const {ReviewUi}=withVscodeStub(()=>require('../../tex/reviewUi'),stub);
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'),stub);
const {ReviewSession}=require('../../tex/reviewSession');

test('selecting among 600 corrections changes focus without republishing or repainting the batch',async()=>{
    const posted=[],session={generation:1,hunks:Array.from({length:600},(_,i)=>({id:'h'+i,ourRange:{startLine:i+1,endLine:i+2},rects:[{page:1}]})),
        payload:()=>{throw Error('selection rebuilt the full payload');}};
    const viewer=Object.assign(Object.create(TexViewer.prototype),{root:file,panel:{},_reviewShown:true,
        coord:{roots:new Map([[file,{files:[file]}]])},_post:m=>posted.push(m),reviewPageBehind:()=>false,focusReviewHunk:h=>posted.push({type:'navigate',id:h.id})});
    const ui=new ReviewUi({viewer});ui.sessions.set(file,session);ui._decor={focus:'focus'};
    ui.paint=()=>{throw Error('selection recalculated every editor decoration');};
    try{
        for(const id of ['h0','h550','h11','h550'])await ui.show(file,id);
        assert.deepEqual(posted.filter(m=>m.type==='reviewSelection').map(m=>m.id),['h0','h550','h11','h550']);
        assert.equal(posted.filter(m=>m.type==='navigate').length,4);assert.equal(posted.some(m=>m.type==='review'),false);
        assert.equal(decorations.length,4);assert.ok(decorations.every(d=>d.kind==='focus'&&d.rows.length===1));
        assert.equal(reveals,4);assert.equal(ui.focused.get(file),'h550');
    }finally{ui.dispose();}
});

test('an unopened review still publishes its initial state and wrong-paper selection is refused',async()=>{
    const viewer=Object.assign(Object.create(TexViewer.prototype),{root:file,panel:{},_reviewShown:false,coord:{roots:new Map([[file,{files:[file]}]])}});
    assert.equal(viewer.selectReviewHunk(file,'h'),false);viewer._reviewShown=true;
    assert.equal(viewer.selectReviewHunk('/other.tex','h'),false);
    let published=0;const ui=new ReviewUi({viewer:{selectReviewHunk:()=>false,viewerOnly:true}});
    ui.sessions.set(file,{generation:1,hunks:[{id:'h',ourRange:{startLine:1,endLine:2}}]});ui.push=()=>{published++;};ui.paintFocus=()=>{};
    try{await ui.show(file,'h');assert.equal(published,1);}finally{ui.dispose();}
});

test('word marks are reused through repeated publication and placement-only updates, but invalidate with source',()=>{
    const s=new ReviewSession({file,baseText:'Old sentence.\n\nStable text.'});s.update({currentText:'New sentence.\n\nStable text.',map:{}});
    const first=s.payload().groups.flatMap(g=>g.hunks)[0].words;assert.ok(first);
    for(let i=0;i<20;i++)assert.equal(s.payload().groups.flatMap(g=>g.hunks)[0].words,first);
    s.hunks=s.hunks.map(h=>({...h,page:2,rects:[{page:2}]}));assert.equal(s.payload().groups.flatMap(g=>g.hunks)[0].words,first);
    s.hunks[0]={...s.hunks[0],ourText:'Another sentence.'};assert.notEqual(s.payload().groups.flatMap(g=>g.hunks)[0].words,first);
    s.hunks=[];s.payload();assert.equal(s._wordRangesCache.size,0);
});

test('selection completes while a passive viewer check is pending and clicks share that check',async()=>{
    let finish,shown=0,checks=0;const pending=new Promise(resolve=>{finish=resolve;});
    const session={generation:1,hunks:[{id:'h',page:1}]},ui={sessions:new Map([[file,session]]),sessionFor:()=>session,show:async()=>{shown++;}};
    const viewer=Object.assign(Object.create(TexViewer.prototype),{root:file,_review:ui,_reviewHunkReady:()=>true,
        _ensureViewerForReview:(_h,_g,options)=>{assert.equal(options.passive,true);checks++;return pending;},_log(){}});
    await viewer._onReviewAction({action:'show',id:'h'});await viewer._onReviewAction({action:'show',id:'h'});
    assert.equal(shown,2);assert.equal(checks,1);assert.ok(viewer._reviewHealthWork);finish(true);await viewer._reviewHealthWork;
});

test('busy or late passive checks never restart a healthy/newer PDF worker',async()=>{
    let restarts=0;const viewer=Object.assign(Object.create(TexViewer.prototype),{root:file,panel:{},_openedGeneration:1,
        _probeViewer:async()=>({ok:false,reason:'viewer did not answer'}),_restartPdfWorker:()=>{restarts++;}});
    await viewer._ensureViewerForReview({page:1},1,{passive:true});assert.equal(restarts,0);
    viewer._probeViewer=async()=>({ok:false,workerDead:true,reason:'PDF worker stopped'});
    await viewer._ensureViewerForReview({page:1},1,{passive:true});assert.equal(restarts,1);
    viewer._probeViewer=async()=>{viewer._openedGeneration=2;return {ok:false,workerDead:true};};
    await viewer._ensureViewerForReview({page:1},1,{passive:true});assert.equal(restarts,1);
});
