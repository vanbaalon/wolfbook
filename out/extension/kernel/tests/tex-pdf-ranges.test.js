const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PdfRangeStore } = require('../../tex/pdfRanges');
const { PdfRanges } = require('../../../client/pdf-ranges');
class Transport {
    constructor(length, initial) { this.length=length; this.initial=initial; this.delivered=[]; }
    onDataRange(begin,data) { this.delivered.push({ begin,data:Buffer.from(data).toString() }); }
}
const pdfjs={ PDFDataRangeTransport:Transport };

test('range store serves only admitted PDFs and validates boundaries and release', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pdf-ranges-'));
    const file=path.join(dir,'paper.pdf'), store=new PdfRangeStore();
    fs.writeFileSync(file,'0123456789');
    try {
        const resource=store.open(file);
        assert.equal(resource.length,10);
        const request={ token:resource.token,request:1,begin:3,end:7 };
        assert.equal(Buffer.from(store.read(request).data,'base64').toString(),'3456');
        for (const patch of [{ token:'foreign' },{ begin:-1 },{ end:11 },{ end:3 },{ begin:0.5 },{ request:0 }])
            assert.ok(store.read({ ...request,...patch }).error);
        store.release(resource.token); store.release(resource.token);
        assert.match(store.read(request).error,/released/);
        store.open(file); store.close(); assert.equal(store.files.size,0);
    } finally { store.close(); fs.rmSync(dir,{ recursive:true,force:true }); }
});

test('client dispatches out-of-order chunks by resource and request and releases independently', () => {
    const messages=[], ranges=new PdfRanges(m=>messages.push(m));
    const first=ranges.create(pdfjs,{ token:'first',length:10 });
    const second=ranges.create(pdfjs,{ token:'second',length:10 });
    first.requestDataRange(0,3); first.requestDataRange(7,10); second.requestDataRange(0,3);
    const reply=(token,request,begin,data) => ranges.receive({ token,request,begin,data:Buffer.from(data).toString('base64') });
    reply('second',1,0,'XYZ'); reply('first',2,7,'789'); reply('first',1,0,'012');
    assert.deepEqual(first.delivered,[{ begin:7,data:'789' },{ begin:0,data:'012' }]);
    assert.deepEqual(second.delivered,[{ begin:0,data:'XYZ' }]);
    first.abort(); first.abort(); assert.equal(ranges.active.size,1);
    reply('first',1,0,'bad'); assert.equal(first.delivered.length,2);
    second.abort(); assert.equal(ranges.active.size,0);
    assert.equal(messages.filter(m=>m.type==='pdfRangeRelease').length,2);
});

test('bad replies and host errors reject and release the affected transport', async () => {
    for (const bad of [{ begin:1,data:'YWJj' },{ begin:0,data:'YQ==' },{ error:'resource truncated' }]) {
        const messages=[], ranges=new PdfRanges(m=>messages.push(m));
        const transport=ranges.create(pdfjs,{ token:'pdf',length:3 });
        transport.requestDataRange(0,3);
        ranges.receive({ token:'pdf',request:1,...bad });
        await assert.rejects(transport.failure);
        assert.equal(transport.closed,true); assert.equal(ranges.active.size,0);
        assert.equal(messages.at(-1).type,'pdfRangeRelease');
    }
});

test('unanswered range requests time out and release their file', async () => {
    const ranges=new PdfRanges(()=>{},5), transport=ranges.create(pdfjs,{ token:'pdf',length:3 });
    transport.requestDataRange(0,3);
    await assert.rejects(transport.failure,/timed out/);
    assert.equal(ranges.active.size,0);
});

test('a lost byte response is retried once with the same immutable request', async () => {
    const messages=[],ranges=new PdfRanges(m=>messages.push(m),10);
    const transport=ranges.create(pdfjs,{token:'retry',length:3});
    transport.requestDataRange(0,3);
    await new Promise(resolve=>setTimeout(resolve,13));
    const requests=messages.filter(m=>m.type==='pdfRangeRequest');
    assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
    ranges.receive({token:'retry',request:requests[1].request,begin:0,data:'YWJj'});
    await new Promise(resolve=>setTimeout(resolve,13));
    assert.equal(transport.closed,undefined);assert.deepEqual(transport.delivered,[{begin:0,data:'abc'}]);
    transport.abort();
});

test('late duplicate replies and cancellation do not revive or leak retry timers', async () => {
    const messages=[],ranges=new PdfRanges(m=>messages.push(m),10),transport=ranges.create(pdfjs,{token:'late',length:3});
    transport.requestDataRange(0,3);await new Promise(resolve=>setTimeout(resolve,13));
    const response={token:'late',request:1,begin:0,data:'YWJj'};
    ranges.receive(response);ranges.receive(response);transport.abort();
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(messages.filter(m=>m.type==='pdfRangeRequest').length,2);
    assert.equal(messages.filter(m=>m.type==='pdfRangeRelease').length,1);assert.equal(transport.delivered.length,1);
});
