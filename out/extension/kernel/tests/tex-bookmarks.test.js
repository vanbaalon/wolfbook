'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { makeVscodeStub } = require('./_stub-vscode');
const original = Module._load, stub = makeVscodeStub();
let TexViewer;
try {
    Module._load = function(name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
    ({ TexViewer } = require('../../tex/texViewer'));
} finally { Module._load = original; }
let saved;
const host = { _viewState: {}, _semanticViewCell: p => ({ file: 'p.tex', stableKey: 'paragraph', line: p.focusYTopBp }),
    _rememberState: (_, patch) => { saved = patch; } };
const bookmark = { id: 'b1', page: 2, x: 100, y: 200, section: '§ 2.1', at: 1, height: 800 };
TexViewer.prototype._rememberView.call(host, 'p.tex', 1, 0, { generation: 1, bookmarks: [bookmark] });
assert.equal(saved.bookmarks[0].viewCell.stableKey, 'paragraph');
assert.equal(saved.bookmarks[0].height, 800);
host._viewState = saved;
host._semanticViewCell = () => { throw Error('existing anchors must not be replaced by shifted coordinates'); };
TexViewer.prototype._rememberView.call(host, 'p.tex', 1, 0, { generation: 1, bookmarks: [bookmark] });
assert.equal(saved.bookmarks[0].viewCell.stableKey, 'paragraph');
const relocated = TexViewer.prototype._bookmarkPlacements.call({ _viewCellPlacement: () => ({ rects: [{ page: 3, x: 90, y: 300 }] }) }, saved.bookmarks, 2);
assert.equal(relocated[0].page, 3); assert.equal(relocated[0].approximate, false);
const missing = TexViewer.prototype._bookmarkPlacements.call({ _viewCellPlacement: () => null }, saved.bookmarks, 2);
assert.equal(missing[0].page, 2); assert.equal(missing[0].approximate, true);
TexViewer.prototype._rememberView.call(host, 'p.tex', 1, 0, { generation: 1, bookmarks: [] });
assert.equal(saved.bookmarks.length, 0, 'deletion persists, including the last bookmark');
host._semanticViewCell = p=>({file:'p.tex',line:p.focusYTopBp});
const personal=Array.from({length:200},(_,i)=>({...bookmark,id:`personal-${i}`}));
const returnBookmark={...bookmark,id:'review-start-1',viewportFrac:.42};
TexViewer.prototype._rememberView.call(host,'p.tex',1,0,{generation:1,bookmarks:[...personal,returnBookmark]});
assert.equal(saved.bookmarks.length,201,'the review return point never displaces a personal bookmark');
assert.equal(saved.bookmarks.at(-1).viewportFrac,.42,'the original viewport position survives persistence');
assert.equal(TexViewer.prototype._bookmarkPlacements.call({_viewCellPlacement:()=>({rects:[{page:4,x:70,y:250}]})},
    [saved.bookmarks.at(-1)],2)[0].viewportFrac,.42,'semantic reflow preserves the return alignment');

const client = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
const state = { generation: 1, sections: { generation: 1, items: [
    { kind: 'section', page: 1, y: 100, number: '1' },
    { kind: 'section', page: 2, y: 100, number: '2.1' },
    { kind: 'section', page: 2, y: 400, number: '2.2' },
] } };
const ctx = vm.createContext({ state });
const start = client.indexOf('function bookmarkSection('), end = client.indexOf('\nasync function gotoBookmark', start);
vm.runInContext(client.slice(start, end), ctx);
assert.equal(ctx.bookmarkSection(bookmark), '§ 2.1');
assert.match(ctx.bookmarkLabel(bookmark), /§ 2.1 · p.2/);
assert.equal(ctx.bookmarkCompactLabel({ ...bookmark, approximate: true }), '§ 2.1 · p.2 ≈');
assert.equal(ctx.bookmarkCompactLabel(returnBookmark),'Review start · p.2');
state.sections.items.push({ kind: 'section', page: 3, y: 150, startPage: 3, startY: 100, number: '4' });
assert.equal(ctx.bookmarkSection({ page: 3, y: 105, section: '§ 3.5' }), '§ 4',
    'first line of wrapped heading belongs to new section, including existing saved bookmarks');
assert.equal(ctx.bookmarkSection({ page: 3, y: 90 }), '§ 2.2', 'text before heading still belongs to preceding section');
const headings = [
    { kind: 'section', headingType: 'chapter', key: 'ch', page: 1, y: 20, number: '1' },
    { kind: 'section', headingType: 'section', key: 'sec', page: 1, y: 60, number: '1.1' },
    { kind: 'section', headingType: 'subsection', key: 'sub', page: 1, y: 90, number: '1.1.1' },
    { kind: 'section', headingType: 'subsubsection', key: 'subsub', page: 1, y: 410, number: '1.1.1.1' },
    { kind: 'section', headingType: 'paragraph', key: 'para', page: 1, y: 405 },
    { kind: 'equation', page: 1, y: 95 },
];
const near = ctx.nearbySectionBookmarks(headings, { top: 100, bottom: 400 }, b => b.y);
assert.equal(near.above.id, 'section:sub');
assert.equal(near.below.id, 'section:subsub', 'skip paragraph/equation markers');
assert(near.above.automatic);
assert.equal(ctx.bookmarkSection(near.below), '§ 1.1.1.1', 'automatic link keeps its own heading number');
assert.equal(ctx.nearbySectionBookmarks(headings, { top: 0, bottom: 500 }, b => b.y).above, null);
assert.equal(ctx.nearbySectionBookmarks(headings, { top: 0, bottom: 500 }, b => b.y).below, null);
assert.equal(ctx.nearbySectionBookmarks(headings, { top: 30, bottom: 500 }, b => b.y).above.section, 'Ch. 1');
assert.equal(ctx.nearbySectionBookmarks(headings, { top: 100, bottom: 400 }, () => null).above, null,
    'unmapped headings do not become guessed links');
const revisions = ctx.revisionEdgeLinks([
    { id: 'r1', name: 'Normalization', rects: [{ page: 2, x: 80, y: 200 }] },
    { id: 'page-only', page: 90, section: { number: '12.3' }, rects: [] },
    { id: 'arriving', page: 91, ready: false, rects: [] },
    { id: 'unmapped', rects: [] },
]);
assert.equal(revisions.length, 2, 'all located, ready corrections get transient navigation links');
assert.equal(revisions[0].revisionId, 'r1');
assert.equal(revisions[0].automatic, true, 'revision links are transient, not saved bookmarks');
assert.match(revisions[0].section, /^Δ § 2.1/);
assert.equal(revisions[1].page, 90);
assert.equal(revisions[1].approximate, true);
assert.match(ctx.bookmarkCompactLabel(revisions[1]), /^Δ § 12.3 · p.90 ≈$/);
assert.match(ctx.bookmarkLabel(revisions[1]), /approximate page location/);
const bounds = { top: 100, bottom: 400 };
assert.equal(ctx.revisionBookmarkEdge(revisions[0], bounds, () => 200, 2), null, 'visible exact changes use inline marks');
assert.equal(ctx.revisionBookmarkEdge(revisions[0], bounds, () => 90, 2), 'above');
assert.equal(ctx.revisionBookmarkEdge(revisions[0], bounds, () => null, 35), 'above', 'unmounted earlier pages keep their links');
assert.equal(ctx.revisionBookmarkEdge(revisions[1], bounds, () => null, 35), 'below');
assert.equal(ctx.revisionBookmarkEdge(revisions[1], bounds, () => null, 90), 'above', 'a page hint on the current page remains navigable');
assert.equal(ctx.revisionBookmarkEdge({ ...revisions[0], page: 90 }, bounds, () => null, 35), 'below');
assert.match(client, /rail\.style\.left = `\$\{bounds\.left\}px`/, 'rails attach to the viewer edge without an inset');
assert.match(client, /b\.revisionId \? reviewAct\('show'/, 'revision chips use review navigation, not acceptance');
state.sections.generation = 0;
assert.equal(ctx.bookmarkSection(bookmark), bookmark.section, 'ignore sections from another render');
const gesture = client.indexOf('function bookmarkGesture(');
vm.runInContext(client.slice(gesture, client.indexOf("\npagesEl().addEventListener", gesture)), ctx);
const event = { button: 0, shiftKey: true, target: { closest: () => null } };
assert(ctx.bookmarkGesture(event));
assert(!ctx.bookmarkGesture({ ...event, ctrlKey: true }), 'preserve selection widening');
assert(!ctx.bookmarkGesture({ ...event, target: { closest: () => ({}) } }), 'controls keep their gestures');
assert(!ctx.bookmarkGesture({ ...event, shiftKey: false }), 'plain drag remains selection');
console.log('WPaper bookmarks: persistence, deletion, reflow, fallback, sections and gestures OK');
