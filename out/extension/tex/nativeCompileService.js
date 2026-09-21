// Native sidecar lane for WPaper. The SDK owns freezing, process
// cancellation and map admission; this boundary supplies WPaper generations.
const fs = require('fs');
const path = require('path');
const { resolveNativeRuntime } = require('./nativeRuntime');
const { nextGeneration } = require('./compileService');
const { NativeArtifactCache } = require('./nativeArtifactCache');
// The SDK rejects a build timeout outside 1 ms..1 h as a caller bug; a user
// setting must degrade to the default rather than retire the native lane.
const clampTimeout = ms => Number.isFinite(ms) && ms >= 1 ? Math.min(Math.floor(ms), 3600000) : 120000;

// A failed report is the document's failure when the log holds a TeX error
// the document raised: an undefined command (placed on its file and line by
// the producer's file-line-error style), a missing input (LaTeX types that
// one out with no place, then the forbidden terminal read ends the run), a
// runaway argument. The producer's own diagnostics carry `producer: true`
// (a timeout, an output overflow, an exit status); a report with only those,
// or a timed-out one, is the lane's failure.
function isDocumentFailure(report) {
    return !report.timed_out && Array.isArray(report.diagnostics) &&
        report.diagnostics.some(d => d?.severity === 'error' && !d.producer);
}

class NativeBuildLane {
    constructor(root, directory = '', runtimeOptions) {
        this.root = root;
        this.directory = directory || process.env.WLATEX_HOME || '';
        this.projectDir = path.dirname(root);
        this.runtime = resolveNativeRuntime(directory, runtimeOptions);
        if (!this.runtime) throw Error('WLaTeX is not installed or configured');
        const sdk = require(this.runtime.sdk);
        const { labBinary, nativeBinary } = this.runtime;
        this.artifactCache = new NativeArtifactCache(path.join(this.projectDir, '.wlatex/native'));
        try {
            this.compiler = new sdk.NativeCompiler({ labBinary, nativeBinary, cache:this.artifactCache.directory });
            this.source = new sdk.NativeSourceSession({ labBinary });
        } catch (error) { this.artifactCache.close(); throw error; }
        // SDK build IDs belong to this session; display IDs share the
        // conventional compiler's allocator and survive lane reconstruction.
        this.buildNumber = 0;
        this.version = 0;
        this.edits = Promise.resolve();
    }
    relative(file) {
        const name = path.relative(this.projectDir, file).split(path.sep).join('/');
        if (!name || name.startsWith('../') || path.isAbsolute(name)) throw Error('Native source is outside the project directory');
        return name;
    }
    invalidate() { this.version++; }
    noteChange(document, changes) {
        if (this.closed) return Promise.reject(Error('Native lane is closed'));
        this.version++;
        const file = this.relative(document.uri.fsPath);
        const text = document.getText();
        const captured = changes.map(c => ({ start: c.rangeOffset, end: c.rangeOffset + c.rangeLength, text: c.text }))
            .sort((a,b) => b.start-a.start);
        this.edits = this.edits.catch(() => {}).then(async () => {
            if (!this.source.files.has(file)) return this.source.open(file, text);
            for (const c of captured) await this.source.edit(file, c.start, c.end, c.text);
            // A missed external/editor event cannot silently desynchronize us.
            if (this.source.files.get(file).text !== text) throw Error('Native source edit history diverged');
        });
        return this.edits;
    }
    async compile(o) {
        const version=this.version;
        const requireCurrent=()=>{
            if (this.closed || version!==this.version || o.signal?.aborted)
                throw Object.assign(Error('Native build superseded'), { name:'AbortError' });
        };
        requireCurrent();
        // Wait for prior deletion before allowing shared-file publication.
        if (this.artifactCache) await this.artifactCache.begin();
        let generation;
        try { requireCurrent(); generation=await this._compile(o); }
        finally { await this.artifactCache?.end(); }
        // Keystrokes during the build do not supersede it (see _compile);
        // only the host's abort or a closed lane does.
        if (this.closed || o.signal?.aborted)
            throw Object.assign(Error('Native build superseded'), { name:'AbortError' });
        return generation;
    }
    async _compile(o) {
        const version = this.version;
        // Before the producer starts, a newer edit makes this build's inputs
        // pointless and the debounce will ask again. Once it is running, only
        // the host's abort signal or closing the lane stops it: the map binds
        // to the captured revisions and later keystrokes are translated, so a
        // build that finishes a few keystrokes behind is still worth showing.
        let started = false;
        const requireCurrent = () => {
            if (this.closed || o.signal?.aborted || (!started && version !== this.version))
                throw Object.assign(Error('Native build superseded'), { name:'AbortError' });
        };
        requireCurrent();
        const texts = new Map();
        for (const file of new Set([this.root, ...(o.sourceFiles || [])])) {
            try { texts.set(this.relative(file),
                o.overlay?.has(file) ? o.overlay.get(file) : fs.readFileSync(file, 'utf8')); }
            catch (error) { if (file === this.root || error.code !== 'ENOENT') throw error; }
        }
        for (const [file, text] of o.overlay || []) texts.set(this.relative(file), text);
        // Full synchronization recovers after a missed editor event.
        // Packages discovered by the native engine are not necessarily present
        // in the editor's TeX graph. Refresh them before freezing a new build.
        // The whole-buffer replacements run INSIDE the edit chain: a keystroke
        // arriving while they are queued must land after them, with offsets
        // relative to the text they install, not race them on the session.
        this.edits = this.edits.catch(() => {}).then(async () => {
            requireCurrent();
            for (const file of this.source.files.keys()) {
                if (texts.has(file)) continue;
                const absolute = path.join(this.projectDir, file);
                try { texts.set(file, fs.readFileSync(absolute, 'utf8')); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            for (const [file, text] of texts) {
                requireCurrent();
                const existing = this.source.files.get(file);
                if (!existing) await this.source.open(file, text);
                else if (existing.text !== text) await this.source.edit(file, 0, existing.text.length, text);
            }
        });
        await this.edits;
        requireCurrent();
        const snapshot = await this.source.capture();
        requireCurrent();
        started = true;
        const report = await this.compiler.compile({ main: this.root, root: this.projectDir,
            generation: ++this.buildNumber, signal: o.signal, timeoutMs:clampTimeout(o.timeoutMs),
            overlays: Object.fromEntries(texts) });
        if (this.closed) requireCurrent();
        const nativeArtifactLease = this.artifactCache?.lease(report);
        report.nativeArtifactLease = nativeArtifactLease;
        requireCurrent();
        if (!report.success) {
            // A document the engine could not typeset is the writer's problem
            // and the lane's normal business: it comes back as a failed
            // generation with diagnostics, the last PDF stays on screen and
            // the next keystroke builds natively again. Only a producer that
            // stopped without a TeX error (a crash, a timeout, an unreadable
            // installation) is the lane's problem, and that still throws so
            // the host can retire it and say so.
            if (!isDocumentFailure(report)) throw Error(report.diagnostics.map(d=>d.message).join('\n') || 'Native compilation failed');
            const diagnostics = report.diagnostics.map(d=>({ ...d,
                file: d.file ? path.resolve(this.projectDir,d.file) : null }));
            const errors = diagnostics.filter(d=>d.severity==='error');
            return { ok:false, runner:'wlatex', engine:'wlatex', root:this.root, projectDir:this.projectDir, nativeArtifactLease,
                generation:nextGeneration(), outDir:null, pdfPath:null, pdfHash:null, pdfBytes:null,
                sourceSnapshotHash:o.sourceSnapshotHash, live:!!o.overlay?.size,
                synctexPath:null, synctexHash:null, glyphMapPath:null, glyphMapHash:null,
                logPath:report.log, pageCount:null, pageSize:null,
                diagnostics, errors:errors.length, warnings:diagnostics.filter(d=>d.severity==='warning').length,
                passes:null, passesLimited:false, rerunWanted:false,
                stopped:true, stopReason:errors[0]?.message || 'Native compilation failed', cancelled:false, timedOut:false,
                ms:report.elapsed_ms, finishedAt:Date.now(), nativeView:null, nativeSource:null,
                nativeReport:report, nativeCompiledSources:null };
        }
        // Native provenance may discover project packages not in WPaper's TeX
        // graph. Open their frozen bytes only if they still match the project.
        for (const binding of report.build.source_bindings) if (!this.source.files.has(binding.file)) {
            requireCurrent();
            const frozen = fs.readFileSync(path.join(report.source_directory, binding.file), 'utf8');
            const original = path.join(this.projectDir, binding.file);
            const current = o.overlay?.has(original) ? o.overlay.get(original) : fs.readFileSync(original, 'utf8');
            if (frozen !== current) throw Error('Native dependency changed during compilation');
            await this.source.open(binding.file, frozen);
        }
        requireCurrent();
        await this.source.publish(report, snapshot);
        requireCurrent();
        // A keystroke during pagination invalidates the view; retry a few
        // times, then ship the PDF without a map and let the next pause's
        // refresh() materialize it. The PDF is never discarded for this.
        let nativeView = null;
        for (let attempt = 0; attempt < 3 && !nativeView; attempt++) {
            requireCurrent();
            try { nativeView = await this.source.readPages(this.pageWindow(o.nativePages, report.build.page_count)); }
            catch (error) { if (error?.name !== 'StaleBuild') throw error; await this.edits.catch(() => {}); }
        }
        requireCurrent();
        // A document that shipped no pages has no page geometry; the viewer
        // falls back to its default page size instead of the lane crashing.
        const first = report.build.pages[0] || null;
        const diagnostics = report.diagnostics.map(d=>({ ...d,
            file: d.file ? path.resolve(this.projectDir,d.file) : null }));
        return { ok:true, runner:'wlatex', engine:'wlatex', root:this.root, projectDir:this.projectDir, nativeArtifactLease,
            generation:nextGeneration(), outDir:report.artifact_directory, pdfPath:report.pdf,
            pdfHash:report.build.pdf_hash, pdfBytes:fs.statSync(report.pdf).size,
            sourceSnapshotHash:o.sourceSnapshotHash, live:!!o.overlay?.size,
            synctexPath:null, synctexHash:null, glyphMapPath:null, glyphMapHash:null,
            logPath:report.log, pageCount:report.build.page_count,
            pageSize:first ? {widthBp:first.width_pt,heightBp:first.height_pt} : null,
            diagnostics, errors:diagnostics.filter(d=>d.severity==='error').length,
            warnings:diagnostics.filter(d=>d.severity==='warning').length,
            passes:report.build.passes.length, passesLimited:false, rerunWanted:true,
            stopped:false, stopReason:null, cancelled:false, timedOut:false,
            ms:report.elapsed_ms, finishedAt:Date.now(), nativeView, nativeSource:this.source,
            nativeReport:report,
            // Files the engine discovered during the build were opened after
            // the capture with their frozen bytes; read those from the session.
            nativeCompiledSources: new Map(report.build.source_bindings.map(binding =>
                [path.join(this.projectDir, binding.file), (snapshot.files[binding.file] ?? this.source.files.get(binding.file)).text])) };
    }
    // The pages a view materializes: the requested window (the pages the
    // viewer has rendered, plus a neighbour each side) clipped to the
    // document, or the first eight pages when nothing is known yet. Reading
    // every page of a long document on each keystroke is what made typing on
    // the 200-page book cost hundreds of worker round trips per character.
    pageWindow(pages, count) {
        const wanted = new Set((pages || []).filter(p => Number.isInteger(p) && p >= 1 && p <= count));
        if (!wanted.size) for (let p = 1; p <= Math.min(count, 8); p++) wanted.add(p);
        return [...wanted].sort((a, b) => a - b);
    }
    async refresh(pages) {
        if (this.closed) return null;
        await this.edits;
        if (this.closed || !this.source.published) return null;
        return this.source.readPages(this.pageWindow(pages, this.source.published.artifact.page_count));
    }
    close() {
        if (this._closing) return this._closing;
        this.closed = true;
        this.version++;
        // Both resources must finish shutting down even if one rejects. This
        // also makes repeated disposal/retirement share one completion handle.
        this._closing = Promise.allSettled([
            Promise.resolve().then(() => this.compiler.close()),
            Promise.resolve().then(() => this.source.close()),
        ]).then(async results => {
            const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
            if (failures.length) throw new AggregateError(failures, 'Native lane shutdown failed');
            await this.artifactCache?.close();
        });
        return this._closing;
    }
}
module.exports = { NativeBuildLane, isDocumentFailure };
