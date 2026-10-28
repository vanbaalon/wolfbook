'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {historyLimits,historyBytes,trimHistory}=require('./reviewHistory');

// Private extension storage, not the source tree. Recompiling never touches it.
class ReviewStore {
    constructor(directory,options={}) {
        this.directory = directory; this.hashes = new Map(); this.seen = new Map();
        this.arrivalRefs=new WeakMap();this.snapshotHashes=new Map();this.textCache=new Map();
        this.options=options;this.historyKeys=new Map();
        fs.mkdirSync(directory, { recursive: true });
    }
    _limits(file) {return historyLimits(typeof this.options==='function' ? this.options(file) : this.options);}
    _snapshotDirectory(file) {return path.join(this.directory,'snapshots',this._key(file));}
    _snapshot(file,text) {
        const cacheKey=this._key(file)+'|'+text;
        let hash=this.snapshotHashes.get(cacheKey);
        // JSON strings preserve even an incomplete UTF-16 character captured
        // during typing. Plain UTF-8 would replace it and alter the history.
        const content=hash ? null : JSON.stringify(text);
        if (!hash) hash=crypto.createHash('sha256').update(content).digest('hex');
        const dir=this._snapshotDirectory(file),dest=path.join(dir,hash+'.json');
        fs.mkdirSync(dir,{recursive:true,mode:0o700});
        if (!fs.existsSync(dest)) {
            const tmp=dest+'.'+process.pid+'.tmp';
            fs.writeFileSync(tmp,content ?? JSON.stringify(text),{mode:0o600});fs.renameSync(tmp,dest);
        }
        this.snapshotHashes.set(cacheKey,hash);
        if (this.snapshotHashes.size>4) this.snapshotHashes.delete(this.snapshotHashes.keys().next().value);
        return hash;
    }
    _text(file,hash) {
        const cacheKey=this._key(file)+'|'+hash;
        if (this.textCache.has(cacheKey)) return this.textCache.get(cacheKey);
        const content=fs.readFileSync(path.join(this._snapshotDirectory(file),hash+'.json'),'utf8');
        if (crypto.createHash('sha256').update(content).digest('hex')!==hash) throw Error('Saved review history snapshot is damaged');
        const text=JSON.parse(content);
        if (typeof text!=='string') throw Error('Invalid saved review history text');
        this.textCache.set(cacheKey,text);
        if (this.textCache.size>4) this.textCache.delete(this.textCache.keys().next().value);
        return text;
    }
    _encode(record) {
        if (!record.session) return {...record,version:2};
        trimHistory(record.session.arrivals || [],this._limits(record.file));
        const arrivals=(record.session.arrivals || []).map(entry=>{
            let refs=this.arrivalRefs.get(entry);
            if (!refs || !refs.lazy && (refs.beforeText!==entry.before || refs.afterText!==entry.after)) {
                refs={beforeRef:this._snapshot(record.file,String(entry.before ?? '')),afterRef:this._snapshot(record.file,String(entry.after ?? '')),
                    beforeText:entry.before,afterText:entry.after};this.arrivalRefs.set(entry,refs);
            }
            const meta=Object.fromEntries(Object.keys(entry).filter(k=>k!=='before' && k!=='after').map(k=>[k,entry[k]]));
            return {...meta,historyBytes:historyBytes(entry),beforeRef:refs.beforeRef,afterRef:refs.afterRef};
        });
        return {...record,version:2,session:{...record.session,arrivals}};
    }
    _decode(record) {
        if (![1,2].includes(record.version) || typeof record.file!=='string') throw Error('Invalid saved review');
        if (record.version===1 || !record.session) return record;
        const arrivals=(record.session.arrivals || []).map(ref=>{
            if (!/^[a-f0-9]{64}$/.test(ref.beforeRef) || !/^[a-f0-9]{64}$/.test(ref.afterRef))
                throw Error('Invalid saved review history reference');
            const {beforeRef,afterRef,...meta}=ref,entry={...meta};
            Object.defineProperties(entry,{before:{enumerable:true,get:()=>this._text(record.file,beforeRef)},
                after:{enumerable:true,get:()=>this._text(record.file,afterRef)}});
            this.arrivalRefs.set(entry,{beforeRef,afterRef,lazy:true});return entry;
        });
        return {...record,session:{...record.session,arrivals}};
    }
    _restore(record) {
        const decoded=this._decode(record);
        if (this.migrating || this.saving || !record.session) return decoded;
        const count=decoded.session.arrivals?.length || 0;
        trimHistory(decoded.session.arrivals || [],this._limits(record.file));
        if (record.version===2 && count===(decoded.session.arrivals?.length || 0)) {
            this.historyKeys.set(record.file,this._historyKey(record));return decoded;
        }
        this.migrating=true;
        try {
            const saved=this.save(decoded);
            return saved.conflict || this._decode(saved.record || decoded);
        } finally {this.migrating=false;}
    }
    _historyKey(record) {return JSON.stringify((record.session?.arrivals || []).map(a=>[a.beforeRef,a.afterRef]));}
    _pruneSnapshots(record) {
        const key=this._historyKey(record);
        if (this.historyKeys.get(record.file)===key) return;
        const retained=new Set((record.session?.arrivals || []).flatMap(a=>[a.beforeRef+'.json',a.afterRef+'.json']));
        const dir=this._snapshotDirectory(record.file);
        if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) {
            if (/^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name)) fs.unlinkSync(path.join(dir,name));
        }
        this.historyKeys.set(record.file,key);
    }
    _key(file) { return crypto.createHash('sha256').update(file).digest('hex'); }
    _stamp(destination) {
        try { const s = fs.statSync(destination); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    /** Another extension host may have approved this file since we loaded it. */
    changed(file) {
        const key = this._key(file), destination = path.join(this.directory, key + '.json');
        const stamp = this._stamp(destination);
        if (!stamp || stamp === this.seen.get(key)) return null;
        const content = fs.readFileSync(destination, 'utf8'), record = JSON.parse(content);
        if (![1,2].includes(record.version) || record.file !== file) throw new Error('Invalid saved review: ' + key);
        this.seen.set(key, stamp);
        this.hashes.set(key, crypto.createHash('sha256').update(content).digest('hex'));
        return this._restore(record);
    }
    save(record) {
        const conflict = this.changed(record.file);
        if (conflict) return { conflict };
        // Snapshot deletion and record replacement share one per-paper lock.
        // A second host retries against the saved record instead of racing GC.
        const lock=path.join(this.directory,this._key(record.file)+'.lock');
        let fd;
        try {fd=fs.openSync(lock,'wx',0o600);}
        catch (error) {
            if (error.code!=='EEXIST') throw error;
            // Recover a lock left by a crashed host, never a live writer's lock.
            let owner;
            try {
                owner=Number(fs.readFileSync(lock,'utf8'));
                if (Number.isInteger(owner) && owner>0) process.kill(owner,0);
                else if (Date.now()-fs.statSync(lock).mtimeMs>60000) {fs.unlinkSync(lock);return this.save(record);}
            }
            catch (check) {
                if (check.code==='ESRCH') {fs.unlinkSync(lock);return this.save(record);}
                if (check.code==='ENOENT') return this.save(record);
            }
            const wasSaving=this.saving;this.saving=true;
            let latest;
            try {latest=this.load([record.file])[0];} finally {this.saving=wasSaving;}
            if (latest) return {conflict:latest};
            throw Error('Another window is saving this review; please try again');
        }
        this.saving=true;
        try {fs.writeFileSync(fd,String(process.pid));return this._saveLocked(record);}
        finally {this.saving=false;fs.closeSync(fd);fs.unlinkSync(lock);}
    }
    _saveLocked(record) {
        const conflict=this.changed(record.file);
        if (conflict) return {conflict};
        const key = this._key(record.file);
        const destination = path.join(this.directory, key + '.json');
        const temporary = destination + '.' + process.pid + '.tmp';
        const wire=this._encode(record),content = JSON.stringify(wire);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        if (this.hashes.get(key) === hash) return { saved:true };
        fs.writeFileSync(temporary, content, { mode: 0o600 });
        // Histories can be large. Recheck after writing the temporary file,
        // since another host may have saved while we serialized this one.
        const newer = this.changed(record.file);
        if (newer) { fs.unlinkSync(temporary); return { conflict:newer }; }
        fs.renameSync(temporary, destination);
        this.hashes.set(key, hash);
        this.seen.set(key, this._stamp(destination));
        try {this._pruneSnapshots(wire);} catch (_) { /* retry cleanup on the next save; approval is durable */ }
        return { saved:true,record:wire };
    }
    load(files) {
        this.errors = [];
        const names = files === undefined
            ? fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
            : [...new Set(files)].map(file => this._key(file) + '.json')
                .filter(name => fs.existsSync(path.join(this.directory, name)));
        return names.flatMap(name => {
            try {
            const destination = path.join(this.directory, name);
            const stamp = this._stamp(destination), content = fs.readFileSync(destination, 'utf8');
            const record = JSON.parse(content);
            if (![1,2].includes(record.version) || typeof record.file !== 'string') throw new Error('Invalid saved review: ' + name);
            if (this._key(record.file) + '.json' !== name) throw new Error('Invalid saved review path: ' + name);
            this.seen.set(name.slice(0, -5), stamp);
            this.hashes.set(name.slice(0, -5), crypto.createHash('sha256').update(content).digest('hex'));
            // Migrate legacy whole-document histories once at load, before a
            // reader's first approval. Immutable texts are deduplicated; later
            // decisions write only the small mutable review record.
            return [this._restore(record)];
            } catch (error) { this.errors.push({ name, message: error.message }); return []; }
        });
    }
}
module.exports = { ReviewStore };
