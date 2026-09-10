// When the Page view is allowed to put itself away — and, mostly, when it is not.
//
//   node out/extension/kernel/tests/tex-follow.test.js
//
// The bug these cases were written for: VS Code started opening agent sessions
// as EDITOR TABS. The old rule read the tab that was in FRONT, saw a webview
// that was not the viewer, and disposed the paper — while the reader was still
// sitting in the .tex it belonged to, having done nothing but glance at a panel
// beside it. Every "the agents panel is in front" case below fails against that
// rule and passes against the pairing rule.

const assert = require('assert');
const { decideFollow, classifyTab, pairedGroup } = require('../../tex/viewerFollow.js');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); }
};

const VIEW_TYPE = 'wolfbook.texViewer';
const OPTS = { viewType: VIEW_TYPE };

// --- tab fixtures, shaped like the real Tab inputs -------------------------
const uri = (fsPath) => ({ fsPath, scheme: 'file' });
const fileTab = (fsPath) => ({ input: { uri: uri(fsPath) } });
// VS Code prefixes a panel's viewType in TabInputWebview, hence the substring test.
const viewerTab = () => ({ input: { viewType: `mainThreadWebview-${VIEW_TYPE}` } });
const webviewTab = (viewType) => ({ input: { viewType } });
const agentsTab = () => webviewTab('mainThreadWebview-anthropic.claude-code.chat');
const terminalTab = () => ({ input: {} });
const settingsTab = () => ({ input: undefined });
const diffTab = (a, b) => ({ input: { original: uri(a), modified: uri(b) } });
const notebookTab = (fsPath) => ({ input: { uri: uri(fsPath), notebookType: 'extended-wolfram-notebook' } });
const customTab = (fsPath, viewType) => ({ input: { uri: uri(fsPath), viewType } });

const group = (viewColumn, tabs, activeIndex, isActive) => ({
    viewColumn,
    tabs,
    activeTab: activeIndex == null ? undefined : tabs[activeIndex],
    isActive: !!isActive,
});

// The arrangement the reader actually has: source on the left, paper beside
// it, agent session in a third group on the right.
const threeGroups = (leftTabs, leftActive, agentsFocused) => [
    group(1, leftTabs, leftActive, !agentsFocused),
    group(2, [viewerTab()], 0, false),
    group(3, [agentsTab()], 0, !!agentsFocused),
];

// --- the reported bug ------------------------------------------------------

test('clicking the agents panel does NOT hide the paper', () => {
    const d = decideFollow(threeGroups([fileTab('/p/main.tex')], 0, true), OPTS);
    assert.notStrictEqual(d.action, 'hide', d.reason);
});

test('the agents panel in front leaves the pairing alone, so the paper stays on the .tex', () => {
    const d = decideFollow(threeGroups([fileTab('/p/main.tex')], 0, true), OPTS);
    assert.strictEqual(d.action, 'restore');
    assert.strictEqual(d.uri.fsPath, '/p/main.tex');
});

test('an agent session opened INTO the paper group does not hide it either', () => {
    const groups = [
        group(1, [fileTab('/p/main.tex')], 0, false),
        group(2, [viewerTab(), agentsTab()], 1, true),
    ];
    const d = decideFollow(groups, OPTS);
    assert.strictEqual(d.action, 'restore', d.reason);
});

test('a webview beside the paper has no file type to judge, so nothing happens', () => {
    const groups = [
        group(1, [agentsTab()], 0, true),
        group(2, [viewerTab()], 0, false),
    ];
    const d = decideFollow(groups, OPTS);
    assert.strictEqual(d.action, 'none', d.reason);
});

test('a terminal or a settings page beside the paper does not hide it', () => {
    for (const t of [terminalTab(), settingsTab()]) {
        const groups = [group(1, [t], 0, true), group(2, [viewerTab()], 0, false)];
        assert.strictEqual(decideFollow(groups, OPTS).action, 'none');
    }
});

// --- hiding still works, on positive evidence ------------------------------

test('a plain file of the wrong type beside the paper DOES hide it', () => {
    const groups = [
        group(1, [fileTab('/p/notes.md')], 0, true),
        group(2, [viewerTab()], 0, false),
    ];
    const d = decideFollow(groups, OPTS);
    assert.strictEqual(d.action, 'hide', d.reason);
});

test('the neighbour, not the focus, is what hides it: a .md beside the paper hides it even while the agents panel has focus', () => {
    const d = decideFollow(threeGroups([fileTab('/p/notes.md')], 0, true), OPTS);
    assert.strictEqual(d.action, 'hide', d.reason);
});

test('a notebook beside the paper hides it', () => {
    const groups = [
        group(1, [notebookTab('/p/run.wb')], 0, true),
        group(2, [viewerTab()], 0, false),
    ];
    assert.strictEqual(decideFollow(groups, OPTS).action, 'hide');
});

test('a custom editor carrying a uri is judged by its file, not by its viewType', () => {
    const groups = [
        group(1, [customTab('/p/deck.wslide', 'wolfbook.slideEditor')], 0, true),
        group(2, [viewerTab()], 0, false),
    ];
    assert.strictEqual(decideFollow(groups, OPTS).action, 'hide');
});

// --- following between papers ----------------------------------------------

test('switching to another .tex in the paired group follows it', () => {
    const groups = [
        group(1, [fileTab('/p/main.tex'), fileTab('/p/appendix.tex')], 1, true),
        group(2, [viewerTab()], 0, false),
    ];
    const d = decideFollow(groups, OPTS);
    assert.strictEqual(d.action, 'restore');
    assert.strictEqual(d.uri.fsPath, '/p/appendix.tex');
});

test('a diff of a .tex counts as that .tex, taking the edited side', () => {
    const groups = [
        group(1, [diffTab('/p/main.tex~', '/p/main.tex')], 0, true),
        group(2, [viewerTab()], 0, false),
    ];
    const d = decideFollow(groups, OPTS);
    assert.strictEqual(d.action, 'restore');
    assert.strictEqual(d.uri.fsPath, '/p/main.tex');
});

test('.TEX is a .tex', () => {
    const groups = [
        group(1, [fileTab('/p/MAIN.TEX')], 0, true),
        group(2, [viewerTab()], 0, false),
    ];
    assert.strictEqual(decideFollow(groups, OPTS).action, 'restore');
});

// --- the paper is not on screen --------------------------------------------

test('with the paper away, a .tex in front brings it back', () => {
    const groups = [group(1, [fileTab('/p/main.tex')], 0, true)];
    const d = decideFollow(groups, OPTS);
    assert.strictEqual(d.action, 'restore');
    assert.strictEqual(d.uri.fsPath, '/p/main.tex');
});

test('with the paper away, the agents panel in front does not bring it back', () => {
    const groups = [
        group(1, [fileTab('/p/main.tex')], 0, false),
        group(2, [agentsTab()], 0, true),
    ];
    assert.strictEqual(decideFollow(groups, OPTS).action, 'none');
});

test('with the paper away nothing ever asks for a hide', () => {
    const groups = [group(1, [fileTab('/p/notes.md')], 0, true)];
    assert.strictEqual(decideFollow(groups, OPTS).action, 'none');
});

// --- degenerate arrangements ------------------------------------------------

test('a paper alone in the window has no neighbour and is left alone', () => {
    const groups = [group(2, [viewerTab()], 0, true)];
    assert.strictEqual(decideFollow(groups, OPTS).action, 'none');
});

test('an empty neighbouring group does not hide the paper', () => {
    const groups = [
        group(1, [], null, true),
        group(2, [viewerTab()], 0, false),
    ];
    assert.strictEqual(decideFollow(groups, OPTS).action, 'none');
});

test('a paper in column one pairs with the group on its right', () => {
    const groups = [
        group(1, [viewerTab()], 0, false),
        group(2, [fileTab('/p/main.tex')], 0, true),
    ];
    const d = decideFollow(groups, OPTS);
    assert.strictEqual(d.action, 'restore');
    assert.strictEqual(d.uri.fsPath, '/p/main.tex');
});

test('the LEFT neighbour wins when the paper has groups on both sides', () => {
    const groups = [
        group(1, [fileTab('/p/far.md')], 0, false),
        group(2, [fileTab('/p/main.tex')], 0, false),
        group(3, [viewerTab()], 0, false),
        group(4, [fileTab('/p/notes.md')], 0, true),
    ];
    const d = decideFollow(groups, OPTS);
    assert.strictEqual(d.action, 'restore');
    assert.strictEqual(d.uri.fsPath, '/p/main.tex');
});

test('the NEAREST left group is the paired one, not the first', () => {
    const groups = [
        group(1, [fileTab('/p/notes.md')], 0, true),
        group(2, [fileTab('/p/main.tex')], 0, false),
        group(3, [viewerTab()], 0, false),
    ];
    assert.strictEqual(decideFollow(groups, OPTS).action, 'restore');
});

test('the paper is found by its tab even when that tab is in the background', () => {
    const groups = [
        group(1, [fileTab('/p/main.tex')], 0, true),
        group(2, [agentsTab(), viewerTab()], 0, false),
    ];
    // The paper's own group is showing something else in front, but the paper
    // is still there — so this is a pairing question, not a "not on screen" one.
    assert.strictEqual(decideFollow(groups, OPTS).action, 'restore');
});

test('a host with no tab-group API asks the caller to fall back', () => {
    assert.strictEqual(decideFollow(undefined, OPTS).action, 'legacy');
    assert.strictEqual(decideFollow({}, OPTS).action, 'legacy');
    assert.strictEqual(decideFollow(null, OPTS).action, 'legacy');
});

test('the real vscode.window.tabGroups shape (an object with .all) is accepted', () => {
    const all = [
        group(1, [fileTab('/p/notes.md')], 0, true),
        group(2, [viewerTab()], 0, false),
    ];
    assert.strictEqual(decideFollow({ all, activeTabGroup: all[0] }, OPTS).action, 'hide');
});

// --- the classifier itself --------------------------------------------------

test('a custom editor tab is our viewer only when the viewType matches', () => {
    assert.strictEqual(classifyTab(viewerTab(), VIEW_TYPE).kind, 'viewer');
    assert.strictEqual(classifyTab(agentsTab(), VIEW_TYPE).kind, 'opaque');
    assert.strictEqual(classifyTab(fileTab('/p/a.tex'), VIEW_TYPE).kind, 'file');
});

test('a malformed tab never throws and never provokes a hide', () => {
    for (const t of [undefined, null, {}, { input: null }, { input: 42 }, { input: { uri: {} } }]) {
        assert.strictEqual(classifyTab(t, VIEW_TYPE).kind, 'opaque');
        const groups = [group(1, [t], 0, true), group(2, [viewerTab()], 0, false)];
        assert.strictEqual(decideFollow(groups, OPTS).action, 'none');
    }
});

test('groups without a viewColumn still pair with something', () => {
    const a = { tabs: [{ input: { uri: uri('/p/main.tex') } }], activeTab: { input: { uri: uri('/p/main.tex') } }, isActive: true };
    const b = { tabs: [viewerTab()], activeTab: viewerTab(), isActive: false };
    assert.ok(pairedGroup([a, b], b) === a);
    assert.strictEqual(decideFollow([a, b], OPTS).action, 'restore');
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
