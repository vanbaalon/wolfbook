// Native sidecar lane for WPaper. The SDK owns freezing, process
// cancellation and map admission; this boundary supplies WPaper generations.
const fs = require('fs');
const path = require('path');
const { resolveNativeRuntime } = require('./nativeRuntime');
const { nextGeneration } = require('./compileService');
const { NativeArtifactCache } = require('./nativeArtifactCache');

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
        // No collection while a producer or publication may use shared files.
        if (this.closed) throw Object.assign(Error('Native build superseded'), { name:'AbortError' });
        this.artifactCache?.begin();
        try { return await this._compile(o); }
        finally { this.artifactCache?.end(); }
    }
    async _compile(o) {
        const version = this.version;
        const requireCurrent = () => {
            if (this.closed || version !== this.version || o.signal?.aborted)
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
        this.edits = this.edits.catch(() => {});
        await this.edits;
        requireCurrent();
        // Full synchronization recovers after a missed editor event.
        // Packages discovered by the native engine are not necessarily present
        // in the editor's TeX graph. Refresh them before freezing a new build.
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
        requireCurrent();
        let snapshot = await this.source.capture();
        requireCurrent();
        const report = await this.compiler.compile({ main: this.root, root: this.projectDir,
            generation: ++this.buildNumber, signal: o.signal, timeoutMs:o.timeoutMs,
            overlays: Object.fromEntries(texts) });
        const nativeArtifactLease = this.artifactCache?.lease(report);
        report.nativeArtifactLease = nativeArtifactLease;
        requireCurrent();
        if (!report.success) throw Error(report.diagnostics.map(d=>d.message).join('\n') || 'Native compilation failed');
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
        const after = await this.source.capture();
        if (version !== this.version || Object.entries(snapshot.files).some(([file,s]) =>
            after.files[file]?.revision !== s.revision || after.files[file]?.digest !== s.digest))
            throw Object.assign(Error('Native build superseded'), { name: 'AbortError' });
        snapshot = after;
        requireCurrent();
        await this.source.publish(report, snapshot);
        requireCurrent();
        const nativeView = await this.source.readPages(Array.from({length: report.build.page_count}, (_,i)=>i+1));
        requireCurrent();
        const first = report.build.pages[0];
        const diagnostics = report.diagnostics.map(d=>({ ...d,
            file: d.file ? path.resolve(this.projectDir,d.file) : null }));
        return { ok:true, runner:'wlatex', engine:'wlatex', root:this.root, projectDir:this.projectDir, nativeArtifactLease,
            generation:nextGeneration(), outDir:report.artifact_directory, pdfPath:report.pdf,
            pdfHash:report.build.pdf_hash, pdfBytes:fs.statSync(report.pdf).size,
            sourceSnapshotHash:o.sourceSnapshotHash, live:!!o.overlay?.size,
            synctexPath:null, synctexHash:null, glyphMapPath:null, glyphMapHash:null,
            logPath:report.log, pageCount:report.build.page_count,
            pageSize:{widthBp:first.width_pt,heightBp:first.height_pt},
            diagnostics, errors:diagnostics.filter(d=>d.severity==='error').length,
            warnings:diagnostics.filter(d=>d.severity==='warning').length,
            passes:report.build.passes.length, passesLimited:false, rerunWanted:true,
            stopped:false, stopReason:null, cancelled:false, timedOut:false,
            ms:report.elapsed_ms, finishedAt:Date.now(), nativeView, nativeSource:this.source,
            nativeReport:report,
            nativeCompiledSources: new Map(report.build.source_bindings.map(binding =>
                [path.join(this.projectDir, binding.file), snapshot.files[binding.file].text])) };
    }
    async refresh() {
        if (this.closed) return null;
        await this.edits;
        if (this.closed || !this.source.published) return null;
        return this.source.readPages(Array.from({length:this.source.published.artifact.page_count},(_,i)=>i+1));
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
        ]).then(results => {
            const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
            if (failures.length) throw new AggregateError(failures, 'Native lane shutdown failed');
            this.artifactCache?.close();
        });
        return this._closing;
    }
}
module.exports = { NativeBuildLane };
