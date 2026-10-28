'use strict';

// Block navigation for pixels already on screen. This is deliberately separate
// from exact glyph/selection maps: a changed glyph loses its caret anchor, but
// its tracked paragraph can still be opened with the current document text.
class EditAccess {
    constructor() { this.frames = new Map(); }
    key(page, identity) { return JSON.stringify([page,identity]); }
    remember(page, identity, blocks, texts) {
        if (identity == null || !blocks.length) return;
        const key=this.key(page,identity);
        this.frames.delete(key);
        this.frames.set(key,{page,identity,blocks,texts:new Map(texts)});
        while(this.frames.size>8)this.frames.delete(this.frames.keys().next().value);
    }
    rememberBlock(page,identity,block,text) {
        const f=this.frames.get(this.key(page,identity));
        const blocks=f ? f.blocks.filter(b=>b.file!==block.file ||
            f.texts.get(block.file)===text && (b.start!==block.start || b.end!==block.end)) : [];
        const texts=new Map(f?.texts);texts.set(block.file,text);
        this.remember(page,identity,[...blocks,block],texts);
    }
    change(file, after, changes, own=false) {
        const sorted=[...changes].sort((a,b)=>b.rangeOffset-a.rangeOffset);
        for(const [key,f]of this.frames) {
            const before=f.texts.get(file);
            if(before==null)continue;
            let expected=before;
            for(const c of sorted)expected=expected.slice(0,c.rangeOffset)+c.text+expected.slice(c.rangeOffset+c.rangeLength);
            // A missed change, reload or out-of-order event cannot revive an
            // old source address, even if a paragraph happens to repeat.
            if(expected!==after){f.blocks=f.blocks.filter(b=>b.file!==file);f.texts.delete(file);continue;}
            for(const c of sorted) {
                const a=c.rangeOffset,z=a+c.rangeLength,delta=c.text.length-c.rangeLength;
                f.blocks=f.blocks.filter(b=>{
                    if(b.file!==file)return true;
                    if(b.deleted)return true;
                    if(c.rangeLength && a<=b.start && z>=b.end && !own){b.deleted=true;return true;}
                    if(z<=b.start && !(own && a===z && a===b.start)){b.start+=delta;b.end+=delta;}
                    else if(a<b.end || own && a===b.end)b.end=Math.max(a+c.text.length,b.end+delta),b.start=Math.min(b.start,a);
                    for(const g of b.glyphs) {
                        if(g.offset==null)continue;
                        if(z<=g.offset)g.offset+=delta;
                        else if(a<g.end)g.offset=null;
                        if(g.offset!=null)g.end+=z<=g.end ? delta : 0;
                    }
                    if(b.end<=b.start)b.deleted=true;
                    return true;
                });
            }
            f.texts.set(file,after);
            if(!f.blocks.length)this.frames.delete(key);
        }
    }
    target(page, identity, x, y, documentFor) {
        const frame=this.frames.get(this.key(page,identity));
        if(!frame || !Number.isFinite(x) || !Number.isFinite(y))return null;
        let best=null,distance=Infinity;
        for(const b of frame.blocks) {
            const doc=documentFor(b.file);
            if(!doc || doc.getText()!==frame.texts.get(b.file))continue;
            for(const r of b.rects) {
                const dx=Math.max(r.x-x,0,x-r.x-r.w),dy=Math.max(r.y-y,0,y-r.y-r.h);
                const d=Math.hypot(dx,dy*3);
                if(d<distance){distance=d;best={...b,doc};}
            }
        }
        // Keep deleted regions as holes until new pixels/map arrive, rather
        // than silently opening a different paragraph under their old ink.
        if(!best || best.deleted)return null;
        let offset=best.start,nearest=Infinity;
        for(const g of best.glyphs) {
            if(g.offset==null || g.offset<best.start || g.offset>best.end)continue;
            const d=Math.hypot(Math.max(g.x-x,0,x-g.x-g.w),Math.max(g.y-y,0,y-g.y-g.h)*3);
            if(d<nearest){nearest=d;offset=g.offset;}
        }
        return {...best,offset:nearest<=12 ? offset : best.start};
    }
    // A fragment carries the exact clear/move geometry used by the renderer.
    // Each placement is relative to its base page, never the last fragment.
    fragment(page, baseIdentity, identity, placement) {
        const base=this.frames.get(this.key(page,baseIdentity));
        if(!base || !Array.isArray(placement.clear) || identity==null)return;
        // DVI placement coordinates start one inch inside the PDF page,
        // matching the renderer's fragmentGeometry origin (72 bp).
        const {spToBp}=require('./texGeometry'),[l,t,r,b]=placement.clear.map(v=>72+spToBp(v)),shift=spToBp(placement.shift || 0);
        const below=Array.isArray(placement.below) ? 72+spToBp(placement.below[1]) : b;
        const overlaps=base.blocks.filter(v=>v.rects.some(q=>q.y<b && q.y+q.h>t && q.x<r && q.x+q.w>l));
        if(overlaps.length!==1)return; // no guess when a producer spans several blocks
        const changed=overlaps[0];
        const blocks=base.blocks.map(v=>({...v,
            rects:v===changed ? [{page,x:l,y:t,w:r-l,h:Math.max(1,b-t+shift)}]
                : v.rects.map(q=>({...q,y:q.y>=below ? q.y+shift : q.y})),
            glyphs:v.glyphs.map(g=>({...g,offset:v===changed ? null : g.offset,y:g.y>=below ? g.y+shift : g.y})),
        }));
        this.remember(page,identity,blocks,base.texts);
    }
}
module.exports={EditAccess};
