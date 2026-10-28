'use strict';
// Pure conversion worker: never opens VS Code documents, runs WL, or renders
// graphics. Even a malformed/large .nb cannot block the extension host's UI.
const {parentPort,workerData}=require('worker_threads');
const fs=require('fs/promises'),crypto=require('crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function convert(file) {
 const before=await fs.stat(file);
 if(before.size>64*1024*1024)throw Error('Notebook exceeds the 64 MiB virtual-read limit.');
 const bytes=await fs.readFile(file);
 const after=await fs.stat(file);
 if(bytes.length!==before.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)
  throw Error('Notebook changed while it was being read; retry for a consistent snapshot.');
 if(bytes.length>64*1024*1024)throw Error('Notebook exceeds the 64 MiB virtual-read limit.');
 const source=bytes.toString('utf8');let notebook,warnings={},graphics=0,failed=false;
 if(/\.nb$/i.test(file)) {
  const model=require('./nbModel'),named=require('../namedchars');
  const result=model.importNb(source,{namedChars:named.NAMED_CHARS,wlUTFtoNames:named.wlUTFtoNames},{mode:'save'});
  warnings=result.warnings || result.metadata?.wolfbookNbImport?.warnings || {};
  failed=!!result.metadata?.wolfbookNbImport?.failed;
  const banner=model.buildBanner(warnings,'save',{});
  if(banner && result.cells[0]?.value===banner)result.cells.shift();
  graphics=result.graphicsTasks?.length || 0;
  for(const c of result.cells) {
   c.value=c.value.replace(/<!--WBIMG:[A-Za-z0-9_]+-->/g,'*(Stored graphic — not rendered in the virtual notebook.)*');
   for(const o of c.outputs || [])for(const item of o.items || [])
    if(item.mime==='text/plain')item.data=String(item.data)
     .replace(/\(graphics — rendering to [^)]+\)/g,'(stored graphics — not rendered in virtual read)')
     .replace(/\(dynamic output — re-evaluate the input cell to regenerate it\)/g,'(stored dynamic output — not evaluated in virtual read)');
  }
  // Keep per-cell approximate box source, but never duplicate the entire .nb
  // source in the WB metadata or invent a live graphics-rendering job.
  notebook={cells:result.cells,metadata:{wolfbookVirtualImport:{format:'nb',warnings,failed,unrendered_graphics:graphics}}};
 } else {
  notebook=require('../utils/notebook-json').parseNotebookJson(source);
  if(!notebook || !Array.isArray(notebook.cells))throw Error('Notebook JSON has no cells array.');
 }
 const sourceHash=hash(bytes);
 notebook.cells.forEach((c,n)=>{
  if(![1,2].includes(c.kind) || typeof c.value!=='string')throw Error(`Invalid notebook cell ${n+1}.`);
  c.languageId ||= c.language || (c.kind===1 ? 'markdown' : 'wolfram');
  c.metadata={...(c.metadata || {}),virtualCellId:`vcell_${sourceHash.slice(0,16)}_${n+1}`};
  c.outputs ||= [];
 });
 const jsonBytes=Buffer.byteLength(JSON.stringify(notebook));
 if(jsonBytes>64*1024*1024)throw Error('Converted notebook exceeds the 64 MiB virtual snapshot limit.');
 return {file,stamp:`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`,
  sha256:sourceHash,source_bytes:bytes.length,json_bytes:jsonBytes,notebook,warnings,failed,unrendered_graphics:graphics};
}
convert(workerData.file).then(result=>parentPort.postMessage({ok:true,result}),error=>parentPort.postMessage({ok:false,error:error.message}));
