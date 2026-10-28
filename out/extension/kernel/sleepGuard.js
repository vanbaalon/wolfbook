'use strict';

// One idle-sleep assertion per extension host, only while native calls are in
// flight. -w ties it to the host PID so a crashed host cannot leave an assertion.
class ActivitySleepGuard {
    constructor({platform=process.platform,spawn=(...args)=>require('child_process').spawn(...args),pid=process.pid,record=()=>{}}={}) {
        Object.assign(this,{platform,spawn,pid,record});
        this.owners=new Map();this.process=null;
    }
    acquire(owner) {
        if(this.platform!=='darwin' || owner.closed)return ()=>{};
        let leases=this.owners.get(owner);
        if(!leases){leases=new Set();this.owners.set(owner,leases);}
        const lease={};leases.add(lease);
        if(!this.process) {
            try {
                const child=this.spawn('caffeinate',['-i','-w',String(this.pid)],{detached:false,stdio:'ignore'});
                this.process=child;
                child.on('spawn',()=>this._record('sleep-guard.started',{pid:this.pid}));
                child.on('error',error=>{if(this.process===child)this.process=null;this._record('sleep-guard.failed',{code:error.code || error.name});});
                child.on('exit',(code,signal)=>{if(this.process===child)this.process=null;this._record('sleep-guard.exited',{code,reason:signal});});
            } catch(error) {this._record('sleep-guard.failed',{code:error.code || error.name});}
        }
        return ()=>{
            if(!leases.delete(lease))return;
            if(!leases.size)this.owners.delete(owner);
            this._stopIfIdle();
        };
    }
    releaseOwner(owner) {
        owner.closed=true;
        this.owners.get(owner)?.clear();this.owners.delete(owner);this._stopIfIdle();
    }
    _record(event,details) {try {this.record(event,details);} catch(_) {}}
    _stopIfIdle() {
        if(this.owners.size || !this.process)return;
        const child=this.process;this.process=null;
        try {child.kill();} catch(_) {}
    }
}

const evaluations=new Set(['evaluate','evaluateRaw','sub','subAuto','subWhenIdle','dialogEval']);
function trackSessionActivity(self,session,guard) {
    self._releaseSleepGuard?.();
    const owner={};
    self._releaseSleepGuard=()=>guard.releaseOwner(owner);
    return new Proxy(session,{
        get(target,property) {
            const value=Reflect.get(target,property,target);
            if(typeof value!=='function')return value;
            if(!evaluations.has(property))return value.bind(target);
            return async(...args)=>{
                const release=guard.acquire(owner);
                try {return await value.apply(target,args);} finally {release();}
            };
        },
    });
}
module.exports={ActivitySleepGuard,trackSessionActivity};
