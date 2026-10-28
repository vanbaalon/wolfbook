'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {withVscodeStub,makeVscodeStub}=require('./_stub-vscode');
const {WolframMCPServer}=withVscodeStub(()=>require('../../claude-mcp/server'),makeVscodeStub());
const {McpResultStore}=require('../../claude-mcp/result-store');
const result=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
function server() {
    const s=new WolframMCPServer(new Map(),[],{boundedResults:true,resultThreshold:4096});
    s._sessionProtocol.set('modern','2025-06-18');return s;
}
const inventory=Array.from({length:800},(_,i)=>({name:`eq:unchanged-${i}`,line:i+1}));

test('large verified receipts keep mutation IDs and verification outside truncation; full details remain fetchable',()=>{
    const s=server();
    for(const state of ['applied','rolled-back','source-changed-during-verification']) {
        const data={state,applied:state==='applied',transaction_id:'tx',operation_id:'op',undo_token:state==='applied'?'undo':null,
            saved:state==='applied',source_conflict:state.includes('source-changed'),
            verification:{ok:state==='applied',references:{ok:true,unresolved:{introduced:[],resolved:[]},
                duplicates:{introduced:[],resolved:[]},before:{labels:inventory},after:{labels:inventory}},
                latex:{ok:state==='applied',diagnostics:inventory}},document_hash:'guard',edits:[{operation:'patch'}]};
        const input={...result(data),structuredContent:{...data,routing:{client_id:'correct-window'}}};
        const bounded=s._boundResult(input,'paper_applyEdit',null,'modern');
        const reply=s._finalizeToolResult(bounded,'paper_applyEdit','modern');
        const receipt=reply.structuredContent;
        for(const key of ['transaction_id','operation_id','undo_token','saved','document_hash'])assert.equal(receipt[key],data[key]);
        assert.equal(receipt.verification.ok,data.verification.ok);
        assert.equal(receipt.verification.latex.ok,data.verification.latex.ok);
        assert.equal(receipt.verification.references.before,undefined);
        assert.equal(receipt.routing.client_id,'correct-window');
        assert.equal(receipt.details_handle.format,'structured');
        assert.ok(JSON.stringify(receipt).length<2000);
        assert.match(reply.content[0].text,/Paper edit:/);assert.ok(reply.content[0].text.length<100);
        const handle=receipt.details_handle.handle;
        assert.equal(s._resultStore.get(handle,0,8192,'structured',['verification','ok']).data,data.verification.ok);
        const labels=s._resultStore.get(handle,0,65536,'structured',['verification','references','before','labels']);
        assert.deepEqual(labels.data,inventory);
        assert.equal(s._boundResult(bounded,'paper_applyEdit',null,'modern').content[0].text,bounded.content[0].text);
    }
});

test('preview receipts remove repeated full source and carry reference/warning deltas',()=>{
    const s=server(),data={applied:false,transaction_id:'preview',documentHash:'old',nextDocumentHash:'next',
        before:'x'.repeat(30000),after:'y'.repeat(30000),editCount:1,
        referenceDelta:{before:{labels:inventory},after:{labels:inventory},unresolved:{introduced:[{target:'missing'}],resolved:[]}},
        warningDelta:{introduced:[],resolved:[]}};
    const reply=s._finalizeToolResult(result(data),'paper_previewEdit','modern');
    assert.equal(reply.structuredContent.transaction_id,'preview');assert.equal(reply.structuredContent.before,undefined);
    assert.equal(reply.structuredContent.referenceDelta.counts.unresolved.introduced,1);
    assert.equal(reply.structuredContent.referenceDelta.unresolved.introduced[0].target,'missing');
    assert.equal(s._resultStore.get(reply.structuredContent.details_handle.handle,0,5,'text').data.length,5);
    const full=s._finalizeToolResult({...result(data),_paperProjection:'full'},'paper_previewEdit','modern');
    assert.equal(full.structuredContent.before,data.before);assert.equal(full.structuredContent.details_handle,undefined);
});

test('modern idle replies are minimal, older clients retain JSON, and delivery guards are never bounded away',()=>{
    const s=server(),idle={state:'waiting',listener_id:'listener'};
    const modern=s._finalizeToolResult({...result(idle),structuredContent:{...idle,routing:{file:'/long/path'}}},'paper_listenComments','modern');
    assert.deepEqual(modern.structuredContent,idle);assert.equal(modern.content[0].text,'Waiting for comments.');
    const old=s._finalizeToolResult(result(idle),'paper_listenComments','old');
    assert.deepEqual(JSON.parse(old.content[0].text),idle);
    const delivery={state:'comments',listener_id:'listener',delivery_id:'delivery',document_hash:'doc',
        comments:[{id:'comment',text:'request',anchor:{editable_span:{text:'a'.repeat(8000),source_hash:'span'},
            context_handle:{listener_id:'listener',delivery_id:'delivery',comment_id:'comment'}}}]};
    const reply=s._finalizeToolResult(result(delivery),'paper_listenComments','modern');
    assert.equal(reply.structuredContent.delivery_id,'delivery');assert.equal(reply.structuredContent.comments[0].anchor.editable_span.source_hash,'span');
    assert.equal(reply.structuredContent.preview,undefined);
});

test('typed details return complete JSON values and label partial chunks explicitly',()=>{
    const store=new McpResultStore(),s=server(),item=store.put(JSON.stringify({answer:{ok:true,values:[1,2]}}),'json');
    const node=store.get(item.handle,0,8192,'structured',['answer']);
    assert.deepEqual(node.data,{ok:true,values:[1,2]});assert.equal(node.format,'structured');
    const partial=store.get(item.handle,0,4,'structured',['answer']);
    assert.equal(partial.format,'json-chunk');assert.equal(typeof partial.data,'string');assert.notEqual(partial.next_offset,null);
    const reply=s._finalizeToolResult(result(node),'wolfbook_getResult','modern');
    assert.equal(reply.content[0].text,'Result details ready.');assert.deepEqual(reply.structuredContent.data,node.data);
    // Existing text/json consumers preserve their original slice contract.
    assert.equal(typeof store.get(item.handle,0,8192,'json',['answer']).data,'string');
});

test('long comment waits honor transport client caps without changing server wait duration',()=>{
    const s=server();s._sessionClientNames.set('claude','claude-code');s._sessionClientNames.set('codex','codex-mcp-client');
    const call={name:'paper_listenComments',arguments:{action:'next',wait_seconds:300}};
    assert.equal(s._inlineWaitFor(call,'claude').waitMs,300000);
    assert.equal(s._inlineWaitFor(call,'codex').waitMs,55000);
    assert.equal(call.arguments.wait_seconds,300);
    assert.equal(s._inlineWaitFor({name:'paper_listenComments',arguments:{action:'next'}},'codex').waitMs,47000);
});
