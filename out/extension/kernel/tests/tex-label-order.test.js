'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanTex } = require('../../tex/texScanner');
const { buildModel } = require('../../tex/texModel');
const { buildLabelChips, tagRowsFromGlyphs } = require('../../tex/labelChips');

const file = '/paper/main.tex';
const source = String.raw`\begin{align}
 a &= 1, \label{eq:diagonal}\\
 b &= 2, \label{eq:companion}
\end{align}`;
const model = buildModel(scanTex(source, { file }), { file });
function number(printed, baseline, row) {
    let x = 520;
    return [...printed].map(str => {
        const g = { page:1, x, baseline, w:5, h:8, d:2, row, kind:4, lv:0, str };
        x += 5; return g;
    });
}
const glyphs = [...number('(2.61)', 108, 1), ...number('(2.62)', 138, 2)];
function chips(options = {}) {
    return buildLabelChips({ objects:model.objects, file, pageWidth:612,
        rowsFor:(_f, line) => line === 4 ? [
            { page:1,x:100,y:95,w:450,h:20 },
            { page:1,x:100,y:125,w:450,h:20 },
        ] : [],
        glyphsFor:(_f, line) => line === 4 ? glyphs : [],
        ...options });
}

for (const printed of [false, true]) test(`collected align labels stay beside their own numbers, auxiliary numbers ${printed ? 'ready' : 'unavailable'}`, () => {
    const actual = chips({ printedFor:printed ? name => ({ printed:name === 'eq:diagonal' ? '2.61' : '2.62' }) : null });
    const diagonal = actual.find(c => c.name === 'eq:diagonal');
    const companion = actual.find(c => c.name === 'eq:companion');
    assert.equal(diagonal.at.y, 100);
    assert.equal(companion.at.y, 130);
    assert.equal(diagonal.approx, false);
    assert.equal(companion.approx, false);
    assert.equal(diagonal.cmd, 'eqref');
    assert.equal(companion.cmd, 'eqref');
});

test('matching printed numbers skips numbered rows without a label', () => {
    const extra = [...number('(2.60)', 78, 0), ...glyphs];
    const actual = chips({ glyphsFor:(_f,line) => line === 4 ? extra : [],
        printedFor:name => ({ printed:name === 'eq:diagonal' ? '2.61' : '2.62' }) });
    assert.equal(actual.find(c => c.name === 'eq:diagonal').at.y, 100);
    assert.equal(actual.find(c => c.name === 'eq:companion').at.y, 130);
});

test('without separate number glyphs, collected formula rows preserve label order and remain approximate', () => {
    const actual = chips({ glyphsFor:null });
    assert.ok(actual.find(c => c.name === 'eq:diagonal').at.y < actual.find(c => c.name === 'eq:companion').at.y);
    assert.ok(actual.every(c => c.approx));
});

test('number recovery excludes ordinary formula ink and page furniture outside the display', () => {
    const formula = number('(x+y)', 158, 3);
    assert.deepEqual(tagRowsFromGlyphs([...formula,...glyphs],612).map(r => r.printed), ['(2.61)','(2.62)']);
    assert.deepEqual(tagRowsFromGlyphs(glyphs.map(g => ({ ...g,x:g.x - 300 })),612), []);
    const bodyNumber = number('(1)',158,3).map(g => ({ ...g,x:g.x - 30 }));
    assert.deepEqual(tagRowsFromGlyphs([...bodyNumber,...glyphs],612).map(r => r.printed), ['(2.61)','(2.62)']);
    assert.deepEqual(tagRowsFromGlyphs(glyphs.map(g => ({ ...g,lv:1 })),612), []);
});

test('Pro EquationNumber glyphs retain custom tags without decoded font text', () => {
    const explicit = glyphs.map(g => ({ ...g,kind:3,str:'',x:g.x - 440 }));
    const tags = tagRowsFromGlyphs([...explicit,...number('(99)',200,4)],612);
    assert.equal(tags.length,2);
    assert.deepEqual(tags.map(t => t.y),[100,130]);
});
