'use strict';
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const {Worker}=require('worker_threads');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
class VirtualNotebooks {
 constructor({maximum=4,maxBytes=64*1024*1024,timeoutMs=30000}={}) {
  this.maximum=maximum;this.maxBytes=maxBytes;this.timeoutMs=timeoutMs;
  this.cache=new Map();this.pending=new Map();this.chain=Promise.resolve();
 }
 async load({file,virtual_notebook_id},baseDirectory,token) {
  if(token?.isCancellationRequested)throw Error('Virtual read cancelled.');
  if(virtual_notebook_id && this.cache.has(virtual_notebook_id)) {
   const hit=this.cache.get(virtual_notebook_id);
   if(file && await fs.realpath(path.resolve(baseDirectory || process.cwd(),file))!==hit.file)throw Error('File does not match this virtual notebook ID.');
   this.cache.delete(virtual_notebook_id);this.cache.set(virtual_notebook_id,hit);return hit;
  }
  if(!file)throw Error('Provide file to create/recover a virtual notebook; the requested snapshot is unavailable.');
  if(!/\.(nb|wb|evsnb|vsnb)$/i.test(file))throw Error('Expected a .nb, .wb, .evsnb or .vsnb file.');
  file=await fs.realpath(path.resolve(baseDirectory || process.cwd(),file));
  const stat=await fs.stat(file);
  if(!stat.isFile())throw Error('Notebook path is not a regular file.');
  if(stat.size>64*1024*1024)throw Error('Notebook exceeds the 64 MiB virtual-read limit.');
  const stamp=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached=[...this.cache.values()].find(s=>s.file===file && s.stamp===stamp);
  if(cached && (!virtual_notebook_id || cached.id===virtual_notebook_id))return cached;
  const key=file+'|'+stamp;
  if(!this.pending.has(key)) {
   if(this.pending.size>=4)throw Error('Virtual notebook reader is busy; retry after the pending reads complete.');
   const work=this.chain.then(()=>this._convert(file));this.chain=work.catch(()=>{});
   this.pending.set(key,work.finally(()=>this.pending.delete(key)));
  }
  const result=await this.pending.get(key);
  if(token?.isCancellationRequested)throw Error('Virtual read cancelled.');
  const id='virtual_nb_'+sha(file+'\0'+result.sha256).slice(0,32);
  if(virtual_notebook_id && virtual_notebook_id!==id)throw Error('The source changed; this file cannot recreate the requested immutable snapshot. Read file without virtual_notebook_id for a new snapshot.');
  const snapshot={...result,id};this.cache.set(id,snapshot);
  let size=[...this.cache.values()].reduce((sum,s)=>sum+s.json_bytes,0);
  while(this.cache.size>this.maximum || size>this.maxBytes) {
   const oldest=this.cache.keys().next().value;size-=this.cache.get(oldest).json_bytes;this.cache.delete(oldest);
  }
  if(!this.cache.has(id))throw Error('Virtual snapshot exceeds the reader memory budget.');
  return snapshot;
 }
 _convert(file) {
  return new Promise((resolve,reject)=>{
   const worker=new Worker(path.join(__dirname,'virtual-worker.js'),{workerData:{file},resourceLimits:{maxOldGenerationSizeMb:384,stackSizeMb:8}});
   let done=false;
   const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);worker.terminate().catch(()=>{});error ? reject(error) : resolve(result);};
   const timer=setTimeout(()=>finish(Error('Virtual conversion exceeded 30 seconds; no file was changed.')),this.timeoutMs);
   worker.once('message',m=>finish(m.ok ? null : Error(m.error),m.result));
   worker.once('error',e=>finish(e));worker.once('exit',code=>{if(!done)finish(Error('Virtual conversion worker exited ('+code+').'));});
  });
 }
 project(snapshot,input={}) {
  const view=input.view || 'overview';
  if(!['overview','cells','wb','search'].includes(view))throw Error('view must be overview, cells, wb or search.');
  const start=input.startCell ?? 1,limit=input.limit ?? (view==='overview' ? 100 : 20);
  if(!Number.isInteger(start)||start<1||!Number.isInteger(limit)||limit<1||limit>100)throw Error('startCell must be a positive integer; limit must be 1–100.');
  const cells=snapshot.notebook.cells,ids=input.cell_ids;
  if(ids && (!Array.isArray(ids)||ids.some(id=>typeof id!=='string')))throw Error('cell_ids must be an array of virtual cell IDs.');
  const outputText=c=>(c.outputs || []).flatMap(o=>(o.items || []).filter(i=>['text/plain','text/markdown'].includes(i.mime)).map(i=>String(i.data ?? ''))).join('\n');
  const selected=[];
  if(view==='search' && (typeof input.query!=='string' || !input.query.trim()))throw Error('A nonempty literal query is required for search.');
  const query=String(input.query || '').toLocaleLowerCase();let next=null;
  for(let i=start-1;i<cells.length;i++) {
   const c=cells[i];if(ids && !ids.includes(c.metadata.virtualCellId))continue;
   if(view==='search' && !(c.value+'\n'+(input.include_outputs===false ? '' : outputText(c))).toLocaleLowerCase().includes(query))continue;
   if(selected.length===limit){next=i+1;break;}selected.push({cellNumber:i+1,cellId:c.metadata.virtualCellId,cell:c});
  }
  const result={virtual_notebook_id:snapshot.id,read_only:true,source:{file:snapshot.file,sha256:snapshot.sha256,bytes:snapshot.source_bytes,origin:'disk'},
   conversion:{format:path.extname(snapshot.file).slice(1),evaluated:false,failed:snapshot.failed,warnings:snapshot.warnings,unrendered_graphics:snapshot.unrendered_graphics},
   cell_count:cells.length,view,startCell:start,next_startCell:next,returned_cells:selected.length};
  if(view==='wb')result.notebook={metadata:snapshot.notebook.metadata || {},cells:selected.map(s=>s.cell)};
  else result.cells=selected.map(({cellNumber,cellId,cell:c})=>view==='overview' ? {
   cellNumber,cellId,kind:c.kind===2 ? 'code' : 'markdown',preview:c.value.split('\n').find(s=>s.trim())?.slice(0,200) || '',
   source_chars:c.value.length,output_count:c.outputs?.length || 0,approximate:!!c.metadata?.nbImport?.approx,
  } : {...c,cellNumber,cellId,...(input.include_outputs===false ? {outputs:[]} : {})});
  return result;
 }
}
module.exports={VirtualNotebooks};
