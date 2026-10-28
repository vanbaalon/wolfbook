'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const Module=require('node:module');
const {CommentStore,sidecarFor}=require('../../tex/commentStore');
const {CommentInbox,commentInbox}=require('../../tex/commentInbox');
const {commentAgent,commentWakeup}=require('../../tex/commentWakeup');
const {registerReaderRange}=require('../../tex/editorActivity');
const {makeVscodeStub}=require('./_stub-vscode');
const {withVscodeStub}=require('./_stub-vscode');
const PAPER=String.raw`\documentclass{article}
\begin{document}
\section{Collaboration}

First paragraph with enough prose to edit separately from the reader.

Middle paragraph stays open in the reader's mini-editor.

Last paragraph with enough prose to edit separately from the reader.

\end{document}
`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function fixture(t) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wpaper-listener-'));
    const file=path.join(dir,'paper.tex');fs.writeFileSync(file,PAPER);
    let text=PAPER, compileHook;
    const batches=[],compiles=[],messages=[];
    const doc={uri:{fsPath:file},languageId:'latex',version:1,
        get isDirty(){return text!==fs.readFileSync(file,'utf8');},
        getText(range){return range ? text.slice(this.offsetAt(range.start),this.offsetAt(range.end)) : text;},
        positionAt(offset){const head=text.slice(0,offset).split('\n');return {line:head.length-1,character:head.at(-1).length};},
        offsetAt(p){return text.split('\n').slice(0,p.line).reduce((a,s)=>a+s.length+1,0)+p.character;},
        set(next){text=next;this.version++;},async save(){fs.writeFileSync(file,text);return true;}};
    const stub=makeVscodeStub();
    stub.Range=class {constructor(start,end){Object.assign(this,{start,end});}};
    stub.WorkspaceEdit=class {constructor(){this.items=[];} replace(uri,range,value){this.items.push({uri,range,text:value});}};
    stub.workspace.textDocuments=[doc];stub.workspace.workspaceFolders=[{uri:{fsPath:dir}}];
    stub.workspace.fs={readFile:async uri=>fs.promises.readFile(uri.fsPath)};
    stub.workspace.openTextDocument=async()=>doc;
    let viewer;
    stub.workspace.applyEdit=async edit=>{
        const before=text;
        const changes=edit.items.map(e=>({rangeOffset:doc.offsetAt(e.range.start),
            rangeLength:doc.offsetAt(e.range.end)-doc.offsetAt(e.range.start),text:e.text}));
        for(const c of [...changes].sort((a,b)=>b.rangeOffset-a.rangeOffset))
            text=text.slice(0,c.rangeOffset)+c.text+text.slice(c.rangeOffset+c.rangeLength);
        doc.version++;batches.push({before,changes});
        // Intentionally send changes in ascending order, which consumers must
        // translate using the single pre-edit coordinate system.
        viewer?._onEditDocChange({document:doc,contentChanges:[...changes].sort((a,b)=>a.rangeOffset-b.rangeOffset)});
        return true;
    };
    const original=Module._load;let tools,TexViewer;
    try {
        Module._load=function(name,...args){
            if(name==='vscode')return stub;
            if(name==='../tex/compileService')return {compile:async options=>{
                compiles.push(options);return compileHook ? compileHook(options) : {ok:true,engine:options.engine};}};
            return original.call(this,name,...args);
        };
        delete require.cache[require.resolve('../../tools/tex-tools')];tools=require('../../tools/tex-tools');
        ({TexViewer}=require('../../tex/texViewer'));
    } finally {Module._load=original;}
    const invoke=async(name,input={},token)=>{
        const result=await new tools[name]().invoke({input},token);
        const body=result.content.map(p=>p.value).join('');
        try{return JSON.parse(body);}catch{return {error:body};}
    };
    const inbox=new CommentInbox();const store=new CommentStore();
    const objects=()=>tools.projectionOf(file,text).model.objects;
    const paragraph=word=>objects().find(o=>o.kind==='paragraph' && o.text.includes(word));
    const add=(body='Please rewrite this sentence.',word='First',meta={})=>store.add(file,paragraph(word),body,meta,objects());
    const listen=(input={},token)=>invoke('PaperListenCommentsTool',{projection:'full',...input},token);
    const edit=async(word='First',value='Improved paragraph.',verify=true)=>{
        const obj=paragraph(word);
        const preview=await invoke('PaperPreviewEditTool',{file,selector:obj.stableKey,expected_source_hash:obj.sourceHash,new_text:value});
        return invoke('PaperApplyEditTool',{transaction_id:preview.transaction_id,verify});
    };
    t.after(()=>{
        for(const l of [...commentInbox().listeners.values()])if(l.file.startsWith(dir+path.sep))commentInbox().stop(l.id);
        inbox.dispose();viewer?._disposables?.forEach(d=>d.dispose());fs.rmSync(dir,{recursive:true,force:true});
    });
    return {dir,file,doc,stub,store,inbox,tools,invoke,listen,add,paragraph,objects,edit,batches,compiles,messages,
        compile:fn=>{compileHook=fn;},
        mini(word='Middle'){
            const obj=paragraph(word);viewer=new TexViewer({}, {roots:new Map()}, {});
            viewer.panel={};viewer.root=file;viewer._rememberEditState=()=>{};viewer._post=m=>messages.push(m);
            viewer._edit={id:1,file,startOffset:obj.sourceRange.startOffset,endOffset:obj.sourceRange.endOffset,lastText:obj.text};
            const sub=registerReaderRange(()=>({file,start:viewer._edit.startOffset,end:viewer._edit.endOffset}));
            viewer._disposables.push(sub);return viewer;
        }};
}

test('waiting for comments leaves the event loop, source, viewer edits and compiler free',async t=>{
    const f=fixture(t),start=await f.listen({action:'start',file:f.file});
    assert.equal(start.state,'listening');let ticks=0;
    const timer=setInterval(()=>ticks++,5);t.after(()=>clearInterval(timer));
    const waiting=f.listen({action:'next',listener_id:start.listener_id,wait_seconds:300});
    await pause(30);
    f.doc.set(f.doc.getText().replace('Middle paragraph','Reader typing in the middle paragraph'));
    const outline=await f.invoke('PaperGetOutlineTool',{file:f.file});assert.ok(outline.outline.length);
    const posted=f.add('Change the first paragraph.');
    const delivery=await waiting;
    assert.equal(delivery.state,'comments');assert.equal(delivery.comments[0].id,posted.id);
    assert.ok(ticks>=2);assert.equal(f.compiles.length,0);assert.equal(f.batches.length,0);
    assert.equal(fs.readFileSync(f.file,'utf8'),PAPER);assert.ok(f.doc.getText().includes('Reader typing'));
    assert.equal(f.store.read(f.file).comments.length,1,'delivery never deletes the instruction');
    assert.equal(delivery.comments[0].object.sourceHash,f.paragraph('First').sourceHash);
});

test('file-scoped starts skip old comments by default and explicitly recover them after restart',async t=>{
    const f=fixture(t),old=f.add('Old discussion');
    const start=await f.inbox.start(f.file);
    assert.equal((await f.inbox.next(start.listener_id,{waitSeconds:0})).state,'waiting');
    assert.equal((await f.inbox.start(f.file)).state,'already-listening');
    f.inbox.stop(start.listener_id);
    const recovered=await f.inbox.start(f.file,true);
    assert.equal((await f.inbox.next(recovered.listener_id,{waitSeconds:0})).comments[0].id,old.id);
    assert.throws(()=>f.inbox.get(recovered.listener_id,path.join(f.dir,'other.tex')),/different file/);
    assert.equal(f.store.read(f.file).comments.length,1);
});

test('external atomic sidecar replacements and edits wake the listener',async t=>{
    const f=fixture(t),comment=f.add('Original instruction');const start=await f.inbox.start(f.file);
    const waiting=f.inbox.next(start.listener_id,{waitSeconds:1});
    await pause(20);
    const record=f.store.read(f.file);record.comments[0].text='External revised instruction';
    record.comments[0].updatedAt=new Date(Date.now()+1).toISOString();
    const temp=sidecarFor(f.file)+'.external';fs.writeFileSync(temp,JSON.stringify(record));fs.renameSync(temp,sidecarFor(f.file));
    const got=await waiting;assert.equal(got.state,'comments');assert.equal(got.comments[0].id,comment.id);
    assert.equal(got.comments[0].text,'External revised instruction');
});

test('claims redeliver until completion, release preserves them, and leases recover after expiry',async t=>{
    const f=fixture(t);f.add();const start=await f.inbox.start(f.file,true);
    const first=await f.inbox.next(start.listener_id,{waitSeconds:0});
    const again=await f.inbox.next(start.listener_id,{waitSeconds:0});
    assert.equal(again.delivery_id,first.delivery_id);assert.equal(again.redelivered,true);
    f.inbox.release(start.listener_id,first.delivery_id);
    const second=await f.inbox.next(start.listener_id,{waitSeconds:0});assert.notEqual(second.delivery_id,first.delivery_id);
    f.inbox.get(start.listener_id).claim.expiresAt=0;
    assert.throws(()=>f.inbox.claim(start.listener_id,second.delivery_id),/expired/);
    const recovered=await f.inbox.next(start.listener_id,{waitSeconds:0});assert.notEqual(recovered.delivery_id,second.delivery_id);
    assert.equal(f.store.read(f.file).comments.length,1);
});

test('cancellation, concurrent waits and stopping settle without losing comments',async t=>{
    const f=fixture(t),start=await f.inbox.start(f.file);
    let cancel;const token={isCancellationRequested:false,onCancellationRequested(fn){cancel=fn;return {dispose(){}};}};
    const waiting=f.inbox.next(start.listener_id,{waitSeconds:1,token});await pause(20);
    assert.equal((await f.inbox.next(start.listener_id,{waitSeconds:0})).state,'already-waiting');
    token.isCancellationRequested=true;cancel();assert.equal((await waiting).state,'cancelled');
    const next=f.inbox.next(start.listener_id,{waitSeconds:1});await pause(20);f.inbox.stop(start.listener_id);
    assert.equal((await next).state,'stopped');f.add();assert.equal(f.store.read(f.file).comments.length,1);
});

test('malformed sidecars and invalid waits are refused without overwriting shared comments',async t=>{
    const f=fixture(t),start=await f.inbox.start(f.file);
    await assert.rejects(f.inbox.next(start.listener_id,{waitSeconds:301}),/0–300/);
    fs.writeFileSync(sidecarFor(f.file),'broken shared JSON');
    await assert.rejects(f.inbox.next(start.listener_id,{waitSeconds:0}));
    assert.equal(fs.readFileSync(sidecarFor(f.file),'utf8'),'broken shared JSON');
    await assert.rejects(f.inbox.start(path.join(f.dir,'missing/paper.tex')));
});

test('MCP cancellation interrupts only its named wait and preserves listener and comments',async t=>{
    const f=fixture(t),start=await f.inbox.start(f.file);
    const wait=f.inbox.next(start.listener_id,{waitSeconds:1,requestId:'mcp-wait'});
    await pause(20);f.inbox.cancelWait(start.listener_id,'mcp-wait');
    assert.equal((await wait).state,'cancelled');assert.equal(f.inbox.status(start.listener_id).state,'listening');
    f.inbox.cancelWait(start.listener_id,'cancel-before-dispatch');
    assert.equal((await f.inbox.next(start.listener_id,{waitSeconds:0,requestId:'cancel-before-dispatch'})).state,'cancelled');
    f.add('Still available');assert.equal((await f.inbox.next(start.listener_id,{waitSeconds:0})).state,'comments');
    assert.equal(f.store.read(f.file).comments.length,1);
});

test('successful verified acknowledgement consumes only delivered comments and uses a separate compiler lane',async t=>{
    const f=fixture(t),posted=f.add('Improve first paragraph');
    const start=await f.listen({action:'start',file:f.file,include_existing:true});
    const delivery=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0});
    const newComment=f.add('Keep this later comment','Last');
    const applied=await f.edit('First','An improved first paragraph.');assert.equal(applied.state,'applied');
    assert.ok(f.compiles[0].outDir.includes('wolfbook-paper-verification'));
    const ack=await f.listen({action:'ack',listener_id:start.listener_id,delivery_id:delivery.delivery_id,operation_id:applied.operation_id});
    assert.equal(ack.state,'consumed');assert.equal(ack.comments_deleted,1);
    assert.deepEqual(f.store.read(f.file).comments.map(c=>c.id),[newComment.id]);
    assert.ok(!f.store.read(f.file).comments.some(c=>c.id===posted.id));
    assert.equal(fs.readFileSync(f.file,'utf8'),PAPER,'listener and unsaved model edits never implicitly save source');
});

test('a real LaTeX-verified listener round trip compiles private overlays and consumes after success',async t=>{
    const f=fixture(t),realCompile=withVscodeStub(()=>require('../../tex/compileService'),f.stub).compile;
    f.add('Improve this first paragraph.');const start=await f.listen({action:'start',file:f.file,include_existing:true});
    const delivery=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0});
    f.compile(realCompile);
    const applied=await f.edit('First','First improved paragraph after a real compiler verification.');
    if(f.compiles[0]?.outDir)t.after(()=>fs.rmSync(f.compiles[0].outDir,{recursive:true,force:true}));
    assert.equal(applied.state,'applied',JSON.stringify(applied));assert.equal(applied.verification.latex.ok,true);
    assert.ok(applied.verification.latex.pdfBytes>0);assert.equal(fs.readFileSync(f.file,'utf8'),PAPER);
    const ack=await f.listen({action:'ack',listener_id:start.listener_id,delivery_id:delivery.delivery_id,operation_id:applied.operation_id});
    assert.equal(ack.state,'consumed');assert.equal(fs.existsSync(sidecarFor(f.file)),false);
});

test('failed, unverified and rolled-back edits cannot consume a comment',async t=>{
    const f=fixture(t);f.add();const start=await f.listen({action:'start',file:f.file,include_existing:true});
    const delivery=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0});
    const ack=operation_id=>f.listen({action:'ack',listener_id:start.listener_id,delivery_id:delivery.delivery_id,operation_id});
    assert.equal((await ack('made-up')).state,'not-consumed');
    const unverified=await f.edit('First','First modified paragraph with enough prose to remain addressable.',false);assert.equal((await ack(unverified.operation_id)).state,'not-consumed');
    f.compile(async()=>({ok:false,engine:'pdflatex'}));
    const failed=await f.edit('First','First broken paragraph with enough prose to remain addressable.');assert.equal(failed.state,'rolled-back');
    assert.equal((await ack(failed.operation_id)).state,'not-consumed');assert.equal(f.store.read(f.file).comments.length,1);
});

test('editing a delivered comment during model work preserves the new instruction and redelivers it',async t=>{
    const f=fixture(t),comment=f.add('Old request');
    const start=await f.listen({action:'start',file:f.file,include_existing:true});
    const delivery=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0});
    const applied=await f.edit();f.store.update(f.file,comment.id,'Actually do this instead');
    const ack=await f.listen({action:'ack',listener_id:start.listener_id,delivery_id:delivery.delivery_id,operation_id:applied.operation_id});
    assert.equal(ack.state,'comment-changed');assert.equal(ack.comments_deleted,0);
    const next=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0});
    assert.equal(next.comments[0].text,'Actually do this instead');assert.notEqual(next.delivery_id,delivery.delivery_id);
});

test('selection quotations retain the exact current source line after unrelated user edits',async t=>{
    const f=fixture(t);const quote='separately from the reader.';
    f.add('Rewrite the selected ending','First',{selection:{quote,lineOffset:0,endLineOffset:0}});
    const start=await f.listen({action:'start',file:f.file,include_existing:true});
    f.doc.set(f.doc.getText().replace('First paragraph','\n\nFirst paragraph'));
    const delivery=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0});
    assert.equal(delivery.comments[0].quote,quote);
    assert.equal(delivery.comments[0].line,f.doc.getText().slice(0,f.doc.getText().indexOf(quote)).split('\n').length);
    assert.equal(delivery.comments[0].object.sourceHash,f.paragraph('First').sourceHash);
});

test('reader typing elsewhere during verification does not prevent consuming an intact model edit',async t=>{
    const f=fixture(t);f.add();const start=await f.listen({action:'start',file:f.file,include_existing:true});
    const delivery=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0});
    f.compile(async()=>{f.doc.set(f.doc.getText().replace('Last paragraph','Reader changed the last paragraph'));
        return {ok:true,engine:'pdflatex'};});
    const applied=await f.edit('First','First improved paragraph with ample prose for the reader.');
    assert.equal(applied.source_conflict,true);
    const ack=await f.listen({action:'ack',listener_id:start.listener_id,delivery_id:delivery.delivery_id,operation_id:applied.operation_id});
    assert.equal(ack.state,'consumed');assert.ok(f.doc.getText().includes('Reader changed'));
    assert.equal(f.doc.getText().includes('First improved'),true);
});

test('reader modifications to the requested fragment keep its comment pending after verification',async t=>{
    const f=fixture(t);f.add();const start=await f.listen({action:'start',file:f.file,include_existing:true});
    const delivery=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0});
    const applied=await f.edit('First','First improved paragraph with ample prose for the reader.');
    f.doc.set(f.doc.getText().replace('First improved','Reader subsequently rewrote this'));
    const ack=await f.listen({action:'ack',listener_id:start.listener_id,delivery_id:delivery.delivery_id,operation_id:applied.operation_id});
    assert.equal(ack.state,'not-consumed');assert.equal(f.store.read(f.file).comments.length,1);
});

test('an open mini-editor defers overlapping model edits while other fragments remain writable',async t=>{
    const f=fixture(t),viewer=f.mini();
    const blocked=await f.edit('Middle','Rewritten middle paragraph.');assert.equal(blocked.state,'user-editing');
    assert.equal(f.batches.length,0);assert.equal(f.compiles.length,0);
    assert.equal((await f.edit('First','First changed elsewhere.')).state,'applied');
    assert.equal(viewer._edit.lastText,"Middle paragraph stays open in the reader's mini-editor.");
    assert.equal(f.messages.some(m=>m.type==='editConflict' || m.type==='editUpdate'),false);
});

test('disjoint model batches preserve the intervening mini-editor range and roll back only their own spans',async t=>{
    const f=fixture(t),viewer=f.mini(),session=viewer._edit;
    const edits=['First','Last'].map(word=>{const o=f.paragraph(word);return {selector:o.stableKey,expected_source_hash:o.sourceHash,new_text:`${word} replacement with more text.`};});
    const p=await f.invoke('PaperPreviewEditTool',{file:f.file,edits});
    f.compile(async()=>({ok:false,engine:'pdflatex'}));
    const applied=await f.invoke('PaperApplyEditTool',{transaction_id:p.transaction_id,verify:true});
    assert.equal(applied.state,'rolled-back');assert.equal(f.doc.getText(),PAPER);
    assert.equal(f.batches.length,2);assert.deepEqual(f.batches.map(b=>b.changes.length),[2,2]);
    assert.equal(f.doc.getText().slice(session.startOffset,session.endOffset),session.lastText);
    assert.equal(f.messages.some(m=>m.type==='editConflict' || m.type==='editUpdate'),false);
});

test('native wake-up plans detect only the supported client and bind escaped paths to one listener',()=>{
    assert.equal(commentAgent(undefined,'claude-code'),'claude-code');
    assert.equal(commentAgent(undefined,'codex-mcp-client'),'codex');
    assert.equal(commentAgent(undefined,'Claude Desktop'),'other');
    assert.equal(commentAgent('codex','claude-code'),'codex');
    assert.throws(()=>commentAgent('some-scheduler'),/agent must/);
    const file='/tmp/Paper "2026"/research $(echo unsafe) `unsafe`.tex';
    const plan=commentWakeup({id:'paper_listener_test',file,agent:'claude-code'});
    assert.deepEqual(plan.poll,{action:'next',file,listener_id:'paper_listener_test',wait_seconds:0});
    assert.equal(plan.setup.tool,'CronCreate');assert.equal(plan.setup.arguments.recurring,true);
    assert.ok(plan.setup.arguments.prompt.includes(JSON.stringify(plan.poll)));
    assert.match(plan.setup.arguments.prompt,/cancel ONLY/);
    assert.match(plan.setup.arguments.prompt,/do not restart the listener automatically/);
    assert.equal(plan.server_installs_scheduler,false);
});

test('a native scheduled check between turns consumes a verified edit without disturbing a reader',async t=>{
    const f=fixture(t),viewer=f.mini();f.add();
    const start=await f.listen({action:'start',file:f.file,include_existing:true,
        _activityContext:{agentName:'claude-code'}});
    assert.equal(start.wakeup.strategy,'claude-cron');
    // Simulate the client's scheduler after the initial model turn has ended:
    // there is no active next wait or source/compiler lock between checks.
    await pause(15);assert.equal(commentInbox().status(start.listener_id).waiting,false);
    const delivery=await f.listen(start.wakeup.poll);assert.equal(delivery.state,'comments');
    const applied=await f.edit('First','First paragraph improved by a scheduled check.');
    const ack=await f.listen({action:'ack',listener_id:start.listener_id,
        delivery_id:delivery.delivery_id,operation_id:applied.operation_id});
    assert.equal(ack.ok,true);assert.equal(f.store.read(f.file).comments.length,0);
    assert.equal(viewer._edit.lastText,"Middle paragraph stays open in the reader's mini-editor.");
    assert.equal(f.messages.some(m=>m.type==='editConflict' || m.type==='editUpdate'),false);
    const quiet=await f.listen(start.wakeup.poll);assert.equal(quiet.state,'waiting');
    assert.deepEqual(quiet,{state:'waiting',listener_id:start.listener_id});
    const stop=await f.listen({action:'stop',listener_id:start.listener_id});
    assert.match(stop.wakeup_cleanup,/CronDelete/);
    const staleTick=await f.listen(start.wakeup.poll);assert.match(staleTick.error,/Unknown or expired/);
    assert.equal(commentInbox().byFile.has(f.file),false,'an old scheduled check must not recreate a stopped listener');
});

test('scheduled checks defer mini-editor conflicts and retry safely on a later wake-up',async t=>{
    const f=fixture(t),viewer=f.mini('First');f.add();
    const start=await f.listen({action:'start',file:f.file,agent:'claude-code',include_existing:true});
    const delivery=await f.listen(start.wakeup.poll);
    const blocked=await f.edit('First','First paragraph from the agent.');
    assert.equal(blocked.state,'user-editing');assert.equal(f.compiles.length,0);
    assert.equal(f.store.read(f.file).comments.length,1);assert.equal(f.doc.getText(),PAPER);
    await pause(15);
    assert.equal((await f.listen(start.wakeup.poll)).delivery_id,delivery.delivery_id);
    viewer._edit=null; // The reader closed the card before the later check.
    const applied=await f.edit('First','First paragraph from the agent.');assert.equal(applied.state,'applied');
    assert.equal((await f.listen({action:'ack',listener_id:start.listener_id,
        delivery_id:delivery.delivery_id,operation_id:applied.operation_id})).ok,true);
    assert.equal(f.store.read(f.file).comments.length,0);
});

test('Codex continuation does not create an unauthorized Goal or claim native scheduling succeeded',async t=>{
    const f=fixture(t);
    const start=await f.listen({action:'start',file:f.file,_activityContext:{agentName:'codex-mcp-client'}});
    assert.equal(start.wakeup.strategy,'codex-wait');assert.equal(start.wakeup.server_installs_scheduler,false);
    assert.equal(start.wakeup.continuous_wait.arguments.wait_seconds,45);
    assert.match(start.wakeup.next,/only when the user explicitly requests a Goal/);
    assert.equal(start.wakeup.setup,undefined,'no implicit create_goal instruction');
    assert.equal(f.compiles.length,0);assert.equal(f.batches.length,0);
    const status=await f.listen({action:'status',listener_id:start.listener_id});
    assert.equal(status.wakeup.agent,'codex');
    await f.listen({action:'stop',listener_id:start.listener_id});
    const invalid=await f.listen({action:'start',file:f.file,agent:'unknown'});
    assert.match(invalid.error,/agent must/);assert.equal(commentInbox().byFile.has(f.file),false);
});

async function deliveryFor(f) {
    const start=await f.listen({action:'start',file:f.file,include_existing:true});
    return f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0});
}
function commentPatch(delivery, replacement, old) {
    const c=delivery.comments[0];
    return {comment_id:c.id,expected_old_text:old ?? c.anchor.editable_span.text,
        replacement,expected_span_hash:c.anchor.editable_span.source_hash};
}

test('prose adjacent to displays and headings is directly addressable without whitespace preparation',async t=>{
    const f=fixture(t);
    f.doc.set(String.raw`\documentclass{article}
\begin{document}
\section{First}Short prose.
\begin{equation}x=1\label{eq:x}\end{equation}
Next prose with the inline spectral identity $y=2$.
\subsection{Next}Last prose.

\label{sec:metadata-only}

\end{document}`);
    const prose=f.objects().filter(o=>o.kind==='paragraph');
    assert.deepEqual(prose.map(o=>o.text),['Short prose.','Next prose with the inline spectral identity $y=2$.','Last prose.']);
    for(const p of prose)assert.equal(f.doc.getText().slice(p.sourceRange.startOffset,p.sourceRange.endOffset),p.text);
    const eq=f.objects().find(o=>o.kind==='display-equation');
    assert.ok(prose.every(p=>p.sourceRange.endOffset<=eq.sourceRange.startOffset || p.sourceRange.startOffset>=eq.sourceRange.endOffset));
});

test('one comment patch verifies inline-to-display conversion and acknowledges without preparatory edits',async t=>{
    const f=fixture(t);f.doc.set(String.raw`\documentclass{article}
\begin{document}
\section{Identity}
First spectral identity $y=2$.
\begin{equation}x=1\label{eq:x}\end{equation}
Last prose.
\end{document}`);
    f.add('Write the selected identity as an equation.','First',{selection:{quote:'$y=2$',lineOffset:0,endLineOffset:0}});
    const delivery=await deliveryFor(f),c=delivery.comments[0];
    assert.equal(c.anchor.status,'exact');assert.ok(c.anchor.equation_labels.includes('eq:x'));
    f.compile(withVscodeStub(()=>require('../../tex/compileService'),f.stub).compile);
    const began=Date.now();
    const applied=await f.invoke('PaperApplyEditTool',{delivery_id:delivery.delivery_id,
        patches:[commentPatch(delivery,String.raw`\begin{equation}y=2\end{equation}`)],acknowledge:true,save:true});
    if(f.compiles[0]?.outDir)t.after(()=>fs.rmSync(f.compiles[0].outDir,{recursive:true,force:true}));
    assert.equal(applied.state,'applied',JSON.stringify(applied));assert.equal(applied.unguarded,undefined);
    assert.equal(applied.verification.latex.ok,true);assert.ok(applied.verification.latex.pdfBytes>0);
    assert.equal(applied.acknowledgment.state,'consumed');assert.equal(applied.saved,true);
    assert.equal(f.batches.length,1);assert.equal(f.compiles.length,1);assert.equal(f.store.read(f.file).comments.length,0);
    assert.ok(f.doc.getText().includes('First spectral identity \\begin{equation}y=2\\end{equation}.'));
    t.diagnostic(`delivery → apply/verify/ack: ${Date.now()-began}ms; compile: ${applied.verification.latex.durationMs}ms; 1 edit, 0 preparatory edits`);
});

test('detached semantic anchors deliver uniquely relocated guarded quotes and direct context handles',async t=>{
    const f=fixture(t);const quote='First paragraph';f.add('Fix this','First',{selection:{quote,lineOffset:0,endLineOffset:0}});
    const record=f.store.read(f.file);Object.assign(record.cells[0],{kind:'unknown-old-object',stableKey:'gone',source:'Old missing object.',sourceHash:'gone'});
    f.store.write(f.file,record);f.doc.set(f.doc.getText().replace('\\section{Collaboration}','\\section{Collaboration}\n\n'));
    const delivery=await deliveryFor(f),c=delivery.comments[0];
    assert.equal(c.detached,true);assert.equal(c.object,null);assert.equal(c.anchor.status,'uniquely-relocated');
    assert.equal(c.anchor.editable_span.text,quote);assert.equal(c.anchor.editable_span.buffer_version,f.doc.version);
    const context=await f.listen({...c.anchor.context_handle,offset:0,limit:5});
    assert.equal(context.anchor.editable_span.text,'First');assert.equal(context.anchor.editable_span.truncated,true);
    f.doc.set(f.doc.getText().replace('\\begin{document}','\\begin{document}\nReader text before the target.\n'));
    const applied=await f.invoke('PaperApplyEditTool',{file:f.file,delivery_id:delivery.delivery_id,
        patches:[commentPatch(delivery,'Improved paragraph')],verify:true,acknowledge:true});
    assert.equal(applied.state,'applied',JSON.stringify(applied));assert.equal(applied.acknowledgment.state,'consumed');
    assert.ok(f.doc.getText().includes('Reader text before'));assert.equal(f.batches.length,1);
});

test('missing, repeated, changed-hash and out-of-span patches cannot guess a source location',async t=>{
    const f=fixture(t);f.add('Fix selected words','First',{selection:{quote:'First paragraph',lineOffset:0,endLineOffset:0}});
    const delivery=await deliveryFor(f),patch=commentPatch(delivery,'Improved words');
    for(const p of [{...patch,expected_span_hash:'stale'},{...patch,expected_old_text:'Last paragraph'}]) {
        const result=await f.invoke('PaperApplyEditTool',{file:f.file,delivery_id:delivery.delivery_id,patches:[p]});
        assert.equal(result.state,'conflict');
    }
    f.doc.set(f.doc.getText().replace('Last paragraph','First paragraph'));
    assert.equal((await f.listen({...delivery.comments[0].anchor.context_handle})).anchor.status,'ambiguous');
    assert.equal((await f.invoke('PaperApplyEditTool',{file:f.file,delivery_id:delivery.delivery_id,patches:[patch]})).state,'conflict');
    f.doc.set(f.doc.getText().replaceAll('First paragraph','Missing quotation'));
    assert.equal((await f.listen({...delivery.comments[0].anchor.context_handle})).anchor.status,'missing');
    assert.equal((await f.invoke('PaperApplyEditTool',{file:f.file,delivery_id:delivery.delivery_id,patches:[patch]})).state,'conflict');
    assert.equal(f.batches.length,0);assert.equal(f.compiles.length,0);assert.equal(f.store.read(f.file).comments.length,1);
});

test('actual patch ranges preserve unrelated mini-editor drafts and reject overlapping patches',async t=>{
    const f=fixture(t);f.mini();
    const {sha256}=require('../../tex/texModel');
    const passage=f.doc.getText();
    const result=await f.invoke('PaperApplyEditTool',{file:f.file,patches:[{
        expected_old_text:passage,replacement:passage.replace('First paragraph','Improved paragraph'),expected_span_hash:sha256(passage)}]});
    assert.equal(result.state,'applied',JSON.stringify(result));assert.equal(f.batches.length,1);
    const middle=f.paragraph('Middle');
    const conflict=await f.invoke('PaperApplyEditTool',{file:f.file,patches:[{
        expected_old_text:middle.text,replacement:'Overwritten reader draft.',expected_span_hash:middle.sourceHash}]});
    assert.equal(conflict.state,'user-editing');assert.equal(f.batches.length,1);
});

test('copied and deleted comment reports can use unique guarded patches without recreating comments',async t=>{
    const f=fixture(t),posted=f.add();const delivery=await deliveryFor(f),patch=commentPatch(delivery,'Improved first paragraph.');
    f.store.delete(f.file,posted.id);
    const refused=await f.invoke('PaperApplyEditTool',{file:f.file,delivery_id:delivery.delivery_id,patches:[patch]});
    assert.equal(refused.state,'conflict');assert.equal(f.batches.length,0);
    const applied=await f.invoke('PaperApplyEditTool',{file:f.file,patches:[patch],verify:true});
    assert.equal(applied.state,'applied',JSON.stringify(applied));assert.equal(f.store.read(f.file).comments.length,0);
});

test('combined apply returns separate outcomes and preserves changed comments or failed verification',async t=>{
    const f=fixture(t),posted=f.add();const delivery=await deliveryFor(f);
    f.compile(async()=>{f.store.update(f.file,posted.id,'A changed reader request');return {ok:true};});
    const applied=await f.invoke('PaperApplyEditTool',{file:f.file,delivery_id:delivery.delivery_id,
        patches:[commentPatch(delivery,'Verified improved paragraph.')],acknowledge:true});
    assert.equal(applied.state,'applied');assert.equal(applied.acknowledgment.state,'comment-changed');
    assert.equal(f.store.read(f.file).comments[0].text,'A changed reader request');
    const next=await f.listen({action:'next',listener_id:delivery.listener_id,wait_seconds:0});
    // The old whole-cell quote is intentionally missing after its rewrite.
    assert.equal(next.comments[0].anchor.status,'exact');
    f.compile(async()=>({ok:true,errors:1}));
    const failed=await f.invoke('PaperApplyEditTool',{file:f.file,delivery_id:next.delivery_id,
        patches:[commentPatch(next,'Another paragraph.')],acknowledge:true});
    assert.equal(failed.state,'rolled-back');assert.equal(failed.acknowledgment.state,'not-consumed');
    assert.equal(failed.verification.latex.ok,false);assert.equal(f.store.read(f.file).comments.length,1);
});

test('combined acknowledgment consumes only patched comments in a multi-comment delivery',async t=>{
    const f=fixture(t);const first=f.add();const last=f.add('Fix the last','Last');
    const start=await f.listen({action:'start',file:f.file,include_existing:true});
    const delivery=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0,max_comments:2});
    const got=await f.invoke('PaperApplyEditTool',{file:f.file,delivery_id:delivery.delivery_id,
        patches:[commentPatch(delivery,'Improved paragraph.')],acknowledge:true});
    assert.equal(got.state,'applied');assert.equal(got.acknowledgment.state,'consumed');
    assert.deepEqual(f.store.read(f.file).comments.map(c=>c.id),[last.id]);assert.notEqual(first.id,last.id);
    const next=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0});
    assert.equal(next.comments.length,1);assert.equal(next.comments[0].id,last.id);
});


test('deliveries expose a reader conflict and long quotes remain fetchable with the full guard',async t=>{
    const f=fixture(t);f.mini('First');f.add();
    const first=await deliveryFor(f);assert.equal(first.comments[0].anchor.status,'user-editing');
    const stopped=await f.listen({action:'stop',listener_id:first.listener_id});assert.equal(stopped.state,'stopped');
    const long=('First unique long quote '+('long source words '.repeat(600))).trimEnd();
    f.doc.set(PAPER.replace(f.paragraph('First').text,long));
    for(const old of f.store.read(f.file).comments)f.store.delete(f.file,old.id);f.add();
    const delivery=await deliveryFor(f),c=delivery.comments[0];
    assert.equal(c.quote.length,8000);assert.equal(c.quoteTruncated,true);assert.equal(c.anchor.editable_span.truncated,true);
    const tail=await f.listen({...c.anchor.context_handle,offset:8000,limit:8000});
    assert.equal(tail.anchor.editable_span.text,long.slice(8000));assert.equal(tail.anchor.editable_span.truncated,false);
    assert.equal(tail.anchor.editable_span.source_hash,c.anchor.editable_span.source_hash);
});

test('compact delivery keeps exact guards once and retrieves omitted context in a bounded batch',async t=>{
    const f=fixture(t);f.add();f.add('Fix the last','Last');
    const start=await f.listen({action:'start',file:f.file,include_existing:true});
    const full=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0,max_comments:2});
    const compact=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0,projection:'compact'});
    assert.equal(compact.delivery_id,full.delivery_id);
    assert.equal(compact.document_hash,full.document_hash);
    for(let i=0;i<compact.comments.length;i++) {
        const a=compact.comments[i], b=full.comments[i];
        assert.equal(a.anchor.editable_span.source_hash,b.anchor.editable_span.source_hash);
        assert.equal(a.object.sourceHash,b.object.sourceHash);
        assert.equal(a.object.stableKey,b.object.stableKey);
        for(const key of ['quote','selection','author','next'])assert.equal(Object.hasOwn(a,key),false);
        assert.equal(a.anchor.context,undefined);assert.equal(a.object.text,undefined);
    }
    assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length);
    const context=await f.listen({action:'context',listener_id:start.listener_id,delivery_id:full.delivery_id,
        comment_ids:compact.comments.map(c=>c.id),limit:16});
    assert.equal(context.contexts.length,2);
    assert.ok(context.contexts.reduce((n,c)=>n+c.anchor.editable_span.text.length,0)<=16);
    assert.equal(context.contexts[0].anchor.editable_span.source_hash,compact.comments[0].anchor.editable_span.source_hash);
    assert.equal((await f.listen({action:'context',listener_id:start.listener_id,delivery_id:full.delivery_id,
        comment_ids:['unrelated']})).state,'not-found');
});

test('compact long delivery flags truncation without losing hash or context capability',async t=>{
    const f=fixture(t),long='First unique '+('words '.repeat(1600));
    f.doc.set(PAPER.replace(f.paragraph('First').text,long));f.add();
    const start=await f.listen({action:'start',file:f.file,include_existing:true});
    const d=await f.listen({action:'next',listener_id:start.listener_id,wait_seconds:0,projection:'compact'});
    const c=d.comments[0];assert.equal(c.anchor.editable_span.text.length,2000);
    assert.equal(c.anchor.editable_span.truncated,true);
    const context=await f.listen({...c.anchor.context_handle,limit:8000});
    assert.equal(context.anchor.editable_span.text,long.slice(0,8000));
    assert.equal(context.anchor.editable_span.source_hash,c.anchor.editable_span.source_hash);
});

test('owning session recovers outstanding delivery without exposing another session capability',async t=>{
    const f=fixture(t);f.add();
    const s=await f.inbox.start(f.file,true,'codex','owner-session');
    const d=await f.inbox.next(s.listener_id,{waitSeconds:0});
    const own=await f.inbox.start(f.file,true,'codex','owner-session');
    assert.equal(own.listener_id,s.listener_id);assert.equal(own.delivery_id,d.delivery_id);
    assert.deepEqual(own.comment_ids,d.comments.map(c=>c.id));assert.equal(own.wakeup,undefined);
    const foreign=await f.inbox.start(f.file,true,'codex','another-session');
    assert.equal(foreign.listener_id,undefined);assert.equal(foreign.delivery_id,undefined);
    assert.equal((await f.inbox.next(s.listener_id,{waitSeconds:0})).delivery_id,d.delivery_id);
    assert.deepEqual(await f.inbox.next(s.listener_id,{waitSeconds:300,token:{isCancellationRequested:true}}),
        {state:'cancelled',listener_id:s.listener_id,file:f.file});
    assert.equal(f.store.read(f.file).comments.length,1);
});

test('verified ack retries are idempotent and never consume a new reader comment',async t=>{
    const f=fixture(t);f.add();const delivery=await deliveryFor(f);
    const applied=await f.invoke('PaperApplyEditTool',{file:f.file,delivery_id:delivery.delivery_id,
        patches:[commentPatch(delivery,'First revised paragraph.')],acknowledge:true});
    assert.equal(applied.acknowledgment.ok,true);f.add('A new request');
    const retry=await f.listen({action:'ack',listener_id:delivery.listener_id,
        delivery_id:delivery.delivery_id,operation_id:applied.operation_id});
    assert.equal(retry.replayed,true);assert.equal(retry.operation_id,applied.operation_id);
    assert.equal(f.store.read(f.file).comments.length,1);
    const wrong=await f.listen({action:'ack',listener_id:delivery.listener_id,
        delivery_id:delivery.delivery_id,operation_id:'wrong-operation'});
    assert.match(wrong.error,/Unknown or expired delivery/);
    assert.equal(f.store.read(f.file).comments.length,1);
});

test('multi-object reads use one snapshot and bound total source',async t=>{
    const f=fixture(t),selectors=['First','Last'].map(w=>f.paragraph(w).stableKey);
    const got=await f.invoke('PaperGetObjectTool',{file:f.file,selectors,max_chars:20});
    assert.equal(got.objects.length,2);assert.equal(got.buffer_version,f.doc.version);
    assert.ok(got.objects.reduce((n,o)=>n+o.text.length,0)<=20);
    assert.ok(got.objects.every(o=>o.textTruncated && o.sourceHash));
    assert.match((await f.invoke('PaperGetObjectTool',{file:f.file,selectors:Array(11).fill(selectors[0])})).error,/1–10/);
    assert.match((await f.invoke('PaperGetObjectTool',{file:f.file,selectors,reveal:true})).error,/reveal/);
    assert.equal(f.batches.length,0);assert.equal(f.compiles.length,0);
});
