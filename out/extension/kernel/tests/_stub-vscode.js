'use strict';

// Shared vscode stub for headless kernel/tool tests.
//
// Usage:
//   const { withVscodeStub, makeVscodeStub } = require('./_stub-vscode');
//   const mod = withVscodeStub(() => require('../../tools/cell-pipeline'));
//
// withVscodeStub(fn, stub?) installs a Module._load interceptor for 'vscode'
// around fn() — use it to require modules that import vscode at load time.
// The interceptor is removed before returning, so requires made later (inside
// test bodies) resolve normally; keep all vscode-importing requires inside fn.

const Module = require('module');

class LanguageModelTextPart {
    constructor(value) { this.value = value; }
}
class LanguageModelToolResult {
    constructor(content) { this.content = content; }
}
class NotebookRange {
    constructor(start, end) { this.start = start; this.end = end; this.isEmpty = start === end; }
}

function makeVscodeStub(overrides = {}) {
    const stub = {
        LanguageModelTextPart,
        LanguageModelToolResult,
        NotebookRange,
        NotebookCellKind: { Markup: 1, Code: 2 },
        NotebookControllerAffinity: { Default: 1, Preferred: 2 },
        ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
        Uri: {
            file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => `file://${p}` }),
            parse: (s) => ({ fsPath: s.replace(/^file:\/\//, ''), scheme: 'file', toString: () => s }),
            joinPath: (base, ...parts) => {
                const p = require('path').join(base.fsPath || base.path || '', ...parts);
                return { fsPath: p, scheme: 'file', path: p, toString: () => `file://${p}` };
            },
        },
        EventEmitter: class {
            constructor() { this._listeners = new Set(); }
            get event() { return (fn) => { this._listeners.add(fn); return { dispose: () => this._listeners.delete(fn) }; }; }
            fire(v) { for (const fn of [...this._listeners]) fn(v); }
            dispose() { this._listeners.clear(); }
        },
        window: {
            activeNotebookEditor: undefined,
            visibleNotebookEditors: [],
            showNotebookDocument: async (doc) => ({ notebook: doc, selection: null }),
            showInformationMessage: async () => undefined,
            showWarningMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, show: () => {}, dispose: () => {} }),
            tabGroups: { all: [] },
            onDidChangeActiveNotebookEditor: () => ({ dispose: () => {} }),
        },
        workspace: {
            notebookDocuments: [],
            workspaceFolders: [],
            getConfiguration: () => ({ get: (_k, dflt) => dflt, update: async () => {} }),
            openNotebookDocument: async (uri) => { throw new Error(`stub: notebook not open: ${uri?.fsPath || uri}`); },
            onDidChangeNotebookDocument: () => ({ dispose: () => {} }),
            onDidOpenNotebookDocument: () => ({ dispose: () => {} }),
            applyEdit: async () => true,
            // Enough of a watcher that code registering one can be executed.
            // A handler kept here would let a test fire an external change.
            createFileSystemWatcher: () => {
                const sub = () => ({ dispose: () => {} });
                return { onDidChange: sub, onDidCreate: sub, onDidDelete: sub, dispose: () => {} };
            },
            fs: { readFile: async () => new Uint8Array(), writeFile: async () => {} },
        },
        commands: {
            executeCommand: async () => undefined,
        },
        notebooks: {
            createNotebookController: () => ({
                dispose: () => {}, updateNotebookAffinity: () => {},
                onDidChangeSelectedNotebooks: () => ({ dispose: () => {} }),
                createNotebookCellExecution: () => { throw new Error('stub: not associated'); },
            }),
        },
        env: { appName: 'VSCodeStub', clipboard: { writeText: async () => {} } },
        lm: undefined,
    };
    // Deep-ish merge: top-level override objects replace or extend the defaults.
    for (const [k, v] of Object.entries(overrides)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && stub[k] && typeof stub[k] === 'object') {
            stub[k] = { ...stub[k], ...v };
        } else {
            stub[k] = v;
        }
    }
    return stub;
}

function withVscodeStub(fn, stubOrOverrides) {
    const stub = (stubOrOverrides && stubOrOverrides.LanguageModelToolResult)
        ? stubOrOverrides
        : makeVscodeStub(stubOrOverrides || {});
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') return stub;
        return originalLoad.apply(this, arguments);
    };
    try {
        return fn(stub);
    } finally {
        Module._load = originalLoad;
    }
}

module.exports = { withVscodeStub, makeVscodeStub, LanguageModelTextPart, LanguageModelToolResult };
