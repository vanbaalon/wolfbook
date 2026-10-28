'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {canonicalPath, scopedPath, folderClients, kernelAllowed, kernelPreference, scopeError, within} = require('../kernel/agentScope');
const TTL = 60 * 60 * 1000;

/** Session capabilities are independent of the agent product name. Only the
 * primary routing server writes this store; tokens are private local files. */
class AgentSessions {
    constructor(storagePath = null) {
        this.storagePath = storagePath;
        this.sessions = new Map();
        this.tokens = new Map();
        if(storagePath) try {
            const rows = JSON.parse(fs.readFileSync(storagePath,'utf8'));
            for(const [token,record] of Object.entries(rows)) if(record.expires > Date.now()) this.tokens.set(token,record);
        } catch(_) {}
    }
    get(sessionId) { return this.sessions.get(sessionId) || null; }
    declare(args, sessionId, clients) {
        const previous = this.get(sessionId);
        let record;
        if(args.resume_token) {
            record = this.tokens.get(args.resume_token);
            if(!record || record.expires <= Date.now()) throw scopeError('RESUME_TOKEN_EXPIRED','Unknown or expired resume token. Declare a working_directory again.');
            if([...this.sessions].some(([id,s])=>id!==sessionId && s.resume_token===args.resume_token))
                throw scopeError('RESUME_TOKEN_IN_USE','This resume token belongs to a connected session.');
            if(args.working_directory && canonicalPath(args.working_directory)!==record.scope.directory)
                throw scopeError('FOLDER_SCOPE_MISMATCH','A resume token cannot change its working directory.');
        }
        const requested = record?.scope.directory || args.working_directory;
        if(!requested || !path.isAbsolute(requested) || !fs.statSync(requested).isDirectory())
            throw scopeError('WORKING_DIRECTORY_REQUIRED','Declare an existing absolute working_directory.');
        const directory = canonicalPath(requested);
        const explicit = args.client_id && clients.find(c=>c.clientId===args.client_id);
        if(args.client_id && !explicit) throw scopeError('CLIENT_UNAVAILABLE','Choose a connected client_id from wolfbook_list_clients.');
        const recommended=folderClients(clients,directory);
        const candidates = explicit ? [{client:explicit,root:folderClients([explicit],directory)[0]?.root || null}] :
            recommended.length ? recommended : clients.map(client=>({client,root:null}));
        const unique = [...new Map(candidates.map(m=>[m.client.clientId,m])).values()];
        if(unique.length !== 1) throw scopeError('WORKSPACE_SCOPE_AMBIGUOUS',`Expected one owning window for ${directory}; found ${unique.length}. Choose client_id from wolfbook_list_clients.`);
        const {client,root} = unique[0];
        const sharing = args.sharing || record?.scope.sharing || 'private';
        if(!['private','folder','shared'].includes(sharing)) throw scopeError('INVALID_SHARING','Use sharing:"private", "folder", or "shared".');
        const same = previous?.directory===directory && previous.sharing===sharing && previous.client_id===client.clientId;
        const scope = {scope_id:record?.scope.scope_id || (same ? previous.scope_id : crypto.randomUUID()),
            directory, workspace_root:root, client_id:client.clientId, client_generation:client.generation,
            sharing, policy:'repository-recommendation', resume_token:args.resume_token || (same ? previous.resume_token : crypto.randomBytes(32).toString('hex'))};
        // A saved target must still be the same durable slot after a reload.
        let target = record?.target || (same ? this.tokens.get(previous.resume_token)?.target : undefined);
        if(target?.notebook) {
            scopedPath(scope,target.notebook);
            const targetClient=clients.find(c=>c.clientId===target.clientId) || client;
            const binding = (targetClient.kernels || []).find(k=>(k.notebooks || []).some(nb=>canonicalPath(nb)===canonicalPath(target.notebook)));
            if(!binding || !kernelAllowed(scope,binding) || (target.kernelSlot && binding.kernel_slot!==target.kernelSlot)) target=null;
            else target={...target,clientId:targetClient.clientId,kernelId:binding.kernel_id,kernelSlot:binding.kernel_slot,ts:Date.now()};
        }
        this.sessions.set(sessionId,scope);
        this.tokens.set(scope.resume_token,{scope,target:target || null,expires:Date.now()+TTL});
        this.persist();
        return {scope,target,preserveTarget:same && !record};
    }
    saveTarget(sessionId,target) {
        const scope=this.get(sessionId);
        if(!scope)return;
        this.tokens.set(scope.resume_token,{scope,target,expires:Date.now()+TTL});
        this.persist();
    }
    release(sessionId) { this.sessions.delete(sessionId); }
    persist() {
        for(const [token,record] of this.tokens) if(record.expires<=Date.now()) this.tokens.delete(token);
        if(!this.storagePath)return;
        fs.mkdirSync(path.dirname(this.storagePath),{recursive:true});
        const temp=`${this.storagePath}.${process.pid}.tmp`;
        fs.writeFileSync(temp,JSON.stringify(Object.fromEntries(this.tokens)),{mode:0o600});
        fs.renameSync(temp,this.storagePath);
    }
    inventory(clients,sessionId,global=false) {
        const scope=this.get(sessionId);
        if(!scope)return clients;
        return clients.map(c=>({...c,recommended:(c.workspaceRoots || []).some(root=>within(root,scope.directory)),
            notebooks:[...(c.notebooks || [])].sort((a,b)=>Number(within(scope.directory,b))-Number(within(scope.directory,a))),
            kernels:(c.kernels || []).map(k=>({...k,...kernelPreference(scope,k)})).sort((a,b)=>Number(b.recommended)-Number(a.recommended))
        })).sort((a,b)=>global ? 0 : Number(b.recommended)-Number(a.recommended));
    }
    route(name,args,sessionId,target,clients) {
        const scope=this.get(sessionId);
        if(!scope)return args;
        const routed={...args,_agentScope:scope};
        if(routed.notebook)routed.notebook=scopedPath(scope,routed.notebook);
        // Explicit targets outrank repository recommendations. Remote proxies are
        // not owners; route an explicit kernel to its actual hosting window.
        const owners=routed.kernel_id ? clients.filter(c=>(c.kernels || []).some(k=>k.kernel_id===routed.kernel_id && !k.remote)) :
            routed.notebook ? clients.filter(c=>(c.notebooks || []).some(nb=>canonicalPath(nb)===routed.notebook)) : [];
        if(!args.client_id && owners.length>1)throw scopeError('NOTEBOOK_TARGET_AMBIGUOUS','Choose the owning client_id explicitly.');
        routed.client_id=args.client_id || owners[0]?.clientId || target?.clientId || scope.client_id;
        if(name==='wolfbook_readNotebookFile') {
            if(routed.file)routed.file=scopedPath(scope,routed.file);
            delete routed.notebook;delete routed.kernel_id;
            return routed; // an offline file read has no notebook/kernel binding
        }
        if(name==='wolfbook_newNotebook') {
            routed.directory=scopedPath(scope,routed.directory || scope.directory);
            if(routed.path)routed.path=scopedPath(scope,routed.path);
            if(routed.filename)routed.filename=scopedPath(scope,routed.filename);
            if(routed.kernel_id) {
                const kernel=clients.find(c=>c.clientId===routed.client_id)?.kernels?.find(k=>k.kernel_id===routed.kernel_id);
                if(kernel && !kernelAllowed(scope,kernel))throw scopeError('KERNEL_UNAVAILABLE','The requested kernel is unavailable.');
            }
            // newNotebook chooses its own binding; never inject the old notebook.
            return routed;
        }
        const management=/^wolfbook_(kernelManager|selectKernel)$/.test(name);
        const inherit=target?.clientId===routed.client_id;
        if(inherit && !management && !routed.notebook && target?.notebook && !args.kernel_id)routed.notebook=scopedPath(scope,target.notebook);
        if(inherit && !routed.kernel_id && target?.kernelId && !management && !args.notebook)routed.kernel_id=target.kernelId;
        if(routed.kernel_id) {
            const client=clients.find(c=>c.clientId===routed.client_id);
            const kernel=client?.kernels?.find(k=>k.kernel_id===routed.kernel_id);
            if(kernel && !kernelAllowed(scope,kernel))throw scopeError('KERNEL_UNAVAILABLE','The requested kernel is unavailable.');
        }
        return routed;
    }
}
module.exports={AgentSessions};
