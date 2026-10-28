'use strict';
const {makeVscodeStub,withVscodeStub}=require('./_stub-vscode');
const fixtureTex=String.raw`\documentclass{article}
\begin{document}
First page.
\newpage
Second page.
\newpage
Prefix Selected sentence here. Tail remains.
\end{document}`;
class Position {constructor(line,character){Object.assign(this,{line,character});}}
class Range {constructor(start,end){Object.assign(this,{start,end});}}
class Selection extends Range {}
const stub=makeVscodeStub({Position,Range,Selection});
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'),stub);
function fixture({pro=true,caret={page:3,x:92,y:72,h:12},reject=false}={}) {
    const file='/isolated-selection-typing/paper.tex';let text=fixtureTex,version=1;
    const edits=[],messages=[];
    const doc={uri:stub.Uri.file(file),get version(){return version;},
        getText(range){return range ? text.slice(this.offsetAt(range.start),this.offsetAt(range.end)) : text;},
        positionAt(offset){const lines=text.slice(0,offset).split('\n');return new Position(lines.length-1,lines.at(-1).length);},
        offsetAt(p){return text.split('\n').slice(0,p.line).reduce((n,line)=>n+line.length+1,0)+p.character;},
        lineAt(n){return {text:text.split('\n')[n] || ''};},get lineCount(){return text.split('\n').length;}};
    stub.workspace.textDocuments=[doc];stub.workspace.openTextDocument=async()=>doc;
    stub.WorkspaceEdit=class {constructor(){this.edits=[];}replace(uri,range,value){this.edits.push({uri,range,value});}};
    stub.workspace.applyEdit=async edit=>{
        if (reject) return false;
        for (const e of edit.edits) {
            const start=doc.offsetAt(e.range.start),end=doc.offsetAt(e.range.end);
            edits.push({start,end,value:e.value});text=text.slice(0,start)+e.value+text.slice(end);version++;
        }
        return true;
    };
    stub.window.visibleTextEditors=[];
    const start=text.indexOf('Selected'),end=start+'Selected sentence here.'.length;
    const map={available:true,native:false,lineRows:()=>[{...caret,w:180}],glyphsForLine:()=>[]};
    const st={map,...(pro ? {nativeLane:{interactive:true}} : {})};
    const v=Object.create(TexViewer.prototype);
    Object.assign(v,{root:file,panel:{},coord:{roots:new Map([[file,st]])},_post:m=>messages.push(m),_log:()=>{},
        _lastSelection:{file,start:doc.positionAt(start),end:doc.positionAt(end),sourceText:text,documentVersion:version},
        _ink:{root:file,file,offset:text.indexOf('First'),version,caret:{page:1,x:10,y:10,h:12}},
        _inkRect:()=>caret,_inkFollow:()=>{},_editSeq:0,_openedGeneration:1,_openedPdfHash:'fixture',
        _ensureDocListener:()=>{},_rememberEditState:()=>{},_editCellStarts:()=>[0],
        _blockAt:()=>({startLine:7,endLine:7,label:'paragraph'})});
    return {v,doc,start,end,edits,messages,stub,
        async replace(key='a',id=1){await v._selectionAction({action:'replace',typingRequest:id,key,text:key,page:3,xBp:caret.x,yTopBp:caret.y,generation:1});},
        async keys(keys,id=1){for(const key of keys)v._inkKey({key,typingRequest:id});await v._inkQueue;}};
}
module.exports={fixtureTex,fixture};
