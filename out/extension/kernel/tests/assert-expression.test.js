'use strict';

// Phase 5.2/7 tests: the expect → WL check builder, the $WBA$ prefix parser,
// the JSON-fallback marker, the de-TeX rewriter, and MCP tools/list visibility.

const assert = require('assert');
const path = require('path');
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
const { WolframMCPServer, loadMCPSchemas, ECONOMY_TOOL_NAMES } = require('../../claude-mcp/server');
Module._load = orig;

const schemas = [
    { name: 'wolfbook_a', description: 'a', inputSchema: { type: 'object', properties: {} }, tags: [] },
    { name: 'wolfbook_hidden', description: 'h', inputSchema: { type: 'object', properties: {} }, tags: ['mcp:hidden'] },
    { name: 'wolfbook_old', description: 'o', inputSchema: { type: 'object', properties: {} }, tags: ['mcp:deprecated', 'mcp:replacedBy:wolfbook_a'] },
    { name: 'wolfbook_runCell', description: 'run', inputSchema: { type: 'object', properties: {} }, tags: [] },
    { name: 'wolfbook_debugCell', description: 'debug', inputSchema: { type: 'object', properties: {} }, tags: [] },
    { name: 'wolfslide_x', description: 's', inputSchema: { type: 'object', properties: {} }, tags: [] },
    { name: 'paper_search', description: 'paper', inputSchema: { type: 'object', properties: {} }, tags: [] },
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

    const economy = new WolframMCPServer(new Map(), schemas, { profile: 'economy' });
    const economyNames = (await economy._dispatch('tools/list', {})).tools.map(t => t.name);
    assert(economyNames.includes('wolfbook_runCell'), 'economy keeps basic notebook execution');
    assert(economyNames.includes('wolfbook_list_clients'), 'economy keeps routing usable');
    assert(economyNames.includes('wolfbook_setTarget'), 'economy keeps session targeting usable');
    assert(economyNames.includes('wolfbook_waitEvaluation'), 'economy keeps long evaluations usable');
    assert(!economyNames.includes('wolfbook_debugCell'), 'economy omits advanced Wolfbook debugging');
    assert(!economyNames.includes('wolfslide_x'), 'economy is Wolfbook-only');
    assert(!economyNames.includes('paper_search'), 'economy omits paper tools');

    const perSession = new WolframMCPServer(new Map(), schemas, { profile: 'full' });
    perSession._sessionProfiles.set('small-model', 'economy');
    const perSessionNames = (await perSession._dispatch('tools/list', {}, 'small-model')).tools.map(t => t.name);
    assert.deepStrictEqual(perSessionNames, economyNames,
        'the economy endpoint overrides tools/list for only that MCP session');

    const actualSchemas = loadMCPSchemas(path.join(__dirname, '..', '..', '..', '..', 'package.json'));
    const actualEconomy = await new WolframMCPServer(new Map(), actualSchemas, { profile: 'economy' })
        ._dispatch('tools/list', {});
    assert.strictEqual(actualEconomy.tools.length, ECONOMY_TOOL_NAMES.size + 3,
        'all economy tools plus the three routing/wait helpers are advertised');
    assert(actualEconomy.tools.every(t => t.name.startsWith('wolfbook_')),
        'the real economy surface contains only wolfbook_* tools');
    assert(Buffer.byteLength(JSON.stringify(actualEconomy)) < 12 * 1024,
        'economy discovery must stay below 12 KiB');
    const economySearch = actualEconomy.tools.find(t => t.name === 'wolfbook_searchCells');
    assert(economySearch.inputSchema.properties.notebook, 'economy search exposes explicit notebook routing');
    assert(economySearch.inputSchema.properties.queries, 'economy search supports batched anchors');
    const economyEdit = actualEconomy.tools.find(t => t.name === 'wolfbook_editCell');
    assert(economyEdit.inputSchema.properties.expected_notebook_revision,
        'economy mutations expose notebook revision guards');

    console.log('assert-expression + visibility tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
