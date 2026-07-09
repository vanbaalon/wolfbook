#!/usr/bin/env node
'use strict';
/* Stage 1a — smart-guide snapping geometry, pure-Node unit tests.
 * Extracts the LIVE computeSnap() from media/wslide-editor.html and checks it. */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.resolve(__dirname, '../../media/wslide-editor.html'), 'utf8');
const block = (html.match(/\/\/ >>> WSLIDE_SNAP_START[\s\S]*?\/\/ <<< WSLIDE_SNAP_END/) || [])[0];
if (!block) { console.error('snap markers not found'); process.exit(1); }
const { computeSnap } = new Function(block + '\n;return { computeSnap };')();

let pass = 0, fail = 0;
const ok = (n, c, d) => c ? (pass++, console.log('\x1b[32m✓\x1b[0m ' + n))
  : (fail++, console.log(`\x1b[31m✗ ${n}\x1b[0m${d ? '\n   ' + d : ''}`));

const CX = [0, 960, 1920], CY = [0, 540, 1080];
let s;
s = computeSnap({ left: 5, top: 300, w: 100, h: 50 }, CX, CY, 8);
ok('snap left edge → 0', s.adjX === -5 && s.guidesX[0] === 0, JSON.stringify(s));
s = computeSnap({ left: 908, top: 0, w: 100, h: 50 }, CX, CY, 8);
ok('snap centre → 960', s.adjX === 2 && s.guidesX[0] === 960, JSON.stringify(s));
s = computeSnap({ left: 50, top: 300, w: 100, h: 50 }, CX, CY, 8);
ok('no snap when far', s.adjX === 0 && s.guidesX.length === 0, JSON.stringify(s));
s = computeSnap({ left: 3, top: 300, w: 100, h: 50 }, [0, 960], CY, 8);
ok('closest target wins (left 3 → 0)', s.adjX === -3, JSON.stringify(s));
s = computeSnap({ left: 500, top: 544, w: 100, h: 50 }, CX, CY, 8);
ok('snap top → 540', s.adjY === -4 && s.guidesY[0] === 540, JSON.stringify(s));
s = computeSnap({ left: 0, top: 1026, w: 50, h: 50 }, [0], CY, 8);
ok('snap bottom → 1080', s.adjY === 4 && s.guidesY[0] === 1080, JSON.stringify(s));
// snap to a sibling edge (e.g. another block's left at x=700)
s = computeSnap({ left: 703, top: 200, w: 100, h: 50 }, [0, 700, 960, 1920], CY, 8);
ok('snap to sibling edge 700', s.adjX === -3 && s.guidesX[0] === 700, JSON.stringify(s));

console.log('');
if (fail) { console.log(`\x1b[31m\x1b[1mSNAP UNIT FAILED — ${fail}.\x1b[0m`); process.exit(1); }
console.log(`\x1b[32m\x1b[1mSNAP UNIT PASSED — ${pass}/${pass}.\x1b[0m`);
