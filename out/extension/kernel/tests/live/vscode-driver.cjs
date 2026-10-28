'use strict';
// Development-window acceptance driver. No notebook contents are written here:
// create/edit/evaluate through Wolfbook MCP; this bridge only exercises VS Code
// commands and observes its real notebook state. Bound to loopback and guarded
// by a per-run token, in an explicitly disposable workspace/profile.
const vscode=require('vscode');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
exports.run=async()=>{
    const folder=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if(!folder || !path.basename(path.dirname(folder)).startsWith('wolfbook-live-'))throw Error('Disposable wolfbook-live-* workspace required');
    const run=path.dirname(folder),token=crypto.randomBytes(24).toString('hex');
    const realFolder=fs.realpathSync(folder);
    const inWorkspace=file=>fs.realpathSync(file).startsWith(realFolder+path.sep);
    const ext=vscode.extensions.getExtension('wolfbook.wolfbook');
    await ext.activate();
    const events=[];
    const subscription=vscode.workspace.onDidChangeNotebookDocument(e=>{
        events.push({at:Date.now(),notebook:e.notebook.uri.fsPath,cells:e.cellChanges.map(c=>({index:c.cell.index,summary:c.executionSummary,outputs:!!c.outputs}))});
        if(events.length>200)events.shift();
    });
    const state=()=>({pid:process.pid,extensionPath:ext.extensionPath,active:vscode.window.activeNotebookEditor?.notebook.uri.fsPath,
        notebooks:vscode.workspace.notebookDocuments.map(nb=>({path:nb.uri.fsPath,closed:nb.isClosed,dirty:nb.isDirty,
            cells:nb.getCells().map(c=>({index:c.index,source:c.document.getText(),summary:c.executionSummary,
                outputs:c.outputs.flatMap(o=>o.items.filter(i=>i.mime==='text/plain'||i.mime==='application/vnd.code.notebook.error').map(i=>({mime:i.mime,text:Buffer.from(i.data).toString()})))}))})),events});
    const server=http.createServer(async(req,res)=>{
        const respond=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
        if(req.headers.authorization!==`Bearer ${token}`)return respond({error:'unauthorized'},403);
        try{
            let body='';for await(const chunk of req)body+=chunk;
            const input=body?JSON.parse(body):{};
            if(req.url==='/state')return respond(state());
            if(req.url==='/hover'){
                const target=path.resolve(input.notebook);
                if(!inWorkspace(target))throw Error('Only this disposable workspace');
                const nb=await vscode.workspace.openNotebookDocument(vscode.Uri.file(target));
                const hovers=await vscode.commands.executeCommand('vscode.executeHoverProvider',nb.cellAt(input.index||0).document.uri,new vscode.Position(0,input.character||1));
                return respond({hovers:hovers.map(h=>h.contents.map(c=>c.value||String(c)))});
            }
            if(req.url==='/select'){
                const target=path.resolve(input.notebook);
                if(!inWorkspace(target))throw Error('Only this disposable workspace');
                const nb=await vscode.workspace.openNotebookDocument(vscode.Uri.file(target));
                const ed=await vscode.window.showNotebookDocument(nb,{preview:false});
                ed.selections=[new vscode.NotebookRange(input.index||0,(input.index||0)+1)];
                await vscode.commands.executeCommand(input.edit?'notebook.cell.edit':'notebook.cell.quitEdit');
                return respond(state());
            }
            if(req.url==='/command'){
                if(!/^(wolfbook\.|notebook\.|workbench\.action\.(closeWindow|reloadWindow|closeAllEditors|focusActiveEditorGroup)|setContext$)/.test(input.command))throw Error('Command outside test scope');
                const value=await vscode.commands.executeCommand(input.command,...(input.args||[]));
                return respond({ok:true,value});
            }
            if(req.url==='/save'){
                for(const nb of vscode.workspace.notebookDocuments)if(inWorkspace(nb.uri.fsPath))await nb.save();
                return respond({ok:true});
            }
            if(req.url==='/close'){
                respond({ok:true});setTimeout(()=>vscode.commands.executeCommand('workbench.action.closeWindow'),100);return;
            }
            respond({error:'unknown route'},404);
        }catch(error){respond({error:error.stack},500);}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    fs.writeFileSync(path.join(run,'driver.json'),JSON.stringify({port:server.address().port,token,pid:process.pid,folder,extensionPath:ext.extensionPath}));
    fs.writeFileSync(path.join(run,'startup.json'),JSON.stringify(state(),null,2));
    await new Promise(()=>{});
    subscription.dispose();server.close();
};
