'use strict';

// A notebook's own evaluation context (kernel/notebook-context.js).
// The unit half runs everywhere; the kernel half runs the generated enter/leave
// code in a throwaway wolframscript kernel, exactly as the checkout loop sends
// it, and is skipped when no wolframscript is found.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const nc = require('../notebook-context');

// ── Setting normalisation ───────────────────────────────────────────────────
assert.strictEqual(nc.normalizeContextSetting(undefined), 'Global');
assert.strictEqual(nc.normalizeContextSetting(''), 'Global');
assert.strictEqual(nc.normalizeContextSetting('Global`'), 'Global');
assert.strictEqual(nc.normalizeContextSetting('notebook'), 'Notebook');
assert.strictEqual(nc.normalizeContextSetting('isolated'), 'Notebook');
assert.strictEqual(nc.normalizeContextSetting('MyProject'), 'MyProject`');
assert.strictEqual(nc.normalizeContextSetting('MyProject`Sub`'), 'MyProject`Sub`');
for (const bad of ['System`', 'Wolfbook`Private`', '1abc`', 'a b`', 'a``', 'x"]; Quit[']) {
    assert.strictEqual(nc.normalizeContextSetting(bad), null, bad);
}

// ── Resolution ──────────────────────────────────────────────────────────────
const nb = (p, context) => ({ uri: { fsPath: p }, metadata: context === undefined ? {} : { wolframSettings: { context } } });
assert.strictEqual(nc.resolveNotebookContext(nb('/tmp/a.wb')), null);
assert.strictEqual(nc.resolveNotebookContext(nb('/tmp/a.wb', 'Global')), null);
assert.strictEqual(nc.resolveNotebookContext(nb('/tmp/a.wb', 'System`')), null, 'invalid → shared, never System`');
const ctxA = nc.resolveNotebookContext(nb('/tmp/a.wb', 'Notebook'));
assert.match(ctxA, /^Notebook\$[0-9a-f]{8}`$/);
assert.strictEqual(nc.resolveNotebookContext(nb('/tmp/a.wb/', 'Notebook')), ctxA, 'stable for the same path');
assert.notStrictEqual(nc.resolveNotebookContext(nb('/tmp/b.wb', 'Notebook')), ctxA, 'unique per notebook');
assert.strictEqual(nc.resolveNotebookContext(nb('/tmp/a.wb', 'Shared`')), 'Shared`');

// ── Generated code never names a bare helper symbol ─────────────────────────
// It is parsed in whatever $Context the kernel is in; a bare name would be
// interned into Global` (or the notebook's context).
for (const code of [nc.enterContextCode(ctxA), nc.leaveContextCode(ctxA)]) {
    const stripped = code.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/Wolfbook`Private`\$\w+/g, '');
    const bare = (stripped.match(/\$?[A-Za-z][A-Za-z0-9$]*/g) || []).filter(n => !/^[A-Z$]/.test(n));
    assert.deepStrictEqual(bare, [], `lower-case bare symbols in ${code}`);
}

// ── Real kernel ─────────────────────────────────────────────────────────────
function findWolframscript() {
    const candidates = [
        process.env.WOLFRAMSCRIPT,
        '/Applications/Wolfram 3.app/Contents/MacOS/wolframscript',
        '/Applications/Wolfram.app/Contents/MacOS/wolframscript',
        '/Applications/Wolfram 2.app/Contents/MacOS/wolframscript',
        '/Applications/Mathematica.app/Contents/MacOS/wolframscript',
        '/usr/local/bin/wolframscript',
    ].filter(Boolean);
    return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }) || null;
}

const ws = findWolframscript();
if (!ws) {
    console.log('notebook-context: unit checks passed; kernel checks SKIPPED (no wolframscript)');
    process.exit(0);
}

const ctxB = nc.resolveNotebookContext(nb('/tmp/b.wb', 'Notebook'));
// Each ToExpression below stands for one kernel round trip of the checkout loop:
// parsed under whatever $Context the previous one left behind.
const q = s => JSON.stringify(s);
const steps = [
    'Global`helper[] := 7',                      // stands in for VsCodeRender & co.
    'Global`before = Names["Global`*"]',
    nc.enterContextCode(ctxA),
    'r["pathA"] = $ContextPath',
    'x = 10',
    'r["ctxInA"] = Context[x]',
    'r["helperInA"] = helper[]',
    '$ContextPath = Append[$ContextPath, "Foo`"]',
    nc.leaveContextCode(ctxA),
    'r["ctxAfter"] = $Context',
    'r["fooLeaked"] = MemberQ[$ContextPath, "Foo`"]',
    'r["xInGlobal"] = ValueQ[Global`x]',
    nc.enterContextCode(ctxA),
    'r["xAgain"] = x',
    'r["fooKept"] = MemberQ[$ContextPath, "Foo`"]',
    nc.leaveContextCode(ctxA),
    nc.enterContextCode(ctxB),
    'r["xInB"] = ValueQ[x]',
    nc.leaveContextCode(ctxB),
    // A second enter without a leave (aborted cell) must still restore Global`.
    nc.enterContextCode(ctxA),
    nc.enterContextCode(ctxA),
    nc.leaveContextCode(ctxA),
    'r["afterDoubleEnter"] = $Context',
    'r["newGlobals"] = Complement[Names["Global`*"], Global`before, {"r", "before", "helper", "x"}]',  // Global`x: interned by the xInGlobal probe itself
];
const script =
    'Global`r = <||>;\n' +
    steps.map(s => `ToExpression[${q(s)}];`).join('\n') + '\n' +
    'Print[ExportString[Global`r, "RawJSON", "Compact" -> True]];\n';
const tmp = path.join(os.tmpdir(), `wb-nbctx-${process.pid}.wls`);
fs.writeFileSync(tmp, script);
const res = spawnSync(ws, ['-file', tmp], { encoding: 'utf8', timeout: 90000 });
fs.unlinkSync(tmp);
const line = (res.stdout || '').split('\n').find(l => l.trim().startsWith('{'));
assert.ok(line, `wolframscript produced no JSON:\n${res.stdout}\n${res.stderr}`);
const r = JSON.parse(line);

assert.strictEqual(r.ctxInA, ctxA, 'x = 10 lands in the notebook context');
assert.strictEqual(r.helperInA, 7, 'Global` helpers stay callable by bare name');
assert.strictEqual(r.ctxAfter, 'Global`', 'leaving restores Global`');
assert.strictEqual(r.fooLeaked, false, "a notebook's $ContextPath change stays in that notebook");
assert.strictEqual(r.xInGlobal, false, 'nothing defined in Global`');
assert.strictEqual(r.xAgain, 10, 'definitions persist in the notebook context across cells');
assert.strictEqual(r.fooKept, true, "the notebook's $ContextPath is remembered");
assert.strictEqual(r.pathA[0], ctxA, 'the notebook context is searched first');
assert.strictEqual(r.pathA[r.pathA.length - 1], 'Global`', 'Global` is searched last');
assert.ok(r.pathA.includes('System`'));
assert.strictEqual(r.xInB, false, 'another notebook does not see it');
assert.strictEqual(r.afterDoubleEnter, 'Global`', 'a missed leave cannot strand the kernel in a notebook context');
assert.deepStrictEqual(r.newGlobals, [], 'enter/leave intern nothing into Global`');

console.log('notebook-context: unit + kernel checks passed');
