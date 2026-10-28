'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { KernelManager, canonicalNotebook } = require('../manager');

// Execute the registered production handlers, without activating the extension
// or starting/evaluating a real Wolfram kernel.
const source = fs.readFileSync(path.join(__dirname, '../../extension.js'), 'utf8');
function handler(name, end, scope) {
    const start = source.indexOf(`registerCommand('${name}', async () => {`);
    const doubleStart = source.indexOf(`registerCommand("${name}", async () => {`);
    const offset = start < 0 ? doubleStart : start;
    assert.ok(offset >= 0, `registered command ${name}`);
    const expression = source.slice(source.indexOf('async () => {', offset), source.indexOf(end, offset));
    return vm.runInNewContext(`(${expression}\n})`, scope);
}
function fixture() {
    const calls = { focused:[], executed:[], selected:[], created:[], warnings:[], errors:[], info:[], picks:null };
    const ctrl = { selectedNotebooks:new Set(), kernelStatusString:'resolved',
        arbiter:{ status:()=>({ busy:false, lifecycle:'idle' }) },
        _controller:{ id:'wolfram', updateNotebookAffinity() {} },
        _cellLastSource:new Map(), _cellDirty:new Set(), _evalModeOverride:'auto',
        execute:(...args)=>calls.executed.push(args) };
    const manager = new KernelManager(null, { maximum:1 });
    const shared = manager.addDefault(ctrl);
    const nb = { uri:{ fsPath:'/tmp/shift-enter.wb', toString:()=> 'file:///tmp/shift-enter.wb' },
        notebookType:'extended-wolfram-notebook', cellCount:1, cellAt:()=>cell };
    const cell = { kind:2, index:0, document:{ uri:{ toString:()=> 'cell://one' }, getText:()=> '1+1' } };
    const editor = { notebook:nb, selections:[{ start:0, end:1 }], visibleRanges:[{ start:0, end:1 }], revealRange() {} };
    // This is a retained unavailable slot, rather than a new notebook's
    // implicit default. It reproduces the actual null binding in the logs.
    manager._bindings.set(canonicalNotebook(nb), 'slot-unavailable');
    let choice = picks => picks.find(pick=>pick.kernelId===shared.id && !pick.action);
    const vscode = { NotebookCellKind:{ Code:2 }, NotebookEditorRevealType:{ AtTop:1 },
        NotebookRange:class { constructor(start,end) { Object.assign(this,{start,end}); } },
        ConfigurationTarget:{Workspace:2}, workspace:{getConfiguration:()=>({update:async(...args)=>{calls.setting=args;}})},
        window:{ activeNotebookEditor:editor,
            showNotebookDocument:async (document,options)=>{calls.focused.push({document,options});return editor;},
            showQuickPick:async picks=>{ calls.picks=picks; return choice(picks); },
            showInformationMessage:message=>calls.info.push(message),
            showErrorMessage:message=>calls.errors.push(message),
            showWarningMessage:message=>calls.warnings.push(message) }, commands:{} };
    const scope = { vscode, vscode_1:vscode, kernelManager:manager,
        _syncRemoteKernelControllers() {}, _remoteKernelDescriptors:()=>[], _liveKernelTopology:()=>[],
        _refreshKernelIdentity() {}, _attachRemoteKernel:()=>null, _detachRemoteKernel() {},
        _startNewKernelForNotebook:async doc=>calls.created.push(doc),
        associateNotebook:async (controller,doc,options)=>{
            calls.selected.push({controller,doc,options}); controller.selectedNotebooks.add(doc); return {associated:true};
        }, scrollLog() {}, _resolveController:()=>ctrl, _debugCtrl:{isActive:false}, setTimeout };
    const manage = handler('wolfbook.manageKernelBinding', '\n        })\n    );\n    _refreshKernelIdentity();', scope);
    const execute = handler('wolfbook.executeCell', '\n    }));\n\n    // Eval mode toggle commands', scope);
    vscode.commands.executeCommand = async name=>{
        assert.equal(name,'wolfbook.manageKernelBinding'); return manage();
    };
    return { calls,ctrl,manager,shared,nb,cell,editor,vscode,scope,manage,execute,
        choose:fn=>{choice=fn;} };
}

test('Shift+Enter with an unavailable saved kernel opens recovery and executes once after selection', async()=>{
    const f=fixture(); assert.equal(f.manager.bindingFor(f.nb),null);
    await f.execute();
    assert.equal(f.manager.bindingFor(f.nb),f.shared);
    assert.equal(f.calls.selected.length,1);
    assert.equal(f.calls.selected[0].doc,f.nb);
    assert.equal(f.calls.selected[0].options.notebookEditor,f.editor);
    assert.equal(f.calls.executed.length,1);
    assert.equal(f.calls.executed[0][0][0],f.cell);
    assert.ok(f.calls.picks.some(p=>p.create),'new kernel remains available at the advisory count');
    assert.ok(!f.calls.picks.some(p=>p.action),'missing kernels have no rename/restart/stop actions');
});
test('cancelling recovery does not bind or execute any cell', async()=>{
    const f=fixture(); f.choose(()=>undefined); await f.execute();
    assert.equal(f.manager.bindingFor(f.nb),null);
    assert.equal(f.calls.executed.length,0); assert.equal(f.calls.selected.length,0);
});
test('a bound notebook executes directly without opening a picker', async()=>{
    const f=fixture(); await f.manager.bind(f.nb,f.shared.id); await f.execute();
    assert.equal(f.calls.picks,null); assert.equal(f.calls.executed.length,1);
});
test('a new notebook uses the workspace default on its first Shift+Enter without a picker',async()=>{
    const f=fixture(); f.manager._bindings.clear(); f.manager.setNewNotebookDefaultSlot(f.shared.slotKey);
    await f.execute();
    assert.equal(f.calls.picks,null);assert.equal(f.calls.executed.length,1);
    assert.equal(f.manager.explicitBindingFor(f.nb),f.shared);
    assert.equal(f.calls.selected[0].options.notebookEditor,f.editor);
});
test('a workspace default cannot overwrite an unavailable explicit notebook assignment',async()=>{
    const f=fixture();f.manager.setNewNotebookDefaultSlot(f.shared.slotKey);f.choose(()=>undefined);
    await f.execute();assert.ok(f.calls.picks);assert.equal(f.calls.executed.length,0);
    assert.equal(f.manager.bindingFor(f.nb),null);
});
test('the menu saves a durable workspace slot and can restore first-run prompting',async()=>{
    const f=fixture();await f.manager.bind(f.nb,f.shared.id);
    f.choose(picks=>picks.find(p=>p.action==='notebook-default'));await f.manage();
    assert.equal(f.manager.newNotebookDefaultSlot,'default');
    assert.deepEqual(Array.from(f.calls.setting),['kernels.defaultForNewNotebooks','default',2]);
    f.choose(picks=>picks.find(p=>p.action==='clear-notebook-default'));await f.manage();
    assert.equal(f.manager.newNotebookDefaultSlot,'');assert.equal(f.calls.setting[1],'');
    assert.equal(f.manager.explicitBindingFor(f.nb),f.shared,'changing defaults preserves explicit bindings');
});
test('kernel recovery targets the original notebook when focus changes while choosing', async()=>{
    const f=fixture(); f.choose(picks=>{
        f.vscode.window.activeNotebookEditor={notebook:{uri:{fsPath:'/tmp/other.wb'}}};
        return picks.find(p=>p.kernelId===f.shared.id && !p.action);
    });
    await f.manage();
    assert.equal(f.manager.explicitBindingFor(f.nb),f.shared);
    assert.equal(f.manager.explicitBindingFor('/tmp/other.wb'),null);
    assert.equal(f.calls.selected[0].doc,f.nb);
    assert.equal(f.calls.selected[0].options.notebookEditor,f.editor);
    assert.equal(f.calls.selected[0].options.allowReveal,false);
});
test('starting a kernel uses the captured notebook, even if notebook focus disappears', async()=>{
    const f=fixture(); f.choose(picks=>{
        f.vscode.window.activeNotebookEditor=undefined; return picks.find(p=>p.create);
    });
    await f.manage(); assert.equal(f.calls.created[0],f.nb);
});
test('closing the notebook or losing the chosen kernel cancels assignment safely', async()=>{
    for (const closed of [false,true]) {
        const f=fixture(); f.choose(picks=>{
            const pick=picks.find(p=>p.kernelId===f.shared.id && !p.action);
            if(closed)f.nb.isClosed=true; else f.manager._entries.delete(f.shared.id);
            return pick;
        });
        await f.manage(); assert.equal(f.calls.selected.length,0);
        if(!closed)assert.match(f.calls.warnings[0],/no longer available/);
    }
});
test('a selected current kernel retains management actions; association failure is reported honestly', async()=>{
    const f=fixture(); await f.manager.bind(f.nb,f.shared.id);
    f.scope.associateNotebook=async()=>({associated:false}); await f.manage();
    assert.equal(f.calls.picks.filter(p=>p.action).length,4);
    assert.equal(f.calls.info.length,0);
    assert.match(f.calls.warnings[0],/controller could not be selected/);
});


test('Shift+Enter reselects the bound controller after a kernel switch and keeps the original cell', async()=>{
    const f=fixture(); await f.manager.bind(f.nb,f.shared.id);
    f.scope.associateNotebook=async (controller,doc,options)=>{
        f.calls.selected.push({controller,doc,options});
        controller.selectedNotebooks.add(doc);
        f.editor.selections=[];
        return {associated:true};
    };
    await f.execute();
    assert.equal(f.calls.selected.length,1);
    assert.equal(f.calls.executed[0][0][0],f.cell);
    assert.equal(f.calls.errors.length,0);
});
test('Shift+Enter reports a failed controller selection without evaluating', async()=>{
    const f=fixture(); await f.manager.bind(f.nb,f.shared.id);
    f.scope.associateNotebook=async()=>({associated:false});
    await f.execute(); assert.equal(f.calls.executed.length,0);
    assert.match(f.calls.warnings[0],/Could not select/);
});
test('Shift+Enter awaits execution and reports rejection or skipped dispatch', async()=>{
    for (const reject of [false,true]) {
        const f=fixture(); await f.manager.bind(f.nb,f.shared.id);
        f.ctrl.execute=async()=>{
            await Promise.resolve();
            if(reject) throw Error('controller disposed');
            return {dispatched:[],skipped:[{reason:'not-associated'}]};
        };
        await f.execute();
        if(reject) assert.match(f.calls.errors[0],/controller disposed/);
        else assert.match(f.calls.warnings[0],/not-associated/);
    }
});
test('Shift+Enter refuses a binding changed during asynchronous selection', async()=>{
    const f=fixture(); await f.manager.bind(f.nb,f.shared.id);
    f.scope.associateNotebook=async()=>{
        f.manager._bindings.set(canonicalNotebook(f.nb),'missing');
        return {associated:true};
    };
    await f.execute();assert.equal(f.calls.executed.length,0);
    assert.match(f.calls.warnings[0],/kernel changed/);
});


test('status-bar switching restores notebook focus for the next physical Shift+Enter',async()=>{
    const f=fixture();await f.manager.bind(f.nb,f.shared.id);await f.manage();
    assert.equal(f.calls.focused.length,1);
    assert.equal(f.calls.focused[0].document,f.nb);
    assert.equal(f.calls.focused[0].options.preserveFocus,false);
    assert.equal(f.calls.focused[0].options.selections,f.editor.selections);
});
test('binding menu does not steal focus after the user switches away while choosing',async()=>{
    const f=fixture();f.choose(picks=>{
        f.vscode.window.activeNotebookEditor=undefined;
        return picks.find(p=>p.kernelId===f.shared.id && !p.action);
    });
    await f.manage();assert.equal(f.calls.focused.length,0);
});
