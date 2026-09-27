const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stepsFor, stepAt, satisfies } = require('../../tex/tourSteps');

test('WLaTeX Pro steps are offered only with its live engine, tagged', () => {
    assert.ok(!stepsFor({}).some(s => s.pro), 'no Pro steps without WLaTeX');
    const pro = stepsFor({ pro: true });
    const at = pro.findIndex(s => s.id === 'inkType');
    assert.ok(at > 0 && pro[at + 1].id === 'inkCite', 'typing on the page, then citing from it');
    assert.equal(stepAt({ at }, { pro: true }).pro, true);
    assert.equal(stepAt({ at: 0 }, { pro: true }).pro, false);
    assert.ok(satisfies({ id: 'inkType' }, { type: 'inkKey', key: 'a' }));
    assert.ok(!satisfies({ id: 'inkType' }, { type: 'inkKey', key: 'ArrowLeft' }));
    assert.ok(satisfies({ id: 'inkCite' }, { type: 'inkKey', key: 'picker:cite' }));
});
