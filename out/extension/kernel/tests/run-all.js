'use strict';

// Headless test runner: executes every *.test.js in this directory as a child
// process, prints a pass/fail table, exits non-zero if any fail.
//
//   node "Extension Development/out/extension/kernel/tests/run-all.js"
//
// deploy-extension.sh only syntax-checks (node --check); run this manually
// before every deploy that touches kernel/, tools/, or claude-mcp/.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();

let failed = 0;
const rows = [];
for (const f of files) {
    const started = Date.now();
    const res = spawnSync(process.execPath, [path.join(dir, f)], {
        encoding: 'utf8', timeout: 120000,
    });
    const ok = res.status === 0;
    if (!ok) failed++;
    rows.push({ file: f, ok, ms: Date.now() - started });
    const mark = ok ? '✓' : '✗';
    console.log(`${mark} ${f} (${Date.now() - started} ms)`);
    if (!ok) {
        const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
        console.log(out.split('\n').map(l => `    ${l}`).join('\n'));
    }
}

console.log(`\n${rows.length - failed}/${rows.length} suites passed`);
process.exit(failed ? 1 : 0);
