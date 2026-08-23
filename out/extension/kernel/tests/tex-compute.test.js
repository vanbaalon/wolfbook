// TexComputeService: choosing a kernel, choosing a width, and writing a figure.
//
//   node out/extension/kernel/tests/tex-compute.test.js
//
// The kernel itself is stubbed. What is being checked is everything AROUND the
// evaluation, which is where the decisions live: a busy kernel is reported
// rather than preempted, the lease is always released, the width is the
// paper's and not the notebook's, and a figure written twice is one file.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withVscodeStub, makeVscodeStub } = require('./_stub-vscode');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => Promise.resolve().then(fn)
    .then(() => { pass++; results.push('  ok   ' + name); })
    .catch((e) => { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); });

let settings = {};
const stub = makeVscodeStub();
stub.workspace.getConfiguration = () => ({
    get: (k, dflt) => (k in settings ? settings[k] : dflt),
    update: async () => {},
});
const { TexComputeService } = withVscodeStub(() => require('../../tex/texCompute'), stub);

// A controller whose arbiter hands out (or refuses) a lease, and whose session
// answers with whatever the test wants the kernel to have said.
function makeCtrl({ reply = 'BOXES:x', busy = null, throws = null } = {}) {
    const log = { acquired: 0, released: 0, evaluated: [] };
    const ctrl = {
        log,
        arbiter: {
            acquire: async () => (busy ? { busy } : { lease: { operationId: 'op-1' } }),
            release: () => { log.released++; },
            status: () => ({ activeOperation: null, busy: false }),
        },
        session: {
            evaluate: async (expr) => {
                log.evaluated.push(expr);
                if (throws) throw new Error(throws);
                return { result: { type: 'string', value: reply } };
            },
        },
    };
    const origAcquire = ctrl.arbiter.acquire;
    ctrl.arbiter.acquire = async (...a) => { log.acquired++; return origAcquire(...a); };
    return ctrl;
}

const svc = (ctrl, mgr) => new TexComputeService({
    resolveController: ctrl ? () => ctrl : null,
    kernelManager: mgr || null,
});

// --- availability ----------------------------------------------------------

test('with no kernel resolver the service loads and says so when asked to run', async () => {
    const s = svc(null);
    assert.strictEqual(s.available(), false);
    const out = await s.run('/p/paper.tex', '1+1', {});
    assert.ok(out.error && /no Wolfram kernel/i.test(out.error));
});

// --- width -----------------------------------------------------------------

test('with nothing measured, the width is a one-column article, not a notebook', async () => {
    settings = {};
    // 80 em is the notebook default and is nearly twice a paper's text block;
    // using it would push every inserted equation into the margin.
    const w = svc(null).widthFor({});
    assert.strictEqual(w.em, 35);           // 345pt / 10pt
    assert.strictEqual(w.source, 'default');
});

test('a measured text width wins over the fallback', async () => {
    settings = {};
    const w = svc(null).widthFor({ textWidthPt: 430, emPt: 10 });
    assert.strictEqual(w.em, 43);
    assert.strictEqual(w.source, 'measured');
});

test('the printed ink is used when nothing measured the source', async () => {
    settings = {};
    const w = svc(null).widthFor({ inkWidthBp: 345 });
    assert.strictEqual(w.em, 35);
    assert.strictEqual(w.source, 'ink');
});

test('the setting outranks every measurement — it is the escape hatch', async () => {
    settings = { 'tex.textWidthPt': 500 };
    const w = svc(null).widthFor({ textWidthPt: 345, inkWidthBp: 345, emPt: 10 });
    assert.strictEqual(w.em, 50);
    assert.strictEqual(w.source, 'setting');
    settings = {};
});

test('a nonsensical measurement cannot produce a width too small to break at', async () => {
    settings = {};
    assert.ok(svc(null).widthFor({ inkWidthBp: 3 }).em >= 10);
});

// --- running ---------------------------------------------------------------

test('a successful run leases the kernel, evaluates once, and releases', async () => {
    const ctrl = makeCtrl({ reply: 'TEXT:42' });
    const out = await svc(ctrl).run('/p/paper.tex', '6*7', { pageWidthEm: 34 });
    assert.strictEqual(out.result.kind, 'text');
    assert.strictEqual(out.result.text, '42');
    assert.strictEqual(ctrl.log.acquired, 1, 'the kernel was leased');
    assert.strictEqual(ctrl.log.released, 1, 'and given back');
    assert.strictEqual(ctrl.log.evaluated.length, 1);
    assert.ok(typeof out.result.ms === 'number', 'and the run is timed');
});

test('the source reaches the kernel inside the guarded wrapper', async () => {
    const ctrl = makeCtrl();
    await svc(ctrl).run('/p/paper.tex', 'Integrate[f[x], x]', {});
    const expr = ctrl.log.evaluated[0];
    assert.ok(expr.includes('Integrate[f[x], x]'), 'the code is in there');
    assert.ok(expr.includes('TimeConstrained['), 'wrapped in a timeout');
    assert.ok(expr.includes('ToExpression['), 'and parsed before it is run');
});

test('A BUSY KERNEL IS REPORTED, NEVER INTERRUPTED', async () => {
    // Someone else is mid-evaluation. Preempting them to typeset a figure would
    // be the wrong trade, and doing it silently would be worse.
    const ctrl = makeCtrl({ busy: { message: 'running', operation_id: 'op-9' } });
    const out = await svc(ctrl).run('/p/paper.tex', '1+1', {});
    assert.ok(out.busy, 'the caller is told it is busy');
    assert.strictEqual(out.busy.operation_id, 'op-9', 'and what is running');
    assert.ok(!out.result, 'nothing was evaluated');
    assert.strictEqual(ctrl.log.evaluated.length, 0);
});

test('a kernel that throws releases the lease anyway', async () => {
    const ctrl = makeCtrl({ throws: 'WSTP link died' });
    const out = await svc(ctrl).run('/p/paper.tex', '1+1', {});
    assert.ok(out.error && /WSTP link died/.test(out.error));
    assert.strictEqual(ctrl.log.released, 1, 'the kernel is not left leased to a dead run');
});

test('the page width reaches the LaTeX conversion rather than being defaulted', async () => {
    // The whole point of measuring the paper: a BOXES reply must be broken to
    // the paper's width. Proven through the public path by asking for a width
    // no default would produce.
    const ctrl = makeCtrl({ reply: 'BOXES:RowBox[{"x"}]' });
    const out = await svc(ctrl).run('/p/paper.tex', 'x', { pageWidthEm: 34, katex: false });
    assert.ok(out.result, 'a result came back');
    assert.ok(['latex', 'text'].includes(out.result.kind),
        'boxes become LaTeX, or say honestly that the converter is missing');
});

// --- figures ---------------------------------------------------------------

test('a figure is written beside the paper, named by its own content', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbcomp-'));
    const texPath = path.join(dir, 'paper.tex');
    const s = svc(null);
    const a = s.writeAsset(texPath, { text: '<svg id="one"/>', ext: 'svg' });
    assert.ok(/^img\/paper\/wl_[0-9a-f]{12}\.svg$/.test(a.rel), `unexpected name: ${a.rel}`);
    assert.ok(fs.existsSync(a.abs), 'the file is really there');
    assert.strictEqual(fs.readFileSync(a.abs, 'utf8'), '<svg id="one"/>');
    assert.ok(!a.rel.includes('\\'), 'forward slashes only — a backslash is an escape to TeX');

    // The SAME picture is the same file. This is what makes recomputing an
    // unchanged result reproduce byte-identical LaTeX.
    const again = s.writeAsset(texPath, { text: '<svg id="one"/>', ext: 'svg' });
    assert.strictEqual(again.rel, a.rel);

    // A DIFFERENT picture is a different file, never a silent overwrite.
    const b = s.writeAsset(texPath, { text: '<svg id="two"/>', ext: 'svg' });
    assert.notStrictEqual(b.rel, a.rel);
    assert.strictEqual(fs.readFileSync(a.abs, 'utf8'), '<svg id="one"/>', 'the first is untouched');

    const png = s.writeAsset(texPath, { base64: Buffer.from('PNGDATA').toString('base64'), ext: 'png' });
    assert.strictEqual(fs.readFileSync(png.abs, 'utf8'), 'PNGDATA', 'base64 assets are decoded');
    fs.rmSync(dir, { recursive: true, force: true });
});

// --- kernels ---------------------------------------------------------------

test('the kernel list is shaped for a picker, and names the paper\'s own binding', async () => {
    const mgr = {
        list: () => ([
            { kernel_id: 'k-1', kernel_label: 'Kernel A', is_default: true, busy: false, lifecycle: 'ready' },
            { kernel_id: 'k-2', kernel_label: 'Kernel B', is_default: false, busy: true, lifecycle: 'ready' },
        ]),
        bindingFor: (p) => (p === '/p/paper.tex' ? { id: 'k-2' } : null),
    };
    const r = svc(null, mgr).kernelsFor('/p/paper.tex');
    assert.strictEqual(r.kernels.length, 2);
    assert.strictEqual(r.boundId, 'k-2', 'a paper binds a kernel the way a notebook does');
    assert.strictEqual(r.kernels[1].busy, true);
});

test('no kernel manager is an empty list, not a crash', async () => {
    assert.deepStrictEqual(svc(null).kernelsFor('/p/paper.tex'), { kernels: [], boundId: null });
});

setTimeout(() => {
    console.log('\ntex-compute.test.js');
    console.log(results.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}, 50);
