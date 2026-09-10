'use strict';

/**
 * Should the paper be on screen right now?
 *
 * The Page view auto-hides so it is never left pinned beside an unrelated
 * file. The first rule for that was "whatever tab is in FRONT is not a .tex,
 * put the paper away", which held only while every non-editor thing lived in a
 * side bar. It stopped holding the moment agent sessions started opening as
 * editor tabs: clicking one made it the active tab, the rule saw a webview
 * that was not the viewer, and the paper vanished — the reader had not left
 * their .tex at all, they had glanced at a panel beside it.
 *
 * So the question the code asks is now a different one, and a local one: not
 * "what is focused" but "what is the paper sitting NEXT TO". The paper's own
 * editor group is located by its tab, its neighbour (the group to the left,
 * where the source lives) is read, and only that group's active tab decides.
 * Focus anywhere else — another group, a terminal, an agent panel — cannot
 * move the paper, because it changes nothing about what the paper is paired
 * with.
 *
 * The second rule is that hiding needs POSITIVE evidence: the neighbour must
 * be showing a real file of the wrong type. A tab that is not a file at all
 * (a webview, a terminal, a settings page, an empty group) has no type to
 * judge, so it leaves the paper alone. Between "hide a paper the reader still
 * wants" and "leave one up a moment too long", the second is the cheap
 * mistake — hiding is a real dispose, and coming back costs a reload.
 *
 * Pure: no vscode import, so the decision is testable against literal tab
 * groups. See out/extension/kernel/tests/tex-follow.test.js.
 */

const TEX_RE = /\.tex$/i;

/** The file a tab is showing, if it is showing one at all. */
function tabUri(input) {
    if (!input || typeof input !== 'object') return null;
    // TabInputText / TabInputNotebook / TabInputCustom all carry `uri`.
    if (input.uri && typeof input.uri.fsPath === 'string') return input.uri;
    // A diff tab names two files; the right-hand side is the one being edited.
    if (input.modified && typeof input.modified.fsPath === 'string') return input.modified;
    if (input.original && typeof input.original.fsPath === 'string') return input.original;
    return null;
}

/**
 * What kind of thing is this tab?
 *
 *   viewer — our own Page view
 *   file   — a real file, `tex` says whether it is one of ours
 *   opaque — a webview, terminal, settings page, welcome page, empty slot:
 *            something with no file type to judge
 *
 * The viewer test comes first because a custom editor tab carries BOTH a
 * viewType and a uri; the duck-typing is deliberate, since the Tab* input
 * classes are not present in every host and `instanceof` would throw on hosts
 * that lack them.
 */
function classifyTab(tab, viewType) {
    const input = tab && tab.input;
    if (!input || typeof input !== 'object') return { kind: 'opaque', uri: null, tex: false };
    if (viewType && typeof input.viewType === 'string' && input.viewType.includes(viewType)) {
        return { kind: 'viewer', uri: null, tex: false };
    }
    const uri = tabUri(input);
    if (!uri) return { kind: 'opaque', uri: null, tex: false };
    return { kind: 'file', uri, tex: TEX_RE.test(uri.fsPath) };
}

/** `vscode.window.tabGroups`, a bare array of groups, or nothing. */
function normalizeGroups(tabGroups) {
    if (Array.isArray(tabGroups)) return tabGroups;
    if (tabGroups && Array.isArray(tabGroups.all)) return tabGroups.all;
    return null;
}

const columnOf = (g) => (g && typeof g.viewColumn === 'number' ? g.viewColumn : NaN);

/** The group holding the Page view, found by its tab rather than its column. */
function findViewerGroup(groups, viewType) {
    for (const g of groups) {
        const tabs = Array.isArray(g && g.tabs) ? g.tabs : [];
        for (const t of tabs) if (classifyTab(t, viewType).kind === 'viewer') return g;
    }
    return null;
}

/**
 * The group the paper is paired with: its neighbour on the LEFT, which is
 * where the source sits in the arrangement the viewer opens into
 * (`ViewColumn.Beside`). A paper opened into column one instead pairs with the
 * group on its right, so the rule still has something to follow.
 */
function pairedGroup(groups, viewerGroup) {
    const vc = columnOf(viewerGroup);
    if (!Number.isFinite(vc)) return groups.find(g => g !== viewerGroup) || null;
    let left = null;
    let right = null;
    for (const g of groups) {
        if (g === viewerGroup) continue;
        const c = columnOf(g);
        if (!Number.isFinite(c)) continue;
        if (c < vc && (!left || c > columnOf(left))) left = g;
        if (c > vc && (!right || c < columnOf(right))) right = g;
    }
    return left || right;
}

const activeGroup = (groups) => groups.find(g => g && g.isActive) || null;

/**
 * @returns {{action: 'restore'|'hide'|'none'|'legacy', uri: object|null, reason: string}}
 *   restore — bring the paper up (or retitle it) for `uri`
 *   hide    — put it away
 *   none    — nothing about the pairing changed; leave it exactly as it is
 *   legacy  — no tab-group API on this host; the caller falls back
 */
function decideFollow(tabGroups, opts) {
    const viewType = (opts && opts.viewType) || '';
    const groups = normalizeGroups(tabGroups);
    if (!groups) return { action: 'legacy', uri: null, reason: 'no tab-group API' };

    const viewerGroup = findViewerGroup(groups, viewType);
    if (!viewerGroup) {
        // The paper is not on screen — auto-hidden, or a host that does not
        // report webview tabs. There is nothing to hide, so the only move is
        // back up, and only on the positive signal of a .tex in front.
        const active = activeGroup(groups);
        const c = classifyTab(active && active.activeTab, viewType);
        if (c.kind === 'file' && c.tex) {
            return { action: 'restore', uri: c.uri, reason: 'a .tex is in front and the paper is away' };
        }
        return { action: 'none', uri: null, reason: 'the paper is not on screen' };
    }

    const paired = pairedGroup(groups, viewerGroup);
    if (!paired) return { action: 'none', uri: null, reason: 'the paper has no neighbouring group' };

    const c = classifyTab(paired.activeTab, viewType);
    if (c.kind === 'file' && c.tex) {
        return { action: 'restore', uri: c.uri, reason: 'the neighbouring group is showing a .tex' };
    }
    if (c.kind === 'file') {
        return { action: 'hide', uri: c.uri, reason: 'the neighbouring group is showing a file that is not a .tex' };
    }
    return { action: 'none', uri: null, reason: `nothing to judge beside the paper (${c.kind})` };
}

module.exports = {
    TEX_RE, tabUri, classifyTab, normalizeGroups, findViewerGroup, pairedGroup, activeGroup, decideFollow,
};
