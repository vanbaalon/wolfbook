'use strict';

const assert = require('assert');
const E = require('./researchEval');

let passed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n${e.stack || e}`); process.exitCode = 1; }
}

console.log('researchEval.test.js');

test('rubric has 11 stable, uniquely named capabilities', () => {
    assert.strictEqual(E.CAPABILITIES.length, 11);
    assert.strictEqual(new Set(E.CAPABILITIES.map(c => c.id)).size, 11);
    assert.ok(E.RUBRIC_VERSION.includes('1.0.0'));
});

test('empty telemetry remains wholly unassessed', () => {
    const r = E.assessTelemetry([]);
    assert.strictEqual(r.summary.score, null);
    assert.strictEqual(r.summary.assessmentCoverage, 0);
    assert.strictEqual(r.summary.statusCounts.unassessed, 11);
});

test('clean replay passes reproducibility but not semantic correctness', () => {
    const events = [
        { runId: 'r1', type: 'quest.accepted', payload: { successCriteria: ['answer produced'] } },
        { runId: 'r1', type: 'fairy.run_metrics', payload: { probesOk: 3, probesFailed: 1, records: 2 } },
        { runId: 'r1', type: 'scroll.submitted', payload: { status: 'delivered', cleanNbPath: '/tmp/clean.wb', steps: [] } },
    ];
    const r = E.assessTelemetry(events);
    const by = Object.fromEntries(r.assessments.map(a => [a.capability, a]));
    assert.strictEqual(by.reproducibility.status, 'pass');
    assert.strictEqual(by.implementation_correctness.status, 'partial');
    assert.strictEqual(by.interpretation.status, 'unassessed');
    assert.ok(r.summary.assessmentCoverage > 0 && r.summary.assessmentCoverage < 1);
});

test('partial notebook cannot pass reproducibility', () => {
    const r = E.assessTelemetry([{ type: 'scroll.submitted', payload: { status: 'partial_delivered', partialNbPath: '/tmp/p.wb', steps: [] } }]);
    const a = r.assessments.find(x => x.capability === 'reproducibility');
    assert.strictEqual(a.status, 'partial');
    assert.ok(a.score < 0.5);
});

test('failed validation is a numerical-validity failure', () => {
    const r = E.assessTelemetry([{ type: 'validation.check', payload: { passed: false, expression: 'x == 1' } }]);
    const a = r.assessments.find(x => x.capability === 'numerical_validity');
    assert.strictEqual(a.status, 'fail');
});

test('unassessed dimensions do not dilute assessed score', () => {
    const r = E.makeReport({ assessments: [
        { capability: 'reproducibility', status: 'pass', score: 1, grader: 'test', rationale: 'x', evidence: [] },
    ] });
    assert.strictEqual(r.summary.score, 1);
    assert.ok(r.summary.assessmentCoverage < 0.2);
});

test('invalid scores are rejected', () => {
    assert.throws(() => E.judgement('pass', 1.2, 'test', ''), /\[0,1\]/);
    assert.throws(() => E.judgement('maybe', 0.5, 'test', ''), /Invalid/);
});

test('report comparison localizes regression and improvement', () => {
    const mk = (impl, repro) => E.makeReport({ assessments: [
        { capability: 'implementation_correctness', status: 'partial', score: impl, grader: 'test', rationale: '', evidence: [] },
        { capability: 'reproducibility', status: 'partial', score: repro, grader: 'test', rationale: '', evidence: [] },
    ] });
    const c = E.compareReports(mk(0.8, 0.6), mk(0.5, 0.9));
    assert.deepStrictEqual(c.regressions.map(x => x.capability), ['implementation_correctness']);
    assert.deepStrictEqual(c.improvements.map(x => x.capability), ['reproducibility']);
});

test('markdown exposes coverage warning', () => {
    const md = E.toMarkdown(E.assessTelemetry([]));
    assert.ok(md.includes('Assessment coverage'));
    assert.ok(md.includes('Unassessed capabilities'));
});

process.on('exit', () => {
    if (!process.exitCode) console.log(`\nResearch evaluation: ${passed} passed, 0 failed`);
});

