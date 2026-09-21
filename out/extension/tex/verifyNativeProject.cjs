// Exercise WPaper's actual build/map lane on an isolated copy of a TeX project.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { NativeBuildLane } = require('./nativeCompileService');
const { NativeMap } = require('./nativeMap');
const { shipDecision } = require('./livePolicy');

async function main() {
    const [directory, input, expectedPages] = process.argv.slice(2);
    if (!directory || !input) throw Error('Usage: node verifyNativeProject.cjs WLATEX_INSTALL MAIN_TEX [EXPECTED_PAGES]');
    const run = await fs.mkdtemp(path.join(os.tmpdir(), 'wpaper-native-project-'));
    const project = path.join(run, 'project');
    const original = path.resolve(input);
    await fs.cp(path.dirname(original), project, { recursive:true,
        filter:file => !['.git', '.wlatex'].includes(path.basename(file)) });
    const root = path.join(project, path.basename(original));
    const text = await fs.readFile(root, 'utf8');
    const lane = new NativeBuildLane(root, directory);
    const timings = {};
    try {
        let started = performance.now();
        const first = await lane.compile({ sourceFiles:[root], sourceSnapshotHash:'reference' });
        timings.first_build_ms = performance.now() - started;
        if (expectedPages) assert.equal(first.pageCount, Number(expectedPages));
        assert.ok(first.pageCount > 0);
        const firstMap = new NativeMap({ ...first, generation:first });
        assert.ok(firstMap.available);
        const priorPdf = await fs.readFile(first.pdfPath);
        const edited = '% WPaper source-map republication check\n' + text;
        await lane.noteChange({ uri:{ fsPath:root }, getText:() => edited },
            [{ rangeOffset:0, rangeLength:0, text:edited.slice(0, edited.length - text.length) }]);
        assert.equal(firstMap.available, false);
        started = performance.now();
        const second = await lane.compile({ overlay:new Map([[root, edited]]), sourceSnapshotHash:'edited' });
        timings.rebuild_ms = performance.now() - started;
        assert.equal(second.pageCount, first.pageCount);
        assert.ok(second.generation > first.generation);
        assert.notEqual(second.nativeView, first.nativeView);
        const map = new NativeMap({ ...second, generation:second });
        assert.ok(map.available);
        assert.equal(second.nativeReport.changedPages.length, 0);
        assert.equal(second.nativeReport.removedPages.length, 0);
        assert.equal(second.pdfHash, first.pdfHash);
        assert.equal(shipDecision({ shownGeneration:first.generation, shownPdfHash:first.pdfHash, gen:second }).ship, false);
        let mappedPages = 0, glyphs = 0;
        started = performance.now();
        for (const page of second.nativeView.pages) {
            const hits = page.hits.filter(hit => hit.preferred_source?.file === path.basename(root) &&
                hit.preferred_source.location.accuracy === 'Exact');
            glyphs += hits.length;
            if (!hits.length) continue;
            mappedPages++;
            const source = hits[0].preferred_source.location.start;
            const rects = await map.forwardAt(root, source.line, source.column_utf16);
            assert.ok(rects?.some(rect => rect.page === page.page), `page ${page.page} has no forward answer`);
        }
        timings.sampled_page_queries_ms = performance.now() - started;
        assert.ok(mappedPages > 0);
        assert.equal(await fs.readFile(root, 'utf8'), text);
        assert.deepEqual(await fs.readFile(first.pdfPath), priorPdf);
        process.stdout.write(JSON.stringify({ result:'PASS', run, pages:second.pageCount,
            mapped_pages:mappedPages, exact_main_file_items:glyphs, timings,
            source_sha256:createHash('sha256').update(text).digest('hex'),
            adapter_sha256:createHash('sha256').update(await fs.readFile(path.join(__dirname,'nativeMap.js'))).digest('hex'),
            lane_sha256:createHash('sha256').update(await fs.readFile(path.join(__dirname,'nativeCompileService.js'))).digest('hex'),
            unchanged_pdf_not_reshipped:true, new_source_map_admitted:true,
            source_files_unchanged:true, previous_pdf_immutable:true,
            cross_engine_parity_verified:false, live_ui_acceptance_verified:false }, null, 2) + '\n');
    } catch (error) {
        error.message += ` (project evidence: ${run})`;
        throw error;
    } finally { await lane.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
