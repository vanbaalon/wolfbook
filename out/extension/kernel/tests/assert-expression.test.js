'use strict';

// Phase 5.2/7 tests: the expect → WL check builder, the $WBA$ prefix parser,
// the JSON-fallback marker, the de-TeX rewriter, and MCP tools/list visibility.

const assert = require('assert');
const { withVscodeStub } = require('./_stub-vscode');

const tools = withVscodeStub(() => require('../../tools/index'));
const {
    _buildExpectCheck, _buildOutputFormWrapper, _parseAssertPrefix,
    _stripJsonFallback, _deTexUsage,
} = tools;

// ── expect → WL check ───────────────────────────────────────────────────────
assert.strictEqual(_buildExpectCheck(null), null);
assert.strictEqual(_buildExpectCheck({}), null);
assert.strictEqual(_buildExpectCheck({ freeOfMessages: true }), null, 'freeOfMessages is JS-side only');
assert.match(_buildExpectCheck({ equals: '42' }), /SameQ\[\$wbR\$, \(42\)\]/);
assert.match(_buildExpectCheck({ matches: '_Integer' }), /MatchQ\[\$wbR\$, _Integer\]/);
const num = _buildExpectCheck({ numeric: { value: '2/3', tolerance: '2*10^-19' } });
assert.match(num, /Abs\[N\[\(\$wbR\$\) - \(2\/3\)\]\] <= \(2\*10\^-19\)/);
const dflt = _buildExpectCheck({ numeric: { value: '1.5' } });
assert.match(dflt, /10\^-10/);
assert.match(_buildExpectCheck({ isTrue: true }), /TrueQ\[\$wbR\$\]/);
const combo = _buildExpectCheck({ equals: '1', isTrue: true });
assert.match(combo, / && /);

// ── outputForm wrapper ──────────────────────────────────────────────────────
assert.match(_buildOutputFormWrapper('json', '$wbR$'), /ExportString\[\$wbR\$, "JSON"/);
assert.match(_buildOutputFormWrapper('json', '$wbR$'), /\$WBJSONFAIL\$/);
assert.match(_buildOutputFormWrapper('', '$wbR$'), /InputForm/);
assert.match(_buildOutputFormWrapper('TeXForm', '$wbR$'), /TeXForm/);

// ── prefix parsers ──────────────────────────────────────────────────────────
assert.deepStrictEqual(_parseAssertPrefix('$WBA$PASS$WBSEP$42'), { outcome: 'PASS', value: '42' });
assert.deepStrictEqual(_parseAssertPrefix('$WBA$FAIL$WBSEP${1, 2}'), { outcome: 'FAIL', value: '{1, 2}' });
assert.deepStrictEqual(_parseAssertPrefix('plain'), { outcome: null, value: 'plain' });
assert.deepStrictEqual(_stripJsonFallback('$WBJSONFAIL$Sin[x]'), { value: 'Sin[x]', jsonFellBack: true });
assert.deepStrictEqual(_stripJsonFallback('[1,2]'), { value: '[1,2]', jsonFellBack: false });

// ── de-TeX ──────────────────────────────────────────────────────────────────
assert.strictEqual(_deTexUsage('Integrate[$f$, {$x$, $x_{\\min }$, $x_{\\max }$}]'),
    'Integrate[f, {x, xmin, xmax}]');
assert.strictEqual(_deTexUsage('gives $\\text{\\textit{eqns}}$ solved'), 'gives eqns solved');
assert.strictEqual(_deTexUsage('no tex here'), 'no tex here');

// ── MCP visibility (Phase 0.2 tags) ─────────────────────────────────────────
const Module = require('module');
const orig = Module._load;
Module._load = function (request) { if (request === 'vscode') return {}; return orig.apply(this, arguments); };
const { WolframMCPServer } = require('../../claude-mcp/server');
Module._load = orig;

const schemas = [
    { name: 'wolfbook_a', description: 'a', inputSchema: { type: 'object', properties: {} }, tags: [] },
    { name: 'wolfbook_hidden', description: 'h', inputSchema: { type: 'object', properties: {} }, tags: ['mcp:hidden'] },
    { name: 'wolfbook_old', description: 'o', inputSchema: { type: 'object', properties: {} }, tags: ['mcp:deprecated', 'mcp:replacedBy:wolfbook_a'] },
    { name: 'wolfslide_x', description: 's', inputSchema: { type: 'object', properties: {} }, tags: [] },
];
(async () => {
    const srv = new WolframMCPServer(new Map(), schemas, {});
    const listed = (await srv._dispatch('tools/list', {})).tools.map(t => t.name);
    assert(listed.includes('wolfbook_a'));
    assert(!listed.includes('wolfbook_hidden'), 'mcp:hidden must not be listed');
    assert(!listed.includes('wolfbook_old'), 'deprecated hidden by default');
    assert(listed.includes('wolfslide_x'), 'full profile keeps wolfslide');

    const srv2 = new WolframMCPServer(new Map(), schemas, { exposeDeprecatedTools: true, profile: 'notebook' });
    const list2 = (await srv2._dispatch('tools/list', {})).tools;
    const names2 = list2.map(t => t.name);
    assert(names2.includes('wolfbook_old'), 'exposeDeprecatedTools lists deprecated names');
    assert(!names2.includes('wolfslide_x'), 'notebook profile drops wolfslide_*');
    const oldEntry = list2.find(t => t.name === 'wolfbook_old');
    assert.match(oldEntry.description, /^DEPRECATED — use `wolfbook_a` instead/);
    assert(!('tags' in oldEntry), 'tags are internal, never sent to clients');

    console.log('assert-expression + visibility tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
