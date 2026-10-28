'use strict';
const assert = require('node:assert/strict');
const { cleanPrintLine, cleanPrintPackets, setBoxToLatexProvider } = require('../../utils/encoding');
const { readCommittedOutputs } = require('../../tools/cell-pipeline');

setBoxToLatexProvider(box => {
    if (box === 'BoxData["42"]') return '42';
    if (box === 'BoxData[FractionBox["1", "3"]]') return '\\frac{1}{3}';
    return null;
});
const packets = ['*STR*value = \x1cBoxData["42"]\n',
    '*STR*fraction = \x1cBoxData[FractionBox["1", "3"]]\\012',
    '*STR*  indented  ', '*STR*last'];
const plain = cleanPrintPackets(packets);
assert.equal(plain, 'value = 42\nfraction = \\frac{1}{3}\n  indented  \nlast\n');
assert.equal(cleanPrintPackets(['*WBP**STR*step = \x1cBoxData["42"]\n']), 'step = 42\n');
assert.equal(cleanPrintPackets(['*STR*value = \\034BoxData["42"]']), 'value = 42\n', 'WSTP octal separators are decoded before splitting arguments');
assert.equal(cleanPrintLine('*STR*Greek: \\316\\223'), 'Greek: Γ');
assert.equal(cleanPrintLine('*SVG*base64data'), '[graphics]');
const cell = { outputs: [{ items: [
    { mime: 'x-application/wolfram-language-html', data: Buffer.from('<div>rendered</div>') },
    { mime: 'text/plain', data: Buffer.from('Print: ' + plain.trimEnd()) },
] }] };
const committed = readCommittedOutputs(cell);
assert.deepEqual(committed.outputs, ['Print: ' + plain.trimEnd()]);
assert.deepEqual(committed.messages, []);
setBoxToLatexProvider(null);
assert.equal(cleanPrintLine('BoxData["42"]\n'), 'BoxData["42"]', 'no addon must not discard printed values');
setBoxToLatexProvider(() => { throw Error('conversion failed'); });
assert.equal(cleanPrintLine('BoxData["42"]'), 'BoxData["42"]');
setBoxToLatexProvider(null);
console.log('Print output: values, math, whitespace, packet boundaries, WBPrint and MCP reads passed');
