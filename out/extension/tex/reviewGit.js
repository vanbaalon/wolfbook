'use strict';
const path=require('path');
const {spawn}=require('child_process');

// Read-only, asynchronous and bounded. Git metadata must never hold up ink.
function runGit(cwd,args,input) {
    return new Promise(resolve=>{
        const p=spawn('git',args,{cwd,stdio:['pipe','pipe','ignore']});
        const chunks=[];let bytes=0,finished=false;
        const done=result=>{if(finished)return;finished=true;clearTimeout(timer);resolve(result);};
        const timer=setTimeout(()=>{p.kill();done(null);},2000);
        p.on('error',()=>done(null));p.stdin.on('error',()=>{});
        p.stdout.on('data',b=>{bytes+=b.length;if(bytes>8*1024*1024){p.kill();done(null);}else chunks.push(b);});
        p.on('close',code=>done(code===0 ? Buffer.concat(chunks).toString('utf8') : null));
        p.stdin.end(input);
    });
}
function authorOf(entries,scope) {
    const people=[...new Map(entries.map(e=>[e.email||e.name,e])).values()];
    if(!people.length)return null;
    return {name:people.length===1 ? people[0].name : `${people[0].name} +${people.length-1}`,
        source:'git',scope,contributors:people.map(({name,email,commit,date})=>({name,email,commit,date}))};
}
async function gitReviewAuthors({file,before,after,hunks},run=runGit) {
    try {
        const root=(await run(path.dirname(file),['rev-parse','--show-toplevel']))?.trim();if(!root)return null;
        const rel=(await run(root,['ls-files','-z','--full-name','--',file]))?.split('\0')[0];if(!rel)return null;
        const head=(await run(root,['rev-parse','HEAD']))?.trim();if(!/^[0-9a-f]{40,64}$/.test(head||''))return null;
        // A name on the last commit says nothing about an uncommitted edit.
        if(await run(root,['show',`${head}:${rel}`])!==after)return null;
        const blob=(await run(root,['hash-object','--stdin'],before))?.trim();if(!blob)return null;
        const log=await run(root,['log','-32','--raw','--no-abbrev','--no-renames',
            '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI',head,'--',rel]);if(!log)return null;
        const entries=log.split('\x1e').slice(1).map(record=>{
            const [header,...raw]=record.trim().split('\n'),[commit,name,email,date]=header.split('\x1f');
            const m=/^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) /m.exec(raw.join('\n'));
            return {commit,name,email,date,old:m?.[1],next:m?.[2]};
        });
        let boundary=entries.findIndex(e=>e.next===blob);
        let changed=boundary>=0 ? entries.slice(0,boundary) : null;
        if(!changed){boundary=entries.findIndex(e=>e.old===blob);if(boundary>=0)changed=entries.slice(0,boundary+1);}
        if(!changed?.length)return null;
        const recent=new Map(changed.map(e=>[e.commit,e]));
        const blame=await run(root,['blame','--line-porcelain',head,'--',rel]);
        const lines=new Map();
        for(const m of (blame||'').matchAll(/^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/gm))
            if(recent.has(m[1]))lines.set(Number(m[2]),recent.get(m[1]));
        const authors={};
        for(const h of hunks){
            const hits=[];
            if(h.verb!=='del')for(let n=h.ourRange.startLine;n<h.ourRange.endLine;n++)if(lines.has(n))hits.push(lines.get(n));
            // For a multi-commit deletion, report contributors to the update,
            // never blame its surviving neighbor or the removed line's writer.
            authors[h.id]=authorOf(hits.length ? hits : changed,hits.length ? 'lines' : 'update');
        }
        return {head,authors,author:authorOf(changed,'update')};
    } catch (_) { return null; }
}
module.exports={gitReviewAuthors,authorOf};
