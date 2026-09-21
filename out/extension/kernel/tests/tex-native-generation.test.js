const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeBuildLane } = require('../../tex/nativeCompileService');
const { nextGeneration } = require('../../tex/compileService');
const { shipDecision } = require('../../tex/livePolicy');

test('native display generations share the conventional allocator across session reconstruction', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-generation-'));
    const root = path.join(directory, 'paper.tex');
    const pdf = path.join(directory, 'paper.pdf');
    fs.writeFileSync(root, 'Alpha'); fs.writeFileSync(pdf, 'PDF fixture');
    const calls = [];
    const createLane = () => {
        const files = new Map();
        const lane = Object.create(NativeBuildLane.prototype);
        Object.assign(lane, { root, projectDir:directory, buildNumber:0, version:0, edits:Promise.resolve(),
            source:{ files, open:async (file, text) => files.set(file, { text }),
                capture:async () => ({ files:{} }), publish:async () => {}, readPages:async () => ({}) },
            compiler:{ compile:async options => {
                calls.push(options.generation);
                assert.equal(options.timeoutMs, 45000);
                return { success:true, generation:options.generation, pdf, diagnostics:[],
                    build:{ source_bindings:[], page_count:1, pages:[{width_pt:612,height_pt:792}],
                        passes:[], pdf_hash:`pdf-${calls.length}` } };
            } } });
        return lane;
    };
    try {
        const conventionalBefore = nextGeneration();
        const first = await createLane().compile({ timeoutMs:45000 });
        const conventionalBetween = nextGeneration();
        const second = await createLane().compile({ timeoutMs:45000 });
        const conventionalAfter = nextGeneration();
        assert.ok(conventionalBefore < first.generation);
        assert.ok(first.generation < conventionalBetween);
        assert.ok(conventionalBetween < second.generation);
        assert.ok(second.generation < conventionalAfter);
        assert.deepEqual(calls, [1,1], 'SDK numbering starts independently in each session');
        for (const shownGeneration of [first.generation, conventionalBetween]) {
            assert.equal(shipDecision({ shownGeneration, shownPdfHash:first.pdfHash, gen:second }).ship, true);
        }
        assert.equal(shipDecision({ shownGeneration:first.generation, shownPdfHash:second.pdfHash,
            gen:second }).reason, 'identical pdf', 'fresh maps do not require resending unchanged pixels');
    } finally { fs.rmSync(directory, { recursive:true, force:true }); }
});
