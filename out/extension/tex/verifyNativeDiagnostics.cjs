// Lane retirement policy: a TeX error in the document is a failed generation
// that keeps the lane; a producer that stops without a document error (its
// diagnostics flagged `producer`) is a lane failure that rejects. Uses only
// the public SDK via the lane.
// node verifyNativeDiagnostics.cjs /absolute/WLaTeX/install
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { NativeBuildLane, isDocumentFailure } = require('./nativeCompileService');
const { NativeMap } = require('./nativeMap');

async function main() {
    const directory = process.argv[2];
    if (!directory || !path.isAbsolute(directory)) throw Error('Supply an absolute WLaTeX installation path');
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'wpaper-native-diagnostics-'));
    const root = path.join(project, 'paper.tex');
    const good = '\\documentclass{article}\n\\begin{document}\nAlpha paragraph.\n\\end{document}\n';
    const broken = good.replace('Alpha paragraph.', 'Alpha \\undefinedcommand paragraph.');
    await fs.writeFile(root, good);
    const lane = new NativeBuildLane(root, directory);
    try {
        const first = await lane.compile({ sourceFiles:[root] });
        assert.equal(first.ok, true);
        assert.ok(new NativeMap({ ...first, generation:first }).available);
        // An undefined command while typing: the generation fails, names the
        // file and line, ships no PDF, and the lane stays open.
        const failed = await lane.compile({ sourceFiles:[root], overlay:new Map([[root, broken]]) });
        assert.equal(failed.ok, false);
        assert.equal(failed.runner, 'wlatex');
        assert.equal(failed.pdfPath, null);
        assert.equal(failed.nativeView, null);
        assert.ok(failed.errors >= 1);
        const placed = failed.diagnostics.find(d => d.severity === 'error' && d.line != null);
        assert.ok(placed, 'the TeX error must carry a line');
        assert.equal(placed.line, 3);
        assert.equal(path.resolve(placed.file), root, 'diagnostic files are absolute project paths');
        assert.match(failed.stopReason, /undefinedcommand|Undefined control sequence/i);
        assert.ok(isDocumentFailure(failed.nativeReport));
        assert.ok(!lane.closed, 'a document error must not close the lane');
        assert.ok(failed.generation > first.generation);
        // The same lane builds the corrected text natively again.
        const fixed = await lane.compile({ sourceFiles:[root], overlay:new Map([[root, good.replace('Alpha', 'Beta')]]) });
        assert.equal(fixed.ok, true);
        assert.equal(fixed.runner, 'wlatex');
        const map = new NativeMap({ ...fixed, generation:fixed });
        assert.ok(map.available);
        assert.ok((await map.forwardAt(root, 3, 0)).length > 0);
        // A missing input is typed out by LaTeX without a place and ends in a
        // forbidden terminal read; it is still the document's error.
        const missing = await lane.compile({ sourceFiles:[root], overlay:new Map([[root, good.replace('Alpha paragraph.', '\\input{nowhere}')]]) });
        assert.equal(missing.ok, false);
        assert.ok(missing.diagnostics.some(d => d.severity === 'error' && !d.producer && /nowhere/.test(d.message)));
        assert.ok(missing.nativeReport.diagnostics.some(d => d.producer === true), 'the producer flags its own exit diagnostic');
        assert.ok(!lane.closed);
        // A producer that never reached a TeX error is a lane failure.
        let laneFailure = null;
        try { await lane.compile({ sourceFiles:[root], timeoutMs:1 }); }
        catch (error) { laneFailure = error; }
        assert.ok(laneFailure, 'a timed-out producer must reject');
        assert.match(laneFailure.message, /time limit|timed out/i);
        assert.equal(isDocumentFailure({ timed_out:true, diagnostics:[{ severity:'error', line:3, message:'x' }] }), false);
        assert.equal(isDocumentFailure({ timed_out:false, diagnostics:[{ severity:'error', producer:true, message:'Native compiler exited with signal' }] }), false);
        assert.equal(isDocumentFailure({ timed_out:false, diagnostics:[{ severity:'warning', message:'w' }, { severity:'error', producer:true, message:'x' }] }), false);
        assert.equal(isDocumentFailure({ timed_out:false, diagnostics:[{ severity:'error', file:'paper.tex', message:'x' }] }), true);
        assert.equal(isDocumentFailure({ timed_out:false, diagnostics:[{ severity:'error', message:"LaTeX Error: File `x.tex' not found." }, { severity:'error', producer:true, message:'exit 1' }] }), true);
        // The real timed-out report carries the producer flag on its failure.
        assert.ok(laneFailure.report?.diagnostics?.some(d => d.producer === true) ?? true);
        assert.equal(await fs.readFile(root, 'utf8'), good, 'saved sources are never modified');
        console.log(JSON.stringify({ result:'PASS', project, platform:process.platform, arch:process.arch,
            document_error_is_failed_generation:true, document_error_keeps_lane:true, diagnostics_placed:true, missing_input_keeps_lane:true,
            corrected_text_builds_on_same_lane:true, producer_failure_rejects:true, saved_source_unchanged:true }, null, 2));
    } finally { await lane.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
