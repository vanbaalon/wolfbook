'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {withVscodeStub}=require('./_stub-vscode');
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'));
const {ReviewUi}=withVscodeStub(()=>require('../../tex/reviewUi'));
const {memoizedPageSource}=require('../../tex/reviewPlacement');

test('native lines outside the loaded pages need no full-source read or alignment',()=>{
 const v=Object.create(TexViewer.prototype);let reads=0;
 const doc={uri:{fsPath:'/paper.tex'},getText:()=>{reads++;return 'Long paper\n'.repeat(50000);}};
 const st={map:{native:true,exact:true,glyphsForLine:()=>[]}};
 for(let line=1;line<=500;line++)assert.deepEqual(v._lineInkRects(st,doc,line),[]);
 assert.equal(reads,0);
});
test('overlapping correction objects align each line once per placement pass, including empty lines',()=>{
 const v=Object.create(TexViewer.prototype);let aligned=0,rows=0;
 v._textOf=()=> 'Text\n'.repeat(50000);
 v._lineInkRects=()=>{aligned++;return [];};
 const st={map:{available:true,exact:true,lineRows:()=>{rows++;return [];}}};
 let map=v._compareMap(st,'/paper.tex');
 for(let i=0;i<124;i++)for(let line=1;line<=12;line++)map.rowsFor(line);
 assert.equal(aligned,12);assert.equal(rows,12);
 map=v._compareMap(st,'/paper.tex');map.rowsFor(1);
 assert.equal(aligned,13,'a fresh placement pass does not reuse old geometry');
});
test('page-only discovery deduplicates shared probes without retaining glyph payloads',async()=>{
 let calls=0;const source=memoizedPageSource({forward:async()=>{calls++;return {hits:[{item:{page:58},box_path:['large geometry']}]};}});
 const replies=await Promise.all(Array.from({length:124},()=>source.forward('main.tex',10,2)));
 assert.equal(calls,1);assert.deepEqual(replies[0],{hits:[{item:{page:58}}]});
 await source.forward('main.tex',11,2);assert.equal(calls,2);
});
test('placement-only refresh does not serialize unchanged review history; text edits still persist',async()=>{
 let text='current',writes=0,updates=0,painted=0;
 const s={baseText:'base',_lastBaseText:'base',_lastText:'current',hunks:[{}],update(){updates++;}};
 const ui=Object.assign(Object.create(ReviewUi.prototype),{sessions:new Map([['paper',s]]),
  _syncStored(){},_currentText:()=>text,mapView:()=>({}),_checkpointFinished(){},
  persist(){writes++;return false;},paint(){painted++;},updateStatus(){},push(){},_lensEmitter:{fire(){}},output:{appendLine(){}}});
 await ui.refresh('paper',{placementOnly:true});assert.equal(writes,0);assert.equal(updates,1);assert.equal(painted,1);
 text='changed';await ui.refresh('paper',{placementOnly:true});assert.equal(writes,1);
});
