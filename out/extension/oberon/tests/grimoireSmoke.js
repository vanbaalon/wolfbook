'use strict';
/**
 * Oberon — Grimoire / Scribe / Postmortem smoke tests (MVP-5).
 *
 * Standalone Node tests for:
 *   - memory/grimoire.js  : file creation, append, idempotency check, header.
 *   - core/scribe.js      : conservative gating (verdict + ward outcomes),
 *                           `grimoire.updated` event, write-failure → omen.
 *   - memory/postmortem.js: deterministic markdown rendering.
 *
 * Uses a throw-away workspace under os.tmpdir() so we never touch the real
 * `.oberon/` or `grimoire/` directory.
 *
 * Run:   node out/extension/oberon/tests/grimoireSmoke.js
 * Expects exit code 0 and "ALL OK" on stdout.
 */

const fs   = require('fs');
const fsp  = require('fs/promises');
const os   = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

// ── Stub `vscode` (required transitively via memory/project) ──────────────
// Project reads the workspace root from vscode.workspace.workspaceFolders;
// we point it at a fresh tmpdir per test run.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oberon-grimoire-'));
const fakeVscodeId = path.resolve(__dirname, '_fakeVscode_grimoire.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: {
            workspaceFolders: [{ uri: { fsPath: TMP_ROOT } }],
            onDidChangeConfiguration: () => ({ dispose() {} }),
            getConfiguration: () => ({ get: () => undefined, update: () => Promise.resolve() }),
        },
        window: {
            showInformationMessage: () => Promise.resolve(),
            showWarningMessage:     () => Promise.resolve(),
            showErrorMessage:       () => Promise.resolve(),
        },
        Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
        EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'vscode') return fakeVscodeId;
    return origResolve.call(this, req, parent, ...rest);
};

const grimoire  = require('../memory/grimoire');
const { runScribe } = require('../core/scribe');
const { writePostmortem } = require('../memory/postmortem');
const project   = require('../memory/project');

// ── Helpers ───────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function t(name, fn) {
    return Promise.resolve().then(fn).then(
        () => { pass++; console.log('  ok   ' + name); },
        (e) => { fail++; console.log('  FAIL ' + name + ' -> ' + (e && e.stack || e)); },
    );
}

class FakeBus {
    constructor() { this.events = []; this.runId = 'R-test-001'; }
    async appendEvent(type, payload, opts) {
        this.events.push({ type, payload: payload || {}, opts: opts || {} });
    }
}

function quest(id = 'Q01_test') {
    return { id, shortName: 'test', title: 'Test quest', objective: 'do a thing' };
}
function charm(id = 'C01_test') { return { id, title: 'Test charm' }; }
function scroll(opts = {}) {
    return {
        id: opts.id || 'S01',
        summary: opts.summary || 'A short summary of the result.',
        confidence: opts.confidence != null ? opts.confidence : 0.92,
        findings:      opts.findings      || [{ claim: 'Sin[0] == 0', confidence: 0.95 }],
        openQuestions: opts.openQuestions || [],
        evidence:      opts.evidence      || [{ tool: 'wolfram_eval', expression: 'Sin[0]', output: '0' }],
    };
}
function reviewOut(verdict = 'success') {
    return {
        oberonVerdict: {
            verdict, narrative: 'ok',
            counts: { quests: 1, charms: 1, toolCalls: 1, llmCalls: 2, skepticChecks: 1 },
            mainEvidence: '', mainFailure: '', recommendedAction: '',
        },
        skeptic: { verdict: 'accept', objections: [], checks: [], summary: { total: 1, matched: 1, failed: 0, skipped: 0 }, spanId: null },
        revisionsUsed: 0,
    };
}
function wardOut(summary, results) {
    return { results: results || [], summary, spanId: 'span', fileRef: null };
}

// ── Tests ─────────────────────────────────────────────────────────────────
(async () => {
    // Wipe between tests by removing the grimoire file (the test layout is
    // recreated lazily by ensureGrimoireFile).
    const wipe = async () => {
        try { await fsp.unlink(path.join(TMP_ROOT, 'grimoire', 'canonical_state.md')); } catch (_) {}
    };

    // 1. ensureGrimoireFile creates dir + header
    await t('ensureGrimoireFile creates file with header', async () => {
        await wipe();
        const fp = await grimoire.ensureGrimoireFile();
        assert(fp && fp.endsWith('canonical_state.md'), 'returns the file path');
        const text = await fsp.readFile(fp, 'utf8');
        assert(text.startsWith('# Oberon Grimoire'), 'has the standard header');
    });

    // 2. appendEntry writes a delimited block and returns sha256
    await t('appendEntry: delimited, sha256-stamped', async () => {
        await wipe();
        const r = await grimoire.appendEntry({ markdown: 'hello world', entryId: 'R/S01', kind: 'verified' });
        assert(r.path && r.sha256 && r.bytesWritten > 0, 'returns ref');
        const text = await fsp.readFile(r.path, 'utf8');
        assert(text.includes('<!-- @grimoire:entry id="R/S01" kind="verified"'), 'open marker');
        assert(text.includes('<!-- @grimoire:entry:end id="R/S01" -->'), 'close marker');
        assert(text.includes('hello world'), 'body present');
    });

    // 3. hasEntry detects repeated runs
    await t('hasEntry true after append, false otherwise', async () => {
        await wipe();
        assert.strictEqual(await grimoire.hasEntry('R/X1'), false);
        await grimoire.appendEntry({ markdown: 'x', entryId: 'R/X1' });
        assert.strictEqual(await grimoire.hasEntry('R/X1'), true);
        assert.strictEqual(await grimoire.hasEntry('R/X2'), false);
    });

    // 4. unverified entries land under "Open Questions / Unverified" header
    await t('appendEntry: unverified header inserted once', async () => {
        await wipe();
        await grimoire.appendEntry({ markdown: 'a', entryId: 'R/A', kind: 'unverified' });
        await grimoire.appendEntry({ markdown: 'b', entryId: 'R/B', kind: 'unverified' });
        const text = await fsp.readFile(grimoire.grimoireFilePath(), 'utf8');
        const matches = text.match(/## Open Questions \/ Unverified/g) || [];
        assert.strictEqual(matches.length, 1, 'header appears exactly once');
        assert(text.includes('id="R/A"') && text.includes('id="R/B"'), 'both entries present');
    });

    // 5. Scribe: success verdict + clean wards → verified entry + grimoire.updated
    await t('Scribe: success → verified, emits grimoire.updated', async () => {
        await wipe();
        const bus = new FakeBus();
        const r = await runScribe({
            quest: quest(), charm: charm(), scroll: scroll(),
            reviewOut: reviewOut('success'),
            wardOut: wardOut({ total: 1, passed: 1, failed: 0, skipped: 0, errored: 0 }),
            runId: 'R-1', bus,
        });
        assert.strictEqual(r.wrote, true, 'wrote');
        assert.strictEqual(r.kind, 'verified', 'kind verified');
        assert.strictEqual(r.findingsWritten, 1);
        assert.strictEqual(r.findingsExcluded, 0);
        const ev = bus.events.find(e => e.type === 'grimoire.updated');
        assert(ev, 'grimoire.updated emitted');
        assert.strictEqual(ev.payload.kind, 'verified');
        assert.strictEqual(ev.payload.findingsWritten, 1);
        assert(ev.payload.sha256 && ev.payload.sha256.startsWith('sha256:'), 'sha256 present');
    });

    // 6. Scribe: needs_review → unverified (no verified facts)
    await t('Scribe: needs_review → unverified', async () => {
        await wipe();
        const bus = new FakeBus();
        const r = await runScribe({
            quest: quest(), charm: charm(), scroll: scroll(),
            reviewOut: reviewOut('needs_review'),
            wardOut: wardOut({ total: 1, passed: 0, failed: 0, skipped: 1, errored: 0 }),
            runId: 'R-2', bus,
        });
        assert.strictEqual(r.kind, 'unverified');
        assert.strictEqual(r.wrote, true);
        const text = await fsp.readFile(grimoire.grimoireFilePath(), 'utf8');
        assert(text.includes('## Open Questions / Unverified'));
        assert(text.includes('kind="unverified"'));
    });

    await t('Scribe: partial_success never promotes findings as verified', async () => {
        await wipe();
        const bus = new FakeBus();
        const r = await runScribe({
            quest: quest(), charm: charm(), scroll: scroll(),
            reviewOut: reviewOut('partial_success'), wardOut: null,
            runId: 'R-PARTIAL', bus,
        });
        assert.strictEqual(r.kind, 'unverified');
        assert.strictEqual(r.findingsWritten, 0);
        assert.strictEqual(r.findingsExcluded, 1);
        const text = await fsp.readFile(grimoire.grimoireFilePath(), 'utf8');
        assert(text.includes('kind="unverified"'));
    });

    // (7. Scribe ward-failure downgrade removed — the Wards/Skeptic layer was
    //  deleted; the Fairy's clean.wb run is now the only verification.)

    // 8. Scribe: idempotent — same runId+scrollId skips on second call
    await t('Scribe: repeated run is idempotent (skipped)', async () => {
        await wipe();
        const bus = new FakeBus();
        const args = {
            quest: quest(), charm: charm(), scroll: scroll(),
            reviewOut: reviewOut('success'),
            wardOut: wardOut({ total: 1, passed: 1, failed: 0, skipped: 0, errored: 0 }),
            runId: 'R-4', bus,
        };
        const a = await runScribe(args);
        const b = await runScribe(args);
        assert.strictEqual(a.wrote, true);
        assert.strictEqual(b.wrote, false);
        assert.strictEqual(b.reason, 'already_recorded');
    });

    // 9. Scribe: repeated DIFFERENT runs append without corrupting the file
    await t('Scribe: repeated runs append cleanly', async () => {
        await wipe();
        const bus = new FakeBus();
        await runScribe({ quest: quest(), charm: charm(), scroll: scroll({ id: 'S01' }),
            reviewOut: reviewOut('success'),
            wardOut: wardOut({ total: 1, passed: 1, failed: 0, skipped: 0, errored: 0 }),
            runId: 'R-A', bus });
        await runScribe({ quest: quest(), charm: charm(), scroll: scroll({ id: 'S02' }),
            reviewOut: reviewOut('success'),
            wardOut: wardOut({ total: 1, passed: 1, failed: 0, skipped: 0, errored: 0 }),
            runId: 'R-B', bus });
        const text = await fsp.readFile(grimoire.grimoireFilePath(), 'utf8');
        assert(text.includes('id="R-A/S01"') && text.includes('id="R-B/S02"'),
               'both entries preserved');
        // Sanity: header still at the top, written exactly once.
        const hdrMatches = text.match(/# Oberon Grimoire/g) || [];
        assert.strictEqual(hdrMatches.length, 1);
    });

    // 10. Scribe: write failure → omen + safe return
    await t('Scribe: write failure degrades to omen', async () => {
        const bus = new FakeBus();
        // Force grimoire.appendEntry to throw by stubbing it.
        const orig = grimoire.appendEntry;
        grimoire.appendEntry = async () => { throw new Error('disk full'); };
        try {
            const r = await runScribe({
                quest: quest(), charm: charm(), scroll: scroll({ id: 'S99' }),
                reviewOut: reviewOut('success'),
                wardOut: wardOut({ total: 1, passed: 1, failed: 0, skipped: 0, errored: 0 }),
                runId: 'R-fail', bus,
            });
            assert.strictEqual(r.wrote, false);
            const omen = bus.events.find(e => e.type === 'omen' && e.payload.kind === 'grimoire_write_failed');
            assert(omen, 'omen emitted');
        } finally {
            grimoire.appendEntry = orig;
        }
    });

    // 11. Scribe: provenance links use relative paths from the grimoire dir
    await t('Scribe: provenance uses relative paths', async () => {
        await wipe();
        const bus = new FakeBus();
        const scrollPath = path.join(TMP_ROOT, 'quests', 'Q01_test', 'scrolls', 'S01.json');
        await fsp.mkdir(path.dirname(scrollPath), { recursive: true });
        await fsp.writeFile(scrollPath, '{}', 'utf8');
        await runScribe({
            quest: quest(), charm: charm(), scroll: scroll({ id: 'S77' }),
            reviewOut: reviewOut('success'),
            wardOut: wardOut({ total: 1, passed: 1, failed: 0, skipped: 0, errored: 0 }),
            runId: 'R-rel', bus,
            scrollFileRef: { path: scrollPath },
        });
        const text = await fsp.readFile(grimoire.grimoireFilePath(), 'utf8');
        assert(text.includes('../quests/Q01_test/scrolls/S01.json'),
               'relative path is rendered');
    });

    // 12. Postmortem: file created with verdict + grimoire result
    await t('Postmortem: creates markdown with structured sections', async () => {
        const pm = await writePostmortem({
            runId: 'R-pm-1', brief: 'a brief',
            quest: quest(), charm: charm(), scroll: scroll(),
            reviewOut: reviewOut('success'),
            wardOut: wardOut({ total: 2, passed: 1, failed: 1, skipped: 0, errored: 0 }),
            grimoireResult: { wrote: true, kind: 'unverified', path: '/x', sha256: 'sha256:abc',
                              findingsWritten: 1, findingsExcluded: 1 },
            runSummary: { llmCallCount: 3, toolCallCount: 5, totalCostUSD: 0.0123,
                          startedAt: new Date(Date.now() - 4000).toISOString(),
                          endedAt: new Date().toISOString(), state: 'IDLE' },
        });
        assert(pm && pm.path && pm.path.endsWith('R-pm-1.md'));
        const text = await fsp.readFile(pm.path, 'utf8');
        assert(text.includes('# Run postmortem'), 'has title');
        assert(text.includes('## Verification'), 'has Verification section');
        assert(text.includes('Grimoire'), 'has Grimoire section');
        assert(text.includes('Next suggested action'), 'has next action');
        assert(text.includes('Clean-run verdict'), 'reports clean-run verdict');
    });

    // 13. Postmortem: failed-verdict run gets a re-run recommendation
    await t('Postmortem: failed verdict suggests re-run', async () => {
        const pm = await writePostmortem({
            runId: 'R-pm-fail',
            quest: quest(), charm: charm(), scroll: scroll(),
            reviewOut: reviewOut('failed'),
            wardOut: null,
        });
        const text = await fsp.readFile(pm.path, 'utf8');
        assert(text.includes('Re-run with a sharper brief'),
               'next-action mentions re-run');
    });

    // 14. Postmortem skipped at the call site when setting is off — we just
    // exercise the no-args degraded behaviour to make sure it never throws.
    await t('Postmortem: handles missing optional fields', async () => {
        const pm = await writePostmortem({ runId: 'R-pm-bare' });
        assert(pm && pm.path);
        const text = await fsp.readFile(pm.path, 'utf8');
        assert(text.includes('UNKNOWN'), 'falls back to UNKNOWN verdict');
    });

    // 15. End-to-end Scribe: empty scroll → skipped, no file mutation
    await t('Scribe: empty scroll → skipped, no entry written', async () => {
        await wipe();
        const bus = new FakeBus();
        const r = await runScribe({
            quest: quest(), charm: charm(),
            scroll: { id: 'S0', findings: [], openQuestions: [], evidence: [], summary: '' },
            reviewOut: reviewOut('success'), wardOut: null,
            runId: 'R-empty', bus,
        });
        assert.strictEqual(r.wrote, false);
        assert.strictEqual(r.reason, 'empty_scroll');
        // No grimoire.updated event for skipped runs.
        const ev = bus.events.find(e => e.type === 'grimoire.updated');
        assert(!ev, 'no grimoire.updated emitted');
    });

    console.log(`\n${pass + fail} tests run — ${pass} passed, ${fail} failed.`);
    if (fail) {
        console.log('FAILED (' + fail + ' / ' + (pass + fail) + ')');
        process.exit(1);
    } else {
        console.log('ALL OK (' + pass + ' tests)');
        process.exit(0);
    }
})();
