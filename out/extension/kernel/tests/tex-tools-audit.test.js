'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const {makeVscodeStub} = require('./_stub-vscode');
const {onAgentEdit} = require('../../tex/reviewBus');
const PAPER = String.raw`\documentclass{article}
\usepackage{amsmath,cleveref}
\begin{document}
\section{Alpha}\label{sec:a}

First paragraph with enough ordinary prose to be a complete addressable object.

\begin{equation}\label{eq:a}a=1\end{equation}

Second paragraph with enough ordinary prose to be a complete addressable object.

\begin{equation}\label{eq:b}b=2\end{equation}
\section{Beta}\label{sec:b}

Final paragraph with enough ordinary prose to be a complete addressable object.

\end{document}
`;
function fixture(t, source = PAPER) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-audit-'));
    t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
    const docs = [], edits = [], compiles = [], events = [];
    let compileHook, applyHook, saveReturn = true;
    const add = (name, initial) => {
        const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, initial);
        let value = initial, version = 1;
        const doc = {uri:{fsPath:file}, languageId:'latex', getText:() => value,
            get version() {return version;}, get isDirty() {return value !== fs.readFileSync(file, 'utf8');},
            positionAt:off => {const lines = value.slice(0, off).split('\n'); return {line:lines.length-1, character:lines.at(-1).length};},
            offsetAt:pos => value.split('\n').slice(0,pos.line).reduce((n,s) => n+s.length+1,0)+pos.character,
            async save() {if (saveReturn) fs.writeFileSync(file, value); return saveReturn;},
            set(text) {value = text; version++;},
            replace(range, text) {const a = this.offsetAt(range.start), b = this.offsetAt(range.end); value=value.slice(0,a)+text+value.slice(b);version++;}};
        docs.push(doc); return doc;
    };
    const doc = add('main.tex', source);
    const stub = makeVscodeStub();
    stub.Range = class {constructor(start,end) {Object.assign(this,{start,end});}};
    stub.Selection = stub.Range;
    stub.WorkspaceEdit = class {constructor() {this.items=[];} replace(uri,range,text) {this.items.push({uri,range,text});}};
    stub.workspace.textDocuments=docs;stub.workspace.workspaceFolders=[{uri:{fsPath:dir}}];
    stub.workspace.fs={readFile:async uri => fs.readFileSync(uri.fsPath)};
    stub.workspace.openTextDocument=async uri => docs.find(d => d.uri.fsPath === uri.fsPath);
    stub.workspace.applyEdit=async we => {if (applyHook && !await applyHook(we)) return false;
        // VS Code interprets all ranges against the pre-edit buffer, then
        // applies disjoint replacements as one undoable WorkspaceEdit.
        const ordered=[...we.items].sort((a,b) => docs.find(d => d.uri.fsPath===b.uri.fsPath).offsetAt(b.range.start)-
            docs.find(d => d.uri.fsPath===a.uri.fsPath).offsetAt(a.range.start));
        for (const item of ordered) {docs.find(d => d.uri.fsPath===item.uri.fsPath).replace(item.range,item.text);edits.push(item);}return true;};
    stub.window.showTextDocument=async () => {throw Error('unexpected editor reveal');};
    const load = Module._load;
    Module._load=function(request,...args) {
        if(request==='vscode') return stub;
        if(request==='../tex/compileService') return {compile:async opts => {compiles.push(opts);
            return compileHook ? compileHook(opts) : {ok:true, engine:opts.engine, errors:0, diagnostics:[]};}};
        return load.call(this,request,...args);
    };
    let tools;
    try {delete require.cache[require.resolve('../../tools/tex-tools')];tools=require('../../tools/tex-tools');}
    finally {Module._load=load;}
    const sub=onAgentEdit(e => events.push(e));t.after(() => sub.dispose());
    const invoke=async (name,input={}) => {const r=await new tools[name]().invoke({input:{file:doc.uri.fsPath,...input}});
        const text=r.content.map(p=>p.value).join('');try{return JSON.parse(text);}catch{return {error:text};}};
    return {dir,doc,docs,tools,edits,compiles,events,stub,add,invoke,
        compile:fn=>{compileHook=fn;}, apply:fn=>{applyHook=fn;}, saveResult:v=>{saveReturn=v;}};
}
const equation = (name,value) => `\\begin{equation}\\label{${name}}${value}\\end{equation}`;

test('all six readers and edit preview preserve buffer, disk, editor focus and compile state', async t => {
    const f=fixture(t), baseline=f.doc.getText(), disk=fs.readFileSync(f.doc.uri.fsPath);
    for(const [tool,input] of [
        ['PaperGetOutlineTool',{mode:'objects',include_project:true}],['PaperGetObjectTool',{selector:'eq:a'}],
        ['PaperGetSectionTool',{selector:'Alpha',include_text:true}],['PaperFindReferencesTool',{include_project:true}],
        ['PaperSearchTool',{queries:[{query:'paragraph'},{label_prefix:'eq:'}],include_project:true}],
        ['PaperMathematicaBlocksTool',{include_code:true}],['PaperPreviewEditTool',{selector:'eq:a',new_text:equation('eq:a','a=3')}]
    ]) {const out=await f.invoke(tool,input);assert.equal(out.error,undefined,tool);assert.equal(f.doc.getText(),baseline,tool);}
    assert.deepEqual(fs.readFileSync(f.doc.uri.fsPath),disk);assert.equal(f.edits.length,0);assert.equal(f.compiles.length,0);assert.equal(f.events.length,0);
});

test('absolute and workspace-relative paths never fall back to an unrelated open basename', async t => {
    const f=fixture(t);const target=path.join(f.dir,'other/main.tex');fs.mkdirSync(path.dirname(target));fs.writeFileSync(target,PAPER.replace('Alpha','Correct file'));
    const out=await f.invoke('PaperGetOutlineTool',{file:target});assert.equal(out.outline[0].title,'Correct file');
    const relative=await f.invoke('PaperGetOutlineTool',{file:'other/main.tex'});assert.equal(relative.outline[0].title,'Correct file');
    assert.match((await f.invoke('PaperGetOutlineTool',{file:path.join(f.dir,'missing/main.tex')})).error,/no .tex document/);
});

test('large objects return complete hashes, exact excerpts and an explicit truncation flag', async t => {
    const long=equation('eq:a',Array(1600).fill('a+').join('')+'1'+ '\n% '+ 'tail'.repeat(1200)+'\n');
    const f=fixture(t,PAPER.replace(equation('eq:a','a=1'),long));
    const clipped=await f.invoke('PaperGetObjectTool',{selector:'eq:a',max_chars:100});
    assert.equal(clipped.text,long.slice(0,100));assert.equal(clipped.textTruncated,true);assert.equal(clipped.sourceChars,long.length);
    const full=await f.invoke('PaperGetObjectTool',{selector:'eq:a',max_chars:20000});
    assert.equal(full.text,long);assert.equal(full.textTruncated,false);
    const crypto=require('node:crypto');assert.equal(full.sourceHash,crypto.createHash('sha256').update(long).digest('hex'));
    const next=long.replace('a+', 'b+');
    const applied=await f.invoke('PaperApplyEditTool',{selector:'eq:a',expected_source_hash:full.sourceHash,new_text:next});
    assert.equal(applied.applied,true);assert.ok(f.doc.getText().includes(next));
});

test('append to the last section stays before the real document end, ignoring inline verbatim', async t => {
    const f=fixture(t,PAPER.replace('Final paragraph',String.raw`Literal \verb|\end{document}\label{fake}| and final paragraph`));
    const p=await f.invoke('PaperPreviewEditTool',{edits:[{operation:'append_to_section',selector:'sec:b',new_text:'New concluding prose.'}]});
    assert.ok(p.transaction_id,JSON.stringify(p));
    const r=await f.invoke('PaperApplyEditTool',{transaction_id:p.transaction_id});assert.equal(r.applied,true);
    assert.ok(f.doc.getText().indexOf('New concluding prose.')<f.doc.getText().lastIndexOf('\\end{document}'));
    const refs=await f.invoke('PaperFindReferencesTool');assert.equal(refs.labels,4,'literal label is inert');
});

test('renames update starred, page and multiple cleveref references without touching verbatim or comments', async t => {
    const extra=String.raw`See \eqref{eq:a}, \ref*{eq:a}, \pageref{eq:a}, \cref{eq:a, eq:b} and \Cref{eq:a,eq:a}.
% keep \ref{eq:a}
Literal \verb|\ref{eq:a}| remains.
`;
    const f=fixture(t,PAPER.replace('\\section{Beta}',extra+'\\section{Beta}'));
    const r=await f.invoke('PaperApplyEditTool',{edits:[{operation:'rename_label',old:'eq:a',new:'eq:renamed'}]});
    assert.equal(r.applied,true,JSON.stringify(r));
    assert.ok(f.doc.getText().includes('\\cref{eq:renamed, eq:b}'));
    assert.ok(f.doc.getText().includes('\\Cref{eq:renamed,eq:renamed}'));
    assert.ok(f.doc.getText().includes('\\verb|\\ref{eq:a}|'));
    assert.ok(f.doc.getText().includes('% keep \\ref{eq:a}'));
    assert.deepEqual((await f.invoke('PaperFindReferencesTool')).unresolvedRefs,[]);
});

test('corrupt JSON control bytes and invalid label keys are refused without writes', async t => {
    const f=fixture(t);
    for(const new_text of ['\begin{equation}', '\frac{1}{2}', '\u0000']) {
        const r=await f.invoke('PaperApplyEditTool',{selector:'eq:a',new_text});assert.equal(r.state,'invalid');
    }
    for(const name of ['x}\\bad{','x%comment','x,y','x y']) {
        const r=await f.invoke('PaperPreviewEditTool',{edits:[{operation:'rename_label',old:'eq:a',new:name}]});assert.equal(r.state,'invalid');
    }
    assert.equal(f.edits.length,0);assert.equal(f.doc.getText(),PAPER);
});

test('deleting or replacing a multi-label alignment refuses to strand any label', async t => {
    const align=String.raw`\begin{align} a&=1\label{eq:first}\\ b&=2\label{eq:last}\end{align}`;
    const f=fixture(t,PAPER.replace(equation('eq:a','a=1'),align+'\nSee \\eqref{eq:first}.'));
    for(const edit of [{operation:'delete',selector:'eq:last'}, {operation:'replace',selector:'eq:last',new_text:equation('eq:new','x=1')}]) {
        const r=await f.invoke('PaperPreviewEditTool',{edits:[edit]});assert.equal(r.state,'conflict',JSON.stringify(r));assert.match(r.reason,/eq:first/);
    }
    assert.equal(f.edits.length,0);
});

test('unsaved include graph participates in rename collision and inbound-reference guards', async t => {
    const f=fixture(t);const child=f.add('child.tex','See \\eqref{eq:a}.\n');
    f.doc.set(PAPER.replace('\\end{document}','\\input{child}\n\\end{document}'));
    const r=await f.invoke('PaperPreviewEditTool',{edits:[{operation:'rename_label',old:'eq:a',new:'eq:new'}]});
    assert.equal(r.state,'cross-file-required');assert.equal(r.locations[0].file,child.uri.fsPath);
});

test('verify true compiles with the paper engine and rolls back actual compile failures', async t => {
    const f=fixture(t,'% !TEX program = xelatex\n'+PAPER);
    f.compile(opts => {assert.equal(opts.engine,'xelatex');assert.ok(opts.overlay.get(f.doc.uri.fsPath).includes('\\undefinedAuditCommand'));
        return {ok:false, errors:1, diagnostics:[{severity:'error',message:'Undefined control sequence'}]};});
    const before=f.doc.getText();
    const r=await f.invoke('PaperApplyEditTool',{selector:'eq:a',new_text:equation('eq:a','\\undefinedAuditCommand'),verify:true,save:true});
    assert.equal(r.applied,false);assert.equal(r.rolledBack,true);assert.equal(r.saved,false);assert.equal(f.compiles.length,1);assert.equal(f.doc.getText(),before);
});

test('default verification rolls back structural errors; verification exceptions also restore the buffer', async t => {
    const f=fixture(t);
    let r=await f.invoke('PaperApplyEditTool',{selector:'eq:a',new_text:'\\begin{equation}broken'});
    assert.equal(r.rolledBack,true);assert.equal(f.doc.getText(),PAPER);
    f.compile(() => {throw Error('compiler unavailable');});
    r=await f.invoke('PaperApplyEditTool',{selector:'eq:a',new_text:equation('eq:a','a=9'),verify:true});
    assert.equal(r.rolledBack,true);assert.equal(f.doc.getText(),PAPER);assert.match(r.verification.error,/compiler unavailable/);
    assert.deepEqual(f.events.map(e=>e.phase),['begin','end','begin','end','begin','end','begin','end']);
});

test('rollback and saving never overwrite newer edits made during verification', async t => {
    const f=fixture(t);
    f.compile(() => {assert.equal(f.events.at(-1).phase,'end', 'agent attribution ends before waiting for the compiler');f.doc.set(f.doc.getText()+'% USER TYPED THIS\n');return {ok:false,errors:1};});
    const r=await f.invoke('PaperApplyEditTool',{selector:'eq:a',new_text:equation('eq:a','a=9'),verify:true,save:true});
    assert.equal(r.source_conflict,true);assert.equal(r.rolledBack,undefined);assert.equal(r.saved,false);
    assert.ok(f.doc.getText().endsWith('% USER TYPED THIS\n'));assert.equal(fs.readFileSync(f.doc.uri.fsPath,'utf8'),PAPER);
    const undo=await f.invoke('PaperApplyEditTool',{action:'undo',undo_token:r.undo_token});assert.equal(undo.state,'conflict');
});

test('saving detects external disk edits during compile and reports a rejected save truthfully', async t => {
    const f=fixture(t);
    f.compile(() => {fs.writeFileSync(f.doc.uri.fsPath,PAPER+'% EXTERNAL\n');return {ok:true,errors:0};});
    const r=await f.invoke('PaperApplyEditTool',{selector:'eq:a',new_text:equation('eq:a','a=9'),verify:true,save:true});
    assert.equal(r.saved,false);assert.equal(r.source_conflict,true);assert.ok(fs.readFileSync(f.doc.uri.fsPath,'utf8').endsWith('% EXTERNAL\n'));
    fs.writeFileSync(f.doc.uri.fsPath,f.doc.getText());f.compile(()=>({ok:true}));f.saveResult(false);
    const r2=await f.invoke('PaperApplyEditTool',{selector:'eq:a',new_text:equation('eq:a','a=8'),save:true});assert.equal(r2.saved,false);
});

test('two concurrent apply calls serialize and reject a transaction consumed by the first', async t => {
    const f=fixture(t);let release,started;const held=new Promise(r=>release=r), entered=new Promise(r=>started=r);
    f.compile(async()=>{started();await held;return {ok:true};});
    const p=await f.invoke('PaperPreviewEditTool',{selector:'eq:a',new_text:equation('eq:a','a=7'),verify:true});
    const a=f.invoke('PaperApplyEditTool',{transaction_id:p.transaction_id});await entered;
    const b=f.invoke('PaperApplyEditTool',{transaction_id:p.transaction_id});release();
    assert.equal((await a).applied,true);assert.equal((await b).state,'not-found');assert.equal(f.edits.length,1);
});

test('rejected editor edits always release review attribution and write locks', async t => {
    const f=fixture(t);f.apply(()=>false);
    const rejected=await f.invoke('PaperApplyEditTool',{selector:'eq:a',new_text:equation('eq:a','a=7')});
    assert.equal(rejected.state,'conflict');assert.match(rejected.reason,/rejected/);
    assert.equal(rejected.buffer_version,f.doc.version);assert.ok(rejected.document_hash);
    assert.equal(rejected.ranges.length,1);assert.equal(rejected.ranges[0].current_source,equation('eq:a','a=1'));
    assert.equal(f.doc.getText(),PAPER);
    assert.deepEqual(f.events.map(e=>e.phase),['begin','end']);
    f.apply(()=>true);assert.equal((await f.invoke('PaperApplyEditTool',{selector:'eq:a',new_text:equation('eq:a','a=8')})).applied,true);
});

const {spawnSync} = require('node:child_process');
test('all nine edit operations produce LaTeX that compiles on isolated fixtures', async t => {
    const f=fixture(t);const paragraphs=f.tools.projectionOf(f.doc.uri.fsPath,PAPER).model.objects.filter(o=>o.kind==='paragraph');
    const operations=[
        {operation:'replace',selector:'eq:a',new_text:equation('eq:a','a=5')},
        {operation:'insert_before',selector:'eq:a',new_text:'Inserted prose.'},
        {operation:'insert_after',selector:'eq:a',new_text:'Inserted prose.'},
        {operation:'append_to_section',selector:'sec:b',new_text:'Appended prose.'},
        {operation:'delete',selector:'eq:a'},
        {operation:'move_before',selector:paragraphs[1].stableKey,target_selector:paragraphs[0].stableKey},
        {operation:'move_after',selector:paragraphs[0].stableKey,target_selector:paragraphs[1].stableKey},
        {operation:'wrap',selector:paragraphs[0].stableKey,environment:'quote'},
        {operation:'rename_label',old:'eq:a',new:'eq:renamed'}
    ];
    for(const edit of operations) {
        f.doc.set(PAPER);
        const r=await f.invoke('PaperApplyEditTool',{edits:[edit]});assert.equal(r.applied,true,JSON.stringify(r));
        fs.writeFileSync(path.join(f.dir,'verification.tex'),f.doc.getText());
        const compiled=spawnSync('/Library/TeX/texbin/pdflatex',['-interaction=nonstopmode','-halt-on-error','verification.tex'],{cwd:f.dir,encoding:'utf8',timeout:15000});
        assert.equal(compiled.status,0,`${edit.operation}: ${compiled.stdout?.slice(-1500)} ${compiled.error||''}`);
    }
    const history=await f.invoke('PaperApplyEditTool',{action:'history',limit:50});assert.ok(history.entries.length>=9);
});

test('CRLF, Unicode and literal TeX backslashes survive the JSON tool transport and guarded edit', async t => {
    const original=PAPER.replace('First paragraph','Unicode naïve Ω 😀. First paragraph').replace(/\n/g,'\r\n'), f=fixture(t,original);
    const replacement=equation('eq:a',String.raw`\varrho+\bar{x}+\beta+\frac{1}{2}+\tau`);
    const obj=await f.invoke('PaperGetObjectTool',{selector:'eq:a'});
    const payload=JSON.parse(JSON.stringify({selector:'eq:a',new_text:replacement,expected_source_hash:obj.sourceHash}));
    const r=await f.invoke('PaperApplyEditTool',payload);assert.equal(r.applied,true);
    assert.equal(f.doc.getText(),original.replace(equation('eq:a','a=1'),replacement));
});

test('stale transactions and overlapping edits reject without mutation', async t => {
    const f=fixture(t);
    const p=await f.invoke('PaperPreviewEditTool',{selector:'eq:a',new_text:equation('eq:a','a=8')});
    f.doc.set(PAPER+'% user edit\n');
    const r=await f.invoke('PaperApplyEditTool',{transaction_id:p.transaction_id});assert.equal(r.state,'conflict');assert.equal(f.edits.length,0);
    const overlap=await f.invoke('PaperPreviewEditTool',{edits:[{operation:'replace',selector:'eq:a',new_text:equation('eq:a','a=2')},
        {operation:'delete',selector:'eq:a'}]});assert.equal(overlap.state,'conflict');assert.match(overlap.reason,/overlap/);
});

test('macro aliases of multi-target references participate in safe renaming', async t => {
    const f=fixture(t,PAPER.replace('\\begin{document}',String.raw`\newcommand{\refs}[1]{\cref{#1}}
\begin{document}`).replace('\\section{Beta}',String.raw`See \refs{eq:a,eq:b}.
\section{Beta}`));
    const r=await f.invoke('PaperApplyEditTool',{edits:[{operation:'rename_label',old:'eq:a',new:'eq:new'}]});
    assert.equal(r.applied,true,JSON.stringify(r));assert.ok(f.doc.getText().includes('\\refs{eq:new,eq:b}'));
});

test('legacy save/build refuse control-corrupted source or a dirty buffer; compile cannot claim an old PDF as success', async t => {
    const f=fixture(t);
    const load=Module._load;
    let callback;
    Module._load=function(request,...args) {
        if(request==='vscode') return f.stub;
        if(request==='child_process') return {execFile:(_bin,_args,_opts,cb)=>{callback=cb;return {on(){}};}};
        return load.call(this,request,...args);
    };
    try {
        delete require.cache[require.resolve('../../tools/wolfslide-tools')];
        const {SaveLatexTool,CompileLatexTool,LatexTool,GetLatexErrorsTool}=require('../../tools/wolfslide-tools');
        const value=r=>r.content.map(p=>p.value).join('');
        let r=await new LatexTool().invoke({input:{action:'build',path:f.doc.uri.fsPath,content:'\begin{document}'}});
        assert.match(value(r),/^Error:/);assert.equal(callback,undefined);
        assert.equal(fs.readFileSync(f.doc.uri.fsPath,'utf8'),PAPER);
        f.doc.set(PAPER+'% unsaved\n');
        r=await new SaveLatexTool().invoke({input:{path:f.doc.uri.fsPath,content:PAPER+'% overwrite\n'}});
        assert.match(value(r),/unsaved/);assert.equal(fs.readFileSync(f.doc.uri.fsPath,'utf8'),PAPER);
        f.doc.set(PAPER);
        const raw=PAPER.replace('a=1',String.raw`a=\beta+\frac12`);
        r=await new SaveLatexTool().invoke({input:{path:f.doc.uri.fsPath,content:raw}});assert.match(value(r),/^Saved:/);
        assert.equal(fs.readFileSync(f.doc.uri.fsPath,'utf8'),raw);
        fs.writeFileSync(path.join(f.dir,'main.pdf'),'OLD PDF');
        const pending=new CompileLatexTool().invoke({input:{path:f.doc.uri.fsPath}});
        callback({code:1},'! Undefined control sequence','');
        r=await pending;assert.match(value(r),/Compilation failed/);assert.match(value(r),/earlier build/);
        fs.writeFileSync(path.join(f.dir,'main.log'),'! Undefined control sequence.\nl.8 \\wrong\n');
        const source=fs.readFileSync(f.doc.uri.fsPath);
        r=await new GetLatexErrorsTool().invoke({input:{path:f.doc.uri.fsPath}});assert.match(value(r),/Undefined control sequence/);
        assert.deepEqual(fs.readFileSync(f.doc.uri.fsPath),source);
    } finally {Module._load=load;}
});

test('regex searches are bounded away from the extension host and never change paper bytes', async t => {
    const f=fixture(t,PAPER.replace('First paragraph', 'a'.repeat(20000)+'! First paragraph'));
    const source=f.doc.getText();
    const r=await f.invoke('PaperSearchTool',{query:'(a+)+$',regex:true});assert.match(r.error,/exceeded/);
    assert.equal(f.doc.getText(),source);assert.equal(f.edits.length,0);
    const normal=await f.invoke('PaperSearchTool',{query:'paragraph.*ordinary',regex:true});assert.ok(normal.matches>=1);
});

test('guarded undo restores the exact original draft even with pre-existing unresolved references', async t => {
    const before=PAPER.replace('First paragraph', 'See \\ref{already-missing}. First paragraph'), f=fixture(t,before);
    const paragraph=f.tools.projectionOf(f.doc.uri.fsPath,before).model.objects.find(o=>o.kind==='paragraph');
    const changed=await f.invoke('PaperApplyEditTool',{selector:paragraph.stableKey,new_text:'Replacement paragraph with sufficient prose to remain an addressable paragraph.'});
    assert.equal(changed.applied,true);
    const undone=await f.invoke('PaperApplyEditTool',{action:'undo',undo_token:changed.undo_token});
    assert.equal(undone.applied,true);assert.equal(f.doc.getText(),before);
});

test('invalid verification options fail before any buffer mutation', async t => {
    const f=fixture(t);
    const r=await f.invoke('PaperApplyEditTool',{selector:'eq:a',new_text:equation('eq:a','a=7'),verify:'true'});
    assert.match(r.error,/verify must be/);assert.equal(f.edits.length,0);assert.equal(f.events.length,0);
});

test('duplicate-label verification rejects an increased duplicate count but permits reducing it', async t => {
    const source=PAPER.replace('\\section{Beta}',equation('eq:a','a=duplicate')+'\n\\section{Beta}'), f=fixture(t,source);
    const bad=await f.invoke('PaperApplyEditTool',{selector:'eq:b',new_text:equation('eq:a','a=third')});
    assert.equal(bad.rolledBack,true);assert.equal(f.doc.getText(),source);
    const duplicates=f.tools.projectionOf(f.doc.uri.fsPath,source).model.objects.filter(o=>o.kind==='display-equation'&&o.label==='eq:a');
    const good=await f.invoke('PaperApplyEditTool',{edits:[{operation:'delete',selector:duplicates.at(-1).stableKey}]});
    assert.equal(good.applied,true,JSON.stringify(good));
    assert.deepEqual((await f.invoke('PaperFindReferencesTool')).duplicateLabels,[]);
});


test('small guarded patches cannot bypass referenced-label guards even without compilation',async t=>{
    const f=fixture(t,PAPER.replace('Second paragraph','See \\eqref{eq:a}. Second paragraph'));
    const {sha256}=require('../../tex/texModel');
    const result=await f.invoke('PaperApplyEditTool',{patches:[{expected_old_text:'eq:a',
        replacement:'eq:gone',expected_span_hash:sha256('eq:a')}],verify:false});
    assert.equal(result.state,'conflict');assert.equal(f.edits.length,0);
    // A uniquely located declaration substring is still guarded against its inbound ref.
    const exact='label{eq:a}';
    const guarded=await f.invoke('PaperApplyEditTool',{patches:[{expected_old_text:exact,
        replacement:'label{eq:gone}',expected_span_hash:sha256(exact)}],verify:false});
    assert.equal(guarded.state,'conflict');assert.match(guarded.reason,/references remain/);assert.equal(f.edits.length,0);
});
