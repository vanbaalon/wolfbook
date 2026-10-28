'use strict';

const hosts=new WeakMap();
// One VS Code collection per extension host. Each controller owns a lease so
// evicting a remote proxy cannot dispose the diagnostics of a live local kernel.
function acquireDiagnostics(vscode) {
    let host=hosts.get(vscode);
    if(!host){host={collection:vscode.languages.createDiagnosticCollection('wolfram-syntax'),owners:new Map(),leases:0};hosts.set(vscode,host);}
    host.leases++;
    const owner={},uris=new Map();let disposed=false;
    const clear=()=>{
        for(const [key,uri] of uris)if(host.owners.get(key)===owner){host.collection.delete(uri);host.owners.delete(key);}
        uris.clear();
    };
    return {
        get name(){return host.collection.name;},
        get:uri=>host.collection.get(uri),
        set(uri,diagnostics){
            if(disposed)return;
            const key=uri.toString();uris.set(key,uri);host.owners.set(key,owner);host.collection.set(uri,diagnostics);
        },
        delete(uri){
            if(disposed)return;
            const key=uri.toString();host.owners.delete(key);uris.delete(key);host.collection.delete(uri);
        },
        clear,
        dispose(){
            if(disposed)return;disposed=true;clear();
            if(--host.leases===0){host.collection.dispose();hosts.delete(vscode);}
        },
    };
}
module.exports={acquireDiagnostics};
