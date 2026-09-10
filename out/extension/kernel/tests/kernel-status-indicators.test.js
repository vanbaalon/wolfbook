'use strict';

const assert = require('assert');
const { makeVscodeStub, withVscodeStub } = require('./_stub-vscode');

(async () => {
    const items = [];
    const commands = new Map();
    const actions = [];
    const prompts = [];
    const dialogs = [];
    const dialogChoices = ['View Full WL Code', 'Abort Task', 'Restart Kernel'];
    let openedTaskFile = null;
    class ThemeColor { constructor(id) { this.id = id; } }
    class MarkdownString {
        constructor() { this.value = ''; }
        appendMarkdown(value) { this.value += value; return this; }
        appendCodeblock(value, language) { this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`; return this; }
    }
    const stub = makeVscodeStub({
        ThemeColor, MarkdownString,
        StatusBarAlignment: { Right: 2 },
        window: {
            createStatusBarItem: id => {
                const item = { id, shown: false, disposed: false, show() { this.shown = true; }, dispose() { this.disposed = true; } };
                items.push(item); return item;
            },
            showWarningMessage: async (...args) => { prompts.push(args); return 'Restart Kernel'; },
            showInformationMessage: async (...args) => {
                dialogs.push(args);
                return dialogChoices.shift();
            },
            showErrorMessage: message => { throw new Error(message); },
            showTextDocument: async doc => { openedTaskFile = doc.uri.fsPath; return {}; },
        },
        workspace: {
            notebookDocuments: [],
            openTextDocument: async uri => ({ uri }),
        },
        commands: {
            registerCommand: (name, fn) => { commands.set(name, fn); return { dispose: () => commands.delete(name) }; },
        },
    });
    const { KernelStatusIndicators, lastWolframTask } = withVscodeStub(
        () => require('../status-indicators'), stub
    );
    const fullSource = 'NSolve[x^5 == 2, x]\n' + '(* retained full Wolfram task *)\n'.repeat(20);
    const busyCtrl = {
        session: {}, kernelStatusString: 'resolved',
        _lastWolframTask: {
            operationId: 'op-1', caption: 'Compute roots', source: fullSource, startedAt: 10,
        },
        arbiter: { status: () => ({ lifecycle: 'busy', busy: true, activeOperation: {
            operationId: 'op-1', caption: 'Compute roots', sourcePreview: 'NSolve[x^5 == 2,', startedAt: 10,
        } }) },
    };
    const idleCtrl = { session: {}, kernelStatusString: 'resolved', arbiter: { status: () => ({ lifecycle: 'idle', busy: false }) },
        _lastWolframTask: { source: 'Plot[Sin[x], {x, 0, 10}]', caption: 'Plot sine', startedAt: 5 } };
    const offlineCtrl = { kernelStatusString: 'unresolved', arbiter: { status: () => ({ lifecycle: 'offline', busy: false }) } };
    const entries = new Map([
        ['k-1', { id: 'k-1', label: 'K1', controller: busyCtrl }],
        ['k-2', { id: 'k-2', label: 'K2', controller: idleCtrl }],
        ['k-3', { id: 'k-3', label: 'K3', controller: offlineCtrl }],
    ]);
    const manager = {
        _entries: entries,
        get: id => entries.get(id),
        describe: entry => entry.controller.arbiter.status(),
        onDidChange: () => ({ dispose() {} }),
    };
    const indicators = new KernelStatusIndicators({ subscriptions: [] }, manager, {
        refreshMs: 0,
        abort: entry => actions.push(`abort:${entry.id}`),
        restart: entry => actions.push(`restart:${entry.id}`),
        stop: entry => actions.push(`stop:${entry.id}`),
    });
    assert.strictEqual(items.length, 2, 'only live kernels get indicators');
    assert.strictEqual(items[0].text, 'K1');
    assert.strictEqual(items[0].color.id, 'charts.green');
    assert.strictEqual(items[1].color.id, 'descriptionForeground');
    assert.match(items[0].tooltip.value, /retained full Wolfram task/);
    assert.strictEqual(lastWolframTask(entries.get('k-2')).source, 'Plot[Sin[x], {x, 0, 10}]');

    // A registry record retains the full source even when the controller's
    // transient record is missing/mismatched and the arbiter has only 160 chars.
    const registrySource = 'Grid[Table[{i, Expand[(x + y)^i]}, {i, 1, 200}]]';
    busyCtrl._lastWolframTask = { operationId: 'older-op', source: 'wrong', startedAt: 1 };
    busyCtrl.operations = {
        get: id => id === 'op-1' ? { source: registrySource, cells: [], caption: 'Compute roots' } : null,
        active: () => null,
        _order: [],
    };
    assert.strictEqual(lastWolframTask(entries.get('k-1')).source, registrySource);
    busyCtrl._lastWolframTask = {
        operationId: 'op-1', caption: 'Compute roots', source: fullSource, startedAt: 10,
    };

    await commands.get('wolfbook.showKernelActivity')('k-1');
    assert(openedTaskFile?.endsWith('.wl'));
    assert.strictEqual(require('fs').readFileSync(openedTaskFile, 'utf8'), fullSource);
    require('fs').unlinkSync(openedTaskFile);
    await commands.get('wolfbook.showKernelActivity')('k-1');
    await commands.get('wolfbook.showKernelActivity')('k-2');
    assert.strictEqual(dialogs[0][1].modal, true);
    assert.match(dialogs[0][1].detail, /State: busy/);
    assert.match(dialogs[0][1].detail, /Last task: Compute roots/);
    assert.match(dialogs[0][1].detail, /Wolfram Language:\nNSolve/);
    assert(dialogs[0].includes('View Full WL Code'));
    assert(dialogs[0].includes('Abort Task'));
    assert.deepStrictEqual(actions, ['abort:k-1', 'restart:k-2']);
    assert.match(prompts[0][1].detail, /in-memory Wolfram definitions/);

    busyCtrl.arbiter.status = () => ({ lifecycle: 'idle', busy: false });
    indicators.refresh();
    assert.strictEqual(items[0].color.id, 'descriptionForeground');
    indicators.dispose();
    assert(items[0].disposed && items[1].disposed);
    console.log('kernel status indicators: OK');
})().catch(error => { console.error(error); process.exit(1); });
