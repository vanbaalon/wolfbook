'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {withVscodeStub}=require('./_stub-vscode');
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'));
function fixture(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-range-recovery-'));
    const root=path.join(dir,'main.tex'),pdfPath=path.join(dir,'main.pdf');fs.writeFileSync(pdfPath,'%PDF-1.5\nimmutable artifact\n%%EOF\n');
    const gen={root,pdfPath,generation:7,pageCount:1,pdfHash:'same-pdf',runner:'wlatex'},posted=[];
    const coord={roots:new Map([[root,{generation:gen,compiling:false}]]),build:()=>{throw Error('transport recovery must not compile');}};
    const viewer=new TexViewer({extensionUri:{fsPath:path.resolve(__dirname,'../../../..')}},coord,{});
    Object.assign(viewer,{root,_webviewReady:true,panel:{title:'',webview:{asWebviewUri:u=>({toString:()=>u.fsPath}),postMessage:m=>{posted.push(m);return Promise.resolve(true);}}},
        _postEditAnchor:async()=>{},syncFromEditor(){},_captureReaderView:async()=>{},_tourObserve(){}});
    t.after(()=>{viewer._pdfRanges?.close();fs.rmSync(dir,{recursive:true,force:true});});
    return {viewer,gen,posted,coord};
}

test('a failed admitted range reopens the same PDF as full bytes without compile',async t=>{
    const {viewer,posted,gen}=fixture(t);await viewer.refresh();const first=posted.find(m=>m.type==='open');
    assert.ok(first.pdfRange);assert.equal(first.pdfBase64,null);
    await viewer._onMessage({type:'pdfRangeFailed',generation:7,pdfHash:'same-pdf',token:first.pdfRange.token,error:'PDF byte request timed out'});
    if(viewer._refreshRun)await viewer._refreshRun;
    const opens=posted.filter(m=>m.type==='open');assert.equal(opens.length,2);assert.equal(opens[1].generation,7);assert.equal(opens[1].pdfHash,'same-pdf');
    assert.equal(opens[1].pdfRange,null);assert.equal(opens[1].pdfBase64,fs.readFileSync(gen.pdfPath).toString('base64'));
    assert.equal(viewer.coord.roots.get(viewer.root).generation,gen,'no generation or map replacement');
    await viewer._onMessage({type:'pdfRangeFailed',generation:7,pdfHash:'same-pdf',token:first.pdfRange.token});
    assert.equal(posted.filter(m=>m.type==='open').length,2,'no endless recovery');
    await viewer._onMessage({type:'pdfRangeRelease',token:first.pdfRange.token});assert.equal(viewer._pdfRanges.files.size,0);
});

test('stale byte failures never reopen another document or generation',async t=>{
    const {viewer,posted}=fixture(t);await viewer.refresh();const first=posted.find(m=>m.type==='open');
    for(const patch of [{generation:6},{pdfHash:'old-pdf'},{token:'old-resource'}])await viewer._onMessage({type:'pdfRangeFailed',generation:7,pdfHash:'same-pdf',token:first.pdfRange.token,...patch});
    assert.equal(posted.filter(m=>m.type==='open').length,1);
});

test('byte requests take the direct path without invoking reader gesture work',async t=>{
    const {viewer,posted}=fixture(t);await viewer.refresh();const resource=posted.find(m=>m.type==='open').pdfRange;
    viewer._tourObserve=()=>{throw Error('range transport is not a gesture');};viewer._syncInstant=true;
    await viewer._onMessage({type:'pdfRangeRequest',token:resource.token,request:1,begin:0,end:4});
    assert.equal(Buffer.from(posted.at(-1).data,'base64').toString(),'%PDF');assert.equal(viewer._syncInstant,true);
});

test('a parser stall switches transport and a later different artifact uses ranges again',async t=>{
    const {viewer,posted,coord,gen}=fixture(t);await viewer.refresh();const resource=posted.find(m=>m.type==='open').pdfRange;
    await viewer._onMessage({type:'openStalled',generation:7,pdfHash:'same-pdf',token:resource.token});if(viewer._refreshRun)await viewer._refreshRun;
    assert.equal(posted.filter(m=>m.type==='open').at(-1).pdfRange,null);
    coord.roots.get(viewer.root).generation={...gen,generation:8,pdfHash:'next-pdf'};await viewer.refresh();
    assert.ok(posted.filter(m=>m.type==='open').at(-1).pdfRange,'fallback is limited to this artifact');
});
