'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {NativeBuildLane}=require('../../tex/nativeCompileService');
function fixture(text){
 const edits=[],files=new Map([['main.tex',{text}]]),lane=Object.create(NativeBuildLane.prototype);
 Object.assign(lane,{root:'/paper/main.tex',projectDir:'/paper',version:0,edits:Promise.resolve(),
  source:{files,published:{artifact:{page_count:1}},
   async edit(file,start,end,text){edits.push({start,end,text});const old=files.get(file).text;files.set(file,{text:old.slice(0,start)+text+old.slice(end)});},
   async open(file,text){files.set(file,{text});},readPages:async pages=>({pages}),
  }});
 const change=(text,changes)=>lane.noteChange({uri:{fsPath:lane.root},getText:()=>text},changes);
 return {lane,files,edits,change};
}
test('a reader event already synchronized by a preview is not applied a second time',async()=>{
 const f=fixture('Alpha! Beta');
 await f.change('Alpha! Beta',[{rangeOffset:5,rangeLength:0,text:'!'}]);
 assert.equal(f.edits.length,0);assert.equal(f.files.get('main.tex').text,'Alpha! Beta');
});
test('missed/interleaved editor events reconcile only the changed span instead of corrupting offsets and closing the worker',async()=>{
 const f=fixture('Prefix 😀 old words. Suffix');
 await f.change('Prefix 😃 new words! Suffix',[{rangeOffset:19,rangeLength:1,text:'!'}]);
 assert.equal(f.files.get('main.tex').text,'Prefix 😃 new words! Suffix');
 assert.ok(f.edits[0].start>0 && f.edits[0].end<27,'unchanged prefix/suffix preserve their provenance');
 assert.equal(f.edits[0].start,7,'emoji replacement preserves the whole surrogate pair');
});
test('ordinary disjoint reader edits retain their individual source operations',async()=>{
 const f=fixture('Alpha Beta');
 await f.change('Alpha! Better',[{rangeOffset:6,rangeLength:4,text:'Better'},{rangeOffset:5,rangeLength:0,text:'!'}]);
 assert.deepEqual(f.edits,[{start:6,end:10,text:'Better'},{start:5,end:5,text:'!'}]);
});
test('map refresh survives a cancelled preview queue tail, while a real worker failure remains an error',async()=>{
 for(const name of ['AbortError','StaleBuild','Cancelled']){
  const f=fixture('Alpha');f.lane.edits=Promise.reject(Object.assign(Error('preview superseded'),{name}));
  assert.deepEqual(await f.lane.refresh([1]),{pages:[1]});
 }
 const f=fixture('Alpha');f.lane.edits=Promise.reject(Error('worker exited'));
 await assert.rejects(f.lane.refresh([1]),/worker exited/);
});
test('refresh drains reader writes appended while a superseded preview is settling',async()=>{
 const f=fixture('Alpha');let reject,release,reads=0;
 f.lane.source.readPages=async()=>{reads++;return {pages:[1]};};
 f.lane.edits=new Promise((_,r)=>reject=r);const pending=f.lane.refresh([1]);
 f.lane.edits=new Promise(r=>release=r);reject(Object.assign(Error('source superseded'),{name:'AbortError'}));
 await new Promise(r=>setImmediate(r));assert.equal(reads,0);release();await pending;assert.equal(reads,1);
});
test('cold compilation source synchronization preserves unchanged glyph ranges',async()=>{
 const f=fixture('Prefix old sentence. Suffix'),stop=Error('snapshot reached');
 f.lane.source.capture=async()=>{throw stop;};
 await assert.rejects(f.lane._compile({sourceFiles:[f.lane.root],overlay:new Map([[f.lane.root,'Prefix new sentence. Suffix']])}),e=>e===stop);
 assert.deepEqual(f.edits,[{start:7,end:10,text:'new'}]);
});
