'use strict';
// History is optional navigation, independent of the approval baseline/hunks.
const sizes=new WeakMap();
function historyLimits(options={}) {
    return {historyLimit:Number.isInteger(options.historyLimit) && options.historyLimit>=0 ? options.historyLimit : 20,
        historyMaxMB:Number.isFinite(options.historyMaxMB) && options.historyMaxMB>=0 ? options.historyMaxMB : 20};
}
function historyBytes(entry) {
    if (Number.isFinite(entry.historyBytes) && entry.historyBytes>=0) return entry.historyBytes;
    if (sizes.has(entry)) return sizes.get(entry);
    const bytes=Buffer.byteLength(JSON.stringify(String(entry.before ?? '')))+Buffer.byteLength(JSON.stringify(String(entry.after ?? '')));
    sizes.set(entry,bytes);return bytes;
}
function trimHistory(arrivals,options) {
    const {historyLimit,historyMaxMB}=historyLimits(options),budget=historyMaxMB*1024*1024;
    let bytes=0,start=arrivals.length;
    while (start>0 && arrivals.length-start<historyLimit) {
        const size=historyBytes(arrivals[start-1]);
        if (bytes+size>budget) break;
        bytes+=size;start--;
    }
    if (start) arrivals.splice(0,start);
    return arrivals;
}
module.exports={historyLimits,historyBytes,trimHistory};
