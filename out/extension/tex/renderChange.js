'use strict';

// A rendering decision is stricter than a review decision. New paragraph
// breaks and literal-source spaces may change the page and must still build.
function priorText(after,changes,previous) {
    if (typeof previous==='string') {
        let applied=previous;
        for (const c of [...changes].sort((a,b)=>b.rangeOffset-a.rangeOffset)) {
            if (!Number.isInteger(c.rangeOffset) || !Number.isInteger(c.rangeLength) ||
                c.rangeOffset<0 || c.rangeLength<0 || c.rangeOffset+c.rangeLength>previous.length) return null;
            applied=applied.slice(0,c.rangeOffset)+c.text+applied.slice(c.rangeOffset+c.rangeLength);
        }
        if (applied===after) return previous;
    }
    // First observed keystroke: insertions can be inverted exactly, including
    // multiple cursors. Deleted bytes cannot be guessed from the new buffer.
    let shift=0, before=after; const cuts=[];
    for (const c of [...changes].sort((a,b)=>a.rangeOffset-b.rangeOffset)) {
        if (c.rangeLength!==0 || !Number.isInteger(c.rangeOffset) || c.rangeOffset<0 ||
            c.rangeOffset>after.length || typeof c.text!=='string') return null;
        const at=c.rangeOffset+shift;
        if (after.slice(at,at+c.text.length)!==c.text) return null;
        cuts.push({at,len:c.text.length}); shift+=c.text.length;
    }
    for (const c of cuts.reverse()) before=before.slice(0,c.at)+before.slice(c.at+c.len);
    return before;
}

function literalAt(text,at) {
    let literal=false,unsafe=false;
    const pattern=/\\(?:begin|end)\s*\{(?:verbatim\*?|[BL]?Verbatim|lstlisting|minted|alltt)\}|\\(?:obeyspaces|obeylines|catcode)\b/g;
    for (const m of text.slice(0,at).matchAll(pattern)) {
        if (/^\\end/.test(m[0])) literal=false;
        else if (/^\\begin/.test(m[0])) literal=true;
        else unsafe=true;
    }
    return literal || unsafe;
}

function editImpact(after,changes,previous) {
    const before=priorText(after,changes,previous);
    if (before==null) return {renderChanged:true,before:null};
    if (before===after) return {renderChanged:false,sourceChanged:false,before};
    const neutral=changes.every(c=> {
        const removed=before.slice(c.rangeOffset,c.rangeOffset+c.rangeLength);
        if (!/^[ \t]*$/.test(c.text) || !/^[ \t]*$/.test(removed) || literalAt(before,c.rangeOffset)) return false;
        const from=before.lastIndexOf('\n',c.rangeOffset-1)+1;
        const next=before.indexOf('\n',c.rangeOffset),to=next<0?before.length:next;
        return /^[ \t]*$/.test(before.slice(from,to));
    });
    return {renderChanged:!neutral,sourceChanged:true,before};
}
function renderTextKey(text) {
    let literal=false,unsafe=false;
    return String(text ?? '').split('\n').map(line=> {
        const value=!literal && !unsafe && /^[ \t]*$/.test(line) ? '' : line;
        for (const m of line.matchAll(/\\(?:begin|end)\s*\{(?:verbatim\*?|[BL]?Verbatim|lstlisting|minted|alltt)\}|\\(?:obeyspaces|obeylines|catcode)\b/g)) {
            if (/^\\end/.test(m[0])) literal=false;
            else if (/^\\begin/.test(m[0])) literal=true;
            else unsafe=true;
        }
        return value;
    }).join('\n');
}
module.exports={editImpact,renderTextKey};
