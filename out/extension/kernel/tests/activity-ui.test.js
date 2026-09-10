'use strict';
const assert = require('assert');
const vm = require('vm');
const html = require('../../monitor/dashboard').renderDashboard();
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
new vm.Script(script);
// Exercise the shipped UI functions without network, VS Code, or live kernels.
const elements = new Map();
const document = { querySelectorAll: () => [], getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', style: {}, options: [], querySelector: () => null, querySelectorAll: () => [] });
    return elements.get(id);
} };
const now = 1800000000000;
class Clock extends Date { static now() { return now; } }
const context = vm.createContext({ document, Date: Clock, window: { scrollY: 200 } });
const definitions = script.slice(script.indexOf("var state="), script.indexOf("$('search').oninput"));
vm.runInContext(definitions, context);
for (const [seconds, expected] of [[0,'0s ago'],[59,'59s ago'],[60,'1m 0s ago'],[263,'4m 23s ago'],[3599,'59m 59s ago'],[3600,'1h ago'],[86399,'23h ago'],[86400,'1d ago']]) {
    assert.equal(vm.runInContext(`ago(${now - seconds * 1000})`, context), expected);
}
const op = { id: 'op', actor: { sessionId: 'agent-a', label: 'Agent A' }, tool: 'wolfbook_runCell',
    state: 'running', startedAt: now - 65000, notebook: '/tmp/example.wb', kernelLabel: 'K3', changes: [] };
context.op = op;
vm.runInContext('state.overview={operations:[op],sessions:[],activeOperationIds:[]}', context);
const card = vm.runInContext("nowCard({sessionId:'agent-a',label:'Agent A',lastOperation:op})", context);
assert.equal((card.match(/K3 · example.wb/g) || []).length, 1, 'target must not repeat when caption is absent');
assert.match(card, /data-agent-card="agent-a"/);
assert.match(card, /aria-pressed="false"/);
vm.runInContext("selectAgent('agent-a')", context);
assert.equal(elements.get('agent-filter').value, 'agent-a');
assert.equal(vm.runInContext('matches(op)', context), true);
assert.equal(vm.runInContext("matches({...op,actor:{sessionId:'agent-b'}})", context), false);
vm.runInContext("selectAgent('agent-a')", context);
assert.equal(elements.get('agent-filter').value, '');
assert.match(vm.runInContext('row(op)', context), /class="time">.*<small><span data-relative=/);
assert.match(script, /es\.onopen=function\(\).*scheduleLoad\(\)/);
assert.match(script, /setInterval\(function\(\)\{if\(!document.hidden\)tickTimes\(\)\},1000\)/);
assert.equal(vm.runInContext("identityColor('session-a')", context), vm.runInContext("identityColor('session-a')", context));
assert.equal(vm.runInContext("groupStories([{...op,state:'completed',clientId:'a'},{...op,id:'op2',state:'completed',clientId:'a',startedAt:op.startedAt-1000}]).length", context), 1);
assert.equal(vm.runInContext("groupStories([{...op,state:'completed',clientId:'a'},{...op,id:'op2',state:'completed',clientId:'b'}]).length", context), 2, 'different owning windows must not be grouped');
assert.equal(vm.runInContext("groupStories([op,{...op,id:'op2'}]).length", context), 2, 'running operations remain individually visible');
assert.doesNotMatch(vm.runInContext("highlight('<script>alert(1)</script>')", context), /<script>/);
assert.match(vm.runInContext("changes({...op,changes:[{action:'edit',cellNumber:3,diff:{removed:'x',added:'y'}}]})", context), /changed fragment/);
assert.match(vm.runInContext("changes({...op,changes:[{action:'edit',cellNumber:3}]})", context), /data-change-index="0"/);
assert.match(html, /id="palette"/);
assert.match(script, /prefers-reduced-motion/);
vm.runInContext('state.displayed=[op];state.overview.operations=[{...op,id:"new-op"},op]', context);
const beforeList = elements.get('activity').innerHTML;
vm.runInContext('render()', context);
assert.equal(vm.runInContext('state.pendingCount', context), 1);
assert.equal(elements.get('activity').innerHTML, beforeList, 'reading history must not be replaced by new calls');
vm.runInContext('acceptUpdates()', context);
assert.equal(vm.runInContext('state.displayed.length', context), 2);
console.log('activity UI time and agent filtering tests: OK');
