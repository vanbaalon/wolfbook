const fs = require('fs');
const path = require('path');
// Keep finalizers alive until every lease of a closed cache has been collected.
const active = new Set();
class NativeArtifactCache {
    constructor(parent) {
        fs.mkdirSync(parent, { recursive:true });
        this.directory=fs.realpathSync(fs.mkdtempSync(path.join(parent,'wpaper-session-')));
        this.entries=new Map(); this.next=0; this.closed=false; this.busy=0;
        this.finalizer=new FinalizationRegistry(()=>this.collect());
        active.add(this);
    }
    lease(report) {
        if (this.closed) throw Error('Native artifact cache closed');
        if (!this.busy) throw Error('Native artifact lease requires an active build');
        const paths=[report.artifact_directory,report.source_directory,report.log].filter(Boolean);
        for (const file of paths) this.checkPath(file);
        const lease=Object.freeze({});
        this.entries.set(++this.next,{ reference:new WeakRef(lease),paths });
        this.finalizer.register(lease,this.next);
        this.collect();
        return lease;
    }
    checkPath(file) {
        const relative=path.relative(this.directory,path.resolve(file));
        if (!relative || relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
            throw Error('Native artifact is outside its owned cache');
        let current=this.directory;
        for (const part of relative.split(path.sep)) {
            current=path.join(current,part);
            try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('Native artifact contains a symlink'); }
            catch (error) { if (error.code!=='ENOENT') throw error; }
        }
    }
    async begin() {
        if (this.closed) throw Error('Native artifact cache closed');
        // Reserve the build before yielding so another collection cannot start.
        this.busy++;
        await this.collecting;
    }
    end() { this.busy--; return this.collect(); }
    collect() {
        if (this.collecting) return this.collecting;
        if (this.busy) return Promise.resolve();
        this.collecting=Promise.resolve().then(()=>this._collect()).catch(error=>{
            this.lastError=error;
        }).finally(()=>{ this.collecting=null; });
        return this.collecting;
    }
    async _collect() {
        if (this.busy) return;
        const live=[...this.entries.values()].filter(entry=>entry.reference.deref()).flatMap(entry=>entry.paths);
        const contains=(parent,child)=>{ const r=path.relative(parent,child); return !r || (!r.startsWith(`..${path.sep}`) && r!=='..' && !path.isAbsolute(r)); };
        for (const [id,entry] of this.entries) {
            if (entry.reference.deref()) continue;
            try {
                for (const file of entry.paths) {
                    this.checkPath(file);
                    // Frozen sources may be content-addressed and shared by reports.
                    if (!live.some(other=>contains(file,other) || contains(other,file)))
                        await fs.promises.rm(file,{ recursive:true,force:true });
                }
                this.entries.delete(id);
            } catch (error) { this.lastError=error; } // Retry at the next collection boundary.
        }
        if (this.closed && !this.entries.size) {
            try {
                await fs.promises.rm(this.directory,{ recursive:true,force:true });
                active.delete(this);
            } catch (error) { this.lastError=error; }
        }
    }
    close() { this.closed=true; return this.collect(); }
}
module.exports={ NativeArtifactCache };
