'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {ReviewSession}=require('../../tex/reviewSession');
const {ReviewStore}=require('../../tex/reviewStore');

test('approval removes just the decided hunk without diffing or remapping unchanged source',()=>{
    const base='First old paragraph.\n\nSecond old paragraph.\n\nThird old paragraph.\n';
    const current=base.replace('First old','First new\nAn inserted line.\nFirst other')
        .replace('Second old','Second new').replace('Third old','Third new');
    let mapCalls=0;const map={generation:42,rowsFor:line=>{mapCalls++;return [{page:1,x:72,y:line*10,w:100,h:10}];}};
    const s=new ReviewSession({file:'/paper.tex',baseText:base});s.update({currentText:current,map});
    assert.equal(s.hunks.length,3);const [first,second,third]=s.hunks,rows=third.rects,ids=s.hunks.map(h=>h.id),before=mapCalls;
    s.keep(first.id);
    assert.equal(mapCalls,before);assert.equal(s.generation,42);assert.equal(s._lastText,current);
    assert.equal(s._lastBaseText,s.baseText);assert.deepEqual(s.hunks.map(h=>h.id),ids.slice(1));
    assert.equal(s.hunks[1].rects,rows,'unchanged ink retains its existing placement');
    assert.equal(s.hunks[0].theirRange.startLine,second.ourRange.startLine,'remaining baseline ranges shift after the insertion');
    assert.equal(s.undo(third.id).edits[0].lines.join('\n'),'Third old paragraph.');
    s.keep(second.id);assert.equal(s.pendingCount,1);s.keep(third.id);
    assert.equal(s.pendingCount,0);assert.equal(s.baseText,current);assert.equal(s.summary.total,0);
});

test('large histories use immutable snapshots and a small mutable decision record',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-approve-large-'));
    try {
        const file='/paper/main.tex',a='A long paper paragraph.\n'.repeat(20000),b=a+'A changed ending.\n';
        const session={baseText:a,lastText:b,arrivals:Array.from({length:20},(_,i)=>({at:i,source:'agent',before:a,after:b})),decided:[]};
        const store=new ReviewStore(dir);store.save({file,session});
        const state=path.join(dir,store._key(file)+'.json'),snapshots=store._snapshotDirectory(file);
        assert.equal(fs.readdirSync(snapshots).length,2,'identical arrival texts are stored once');
        assert.ok(fs.statSync(state).size<a.length*3,'decision state excludes the repeated full history');
        const names=fs.readdirSync(snapshots),stamps=names.map(n=>fs.statSync(path.join(snapshots,n)).mtimeMs);
        const reload=new ReviewStore(dir),record=reload.load([file])[0];
        record.session.decided.push({id:'approved',action:'kept'});
        reload._text=()=>{throw Error('approval must not read old history snapshots');};
        reload._snapshot=()=>{throw Error('approval must not write old history snapshots');};
        reload.save(record);
        assert.deepEqual(names.map(n=>fs.statSync(path.join(snapshots,n)).mtimeMs),stamps);
        const final=new ReviewStore(dir).load([file])[0];
        assert.equal(final.session.decided[0].id,'approved');assert.equal(final.session.arrivals.length,20);
        assert.equal(final.session.arrivals[3].before,a);assert.equal(final.session.arrivals[19].after,b);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('legacy review histories migrate once on load with source, authors and approvals preserved',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-approve-legacy-'));
    try {
        const store=new ReviewStore(dir),file='/paper.tex',state=path.join(dir,store._key(file)+'.json');
        fs.writeFileSync(state,JSON.stringify({version:1,file,session:{baseText:'new',lastText:'new',decided:[{id:'kept'}],
            arrivals:[{at:1,author:{name:'Agent'},before:'old',after:'new'}]}}));
        const loaded=store.load([file])[0];assert.equal(store.errors.length,0);
        assert.equal(JSON.parse(fs.readFileSync(state)).version,2);assert.equal(loaded.session.baseText,'new');
        assert.equal(fs.existsSync(state+'.v1'),false,'discarded history is not retained in a second giant file');
        assert.equal(loaded.session.arrivals[0].before,'old');assert.equal(loaded.session.arrivals[0].after,'new');
        assert.equal(loaded.session.arrivals[0].author.name,'Agent');assert.equal(loaded.session.decided[0].id,'kept');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('history snapshots preserve incomplete UTF-16 and reject corrupted immutable text',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-approve-unicode-'));
    try {
        const store=new ReviewStore(dir),file='/paper.tex',a='A\uD800',b='B\uD801';
        store.save({file,session:{baseText:b,lastText:b,arrivals:[{before:a,after:b}]}});
        const loaded=new ReviewStore(dir).load([file])[0];
        assert.equal(loaded.session.arrivals[0].before,a);assert.equal(loaded.session.arrivals[0].after,b);
        const record=JSON.parse(fs.readFileSync(path.join(dir,store._key(file)+'.json')));
        fs.writeFileSync(path.join(store._snapshotDirectory(file),record.session.arrivals[0].beforeRef+'.json'),'"corrupted"');
        assert.throws(()=>new ReviewStore(dir).load([file])[0].session.arrivals[0].before,/damaged/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('default retention keeps the newest 20 versions without altering active review state',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-history-limit-'));
    try {
        const store=new ReviewStore(dir),file='/bounded.tex',state=path.join(dir,store._key(file)+'.json');
        const session={baseText:'approved',lastText:'pending source',decided:[{id:'approved-id'}],
            feedback:[{comment:'Keep this feedback'}],edited:['reader-hunk'],firstSeen:[['pending','batch']],
            arrivals:Array.from({length:50},(_,i)=>({at:i,before:'before '+i,after:'after '+i}))};
        fs.writeFileSync(state,JSON.stringify({version:1,file,session}));
        const loaded=store.load([file])[0];
        assert.equal(loaded.session.arrivals.length,20);assert.equal(loaded.session.arrivals[0].at,30);
        for (const key of ['baseText','lastText','decided','feedback','edited','firstSeen']) assert.deepEqual(loaded.session[key],session[key]);
        const expected=session.arrivals.slice(-20);
        assert.deepEqual(loaded.session.arrivals.map(a=>[a.before,a.after]),expected.map(a=>[a.before,a.after]));
        assert.equal(fs.readdirSync(store._snapshotDirectory(file)).length,40,'discarded versions never create snapshots');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('byte budget and disabled history reclaim snapshots while preserving another paper',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-history-budget-'));
    try {
        const file='/budget.tex',other='/other.tex',store=new ReviewStore(dir,{historyLimit:100,historyMaxMB:1});
        const arrivals=Array.from({length:8},(_,i)=>({at:i,before:String(i)+'a'.repeat(200000),after:String(i)+'b'.repeat(200000)}));
        store.save({file,session:{baseText:'approved',lastText:'pending',decided:[{id:'keep'}],arrivals}});
        store.save({file:other,session:{baseText:'other',arrivals:[{before:'x',after:'y'}]}});
        const record=store.load([file])[0];assert.deepEqual(record.session.arrivals.map(a=>a.at),[6,7]);
        const bytes=fs.readdirSync(store._snapshotDirectory(file)).reduce((sum,n)=>sum+fs.statSync(path.join(store._snapshotDirectory(file),n)).size,0);
        assert.ok(bytes<=1024*1024);
        const disabled=new ReviewStore(dir,{historyLimit:0});
        const trimmed=disabled.load([file])[0];assert.equal(trimmed.session.arrivals.length,0);
        assert.equal(trimmed.session.baseText,'approved');assert.equal(trimmed.session.lastText,'pending');assert.equal(trimmed.session.decided[0].id,'keep');
        assert.deepEqual(fs.readdirSync(store._snapshotDirectory(file)),[]);
        assert.equal(new ReviewStore(dir).load([other])[0].session.arrivals[0].after,'y');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('retention follows user limits in memory and refuses a conflicting writer without deleting history',()=>{
    const s=new ReviewSession({baseText:'baseline',historyLimit:3});
    for(let i=0;i<10;i++)s.recordArrival({text:'version '+i,at:i+1});
    assert.deepEqual(s.arrivals.map(a=>a.after),['version 7','version 8','version 9']);assert.equal(s.baseText,'baseline');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-history-lock-'));
    try {
        const store=new ReviewStore(dir),file='/locked.tex';
        store.save({file,session:{baseText:'base',arrivals:[{before:'old',after:'new'}]}});
        const record=store.load([file])[0],lock=path.join(dir,store._key(file)+'.lock');
        fs.writeFileSync(lock,String(process.pid));
        const result=store.save(record);assert.ok(result.conflict);assert.equal(result.conflict.session.arrivals[0].before,'old');
        fs.unlinkSync(lock);
        assert.equal(store.save(record).saved,true);
        fs.writeFileSync(lock,'');fs.utimesSync(lock,new Date(0),new Date(0));
        assert.equal(store.save(record).saved,true,'an abandoned empty lock must not permanently block approvals');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('disabling historical versions leaves pending corrections reviewable after reload',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-history-pending-'));
    try {
        const file='/pending.tex',s=new ReviewSession({file,baseText:'Original first paragraph.\n\nOriginal second paragraph.'});
        const current='Changed first paragraph.\n\nChanged second paragraph.';
        s.recordArrival({text:current});s.update({currentText:current});
        s.keep(s.hunks[0].id);
        const pending=s.hunks[0].id,baseline=s.baseText;
        const store=new ReviewStore(dir,{historyLimit:0});store.save({file,session:s.serialize()});
        const restored=ReviewSession.restore(store.load([file])[0].session,{historyLimit:0});
        assert.equal(restored.arrivals.length,0);assert.equal(restored.baseText,baseline);
        assert.equal(restored.hunks.length,1);assert.equal(restored.hunks[0].id,pending);
        assert.equal(restored.undo(pending).edits[0].lines.join('\n'),'Original second paragraph.');
        restored.keep(pending);assert.equal(restored.baseText,current);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
