'use strict';
const fs=require('fs'),path=require('path');

// Resolve existing ancestors too, for consistent routing and repository advice.
function canonicalPath(value) {
    let candidate=path.resolve(String(value)),suffix=[];
    while (!fs.existsSync(candidate)) {
        const parent=path.dirname(candidate);
        if (parent===candidate) break;
        suffix.unshift(path.basename(candidate));candidate=parent;
    }
    try {candidate=fs.realpathSync.native(candidate);} catch (_) {}
    const result=path.join(candidate,...suffix);
    return process.platform==='win32' ? result.toLowerCase() : result;
}
function within(folder,file) {
    if (!folder || !file) return false;
    const relative=path.relative(canonicalPath(folder),canonicalPath(file));
    return relative==='' || (!path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep));
}
function scopeError(code,message) { const e=new Error(message);e.code=code;return e; }
function scopedPath(scope,value) {
    const file=canonicalPath(path.resolve(scope.directory,String(value)));
    return file;
}
function kernelAllowed(scope,kernel) {
    // Ownership is attribution, not an access boundary for local agents.
    return !!kernel && !kernel.owner_unavailable;
}
function kernelRecommended(scope,kernel) {
    if (!kernelAllowed(scope,kernel)) return false;
    if (!scope) return true;
    const owner=kernel.owner_folder || kernel.ownerFolder;
    if (owner && (within(scope.directory,owner) || within(owner,scope.directory))) return true;
    const notebooks = kernel.notebooks || [...(kernel.controller?.selectedNotebooks || [])];
    return notebooks.some(nb => within(scope.directory,typeof nb === 'string' ? nb : nb.uri.fsPath));
}
function kernelPreference(scope,kernel) {
    const recommended = kernelRecommended(scope,kernel);
    return { recommended, ...(!recommended && scope ? {
        recommendation: `Prefer a kernel associated with ${scope.directory}; other available kernels remain usable when explicitly selected.`,
    } : {}) };
}
function assertKernelScope(scope,kernel) {
    if (!kernelAllowed(scope,kernel)) throw scopeError('KERNEL_UNAVAILABLE','The selected kernel is unavailable. Choose a connected kernel.');
}
function folderClients(clients,directory) {
    const matches=clients.flatMap(c=>(c.workspaceRoots || []).filter(root=>within(root,directory))
        .map(root=>({client:c,root:canonicalPath(root)})));
    const longest=Math.max(0,...matches.map(m=>m.root.length));
    return matches.filter(m=>m.root.length===longest);
}
module.exports={canonicalPath,within,scopedPath,kernelAllowed,kernelRecommended,kernelPreference,assertKernelScope,scopeError,folderClients};
