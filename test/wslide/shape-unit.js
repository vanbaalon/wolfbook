#!/usr/bin/env node
'use strict';
/* Stage 2 — shape SVG generator, pure-Node unit tests + editor/exporter parity. */
const fs = require('fs');
const path = require('path');

const editorHtml = fs.readFileSync(path.resolve(__dirname, '../../media/wslide-editor.html'), 'utf8');
const exporterJs = fs.readFileSync(path.resolve(__dirname, '../../out/extension/slideExporter.js'), 'utf8');

const block = (editorHtml.match(/\/\/ >>> WSLIDE_SHAPE_START[\s\S]*?\/\/ <<< WSLIDE_SHAPE_END/) || [])[0];
if (!block) { console.error('shape markers not found'); process.exit(1); }
const { buildShapeSVG } = new Function(block + '\n;return { buildShapeSVG };')();

let pass = 0, fail = 0;
const ok = (n, c, d) => c ? (pass++, console.log('\x1b[32m✓\x1b[0m ' + n))
  : (fail++, console.log(`\x1b[31m✗ ${n}\x1b[0m${d ? '\n   ' + d.slice(0, 160) : ''}`));

const S = (o) => buildShapeSVG(Object.assign({ id: 't', w: 300, h: 200 }, o));

ok('rect: <rect> + correct viewBox', /<rect /.test(S({ shape: 'rect' })) && S({ shape: 'rect' }).includes('viewBox="0 0 300 200"'), S({ shape: 'rect' }));
ok('roundRect: has rx', /<rect[^>]*rx="18"/.test(S({ shape: 'roundRect' })), S({ shape: 'roundRect' }));
ok('ellipse: <ellipse>', /<ellipse /.test(S({ shape: 'ellipse' })));
ok('triangle: <polygon> (3 pts)', (S({ shape: 'triangle' }).match(/,/g) || []).length >= 2 && /<polygon /.test(S({ shape: 'triangle' })));
ok('diamond: <polygon>', /<polygon /.test(S({ shape: 'diamond' })));
ok('highlight: rect, no stroke', /<rect /.test(S({ shape: 'highlight' })) && !/stroke=/.test(S({ shape: 'highlight' })), S({ shape: 'highlight' }));
ok('cloud: <path>', /<path /.test(S({ shape: 'cloud' })));
ok('callout: rect + tail path', /<rect /.test(S({ shape: 'callout' })) && /<path /.test(S({ shape: 'callout' })));
{
  const line = S({ shape: 'line', points: [[0, .5], [1, .5]], headEnd: 'arrow', stroke: '#123456', strokeWidth: 3 });
  ok('line: <line> + marker-end + <marker>', /<line /.test(line) && /marker-end="url\(#he_t\)"/.test(line) && /<marker /.test(line), line);
  ok('line: no head when none', !/<marker /.test(S({ shape: 'line' })));
}
ok('valid svg open/close', S({ shape: 'rect' }).startsWith('<svg ') && S({ shape: 'rect' }).endsWith('</svg>'));
ok('custom fill/stroke honoured', S({ shape: 'rect', fill: '#abcdef', stroke: '#012345', strokeWidth: 5 }).includes('fill="#abcdef"') && S({ shape: 'rect', fill: '#abcdef', stroke: '#012345', strokeWidth: 5 }).includes('stroke="#012345"'));

// Editor/exporter parity — the two buildShapeSVG bodies must be identical.
function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  // brace-match from the first {
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (!depth) break; } }
  return src.slice(i, k + 1).replace(/\s+/g, ' ').trim();
}
const eFn = extractFn(editorHtml, 'buildShapeSVG'), xFn = extractFn(exporterJs, 'buildShapeSVG');
ok('editor/exporter buildShapeSVG identical', eFn && xFn && eFn === xFn, eFn && xFn ? 'differ' : 'missing');

console.log('');
if (fail) { console.log(`\x1b[31m\x1b[1mSHAPE UNIT FAILED — ${fail}.\x1b[0m`); process.exit(1); }
console.log(`\x1b[32m\x1b[1mSHAPE UNIT PASSED — ${pass}/${pass}.\x1b[0m`);
