'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,fixtureTex}=require('./_selection-typing-fixture.cjs');

test('typing over a selected sentence establishes live input at the range start, not an older page caret',async()=>{
    const f=fixture();await f.replace('a');await f.keys(['b','c','Backspace','d']);
    assert.equal(f.doc.getText(),fixtureTex.replace('Selected sentence here.','abd'));
    assert.equal(f.v._ink.offset,f.start+3);assert.equal(f.v._ink.version,f.doc.version);
    assert.equal(f.v._ink.caret.page,3);assert.equal(f.v._inkMap,null);
    assert.equal(f.v._reviewNavigation.owner,'viewer');assert.equal(f.v._lastSelection,null);
    assert.ok(f.messages.some(m=>m.type==='inkCaret' && m.typingRequest===1));
    assert.equal(f.messages.some(m=>m.type==='highlight' && m.reveal),false);
});
test('a replacement is undoable including its removed text and typed TeX characters remain escaped',async()=>{
    const f=fixture();await f.replace('%');assert.ok(f.doc.getText().includes('Prefix \\% Tail remains.'));
    await f.keys(['undo']);assert.equal(f.doc.getText(),fixtureTex);
    await f.keys(['redo']);assert.ok(f.doc.getText().includes('Prefix \\% Tail remains.'));
});
test('late keys for a replaced typing session cannot reach another source caret',async()=>{
    const f=fixture();await f.replace('a');await f.keys(['z'],999);
    assert.equal(f.doc.getText(),fixtureTex.replace('Selected sentence here.','a'));
});
test('standard mode hands the exact selection to the mini-editor before modifying any source',async()=>{
    const f=fixture({pro:false});await f.replace('a');
    assert.equal(f.doc.getText(),fixtureTex);assert.equal(f.edits.length,0);
    const open=f.messages.find(m=>m.type==='editOpen'),select=f.messages.find(m=>m.type==='editSelect');
    assert.ok(open?.selectionTyping);assert.equal(open.typingRequest,1);
    assert.equal(open.text.slice(select.start,select.end),'Selected sentence here.');
    assert.equal(select.typingRequest,1);assert.equal(f.v._ink,null);
});
test('a rejected edit reports handoff failure and never creates a live caret',async()=>{
    const f=fixture({reject:true});await f.replace();
    assert.equal(f.doc.getText(),fixtureTex);assert.equal(f.v._ink,null);
    assert.ok(f.messages.some(m=>m.type==='selectionTypingFailed' && m.typingRequest===1));
});
test('cancel during source lookup preserves the selection text and blocks a late typing caret',async()=>{
    const f=fixture();let resolve;
    f.v._selectionTarget=()=>new Promise(r=>{resolve=r;});
    const pending=f.replace('a');
    await f.v._onMessage({type:'selectionTypingCancel',typingRequest:1});
    resolve({doc:f.doc,range:new f.stub.Range(f.doc.positionAt(f.start),f.doc.positionAt(f.end)),
        sel:{file:f.doc.uri.fsPath,start:f.doc.positionAt(f.start),end:f.doc.positionAt(f.end)}});
    await pending;assert.equal(f.doc.getText(),fixtureTex);assert.equal(f.edits.length,0);assert.equal(f.v._ink,null);
    assert.equal(f.messages.some(m=>m.type==='inkCaret' && m.typingRequest===1),false);
});
