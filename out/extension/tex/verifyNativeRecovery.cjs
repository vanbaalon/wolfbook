// Real optional-runtime session reconstruction check. No extension deployment.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { NativeBuildLane } = require('./nativeCompileService');
const { NativeMap } = require('./nativeMap');
const { nextGeneration } = require('./compileService');
const { shipDecision } = require('./livePolicy');

async function main() {
    const directory = process.argv[2];
    if (!directory) throw Error('Usage: node verifyNativeRecovery.cjs /absolute/WLaTeX/install');
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'wpaper-native-recovery-'));
    const root = path.join(project, 'paper.tex');
    const original = '\\documentclass{article}\n\\begin{document}\nAlpha\n\\end{document}\n';
    const edited = original.replace('Alpha', 'Beta');
    await fs.writeFile(root, original);
    let lane = new NativeBuildLane(root, directory);
    try {
        const first = await lane.compile({ sourceFiles:[root], sourceSnapshotHash:'first' });
        const oldMap = new NativeMap({ ...first, generation:first });
        assert.ok(oldMap.available);
        const originalPdf = await fs.readFile(first.pdfPath);
        // The public close contract terminates the source process. Recovery
        // must use a new session; old snapshots and page views cannot migrate.
        await lane.source.close();
        assert.equal(oldMap.available, false);
        await assert.rejects(lane.compile({ overlay:new Map([[root, edited]]) }));
        await lane.close();
        const interveningGeneration = nextGeneration();
        lane = new NativeBuildLane(root, directory);
        const recovered = await lane.compile({ overlay:new Map([[root, edited]]), sourceSnapshotHash:'edited' });
        assert.notEqual(recovered.nativeSource, first.nativeSource);
        assert.ok(interveningGeneration > first.generation);
        assert.ok(recovered.generation > interveningGeneration);
        assert.equal(recovered.nativeReport.generation, 1, 'SDK build numbering remains per session');
        assert.equal(shipDecision({ shownGeneration:first.generation,
            shownPdfHash:first.pdfHash, gen:recovered }).ship, true);
        assert.equal(shipDecision({ shownGeneration:interveningGeneration,
            shownPdfHash:first.pdfHash, gen:recovered }).ship, true);
        assert.equal(recovered.nativeSource.files.get('paper.tex').text, edited);
        assert.equal(await fs.readFile(root, 'utf8'), original, 'recovery must preserve unsaved buffers');
        assert.deepEqual(await fs.readFile(first.pdfPath), originalPdf);
        const map = new NativeMap({ ...recovered, generation:recovered });
        assert.ok(map.available);
        assert.ok((await map.forwardAt(root, 3, 0)).length > 0);
        process.stdout.write(JSON.stringify({ result:'PASS', project,
            lane_sha256:createHash('sha256').update(await fs.readFile(path.join(__dirname, 'nativeCompileService.js'))).digest('hex'),
            display_generations_unique_across_sessions:true, recovered_pdf_ships:true,
            old_view_invalidated:true, terminated_session_rejected:true,
            new_session_republished:true, unsaved_source_preserved:true,
            old_pdf_immutable:true, recovered_forward_mapping:true }, null, 2) + '\n');
    } finally { await lane.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
