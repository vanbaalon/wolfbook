// Real native project-file lifecycle check. Uses only the public SDK via the lane.
// node verifyNativeFiles.cjs /absolute/WLaTeX/install
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { NativeBuildLane } = require('./nativeCompileService');
const { NativeMap } = require('./nativeMap');

async function main() {
    const directory = process.argv[2];
    if (!directory || !path.isAbsolute(directory)) throw Error('Supply an absolute WLaTeX installation path');
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'wpaper-native-files-'));
    const root = path.join(project, 'paper.tex');
    const chapter = path.join(project, 'chapter.tex'), renamed = path.join(project, 'renamed.tex');
    const original = '\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n';
    const changed = original.replace('{chapter}', '{renamed}');
    await fs.writeFile(root, original);
    await fs.writeFile(chapter, 'Alpha chapter.\n');
    const lane = new NativeBuildLane(root, directory);
    const bindings = generation => generation.nativeReport.build.source_bindings.map(b => b.file);
    try {
        const first = await lane.compile({ sourceFiles:[root,chapter] });
        assert.ok(bindings(first).includes('chapter.tex'));
        const firstPdf = await fs.readFile(first.pdfPath);
        await fs.rename(chapter, renamed);
        // Deliberately retain the stale include graph while the unsaved root
        // references the new filename. Native discovery must supply the new file.
        const second = await lane.compile({ sourceFiles:[root,chapter], overlay:new Map([[root,changed]]) });
        assert.ok(bindings(second).includes('renamed.tex'));
        assert.ok(!bindings(second).includes('chapter.tex'));
        await assert.rejects(fs.access(path.join(second.nativeReport.source_directory,'chapter.tex')), { code:'ENOENT' });
        assert.ok(new NativeMap({ ...second, generation:second }).available);
        await fs.unlink(renamed);
        // A source session still knows the old bytes, but they must not become
        // compiler overlays when the file has actually disappeared.
        await assert.rejects(lane.compile({ sourceFiles:[root,chapter], overlay:new Map([[root,changed]]), timeoutMs:30000 }),
            error => { assert.doesNotMatch(error.message, /timed out/i); return true; });
        const unsaved = 'Unsaved replacement chapter.\n';
        let recovered, missingOverlayError = null;
        try {
            recovered = await lane.compile({ sourceFiles:[root,chapter],
                overlay:new Map([[root,changed],[renamed,unsaved]]) });
        } catch (error) {
            // Keep this as a failing acceptance gate, while still checking
            // recovery after the resource is recreated on disk.
            if (!/overlay is not a project file: renamed\.tex/.test(error.message)) throw error;
            missingOverlayError = error.message.trim();
            await fs.writeFile(renamed, 'Saved replacement chapter.\n');
            recovered = await lane.compile({ sourceFiles:[root,chapter],
                overlay:new Map([[root,changed],[renamed,unsaved]]) });
        }
        assert.equal(recovered.nativeCompiledSources.get(renamed), unsaved);
        const map = new NativeMap({ ...recovered, generation:recovered });
        assert.ok((await map.forwardAt(renamed,1,0))?.length);
        assert.equal(await fs.readFile(root,'utf8'), original);
        if (missingOverlayError) assert.equal(await fs.readFile(renamed,'utf8'), 'Saved replacement chapter.\n');
        else await assert.rejects(fs.access(renamed), { code:'ENOENT' });
        await assert.rejects(fs.access(chapter), { code:'ENOENT' });
        assert.deepEqual(await fs.readFile(first.pdfPath), firstPdf);
        assert.ok(recovered.generation > second.generation && second.generation > first.generation);
        console.log(JSON.stringify({ result:missingOverlayError ? 'INCOMPLETE' : 'PASS', missingOverlayError, project, platform:process.platform, arch:process.arch,
            renamed_dependency_discovered:true, stale_graph_did_not_restore_deleted_file:true,
            missing_dependency_rejected:true, unsaved_missing_file_overlay_supported:!missingOverlayError,
            recovered_dependency_mapping:true, saved_source_unchanged:true, old_pdf_immutable:true }, null, 2));
        if (missingOverlayError) process.exitCode = 1;
    } finally { await lane.close(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
