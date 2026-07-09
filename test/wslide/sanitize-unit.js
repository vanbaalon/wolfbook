#!/usr/bin/env node
'use strict';
/* ============================================================================
 * Phase 2 sanitizer — pure-Node unit tests (no browser required).
 *
 * Extracts the LIVE sanitizer helpers from media/wslide-editor.html and tests
 * the parser-independent core: math protect/restore round-trip, the style
 * allow-list, and the allow-list node cleaner (driven with constructed DOM-shaped
 * nodes). The full sanitizeRichHtml() additionally needs a browser HTML parser —
 * that end-to-end path is covered by sanitize-gate.js (headless Chromium).
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, '../../media/wslide-editor.html'), 'utf8');
const block = (html.match(/\/\/ >>> WSLIDE_SANITIZER_START[\s\S]*?\/\/ <<< WSLIDE_SANITIZER_END/) || [])[0];
if (!block) { console.error('sanitizer markers not found'); process.exit(1); }

// Function declarations don't execute their body, so sanitizeRichHtml's reference
// to `document` is never hit here — we only call the DOM-free helpers.
const api = new Function(block + '\n;return {_mathProtect,_mathRestore,_rStyleFilter,_rCleanNode,_rEscText,_rEscAttr};')();

// Constructed DOM-shaped nodes (the exact shape _rCleanNode consumes).
const txt = s => ({ nodeType: 3, nodeValue: s });
const el  = (tag, children = [], attrs = {}) => ({ nodeType: 1, tagName: tag, childNodes: children, getAttribute: k => (attrs[k] != null ? attrs[k] : null) });

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log('\x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log(`\x1b[31m✗ ${name}\x1b[0m\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('\x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n    ' + detail : ''}`); }
}

// ── Math protect/restore round-trip (the bug-prone part) ──────────────────────
for (const m of [
  'Energy $E=mc^2$ and $a &lt; b$ end',
  '$$\\frac{1}{2}$$ display',
  'no math here at all 12345',
  'mixed $x$ text 99 and $$\\sum_{i=1}^n i$$',
]) {
  const { prot, tokens } = api._mathProtect(m);
  eq('math round-trip: ' + JSON.stringify(m).slice(0, 40), api._mathRestore(prot, tokens), m);
}
// Plain digits in text must NOT be corrupted by restore (delimiter-scoped).
{
  const { prot, tokens } = api._mathProtect('price 100 dollars');
  ok('digits in text survive (no token collision)', api._mathRestore(prot, tokens) === 'price 100 dollars');
}

// ── Style allow-list ──────────────────────────────────────────────────────────
eq('style: keep allow-listed, drop the rest',
  api._rStyleFilter('color:#fff; margin:0; mso-pagination:none; font-size:24px; font-weight:bold'),
  'color:#fff;font-size:24px;font-weight:bold');
eq('style: drop url()/expression values',
  api._rStyleFilter('background-color:url(x); color:red'), 'color:red');
eq('style: empty in → empty out', api._rStyleFilter(''), '');

// ── Escaping ──────────────────────────────────────────────────────────────────
eq('escText', api._rEscText('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
eq('escAttr', api._rEscAttr('x"y<z'), 'x&quot;y&lt;z');

// ── Node cleaning (allow-list) ────────────────────────────────────────────────
eq('text node escaped', api._rCleanNode(txt('a & b <')), 'a &amp; b &lt;');
eq('unknown tags unwrapped (table→text)',
  api._rCleanNode(el('TABLE', [el('TR', [el('TD', [txt('cell')])])])), 'cell');
eq('span with allowed style kept',
  api._rCleanNode(el('SPAN', [txt('x')], { style: 'color:#fff;margin:0' })), '<span style="color:#fff">x</span>');
eq('styleless span unwrapped', api._rCleanNode(el('SPAN', [txt('x')], {})), 'x');
eq('font→span colour', api._rCleanNode(el('FONT', [txt('Red')], { color: '#ff0000' })), '<span style="color:#ff0000">Red</span>');
eq('empty inline tag dropped', api._rCleanNode(el('B', [])), '');
eq('non-empty bold kept', api._rCleanNode(el('B', [txt('hi')])), '<b>hi</b>');
eq('javascript: href stripped', api._rCleanNode(el('A', [txt('x')], { href: 'javascript:alert(1)' })), '<a>x</a>');
eq('safe href kept', api._rCleanNode(el('A', [txt('x')], { href: 'https://x.com' })), '<a href="https://x.com">x</a>');
eq('br preserved', api._rCleanNode(el('BR', [])), '<br>');
eq('script node dropped with its content', api._rCleanNode(el('SCRIPT', [txt('alert(1)')])), '');
eq('style node dropped with its content', api._rCleanNode(el('STYLE', [txt('.x{color:red}')])), '');
eq('nested allowed tags', api._rCleanNode(el('B', [el('I', [txt('hi')])])), '<b><i>hi</i></b>');

console.log('');
if (fail) { console.log(`\x1b[31m\x1b[1mUNIT FAILED — ${fail} failed, ${pass} passed.\x1b[0m`); process.exit(1); }
console.log(`\x1b[32m\x1b[1mUNIT PASSED — ${pass}/${pass}.\x1b[0m`);
