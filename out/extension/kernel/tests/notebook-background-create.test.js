'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { makeVscodeStub } = require('./_stub-vscode');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-background-'));
    const notices = [], selected = new Set(), bindings = new Map();
    let dispatched = 0, shown = 0, affinity = 0, selectOnLoad = false, allowOpen = false;
    const selectionListeners = new Set();
    const ctrl = {
        kernelStatusString: 'unresolved', selectedNotebooks: selected,
        launches: 0, launchKernel: async () => { ctrl.launches++; ctrl.kernelStatusString = 'resolved'; },
        _controller: { id: 'wolfram', updateNotebookAffinity: () => { affinity++; },
            onDidChangeSelectedNotebooks: fn => {selectionListeners.add(fn);return {dispose:()=>selectionListeners.delete(fn)};} },
        executionQueue: { queueLength: () => 0 },
        execute: async ([cell]) => {
            assert.strictEqual(shown, allowOpen ? 1 : 0, 'evaluation adds no further editor reveals');
            assert.strictEqual(stub.window.activeNotebookEditor, undefined, 'WPaper still owns the active group');
            assert.strictEqual(ctrl._silentExecution, true);
            if (!selected.has(cell.notebook)) {
                return { dispatched: [], skipped: [{ index: cell.index, reason: 'not-associated' }] };
            }
            dispatched++;
            cell.outputs = [{ items: [{ mime: 'text/plain', data: Buffer.from('4') }] }];
            cell.executionSummary = { success: true, timing: { startTime: Date.now() - 1, endTime: Date.now() } };
            return { dispatched: [{ index: cell.index }], skipped: [] };
        },
    };
    const entry = { id: 'K1', label: 'Wolfram K1', controller: ctrl };
    const manager = {
        defaultEntry: entry, get: id => id === entry.id ? entry : null,
        annotateNotebook: p => ({kernel_id:(bindings.get(p) || entry).id}),
        explicitBindingFor: p => bindings.get(p), bindingFor: p => bindings.get(p) || entry,
        bind: async (p, id) => { assert.strictEqual(id, entry.id); bindings.set(p, entry); },
    };
    const stub = makeVscodeStub({
        window: {
            showNotebookDocument: async (notebook, options) => {
                assert.ok(allowOpen,'background loading must not reveal a notebook');shown++;
                assert.equal(options.preserveFocus,true);assert.equal(options.preview,false);
                const editor={notebook};stub.window.visibleNotebookEditors=[editor];return editor;
            },
            showInformationMessage: (...args) => new Promise(resolve => notices.push({ args, resolve })),
        },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: root } }],
            openNotebookDocument: async uri => {
                const existing = stub.workspace.notebookDocuments.find(d => d.uri.fsPath === uri.fsPath);
                if (existing) return existing;
                const json = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8'));
                const doc = { uri, notebookType: 'extended-wolfram-notebook', metadata: json.metadata,
                    cellCount: json.cells.length, cellAt: i => doc.cells[i] };
                doc.cells = json.cells.map((c, index) => ({ ...c, index, notebook: doc,
                    document: { uri: { toString: () => `cell://${uri.fsPath}/${index}` }, getText: () => c.value } }));
                stub.workspace.notebookDocuments.push(doc);
                if (selectOnLoad) selected.add(doc);
                return doc;
            },
        },
    });
    const originalLoad = Module._load;
    Module._load = function (request) { return request === 'vscode' ? stub : originalLoad.apply(this, arguments); };
    try {
        const { NewNotebookTool } = require('../../tools/index');
        const getController = () => ctrl;
        getController.manager = manager;
        const tool = new NewNotebookTool(getController);
        const result = await tool.invoke({ input: { path: 'new.wb', cells: [{ content: '2+2' }] } });
        const text = result.content.map(p => p.value).join('\n');
        assert.match(text, /Created \*\*new\.wb\*\*/);
        assert.match(text, /loaded in the background \(1 cells\)/);
        assert.match(text, /retry wolfbook_newNotebook.*reveal:true/);
        const receipt=JSON.parse(result.content.at(-1).value);
        assert.equal(receipt.controller_selected,false);
        assert.deepEqual(receipt.next_action.arguments,{path:path.join(root,'new.wb'),reveal:true,kernel_id:entry.id});
        assert.match(text, /initial cells are NOT evaluated by default/);
        assert.strictEqual(shown, 0);
        assert.strictEqual(dispatched, 0);
        assert.equal(ctrl.launches, 0, 'creating a notebook without evaluation must stay dormant');
        assert.strictEqual(affinity, 1);
        assert(bindings.has(path.join(root, 'new.wb')), 'agent routing/kernel binding is retained without a visible editor');
        assert.deepStrictEqual(notices[0].args.slice(1), ['Open Notebook']);
        assert.match(notices[0].args[0], /created "new\.wb" in the background/);
        const initial = fs.readFileSync(path.join(root, 'new.wb'), 'utf8');

        const reopened = await tool.invoke({ input: { path: 'new.wb', cells: [{ content: 'destroy = 1' }], evaluate: true } });
        const reopenText = reopened.content.map(p => p.value).join('\n');
        assert.match(reopenText, /Loaded existing/);
        assert.equal(ctrl.launches, 1, 'explicit agent evaluation starts the dormant target');
        assert.match(reopenText, /NOT executed/, 'unselected controller never yields a false success');
        assert.match(reopenText, /Call wolfbook_newNotebook.*reveal:true/, 'report automatic recovery instead of a user click');
        assert.strictEqual(fs.readFileSync(path.join(root, 'new.wb'), 'utf8'), initial, 'opening an existing notebook preserves its contents');
        assert.strictEqual(notices.length, 1, 'creation and subsequent activity share one unattended toast');
        assert.strictEqual(shown, 0);

        selectOnLoad = true;
        const evaluated = await tool.invoke({ input: { path: 'selected.wb', cells: [{ content: '2+2' }], evaluate: true } });
        const evaluatedText = evaluated.content.map(p => p.value).join('\n');
        assert.match(evaluatedText, /controller selected for this notebook/);
        assert.match(evaluatedText, /Cell 1: ✓ — 4/);
        assert.strictEqual(dispatched, 1, 'associated notebooks still evaluate through the real evidence-gated pipeline');
        assert.strictEqual(shown, 0);
        assert.strictEqual(ctrl._silentExecution, false, 'pipeline releases its silent execution guard');
        selectOnLoad = false;
        allowOpen = true;
        stub.commands.getCommands = async () => ['notebook.selectKernel','_notebook.selectKernel'];
        stub.commands.executeCommand = async (name,args) => {
            assert.equal(name,'notebook.selectKernel');assert.equal(args.id,ctrl._controller.id);
            const target=args.notebookEditor.notebook;
            assert.equal(target.uri.fsPath,path.join(root,'new.wb'));
            selected.add(target);
            for(const fn of selectionListeners)fn({notebook:target,selected:true});
        };
        const ready=await tool.invoke({input:{path:'new.wb',kernel_id:entry.id,reveal:true,evaluate:true}});
        const readyText=ready.content.map(p=>p.value).join('\n');
        assert.match(readyText,/Loaded existing/);assert.match(readyText,/Cell 1: ✓ — 4/);
        const readyReceipt=JSON.parse(ready.content.at(-1).value);
        assert.equal(readyReceipt.controller_selected,true);assert.equal(readyReceipt.evaluation_ready,true);
        assert.equal(readyReceipt.revealed,true);assert.equal(readyReceipt.next_action,undefined);
        assert.equal(shown,1);assert.equal(dispatched,2);
        assert.equal(selectionListeners.size,0);
        assert.strictEqual(fs.readFileSync(path.join(root,'new.wb'),'utf8'),initial,'recovery preserves existing cells');
        assert.equal(bindings.get(path.join(root,'new.wb')),entry,'recovery retains the intended binding');
        assert.equal(notices.length,2,'explicit open does not add a redundant Open Notebook notification');
        const privateSelected=new Set();
        const privateController={kernelStatusString:'resolved',selectedNotebooks:privateSelected,
            _controller:{...ctrl._controller,id:'private-controller',label:'Agent K2'}};
        const privateEntry={id:'k-private',label:'Agent K2',isDefault:false,controller:privateController};
        manager.get=id=>id === privateEntry.id ? privateEntry : id === entry.id ? entry : null;
        manager.bind=async(p,id)=>{const chosen=manager.get(id);assert.ok(chosen);bindings.set(p,chosen);};
        stub.commands.executeCommand=async(name,args)=>{
            assert.equal(name,'notebook.selectKernel');assert.equal(args.id,'private-controller');
            const target=args.notebookEditor.notebook;
            assert.equal(target.uri.fsPath,path.join(root,'isolated.wb'));
            privateSelected.add(target);
            for(const fn of selectionListeners)fn({notebook:target,selected:true});
        };
        const privateResult=await tool.invoke({input:{path:'isolated.wb',kernel_id:privateEntry.id,reveal:true}});
        const privateReceipt=JSON.parse(privateResult.content.at(-1).value);
        assert.equal(privateReceipt.kernel_id,privateEntry.id);
        assert.equal(privateReceipt.controller_selected,true);assert.equal(privateReceipt.evaluation_ready,true);
        assert.equal(bindings.get(path.join(root,'isolated.wb')),privateEntry,'private target never falls back to K1');
        assert.equal(shown,2);assert.equal(selectionListeners.size,0);
        assert.ok(!selected.has(stub.workspace.notebookDocuments.find(d=>d.uri.fsPath.endsWith('isolated.wb'))));
        console.log('notebook background creation/evaluation and automatic private-controller recovery tests: OK');
    } finally {
        Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(err => { console.error(err); process.exit(1); });
