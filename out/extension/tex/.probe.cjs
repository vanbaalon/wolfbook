const {NativeBuildLane}=require('./nativeCompileService');const {NativeMap}=require('./nativeMap');const {FLAG}=require('./renderMap');const {execFileSync}=require('child_process');const fs=require('fs');const path=require('path');
(async()=>{const [dir,main]=process.argv.slice(2);const lane=new NativeBuildLane(path.join(dir,main),'/Users/k0959535/Dropbox/Programming/WLaTeX/wlatex');
const gen=await lane.compile({timeoutMs:600000});const all=Array.from({length:gen.pageCount},(_,i)=>i+1);const view=await lane.refresh(all);
const map=new NativeMap({nativeView:view,nativeSource:lane.source,generation:{pdfHash:gen.pdfHash,projectDir:dir,outDir:gen.outDir}});
const pp=execFileSync('pdftotext',['-bbox',gen.pdfPath,'-'],{encoding:'utf8',maxBuffer:1<<28}).split('<page ').slice(1);const cls={};
for(const n of all)for(const m of pp[n-1].matchAll(/<word xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)">(.*)<\/word>/g)){
 const w=(m[5].toLowerCase().match(/[a-z]{3,}/)||[])[0];if(!w||!/^[^A-Za-z]*[A-Za-z]+[^A-Za-z]*$/.test(m[5]))continue;const [x0,y0,x1,y1]=m.slice(1,5).map(Number);
 const r=map.renderToSource(n,(x0+x1)/2,(y0+y1)/2);if(!r.file||r.generated)continue;const lines=fs.readFileSync(r.file,'utf8').split('\n');if((lines[r.line-1]||'').toLowerCase().includes(w))continue;
 let d=Infinity,at=-1;lines.forEach((l,i)=>{if(l.toLowerCase().includes(w)&&Math.abs(i-(r.line-1))<d){d=Math.abs(i-(r.line-1));at=i}});if(d<=10)continue;
 const key=(lines[r.line-1]||'').trim().slice(0,40);(cls[key]||=[]).push(m[5]+'@'+(at+1)+'(-'+d+')')}
for(const [k,v] of Object.entries(cls).sort((a,b)=>b[1].length-a[1].length).slice(0,10))console.log(v.length,JSON.stringify(k),v.slice(0,5).join(' '));
lane.close();process.exit(0)})();
