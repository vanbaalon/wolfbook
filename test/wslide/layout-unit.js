#!/usr/bin/env node
'use strict';
/* ============================================================================
 * Phase 4 Item 11b — layout reflow unit tests (pure Node, no browser).
 *
 * Extracts the LIVE applyLayoutToSlide() from media/wslide-editor.html and proves
 * the critical invariant: reflowing a slide into ANY template **loses no content**
 * (every existing leaf block survives, with its id), and the structure is sane.
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, '../../media/wslide-editor.html'), 'utf8');
const block = (html.match(/\/\/ >>> WSLIDE_LAYOUT_START[\s\S]*?\/\/ <<< WSLIDE_LAYOUT_END/) || [])[0];
if (!block) { console.error('layout markers not found'); process.exit(1); }
const api = new Function(block + '\n;return {applyLayoutToSlide,_collectLeaves};')();

let pass = 0, fail = 0;
const ok = (name, cond, detail) => cond ? (pass++, console.log('\x1b[32m✓\x1b[0m ' + name))
  : (fail++, console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n    ' + detail : ''}`));

function leafIds(node, out = []) {
  (node.children || []).forEach(b => { if ((b.children || []).length) leafIds(b, out); else out.push(b.id); });
  return out;
}
const srcSlide = () => ({
  id: 's1', label: 'orig', background: '#abc', layout: 'column',
  children: [
    { id: 'h', type: 'heading', level: 1, content: 'Title' },
    { id: 'row', type: 'container', layout: 'row', children: [
      { id: 't1', type: 'text', content: 'left' },
      { id: 't2', type: 'text', content: 'right' },
    ] },
    { id: 'img', type: 'image', src: 'x.png' },
  ],
}); // leaves: h, t1, t2, img

let _n = 0; const uid = () => 'gen' + (++_n);
const templates = {
  blank:   { build: () => ({ id: uid(), layout: 'column', children: [] }) },
  title:   { build: () => ({ id: uid(), layout: 'column', children: [ { id: uid(), type: 'heading', level: 1, content: 'Title' } ] }) },
  twoCol:  { build: () => ({ id: uid(), layout: 'column', children: [
              { id: uid(), type: 'heading', level: 2, content: 'Heading' },
              { id: uid(), type: 'container', layout: 'row', children: [
                { id: uid(), type: 'text', content: 'L' }, { id: uid(), type: 'text', content: 'R' } ] } ] }) },
};

const origIds = leafIds(srcSlide()).sort();

for (const [name, tpl] of Object.entries(templates)) {
  const s = srcSlide();
  const r = api.applyLayoutToSlide(s, tpl);
  const got = leafIds(r).sort();
  ok(`${name}: no content lost (all leaf ids preserved)`,
     JSON.stringify(got) === JSON.stringify(origIds),
     `orig=${origIds.join(',')}  got=${got.join(',')}`);
  ok(`${name}: leaf count preserved (${origIds.length})`, leafIds(r).length === origIds.length);
  ok(`${name}: adopted template layout`, r.layout === tpl.build().layout);
  ok(`${name}: slide identity kept`, r.id === 's1' && r.label === 'orig' && r.background === '#abc');
}

// Structural spot-check: twoCol has 3 slots, 4 leaves → 4th appends into the row container.
{
  const r = api.applyLayoutToSlide(srcSlide(), templates.twoCol);
  const row = (r.children || []).find(b => b.children);
  ok('twoCol: leftover leaf appended into a container (row has 3 children)', row && row.children.length === 3,
     row ? `row has ${row.children.length}` : 'no row container');
}
// Blank (0 slots) → everything appends to root.
{
  const r = api.applyLayoutToSlide(srcSlide(), templates.blank);
  ok('blank: all 4 leaves land at root', (r.children || []).length === 4);
}

console.log('');
if (fail) { console.log(`\x1b[31m\x1b[1mLAYOUT UNIT FAILED — ${fail} failed, ${pass} passed.\x1b[0m`); process.exit(1); }
console.log(`\x1b[32m\x1b[1mLAYOUT UNIT PASSED — ${pass}/${pass}.\x1b[0m`);
