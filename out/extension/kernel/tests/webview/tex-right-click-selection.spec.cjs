'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {makeVscodeStub,withVscodeStub}=require('../_stub-vscode');
const texDir=process.env.WPAPER_EXT_ROOT ? path.join(process.env.WPAPER_EXT_ROOT,'out/extension/tex') : path.resolve(__dirname,'../../../tex');
const {compile}=require(path.join(texDir,'compileService'));
const {GlyphMap}=require(path.join(texDir,'glyphMap'));
const {NativeMap}=require(path.join(texDir,'nativeMap'));
const {NativeBuildLane}=require(path.join(texDir,'nativeCompileService'));
const {scanTex}=require(path.join(texDir,'texScanner'));
const {buildModel}=require(path.join(texDir,'texModel'));
class Position {constructor(line,character){this.line=line;this.character=character;}}
class Range {constructor(start,end){this.start=start;this.end=end;}}
class Selection extends Range {constructor(anchor,active){
    const forward=anchor.line<active.line || anchor.line === active.line && anchor.character<=active.character;
    super(forward ? anchor : active,forward ? active : anchor);this.anchor=anchor;this.active=active;
}}
const stub=makeVscodeStub({Position,Range,Selection,workspace:{textDocuments:[],
    onDidChangeTextDocument:()=>({dispose(){}})},window:{visibleTextEditors:[]}});
const {TexViewer}=withVscodeStub(()=>require(path.join(texDir,'texViewer')),stub);
const fixtureTex='\\documentclass{article}\n\\providecommand{\\SelectionSkip}{}\\IfFileExists{spacing.tex}{\\input{spacing}}{}\n\\begin{document}\\SelectionSkip\nThe chosen fragment $x^2$ stays selected while the full compile replaces the map.\n\nA different paragraph is below the selected one.\n\\end{document}\n';
const tests=['standard','Pro'].map(mode=>({
    id:`right-click-refresh-${mode}`,name:`${mode}: right-click opens the clicked paragraph after a full compile, clearing the old selection`,
    async run(t){
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wpaper-right-click-')),file=path.join(dir,'paper.tex');
        fs.writeFileSync(file,fixtureTex);let lane;
        try {
            const model=buildModel(scanTex(fixtureTex,{file}),{file});
            const gen=mode === 'Pro' ? await (lane=new NativeBuildLane(file,process.env.WPAPER_NATIVE_TEST_DIR || '/Users/k0959535/Dropbox/Programming/WLaTeX/wlatex'))
                .compile({root:file,sourceFiles:[file],nativePages:[1],timeoutMs:60000})
                : await compile({root:file,sourceFiles:[file],engine:'lualatex',glyphMap:true,outDir:path.join(dir,'build'),timeoutMs:30000});
            assert.equal(gen.ok,true,JSON.stringify(gen.diagnostics));
            const makeMap=(generation=gen)=>mode === 'Pro' ? new NativeMap({generation,model,nativeView:generation.nativeView,nativeSource:generation.nativeSource})
                : new GlyphMap({generation,model});
            const doc={uri:stub.Uri.file(file),version:1,get lineCount(){return fixtureTex.split('\n').length;},
                positionAt(offset){const lines=fixtureTex.slice(0,offset).split('\n');return new Position(lines.length-1,lines.at(-1).length);},
                offsetAt(p){const lines=fixtureTex.split('\n');return lines.slice(0,p.line).reduce((n,line)=>n+line.length+1,0)+p.character;},
                getText(range){return range ? fixtureTex.slice(this.offsetAt(range.start),this.offsetAt(range.end)) : fixtureTex;},
                lineAt(n){return {text:fixtureTex.split('\n')[n]};}};
            stub.workspace.openTextDocument=async()=>doc;
            const st={root:file,map:makeMap(),generation:gen};
            const coord={roots:new Map([[file,st]]),rootFor:()=>file,stateFor:()=>st};
            const v=new TexViewer({extensionUri:stub.Uri.file(path.resolve(texDir,'../../..'))},coord,{get:()=>({model})});
            const posted=[];Object.assign(v,{root:file,panel:{webview:{postMessage:m=>posted.push(m)}},
                _openedGeneration:10,_openedPdfHash:gen.pdfHash,_nativeCursorRequest:1,followMode:'scroll',
                _rememberEditState:()=>{},_ensureDocListener:()=>{},_postEditSelection:()=>{}});
            const from=fixtureTex.indexOf('chosen'),to=fixtureTex.indexOf('stays')-1;
            const selection=new Selection(doc.positionAt(to),doc.positionAt(from));
            const bytes=fs.readFileSync(gen.pdfPath).toString('base64');
            await t.open(10,{pdfBase64:bytes,pages:gen.pageCount});
            await t.post({type:'engine',state:mode === 'Pro' ? 'live' : 'off'});
            if (mode === 'Pro') await v._syncNativeCursor(st,{document:doc,selection},{preserveView:true},1);
            else v._postSelection(st,doc,selection,{keepRange:true});
            assert.ok(v._lastSelection);
            for(const m of posted.splice(0))await t.post(m);
            await t.waitFor(()=>document.querySelectorAll('.selbrk').length === 2,null,{what:'the original source selection'});
            const before=await t.eval(()=>parseFloat(document.querySelector('.selbrk.start').style.top));
            // An included layout definition moves the text without changing
            // the selected file. Follow is off and the editor cursor need not
            // own the viewer's range during the handoff.
            v.followMode='off';
            fs.writeFileSync(path.join(dir,'spacing.tex'),'\\renewcommand{\\SelectionSkip}{\\vspace*{36pt}}');
            const moved=mode === 'Pro' ? await lane.compile({root:file,sourceFiles:[file,path.join(dir,'spacing.tex')],nativePages:[1],timeoutMs:60000})
                : await compile({root:file,sourceFiles:[file,path.join(dir,'spacing.tex')],engine:'lualatex',glyphMap:true,outDir:path.join(dir,'moved'),timeoutMs:30000});
            assert.equal(moved.ok,true);
            st.map=makeMap(moved);st.generation=moved;doc.version++;
            await t.open(11,{pdfBase64:fs.readFileSync(moved.pdfPath).toString('base64'),pdfHash:moved.pdfHash,pages:moved.pageCount});
            assert.equal(await t.eval(()=>document.querySelectorAll('.selbrk').length),0,'old rectangles are hidden while the new source geometry is pending');
            await v._onMessage({type:'opened',generation:11,pdfHash:moved.pdfHash});
            for(const m of posted.splice(0))await t.post(m);
            await t.waitFor(()=>document.querySelectorAll('.selbrk').length === 2,null,{what:'selection retained after the PDF handoff'});
            const after=await t.eval(()=>parseFloat(document.querySelector('.selbrk.start').style.top));
            assert.ok(after>before+20,`${mode}: selection must follow the text down, ${before} -> ${after}`);
            await t.clear();
            const row=st.map.lineRows(file,6)[0];
            assert.ok(row,'the different paragraph has current mapped geometry');
            const point=await t.toClient(row.page,row.x+20,row.y+row.h/2);
            await t.page.mouse.click(point.x,point.y,{button:'right'});
            const message=await t.waitPosted('editHere');
            assert.equal(message.preserveSelection,false);
            const clears=await t.posted('selectionClear');
            assert.equal(clears.length,1);
            assert.equal(await t.eval(()=>document.querySelectorAll('.selbrk,.selfill,.selact').length),0);
            await v._onMessage(clears[0]);
            assert.equal(v._lastSelection,null);
            await v._openEditSession(message);
            const opened=posted.find(m=>m.type === 'editOpen');
            assert.ok(opened,JSON.stringify(posted));
            assert.equal(opened.startLine,6,'the clicked paragraph owns the editor');
            assert.equal(opened.text,'A different paragraph is below the selected one.');
            if(mode === 'Pro') {
                assert.ok(opened.clickOffset>0,'the native map supplies the clicked source caret');
                assert.equal(opened.caretStart,opened.caretEnd);
            }
            for(const m of posted.splice(0))await t.post(m);
            await t.waitFor(()=>!!document.querySelector('.editcard textarea'),null,{what:'mini-editor from the actual host handler'});
            const actual=await t.eval(()=>{const ta=document.querySelector('.editcard textarea');return {
                value:ta.value,start:ta.selectionStart,end:ta.selectionEnd,focused:ta===document.activeElement};});
            assert.equal(actual.value,opened.text);
            assert.equal(actual.start,actual.end,'the previous selection is not carried into the clicked paragraph');
            assert.equal(actual.focused,true);
            assert.ok(!(await t.eval(()=>document.getElementById('status').textContent)).includes('selection changed'));
        }finally{if(lane)await lane.close();fs.rmSync(dir,{recursive:true,force:true});}
    },
}));
tests.push({id:'live-selection-redraw',name:'live redraw hides old selection geometry and rejects replies for an older page',async run(t){
    const word=t.word('chosen');
    const span=(identity,y=word.y)=>({native:true,geometry:{generation:1,livePages:{1:identity}},
        rows:[{page:1,x:word.x,y,w:word.w,h:word.h}],
        start:{exactEdge:{page:1,x:word.x,y,h:word.h}},
        end:{exactEdge:{page:1,x:word.x+word.w,y,h:word.h}},lines:1});
    await t.post({type:'selection',span:span(null)});
    await t.waitFor(()=>document.querySelectorAll('.selbrk').length===2,null,{what:'initial selection'});
    await t.clear();
    const txdl={fonts:[],ops:[{op:'rule',x:0,y:0,w:60*65536,h:6*65536}]};
    await t.post({type:'txdlPage',generation:20,page:1,changed:true,identity:'page-20',txdl});
    await t.waitPosted('selectionReproject',m=>m.liveIdentity==='page-20');
    assert.equal(await t.eval(()=>document.querySelectorAll('.selbrk, .selfill, .selact').length),0);
    await t.post({type:'selection',span:span(null)});
    assert.equal(await t.eval(()=>document.querySelectorAll('.selbrk').length),0,'late cold geometry cannot paint on the live page');
    await t.post({type:'selection',span:span('page-20',word.y+36)});
    await t.waitFor(()=>document.querySelectorAll('.selbrk').length===2,null,{what:'reprojected live selection'});
    const y=await t.eval(()=>parseFloat(document.querySelector('.selbrk.start').style.top));
    await t.clear();
    await t.post({type:'txdlPage',generation:20,page:1,changed:true,identity:'page-20',txdl});
    assert.equal(await t.eval(()=>parseFloat(document.querySelector('.selbrk.start').style.top)),y,'same identity redraw preserves correct geometry');
    const SP=65536;
    const placement={page:1,dx:0,dy:80*SP,clip:[0,0,400*SP,600*SP],clear:[0,60*SP,400*SP,100*SP],below:[0,100*SP,400*SP,600*SP],shift:14*SP};
    await t.post({type:'txdlFragment',generation:21,page:1,index:0,placement,txdl,mapIdentity:'fragment-21'});
    await t.waitPosted('selectionReproject',m=>m.liveIdentity==='fragment-21');
    assert.equal(await t.eval(()=>document.querySelectorAll('.selbrk').length),0);
    await t.post({type:'selection',span:span('page-20',word.y+36)});
    assert.equal(await t.eval(()=>document.querySelectorAll('.selbrk').length),0,'late page geometry cannot paint on a newer paragraph fragment');
    await t.post({type:'selection',span:span('fragment-21',word.y+50)});
    await t.waitFor(()=>document.querySelectorAll('.selbrk').length===2,null,{what:'fragment selection'});
}});
module.exports={fixtureTex,tests};
