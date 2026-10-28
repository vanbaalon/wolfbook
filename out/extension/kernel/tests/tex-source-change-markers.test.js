'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {withVscodeStub}=require('./_stub-vscode');
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'));
const {locateSourcePage}=require('../../tex/reviewPlacement');
const {placeHunk}=require('../../tex/texCompare');
const {ReviewSession}=require('../../tex/reviewSession');

test('spacing changes find a nearby printed caption without borrowing its ink',async()=>{
    const text='\\caption{Printed caption}\n\\vspace{2em}\n\\label{fig:result}\n\\end{figure}';
    const source={forward:async(f,line)=>({hits:line===1 ? [{item:{page:45}}] : []})};
    const hit=await locateSourcePage(source,'paper.tex',text,2,3,()=>true,{contextual:true});
    assert.deepEqual(hit,{page:45,matchedLine:1,exact:false,contextual:true});
    assert.equal(await locateSourcePage(source,'paper.tex',text,2,3),null,'exact callers keep their original semantics');
    const caption={page:45,x:70,y:240,w:300,h:12};
    const placed=placeHunk({rowsFor:n=>n===1 ? [caption] : [],locate:()=>hit,
        objectAtLine:()=>({kind:'figure'}),objectRects:()=>[caption]}, {aStart:2,aEnd:3});
    assert.equal(placed.where,'gap');assert.equal(placed.contextual,true);
    assert.deepEqual(placed.rects,[{page:45,x:70,y:252,w:300,h:0,caret:true}]);
});

test('a correction deep inside a long hidden block skips its body and uses the nearer printed boundary',async()=>{
    const lines=['Before.','\\begin{comment}',...Array(3000).fill('Hidden prose.'),'\\end{comment}','After.'];
    for(const [line,expected] of [[100,1],[2900,3004]]) {
        const queried=[];
        const source={forward:async(f,n)=>{queried.push(n);return {hits:[{item:{page:n===1 ? 10 : 11}}]};}};
        const hit=await locateSourcePage(source,'paper.tex',lines.join('\n'),line,line+1,()=>true,{contextual:true});
        assert.equal(hit.matchedLine,expected);assert.equal(hit.contextual,true);
        assert.deepEqual(queried,[expected],'no worker lookups for thousands of hidden lines');
    }
});

test('adjacent hidden blocks are skipped even when their individual boundaries are far apart',async()=>{
    const text=['Heading.','\\begin{comment}',...Array(200).fill('Hidden.'),'\\end{comment}',
        '\\begin{comment}',...Array(200).fill('More hidden.'),'\\end{comment}'].join('\n');
    let calls=0;
    const hit=await locateSourcePage({forward:async(f,n)=>{calls++;assert.equal(n,1);return {hits:[{item:{page:92}}]};}},
        'paper.tex',text,390,391,()=>true,{contextual:true});
    assert.equal(hit.page,92);assert.equal(calls,1);
});

test('literal and commented comment delimiters do not hide genuine printed text',async()=>{
    for(const text of ['% \\begin{comment}\nPrinted.', '\\begin{verbatim}\n\\begin{comment}\n\\end{verbatim}\nPrinted.']) {
        const n=text.split('\n').length;
        const hit=await locateSourcePage({forward:async(f,line)=>{assert.equal(line,n);return {hits:[{item:{page:3}}]};}},
            'paper.tex',text,n,n+1,()=>true,{contextual:true});
        assert.equal(hit.exact,true);assert.equal(hit.contextual,undefined);
    }
});

test('context lookup cannot publish a page after the source revision changes',async()=>{
    let current=true;
    const hit=await locateSourcePage({forward:async(f,n)=>{
        if(n===1)current=false;return {hits:n===1 ? [{item:{page:3}}] : []};}},
        'paper.tex','Printed.\n% source comment',2,3,()=>current,{contextual:true});
    assert.equal(hit,null);
});

test('a following printed boundary gets a marker above it and a page hint survives an unloaded map',()=>{
    const hit={page:93,matchedLine:9,exact:false,contextual:true};
    const row={page:93,x:70,y:80,w:160,h:12};
    const waiting=placeHunk({rowsFor:()=>[],locate:()=>hit},{aStart:4,aEnd:5});
    assert.equal(waiting.where,'page');assert.equal(waiting.contextual,true);assert.deepEqual(waiting.rects,[]);
    const mapped=placeHunk({rowsFor:n=>n===9 ? [row] : [],locate:()=>hit},{aStart:4,aEnd:5});
    assert.equal(mapped.where,'gap');assert.equal(mapped.rects[0].y,80);assert.equal(mapped.rects[0].h,0);
});

test('clicking a nonprinting correction loads just its boundary page and publishes a source marker',async()=>{
    const file='/paper.tex',before='Caption.\n\\vspace{1em}',text='Caption.\n\\vspace{2em}';
    const v=Object.create(TexViewer.prototype);
    const lane={relative:()=> 'paper.tex',source:{files:new Map([['paper.tex',{text}]]),
        forward:async(f,line)=>({hits:line===1 ? [{item:{page:90}}] : []})}};
    const st={sourceRevision:2,generation:{generation:4,pdfHash:'pdf'},nativeLane:lane,
        map:{native:true,available:true,exact:false,lineRows:()=>[],objectAtLine:()=>null,sourceToRender:()=>null}};
    const session=new ReviewSession({file,baseText:before});session.recordArrival({text});session.update({currentText:text});
    const h=session.hunks[0];let mapped=0;
    Object.assign(v,{root:file,panel:{},_openedPdfHash:'pdf',_openedGeneration:4,
        coord:{roots:new Map([[file,st]]),noteNativeViewport:(root,p)=>assert.equal(p,90),
            ensureNativeMap:async(s,timeout,p)=>{mapped++;assert.equal(p,90);
                st.map.lineRows=(f,n)=>n===1 ? [{page:90,x:70,y:220,w:300,h:12}] : [];return true;},
            build:()=>{throw Error('source marker navigation must not compile');}},
        _review:{refresh:async()=>session.update({currentText:text,map:v._reviewMap(st,file)})}});
    assert.equal(await v.ensureReviewPlacement(file,h),true);assert.equal(mapped,1);
    const placed=session.hunks[0];assert.equal(placed.where,'gap');assert.equal(placed.contextual,true);
    assert.equal(session.payload().groups[0].hunks[0].contextual,true,'marker identity reaches the client');
    session.update({currentText:text,map:{rowsFor:n=>n===2 ? [{page:90,x:70,y:240,w:10,h:12}] : []}});
    assert.equal(session.payload().groups[0].hunks[0].contextual,false,'new exact placement clears an older context marker');
});
