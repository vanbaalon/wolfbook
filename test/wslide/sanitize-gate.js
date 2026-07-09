#!/usr/bin/env node
'use strict';
/* ============================================================================
 * Phase 2 sanitizer — end-to-end gate (pure Node via linkedom).
 *
 * Extracts the LIVE sanitizeRichHtml() from media/wslide-editor.html and runs it
 * against a real DOM (linkedom — no browser, deterministic) to assert, per case:
 *   • idempotency        sanitize(sanitize(x)) === sanitize(x)
 *   • text preservation  textContent(sanitize(x)) === textContent(x)  (no data loss)
 *   • cruft removal      Word/Pages/font/class/mso/script stripped
 *   • math safety        $…$ / $$…$$ survive verbatim
 *
 * Skips cleanly (exit 0) if linkedom isn't installed, so it never hard-blocks.
 * (Replaces the earlier headless-Chrome version, whose --dump-dom did not exit
 * reliably across environments. Core logic is also covered by sanitize-unit.js.)
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const EDITOR_HTML = path.resolve(__dirname, '../../media/wslide-editor.html');

let parseHTML = null;
try { ({ parseHTML } = require('linkedom')); } catch (_) { /* optional */ }

function extractSanitizer(html) {
  const m = html.match(/\/\/ >>> WSLIDE_SANITIZER_START[\s\S]*?\/\/ <<< WSLIDE_SANITIZER_END/);
  if (!m) throw new Error('sanitizer markers not found in wslide-editor.html');
  return m[0];
}

const CASES = [
  { name: 'nested spans (repeated size+colour)',
    input: '<span style="color:#ff0000"><span style="font-size:24px">Hi</span></span>' },
  { name: 'Word paste cruft',
    input: '<p class="MsoNormal" style="margin:0in;mso-pagination:none"><span style="font-family:Calibri;color:black">Hello <b>world</b></span><o:p></o:p></p>',
    absent: ['class=', 'mso-', '<o:p', 'MsoNormal', 'margin'] },
  { name: 'legacy <font> tag',
    input: '<font color="#ff0000" size="5">Red</font>',
    contains: ['color:#ff0000'], absent: ['<font', 'size='] },
  { name: 'inline math with &lt;',
    input: 'Energy $E=mc^2$ and $a &lt; b$ end',
    contains: ['$E=mc^2$', '$a &lt; b$'] },
  { name: 'display math',
    input: '<div>$$\\frac{1}{2}$$</div>',
    contains: ['$$\\frac{1}{2}$$'] },
  { name: 'clean editor content (no semantic loss)',
    input: '<b>bold</b> <i>it</i> <span style="color:#333333">x</span> <a href="https://x.com">l</a><br>',
    contains: ['<b>bold</b>', '<br>', 'href="https://x.com"', 'color:#333333'] },
  { name: 'javascript: link stripped',
    input: '<a href="javascript:alert(1)">x</a>',
    absent: ['javascript:'] },
  { name: 'disallowed tags unwrapped',
    input: '<table><tr><td>cell</td></tr></table>',
    absent: ['<table', '<td', '<tr'] },
  { name: 'empty inline tags dropped',
    input: '<b></b><span style="color:red"></span>keep',
    contains: ['keep'] },
  { name: 'script stripped (content dropped, not kept as text)',
    input: 'safe<script>alert(1)</scr' + 'ipt>text',
    absent: ['<script', 'alert('], noTextCheck: true },
  { name: 'nested font-size spans collapse to innermost',
    input: '<span style="font-size:26px"><span style="font-size:24px"><span style="font-size:20px">know</span></span></span>',
    contains: ['font-size:20px', 'know'], absent: ['26px', '24px'] },
  { name: 'adjacent identical spans merge',
    input: '<span style="color:#ff0000">a</span><span style="color:#ff0000">b</span>',
    contains: ['ab'], absent: ['</span><span'] },
];

function main() {
  if (!parseHTML) {
    console.log('⚠ linkedom not installed — end-to-end sanitizer gate skipped.');
    console.log('  Enable with:  npm i -D linkedom   (core logic is already covered by `npm run wslide:sanitize-unit`).');
    process.exit(0);
  }
  const { document } = parseHTML('<!DOCTYPE html><html><body></body></html>');
  const src = extractSanitizer(fs.readFileSync(EDITOR_HTML, 'utf8'));
  // Function declarations don't run their body at definition, so passing `document`
  // satisfies sanitizeRichHtml's only browser dependency.
  const { sanitizeRichHtml } = new Function('document', src + '\n;return { sanitizeRichHtml };')(document);
  const tc = html => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent; };

  let fail = 0;
  for (const c of CASES) {
    const notes = [];
    let out;
    try {
      out = sanitizeRichHtml(c.input);
      if (sanitizeRichHtml(out) !== out) notes.push('not idempotent');
      if (!c.noTextCheck && tc(out) !== tc(c.input)) notes.push(`text changed: ${JSON.stringify(tc(c.input))} -> ${JSON.stringify(tc(out))}`);
      for (const inc of (c.contains || [])) if (out.indexOf(inc) < 0) notes.push(`missing "${inc}"`);
      for (const ex of (c.absent || [])) if (out.indexOf(ex) >= 0) notes.push(`should not contain "${ex}"`);
    } catch (e) { notes.push('threw: ' + e.message); }
    if (notes.length) { fail++; console.log(`\x1b[31m✗ ${c.name}\x1b[0m`); notes.forEach(n => console.log('    ' + n)); if (out != null) console.log('    out: ' + out); }
    else console.log('\x1b[32m✓\x1b[0m ' + c.name);
  }
  console.log('');
  if (fail) { console.log(`\x1b[31m\x1b[1mSANITIZER GATE FAILED — ${fail}/${CASES.length}.\x1b[0m`); process.exit(1); }
  console.log(`\x1b[32m\x1b[1mSANITIZER GATE PASSED — ${CASES.length}/${CASES.length}.\x1b[0m`);
}

main();
