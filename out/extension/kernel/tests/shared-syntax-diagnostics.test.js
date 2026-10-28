'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {acquireDiagnostics}=require('../../syntax/diagnostics');
function fixture(){const values=new Map();let created=0,disposed=0;
    const vscode={languages:{createDiagnosticCollection:name=>{assert.equal(name,'wolfram-syntax');created++;return{
        name,set:(uri,v)=>values.set(uri.toString(),v),get:uri=>values.get(uri.toString()),delete:uri=>values.delete(uri.toString()),dispose:()=>{disposed++;values.clear();}};}}};
    return {vscode,values,created:()=>created,disposed:()=>disposed};}
const uri=s=>({toString:()=>s});
test('local kernels and remote proxies share one collection until the final controller is disposed',()=>{
    const f=fixture(),a=acquireDiagnostics(f.vscode),b=acquireDiagnostics(f.vscode);assert.equal(f.created(),1);
    a.set(uri('a'),['error-a']);b.set(uri('b'),['error-b']);a.dispose();a.dispose();
    assert.equal(f.disposed(),0);assert.deepEqual(b.get(uri('b')),['error-b']);assert.equal(f.values.has('a'),false);
    b.dispose();assert.equal(f.disposed(),1);acquireDiagnostics(f.vscode).dispose();assert.equal(f.created(),2);
});
test('disposing an old kernel cannot erase diagnostics written later by the newly selected kernel',()=>{
    const f=fixture(),a=acquireDiagnostics(f.vscode),b=acquireDiagnostics(f.vscode),cell=uri('cell');
    a.set(cell,['old error']);b.set(cell,['current error']);a.dispose();assert.deepEqual(b.get(cell),['current error']);
    b.delete(cell);assert.equal(f.values.size,0);b.dispose();
});
test('real notebook controller construction acquires shared leases rather than duplicate collections',()=>{
    const h=require('./_stub-controller').makeControllerHarness(),a=h.kernel(),b=h.kernel();
    try{
        const resources=h.calls.resources.filter(r=>r.kind==='diagnostics');assert.equal(resources.length,1);
        a.dispose();assert.equal(resources[0].disposed,false);b.dispose();assert.equal(resources[0].disposed,true);
    }finally{a.dispose();b.dispose();}
});
