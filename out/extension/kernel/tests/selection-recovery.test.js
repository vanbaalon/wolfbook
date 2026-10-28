'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Module=require('node:module');
const {associateNotebook}=require('../association');
const {makeVscodeStub}=require('./_stub-vscode');
const source=fs.readFileSync(path.join(__dirname,'../../controller.js'),'utf8');
const start=source.indexOf('        const _createExecution = async');
const end=source.indexOf('\n        if (this.isAborting)',start);

test('VS Code rejecting a stale selected receipt causes real reselection before retry',async()=>{
    const nb={uri:{toString:()=> 'file:///tmp/switched.wb'}};
    const cell={index:0,notebook:nb};
    let selected=false,attempts=0,selections=0;
    const listeners=new Set();
    const execution={cell};
    const ctrl={selectedNotebooks:new Set([nb]),_controller:{id:'K2',label:'K2',
        updateNotebookAffinity(){},
        onDidChangeSelectedNotebooks:fn=>{listeners.add(fn);return {dispose:()=>listeners.delete(fn)};},
        createNotebookCellExecution:()=>{
            attempts++;if(!selected)throw Error('controller is not associated with notebook');return execution;
        }}};
    const editor={notebook:nb};
    const vscode=makeVscodeStub({window:{activeNotebookEditor:editor,visibleNotebookEditors:[editor]},commands:{
        getCommands:async()=>['notebook.selectKernel'],executeCommand:async(name,args)=>{
            assert.equal(name,'notebook.selectKernel');assert.equal(args.id,'K2');
            selections++;selected=true;ctrl.selectedNotebooks.add(nb);
            for(const fn of [...listeners])fn({notebook:nb,selected:true});
        }}});
    const original=Module._load;
    Module._load=function(request){return request==='vscode'?vscode:original.apply(this,arguments);};
    try {
        const recover=vm.runInNewContext(`(function(){${source.slice(start,end)};return _createExecution;})`,{
            isSilent:false,scrollLog(){},require:name=>{
                assert.equal(name,'./kernel/association');return {associateNotebook};
            }}).call(ctrl);
        assert.equal(await recover(cell),execution);
        assert.equal(selections,1,'must not take the cached already-selected shortcut');
        assert.equal(attempts,2);assert.equal(listeners.size,0);
    } finally {Module._load=original;}
});
