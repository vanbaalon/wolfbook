'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {withVscodeStub}=require('./_stub-vscode');
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'));
const file='/paper/main.tex';
function fixture(){
    const text='\\begin{document}\n\\section{Parent}\nParent body.\n\\subsection{Child}\nChild body.\n\\end{document}';
    const heads=[{kind:'section-heading',cmd:'section',level:2,title:'Parent',stableKey:'parent',
        sourceRange:{file,startLine:2,endLine:2}},
        {kind:'section-heading',cmd:'subsection',level:3,title:'Child',stableKey:'child',sourceRange:{file,startLine:4,endLine:4}}];
    const row={page:29,x:72,y:180,w:140,h:12};let loaded=false;
    const lane={relative:()=> 'main.tex',source:{files:new Map([['main.tex',{text}]]),
        forward:async(f,line)=>({hits:[{item:{page:line===2?29:30}}]})}};
    const st={map:{native:true,available:true,lineRows:(f,line)=>loaded && line===2?[row]:[],
        rangeRows:()=>[{page:37,x:72,y:300,w:160,h:12}]},generation:{generation:5,pdfHash:'pdf'},
        sourceRevision:2,nativeLane:lane};
    const v=Object.create(TexViewer.prototype),posts=[];
    Object.assign(v,{root:file,panel:{},_openedPdfHash:'pdf',_openedGeneration:5,shownGeneration:5,
        _post:m=>posts.push(m),_log:()=>{},_projectModels:()=>new Map([[file,{objects:heads}]]),_textOf:()=>text,
        coord:{roots:new Map([[file,st]]),noteNativeViewport:()=>{},
            ensureNativeMap:async(s,ms,page)=>{assert.equal(page,29);loaded=true;return true;}}});
    return {v,st,lane,heads,row,posts,setLoaded:x=>{loaded=x;}};
}
test('a windowed map must not place a parent heading at the end of its body',()=>{
    const {v,st}=fixture();const items=v._sectionControls(st);
    assert.equal(items[0].page,null,'page 37 belongs to distant body ink, not the heading');
    assert.equal(items[0].y,null,'no guessed overlay at the top of a page');
    st.map.native=false;
    st.map.rangeRows=()=>[{page:29,x:70,y:180,w:100,h:12},{page:37,x:70,y:200,w:100,h:12}];
    assert.equal(v._sectionControls(st)[0].page,29,'a full conventional map uses the first body row, not its last');
});
test('heading page discovery does not load every native page or compile',async()=>{
    const {v,st,posts}=fixture();let loads=0;
    v.coord.ensureNativeMap=()=>{loads++;throw Error('outline discovery must not map pages');};
    await v._postSections();await v._sectionLocationWork;
    const items=posts.filter(m=>m.type==='sections').at(-1).items;
    assert.deepEqual(items.map(i=>i.page),[29,30]);
    assert.ok(items.every(i=>i.pageApproximate && i.y===null));assert.equal(loads,0);
});
test('clicking a distant section queries its title and loads its target window',async()=>{
    const {v,st,lane,posts,row}=fixture(),queries=[];
    lane.source.forward=async(f,line,column)=>{queries.push({line,column});return {hits:[{item:{page:29}}]};};
    await v._gotoEdit({file,line:2,endLine:5,label:'section'});
    assert.deepEqual(queries,[{line:2,column:9}],'use printed heading text instead of the section command');
    const message=posts.find(m=>m.type==='navigateTo');
    assert.equal(message.page,29);assert.equal(message.generation,5);assert.deepEqual(message.rects,[row]);
    assert.equal(v._reviewNavigation.owner,'viewer');
    assert.ok(!posts.some(m=>m.type==='status'),'no misleading unmapped warning');
});
test('a known heading page remains navigable when exact geometry cannot load promptly',async()=>{
    const {v,posts}=fixture();v.coord.ensureNativeMap=async()=>false;
    await v._gotoEdit({file,line:2,endLine:2,label:'section'});
    const message=posts.find(m=>m.type==='navigateTo');
    assert.equal(message.page,29);assert.deepEqual(message.rects,[]);assert.match(message.label,/≈/);
});
test('an editor gesture or source edit cancels an outstanding section jump',async()=>{
    for(const reason of ['editor','source']){
        const {v,st,lane,posts}=fixture();let release;
        lane.source.forward=()=>new Promise(resolve=>{release=resolve;});
        const work=v._gotoEdit({file,line:2,endLine:5,label:'section'});
        if(reason==='editor')v._reviewNavigation=null;else {st.sourceRevision++;st.sourceAhead=true;}
        release({hits:[{item:{page:29}}]});await work;
        assert.ok(!posts.some(m=>m.type==='navigateTo'),'late geometry cannot move a reader who moved on');
    }
});
test('the heading cache cannot reuse coordinates from another PDF',()=>{
    const {v,st,setLoaded}=fixture();setLoaded(true);assert.equal(v._sectionControls(st)[0].page,29);
    setLoaded(false);v._openedPdfHash='other';st.generation={generation:6,pdfHash:'other'};
    assert.equal(v._sectionControls(st)[0].page,null);
});
test('section discovery stops publishing when the source changes during lookup',async()=>{
    const {v,st,lane,posts}=fixture();let release;
    lane.source.forward=()=>new Promise(resolve=>{release=resolve;});
    await v._postSections();const work=v._sectionLocationWork;
    st.sourceAhead=true;st.sourceRevision++;
    release({hits:[{item:{page:29}}]});await work;
    assert.equal(v._reviewLocations.entries.size,0);
    assert.ok(posts.filter(m=>m.type==='sections').every(m=>!m.items[0].page));
});
test('navigation can recover an unavailable viewport map from the current native source',async()=>{
    const {v,st,posts}=fixture();st.map.available=false;
    await v._gotoEdit({file,line:2,endLine:2,label:'section'});
    assert.equal(posts.find(m=>m.type==='navigateTo').page,29);
});
