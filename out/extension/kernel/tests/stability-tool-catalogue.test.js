'use strict';

// Stability: the tool catalogue stays coherent as tools are added.
//
// package.json feeds BOTH the MCP tools/list and Copilot, so drift there is
// silent in two places. This lints what the audit of 2026-09-25 found broken:
//   * participants named tools that did not exist (wolfbook_runRange,
//     wolfbook_saveLatex, …) — they never had LaTeX tools;
//   * the Copilot shadow tools were registered but never contributed (dead);
//   * descriptions ran to 2 KB, were truncated mid-sentence by the server, and
//     carried bug history ("it used to …") into every session's context;
//   * a family tag with no matching Copilot `when` clause would make a tool
//     reachable over MCP but unreachable in Copilot (or the reverse).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const exposure = require('../../claude-mcp/tool-exposure');

const root = path.join(__dirname, '..', '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tools = pkg.contributes.languageModelTools;
const names = new Set(tools.map(t => t.name));
const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'index.js'), 'utf8');
const registered = new Set([...indexSrc.matchAll(/\{ name: '([A-Za-z_]+)',\s*impl:/g)].map(m => m[1]));

// 1. Declared ⇔ registered.
for (const n of names) assert.ok(registered.has(n), `declared but not registered: ${n}`);
for (const n of registered) assert.ok(names.has(n), `registered but not declared (VS Code refuses it): ${n}`);

// 2. Families are known, and Copilot `when` clauses agree with them.
for (const t of tools) {
    const fam = exposure.familyOf(t);
    if (!fam) { assert.ok(!t.when, `core tool must not be gated: ${t.name}`); continue; }
    assert.ok(exposure.FAMILIES[fam], `unknown family "${fam}" on ${t.name}`);
    assert.ok(t.when && t.when.includes(`wolfbook.tools.${fam}`), `${t.name}: when must include wolfbook.tools.${fam}`);
    const ctx = exposure.FAMILIES[fam].context;
    if (ctx) assert.ok(t.when.includes(`wolfbook.ctx.${ctx}`), `${t.name}: context family must test wolfbook.ctx.${ctx}`);
}

// 3. Removed tools are gone everywhere a model could see them.
for (const n of Object.keys(exposure.REMOVED_TOOLS)) {
    assert.ok(!names.has(n) && !registered.has(n), `removed tool still present: ${n}`);
}

// 4. Participant tool lists name real tools.
const listOf = name => {
    const m = indexSrc.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(m, `${name} not found`);
    return [...m[1].matchAll(/'([A-Za-z_]+)'/g)].map(x => x[1]);
};
for (const n of listOf('PARTICIPANT_WOLFBOOK_TOOLS')) assert.ok(names.has(n), `participant names a missing tool: ${n}`);

// 5. Descriptions: bounded, no history, no truncation needed.
for (const t of tools) {
    const d = t.modelDescription || '';
    assert.ok(d.length > 0, `${t.name}: no description`);
    assert.ok(d.length <= 420, `${t.name}: description ${d.length} chars (limit 420)`);
    assert.ok(!/\b(it |they )?used to\b|\bwas (fixed|dropped)\b/i.test(d), `${t.name}: description carries history`);
}

// 6. The default surface stays small: core tools that are listed by default.
const core = tools.filter(t => !exposure.familyOf(t) &&
    !(t.tags || []).some(x => x === 'mcp:hidden' || x === 'mcp:deprecated'));
assert.ok(core.length <= 20, `core surface grew to ${core.length} tools — put rare ones in a family`);

console.log(`stability-tool-catalogue: all assertions passed (${tools.length} tools, ${core.length} core)`);
