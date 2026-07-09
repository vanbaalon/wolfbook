#!/usr/bin/env node
'use strict';
/* Stage 3a — design-verb library, pure-Node unit tests.
 * Extracts the LIVE WSLIDE_VERBS from media/wslide-editor.html and checks each verb's
 * geometry + style-hygiene + human changelog. Pure (no DOM), like snap-unit/shape-unit. */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.resolve(__dirname, '../../media/wslide-editor.html'), 'utf8');
const block = (html.match(/\/\/ >>> WSLIDE_VERBS_START[\s\S]*?\/\/ <<< WSLIDE_VERBS_END/) || [])[0];
if (!block) { console.error('verb markers not found'); process.exit(1); }
const { WSLIDE_VERBS } = new Function(block + '\n;return { WSLIDE_VERBS };')();
const V = WSLIDE_VERBS;

let pass = 0, fail = 0;
const ok = (n, c, d) => c ? (pass++, console.log('\x1b[32m✓\x1b[0m ' + n))
  : (fail++, console.log(`\x1b[31m✗ ${n}\x1b[0m${d ? '\n   ' + String(d).slice(0, 200) : ''}`));
// three items: a left/top ragged column
const mk = () => [
  { id: 'a', x: 100, y: 100, w: 200, h: 80 },
  { id: 'b', x: 130, y: 240, w: 160, h: 60 },
  { id: 'c', x: 108, y: 360, w: 240, h: 100 },
];

// ── align ────────────────────────────────────────────────────────────────
{
  const items = mk(); const r = V.align(items, { edge: 'left' });
  ok('align left → all x = bbox.L (100)', items.every(i => i.x === 100), JSON.stringify(items.map(i => i.x)));
  ok('align left changelog + changed ids', /Aligned 2 blocks · left edges/.test(r.changelog[0]) && r.changed.sort().join() === 'b,c', JSON.stringify(r));
}
{
  const items = mk(); V.align(items, { edge: 'right' });
  const R = Math.max(...mk().map(i => i.x + i.w)); // 348
  ok('align right → right edges meet bbox.R', items.every(i => i.x + i.w === R), JSON.stringify(items.map(i => i.x + i.w)));
}
{
  const items = mk(); V.align(items, { edge: 'hcenter' });
  const cx = (100 + 348) / 2; // 224
  ok('align hcenter → centres on bbox.cx', items.every(i => Math.round(i.x + i.w / 2) === cx), JSON.stringify(items.map(i => i.x + i.w / 2)));
}
{
  const items = [{ id: 'a', x: 100, y: 100, w: 200, h: 80 }];
  V.align(items, { edge: 'left', toCanvas: true });
  ok('align toCanvas left → x = 0', items[0].x === 0, JSON.stringify(items[0]));
  const it2 = [{ id: 'a', x: 100, y: 100, w: 200, h: 80 }];
  V.align(it2, { edge: 'hcenter', toCanvas: true });
  ok('align toCanvas hcenter → centred on 1920', Math.round(it2[0].x + it2[0].w / 2) === 960, JSON.stringify(it2[0]));
}

// ── distribute ─────────────────────────────────────────────────────────────
{
  const items = [
    { id: 'a', x: 0, y: 0, w: 100, h: 50 },     // centre 50
    { id: 'b', x: 40, y: 0, w: 100, h: 50 },    // middle, will move
    { id: 'c', x: 400, y: 0, w: 100, h: 50 },   // centre 450
  ];
  const r = V.distribute(items, { axis: 'h' });
  const mid = items.find(i => i.id === 'b');
  ok('distribute h → middle centre = 250', Math.round(mid.x + mid.w / 2) === 250, JSON.stringify(items.map(i => i.x + i.w / 2)));
  ok('distribute h endpoints fixed', items.find(i => i.id === 'a').x === 0 && items.find(i => i.id === 'c').x === 400, JSON.stringify(items));
  ok('distribute changelog', /Distributed 3 blocks evenly · horizontal/.test(r.changelog[0]), JSON.stringify(r.changelog));
}
ok('distribute <3 is a no-op', V.distribute(mk().slice(0, 2), { axis: 'h' }).changed.length === 0);

// ── matchSize ───────────────────────────────────────────────────────────────
{
  const items = mk(); const r = V.matchSize(items, { dim: 'wh', refId: 'a' });
  ok('matchSize wh → others take ref size (200×80)', items.filter(i => i.id !== 'a').every(i => i.w === 200 && i.h === 80), JSON.stringify(items));
  ok('matchSize ref unchanged + changelog', items[0].w === 200 && /Matched size of 2 blocks/.test(r.changelog[0]), JSON.stringify(r));
  const w = mk(); V.matchSize(w, { dim: 'w', refId: 'b' });
  ok('matchSize w only touches width', w.filter(i => i.id !== 'b').every(i => i.w === 160) && w.find(i => i.id === 'a').h === 80, JSON.stringify(w));
}

// ── snapToGrid ────────────────────────────────────────────────────────────────
{
  const items = mk(); const r = V.snapToGrid(items, { grid: 20 });
  ok('snapToGrid → x/y multiples of 20', items.every(i => i.x % 20 === 0 && i.y % 20 === 0), JSON.stringify(items.map(i => [i.x, i.y])));
  ok('snapToGrid nearest (130→140, 108→100)', items[1].x === 140 && items[2].x === 100, JSON.stringify(items.map(i => i.x)));
  // item a (100,100) is already on-grid, so only b & c report as changed:
  ok('snapToGrid leaves size alone by default', items[0].w === 200 && items[0].h === 80 && /Snapped 2 blocks to 20px grid/.test(r.changelog[0]), JSON.stringify(r));
  const s = [{ id: 'a', x: 3, y: 3, w: 7, h: 7 }]; V.snapToGrid(s, { grid: 20, size: true });
  ok('snapToGrid size:true clamps w/h to >= grid', s[0].w === 20 && s[0].h === 20, JSON.stringify(s[0]));
}

// ── centerOnCanvas ──────────────────────────────────────────────────────────────
{
  const items = mk(); V.centerOnCanvas(items, { axis: 'both' });
  const L = Math.min(...items.map(i => i.x)), R = Math.max(...items.map(i => i.x + i.w));
  const T = Math.min(...items.map(i => i.y)), B = Math.max(...items.map(i => i.y + i.h));
  ok('centerOnCanvas both → bbox centred on 960/540', Math.abs((L + R) / 2 - 960) <= 1 && Math.abs((T + B) / 2 - 540) <= 1, JSON.stringify({ cx: (L + R) / 2, cy: (T + B) / 2 }));
  const items2 = mk(); V.centerOnCanvas(items2, { axis: 'h' });
  ok('centerOnCanvas h leaves y untouched', items2.every((i, k) => i.y === mk()[k].y), JSON.stringify(items2.map(i => i.y)));
}

// ── stack ─────────────────────────────────────────────────────────────────────
{
  const items = mk(); const r = V.stack(items, { axis: 'v', gap: 24 });
  const byY = items.slice().sort((a, b) => a.y - b.y);
  ok('stack v → first stays at its y (100)', byY[0].y === 100, JSON.stringify(byY.map(i => i.y)));
  ok('stack v → each next = prev.bottom + 24', byY[1].y === byY[0].y + byY[0].h + 24 && byY[2].y === byY[1].y + byY[1].h + 24, JSON.stringify(byY.map(i => [i.y, i.h])));
  ok('stack v → cross-aligned to first x', items.every(i => i.x === byY[0].x), JSON.stringify(items.map(i => i.x)));
  ok('stack changelog', /Stacked 3 blocks · vertical, 24px gap/.test(r.changelog[0]), JSON.stringify(r.changelog));
}
ok('stack <2 is a no-op', V.stack([mk()[0]], { axis: 'v' }).changed.length === 0);

// ── tidy (composer recipe) ────────────────────────────────────────────────────────
{
  const items = mk(); const r = V.tidy(items, { grid: 20, gap: 24 });
  const byY = items.slice().sort((a, b) => a.y - b.y);
  // x stays grid-aligned (snap + left-align); y follows the stack gap arithmetic, not the grid.
  ok('tidy → x grid-aligned & first block snapped', items.every(i => i.x % 20 === 0) && byY[0].y % 20 === 0, JSON.stringify(items.map(i => [i.x, i.y])));
  ok('tidy → left-aligned (tall selection ⇒ column)', items.every(i => i.x === items[0].x), JSON.stringify(items.map(i => i.x)));
  ok('tidy → stacked with 24px gaps', byY[1].y === byY[0].y + byY[0].h + 24, JSON.stringify(byY.map(i => [i.y, i.h])));
  ok('tidy changelog mentions column', /Tidied 3 blocks · column/.test(r.changelog[0]), JSON.stringify(r.changelog));
  const one = [{ id: 'a', x: 33, y: 47, w: 100, h: 50 }]; const r1 = V.tidy(one, { grid: 20 });
  ok('tidy 1 block → just snaps', one[0].x === 40 && one[0].y === 40 && /Snapped 1 block/.test(r1.changelog[0]), JSON.stringify({ one, r1 }));
}

// ── dedupeStyles ──────────────────────────────────────────────────────────────────
{
  const sty = () => ({ color: '#123', fontSize: '32px' });
  const blocks = [
    { id: 'a', style: sty() }, { id: 'b', style: sty() }, { id: 'c', style: sty() },
    { id: 'd', style: { color: '#999', fontSize: '18px' } },     // unique — untouched
    { id: 'e', style: { color: '#f00' } },                        // 1-key — below threshold
  ];
  const presets = {};
  const r = V.dedupeStyles(blocks, presets, { minShare: 3 });
  ok('dedupe promotes the 3-block group', ['a', 'b', 'c'].every(id => blocks.find(b => b.id === id).stylePreset === 'auto1'), JSON.stringify(blocks.map(b => [b.id, b.stylePreset])));
  ok('dedupe deletes inline style on promoted', ['a', 'b', 'c'].every(id => !blocks.find(b => b.id === id).style), JSON.stringify(blocks));
  ok('dedupe mints preset def', presets.auto1 && presets.auto1.color === '#123' && presets.auto1.fontSize === '32px', JSON.stringify(presets));
  ok('dedupe leaves unique + trivial blocks alone', blocks.find(b => b.id === 'd').style && !blocks.find(b => b.id === 'd').stylePreset && blocks.find(b => b.id === 'e').style && !blocks.find(b => b.id === 'e').stylePreset, JSON.stringify(blocks.filter(b => 'de'.includes(b.id))));
  ok('dedupe changelog', /Promoted 3 blocks → preset "auto1"/.test(r.changelog[0]), JSON.stringify(r.changelog));
}
{
  // reuse an existing preset with the same definition instead of minting a new one
  const blocks = [
    { id: 'a', style: { color: '#123', fontSize: '32px' } },
    { id: 'b', style: { color: '#123', fontSize: '32px' } },
    { id: 'c', style: { color: '#123', fontSize: '32px' } },
  ];
  const presets = { lead: { fontSize: '32px', color: '#123' } };
  V.dedupeStyles(blocks, presets, { minShare: 3 });
  ok('dedupe reuses matching existing preset (no auto1)', blocks.every(b => b.stylePreset === 'lead') && !presets.auto1, JSON.stringify({ blocks: blocks.map(b => b.stylePreset), presets: Object.keys(presets) }));
}
ok('dedupe below minShare is a no-op', (() => { const b = [{ id: 'a', style: { color: '#1', fontSize: '2px' } }, { id: 'b', style: { color: '#1', fontSize: '2px' } }]; const r = V.dedupeStyles(b, {}, { minShare: 3 }); return r.changed.length === 0 && b.every(x => x.style && !x.stylePreset); })());

console.log('');
if (fail) { console.log(`\x1b[31m\x1b[1mVERB UNIT FAILED — ${fail}.\x1b[0m`); process.exit(1); }
console.log(`\x1b[32m\x1b[1mVERB UNIT PASSED — ${pass}/${pass}.\x1b[0m`);
