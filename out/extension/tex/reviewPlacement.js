'use strict';

const { visibleWords } = require('./texWords');

// Reviews may point beside nonprinting source, but outlines and source editing
// must keep their exact lookup semantics. Cache two immutable source indexes so
// a batch of corrections does not rescan a long paper once per hunk.
const contextIndexes = new Map();
function contextIndex(text) {
    if (contextIndexes.has(text)) return contextIndexes.get(text);
    const lines=text.split('\n'),hidden=new Uint8Array(lines.length);
    const {scanTex}=require('./texScanner');
    for (const o of scanTex(text).objects) {
        if (!['comment','filecontents','filecontents*'].includes(o.envName)) continue;
        hidden.fill(1,Math.max(0,o.startLine-1),Math.min(lines.length,o.endLine));
    }
    const eligible=i=>!hidden[i] && /\S/.test(lines[i]) && !/^\s*%/.test(lines[i]);
    const before=new Int32Array(lines.length+1),after=new Int32Array(lines.length+1);
    let previous=-1,next=lines.length;
    for(let i=0;i<lines.length;i++){before[i]=previous;if(eligible(i))previous=i;}
    before[lines.length]=previous;after[lines.length]=next;
    for(let i=lines.length-1;i>=0;i--){if(eligible(i))next=i;after[i]=next;}
    const index={lines,hidden,before,after};contextIndexes.set(text,index);
    if(contextIndexes.size>2)contextIndexes.delete(contextIndexes.keys().next().value);
    return index;
}

function* contextProbes(text,start,end,index) {
    const {lines,before,after}=index;
    let left=before[Math.min(lines.length,Math.max(0,start-1))];
    let right=after[Math.min(lines.length,Math.max(0,end-1))];
    for(let count=0;count<64 && (left>=0 || right<lines.length);count++) {
        const preceding=left>=0 && (right>=lines.length || start-1-left<=right-(end-1));
        const n=preceding ? left : right;
        if(preceding)left=before[n];else right=after[n+1];
        yield* sourceProbes(text,n+1,n+2,lines);
    }
}

// A command's first column often has no ink (\item, \paragraph, \begin).
// Query printed tokens first. This discovers a page without loading its glyph
// map, and never borrows a source line outside the change.
function sourceProbes(text, startLine, endLine, lines = text.split('\n')) {
    const probes = [];
    const end = Math.min(Math.max(startLine + 1, endLine || startLine + 1), startLine + 12, lines.length + 1);
    for (let line = startLine; line < end; line++) {
        const src = lines[line - 1] || '';
        const columns = visibleWords(src, { scope:'all' }).slice(0, 3).map(w => w.sourceStart);
        const first = src.search(/\S/);
        if (first >= 0 && src[first] !== '%') columns.push(first);
        for (const column of new Set(columns))
            if (Number.isInteger(column)) probes.push({ line, column });
    }
    return probes;
}

// A deletion has no surviving source range of its own. Its location is the
// gap between surviving neighbours, including blank lines and EOF. This is
// deliberately separate from ordinary changes, which must never borrow ink.
function deletionProbes(text,line) {
    const lines=text.split('\n'),probes=[];
    for (let distance=0;distance<64;distance++) {
        for (const n of [line+distance,line-1-distance]) {
            if (n<1 || n>lines.length) continue;
            const src=lines[n-1],first=src.search(/\S/);
            if (first<0 || src[first]==='%') continue;
            const columns=visibleWords(src,{scope:'all'}).slice(0,3).map(w=>w.sourceStart);
            columns.push(first);
            for (const column of new Set(columns)) if (Number.isInteger(column)) probes.push({line:n,column});
        }
    }
    return probes;
}

async function locateSourcePage(source, file, text, startLine, endLine, isCurrent = () => true, {contextual=false} = {}) {
    const seam=endLine===startLine;
    const index=contextual && !seam ? contextIndex(text) : null;
    for (const p of seam ? deletionProbes(text,startLine) : sourceProbes(text, startLine, endLine,index?.lines)) {
        if (!isCurrent()) return null;
        if(index?.hidden[p.line-1])continue;
        const answer = await source.forward(file, p.line, p.column);
        if (!isCurrent()) return null;
        const page = answer.hits?.find(hit => Number.isInteger(hit.item?.page) && hit.item.page > 0)?.item.page;
        if (page) return { page, matchedLine:p.line, exact:!seam,...(seam ? {seam:true} : {}) };
        // Background discovery must give typing and viewer messages a turn.
        await new Promise(resolve => setImmediate(resolve));
    }
    if(index)for(const p of contextProbes(text,startLine,endLine || startLine+1,index)) {
        if(!isCurrent())return null;
        const answer=await source.forward(file,p.line,p.column);
        if(!isCurrent())return null;
        const page=answer.hits?.find(hit=>Number.isInteger(hit.item?.page) && hit.item.page>0)?.item.page;
        if(page)return {page,matchedLine:p.line,exact:false,contextual:true};
        await new Promise(resolve=>setImmediate(resolve));
    }
    return null;
}

// One generation may probe the same surviving context for many corrections.
// Share requests and keep only the page answer, not each glyph/ancestor tree.
function memoizedPageSource(source, cache = new Map()) {
    return { forward(file, line, column) {
        const key=JSON.stringify([file,line,column]);
        if (!cache.has(key)) {
            const result=Promise.resolve(source.forward(file,line,column)).then(answer=>{
                const page=answer.hits?.find(hit=>Number.isInteger(hit.item?.page) && hit.item.page>0)?.item.page;
                return {hits:page ? [{item:{page}}] : []};
            });
            cache.set(key,result);
            result.catch(()=>{if(cache.get(key)===result)cache.delete(key);});
            if(cache.size>2048)cache.delete(cache.keys().next().value);
        }
        return cache.get(key);
    }};
}

module.exports = { sourceProbes, locateSourcePage, memoizedPageSource };
