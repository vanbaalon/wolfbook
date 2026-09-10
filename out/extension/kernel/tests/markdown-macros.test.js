'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rendererPath = path.join(__dirname, '../../../renderers/markdown-latex-delims.js');
const source = fs.readFileSync(rendererPath, 'utf8')
    .replace('export const activate', 'const activate');
const sandbox = {};
vm.runInNewContext(`${source}\nthis.convertLatexDelimiters = convertLatexDelimiters;`, sandbox);

const convert = sandbox.convertLatexDelimiters;
assert.strictEqual(convert('$z = x + \\ii y$'), '$z = x + \\mathrm{i} y$');
assert.strictEqual(convert('\\[e^{\\ii \\pi}+1=0\\]'), '$$e^{\\mathrm{i} \\pi}+1=0$$');
assert.strictEqual(convert('$\\iint f$ and $\\iiint g$'), '$\\iint f$ and $\\iiint g$');
assert.strictEqual(convert('`$\\ii$` and ```math\n$\\ii$\n```'), '`$\\ii$` and ```math\n$\\ii$\n```');

console.log('markdown-macros.test.js: ok');
