#!/usr/bin/env node
'use strict';
/* Stage 3c — applyPlan (webview): pure-Node unit tests. Extracts the LIVE WSLIDE_VERBS +
 * WSLIDE_PLAN marker blocks from media/wslide-editor.html and checks that an AI design plan
 * applies to a slide correctly: geometry verbs move ABSOLUTE blocks, prose textEdits apply,
 * and math/eval/code/shape content is never reworded. */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.resolve(__dirname, '../../media/wslide-editor.html'), 'utf8');
const verbsBlock = (html.match(/\/\/ >>> WSLIDE_VERBS_START[\s\S]*?\/\/ <<< WSLIDE_VERBS_END/) || [])[0];
const planBlock = (html.match(/\/\/ >>> WSLIDE_PLAN_START[\s\S]*?\/\/ <<< WSLIDE_PLAN_END/) || [])[0];
if (!verbsBlock || !planBlock) { console.error('verb/plan markers not found'); process.exit(1); }
const { WSLIDE_VERBS, applyPlan } = new Function(verbsBlock + '\n' + planBlock + '\n;return { WSLIDE_VERBS, applyPlan };')();

let pass = 0, fail = 0;
const ok = (n, c, d) => c ? (pass++, console.log('\x1b[32m✓\x1b[0m ' + n))
  : (fail++, console.log(`\x1b[31m✗ ${n}\x1b[0m${d ? '\n   ' + String(d).slice(0, 220) : ''}`));

const mkSlide = () => ({
  children: [
    { id: 'a', type: 'text', position: 'absolute', x: 100, y: 100, w: 200, h: 80, content: '<p>one</p>' },
    { id: 'b', type: 'text', position: 'absolute', x: 130, y: 240, w: 160, h: 60, content: '<p>two</p>' },
    { id: 'c', type: 'text', position: 'absolute', x: 108, y: 360, w: 240, h: 100, content: '<p>three</p>' },
    { id: 'm', type: 'math', position: 'absolute', x: 500, y: 100, w: 300, h: 90, content: '$E=mc^2$' },
  ],
});

// ── geometry verb: align left ───────────────────────────────────────────────────
{
  const slide = mkSlide();
  const r = applyPlan(slide, { verbs: [{ op: 'align', params: { edge: 'left' }, ids: ['a', 'b', 'c'] }], textEdits: [], changelog: 'left-aligned' }, WSLIDE_VERBS);
  const byId = {}; slide.children.forEach(b => byId[b.id] = b);
  ok('align left → a,b,c share min x (100)', [byId.a, byId.b, byId.c].every(b => b.x === 100), JSON.stringify([byId.a.x, byId.b.x, byId.c.x]));
  ok('align left → math block untouched', byId.m.x === 500, byId.m.x);
  ok('changed ids = b,c (a already at 100)', r.changedIds.sort().join() === 'b,c', JSON.stringify(r.changedIds));
  ok('changelog prefers plan.changelog', r.changelog[0] === 'left-aligned', JSON.stringify(r.changelog));
}

// ── geometry verb without ids → whole selection (all absolute blocks) ────────────
{
  const slide = mkSlide();
  applyPlan(slide, { verbs: [{ op: 'snapToGrid', params: { grid: 20 } }], textEdits: [] }, WSLIDE_VERBS);
  const byId = {}; slide.children.forEach(b => byId[b.id] = b);
  ok('snapToGrid (no ids) snaps all abs blocks', slide.children.every(b => b.x % 20 === 0 && b.y % 20 === 0), JSON.stringify(slide.children.map(b => [b.x, b.y])));
}

// ── textEdits: prose reworded, protected untouched ───────────────────────────────
{
  const slide = mkSlide();
  const r = applyPlan(slide, {
    verbs: [],
    textEdits: [
      { id: 'a', content: '<p>ONE!</p>' },       // prose → applied
      { id: 'm', content: '$hacked$' },           // math → ignored by applyPlan too (defence in depth)
    ],
    changelog: 'reworded a',
  }, WSLIDE_VERBS);
  const byId = {}; slide.children.forEach(b => byId[b.id] = b);
  ok('textEdit rewords prose block a', byId.a.content === '<p>ONE!</p>', byId.a.content);
  ok('textEdit refuses to touch math content', byId.m.content === '$E=mc^2$', byId.m.content);
  ok('changed ids = [a]', JSON.stringify(r.changedIds) === '["a"]', JSON.stringify(r.changedIds));
}

// ── styleEdits: restyle any block, including math + flow (the "make it blue" fix) ──
{
  const slide = mkSlide();
  const r = applyPlan(slide, {
    verbs: [], textEdits: [],
    styleEdits: [
      { id: 'a', style: { color: 'blue', fontSize: '48px' } },
      { id: 'm', style: { color: '#e11d48' } },   // restyling math IS allowed (not a content rewrite)
    ],
    changelog: 'coloured a + m',
  }, WSLIDE_VERBS);
  const byId = {}; slide.children.forEach(b => byId[b.id] = b);
  ok('styleEdit merges into block.style', byId.a.style && byId.a.style.color === 'blue' && byId.a.style.fontSize === '48px', JSON.stringify(byId.a.style));
  ok('styleEdit restyles math block (allowed)', byId.m.style && byId.m.style.color === '#e11d48', JSON.stringify(byId.m.style));
  ok('styleEdit does NOT touch math content', byId.m.content === '$E=mc^2$', byId.m.content);
  ok('styleEdit changed ids = a,m', r.changedIds.sort().join() === 'a,m', JSON.stringify(r.changedIds));
}
{
  // flow block (no position) can still be restyled — this is the columns-layout case
  const slide = { children: [{ id: 'f', type: 'text', content: '<p>Column 1</p>' }] };
  const r = applyPlan(slide, { verbs: [], textEdits: [], styleEdits: [{ id: 'f', style: { color: 'blue' } }] }, WSLIDE_VERBS);
  ok('styleEdit works on flow block (creates style)', slide.children[0].style && slide.children[0].style.color === 'blue' && r.changedIds[0] === 'f', JSON.stringify(slide.children[0]));
}

// ── flow (non-absolute) blocks are not moved by geometry verbs ───────────────────
{
  const slide = { children: [
    { id: 'f1', type: 'text', content: '<p>x</p>' },   // flow, no position/x/y/w/h
    { id: 'f2', type: 'text', content: '<p>y</p>' },
  ]};
  const r = applyPlan(slide, { verbs: [{ op: 'align', params: { edge: 'left' } }], textEdits: [] }, WSLIDE_VERBS);
  ok('flow blocks unchanged by geometry verb', r.changedIds.length === 0 && slide.children.every(b => b.x === undefined), JSON.stringify(r.changedIds));
}

// ── empty / no-op plan ───────────────────────────────────────────────────────────
{
  const slide = mkSlide();
  const r = applyPlan(slide, { verbs: [], textEdits: [], changelog: '' }, WSLIDE_VERBS);
  ok('empty plan → no changes', r.changedIds.length === 0, JSON.stringify(r));
}

console.log('');
if (fail) { console.log(`\x1b[31m\x1b[1mPLAN UNIT FAILED — ${fail}.\x1b[0m`); process.exit(1); }
console.log(`\x1b[32m\x1b[1mPLAN UNIT PASSED — ${pass}/${pass}.\x1b[0m`);
