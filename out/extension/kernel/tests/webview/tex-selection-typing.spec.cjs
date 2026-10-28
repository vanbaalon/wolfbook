'use strict';
const assert=require('node:assert/strict');
const {fixtureTex,fixture}=require('../_selection-typing-fixture.cjs');
async function prepare(t) {
    const a=t.word('Selected'),b=t.word('here.');
    await t.post({type:'inkCaret',page:1,x:10,y:20,h:12});
    const row={page:3,x:a.x,y:a.y,w:b.x1-a.x,h:a.h};
    await t.post({type:'selection',span:{native:true,rows:[row],lines:1,
        start:{rects:[row],exactEdge:{page:3,x:a.x,y:a.y,h:a.h}},
        end:{exactEdge:{page:3,x:b.x1,y:b.y,h:b.h}}},reveal:false});
    await t.waitFor(()=>document.querySelectorAll('.selbrk').length===2,null,{what:'selected sentence'});
    await t.eval(()=>{const main=document.querySelector('main');main.scrollTop=document.querySelector('.page[data-page="3"]').offsetTop-80;main.focus({preventScroll:true});});
    const scroll=await t.eval(()=>document.querySelector('main').scrollTop);
    await t.clear();
    await t.page.keyboard.type('abc');await t.page.keyboard.press('Backspace');await t.page.keyboard.type('d');
    const first=await t.waitPosted('selectionAction');
    assert.equal(first.action,'replace');assert.ok(first.typingRequest);
    assert.equal((await t.posted('selectionAction')).length,1,'following keys buffer during the asynchronous handoff');
    assert.equal((await t.posted('inkKey')).length,0,'the old page-one caret cannot consume the typing');
    return {first,scroll,caret:{page:3,x:a.x,y:a.y,h:a.h}};
}
const tests=[{
    id:'selection-live-typing',name:'typing replaces the viewer selection, continues at its live caret, and keeps the same scroll',
    async run(t) {
        const {first,scroll,caret}=await prepare(t),f=fixture({caret});
        await f.v._selectionAction(first);
        for(const message of f.messages.splice(0))await t.post(message);
        await t.waitFor(()=>window.__posted.filter(m=>m.type==='inkKey').length===4,null,{what:'buffered keys handed to the new caret'});
        const keys=await t.posted('inkKey');assert.deepEqual(keys.map(m=>m.key),['b','c','Backspace','d']);
        for(const key of keys)f.v._inkKey(key);await f.v._inkQueue;
        assert.equal(f.doc.getText(),fixtureTex.replace('Selected sentence here.','abd'));
        assert.equal(await t.eval(()=>document.querySelectorAll('.selbrk').length),0);
        assert.equal(await t.eval(()=>document.querySelector('.inkcaret').closest('.page').dataset.page),'3');
        // A late source-editor echo must not drag the view back to its cursor.
        await t.post({type:'highlight',generation:1,rects:[{page:1,x:10,y:20,w:50,h:12}],reveal:true,exact:true});
        await t.sleep(100);
        t.near(await t.eval(()=>document.querySelector('main').scrollTop),scroll,1,'typing preserves the reader scroll');
        await t.clear();await t.page.keyboard.type('e');
        const next=await t.waitPosted('inkKey');f.v._inkKey(next);await f.v._inkQueue;
        assert.equal(f.doc.getText(),fixtureTex.replace('Selected sentence here.','abde'));
        assert.equal((await t.posted('selectionAction')).length,0);
    },
},{
    id:'selection-standard-typing',name:'standard mode puts all buffered typing into the exact mini-editor selection',
    async run(t) {
        const {first,scroll,caret}=await prepare(t),f=fixture({pro:false,caret});
        await f.v._selectionAction(first);assert.equal(f.edits.length,0);
        for(const message of f.messages.splice(0))await t.post(message);
        await t.waitFor(()=>document.activeElement?.tagName==='TEXTAREA',null,{what:'typing in the mini-editor'});
        const edit=await t.waitPosted('editChange');
        assert.equal(edit.text,'Prefix abd Tail remains.');
        assert.equal(await t.eval(()=>document.querySelector('.ec-editor textarea').value),edit.text);
        t.near(await t.eval(()=>document.querySelector('main').scrollTop),scroll,1,'opening a typing card does not jump the page');
        await t.page.keyboard.type('e');
        await t.waitFor(()=>document.querySelector('.ec-editor textarea').value==='Prefix abde Tail remains.',null,{what:'continued source typing'});
    },
}];
tests.push({id:'selection-buffered-arrows',name:'buffered cursor moves and text edits retain their order in the mini-editor',
    async run(t){
        const {caret}=await prepare(t);
        // prepare buffered abd; move inside it and insert X before the reply.
        await t.page.keyboard.press('ArrowLeft');await t.page.keyboard.type('X');
        const first=await t.waitPosted('selectionAction'),f=fixture({pro:false,caret});
        await f.v._selectionAction(first);for(const m of f.messages.splice(0))await t.post(m);
        await t.waitFor(()=>document.querySelector('.ec-editor textarea')?.value==='Prefix abXd Tail remains.',null,
            {what:'buffered cursor movement retained'});
    }});
module.exports={fixtureTex,tests};
