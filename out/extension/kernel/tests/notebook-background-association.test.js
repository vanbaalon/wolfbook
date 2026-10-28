'use strict';
const assert = require('assert');
const Module = require('module');
const { makeVscodeStub } = require('./_stub-vscode');
const { associateNotebook } = require('../association');

(async () => {
    const doc = { uri: { fsPath: '/tmp/agent.wb', toString: () => 'file:///tmp/agent.wb' } };
    const selected = new Set();
    const selectionEvents = [];
    let shown = 0, commands = 0, affinities = 0;
    const ctrl = { selectedNotebooks: selected, _controller: {
        id: 'wolfram', label: 'K1',
        updateNotebookAffinity: () => { affinities++; },
        onDidChangeSelectedNotebooks: fn => {
            selectionEvents.push(fn);
            return { dispose() { selectionEvents.splice(selectionEvents.indexOf(fn), 1); } };
        },
    } };
    const stub = makeVscodeStub({
        window: { showNotebookDocument: async notebook => {
            shown++;
            stub.window.activeNotebookEditor = { notebook };
        } },
        commands: {
            getCommands: async () => ['_notebook.selectKernel'],
            executeCommand: async (name, args) => {
                commands++;
                assert.strictEqual(name, '_notebook.selectKernel');
                assert.strictEqual(args.id, ctrl._controller.id);
                selected.add(doc);
                for (const fn of [...selectionEvents]) fn({ notebook: doc, selected: true });
            },
        },
    });
    const originalLoad = Module._load;
    Module._load = function (request) { return request === 'vscode' ? stub : originalLoad.apply(this, arguments); };
    try {
        let result = await associateNotebook(ctrl, doc, { allowReveal: false });
        assert.strictEqual(result.associated, false);
        assert.strictEqual(result.method, 'background-selection-pending');
        assert.strictEqual(affinities, 1, 'record affinity so an explicit user open can associate');
        assert.strictEqual(shown, 0, 'hidden notebook must not displace WPaper for association');
        assert.strictEqual(commands, 0, 'selection must not run against a different active editor');

        stub.window.activeNotebookEditor = { notebook: doc };
        result = await associateNotebook(ctrl, doc, { allowReveal: false });
        assert.strictEqual(result.associated, true, 'select controller while user already views the notebook');
        assert.strictEqual(shown, 0);
        assert.strictEqual(commands, 1);
        assert.strictEqual(selectionEvents.length, 0, 'dispose selection subscriptions');

        stub.window.activeNotebookEditor = undefined;
        result = await associateNotebook(ctrl, doc, { allowReveal: false });
        assert.strictEqual(result.method, 'already');
        assert.strictEqual(shown, 0, 'associated notebooks evaluate in background with no navigation');
        assert.strictEqual(commands, 1);

        // User navigation while the asynchronous command lookup is pending must
        // not cause selection or reveal against their newly active WPaper tab.
        selected.clear();
        stub.window.activeNotebookEditor = { notebook: doc };
        stub.commands.getCommands = async () => {
            stub.window.activeNotebookEditor = undefined;
            return ['_notebook.selectKernel'];
        };
        result = await associateNotebook(ctrl, doc, { allowReveal: false });
        assert.strictEqual(result.associated, false);
        assert.strictEqual(shown, 0);
        assert.strictEqual(commands, 1);
        // Public API targets a visible notebook in another group without
        // opening it or selecting a kernel against the active notebook.
        const other={uri:{toString:()=> 'file:///tmp/user.wb'}};
        const editor={notebook:doc};
        stub.window.visibleNotebookEditors=[editor];
        stub.window.activeNotebookEditor={notebook:other};
        stub.commands.getCommands=async()=>['notebook.selectKernel','_notebook.selectKernel'];
        stub.commands.executeCommand=async(name,args)=>{
            commands++;assert.equal(name,'notebook.selectKernel');
            assert.equal(args.notebookEditor,editor);assert.equal(args.id,ctrl._controller.id);
            selected.add(doc);
            for(const fn of [...selectionEvents])fn({notebook:doc,selected:true});
        };
        result=await associateNotebook(ctrl,doc,{allowReveal:false});
        assert.equal(result.associated,true);assert.equal(shown,0);
        assert.equal(stub.window.activeNotebookEditor.notebook,other);
        assert.equal(selectionEvents.length,0);

        selected.clear();stub.window.visibleNotebookEditors=[];
        result=await associateNotebook(ctrl,doc,{allowReveal:false});
        assert.equal(result.associated,false);assert.equal(result.method,'background-selection-pending');
        assert.equal(commands,2,'a hidden notebook cannot fall back to selecting the active user notebook');
        assert.equal(shown,0);
        console.log('notebook background and exact-editor kernel association tests: OK');
    } finally { Module._load = originalLoad; }
})().catch(err => { console.error(err); process.exit(1); });
