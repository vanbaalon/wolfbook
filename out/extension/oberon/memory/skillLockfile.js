'use strict';
const fsp=require('fs/promises'),path=require('path'),crypto=require('crypto');
const project=require('./project');
const queues=new Map();

async function pinSkill({ref,contentHash,compatibility='verified-in-run',source='wolfbook-fairy',lifecycle='cited',environment=null,evidence=null}={}){
    const root=project.getWorkspaceRoot();if(!root||!ref)return {ok:false};
    const file=path.join(root,'.skilxiv.lock');
    const previous=queues.get(file)||Promise.resolve();
    const update=previous.catch(()=>{}).then(async()=>{
        let data={schema_version:'1.0',skills:{}};
        try{const old=JSON.parse(await fsp.readFile(file,'utf8'));if(!old||typeof old!=='object'||!old.skills||typeof old.skills!=='object')throw new Error('invalid schema');data=old}
        catch(e){if(e.code!=='ENOENT')throw new Error(`Cannot update corrupt .skilxiv.lock: ${e.message}`)}
        const prior=data.skills[ref]||{};
        const event={state:lifecycle,at:new Date().toISOString(),environment:environment||null,evidence:evidence||null};
        data.skills[ref]={...prior,ref,content_hash:contentHash||prior.content_hash||null,retrieved_at:prior.retrieved_at||event.at,last_used_at:event.at,compatibility,source,lifecycle,environment:environment||prior.environment||null,events:[...(Array.isArray(prior.events)?prior.events:[]),event].slice(-50)};
        const tmp=`${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        await fsp.writeFile(tmp,JSON.stringify(data,null,2)+'\n','utf8');
        try{await fsp.rename(tmp,file)}catch(e){await fsp.unlink(tmp).catch(()=>{});throw e}
        return {ok:true,file};
    });
    queues.set(file,update);
    try{return await update}finally{if(queues.get(file)===update)queues.delete(file)}
}
module.exports={pinSkill};
