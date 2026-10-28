'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSynctexText } = require('../../tex/synctexParse');

const doc = (header) => parseSynctexText(`SyncTeX Version:1\nInput:1:/paper.tex\n${header}\nContent:\n{1\n(1,3:100,200:300,40,10\nx1,3:150,200\n)\n}1\nPostamble:\nCount:2\n`);

test('SyncTeX offsets move all records into PDF page coordinates without changing dimensions', () => {
    const parsed = doc('Magnification:1000\nUnit:1\nX Offset:4736287\nY Offset:4736287');
    const [box, char] = parsed.pages.get(1).boxes;
    assert.deepEqual([box.h, box.v, box.W, box.H, box.D], [4736387, 4736487, 300, 40, 10]);
    assert.deepEqual([char.h, char.v], [4736437, 4736487]);
    assert.equal(parsed.pages.get(1).root.children[0], box, 'queries of the tree and flat index see the same transformed box');
});

test('SyncTeX Unit scales coordinates and dimensions; header offsets are already scaled points', () => {
    const [box] = doc('Unit:2\nX Offset:1000\nY Offset:2000').pages.get(1).boxes;
    assert.deepEqual([box.h, box.v, box.W, box.H, box.D], [1200, 2400, 600, 80, 20]);
});

test('ordinary pdfTeX coordinates remain unchanged', () => {
    const [box] = doc('Unit:1\nX Offset:0\nY Offset:0').pages.get(1).boxes;
    assert.deepEqual([box.h, box.v, box.W, box.H, box.D], [100, 200, 300, 40, 10]);
});
