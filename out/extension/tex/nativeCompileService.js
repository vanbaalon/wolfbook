// Development/native sidecar lane for WPaper. The SDK owns freezing, process
// cancellation and map admission; this boundary supplies WPaper generations.
const fs = require('fs');
const path = require('path');

class NativeBuildLane {
    constructor(root, directory) {
        if (!directory || !path.isAbsolute(directory)) throw Error('Set wolfbook.tex.wlatexDirectory to the built WLaTeX checkout');
        this.root = root;
        this.directory = directory;
        this.projectDir = path.dirname(root);
        const sdk = require(path.join(directory, 'integrations/wpaper'));
        const suffix = process.platform === 'win32' ? '.exe' : '';
        const labBinary = path.join(directory, `target/debug/wlatex-lab${suffix}`);
        const nativeBinary = path.join(directory, `native-lab/target/release/wlatex-native-lab${suffix}`);
        this.source = new sdk.NativeSourceSession({ labBinary });
        this.compiler = new sdk.NativeCompiler({ labBinary, nativeBinary, cache: path.join(this.projectDir, '.wlatex/native') });
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
        const version = this.version;
        const texts = new Map();
        for (const file of new Set([this.root, ...(o.sourceFiles || [])])) {
            try { texts.set(this.relative(file),
                o.overlay?.has(file) ? o.overlay.get(file) : fs.readFileSync(file, 'utf8')); }
            catch (error) { if (file === this.root || error.code !== 'ENOENT') throw error; }
        }
        for (const [file, text] of o.overlay || []) texts.set(this.relative(file), text);
        this.edits = this.edits.catch(() => {});
        await this.edits;
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
            const existing = this.source.files.get(file);
            if (!existing) await this.source.open(file, text);
            else if (existing.text !== text) await this.source.edit(file, 0, existing.text.length, text);
        }
        let snapshot = await this.source.capture();
        const report = await this.compiler.compile({ main: this.root, root: this.projectDir,
            generation: ++this.buildNumber, signal: o.signal,
            overlays: Object.fromEntries(texts) });
        if (version !== this.version || o.signal?.aborted) throw Object.assign(Error('Native build superseded'), { name: 'AbortError' });
        if (!report.success) throw Error(report.diagnostics.map(d=>d.message).join('\n') || 'Native compilation failed');
        // Native provenance may discover project packages not in WPaper's TeX
        // graph. Open their frozen bytes only if they still match the project.
        for (const binding of report.build.source_bindings) if (!this.source.files.has(binding.file)) {
            const frozen = fs.readFileSync(path.join(report.source_directory, binding.file), 'utf8');
            const original = path.join(this.projectDir, binding.file);
            const current = o.overlay?.has(original) ? o.overlay.get(original) : fs.readFileSync(original, 'utf8');
            if (frozen !== current) throw Error('Native dependency changed during compilation');
            await this.source.open(binding.file, frozen);
        }
        const after = await this.source.capture();
        if (version !== this.version || Object.entries(snapshot.files).some(([file,s]) =>
            after.files[file]?.revision !== s.revision || after.files[file]?.digest !== s.digest))
            throw Object.assign(Error('Native build superseded'), { name: 'AbortError' });
        snapshot = after;
        await this.source.publish(report, snapshot);
        const nativeView = await this.source.readPages(Array.from({length: report.build.page_count}, (_,i)=>i+1));
        if (version !== this.version || o.signal?.aborted) throw Object.assign(Error('Native build superseded'), { name: 'AbortError' });
        const first = report.build.pages[0];
        const diagnostics = report.diagnostics.map(d=>({ ...d,
            file: d.file ? path.resolve(this.projectDir,d.file) : null }));
        return { ok:true, runner:'wlatex', engine:'wlatex', root:this.root, projectDir:this.projectDir,
            generation:this.buildNumber, outDir:report.artifact_directory, pdfPath:report.pdf,
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
        await this.edits;
        if (!this.source.published) return null;
        return this.source.readPages(Array.from({length:this.source.published.artifact.page_count},(_,i)=>i+1));
    }
    async close() { await Promise.all([this.compiler.close(), this.source.close()]); }
}
module.exports = { NativeBuildLane };
