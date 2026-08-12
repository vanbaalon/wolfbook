#!/usr/bin/env node
'use strict';
/* Stage 3c — slideAI.js host planner: pure-Node unit tests for buildMessages / extractJson /
 * parsePlan / validatePlan. Requiring the module must NOT pull `vscode` (the provider layer
 * is lazy-required inside planFromInstruction only). */
const path = require('path');
const AI = require(path.resolve(__dirname, '../../out/extension/slideAI.js'));

let pass = 0, fail = 0;
const ok = (n, c, d) => c ? (pass++, console.log('\x1b[32m✓\x1b[0m ' + n))
  : (fail++, console.log(`\x1b[31m✗ ${n}\x1b[0m${d ? '\n   ' + String(d).slice(0, 220) : ''}`));

const blocks = [
  { id: 'a', type: 'text', position: 'absolute', x: 100, y: 100, w: 200, h: 80, content: '<p>hello</p>' },
  { id: 'b', type: 'text', position: 'absolute', x: 130, y: 240, w: 160, h: 60, content: '<p>world</p>' },
  { id: 'm', type: 'math', position: 'absolute', x: 0, y: 0, w: 300, h: 90, content: '$E=mc^2$' },
];

// ── buildMessages ────────────────────────────────────────────────────────────
{
  const msgs = AI.buildMessages({ instruction: 'tidy this', blocks, canvas: { w: 1920, h: 1080 } });
  ok('buildMessages → [system,user]', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user', JSON.stringify(msgs.map(m => m.role)));
  ok('user msg carries canvas + instruction', /1920×1080/.test(msgs[1].content) && /tidy this/.test(msgs[1].content), msgs[1].content.slice(0, 120));
  ok('protected (math) content omitted from prompt', !/E=mc\^2/.test(msgs[1].content) && /hello/.test(msgs[1].content), msgs[1].content);
}

// ── extractJson ──────────────────────────────────────────────────────────────
ok('extractJson: fenced', AI.extractJson('sure!\n```json\n{"verbs":[]}\n```') === '{"verbs":[]}');
ok('extractJson: nested braces + string braces', AI.extractJson('x {"a":{"b":1},"s":"}{"} y') === '{"a":{"b":1},"s":"}{"}');
ok('extractJson: none → null', AI.extractJson('no json here') === null);

// ── parsePlan ────────────────────────────────────────────────────────────────
{
  const p = AI.parsePlan('```json\n{"verbs":[{"op":"tidy","params":{}}],"textEdits":[],"changelog":"tidied"}\n```');
  ok('parsePlan → shape', p.verbs.length === 1 && p.verbs[0].op === 'tidy' && p.changelog === 'tidied', JSON.stringify(p));
  const p2 = AI.parsePlan('{"changelog":"x"}');
  ok('parsePlan defaults arrays', Array.isArray(p2.verbs) && Array.isArray(p2.textEdits) && p2.verbs.length === 0, JSON.stringify(p2));
  let threw = false; try { AI.parsePlan('total garbage no braces'); } catch (_) { threw = true; }
  ok('parsePlan throws on garbage', threw);
}

// ── validatePlan ─────────────────────────────────────────────────────────────
{
  const raw = {
    verbs: [
      { op: 'tidy', params: {} },
      { op: 'evilOp', params: {} },                     // unknown → dropped
      { op: 'matchSize', params: { dim: 'w', refId: 'zzz' }, ids: ['a', 'ghost'] }, // bad refId + ghost id
    ],
    textEdits: [
      { id: 'a', content: '<p>new</p>' },               // ok
      { id: 'm', content: '$x$' },                      // math → refused
      { id: 'ghost', content: 'x' },                    // unknown → dropped
      { id: 'b', content: 42 },                         // non-string → dropped
    ],
    changelog: 'did stuff',
  };
  const { plan, warnings } = AI.validatePlan(raw, { blocks });
  ok('validate keeps known verbs only', plan.verbs.length === 2 && plan.verbs.every(v => AI.VERB_OPS.includes(v.op)), JSON.stringify(plan.verbs));
  ok('validate filters ghost ids from verb, keeps real', JSON.stringify(plan.verbs[1].ids) === JSON.stringify(['a']), JSON.stringify(plan.verbs[1]));
  ok('validate drops invalid refId', !('refId' in plan.verbs[1].params), JSON.stringify(plan.verbs[1].params));
  ok('validate keeps only the valid prose textEdit', plan.textEdits.length === 1 && plan.textEdits[0].id === 'a', JSON.stringify(plan.textEdits));
  ok('validate refuses math rewrite (warning)', warnings.some(w => /protected block m/.test(w)), JSON.stringify(warnings));
  ok('validate keeps changelog', plan.changelog === 'did stuff', plan.changelog);
}
{
  // all-filtered ids → verb falls back to whole selection (ids undefined)
  const { plan } = AI.validatePlan({ verbs: [{ op: 'align', params: { edge: 'left' }, ids: ['ghost'] }], textEdits: [] }, { blocks });
  ok('validate: verb with all-bad ids → whole selection', plan.verbs.length === 1 && plan.verbs[0].ids === undefined, JSON.stringify(plan.verbs));
}

// ── styleEdits (restyle — the "make it blue" gap) ──────────────────────────────
ok('parsePlan defaults styleEdits array', Array.isArray(AI.parsePlan('{"changelog":"x"}').styleEdits));
{
  const raw = {
    verbs: [], textEdits: [],
    styleEdits: [
      { id: 'a', style: { color: 'blue', fontSize: '48px', evilKey: 'url(x)' } }, // keep color+fontSize, drop evilKey
      { id: 'm', style: { color: '#f00' } },                                       // restyling math is ALLOWED
      { id: 'ghost', style: { color: 'red' } },                                    // unknown id → dropped
      { id: 'b', style: { notACssKey: 'x' } },                                     // no allowed keys → dropped
    ],
    changelog: 'coloured things',
  };
  const { plan, warnings } = AI.validatePlan(raw, { blocks });
  ok('styleEdit whitelists keys (color+fontSize, drops evilKey)', plan.styleEdits.find(s => s.id === 'a') && JSON.stringify(Object.keys(plan.styleEdits.find(s => s.id === 'a').style).sort()) === '["color","fontSize"]', JSON.stringify(plan.styleEdits));
  ok('styleEdit ALLOWED on protected (math) block', !!plan.styleEdits.find(s => s.id === 'm' && s.style.color === '#f00'), JSON.stringify(plan.styleEdits));
  ok('styleEdit dropped for unknown id', !plan.styleEdits.find(s => s.id === 'ghost'), JSON.stringify(plan.styleEdits));
  ok('styleEdit dropped when no allowed keys', !plan.styleEdits.find(s => s.id === 'b'), JSON.stringify(warnings));
  ok('prompt advertises styleEdits + make it blue', /styleEdits/.test(AI.buildMessages({ instruction: 'x', blocks, canvas: {} })[0].content) && /make it blue/.test(AI.buildMessages({ instruction: 'x', blocks, canvas: {} })[0].content));
}

console.log('');
if (fail) { console.log(`\x1b[31m\x1b[1mSLIDEAI UNIT FAILED — ${fail}.\x1b[0m`); process.exit(1); }
console.log(`\x1b[32m\x1b[1mSLIDEAI UNIT PASSED — ${pass}/${pass}.\x1b[0m`);
