'use strict';
const {renderTextKey}=require('./renderChange');
const {sha256}=require('./texModel');

// Two bounded entries per session, reclaimed with the session. Revision checks
// during glyph mapping must never normalize/hash the entire paper per glyph.
class ReviewRevisionCache {
    constructor(digest=text=>sha256(renderTextKey(text))) {
        this.digest=digest;
        this.sessions=new WeakMap();
    }
    text(session,field) {
        let slots=this.sessions.get(session);
        if(!slots){slots={};this.sessions.set(session,slots);}
        const text=session[field];
        if(slots[field] && slots[field].text===text)return slots[field].hash;
        const same=Object.values(slots).find(entry=>entry.text===text);
        const hash=same ? same.hash : this.digest(text);
        slots[field]={text,hash};
        return hash;
    }
    revision(root,sourceRevision,files,sessionFor,file) {
        const session=sessionFor(file);
        if(!session)return null;
        const baselines=files.map(path=>{
            const other=path===file ? session : sessionFor(path);
            return other ? `${path}\0${this.text(other,'baseText')}` : path;
        }).join('\0');
        return sha256(`${root}\0${sourceRevision || 0}\0${baselines}\0${this.text(session,'baseText')}\0${this.text(session,'_lastText')}`);
    }
}
module.exports={ReviewRevisionCache};
