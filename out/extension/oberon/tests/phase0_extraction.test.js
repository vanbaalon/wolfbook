'use strict';
/**
 * Phase 0 — full-text / equation extraction (measure #9).
 *
 * Guards the bug that made the literature tool net-negative: papers were "read" but
 * `equations: 0` came back. Verifies extractSections captures BOTH ar5iv (`<math
 * alttext>`) and arXiv-native (`<annotation … x-tex>`) LaTeX, decodes HTML entities
 * (hex + decimal + named), dedups, and that a realistic multi-equation page yields ≥5.
 *
 * Pure + offline (HTML fixtures only); no network. Run: node phase0_extraction.test.js
 */

const assert = require('assert');
const paperSearch = require('../../tools/paperSearch');

let pass = 0, fail = 0; const failures = [];
async function ok(label, fn) {
    try { await fn(); console.log(`  ok ${label}`); pass++; }
    catch (e) { console.error(`  FAIL ${label}: ${e && e.message || e}`); failures.push({ label, e }); fail++; }
}

// A realistic ar5iv-style page with several distinct equations + native-HTML annotations.
const AR5IV_FIXTURE = `
<html><head><style>.ltx{}</style><script>var a=1;</script></head><body>
  <h1>Fast analytic solver of rational Bethe equations</h1>
  <h2>1. The QQ-system</h2>
  <p>The Wronskian condition reads
     <math alttext="Q_a^{[+1]} Q_b^{[-1]} - Q_a^{[-1]} Q_b^{[+1]} = Q_{ab} Q_\\emptyset">W</math>.</p>
  <p>Degrees follow <math alttext="\\deg Q_a = \\lambda_a + (N-a)">d</math>.</p>
  <h2>2. Energy</h2>
  <p>Energy <math alttext="E = \\sum_j \\frac{1}{u_j^2 + 1/4}">E</math> and
     momentum <math alttext="P = \\sum_j \\frac{1}{i}\\log\\frac{u_j+i/2}{u_j-i/2}">P</math>.</p>
  <p>Drive <math alttext="W(u) \\propto u^L">drive</math>.</p>
  <p>Entities: <math alttext="\\alpha = &#945; ,\\ \\beta = &#x3b2; ,\\ a &amp; b">ent</math>.</p>
  <p>Native HTML form:
     <math><annotation encoding="application/x-tex">\\zeta(s)=\\sum_n n^{-s}</annotation></math>.</p>
</body></html>`;

async function main() {
    console.log('\n── Phase 0: paperSearch.extractSections (equation extraction #9) ──');

    await ok('extracts ar5iv <math alttext> LaTeX + headings', async () => {
        const out = paperSearch.extractSections(AR5IV_FIXTURE);
        assert.ok(out.headings.some(h => /QQ-system/.test(h)), 'heading captured');
        assert.ok(out.equations.some(e => /Q_a\^\{\[\+1\]\}/.test(e)), `Wronskian eq missing: ${JSON.stringify(out.equations)}`);
        assert.ok(out.equations.some(e => /\\deg Q_a/.test(e)), 'degree eq missing');
    });

    await ok('extracts arXiv-native <annotation … x-tex> LaTeX', async () => {
        const out = paperSearch.extractSections(AR5IV_FIXTURE);
        assert.ok(out.equations.some(e => /\\zeta\(s\)=\\sum_n/.test(e)), `annotation eq missing: ${JSON.stringify(out.equations)}`);
    });

    await ok('decodes hex, decimal AND named HTML entities', async () => {
        const out = paperSearch.extractSections(AR5IV_FIXTURE);
        const ent = out.equations.find(e => /alpha/.test(e));
        assert.ok(ent, 'entity equation missing');
        assert.ok(ent.includes(String.fromCharCode(945)), 'decimal &#945; → α not decoded');
        assert.ok(ent.includes(String.fromCharCode(0x3b2)), 'hex &#x3b2; → β not decoded');
        assert.ok(ent.includes(' & '), 'named &amp; → & not decoded');
    });

    await ok('REGRESSION: a multi-equation page yields ≥5 distinct equations', async () => {
        const out = paperSearch.extractSections(AR5IV_FIXTURE);
        assert.ok(out.equations.length >= 5, `expected ≥5, got ${out.equations.length}: ${JSON.stringify(out.equations)}`);
        // distinct
        assert.strictEqual(out.equations.length, new Set(out.equations).size, 'equations must be de-duplicated');
    });

    await ok('dedups identical equations', async () => {
        const dup = '<body>' + '<math alttext="x=1">x</math>'.repeat(4) + '</body>';
        const out = paperSearch.extractSections(dup);
        assert.strictEqual(out.equations.filter(e => e === 'x=1').length, 1);
    });

    await ok('tolerates empty / garbage input', async () => {
        assert.deepStrictEqual(paperSearch.extractSections('').equations, []);
        assert.deepStrictEqual(paperSearch.extractSections('').headings, []);
        assert.deepStrictEqual(paperSearch.extractSections(null).equations, []);
        assert.ok(typeof paperSearch.extractSections('<p>no math here</p>').textSample === 'string');
    });

    await ok('strips <script>/<style> from the text sample', async () => {
        const out = paperSearch.extractSections(AR5IV_FIXTURE);
        assert.ok(!/var a=1/.test(out.textSample), 'script body leaked into text');
        assert.ok(!/\.ltx\{\}/.test(out.textSample), 'style body leaked into text');
    });

    await ok('fetchPaperHtml is exported and async', async () => {
        assert.strictEqual(typeof paperSearch.fetchPaperHtml, 'function');
        assert.strictEqual(paperSearch.fetchPaperHtml.constructor.name, 'AsyncFunction');
    });

    console.log(`\n── Phase 0 Results: ${pass} passed, ${fail} failed ──`);
    if (failures.length) { for (const { label, e } of failures) console.error(`  [FAIL] ${label}\n    ${e && e.stack || e}`); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
