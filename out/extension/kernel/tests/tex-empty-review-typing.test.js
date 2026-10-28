'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {ReviewSession}=require('../../tex/reviewSession');
const {editImpact}=require('../../tex/renderChange');
const {renderTextKey}=require('../../tex/renderChange');

test('spaces beside an unresolved deletion remain a stable deletion, not an empty replacement',()=>{
    const base='The old paragraph.\n\n\\plan{The old plan.}\n\\paragraph{Which terms to watch}\n';
    let text='The new paragraph.\n\n \n\\paragraph{Which terms to watch}\n';
    const s=new ReviewSession({file:'/main.tex',baseText:base});
    s.noteBatch({source:'paper_applyEdit'});s.update({currentText:text});
    const deletion=s.hunks.find(h=>h.verb==='del');
    assert.ok(deletion);const id=deletion.id;
    for (let i=0;i<8;i++) {
        const at=text.indexOf('\n \n')+2;
        s.noteReaderEdit({offset:at,length:0,text:' '});
        text=text.slice(0,at)+' '+text.slice(at);
        s.update({currentText:text,readerChanges:[{rangeOffset:at,rangeLength:0,text:' '}]});
        assert.equal(s.pendingCount,2);
        assert.ok(s.hunks.some(h=>h.id===id && h.verb==='del'));
        assert.ok(!s.hunks.some(h=>h.verb==='change' && h.changedWords===0));
        assert.ok(!s.edited.has(id),'typing spaces never flags the removed plan as reader-edited');
    }
    assert.match(s.baseText,/old paragraph/,'the unresolved real edit is still unapproved');
    assert.ok(s.keep(id).ok);
    s.update({currentText:text});
    assert.equal(s.pendingCount,1,'the cached comparison cannot resurrect a kept deletion');
});

test('typing words into a removed block still protects the reader from Undo',()=>{
    const s=new ReviewSession({file:'/main.tex',baseText:'Before\nRemoved plan\nAfter'});
    let text='Before\n \nAfter';s.update({currentText:text});
    const at=text.indexOf(' \n')+1;
    s.noteReaderEdit({offset:at,length:0,text:'My new explanation'});
    s.update({currentText:text.slice(0,at)+'My new explanation'+text.slice(at)});
    assert.equal(s.hunks[0].verb,'change');
    assert.equal(s.undoAll().refused.length,1);
});

test('a proven insertion on an already blank line changes no rendered content',()=>{
    const before='Paragraph.\n\nNext paragraph.',at=before.indexOf('\n\n')+1;
    const after=before.slice(0,at)+' '+before.slice(at);
    const c=[{rangeOffset:at,rangeLength:0,text:' '}];
    assert.equal(editImpact(after,c).renderChanged,false);
    assert.equal(editImpact(after,c,before).renderChanged,false);
    assert.equal(editImpact(before, [{rangeOffset:at,rangeLength:1,text:''}],after).renderChanged,false);
});

test('real text, new paragraph breaks and literal spaces require rendering',()=>{
    for (const [before,at,text] of [
        ['Paragraph.',4,' '],
        ['Paragraph.',4,'x'],
        ['Paragraph.',4,'\n\n'],
        ['\\begin{verbatim}\n\n\\end{verbatim}',18,' '],
        ['\\obeyspaces\n\ntext',13,' '],
    ]) {
        const after=before.slice(0,at)+text+before.slice(at);
        assert.equal(editImpact(after,[{rangeOffset:at,rangeLength:0,text}],before).renderChanged,true);
    }
});

test('multiple cursors are inverted using original event offsets',()=>{
    const before='First\n\nSecond\n\nThird', offsets=[6,14];
    const changes=offsets.map(rangeOffset=>({rangeOffset,rangeLength:0,text:' '}));
    let after=before;for (const c of changes.slice().reverse()) after=after.slice(0,c.rangeOffset)+c.text+after.slice(c.rangeOffset);
    const impact=editImpact(after,changes);
    assert.equal(impact.before,before);assert.equal(impact.renderChanged,false);
});

test('rendered correction cache ignores only ordinary blank-line spaces',()=>{
    assert.equal(renderTextKey('Paragraph\n\nNext'),renderTextKey('Paragraph\n   \nNext'));
    assert.notEqual(renderTextKey('Paragraph\n\nNext'),renderTextKey('Paragraph\n\n\nNext'));
    assert.notEqual(renderTextKey('two words'),renderTextKey('twowords'));
    assert.notEqual(renderTextKey('\\begin{verbatim}\n \n\\end{verbatim}'),renderTextKey('\\begin{verbatim}\n  \n\\end{verbatim}'));
});

test('restoring a formerly empty replacement preserves its original author batch',()=>{
    const s=new ReviewSession({file:'/main.tex',baseText:'Before\nRemoved plan\nAfter'});
    s.noteBatch({source:'paper_applyEdit',author:{name:'Original agent'}});
    s.update({currentText:'Before\n \nAfter'});
    const h=s.hunks[0],saved=s.serialize(),batch=s.firstSeen.get(h.id);
    saved.firstSeen=[[h.previousId,batch]];
    const restored=ReviewSession.restore(saved);
    assert.equal(restored.firstSeen.get(restored.hunks[0].id),batch);
    assert.equal(restored.payload().groups[0].author.name,'Original agent');
    assert.equal(restored.hunks[0].verb,'del');
});
