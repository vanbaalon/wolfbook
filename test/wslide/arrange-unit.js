#!/usr/bin/env node
'use strict';
/* wolfslide_arrange — host-side align/distribute geometry (out/extension/slideArrange.js).
 * Pure-Node unit tests. Requiring the module must NOT pull `vscode`. */
const path = require('path');
const A = require(path.resolve(__dirname, '../../out/extension/slideArrange.js'));

let pass = 0, fail = 0;
const ok = (n, c, d) => c ? (pass++, console.log('\x1b[32m✓\x1b[0m ' + n))
  : (fail++, console.log(`\x1b[31m✗ ${n}\x1b[0m${d ? '\n   ' + String(d).slice(0, 220) : ''}`));

const mk = () => [
  { id: 'a', x: 100, y: 100, w: 200, h: 80 },
  { id: 'b', x: 130, y: 240, w: 160, h: 60 },
  { id: 'c', x: 108, y: 360, w: 240, h: 100 },
];

// ── align (relative to selection bbox) ─────────────────────────────────────────
{
  const it = mk(); const r = A.align(it, { edge: 'left' });
  ok('align left → all x = bbox.L (100)', it.every(i => i.x === 100), JSON.stringify(it.map(i => i.x)));
  ok('align left changed = b,c', r.changed.sort().join() === 'b,c', JSON.stringify(r));
  ok('align left changelog mentions selection', /relative to selection/.test(r.changelog[0]), r.changelog[0]);
}
{
  const it = mk(); A.align(it, { edge: 'right' });
  const R = Math.max(...mk().map(i => i.x + i.w));   // 348
  ok('align right → right edges meet bbox.R', it.every(i => i.x + i.w === R), JSON.stringify(it.map(i => i.x + i.w)));
}
{
  const it = mk(); A.align(it, { edge: 'vcenter' });
  const cy = (100 + 460) / 2;   // bbox T=100, B=460 → 280
  ok('align vcenter → vertical centres on bbox.cy', it.every(i => Math.round(i.y + i.h / 2) === cy), JSON.stringify(it.map(i => i.y + i.h / 2)));
}
// align relative to slide (canvas)
{
  const it = [{ id: 'a', x: 100, y: 100, w: 200, h: 80 }];
  A.align(it, { edge: 'hcenter', relativeTo: 'slide' });
  ok('align hcenter relativeTo slide → centred on 1920', Math.round(it[0].x + it[0].w / 2) === 960, JSON.stringify(it[0]));
  const it2 = [{ id: 'a', x: 100, y: 500, w: 200, h: 80 }];
  A.align(it2, { edge: 'top', relativeTo: 'slide' });
  ok('align top relativeTo slide → y = 0', it2[0].y === 0, it2[0].y);
}
// invalid edge
ok('align invalid edge → error', !!A.align(mk(), { edge: 'middle' }).error, JSON.stringify(A.align(mk(), { edge: 'middle' })));

// ── distribute ───────────────────────────────────────────────────────────────
{
  const it = [
    { id: 'a', x: 0, y: 0, w: 100, h: 50 },     // centre 50
    { id: 'b', x: 40, y: 0, w: 100, h: 50 },    // middle → moves
    { id: 'c', x: 400, y: 0, w: 100, h: 50 },   // centre 450
  ];
  const r = A.distribute(it, { axis: 'horizontal' });
  const mid = it.find(i => i.id === 'b');
  ok('distribute horizontal → middle centre = 250', Math.round(mid.x + mid.w / 2) === 250, JSON.stringify(it.map(i => i.x + i.w / 2)));
  ok('distribute endpoints fixed', it.find(i => i.id === 'a').x === 0 && it.find(i => i.id === 'c').x === 400, JSON.stringify(it));
  ok('distribute changelog', /Distributed 3 blocks evenly · horizontal/.test(r.changelog[0]), r.changelog[0]);
}
ok('distribute accepts "v" alias', !A.distribute(mk(), { axis: 'v' }).error, JSON.stringify(A.distribute(mk(), { axis: 'v' })));
ok('distribute <3 → error', /needs 3\+/.test(A.distribute(mk().slice(0, 2), { axis: 'horizontal' }).error || ''), JSON.stringify(A.distribute(mk().slice(0, 2), { axis: 'horizontal' })));
ok('distribute bad axis → error', !!A.distribute(mk(), { axis: 'diagonal' }).error);

// ── align + distribute compose (align first, then distribute) ────────────────────
{
  const it = mk();
  A.align(it, { edge: 'left' });               // all x → 100
  A.distribute(it, { axis: 'vertical' });      // even y centres
  const byY = it.slice().sort((p, q) => p.y - q.y);
  ok('compose: left-aligned then vertically distributed', it.every(i => i.x === 100) && Math.round(byY[1].y + byY[1].h / 2) === Math.round((byY[0].y + byY[0].h / 2 + byY[2].y + byY[2].h / 2) / 2), JSON.stringify(it.map(i => [i.x, i.y])));
}

console.log('');
if (fail) { console.log(`\x1b[31m\x1b[1mARRANGE UNIT FAILED — ${fail}.\x1b[0m`); process.exit(1); }
console.log(`\x1b[32m\x1b[1mARRANGE UNIT PASSED — ${pass}/${pass}.\x1b[0m`);
