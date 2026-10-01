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

// The auxiliary files the interactive lane feeds back to the engine, so that
// \ref, \cite, the table of contents and the list of figures read the numbers
// the settled cold build wrote. The engine runs no auxiliary passes of its
// own: these are ordinary inputs to it.
// The settled build's tool outputs too (bibliography, index, glossaries,
// nomenclature), or the live pages lose those sections.
const AUXILIARY_FILE = /\.(aux|toc|lof|lot|out|bbl|ind|gls|acr|nls|sls)$/i;
// The engine refuses an overlay name that is not a relative, canonical project
// path. Checked here so a stray auxiliary name can never fail a whole build.
const SAFE_OVERLAY = name => typeof name === 'string' && name.length > 0 && !/[\\:\0]/.test(name) &&
    !name.split('/').some(part => !part || part === '.' || part === '..');

// A preview page as the viewer wants it. `geometry` is already in big points
// (the SDK converts the stream's scaled points), and it is null whenever the
// stream carried no media size — most pages, in practice — so the viewer falls
// back to the geometry of the PDF page the overlay covers.
function interactivePage(generation, event) {
    const geometry = event.geometry;
    return { generation, page:event.page, changed:event.changed !== false,
        identity:event.identity?.page_hash ?? null,
        txdl:event.payload?.txdl ?? null, fonts:event.payload?.fonts ?? null,
        error:event.payload?.error ?? null,
        // The engine's own clock: ms from the build's start to this page.
        sinceBuildMs:Number.isFinite(event.since_build_ms) ? event.since_build_ms : null,
        pageSize:geometry && geometry.width_pt > 0 && geometry.height_pt > 0
            ? { widthBp:geometry.width_pt, heightBp:geometry.height_pt } : null };
}

// A paragraph fragment as the viewer wants it: the typed paragraph's display
// list and where it goes on the page shown (`placement`, in the page's DVI
// scaled points: dx/dy added to the fragment's coordinates, the column clip,
// the old paragraph to clear, the band below it and how far that band moves).
// A preview only; the page that follows replaces it.
function interactiveFragment(generation, event) {
    return { generation, page:event.page, index:event.fragment_index ?? 0,
        placement:event.placement ?? null, source:event.source ?? null,
        txdl:event.payload?.txdl ?? null, fonts:event.payload?.fonts ?? null,
        error:event.payload?.error ?? null,
        map:event.map ?? null, mapFiles:event.map_files ?? null,
        // The page shown with the paragraph in it has its own live map
        // (`page_map_ready` with this identity follows).
        mapIdentity:event.page_map_identity ?? null,
        sinceBuildMs:Number.isFinite(event.since_build_ms) ? event.since_build_ms : null };
}

// A preview that did not run. Shaped like a failed generation so a caller can
// log it and move on; it is never a reason to retire the native lane, because
// the cold build that follows is untouched by it.
function interactiveFailure(generation, message, fatal) {
    return { ok:false, incremental:true, generation, pages:[], pageCount:null, report:null, fatal:!!fatal,
        diagnostics:[{ severity:'error', file:null, line:null, producer:false,
            message:message || 'the interactive build failed' }] };
}

// BUILD ARTIFACTS DO NOT LIVE IN THE PAPER'S FOLDER. A project folder is often
// synced (Dropbox, iCloud) or committed, and every build writes tens of
// megabytes of PDF, XDV and maps. They go to the user's cache directory, one
// folder per project path (`WLATEX_ARTIFACT_CACHE` overrides the base).
function artifactParent(projectDir) {
    const key = require('crypto').createHash('sha256').update(path.resolve(projectDir)).digest('hex').slice(0, 16);
    const home = require('os').homedir();
    const base = process.env.WLATEX_ARTIFACT_CACHE
        || (process.platform === 'darwin' ? path.join(home, 'Library/Caches/wlatex/projects')
            : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || require('os').tmpdir(), 'wlatex/projects')
                : path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'wlatex/projects'));
    return path.join(base, key);
}

// THE LAST SETTLED BUILD OUTLIVES THE SESSION. Its auxiliary files (and what
// its BibTeX/biber/index steps last read) are kept beside the session
// folders, one copy per main file, so the first build after reopening the
// paper starts from them: it usually settles in one pass instead of three,
// and runs no tool whose inputs did not change. The producer checks every
// file against the hashes recorded here and ignores a seed that fails.
function settledSeedDirectory(projectDir, root) {
    const key = require('crypto').createHash('sha256').update(path.relative(projectDir, root)).digest('hex').slice(0, 16);
    return path.join(artifactParent(projectDir), 'settled', key);
}

/**
 * What an .aux says references print as, by line: each label's number and
 * each citation's label (`key -> { value, line }`). Page numbers are left
 * out — a \\pageref catches up at the settle, not with a whole live rebuild
 * per paragraph that moved.
 */
function referenceEntries(aux) {
    const out = new Map();
    for (const line of String(aux || '').split('\n')) {
        const label = /^\\newlabel\{([^}]*)\}\{\{([^}]*)\}/.exec(line);
        const cite = !label && /^\\bibcite\{([^}]*)\}\{([^}]*)\}/.exec(line);
        const m = label || cite;
        if (!m) continue;
        const key = `${label ? 'L' : 'C'}${m[1]}`;
        // LaTeX keeps the last of a label defined twice.
        out.set(key, { value: m[2], line, count: (out.get(key)?.count || 0) + 1 });
    }
    return out;
}

/**
 * The .aux a live build read, with the references a later live build wrote
 * differently (or new ones). A build that stopped where its pages met the
 * previous build's (`complete` false) wrote only its own pages' entries: the
 * rest stand as read, and a label defined twice cannot be judged from part
 * of the document (the last definition wins). Null when nothing differs.
 */
function mergeReferences(read, written, complete = true) {
    const was = referenceEntries(read), now = referenceEntries(written);
    const changed = [...now].filter(([key, e]) => {
        const old = was.get(key);
        if (!old) return true;
        if (!complete && (old.count > 1 || e.count > 1)) return false;
        return old.value !== e.value;
    });
    if (!changed.length) return null;
    const lines = String(read || '').split('\n');
    const at = new Map(lines.map((line, i) => [line, i]));
    const extra = [];
    for (const [key, e] of changed) {
        const old = was.get(key);
        if (old && at.has(old.line)) lines[at.get(old.line)] = e.line; else extra.push(e.line);
    }
    // New entries before the closing lines LaTeX writes last.
    const end = lines.findIndex(l => /^\\gdef\s*\\@abspage@last|^\\@abspage@last/.test(l));
    if (end >= 0) lines.splice(end, 0, ...extra); else lines.push(...extra);
    return lines.join('\n');
}

function auxiliaryDigest(texts) {
    const hash = require('crypto').createHash('sha256');
    for (const name of Object.keys(texts).sort()) hash.update(name).update('\0').update(texts[name]).update('\0');
    return hash.digest('hex');
}

/** Copy a settled build's seed (a trimmed build.json and its auxiliary files) into `directory`. */
function keepSettledSeed(directory, report) {
    const build = report.build;
    const staging = `${directory}.tmp-${process.pid}-${Date.now()}`;
    try {
        for (const name of Object.keys(build.auxiliary_files)) {
            if (!SAFE_OVERLAY(name)) throw Error(`unsafe auxiliary name ${name}`);
            fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive:true });
            fs.copyFileSync(path.join(report.artifact_directory, name), path.join(staging, name));
        }
        fs.mkdirSync(staging, { recursive:true });
        fs.writeFileSync(path.join(staging, 'build.json'), JSON.stringify({ main_file:build.main_file, settled:true,
            auxiliary_files:build.auxiliary_files, tool_inputs:build.tool_inputs || {} }));
        fs.rmSync(directory, { recursive:true, force:true });
        fs.renameSync(staging, directory);
    } finally { fs.rmSync(staging, { recursive:true, force:true }); }
}

/**
 * Producer environment for cold builds, read at every build so the setting
 * applies from the next one. `wolfbook.tex.synctex` writes SyncTeX for
 * external viewers (Export PDF puts it beside the exported file).
 */
function coldBuildEnv() {
    let synctex = false, shellEscape = false;
    try {
        const vscode = require('vscode');
        const config = vscode.workspace.getConfiguration('wolfbook.tex');
        synctex = !!config.get('synctex', false);
        // SHELL ESCAPE RUNS THE PAPER'S COMMANDS WITH THE USER'S RIGHTS, so
        // only the user's own setting turns it on — never a workspace's
        // settings file, which travels with a downloaded project — and only
        // in a trusted workspace. The live preview never runs them.
        shellEscape = config.inspect('shellEscape')?.globalValue === true && vscode.workspace.isTrusted !== false;
    } catch (_) { /* outside VS Code */ }
    return { ...(synctex ? { WLATEX_SYNCTEX: '1' } : {}), ...(shellEscape ? { WLATEX_SHELL_ESCAPE: '1' } : {}) };
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
        // WLATEX IS LICENSED; WPAPER IS NOT. Without a WLaTeX licence (after
        // its trial) the engine refuses every build, so the lane is not
        // made at all and WPaper compiles with its own compiler, saying why
        // once. An SDK or engine from before licences answers "not required".
        if (typeof sdk.licenseStatus === 'function') {
            this.license = sdk.licenseStatus(nativeBinary);
            if (this.license.required && !this.license.allowed) {
                const error = Error(`${this.license.message}. WPaper: Enter WLaTeX Licence… installs one`);
                error.code = 'WLATEX_LICENSE';
                throw error;
            }
        }
        this.artifactCache = new NativeArtifactCache(artifactParent(this.projectDir));
        try {
            this.compiler = new sdk.NativeCompiler({ labBinary, nativeBinary, cache:this.artifactCache.directory, env:coldBuildEnv });
            this.source = new sdk.NativeSourceSession({ labBinary });
        } catch (error) { this.artifactCache.close(); throw error; }
        // THE INTERACTIVE LANE IS OPTIONAL AND NEVER LOAD-BEARING.
        //
        // It is the SDK's long-lived incremental engine, wrapped in a build
        // session that shares this lane's cold compiler and source session.
        // A runtime without it — an older WLaTeX, an SDK whose build session
        // does not take `interactive`, a main file the engine will not accept
        // — leaves `this.session` null, every interactive entry point below
        // answers null, and the lane behaves exactly as it did before this
        // existed. The engine process itself starts lazily, on the first
        // interactive build; constructing the session costs nothing.
        this.session = null;
        this.interactiveUnavailable = null;
        try {
            if (typeof sdk.NativeBuildSession === 'function') {
                const session = new sdk.NativeBuildSession({ compiler:this.compiler, source:this.source,
                    labBinary, nativeBinary, cache:this.artifactCache.directory,
                    interactive:{ main:this.root, root:this.projectDir } });
                if (session.interactive) this.session = session;
                else this.interactiveUnavailable = 'this WLaTeX has no incremental engine';
            } else this.interactiveUnavailable = 'this WLaTeX SDK has no build session';
        } catch (error) { this.session = null; this.interactiveUnavailable = error.message; }
        // The last successful cold report, for the auxiliary texts the
        // interactive lane replays. Null until a cold build has succeeded.
        this.coldReport = null;
        // The settled build kept from an earlier session (settledSeedDirectory).
        this.settledSeed = settledSeedDirectory(this.projectDir, root);
        this._keptSeed = null;
        this.interactiveWarm = false;
        this._warming = null;
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
    isInside(file) {
        const name = path.relative(this.projectDir, file);
        return !!name && !name.startsWith('..') && !path.isAbsolute(name);
    }
    invalidate() { this.version++; }
    noteChange(document, changes) {
        if (this.closed) return Promise.reject(Error('Native lane is closed'));
        this.version++;
        // A file outside the project is not part of the native snapshot (the
        // engine cannot read it): its edits have nothing to update.
        if (!this.isInside(document.uri.fsPath)) return Promise.resolve();
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
            // Outside the project: the engine cannot read it; TeX reports it missing.
            if (!this.isInside(file)) continue;
            try { texts.set(this.relative(file),
                o.overlay?.has(file) ? o.overlay.get(file) : fs.readFileSync(file, 'utf8')); }
            catch (error) { if (file === this.root || error.code !== 'ENOENT') throw error; }
        }
        for (const [file, text] of o.overlay || []) if (this.isInside(file)) texts.set(this.relative(file), text);
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
        // The last settled build's auxiliary files seed the first pass: an edit
        // that moved no reference settles in one pass instead of two. Its
        // artifacts are still leased by `coldReport`; the producer checks them.
        // Before this session has one, the settled build kept from the last.
        const seed = this.coldReport?.build?.settled === true ? this.coldReport.artifact_directory || null
            : this._keptSeedFiles() ? this.settledSeed : null;
        const report = await this.compiler.compile({ main: this.root, root: this.projectDir,
            generation: ++this.buildNumber, signal: o.signal, timeoutMs:clampTimeout(o.timeoutMs),
            overlays: Object.fromEntries(texts), seed });
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
        // The interactive lane replays this build's auxiliary files, so the
        // preview numbers what the settled build numbered. Recorded only for a
        // build that succeeded, and only once its artifacts exist.
        this.coldReport = report;
        // The settle wrote its own .aux: live builds read that from now on.
        this._liveAuxiliaryAdopted = null;
        this._pendingLiveAuxiliary = null;
        // Kept for the next session, when it changed (see keepSettledSeed).
        if (report.build.settled === true) {
            const kept = JSON.stringify([report.build.auxiliary_files, report.build.tool_inputs || null]);
            if (kept !== this._keptSeed) {
                try { keepSettledSeed(this.settledSeed, report); this._keptSeed = kept; }
                catch (_) { /* the next session starts unseeded, as before */ }
            }
        }
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
            // Not `synctexPath`: that one feeds the latexmk SyncTeX map. This is
            // only carried to Export PDF, for external viewers.
            exportSynctexPath:report.build.synctex ? path.join(report.artifact_directory, report.build.synctex) : null,
            logPath:report.log, pageCount:report.build.page_count,
            pageSize:first ? {widthBp:first.width_pt,heightBp:first.height_pt} : null,
            diagnostics, errors:diagnostics.filter(d=>d.severity==='error').length,
            warnings:diagnostics.filter(d=>d.severity==='warning').length,
            passes:report.build.passes.length, passesLimited:false,
            // A settled native build (auxiliary files stable, every index,
            // glossary and biber step run) needs no latexmk pass behind it;
            // an unsettled one still gets the authoritative rebuild.
            rerunWanted:report.build.settled !== true,
            stopped:false, stopReason:null, cancelled:false, timedOut:false,
            ms:report.elapsed_ms, finishedAt:Date.now(), nativeView, nativeSource:this.source,
            nativeReport:report,
            // Files the engine discovered during the build were opened after
            // the capture with their frozen bytes; read those from the session.
            nativeCompiledSources: new Map(report.build.source_bindings.map(binding =>
                [path.join(this.projectDir, binding.file), (snapshot.files[binding.file] ?? this.source.files.get(binding.file)).text])) };
    }
    /** Is an incremental engine available for live previews on this lane? */
    get interactive() { return !!(this.session && this.session.interactive && !this.closed); }

    /**
     * Start the engine process, off the keystroke path.
     *
     * Starting it means locating its XeLaTeX format, and building one when the
     * user's format cache has none — tens of seconds, once per engine binary.
     * A preview is worth waiting for; a typing pause is not, so the first
     * interactive build asks for this and then declines to preview, and every
     * pause after it previews normally. Resolves true when the engine is up.
     */
    warmInteractive() {
        if (!this.interactive) return Promise.resolve(false);
        if (this._warming) return this._warming;
        this._warming = Promise.resolve()
            .then(() => this.session.interactive.start())
            .then(() => { this.interactiveWarm = !this.closed; return this.interactiveWarm; })
            .catch(error => {
                // A preview that cannot start is not a lane that cannot build.
                this.interactiveUnavailable = error.message;
                this._warming = null;
                return false;
            });
        return this._warming;
    }

    /**
     * Glyph outlines for the webview's TXDL renderer, by font definition
     * digest. Null when there is no engine, so the caller can say so instead
     * of drawing a page of blanks.
     */
    async outlines(font, glyphs) {
        if (!this.interactive) return null;
        return this.session.outlines(font, glyphs);
    }

    /**
     * An EPS/PS figure of the project as a one-page PDF Buffer — the
     * engine's Ghostscript conversion, what the PDF shows. Null without an
     * engine (or one too old to convert).
     */
    async figure(relativeFile) {
        if (!this.interactive || typeof this.session.figure !== 'function') return null;
        return this.session.figure(relativeFile);
    }

    /**
     * ONE INCREMENTAL BUILD FOR THE LIVE PREVIEW.
     *
     * The engine resumes from the latest page checkpoint the edit did not
     * reach and typesets forward until its state provably matches the previous
     * document, so a word changed on page 2 of a long paper costs the pages
     * that actually moved rather than the whole document. Each recomputed page
     * arrives as a TXDL display list through `o.onPage` and is drawn over the
     * PDF canvas in the webview.
     *
     * IT IS A PREVIEW, NOT A BUILD. It never settles, produces no PDF, no
     * source map and no provenance; the cold build that follows it still does
     * all of that and remains what the reader finally sees. Therefore this
     * NEVER THROWS for a failure of its own: a failed interactive build comes
     * back as `{ ok: false }` and the caller simply carries on to the cold
     * build. Only a superseded or aborted build answers null.
     */
    async interactiveBuild(o = {}) {
        if (!this.interactive) return null;
        // The engine starts lazily, and starting it is the one slow thing here
        // (see warmInteractive). Ask for it and let this pause go by; the
        // cold build below is exactly what it always was.
        if (!this.interactiveWarm) {
            const warm = this.warmInteractive();
            if (o.wait !== true) return null;
            if (!await warm) return interactiveFailure(null, this.interactiveUnavailable, false);
            if (!this.interactive) return null;
        }
        let handle = null, generation = null, fedAuxiliary = {};
        const timing = process.env.WPAPER_BUILD_TIMING ? { t0: performance.now() } : null;
        try {
            const texts = this._interactiveOverlays(o);
            if (timing) timing.overlays = performance.now() - timing.t0;
            const viewport = [...new Set((o.nativePages || [])
                .filter(page => Number.isInteger(page) && page >= 1))].sort((a, b) => a - b);
            generation = ++this.buildNumber;
            const auxiliary = this._auxiliaryTexts();
            this._liveAuxiliary = auxiliaryDigest(auxiliary);
            fedAuxiliary = auxiliary;
            if (timing) timing.auxiliary = performance.now() - timing.t0;
            handle = this.session.build({ main:this.root, root:this.projectDir,
                overlays:Object.fromEntries(texts), auxiliary,
                generation, lane:'interactive', viewport });
        } catch (error) {
            if (error?.name === 'AbortError') return null;
            return interactiveFailure(generation, error.message, error.fatal === true);
        }
        const abort = () => { try { handle.cancel(); } catch (_) { /* already finished */ } };
        o.signal?.addEventListener('abort', abort, { once:true });
        let built = null, failed = null, superseded = false;
        try {
            if (timing) timing.submitted = performance.now() - timing.t0;
            for await (const event of handle.events()) {
                if (timing && timing[event.event] == null) timing[event.event] = performance.now() - timing.t0;
                if (event.event === 'page_finalized') {
                    // A KEYSTROKE DOES NOT INVALIDATE A PAGE. The reader is
                    // still typing — that is why this ran — and a page from a
                    // build two characters old is precisely what the preview
                    // is for. The session stops emitting pages of a build a
                    // newer one has superseded, which is the real staleness
                    // test; only closing the lane or the host's own abort ends
                    // the drawing here.
                    if (this.closed || o.signal?.aborted) continue;
                    if (typeof o.onPage !== 'function') continue;
                    try { o.onPage({ ...interactivePage(generation, event), ...(timing ? { timing: { ...timing, page: performance.now() - timing.t0 } } : {}) }); }
                    catch (_) { /* a viewer that cannot draw never fails a build */ }
                } else if (event.event === 'paragraph_fragment') {
                    // The typed paragraph ahead of its page: drawn at once over
                    // the page shown. Same staleness rule as pages.
                    if (this.closed || o.signal?.aborted || typeof o.onFragment !== 'function') continue;
                    try { o.onFragment({ ...interactiveFragment(generation, event), ...(timing ? { timing: { ...timing, fragment: performance.now() - timing.t0 } } : {}) }); }
                    catch (_) { /* a viewer that cannot draw never fails a build */ }
                } else if (event.event === 'page_map_ready' || event.event === 'page_map_failed') {
                    // The page's own source map reached the worker (or could
                    // not be bound): clicks on that live page may now be
                    // answered from it. It never gates the pixels.
                    if (this.closed || typeof o.onPageMap !== 'function') continue;
                    try { o.onPageMap({ generation, page:event.page, ready:event.event === 'page_map_ready',
                        identity:event.identity ?? null, error:event.error ?? null }); }
                    catch (_) { /* a viewer that cannot map never fails a build */ }
                } else if (event.event === 'built') built = event;
                else if (event.event === 'failed') failed = event;
                else if (event.event === 'superseded' || event.event === 'cancelled') superseded = true;
            }
            await handle.report;
        } catch (error) {
            if (error?.name === 'AbortError') return null;
            if (!failed) return interactiveFailure(generation, error.message, error.fatal === true);
        } finally { o.signal?.removeEventListener('abort', abort); }
        if (superseded || o.signal?.aborted) return null;
        if (failed) return interactiveFailure(generation, failed.error, failed.fatal === true);
        if (!built) return interactiveFailure(generation, 'the interactive build produced no report', false);
        // NEW REFERENCES. A \\label typed now is in the .aux this build wrote,
        // not in the one it read: one more build reading it prints the number
        // (the host runs it at a pause, see renderUi._scheduleReferencePass).
        const merged = {};
        for (const [name, text] of Object.entries(built.auxiliary_written || {})) {
            if (!SAFE_OVERLAY(name) || typeof text !== 'string') continue;
            const next = mergeReferences(fedAuxiliary[name], text, built.report?.stop === 'EndOfDocument');
            if (next !== null) merged[name] = next;
        }
        const referencesChanged = Object.keys(merged).length > 0;
        this._pendingLiveAuxiliary = referencesChanged ? merged : null;
        return { ok:true, incremental:true, generation, referencesChanged, pages:built.pages || [],
            pageCount:built.page_count ?? (built.pages || []).length,
            report:built.report || null, diagnostics:built.diagnostics || [],
            elapsedMs:built.elapsed_ms ?? null };
    }

    /**
     * The overlay texts one interactive build compiles: the root, the editor's
     * include graph, every unsaved buffer and every file the source session
     * already knows (a package the engine discovered on an earlier build).
     * The same map `_compile` builds, minus the edit-chain synchronization —
     * that belongs to the cold path, which owns the source map, and a preview
     * must not perturb it.
     */
    _interactiveOverlays(o) {
        // ONLY WHAT DIFFERS FROM DISK. The engine reads the project from disk
        // itself and rescans it before every build, so an unedited file needs
        // no copy: sending every file cost a read of each and about half a
        // megabyte of JSON per keystroke on a long book (3.7 ms of the first
        // changed page). The exceptions are files the engine will not read
        // from disk — symlinks and hidden paths — whose text comes from here.
        const texts = new Map();
        for (const [file, text] of o.overlay || []) if (this.isInside(file)) texts.set(this.relative(file), text);
        const known = [...this.source.files.keys()].map(file => path.join(this.projectDir, file));
        for (const file of new Set([this.root, ...(o.sourceFiles || []), ...known])) {
            // Outside the project: the engine cannot read it; TeX reports it missing.
            if (!this.isInside(file)) continue;
            const name = this.relative(file);
            if (texts.has(name)) continue;
            try {
                const hidden = name.split(/[\\/]/).some(part => part.startsWith('.'));
                if (hidden || fs.lstatSync(file).isSymbolicLink()) texts.set(name, fs.readFileSync(file, 'utf8'));
                else if (file === this.root) fs.accessSync(file);
            } catch (error) { if (file === this.root || error.code !== 'ENOENT') throw error; }
        }
        return texts;
    }

    /**
     * The auxiliary files the last successful cold build wrote, so references,
     * citations and the contents resolve in the preview exactly as they do in
     * the PDF on screen. Empty until a cold build has succeeded — a first
     * preview of a fresh paper shows `??`, which is what the first cold build
     * shows too. Best effort per file: the artifact cache may have swept one,
     * and a preview with one fewer input is better than no preview.
     */
    _auxiliaryTexts() {
        const report = this.coldReport;
        const texts = {};
        // Until this session's first build lands, the settled build kept from
        // the last one: the first live pages then already number references.
        const directory = report?.artifact_directory || (!report && this._keptSeedFiles() ? this.settledSeed : null);
        const files = directory ? (report?.artifact_directory ? report.build?.auxiliary_files : this._keptSeedFiles()) : null;
        for (const name of Object.keys(files || {})) {
            if (!AUXILIARY_FILE.test(name) || !SAFE_OVERLAY(name)) continue;
            try { texts[name] = fs.readFileSync(path.join(directory, name), 'utf8'); }
            catch (_) { /* swept or unreadable: the preview reads one fewer */ }
        }
        // What a reference pass adopted from a live build (adoptLiveAuxiliary),
        // until the next settle writes its own.
        for (const [name, text] of Object.entries(this._liveAuxiliaryAdopted || {}))
            if (SAFE_OVERLAY(name) && typeof text === 'string') texts[name] = text;
        return texts;
    }

    /**
     * Take the .aux the last live build wrote as the one live builds read, when
     * it defines references differently from what that build read. True when
     * there was one: the next live build then prints the new numbers.
     */
    adoptLiveAuxiliary() {
        if (!this._pendingLiveAuxiliary) return false;
        this._liveAuxiliaryAdopted = { ...(this._liveAuxiliaryAdopted || {}), ...this._pendingLiveAuxiliary };
        this._pendingLiveAuxiliary = null;
        return true;
    }

    /**
     * Whether the settled build's auxiliary files differ from those the last
     * live build read. The engine then restarts from the top on its next live
     * build (the files are read by the preamble and every page after), which
     * is better paid right after a settle than on the reader's next key.
     */
    liveAuxiliaryStale() {
        return this.interactive && this.interactiveWarm && this._liveAuxiliary !== undefined &&
            auxiliaryDigest(this._auxiliaryTexts()) !== this._liveAuxiliary;
    }

    /** The auxiliary files of the settled build kept for this main file, or null. */
    _keptSeedFiles() {
        try {
            const build = JSON.parse(fs.readFileSync(path.join(this.settledSeed, 'build.json'), 'utf8'));
            return build.settled === true && build.main_file === this.relative(this.root) ? build.auxiliary_files || null : null;
        } catch (_) { return null; }
    }

    /**
     * The live map's view of `pages` (pages the incremental engine drew and
     * whose own maps reached the worker), or null when there is none.
     */
    async liveView(pages) {
        if (this.closed || !pages.length) return null;
        // The session keeps each live page's map and publishes it to the
        // worker only when a viewer reads that page.
        if (typeof this.session?.ensureLiveMaps === 'function') {
            const { ready } = await this.session.ensureLiveMaps(pages);
            pages = pages.filter(page => ready.includes(page));
        }
        if (this.closed || !this.source.livePublished || !pages.length) return null;
        return this.source.readPages(pages, { live:true });
    }

    /**
     * The source of a live page's specials `ordinals` (see the SDK's
     * `source.specials`), files absolute; null when the page has no live map.
     * A TikZ path's special names the command that drew it.
     */
    async liveSpecials(page, ordinals) {
        if (this.closed || typeof this.source.specials !== 'function') return null;
        if (typeof this.session?.ensureLiveMaps === 'function') {
            const { ready } = await this.session.ensureLiveMaps([page]);
            if (!ready.includes(page)) return null;
        }
        if (this.closed || !this.source.livePublished) return null;
        const specials = await this.source.specials(page, ordinals, { live:true });
        const absolute = side => side && { ...side, file: path.resolve(this.projectDir, side.file) };
        return specials.map(s => s && { definition: absolute(s.definition), invocation: absolute(s.invocation) });
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
        this.interactiveWarm = false;
        this.version++;
        // Both resources must finish shutting down even if one rejects. This
        // also makes repeated disposal/retirement share one completion handle.
        this._closing = Promise.allSettled([
            // Closing the build session stops the interactive engine process.
            // It shares this lane's compiler and source session, so it does
            // not close those; the two entries below still own that.
            Promise.resolve().then(() => this.session?.close()),
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
module.exports = { NativeBuildLane, isDocumentFailure, coldBuildEnv };
