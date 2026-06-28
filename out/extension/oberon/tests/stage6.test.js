'use strict';
/**
 * Stage 6 — run-robustness fixes (FAIRY_RUN_OBSERVATIONS_R3_22JUN.md):
 *  O1  — compaction never orphans a `tool` message (findSafeTailStart, sanitizeToolPairing)
 *  O6  — estimateContextChars
 *  O4  — appendCheckpointSection dedupes already-committed steps
 *  O9  — buildCleanCells deterministically builds clean.wb cells (no dup steps)
 */

const assert  = require('assert');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const Module  = require('module');

// ── vscode stub ──────────────────────────────────────────────────────────────
const fakeVscodeId = path.resolve(__dirname, '..', 'vscode.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
        window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) },
        EventEmitter: class { constructor() { this.event = () => {}; } on() {} off() {} fire() {} },
        Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
    },
};
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function (req, parent, isMain, opts) {
    if (req === 'vscode') return fakeVscodeId;
    return origResolve(req, parent, isMain, opts);
};

let passCount = 0, failCount = 0;
const failures = [];
async function ok(label, fn) {
    try { await fn(); console.log(`  ok ${label}`); passCount++; }
    catch (e) { console.error(`  FAIL ${label}: ${e && e.message || e}`); failures.push({ label, err: e }); failCount++; }
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'stage6-')); }

const { _internals } = require('../core/fairy');
const { findSafeTailStart, sanitizeToolPairing, estimateContextChars } = _internals;
const { createWorkDir, buildCleanCells } = require('../fairy/workDir');

// Build a realistic message stream: assistant(tool_calls) → tool → ... with some user msgs.
function msgStream() {
    const a = (id) => ({ role: 'assistant', tool_calls: [{ id, function: { name: 'probe', arguments: '{"code":"1+1"}' } }] });
    const t = (id) => ({ role: 'tool', tool_call_id: id, content: '{"ok":true}' });
    return [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'task' },
        a('c1'), t('c1'),
        a('c2'), t('c2'),
        { role: 'user', content: '[steer]' },
        a('c3'), t('c3'),
        a('c4'), t('c4'),
    ];
}

// ── O1 ─────────────────────────────────────────────────────────────────────────

async function runO1() {
    console.log('\n── O1: compaction tool/tool_calls pairing ──');

    await ok('O1: findSafeTailStart never lands on a tool message', async () => {
        const m = msgStream();
        for (let len = 1; len <= m.length - 2; len++) {
            const idx = findSafeTailStart(m, len, 2);
            assert.ok(m[idx].role !== 'tool', `tail start ${idx} is a tool message (len=${len})`);
            assert.ok(idx >= 2, 'never below minStart');
        }
    });

    await ok('O1: sanitizeToolPairing drops an orphan tool message', async () => {
        const bad = [
            { role: 'system', content: 's' },
            { role: 'user', content: 'u' },
            { role: 'tool', tool_call_id: 'x', content: 'orphan' },   // no preceding tool_calls
            { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'p', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c', content: 'ok' },        // valid
        ];
        const clean = sanitizeToolPairing(bad);
        const toolMsgs = clean.filter(x => x.role === 'tool');
        assert.strictEqual(toolMsgs.length, 1, 'only the paired tool message survives');
        // every tool message is preceded by an assistant with tool_calls
        for (let i = 0; i < clean.length; i++) {
            if (clean[i].role === 'tool') {
                const prev = clean[i - 1];
                assert.ok(prev && prev.role === 'assistant' && prev.tool_calls, 'tool follows tool_calls');
            }
        }
    });

    await ok('O1-fix: MULTI tool_calls in one turn keep ALL their tool results', async () => {
        // The real run_2026-06-24 bug: one assistant turn with 3 tool_calls; the old
        // "immediately-preceded-by-assistant" rule dropped the 2nd/3rd tool results →
        // assistant tool_calls left with missing responses → provider 400.
        const msgs = [
            { role: 'system', content: 's' },
            { role: 'user', content: 'u' },
            { role: 'assistant', tool_calls: [
                { id: 'a', function: { name: 'note_fact', arguments: '{}' } },
                { id: 'b', function: { name: 'note_fact', arguments: '{}' } },
                { id: 'c', function: { name: 'note_fact', arguments: '{}' } },
            ] },
            { role: 'tool', tool_call_id: 'a', content: '1' },
            { role: 'tool', tool_call_id: 'b', content: '2' },
            { role: 'tool', tool_call_id: 'c', content: '3' },
        ];
        const clean = sanitizeToolPairing(msgs);
        const ids = clean.filter(x => x.role === 'tool').map(x => x.tool_call_id).sort();
        assert.deepStrictEqual(ids, ['a', 'b', 'c'], 'all three tool results survive');
    });
    await ok('O1-fix: missing tool result for an assistant tool_call is synthesized', async () => {
        const msgs = [
            { role: 'assistant', tool_calls: [
                { id: 'a', function: { name: 'probe', arguments: '{}' } },
                { id: 'b', function: { name: 'probe', arguments: '{}' } },
            ] },
            { role: 'tool', tool_call_id: 'a', content: '1' },   // 'b' response missing
        ];
        const clean = sanitizeToolPairing(msgs);
        const ids = clean.filter(x => x.role === 'tool').map(x => x.tool_call_id).sort();
        assert.deepStrictEqual(ids, ['a', 'b'], 'missing tool result synthesized so pairing is valid');
    });
    await ok('O1: a user/summary inserted before the tail does not orphan a tool', async () => {
        const m = msgStream();
        const tailStart = findSafeTailStart(m, 4, 2);   // emulate keepLast*2 = 4
        const head = m.slice(0, 2);
        const summary = { role: 'user', content: '[digest]' };
        const tail = m.slice(tailStart);
        const result = sanitizeToolPairing([...head, summary, ...tail]);
        // No tool message without a preceding assistant tool_calls
        for (let i = 0; i < result.length; i++) {
            if (result[i].role === 'tool') {
                const prev = result[i - 1];
                assert.ok(prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls),
                    `orphan tool at ${i} after compaction`);
            }
        }
    });
}

// ── O6 ─────────────────────────────────────────────────────────────────────────

async function runO6() {
    console.log('\n── O6: estimateContextChars ──');
    await ok('O6: counts content + tool_call arguments', async () => {
        const m = [
            { role: 'user', content: 'abcd' },
            { role: 'assistant', tool_calls: [{ function: { name: 'probe', arguments: '12345' } }] },
        ];
        const n = estimateContextChars(m);
        assert.strictEqual(n, 4 + 5 + 'probe'.length);
    });
    await ok('O6: empty messages → 0', async () => {
        assert.strictEqual(estimateContextChars([]), 0);
    });
}

// ── O4 ─────────────────────────────────────────────────────────────────────────

function step(id, code) {
    return { id, probeId: id.replace('s', 'p'), code, resultRef: id.replace('s', 'p'),
        dependsOn: [], usesSymbols: [], definesSymbols: [id], note: id, status: 'valid' };
}

async function runO4() {
    console.log('\n── O4: checkpoint dedup ──');

    await ok('O4: a step committed in an earlier section is not re-added', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.appendCheckpointSection({ sectionTitle: 'Sec A', steps: [step('sA', 'a=1')], inputs: [], assumptions: [] });
        // Sec B includes sA again plus a new sB
        await wd.appendCheckpointSection({ sectionTitle: 'Sec B', steps: [step('sA', 'a=1'), step('sB', 'b=2')], inputs: [], assumptions: [] });

        const nb = JSON.parse(fs.readFileSync(wd.checkpointNb, 'utf8'));
        const stepCells = nb.cells.filter(c => {
            const tags = (c.metadata && c.metadata.tags) || [];
            return tags.includes('step');
        });
        const ids = stepCells.map(c => { const t = c.metadata.tags; return t[t.indexOf('step') + 1]; });
        // sA should appear exactly once, sB once
        assert.strictEqual(ids.filter(x => x === 'sA').length, 1, `sA count: ${ids.filter(x=>x==='sA').length}`);
        assert.strictEqual(ids.filter(x => x === 'sB').length, 1);
    });

    await ok('O4: a section with only already-committed steps adds a note, not dup cells', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.appendCheckpointSection({ sectionTitle: 'Sec A', steps: [step('sA', 'a=1')], inputs: [], assumptions: [] });
        await wd.appendCheckpointSection({ sectionTitle: 'Sec A again', steps: [step('sA', 'a=1')], inputs: [], assumptions: [] });
        const nb = JSON.parse(fs.readFileSync(wd.checkpointNb, 'utf8'));
        const sACells = nb.cells.filter(c => { const t = (c.metadata && c.metadata.tags) || []; return t[t.indexOf('step') + 1] === 'sA'; });
        assert.strictEqual(sACells.length, 1, 'sA still only once');
        assert.ok(nb.cells.some(c => /already committed/.test(c.value || '')), 'note cell present');
    });
}

// ── O9 ─────────────────────────────────────────────────────────────────────────

async function runO9() {
    console.log('\n── O9: buildCleanCells deterministic ──');

    await ok('O9: header + input + assumptions + step cells', async () => {
        const cells = buildCleanCells({
            taskTitle: 'My task',
            inputs: [{ id: 'in1', code: 'n = 4' }],
            assumptions: [{ statement: 'n>0', wlAssumption: 'n > 0' }],
            steps: [step('s1', 'Hmat = {{1}}'), step('s2', 'eigs = Eigenvalues[Hmat]')],
        });
        const text = cells.map(c => c.value).join('\n');
        assert.ok(text.includes('My task'), 'task title');
        assert.ok(text.includes('n = 4'), 'input');
        assert.ok(text.includes('$Assumptions = And[n > 0]'), 'assumptions');
        assert.ok(text.includes('Hmat = {{1}}') && text.includes('eigs = Eigenvalues[Hmat]'), 'steps');
    });

    await ok('O9: each recorded step appears exactly once (no dup)', async () => {
        const cells = buildCleanCells({
            taskTitle: 'T', inputs: [], assumptions: [],
            steps: [step('s1', 'a=1'), step('s2', 'b=2')],
        });
        const stepCells = cells.filter(c => (c.metadata && c.metadata.tags || []).includes('step'));
        assert.strictEqual(stepCells.length, 2);
    });

    await ok('O9: empty chain → just a header cell', async () => {
        const cells = buildCleanCells({ taskTitle: 'T', inputs: [], assumptions: [], steps: [] });
        assert.strictEqual(cells.length, 1);
    });

    await ok('clean.wb: registered util used by a step is emitted before steps', async () => {
        const cells = buildCleanCells({
            taskTitle: 'T', inputs: [], assumptions: [],
            steps: [step('s1', 'm0 = baxterTQ[4, 0]')],
            utils: [{ name: 'baxterTQ', code: 'baxterTQ[L_, M_] := L + M', note: 'TQ solver' }],
        });
        const text = cells.map(c => c.value).join('\n');
        assert.ok(text.includes('baxterTQ[L_, M_] :='), 'util def present');
        const utilIdx = cells.findIndex(c => /baxterTQ\[L_/.test(c.value || ''));
        const stepIdx = cells.findIndex(c => /m0 = baxterTQ/.test(c.value || ''));
        assert.ok(utilIdx >= 0 && utilIdx < stepIdx, 'util comes before the step that calls it');
    });

    await ok('clean.wb: an unused util is NOT emitted', async () => {
        const cells = buildCleanCells({
            taskTitle: 'T', inputs: [], assumptions: [],
            steps: [step('s1', 'a = 1')],
            utils: [{ name: 'unusedHelper', code: 'unusedHelper[x_] := x', note: 'n' }],
        });
        const text = cells.map(c => c.value).join('\n');
        assert.ok(!text.includes('unusedHelper[x_]'), 'unused util omitted');
    });
}

// ── Skill citation ──────────────────────────────────────────────────────────

async function runCitation() {
    console.log('\n── Skill citation (skills-used + citation) ──');
    const cite = require('../fairy/skillCitation');

    await ok('parseSkillRef splits ns/name/version', async () => {
        assert.deepStrictEqual(cite.parseSkillRef('@vanbaalon/su2-xxx-bethe-roots-tq@0.1.0'),
            { namespace: 'vanbaalon', name: 'su2-xxx-bethe-roots-tq', version: '0.1.0' });
    });
    await ok('skillPageUrl uses bare namespace (no @)', async () => {
        assert.strictEqual(cite.skillPageUrl('https://skilxiv.org', '@vanbaalon/su2-xxx-bethe-roots-tq@0.1.0'),
            'https://skilxiv.org/n/vanbaalon/su2-xxx-bethe-roots-tq');
    });
    await ok('buildSkillsUsedMarkdown has link, conclusion, citation, bibtex', async () => {
        const md = cite.buildSkillsUsedMarkdown({
            baseUrl: 'https://skilxiv.org',
            skills: [{ ref: '@vanbaalon/su2-xxx-bethe-roots-tq@0.1.0', used: true, outcome: 'used_reproduced' }],
            accessedDate: '2026-06-22',
        });
        assert.ok(md.includes('## Skills used'));
        assert.ok(md.includes('/n/vanbaalon/su2-xxx-bethe-roots-tq'), 'skill page link');
        assert.ok(/reproduced/i.test(md), 'usefulness conclusion');
        assert.ok(md.includes('Suggested citation'), 'citation section');
        assert.ok(md.includes('```bibtex') && md.includes('@misc{skilxiv_vanbaalon_su2'), 'bibtex');
        assert.ok(md.includes('accessed 2026-06-22'), 'accessed date');
    });
    await ok('buildSkillsUsedMarkdown empty when no skills', async () => {
        assert.strictEqual(cite.buildSkillsUsedMarkdown({ skills: [] }), '');
    });
    await ok('buildSkillsUsedMarkdown includes the run report when provided', async () => {
        const md = cite.buildSkillsUsedMarkdown({
            skills: [{ ref: '@n/s@1', used: true, outcome: 'used_reproduced' }],
            runReport: 'Reproduced via this skill. Task: solve X. Key result: eigs = {1,2}',
        });
        assert.ok(md.includes("This run's report"), 'report heading');
        assert.ok(md.includes('Key result: eigs = {1,2}'), 'report body');
    });
    await ok('clean.wb appends skills-used cell when skillsBlock given', async () => {
        const cells = buildCleanCells({
            taskTitle: 'T', inputs: [], assumptions: [], steps: [step('s1', 'a=1')],
            skillsBlock: '## Skills used\n\n- foo',
        });
        const last = cells[cells.length - 1];
        assert.ok((last.value || '').includes('## Skills used'), 'skills cell appended last');
        assert.ok(((last.metadata && last.metadata.tags) || []).includes('skills-used'));
    });
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    for (const s of [runO1, runO6, runO4, runO9, runCitation]) await s();
    console.log(`\n── Stage 6 Results: ${passCount} passed, ${failCount} failed ──`);
    if (failures.length) {
        for (const { label, err } of failures) {
            console.error(`  [FAIL] ${label}`);
            if (err && err.stack) console.error('    ' + err.stack.split('\n').join('\n    '));
        }
        process.exit(1);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
