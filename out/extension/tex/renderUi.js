// renderUi.js — the editor-visible half of Stage 2.
//
// Owns the compile lifecycle per root document and turns a RenderMap into the
// three things the plan asks for at this stage:
//
//   * page-boundary markers in the source ("PAGE 4 BEGINS (APPROX.)")
//   * a position gutter/status ("p.4 ▰▰▰▰▱ equation") that follows the cursor
//   * render-aware diagnostics ("paragraph exceeds text width by 1.6 mm")
//
// TYPING IS NEVER BLOCKED. A compile of a real 89-page paper takes ~17 s, so it
// runs after a short typing pause, on save and on demand. Between compiles the map
// stays useful for gutters and diagnostics: edits are fed to RenderMap.noteEdit
// so line positions can be translated. The page tracer itself pauses until the
// matching PDF is visible; word matching against old ink is never trustworthy.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');

const {
    compile, saveGeneration, loadGeneration, probeInitCode, snapshotSources, MAX_PASSES_CODE, probeLualatex,
    describeCompileFailure, describeExit,
} = require('./compileService');
const { RenderMap, FLAG } = require('./renderMap');
const { GlyphMap } = require('./glyphMap');
const { NativeMap } = require('./nativeMap');
const { NativeBuildLane } = require('./nativeCompileService');
const { hasNativeRuntime } = require('./nativeRuntime');
const { findRoot, buildGraph } = require('./texProject');
const {
    nextLiveDelayMs, cooldownDelayMs, blendLiveMs, synctexUnchanged,
    generationSatisfies, authoritativeDelayMs, shouldUseGlyphMap, glyphMapBackoff, paperEngineIntent, paperCompileEngine,
} = require('./livePolicy');
const { foldForCompile, MARK: COLLAPSE_MARK } = require('./collapse');
const sameRenderedSource = (st,a,b) => a===b || !!a && !!b &&
    (st.renderlessSnapshots?.get(a) || a)===(st.renderlessSnapshots?.get(b) || b);
const supersededNativeWork=error=>['AbortError','StaleBuild','Cancelled'].includes(error?.name);
const { formatDependencyHelp } = require('./dependencyHelp');

const FLAG_ICON = {
    [FLAG.FRESH]: '$(pass-filled)',
    [FLAG.PROBABLY_CURRENT]: '$(circle-large-outline)',
    [FLAG.STALE]: '$(sync~spin)',
    [FLAG.UNMAPPED]: '$(circle-slash)',
};
const FLAG_WORD = {
    [FLAG.FRESH]: 'fresh',
    [FLAG.PROBABLY_CURRENT]: 'probably current',
    [FLAG.STALE]: 'stale',
    [FLAG.UNMAPPED]: 'unmapped',
};

function nodeDeps() {
    const fs = require('fs');
    return {
        readFile: (p) => fs.readFileSync(p, 'utf8'),
        exists: (p) => { try { return fs.existsSync(p); } catch (_) { return false; } },
        listDir: (p) => { try { return fs.readdirSync(p); } catch (_) { return []; } },
    };
}

/** One root document's compile state. */
/**
 * The map for a generation: exact when the engine emitted one, SyncTeX-only
 * otherwise. One construction site, so nothing downstream has to know which.
 */
/**
 * makeMap, but a native map is indexed in slices of the event loop
 * (NativeMap.build): a long paper's map no longer holds the extension host
 * for a fifth of a second after every typing pause and every settle.
 */
async function makeMapAsync(o) {
    const gen = o && o.generation;
    if (gen && gen.nativeView && gen.nativeSource) return NativeMap.build({ ...o,
        nativeView: gen.nativeView, nativeSource: gen.nativeSource, projectDir: gen.projectDir });
    return makeMap(o);
}

function makeMap(o) {
    const gen = o && o.generation;
    if (gen && gen.nativeView && gen.nativeSource) return new NativeMap({ ...o,
        nativeView: gen.nativeView, nativeSource: gen.nativeSource, projectDir: gen.projectDir });
    if (gen && (gen.glyphMapPath || o.glyphDoc)) return new GlyphMap(o);
    return new RenderMap(o);
}

/**
 * A source file's text, or null — a file we cannot read simply is not folded.
 *
 * CACHED ON (mtime, ctime, size), because this runs for every source file on every
 * rebuild — that is once per typing pause — and a project is many files. The
 * cache is only ever a shortcut past a read whose answer cannot have changed.
 */
const _textCache = new Map();          // file -> {key, text}
function readFileOrNull(f) {
    let key = null;
    try { const st = fs.statSync(f); key = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`; } catch (_) { return null; }
    const hit = _textCache.get(f);
    if (hit && hit.key === key) return hit.text;
    let text = null;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
    if (_textCache.size > 400) _textCache.clear();
    _textCache.set(f, { key, text });
    return text;
}

class RootState {
    constructor(root) {
        this.root = root;
        this.files = [root];
        this.generation = null;
        this.map = null;
        this.prevMap = null;
        this.running = null;      // AbortController
        this.lastError = null;
        this.compiling = false;
        this.liveCompiling = false;
        this.liveQueued = false;   // somebody typed while a live build was running
        // How long this paper's live rebuilds actually take, smoothed. Null
        // until the first one finishes, and null means "use the ceiling".
        this.liveMsEwma = null;
        this.authoritativeRunning = false;
        this.dependencyIssue = null;
        // True from the first source edit until a compile of those exact bytes
        // lands. This is deliberately independent of line displacement: a
        // same-line word edit makes the old PDF just as unfit for tracing.
        this.sourceAhead = false;
    }
}

// With a live engine, the cold map's re-read after typing waits for this long
// a pause in it (see noteChange).
const NATIVE_REFRESH_TYPING_IDLE_MS = 400;
// How long a live build that has not shown its first page yet is protected
// from the next keystroke (see _schedulePreview).
const PREVIEW_FIRST_PAGE_GRACE_MS = 700;

class RenderCoordinator {
    /** @param {import('./index').Projection} projection */
    constructor(projection, output) {
        this.projection = projection;
        this.output = output;
        this.roots = new Map();          // rootPath -> RootState
        this.rootOf = new Map();         // docPath  -> rootPath
        this._emitter = new vscode.EventEmitter();
        this.onDidChange = this._emitter.event;
        // The interactive (incremental) lane's pages, for a viewer that draws
        // them between cold builds. Nothing is ever fired when the installed
        // WLaTeX has no incremental engine, so a consumer needs no other test.
        this._interactiveEmitter = new vscode.EventEmitter();
        this.onDidInteractive = this._interactiveEmitter.event;
        this._liveTimers = new Map();    // rootPath -> debounce handle
        this._previewTimers = new Map(); // rootPath -> live preview throttle handle
        this._previewRecovery = new Map(); // bounded engine retries per source revision
        this._liveFirst = new Map();
        this._idleTimers = new Map();    // rootPath -> the full-rebuild handle
        this._sourceTexts = new Map();
        this._capOk = null;              // can latexmk take our -e? probed once
        this._reportedDependencyIssues = new Set();
        this._buildWork = new Map();
        const { ExternalBuildQueue, gitWorktreeBusy } = require('./externalBuildQueue');
        this._externalBuilds = new ExternalBuildQueue({
            busy: root => !!this._buildWork.get(root)?.size || !!this.roots.get(root)?.compiling || gitWorktreeBusy(root),
            needed: root => {
                const cfg = vscode.workspace.getConfiguration('wolfbook.tex');
                if (!cfg.get('liveRender', true) || cfg.get('compile', 'onSave') === 'off') return false;
                const st = this.roots.get(root);
                if (!st) return false;
                const snapshot = snapshotSources(st.files, this.liveOverlay(root));
                const signature = this._externalSignature(st, snapshot);
                // A failed build is retried by an actual source/asset change or
                // manual Compile, not by delayed review notifications.
                if (st.lastError && st.externalAttempt === signature) return false;
                const needed = !st.map || !this.isCurrent(st, snapshot, { authoritative: st._noConverge !== snapshot });
                if (!needed && st.sourceAhead) { st.sourceAhead = false; this._emitter.fire(st); }
                // An identical reload can invalidate provenance without
                // changing the PDF. Recover that window, not the whole paper.
                if (!needed && st.nativeLane && !st.map?.available) this._scheduleNativeRefresh(st, st.nativeLane, 0);
                return needed;
            },
            run: async root => {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(root));
                const st = this.roots.get(root);
                if (st) st.externalAttempt = this._externalSignature(st);
                await this.build(doc, { external: true, authoritative: true, quiet: true });
            },
            onError: error => this.log(`external rebuild: ${error.message}`),
        });
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._externalBuilds.dispose();
        for (const s of this.roots.values()) this._clearNativeWork(s);
        for (const s of this.roots.values()) if (s.nativeLane) {
            const lane = s.nativeLane;
            s.nativeLane = null;
            lane.close().catch(() => {});
        }
        for (const s of this.roots.values()) if (s.running) s.running.abort();
        for (const t of this._liveTimers.values()) clearTimeout(t);
        for (const t of this._previewTimers.values()) clearTimeout(t);
        for (const t of this._idleTimers.values()) clearTimeout(t);
        this._liveTimers.clear();
        this._previewTimers.clear();
        this._liveFirst.clear();
        this._idleTimers.clear();
        this._sourceTexts?.clear();
        this._emitter.dispose();
        this._interactiveEmitter.dispose();
    }

    /**
     * The unsaved text of every file in this root's include graph.
     *
     * Dirty documents and content changes whose dirty flag has not arrived
     * yet go in. WorkspaceEdit can deliver the new text before isDirty flips;
     * a viewer deletion must preview that text rather than the old disk file.
     */
    liveOverlay(root) {
        const st = this.roots.get(root);
        if (!st) return null;
        const files = new Set(st.files || [root]);
        const m = new Map();
        for (const d of vscode.workspace.textDocuments) {
            if (d.isClosed) continue;
            const f = d.uri.fsPath;
            if (!files.has(f) && f !== root) continue;
            const pending = st.pendingOverlayVersions?.get(f) === d.version;
            if (!d.isDirty && !pending) continue;
            if (d.isDirty) st.pendingOverlayVersions?.delete(f);
            m.set(f, d.getText());
        }

        // FOLDED SECTIONS ARE LEFT OUT OF THE COPY WE COMPILE, AND ONLY THERE.
        //
        // The .tex itself keeps every word — it is shared, on Overleaf and over
        // git, and a colleague must see the whole paper. What is written into
        // the file is two comment lines saying a section is folded; the
        // commenting-out happens here, in the same overlay the live render
        // already uses to compile unsaved buffers.
        //
        // Line for line with the original (tex/collapse.js), so the render map
        // still points at the right source lines.
        for (const f of [...files, root]) {
            const base = m.has(f) ? m.get(f) : readFileOrNull(f);
            if (base == null || base.indexOf(COLLAPSE_MARK) < 0) continue;
            const folded = foldForCompile(base);
            if (folded !== base) m.set(f, folded);
        }
        return m.size ? m : null;
    }

    /** Reopening a stale viewer has no edit event to arm the live timer. */
    ensureLiveRefresh(doc) {
        const root = this.rootFor(doc);
        const st = this.roots.get(root);
        // Do not postpone existing work, duplicate an active build, or retry
        // a failed compile on every UI refresh. A new edit/manual Compile can
        // retry errors through the ordinary paths.
        if (!st || !st.sourceAhead || st.compiling || st.lastError || this._liveTimers.has(root)) return;
        this.scheduleLive(doc, 3000);
    }

    /**
     * Recompile after typing pauses. Debouncing avoids obsolete queued builds
     * and keeps the viewer to at most one swap per pause.
     */
    scheduleLive(doc, delayMs, { preview = true } = {}) {
        const cfg = vscode.workspace.getConfiguration('wolfbook.tex');
        if (!cfg.get('liveRender', true)) return;
        // Someone who turned compiling off did not ask for it back by typing.
        if (cfg.get('compile', 'onSave') === 'off') return;
        const root = this.rootFor(doc);
        const st = this.roots.get(root);
        if (this._externalBuilds.has(root)) {
            // Reader typing retains its incremental preview. A clean buffer
            // reload from Git contributes only to the shared full-build batch.
            if (preview && (doc.isDirty || st?.lastEditOrigin === 'mini-editor')) this._schedulePreview(root, st);
            this.scheduleExternal(doc);
            return;
        }
        if (!st?.sourceAhead && st?.renderlessVersion?.file===doc.uri.fsPath && st.renderlessVersion.version===doc.version) return;
        // With an incremental engine the page on screen follows every
        // keystroke (see _schedulePreview); the full native build below only
        // settles what the preview cannot (PDF, map of every page, aux files),
        // so it waits for typing to really stop.
        const previewing = preview && delayMs === undefined && this._schedulePreview(root, st);
        // THE SETTING IS THE CEILING, NOT THE VALUE. A paper that rebuilds in
        // 400 ms should feel immediate; one that takes 17 s must stay calm,
        // because firing sooner than the last build finished only queues work
        // the next keystroke will cancel.
        let wait = delayMs ?? nextLiveDelayMs({
            lastMs: st && st.liveMsEwma,
            ceilingMs: Math.max(200, cfg.get('liveRenderDelayMs', 900)),
        });
        const settleMs = Math.max(0, cfg.get('nativeSettleDelayMs', 2500));
        if (previewing) wait = Math.max(wait, settleMs);
        const prev = this._liveTimers.get(root);
        // Every automatic full build waits for idle. A first-edit deadline
        // would force a PDF rebuild in the middle of sustained typing.
        this._liveFirst.delete(root);
        if (prev) clearTimeout(prev);
        this._liveTimers.set(root, setTimeout(() => {
            this._liveTimers.delete(root);
            this._liveFirst.delete(root);
            this.build(doc, { live: true }).catch(() => { /* reported via state */ });
        }, wait));
        // Typing also postpones the full rebuild that converges cross-references.
        this._armAuthoritative(root, wait);
    }

    _externalSignature(st, snapshot = snapshotSources(st.files, this.liveOverlay(st.root))) {
        const assets = this._assetFiles(st);
        return `${snapshot}:${assets.length ? snapshotSources(assets) : ''}`;
    }

    /** All external files of one paper share one settled build after the burst. */
    scheduleExternal(doc) {
        if (this._disposed) return;
        const cfg = vscode.workspace.getConfiguration('wolfbook.tex');
        if (!cfg.get('liveRender', true) || cfg.get('compile', 'onSave') === 'off') return;
        const root = this.rootFor(doc);
        // Cancel competing full builds, leaving the reader's already queued
        // incremental page preview intact.
        for (const timers of [this._liveTimers, this._idleTimers]) {
            const timer = timers.get(root);
            if (timer != null) clearTimeout(timer);
            timers.delete(root);
        }
        this._liveFirst.delete(root);
        this._externalBuilds.notify(root, Math.max(1000, cfg.get('liveRenderDelayMs', 900)));
    }

    /**
     * A full rebuild once the typing really stops.
     *
     * Live builds may stop after one engine pass, so cross-references, the
     * table of contents and page numbers can lag while you type. Paying for
     * convergence on every pause would defeat the point, so the correction is
     * deferred to a real gap — and it is usually FREE to apply: if the full
     * build produces the same PDF, texViewer.refresh recognises the content
     * hash and ships nothing at all.
     *
     * LIVE ALWAYS WINS. A keystroke re-arms this timer, it refuses to start
     * while anything is compiling, and compileService serialises the out dir
     * regardless.
     */
    _armAuthoritative(root, liveDelayMs) {
        const prev = this._idleTimers.get(root);
        if (prev) clearTimeout(prev);
        const cfg = vscode.workspace.getConfiguration('wolfbook.tex');
        const wait = authoritativeDelayMs({
            configuredMs: cfg.get('authoritativeDelayMs', 4000),
            liveDelayMs,
        });
        if (!wait) return;
        this._idleTimers.set(root, setTimeout(() => {
            this._idleTimers.delete(root);
            const st = this.roots.get(root);
            // NOTHING TO CONVERGE UNLESS THE LAST BUILD LEFT SOMETHING BEHIND,
            // and there are two ways for that to happen: the pass cap bit
            // (`passesLimited`), or LaTeX itself asked for another pass
            // (`rerunWanted`) — which is what a brand new \label does. Only
            // the first was checked here, so a new label printed `??` and
            // nothing ever went back to fix it. Reported exactly that way.
            const g = st && st.generation;
            if (!g || !(g.passesLimited || g.rerunWanted)) return;
            if (st.compiling) { this._armAuthoritative(root, liveDelayMs); return; }
            // A PAPER THAT ALWAYS ASKS IS NOT A REASON TO COMPILE FOR EVER.
            //
            // The rule is EMPIRICAL, because no rule about the log can cover
            // every package: once a correcting build has run and demonstrably
            // fixed nothing — it still wants a rerun and produced byte for byte
            // the same PDF — this text is not going to converge, and we stop
            // asking until the reader changes something. (LaTeX does not
            // request a rerun for a \ref whose label does not exist; that is
            // reported as "undefined", never as "rerun", so a broken reference
            // never gets us here at all. Measured, not assumed.)
            if (st._noConverge === g.sourceSnapshotHash) return;
            const tries = (st._convergeAt === g.sourceSnapshotHash ? st._convergeTries || 0 : 0);
            if (tries >= 2) return;
            st._convergeAt = g.sourceSnapshotHash;
            st._convergeTries = tries + 1;
            this.buildAuthoritative(root, { was: g }).catch(() => { /* reported via state */ });
        }, wait));
    }

    /** The background full rebuild. Quiet by construction: no progress toast. */
    async buildAuthoritative(root, { was = null } = {}) {
        const st = this.roots.get(root);
        if (!st || st.compiling) return;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(root)); }
        catch (_) { return; }
        if (was && st.generation !== was) return;
        st.authoritativeRunning = true;
        this._emitter.fire(st);
        try { await this.build(doc, { authoritative: true, quiet: true, settleGeneration: was }); }
        finally { st.authoritativeRunning = false; this._emitter.fire(st); }

        // DID IT ACTUALLY FIX ANYTHING? If the correcting build still wants a
        // rerun and produced exactly the PDF it was correcting, then whatever
        // is unresolved in this paper is not resolvable by compiling it again.
        // Remember that against the TEXT, so the next edit is free to try.
        const now = st.generation;
        if (was && now && now.rerunWanted && now.pdfHash && now.pdfHash === was.pdfHash) {
            st._noConverge = now.sourceSnapshotHash;
            this.log('  the rebuild changed nothing and it still wants a rerun — ' +
                'leaving it alone until the paper changes');
        }
    }

    rootFor(doc) {
        const p = doc.uri.fsPath;
        if (this.rootOf.has(p)) return this.rootOf.get(p);
        let root = p;
        try {
            const deps = nodeDeps();
            const r = findRoot(p, deps);
            root = r.root;
            const g = buildGraph(root, deps);
            const st = this.roots.get(root) || new RootState(root);
            st.files = g.files.length ? g.files : [root];
            this.roots.set(root, st);
            for (const f of st.files) this.rootOf.set(f, root);
        } catch (_) { /* fall back to the file itself */ }
        this.rootOf.set(p, root);
        if (!this.roots.has(root)) this.roots.set(root, new RootState(root));
        return root;
    }

    stateFor(doc) { return this.roots.get(this.rootFor(doc)) || null; }
    mapFor(doc) { const s = this.stateFor(doc); return s ? s.map : null; }

    /** The PDF text sweep is not a viewport: it visits the entire paper. */
    noteRenderedPage(root, generation, page) {
        const st = this.roots.get(root);
        if (!st || !Number.isInteger(page)) return;
        if (!this._nativeWindow(st).includes(page)) return;
        if (st.nativeLane && st.map?.native && !st.map.hasPage(page)) this._scheduleNativeRefresh(st, st.nativeLane, 50);
    }
    /** Materialize geometry near the reader, never every page visited before. */
    noteNativeViewport(root, page) {
        const st = this.roots.get(root);
        if (!st || !Number.isInteger(page) || page < 1 || st.nativeViewportPage === page) return;
        st.nativeViewportPage = page;
        if (st.nativeLane && st.map?.native) this._scheduleNativeRefresh(st, st.nativeLane, 50);
    }
    _nativeWindow(st) {
        const center = st.nativeViewportPage || 1;
        const count = Math.max(center, st.generation?.pageCount || Infinity);
        return [center - 1, center, center + 1].filter(p => p >= 1 && p <= count);
    }
    /**
     * Refreshes coalesce: a burst of keystrokes produces one page read after
     * the burst, never one per character, and at most one read is in flight.
     * The worker translates every intermediate revision, so nothing is lost.
     */
    _scheduleNativeRefresh(st, lane, delayMs = 80) {
        if (this._disposed || this.proDisabled || st.nativeLane !== lane) return;
        // WITH A LIVE ENGINE, NOT WHILE THE READER TYPES — whoever asks (an
        // edit, the viewer's text sweep, a read a keystroke made stale). On a
        // long paper the read is the whole document, and done per keystroke
        // it held this process long enough for the next key to supersede the
        // live build before its page arrived. The live pages show the typing;
        // this map catches up at a pause, or at once for a click
        // (ensureNativeMap).
        const lastKey = Math.max(st.lastEditAt || 0, st.lastInkAt || 0);
        const sinceKey = lastKey ? Date.now() - lastKey : Infinity;
        if (lane?.interactive && sinceKey < NATIVE_REFRESH_TYPING_IDLE_MS) delayMs = Math.max(delayMs, NATIVE_REFRESH_TYPING_IDLE_MS - sinceKey);
        clearTimeout(st.nativeRefreshTimer);
        st.nativeRefreshTimer = setTimeout(() => {
            if (this._disposed || this.proDisabled || st.nativeLane !== lane) return;
            // A key since this was asked for: wait for the pause again.
            const last = Math.max(st.lastEditAt || 0, st.lastInkAt || 0);
            if (lane?.interactive && last && Date.now() - last < NATIVE_REFRESH_TYPING_IDLE_MS) {
                this._scheduleNativeRefresh(st, lane, 0);
                return;
            }
            // NOT WHILE A BUILD RUNS: it installs its own map when it lands,
            // and a read now (hundreds of ms of this thread on a long paper)
            // would be thrown away seconds later. Afterwards, only if the map
            // is still behind (the build failed or was superseded).
            if (st.compiling) { this._scheduleNativeRefresh(st, lane, 500); return; }
            const window = this._nativeWindow(st);
            if (st.map?.native && st.map.available && window.every(p => st.map.hasPage(p)) &&
                (st.map.materializedPages || []).every(p => window.includes(p))) return;
            this._runNativeRefresh(st, lane).catch(() => {});
        }, delayMs);
    }
    /**
     * The cold map, current, for a click that needs it now: a refresh the
     * typing postponed runs at once. True when the map is available.
     */
    async ensureNativeMap(st, timeoutMs = 1500, page = null) {
        const ready = () => !!st?.map?.available && (!Number.isInteger(page) || st.map.hasPage(page));
        if (!st?.map?.native || ready()) return ready();
        if (Number.isInteger(page) && page > 0) st.nativeViewportPage = page;
        const lane = st.nativeLane;
        if (!lane) return false;
        const deadline = Date.now() + timeoutMs;
        clearTimeout(st.nativeRefreshTimer);
        const refresh = async () => {
            let timer;
            try {
                await Promise.race([
                    this._runNativeRefresh(st, lane).catch(() => {}),
                    new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
                ]);
            } finally { clearTimeout(timer); }
        };
        await refresh();
        while (!ready() && !this._disposed && st.nativeLane === lane && Date.now() < deadline) {
            if (!st.nativeRefreshing) await refresh();
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return !this._disposed && st.nativeLane === lane && ready();
    }
    async _runNativeRefresh(st, lane) {
        if (this._disposed || this.proDisabled || st.nativeLane !== lane) return;
        if (st.nativeRefreshing) { st.nativeRefreshAgain = true; return; }
        st.nativeRefreshing = true;
        try {
            const generation = st.generation;
            if (st.nativeLane !== lane || generation?.nativeSource !== lane.source) return;
            let view;
            try { view = await lane.refresh(this._nativeWindow(st)); }
            catch (error) {
                // A keystroke during pagination invalidates the view; read again
                // after the burst instead of giving the lane up.
                if (supersededNativeWork(error)) { st.nativeRefreshAgain = true; return; }
                throw error;
            }
            if (!view || st.nativeLane !== lane || st.generation !== generation || generation?.nativeSource !== lane.source) return;
            // Between a newer build publishing its map and that build
            // becoming st.generation, the refreshed view belongs to a PDF
            // that is not displayed yet. The newer build installs its own
            // map when it lands; building one here would throw and retire
            // the lane on an ordinary keystroke.
            if (generation.pdfHash && view.artifact?.pdf_hash !== generation.pdfHash) return;
            const map = await makeMapAsync({ generation: { ...generation, nativeView: view },
                model:this._modelFor(st.root), pageSize:this._pageSize(generation) });
            // Built across ticks: install it only if nothing replaced the lane,
            // the generation or its view meanwhile.
            if (st.nativeLane !== lane || st.generation !== generation || generation?.nativeSource !== lane.source) return;
            generation.nativeView = view;
            st.map = map;
            this._emitter.fire(st);
        } catch (error) {
            if(supersededNativeWork(error)) {
                if(st.nativeLane===lane)st.nativeRefreshAgain=true;
                return;
            }
            this.log(`  native mapping: ${error.message}`);
            await this._retireNativeLane(st, lane, error.message);
        } finally {
            st.nativeRefreshing = false;
            if (st.nativeRefreshAgain) { st.nativeRefreshAgain = false; this._scheduleNativeRefresh(st, lane, 0); }
        }
    }

    /**
     * THE LIVE PREVIEW FOLLOWS THE KEYSTROKES, NOT THE PAUSES.
     *
     * The incremental engine puts an edited page on screen in tens of
     * milliseconds, and a newer request abandons an older build at its next
     * page boundary, so there is nothing to wait for: a short trailing
     * throttle merges a burst of keys into one request. It runs outside
     * build() and never waits for a cold build. Answers true when a preview
     * was scheduled (an incremental engine is present).
     */
    _schedulePreview(root, st, { now = false } = {}) {
        const lane = st && st.nativeLane;
        if (!lane || !lane.interactive || this._disposed || this.proDisabled || st.nativeOff) return false;
        const cfg = vscode.workspace.getConfiguration('wolfbook.tex');
        const throttle = Math.max(0, cfg.get('livePreviewThrottleMs', 30));
        // LEADING EDGE WHEN IDLE. With no preview build in flight the keystroke
        // starts one at once (the throttle alone was most of the delay to the
        // page); keystrokes that arrive while one runs wait out the throttle
        // and start a single build that supersedes it, so a burst still
        // coalesces into one build per throttle window.
        const busy = (this._previewBusy ||= new Map());
        // NO KEY CANCELS A BUILD THAT HAS NOT SHOWN ANYTHING YET. On a long
        // paper the first changed page takes longer than the gap between two
        // keys, so superseding at every key cancelled every build before its
        // page arrived: nothing moved until a pause ("it only refreshes after
        // 2–3 words"). The key waits instead, and its build starts the moment
        // that page is on screen (or the build ends, or the grace runs out).
        const cur = (this._previewCur ||= new Map()).get(root);
        if (cur && busy.get(root) === cur.run && !cur.shown && Date.now() - cur.started < PREVIEW_FIRST_PAGE_GRACE_MS) {
            cur.pending = true;
            clearTimeout(cur.graceTimer);
            cur.graceTimer = setTimeout(() => { if (cur.pending) { cur.pending = false; cur.shown = true; this._schedulePreview(root, st); } },
                Math.max(0, PREVIEW_FIRST_PAGE_GRACE_MS - (Date.now() - cur.started)));
            return true;
        }
        clearTimeout(this._previewTimers.get(root));
        this._previewTimers.set(root, setTimeout(() => {
            this._previewTimers.delete(root);
            if (this._disposed || this.proDisabled || st.nativeLane !== lane) return;
            const next = { started: Date.now(), shown: false, pending: false, run: null };
            const run = this._runInteractive(st, lane, root, { root, sourceFiles: st.files, overlay: this.liveOverlay(root),
                nativePages: this._nativeWindow(st) }, next).catch(() => { /* logged inside */ });
            next.run = run;
            this._previewCur.set(root, next);
            busy.set(root, run);
            run.finally(() => {
                if (busy.get(root) === run) busy.delete(root);
                clearTimeout(next.graceTimer);
                // A key held for this build that ended without a page.
                if (next.pending) { next.pending = false; this._schedulePreview(root, st); }
            });
        // A build that has drawn its paragraph fragment has nothing left to
        // coalesce for: the next key's build reaches its own fragment in a
        // few ms, and the engine drops the running one within a slice.
        }, busy.has(root) && !now && !cur?.fragmentShown ? throttle : 0));
        return true;
    }

    /**
     * NEW REFERENCES RESOLVE LIVE. A \\label (or a \\ref to one) typed now
     * prints "??" until a build reads the .aux that defines it: the live
     * build that saw it wrote that .aux, so at the next pause in typing one
     * more live build reads it (LaTeX's second pass, without waiting for the
     * settle). At most two per text, as LaTeX's own reruns converge.
     */
    _scheduleReferencePass(root, st, lane) {
        if (this._disposed || this.proDisabled || st.nativeOff || st.nativeLane !== lane) return;
        const timers = (this._referenceTimers ||= new Map());
        clearTimeout(timers.get(root));
        if (st.referencePassText === st.lastEditAt && (st.referencePasses || 0) >= 2) return;
        const fire = () => {
            if (this._disposed || this.proDisabled || st.nativeOff || st.nativeLane !== lane || !lane.interactive) return;
            const last = Math.max(st.lastEditAt || 0, st.lastInkAt || 0);
            const wait = last ? NATIVE_REFRESH_TYPING_IDLE_MS - (Date.now() - last) : 0;
            if (wait > 0 || this._previewBusy?.has(root)) { timers.set(root, setTimeout(fire, Math.max(wait, 30))); return; }
            if (typeof lane.adoptLiveAuxiliary !== 'function' || !lane.adoptLiveAuxiliary()) return;
            if (st.referencePassText !== st.lastEditAt) { st.referencePassText = st.lastEditAt; st.referencePasses = 0; }
            st.referencePasses++;
            const busy = (this._previewBusy ||= new Map());
            const run = this._runInteractive(st, lane, root, { root, sourceFiles: st.files, overlay: this.liveOverlay(root),
                nativePages: this._nativeWindow(st) }).catch(() => { /* logged inside */ });
            busy.set(root, run);
            run.finally(() => { if (busy.get(root) === run) busy.delete(root); });
        };
        timers.set(root, setTimeout(fire, 0));
    }

    /**
     * A settle that changed the auxiliary files (new references, a longer
     * contents) makes the live engine's next build start from the top. Paid
     * here, in the background while the reader is not typing, rather than on
     * their next key: a live build whose pages are not drawn.
     */
    _warmLiveAfterSettle(root, st, lane) {
        if (this._disposed || this.proDisabled || st.nativeOff || st.nativeLane !== lane) return;
        if (!lane?.interactive || typeof lane.liveAuxiliaryStale !== 'function' || !lane.liveAuxiliaryStale()) return;
        const last = Math.max(st.lastEditAt || 0, st.lastInkAt || 0);
        if ((last && Date.now() - last < NATIVE_REFRESH_TYPING_IDLE_MS) || this._previewBusy?.has(root)) return;
        const busy = (this._previewBusy ||= new Map());
        const run = lane.interactiveBuild({ root, sourceFiles: st.files, overlay: this.liveOverlay(root),
            nativePages: this._nativeWindow(st) }).catch(() => null);
        busy.set(root, run);
        run.finally(() => { if (busy.get(root) === run) busy.delete(root); });
    }

    /**
     * FIRST OPEN, PAGES FIRST. A new lane has no PDF to show until its first
     * full build lands (median 2.2 s, up to 15 s on the arXiv corpus); the
     * live engine typesets the first page in about half a second. So a live
     * build runs at once, next to that full build, and its pages are what the
     * viewer shows first (texViewer's `liveStart`). It waits for the engine
     * to start, which a keystroke's preview does not.
     */
    _previewFirstOpen(root, st) {
        const lane = st && st.nativeLane;
        if (!lane || !lane.interactive || this._disposed || this.proDisabled || st.nativeOff) return;
        const busy = (this._previewBusy ||= new Map());
        if (busy.has(root)) return;
        const run = this._runInteractive(st, lane, root, { root, sourceFiles: st.files, overlay: this.liveOverlay(root),
            nativePages: this._nativeWindow(st), wait: true }).catch(() => { /* logged inside */ });
        busy.set(root, run);
        run.finally(() => { if (busy.get(root) === run) busy.delete(root); });
    }

    /**
     * One interactive preview build, with its pages pushed to whatever is
     * drawing them. Everything here is contained: it cannot throw, it cannot
     * retire the lane, and it cannot change `st.generation`, `st.map` or any
     * other state the cold build owns. The worst it can do is log a line and
     * cost the pause the time it took.
     */
    /** A live build's first changed page is on screen: a key held for it starts the next build now. */
    _previewShown(root, st, cur) {
        if (cur.shown) return;
        cur.shown = true;
        clearTimeout(cur.graceTimer);
        // It has waited already: no throttle.
        if (cur.pending) { cur.pending = false; setImmediate(() => this._schedulePreview(root, st, { now: true })); }
    }

    async _runInteractive(st, lane, root, compileOpts, cur = null) {
        if (this._disposed || this.proDisabled || st.nativeOff || st.nativeLane !== lane) return null;
        const t0 = Date.now();
        const revision = st.sourceRevision || 0;
        const diagnosticsAtStart = st.diagnosticsSequence || 0;
        const keyAt = st.lastEditAt || t0;
        let result = null;
        try {
            result = await lane.interactiveBuild({ ...compileOpts,
                onPage: page => {
                    if (this._disposed || this.proDisabled || st.nativeLane !== lane) return;
                    this._interactiveEmitter.fire({ kind:'page', root, ...page });
                    // FRESH, not merely "changed": a build re-sends pages it calls
                    // changed that are identical to what was delivered before
                    // (it compares with its last COMPLETED build, and typing
                    // cancels them all), so page 1 arrived at once in every build
                    // and counted as shown long before the page being typed on.
                    if (page.changed !== false) {
                        const seen = (st.liveIdentity ||= new Map());
                        const fresh = !page.identity || seen.get(page.page) !== page.identity;
                        if (page.identity) seen.set(page.page, page.identity);
                        if (cur && fresh) this._previewShown(root, st, cur);
                    }
                },
                // THE TYPED PARAGRAPH FIRST. A fragment is the paragraph being
                // typed, set as the page will set it and placed on the page
                // shown; it reaches the screen tens of ms before the page. A
                // placed fragment is the build's "shown" moment (#42): the
                // next key may supersede this build, and its page comes when
                // the typing pauses.
                onFragment: fragment => {
                    if (this._disposed || this.proDisabled || st.nativeLane !== lane) return;
                    this._interactiveEmitter.fire({ kind:'fragment', root, ...fragment });
                    if (cur && fragment.placement && fragment.txdl) {
                        cur.fragmentShown = true;
                        this._previewShown(root, st, cur);
                    }
                },
                onPageMap: map => {
                    if (this._disposed || this.proDisabled || st.nativeLane !== lane) return;
                    this._interactiveEmitter.fire({ kind:'pageMap', root, lane, ...map });
                } });
        } catch (error) {
            // interactiveBuild answers with a failure rather than throwing;
            // this is here so that a future one still cannot break a keystroke.
            this.log(`  WLaTeX live preview: ${error.message}`);
            return null;
        }
        if (!result || this._disposed || this.proDisabled || st.nativeLane !== lane) return null;
        // The full compile is authoritative. An older live run finishing
        // late cannot replace its diagnostics, even for identical source.
        const canPublishDiagnostics = (st.sourceRevision || 0) === revision &&
            !(st.compileDiagnostics?.revision === revision && st.compileDiagnostics.sequence > diagnosticsAtStart);
        if (!result.ok) {
            const problem = result.diagnostics?.find(d => d.severity === 'error') || result.diagnostics?.[0];
            const reason = `${problem?.line ? `Line ${problem.line}: ` : ''}${problem?.message || 'the live build failed'}`;
            this.log(`  WLaTeX live preview skipped: ${reason}`);
            if (canPublishDiagnostics) {
                const sourceErrors = (result.diagnostics || []).filter(d => d.severity === 'error' && !d.producer);
                const producer = problem?.producer === true && !sourceErrors.length;
                st.livePreviewError = { revision, reason, producer };
                // A preview watchdog or restart failure says nothing about
                // the document's TeX. Keep its real diagnostics untouched.
                if (!producer) st.liveDiagnostics = { revision, at:Date.now(), sequence:st.diagnosticsSequence = (st.diagnosticsSequence || 0) + 1,
                    list:sourceErrors.map(d => ({ ...d, file:d.file ? path.resolve(lane.projectDir, d.file) : null })) };
                this._emitter.fire(st);
                if (producer) this._retryPreview(st, lane, revision);
            }
            return result;
        }
        // THE LIVE ERRORS, NOW. A preview that hit a TeX error says so while
        // the reader is still at the keyboard; the next full build's own
        // diagnostics replace these (renderDiagnostics compares the times).
        const errors = (result.diagnostics || []).filter(d => d.severity === 'error')
            .map(d => ({ ...d, file: d.file ? path.resolve(lane.projectDir, d.file) : null }));
        const hadLive = !!st.liveDiagnostics?.list.length;
        const hadPreviewError = !!st.livePreviewError;
        if (canPublishDiagnostics) {
            const problem = result.diagnostics?.find(d => d.severity === 'error');
            st.livePreviewError = problem ? { revision,
                reason:`${problem.line ? `Line ${problem.line}: ` : ''}${problem.message}` } : null;
        }
        if (canPublishDiagnostics) st.liveDiagnostics = { revision, at: Date.now(),
            sequence:st.diagnosticsSequence = (st.diagnosticsSequence || 0) + 1, list: errors };
        if ((st.sourceRevision || 0) === revision) this._clearPreviewRecovery(root);
        // The page now shows the latest text: the status says "live".
        const wasCurrent = st.livePreviewAt >= (st.lastEditAt || 0);
        st.livePreviewAt = keyAt;
        st.livePreviewRevision = revision;
        const r = result.report || {};
        st.livePreviewStats = { firstChangedMs: r.first_changed_ms ?? null, totalMs: r.total_ms ?? null,
            recomputed: r.pages_recomputed ?? null, reused: r.pages_reused ?? null,
            sinceKeyMs: st.lastEditAt ? Date.now() - st.lastEditAt : null };
        if (errors.length || hadLive || hadPreviewError || !wasCurrent) this._emitter.fire(st);
        const report = result.report || {};
        // Honest by construction: this says what the preview recomputed, not
        // what is settled. The settled state is still the cold build's, and
        // the status bar keeps saying so.
        const summary = `live: ${report.pages_recomputed ?? '?'} page(s) recomputed, ` +
            `${report.pages_reused ?? 0} reused of ${result.pageCount ?? '?'} · ` +
            `${Math.round(report.total_ms ?? (Date.now() - t0))} ms`;
        this.log(`  ${summary}`);
        // The page each error was typeset on (the engine places it by the log
        // offset of every page's shipout), so the preview can mark it there.
        this._interactiveEmitter.fire({ kind:'built', root, generation:result.generation,
            pageCount:result.pageCount, pages:result.pages, report, summary,
            errors: errors.filter(e => Number.isInteger(e.page)).slice(0, 20)
                .map(e => ({ page:e.page, file:e.file, line:e.line, message:e.message })) });
        if (result.referencesChanged) this._scheduleReferencePass(root, st, lane);
        return result;
    }

    /**
     * Give the native lane up for this root. With a reason it is a failure of
     * the lane itself (worker, protocol, producer), not of the document:
     * document errors come back as failed generations and never reach here.
     * A failure is said once per distinct reason, because a silent fallback
     * to latexmk is exactly what made the lane untrustworthy.
     */
    async _retireNativeLane(st, lane, reason = null) {
        const current = st.nativeLane === lane;
        if (current) {
            this._clearNativeWork(st);
            st.nativeLane = null;
            if (reason) st.nativeUnavailable = reason;
        }
        try { await lane.close(); }
        catch (error) { this.log(`WLaTeX shutdown: ${error.message}`); }
        if (current && !this._disposed && !st.nativeLane) this._emitter.fire(st);
        if (current && reason) this._noticeNativeLane(`WLaTeX preview stopped: ${reason}. Using the normal WPaper compiler until the next Compile.`);
    }

    _clearPreviewRecovery(root) {
        clearTimeout(this._previewRecovery?.get(root)?.timer);
        this._previewRecovery?.delete(root);
    }

    _retryPreview(st, lane, revision) {
        const root = st.root;
        let retry = this._previewRecovery.get(root);
        if (!retry || retry.revision !== revision) {
            this._clearPreviewRecovery(root);
            retry = { revision, attempts:0, timer:null };
            this._previewRecovery.set(root, retry);
        }
        if (retry.timer || retry.attempts >= 2) return;
        retry.attempts++;
        retry.timer = setTimeout(() => {
            retry.timer = null;
            if (this._disposed || this.proDisabled || st.nativeOff || st.nativeLane !== lane ||
                (st.sourceRevision || 0) !== revision || !st.livePreviewError?.producer) return;
            this._schedulePreview(root, st, { now:true });
        }, retry.attempts * 1000);
    }

    _clearNativeWork(st) {
        this._clearPreviewRecovery(st.root);
        clearTimeout(st.nativeRefreshTimer);
        st.nativeRefreshTimer = null;
        st.nativeRefreshAgain = false;
        for (const timers of [this._previewTimers, this._referenceTimers]) {
            clearTimeout(timers?.get(st.root));
            timers?.delete(st.root);
        }
        const cur = this._previewCur?.get(st.root);
        if (cur) { clearTimeout(cur.graceTimer); cur.pending = false; }
        this._previewCur?.delete(st.root);
        this._previewBusy?.delete(st.root);
    }

    /** A deliberate engine setting change supersedes work prepared for the old engine. */
    configurationChanged(event) {
        if (this._disposed || !['mapEngine', 'wlatexDirectory', 'engine'].some(key =>
            event.affectsConfiguration(`wolfbook.tex.${key}`))) return false;
        this._licenseRefused = null;
        for (const st of this.roots.values()) {
            st.buildPreparation = (st.buildPreparation || 0) + 1;
            st.running?.abort();
            this._clearNativeWork(st);
            for (const timers of [this._liveTimers, this._idleTimers]) {
                clearTimeout(timers.get(st.root));
                timers.delete(st.root);
            }
            this._liveFirst.delete(st.root);
            st.nativeRefusedSnapshot = null;
            st.nativeRefusedDirectory = null;
            st.nativeUnavailable = null;
            st.prevMap = st.map;
            st.map = null;
            if (st.nativeLane) this._retireNativeLane(st, st.nativeLane).catch(error => this.log(error.message));
            this._emitter.fire(st);
        }
        return true;
    }

    _noticeNativeLane(message, license = false) {
        this._nativeNotices ||= new Set();
        if (this._nativeNotices.has(message)) return;
        this._nativeNotices.add(message);
        const show = 'Show log', enter = 'Enter Licence…';
        const picks = license ? [enter, show] : [show];
        Promise.resolve(vscode.window.showWarningMessage(message, ...picks))
            .then(pick => {
                if (pick === show) this.output.show(true);
                if (pick === enter) vscode.commands.executeCommand('wolfbook.tex.enterWlatexLicense');
            })
            .catch(() => { /* a notice must never break compiling */ });
    }

    /**
     * A licence was just installed: WLaTeX may be used again at the next
     * build, and its notices may be said again.
     */
    licenseInstalled() {
        this._licenseRefused = null;
        this._nativeNotices = new Set([...(this._nativeNotices || [])].filter(m => !/WLaTeX (trial|licen)/i.test(m)));
    }

    /**
     * Say once per paper and reason why its live preview is off: the paper
     * is written for another engine (WLaTeX's live engine is XeTeX), so the
     * page follows saves through `engine` instead of every keystroke.
     */
    _noticeNativeOff(root, reason, engine, choice = null) {
        this._nativeOffNotices ||= new Set();
        const key = `${root}\0${reason}`;
        if (this._nativeOffNotices.has(key)) return;
        this._nativeOffNotices.add(key);
        const name = path.basename(root);
        const show = 'Show log';
        const intent = choice?.intent;
        // THE WRITER CHOOSES. A paper that only shows it is written for
        // pdfLaTeX (not one that declares it) may be previewed with WLaTeX
        // anyway, after a warning: fonts and line breaks can differ a little
        // from the pdflatex PDF. `\pdfoutput=1` would stop XeTeX, so that
        // choice rewrites it as `\ifdefined\pdfoutput\pdfoutput=1\fi` —
        // which pdflatex reads as before and arXiv still recognises — and the
        // paper is then simply one WLaTeX builds. Other pdfTeX- or
        // LuaTeX-only code is previewed as it is, for this preamble.
        if (intent && !intent.why.startsWith('% !TEX')) {
            const pdfoutput = intent.why === '\\pdfoutput=1' && intent.line;
            const anyway = 'Preview with WLaTeX', keep = `Keep ${engine}`;
            const message = `Live preview is off for ${name}: ${reason}, and WLaTeX's live engine is XeTeX. ` +
                `WLaTeX can preview it anyway; fonts and line breaks may differ slightly from the ${engine} PDF. ` +
                (pdfoutput ? `This changes line ${intent.line} to "\\ifdefined\\pdfoutput\\pdfoutput=1\\fi", which ${engine} and arXiv read as before. ` : '') +
                `An explicit Compile still uses ${engine}.`;
            Promise.resolve(vscode.window.showWarningMessage(message, anyway, keep, show))
                .then(async pick => {
                    if (pick === show) this.output.show(true);
                    if (pick === anyway) await this.chooseNative(root);
                })
                .catch(() => { /* a notice must never break compiling */ });
            return;
        }
        const message = `Live preview is off for ${name}: ${reason}, and WLaTeX's live engine is XeTeX. ` +
            `WPaper builds it with ${engine}, and the page updates when you save. ` +
            'To preview it live, put "% !TEX program = xelatex" on its first line.';
        Promise.resolve(vscode.window.showInformationMessage(message, show))
            .then(pick => { if (pick === show) this.output.show(true); })
            .catch(() => { /* a notice must never break compiling */ });
    }

    /**
     * The writer chose WLaTeX for a paper written for another engine (from
     * the warning, or the WLaTeX Pro badge at any time): `\pdfoutput=1` is
     * made engine-neutral, other pdfTeX- or LuaTeX-only code is previewed as
     * it is while the preamble stays the same. Resolves false when the paper
     * declares its engine (`% !TEX program`) or nothing was in the way.
     */
    async chooseNative(root) {
        const st = this.roots.get(root);
        if (!st) return false;
        const hints = paperEngineHints(root, this.liveOverlay(root));
        const intent = hints?.intent;
        if (!intent || ['xelatex', 'xetex'].includes(intent.program) || intent.why.startsWith('% !TEX')) return false;
        const doc = await vscode.workspace.openTextDocument(root);
        const name = path.basename(root);
        if (intent.why === '\\pdfoutput=1' && intent.line) {
            if (!await this._neutralizePdfoutput(doc, intent.line)) return false;
            this.log(`WLaTeX chosen for ${name}: line ${intent.line} now reads \\ifdefined\\pdfoutput\\pdfoutput=1\\fi`);
        } else {
            st.nativeOverride = hints.preamble;
            this.log(`WLaTeX chosen for ${name} while its preamble stays as it is`);
        }
        st.nativeOffLogged = null;
        await this.build(doc, { quiet: true });
        return true;
    }

    /** `\pdfoutput=1` on `line` (1-based) → `\ifdefined\pdfoutput\pdfoutput=1\fi`, as one edit. */
    async _neutralizePdfoutput(doc, line) {
        if (line < 1 || line > doc.lineCount) return false;
        const text = doc.lineAt(line - 1).text;
        const m = /\\pdfoutput\s*=?\s*1\b/.exec(text);
        if (!m || /\\ifdefined\s*\\pdfoutput/.test(text)) return false;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(line - 1, m.index, line - 1, m.index + m[0].length), `\\ifdefined\\pdfoutput${m[0]}\\fi`);
        return vscode.workspace.applyEdit(edit);
    }

    /** Feed an edit through, so the map can translate rather than go stale. */
    noteChange(e, { origin = 'editor' } = {}) {
        if (this._disposed) return;
        const file = e.document.uri.fsPath;
        if (!e.contentChanges?.length) {
            // The later dirty/save notification ends the WorkspaceEdit gap.
            // Do not leave a clean buffer shadowing future disk changes.
            this.roots.get(this.rootOf.get(file))?.pendingOverlayVersions?.delete(file);
            return;
        }
        const st = this.stateFor(e.document);
        if (!st) return;
        const after=typeof e.document.getText==='function' ? e.document.getText() : null;
        const impact=after==null ? {renderChanged:true} : require('./renderChange').editImpact(
            after,e.contentChanges,this._sourceTexts?.get(file));
        if (after!=null) (this._sourceTexts ||= new Map()).set(file,after);
        if (impact.sourceChanged===false) return impact;
        const wasAhead=!!st.sourceAhead;
        // Only a proven blank-line space edit can alias an already-current
        // PDF. Capture both raw snapshots: real pending edits stay behind.
        let beforeSnapshot=null;
        if (!impact.renderChanged) {
            try {
                const overlay=new Map(this.liveOverlay(st.root) || []);
                overlay.set(file,impact.before);
                beforeSnapshot=snapshotSources(st.files,overlay);
            } catch (_) { /* unknown provenance still needs a build */ }
        }
        st.renderlessVersion=!impact.renderChanged ? {file,version:e.document.version} : null;
        if (origin === 'external-reload' && !e.document.isDirty) st.pendingOverlayVersions?.delete(file);
        else (st.pendingOverlayVersions ||= new Map()).set(file, e.document.version);
        st.sourceAhead = impact.renderChanged || wasAhead;
        st.lastEditAt = Date.now();
        st.lastEditOrigin = origin;
        if (impact.renderChanged) {
            st.sourceRevision = (st.sourceRevision || 0) + 1;
            st.renderlessSnapshots?.clear();
        } else if (beforeSnapshot) {
            const afterSnapshot=snapshotSources(st.files,this.liveOverlay(st.root));
            const aliases=st.renderlessSnapshots ||= new Map();
            const base=aliases.get(beforeSnapshot) || beforeSnapshot;
            aliases.set(afterSnapshot,base);
            if (aliases.size>64) {
                const key=st.generation?.sourceSnapshotHash, generationBase=aliases.get(key);
                aliases.clear(); aliases.set(afterSnapshot,base);
                if (generationBase) aliases.set(key,generationBase);
            }
        }
        impact.pendingRendering=st.sourceAhead;
        // A KEY KILLS THE BACKGROUND FULL BUILD. Its text is gone; the live
        // lane takes the key, and the next pause starts a full build of the
        // new text. A forced Compile is left to finish. A save's change
        // event (no content changes: only the dirty flag moved) is no key.
        if (impact.renderChanged && st.running && st.backgroundCompiling && !st.forcedCompiling && !st.externalCompiling && e.contentChanges?.length) {
            const running = st.running;
            st.running = null;
            st.runningSnapshot = null;
            st.compiling = false;
            st.liveCompiling = false;
            st.backgroundCompiling = false;
            running.abort();
            this.log(`background build of ${path.basename(this.rootFor(e.document))} dropped: typing`);
            this._emitter.fire(st);
        }
        if (st.nativeLane) {
            const lane = st.nativeLane;
            if (st.map?.native) st.map.noteEdit();
            lane.noteChange(e.document, e.contentChanges).then(() => {
                if (st.nativeLane === lane) this._scheduleNativeRefresh(st, lane);
            }).catch(async error => {
                if(supersededNativeWork(error)) {
                    if(st.nativeLane===lane)this._scheduleNativeRefresh(st,lane);
                    return;
                }
                this.log(`  native mapping: ${error.message}`);
                await this._retireNativeLane(st, lane, error.message);
            });
        }
        if (!st.map) return impact;
        for (const c of e.contentChanges) {
            const removed = c.range.end.line - c.range.start.line;
            const added = (c.text.match(/\n/g) || []).length;
            if (removed !== added) st.map.noteEdit(file, c.range.start.line + 1, added - removed);
        }
        return impact;
    }

    /**
     * A file we depend on changed outside the editor.
     *
     * The compile record keys off a hash of the sources, so it is ALREADY not
     * current — nothing needs tearing down. What this does is make the surfaces
     * notice now, instead of at the reader's next keystroke, so the gutter and
     * the status item stop asserting a position that was computed against
     * content nobody has any more.
     */
    invalidate(file) {
        _textCache.delete(file);
        const root = this.rootOf.get(file) || file;
        const st = this.roots.get(root);
        if (!st) return false;
        st.renderlessSnapshots?.clear(); st.renderlessVersion=null;
        st.sourceAhead = true;
        st.sourceRevision = (st.sourceRevision || 0) + 1;
        st.nativeLane?.invalidate();
        if (st.map?.native) st.map.noteEdit();
        this._emitter.fire(st);
        return true;
    }

    /** Binary assets are dependencies, never text overlays or review edits. */
    invalidateAsset(root, file) {
        const st = this.roots.get(root);
        if (!st) return false;
        st.assetFiles ||= new Set();
        st.assetFiles.add(file);
        return this.invalidate(root);
    }

    _assetFiles(st, generation = st.generation) {
        return [...new Set([...(st.assetFiles || []), ...(generation?.assetFiles || [])])].sort();
    }

    _assetsCurrent(st, generation = st.generation) {
        const files = this._assetFiles(st, generation);
        return !files.length || generation?.assetSnapshotHash === snapshotSources(files);
    }

    /**
     * Is this root's generation good enough for what is asking?
     *
     * A ONE-PASS BUILD DOES NOT SATISFY A SAVE. Its snapshot hash matches — the
     * bytes really are what was compiled — so the old test said "current" and
     * the save did nothing, leaving cross-references a pass behind for as long
     * as the reader kept typing.
     */
    isCurrent(st, snapshot, { authoritative = false } = {}) {
        const g = st.generation;
        if (!g || !g.sourceSnapshotHash) return false;
        if (!sameRenderedSource(st,g.sourceSnapshotHash,snapshot)) return false;
        if (!this._assetsCurrent(st, g)) return false;
        return generationSatisfies(g, { authoritative });
    }

    /**
     * Compile, or reuse the last generation if the sources have not moved.
     * Only one compile per root at a time; a second request cancels the first,
     * which is cheap (45-80 ms process-group kill, measured).
     */
    /**
     * `priority`: a build the reader waits for, as a Compile is (the glow,
     * nothing but another Compile aborts it), but on the paper's own lane —
     * WLaTeX's full build with its exact map, where `force` runs latexmk.
     * Going to an agent's change asks for one (TexViewer.compileForReview).
     */
    async build(doc, options = {}) {
        if (this._disposed) return;
        const root = this.rootFor(doc), st = this.roots.get(root);
        if (options.force || options.priority) this._externalBuilds.cancel(root);
        else if (!options.external && this._externalBuilds.has(root)) {
            this.scheduleExternal(doc);
            return st;
        }
        // Cover asynchronous engine preparation as well as the actual process:
        // a watcher must not supersede a manual Compile still opening its lane.
        const token = {};
        const work = this._buildWork.get(root) || new Set();
        this._buildWork.set(root, work); work.add(token);
        st.externalWork = token; st.externalCompiling = !!options.external;
        try { return await this._build(doc, options); }
        finally {
            work.delete(token);
            if (!work.size) this._buildWork.delete(root);
            if (st.externalWork === token) st.externalCompiling = false;
        }
    }

    async _build(doc, { force = false, firstPass = false, settleGeneration = null, live = false, authoritative = false, quiet = false, priority = false, external = false } = {}) {
        const waited = force || priority;
        if (this._disposed) return;
        const root = this.rootFor(doc);
        if (typeof doc.getText==='function') (this._sourceTexts ||= new Map()).set(doc.uri.fsPath,doc.getText());
        // A deliberate save/Compile supersedes the debounce which preceded it.
        // Leaving that timer armed lets it wake during the authoritative build
        // and abort the very compile the reader explicitly requested.
        if (!live) {
            const pending = this._liveTimers.get(root);
            if (pending) clearTimeout(pending);
            this._liveTimers.delete(root);
            this._liveFirst.delete(root);
        }
        const st = this.roots.get(root);
        const background = !waited && !!st.generation;
        const sourceRevision = st.sourceRevision || 0;
        const preparation = st.buildPreparation = (st.buildPreparation || 0) + 1;
        const preparing = () => !this._disposed && this.roots.get(root) === st && st.buildPreparation === preparation &&
            (!background || (st.sourceRevision || 0) === sourceRevision);
        const overlay = this.liveOverlay(root);
        // ONE snapshot per build. It used to be computed twice — here and again
        // inside compile() — which reads and hashes every source file twice per
        // keystroke pause, and let the two disagree if a file moved between them.
        const snapshot = snapshotSources(st.files, overlay);
        const assetFiles = this._assetFiles(st);
        const assetSnapshotHash = assetFiles.length ? snapshotSources(assetFiles) : null;
        // The viewer's Compile requests fresh output immediately; it need not
        // wait for reference convergence. Export/verification still request a
        // full build. `force` alone retains that full-build contract for tools.
        const wantFull = authoritative || (force && !firstPass);
        // THE ENGINE EMITS THE MAP (tex/glyphMap.js). `mapEngine` auto means:
        // build the WPaper view with lualatex + the wbmap hook when lualatex is
        // installed, so the render map is read off the engine rather than
        // inferred from SyncTeX. Decided up front, because a map that is NOT
        // exact while one is wanted — the cached generation of a pdflatex
        // compile from before the upgrade, or the reused record of a warm open —
        // must not count as current: it would keep answering with the old,
        // approximate geometry until the source happened to change.
        const cfg0 = vscode.workspace.getConfiguration('wolfbook.tex');
        let mapEngine = cfg0.get('mapEngine', 'auto');
        // WLaTeX Pro switched off from its badge: WPaper exactly as without
        // WLaTeX (the ordinary map engine; no live pages, no page typing).
        if (this.proDisabled && mapEngine === 'wlatex') mapEngine = 'auto';
        const nativeDirectory = cfg0.get('wlatexDirectory', '') || process.env.WLATEX_HOME || '';
        // An unreleased optional engine must be invisible when absent, even
        // with a stale opt-in setting or a paper requesting another engine.
        if (mapEngine === 'wlatex' && !hasNativeRuntime(nativeDirectory)) {
            mapEngine = 'auto';
            st.nativeUnavailable = 'Optional runtime absent; using the normal WPaper compiler.';
            if (st.nativeLane) {
                await this._retireNativeLane(st, st.nativeLane);
                if (!preparing()) return st;
            }
        }
        if (force) st.nativeRefusedSnapshot = null;
        // A SETTLED NATIVE BUILD IS AUTHORITATIVE. Saves and the convergence
        // timer stay on the native lane, which runs the auxiliary passes and
        // the BibTeX, biber, index and glossary tools itself. latexmk runs
        // for an explicit Compile, or when the native build of these very
        // sources left a tool pending (`rerunWanted`).
        const nativeUnsettled = st.generation?.runner === 'wlatex' && st.generation.rerunWanted &&
            st.generation.sourceSnapshotHash === snapshot;
        // Settle with the producer of the first PDF. Switching a manual
        // pdfLaTeX preview to WLaTeX here changes its layout, rather than just
        // resolving its references, and discards the useful auxiliary files.
        const settleConventional = settleGeneration?.runner === 'latexmk';
        let wantNative = mapEngine === 'wlatex' && !force && !settleConventional && !(authoritative && nativeUnsettled);
        // A PAPER WRITTEN FOR ANOTHER ENGINE. `% !TEX program = pdflatex`
        // says so outright; a paper that failed natively but built with the
        // configured compiler (`\pdfoutput`, luacode) proved it. A declared
        // engine holds until its preamble changes; a comparison holds only
        // for the exact text compared, so a repaired body can recover Pro.
        const hints = paperEngineHints(root, overlay, cfg0.get('engine', 'pdflatex'));
        if (st.nativeIncompatible && (st.nativeIncompatible.preamble !== hints?.preamble ||
            st.nativeIncompatible.snapshot !== snapshot)) st.nativeIncompatible = null;
        if (st.nativeIncompatibleTried && st.nativeIncompatibleTried !== snapshot) st.nativeIncompatibleTried = null;
        // The writer chose WLaTeX for this preamble anyway (see _noticeNativeOff).
        const overridden = !!hints?.preamble && st.nativeOverride === hints.preamble;
        const intent = mapEngine === 'wlatex' && hints?.intent && !['xelatex', 'xetex'].includes(hints.intent.program) && !overridden ? hints.intent : null;
        const where = intent ? `${intent.why}${intent.line ? `, line ${intent.line}` : ''}` : '';
        st.nativeOff = intent ? (intent.why.startsWith('% !TEX') ? `the paper asks for ${intent.program} (${where})`
            : `the paper is written for ${intent.program} (${where})`) : st.nativeIncompatible?.reason || null;
        // The conventional build then uses the engine the paper is written
        // for, whatever `wolfbook.tex.engine` says.
        st.nativeOffEngine = intent && ['pdflatex', 'lualatex'].includes(intent.program) ? intent.program : null;
        // Shown, not declared: the writer may choose WLaTeX anyway (chooseNative).
        st.nativeOffChoosable = !!intent && !intent.why.startsWith('% !TEX');
        if (wantNative && st.nativeOff) {
            if (st.nativeOffLogged !== st.nativeOff) {
                this.log(`WLaTeX not used: ${st.nativeOff}`);
                st.nativeOffLogged = st.nativeOff;
                this._noticeNativeOff(root, st.nativeOff, st.nativeOffEngine || cfg0.get('engine', 'pdflatex'),
                    intent ? { intent, st, preamble: hints.preamble } : null);
            }
            wantNative = false;
            // A pdfLaTeX paper is built with pdflatex (SyncTeX), not
            // LuaLaTeX's exact map: the PDF is the one its author gets.
            mapEngine = st.nativeOffEngine === 'pdflatex' ? 'off' : 'auto';
            // THE LANE GOES WITH IT. Left attached, every later build was a
            // pdflatex generation "on the lane", which the Pro badge can only
            // read as `settling` — it spun for the rest of the session.
            if (st.nativeLane) {
                await this._retireNativeLane(st, st.nativeLane);
                if (!preparing()) return st;
            }
        }
        if (wantNative && st.nativeRefusedSnapshot === snapshot && st.nativeRefusedDirectory === nativeDirectory) {
            wantNative = false;
            mapEngine = 'auto';
        }
        if (wantNative) {
            const directory = nativeDirectory;
            try {
                if (!st.nativeLane || st.nativeLane.directory !== directory) {
                    if (st.nativeLane) await this._retireNativeLane(st, st.nativeLane);
                    if (!preparing()) return st;
                    // A licence refusal holds until a licence is entered;
                    // asking the engine again at every build would only
                    // cost the build time.
                    if (this._licenseRefused) throw this._licenseRefused;
                    st.nativeLane = new NativeBuildLane(root, directory);
                    const license = st.nativeLane.license;
                    if (license?.required && license.state === 'trial' && license.days_left <= 7)
                        this._noticeNativeLane(`WLaTeX trial: ${license.days_left} day${license.days_left === 1 ? '' : 's'} left.`, true);
                    // Start the incremental engine now, so the first keystroke
                    // already previews instead of only asking for the engine.
                    if (typeof st.nativeLane.warmInteractive === 'function') st.nativeLane.warmInteractive();
                    this._previewFirstOpen(root, st);
                    const runtime = st.nativeLane.runtime;
                    if (runtime) this.log(`WLaTeX lane: ${runtime.labBinary}` +
                        (runtime.installed ? '' : ' (development checkout, newest build)'));
                }
                st.nativeUnavailable = null;
            } catch (error) {
                const reason = `WLaTeX unavailable: ${error.message}. Using the normal WPaper compiler.`;
                if (error?.code === 'WLATEX_LICENSE') this._licenseRefused = error;
                if (st.nativeUnavailable !== reason) this.log(reason);
                st.nativeUnavailable = reason;
                // Keep startup diagnostics in the log; no unreleased-engine popup.
                wantNative = false;
                mapEngine = 'auto';
            }
        }
        if ((cfg0.get('mapEngine', 'auto') !== 'wlatex' || this.proDisabled) && st.nativeLane) {
            await this._retireNativeLane(st, st.nativeLane);
            if (!preparing()) return st;
        }
        if (mapEngine === 'auto') {
            if (this._luaOk == null) this._luaOk = await probeLualatex();
        }
        if (!preparing()) return st;
        // An automatic LuaLaTeX map must not override a XeLaTeX font setup
        // or a paper's explicit pdfLaTeX declaration.
        const wantGlyphMap = settleConventional ? !!settleGeneration.glyphMapPath : (mapEngine === 'lualatex' ||
            (hints?.engine !== 'xelatex' && !['pdflatex', 'pdftex'].includes(hints?.program))) && shouldUseGlyphMap({
            mapEngine,
            luaOk: !!this._luaOk,
            force,
            snapshot,
            refusedSnapshot: st.glyphMapRefused,
        });
        const mapIsStale = (wantGlyphMap && st.map && !st.map.exact) ||
            (wantNative && (!st.map?.native || !st.map.available)) || (!wantNative && st.map?.native);
        if (!force && !mapIsStale && this.isCurrent(st, snapshot, { authoritative: wantFull }) && st.map) {
            // The reader may have typed and undone back to the exact compiled
            // bytes. No process needs to run, but the viewer still needs the
            // state transition that lets tracing wake up again.
            if (st.sourceAhead) {
                st.sourceAhead = false;
                this._emitter.fire(st);
            }
            return st;
        }

        // A COMPILE ALREADY DONE IS NOT WORTH DOING AGAIN.
        //
        // The out dir survives a VS Code restart with its PDF and .synctex.gz
        // intact; only the in-memory record was lost, so reopening a paper paid
        // the whole compile again for a byte-identical result. Restoring the
        // record makes a warm open instant instead.
        if (!force && !st.generation) {
            const cached = loadGeneration(root, { sourceFiles: st.files, overlay });
            // A cached generation without the glyph map is not the one we want
            // when the engine can emit one: compile instead of reviving it.
            if (cached && this._assetsCurrent(st, cached) && !wantNative && !(wantGlyphMap && !cached.glyphMapPath)) {
                st.generation = cached;
                st.map = makeMap({
                    generation: cached,
                    model: this._modelFor(root),
                    pageSize: this._pageSize(cached),
                });
                st.lastError = null;
                st.dependencyIssue = null;
                st.sourceAhead = false;
                this.log(`reused the previous compile of ${path.basename(root)} ` +
                    `(${cached.pageCount ?? '?'} pages, nothing changed)`);
                this._emitter.fire(st);
                return st;
            }
        }

        // A LIVE BUILD DOES NOT KILL ANOTHER LIVE BUILD.
        //
        // Every new build used to abort the one in flight. On a paper whose
        // rebuild takes longer than the pause that triggers it — measured at
        // 1.4 s against a 900 ms debounce on the real one — that means a reader
        // typing in ordinary bursts can throw away build after build and see
        // the page update rarely or never. The work was being done and then
        // discarded a moment before it finished, and it gets worse as the
        // paper grows, which is exactly how "the live render is getting slow"
        // feels from the outside.
        //
        // So a live rebuild arriving while another live one is running just
        // asks for another round when that one lands. Only ONE is ever
        // pending — the newest text wins — and a deliberate build (a save, the
        // Compile button, the convergence pass) still takes precedence and
        // aborts, because the reader asked for it now.
        //
        // THE COMPILE BUTTON HAS TOP PRIORITY. A forced build is what the
        // reader asked for and waits for: nothing but another Compile aborts
        // it. A live settle or a save arriving meanwhile goes round once it
        // lands (the save's text, when it is the one being compiled, needs
        // nothing more).
        //
        // A SAVE OF THE TEXT BEING BUILT LETS THAT BUILD LAND. The viewer
        // auto-saves 3 s after the last key, half a second into the 2.5 s
        // pause's full build of those very buffers: aborting it to start the
        // same build over threw the work away and showed nothing for twice
        // as long.
        if (st.running) {
            if (st.forcedCompiling && !waited) {
                if (live || st.runningSnapshot !== snapshot) st.liveQueued = true;
                this.log(`${live ? 'live rebuild' : 'build'} of ${path.basename(root)} waits for the Compile already running`);
                return st;
            }
            if (live && st.liveCompiling) {
                st.liveQueued = true;
                this.log(`live rebuild of ${path.basename(root)} queued behind the one already running`);
                return st;
            }
            if (!live && !force && st.backgroundCompiling && st.runningSnapshot === snapshot) {
                this.log(`save of ${path.basename(root)}: the build already running has this text`);
                return st;
            }
            st.running.abort();
        }
        const ac = new AbortController();
        st.running = ac;
        st.runningSnapshot = snapshot;
        st.compiling = true;
        // A live rebuild is background work: the previous PDF stays on screen
        // and the panel shows a quiet marker, rather than the blocking
        // "compiling…" banner a deliberate Compile deserves.
        st.liveCompiling = live;
        st.forcedCompiling = waited;
        // Automatic builds on either engine keep the existing paper visible
        // without a blue shade; the next key kills them (noteChange). Only
        // a deliberate Compile/priority request or first open glows.
        st.backgroundCompiling = background;
        this._emitter.fire(st);

        const t0 = Date.now();
        this.log(`compile ${path.basename(root)} …`);
        // Progress, because a first compile is seconds of nothing otherwise.
        // A LIVE rebuild is deliberately silent: it fires while you type, and a
        // notification per pause would be intolerable.
        let progress = null;
        let progressDone = null;
        if (!live && !quiet && !st.backgroundCompiling) {
            const ready = new Promise(r => { progressDone = r; });
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `WPaper: compiling ${path.basename(root)}`,
                cancellable: true,
            }, (p, token) => {
                progress = p;
                token.onCancellationRequested(() => ac.abort());
                return ready;
            });
        }
        const note = (msg) => { try { if (progress) progress.report({ message: msg }); } catch (_) { /* gone */ } };
        try {
            const cfg = vscode.workspace.getConfiguration('wolfbook.tex');
            // Publish the first usable PDF before settling its references.
            // Viewer Compile explicitly asks for this; typing can opt out via
            // liveSinglePass. Only a limited/unsettled result arms the quiet
            // follow-up below. Export and verification always settle in place.
            const capWanted = !wantFull && !wantNative &&
                (firstPass || (live && cfg.get('liveSinglePass', true)));
            if (capWanted && this._capOk === null) {
                this._capOk = await probeInitCode(MAX_PASSES_CODE(1));
                if (!this._capOk) this.log('  latexmk refused the pass cap — builds stay full');
            }
            const compileOpts = {
                root,
                sourceFiles: st.files,
                sourceSnapshotHash: snapshot,
                // AN AUTHORITATIVE BUILD MUST ACTUALLY RUN. The sources have
                // not changed since the capped build it is correcting, so
                // latexmk would say "nothing to do" and leave the unresolved
                // references exactly where they were.
                force: !!force || wantFull,
                overlay,
                signal: ac.signal,
                timeoutMs: cfg.get('compileTimeoutMs', 180000),
                // Pages the native map materializes first (the viewer's window).
                nativePages: this._nativeWindow(st),
                // The skeleton only has to be walked when it might have changed.
                mirror: live ? 'auto' : 'always',
                engine: (settleConventional && settleGeneration.engine) || st.nativeOffEngine || hints?.engine || cfg.get('engine', 'pdflatex'),
                onLog: (l) => {
                    const run = /^Latexmk: Run number (\d+)/.exec(l);
                    if (run) { note(`pass ${run[1]}`); return; }
                    const pg = /\[(\d+)[\s{]/.exec(l);
                    if (pg) note(`page ${pg[1]}`);
                },
            };
            // THE ENGINE EMITS THE MAP (tex/glyphMap.js). `mapEngine` auto
            // means: build the WPaper view with lualatex + the wbmap hook when
            // lualatex is installed, so the render map is read off the engine
            // rather than inferred from SyncTeX. A document lualatex cannot
            // build falls back to the configured engine below, flagged.
            const primaryOpts = wantGlyphMap
                ? { ...compileOpts, engine: 'lualatex', glyphMap: true }
                : compileOpts;
            let gen;
            if (wantNative) {
                const lane = st.nativeLane;
                // THE PREVIEW DRAWS BEFORE THE BUILD RUNS.
                //
                // The incremental engine can put the pages an edit touched on
                // screen in tens of milliseconds, while a cold build of a real
                // paper is seconds away. It runs here, on the same typing
                // pause the cold build below runs on, and its pages are drawn
                // as overlays over the PDF canvases. The cold build then does
                // everything it did before — the PDF, the source map, the
                // diagnostics, settlement — and its PDF replaces the overlays.
                //
                // It is only ever a preview, so it is only ever run for a LIVE
                // rebuild (a save or a Compile wants the real thing), and a
                // failure of it is never a failure of the lane: it is logged
                // and this keystroke falls back to exactly the old behaviour.
                // The live preview is not run here any more: it follows every
                // keystroke on its own schedule (_schedulePreview), so this
                // build only settles.
                try {
                    gen = await lane.compile(compileOpts);
                    st.nativeRefusedSnapshot = null;
                    if (gen?.ok) this._warmLiveAfterSettle(root, st, lane);
                } catch (error) {
                    if (ac.signal.aborted || ['AbortError', 'StaleBuild'].includes(error?.name)) throw error;
                    // A TeX error in the document resolves as a failed
                    // generation above and keeps the lane; reaching here means
                    // the producer, worker or installation failed.
                    this.log(`WLaTeX preview failed: ${error.message}. Trying the configured WPaper compiler.`);
                    await this._retireNativeLane(st, lane, error.message);
                    st.nativeRefusedSnapshot = snapshot;
                    st.nativeRefusedDirectory = nativeDirectory;
                    gen = await compile({ ...compileOpts, maxPasses:null });
                }
                // Register packages discovered outside the editor's include
                // graph so subsequent dirty buffers and file events reach us.
                for (const file of gen.nativeCompiledSources?.keys() || []) {
                    if (!st.files.includes(file)) st.files.push(file);
                    this.rootOf.set(file, root);
                }
                if (gen.nativeCompiledSources) gen.sourceSnapshotHash = snapshotSources(st.files,
                    new Map([...(overlay || []), ...gen.nativeCompiledSources]));
                // A PDF is best-effort output, not proof of error-free TeX.
                // Only a clean comparison of this SAME frozen text can
                // disable Pro, and only until that text changes. A half-typed
                // formula both engines reject keeps its live lane.
                if (!gen.ok && gen.errors > 0 && !ac.signal.aborted && hints?.preamble &&
                    st.nativeIncompatibleTried !== snapshot && (st.sourceRevision || 0) === sourceRevision) {
                    const conventional = await compile({ ...compileOpts, maxPasses: null });
                    const clean = conventional.ok && !conventional.cancelled && !conventional.stopped && !conventional.timedOut &&
                        conventional.logWritten !== false &&
                        !(conventional.errors > 0) && !conventional.diagnostics?.some(d => d.severity === 'error');
                    const current = !ac.signal.aborted && (st.sourceRevision || 0) === sourceRevision &&
                        snapshotSources(st.files, this.liveOverlay(root)) === (gen.sourceSnapshotHash || snapshot);
                    if (current) st.nativeIncompatibleTried = snapshot;
                    if (clean && current) {
                        const first = gen.diagnostics?.find(d => d.severity === 'error')?.message || 'a document error';
                        st.nativeIncompatible = { preamble: hints.preamble, snapshot,
                            reason: `WLaTeX (XeTeX) cannot build this paper with the current text; ${compileOpts.engine} builds it without errors (${first})` };
                        st.nativeOff = st.nativeIncompatible.reason;
                        this.log(`  ${st.nativeIncompatible.reason} — retrying WLaTeX when the text changes`);
                        st.nativeOffLogged = st.nativeOff;
                        this._noticeNativeOff(root, st.nativeOff, compileOpts.engine);
                        gen = conventional;
                    }
                }
            } else gen = await compile({
                ...primaryOpts,
                maxPasses: (capWanted && this._capOk) ? 1 : null,
            });
            // latexmk could not run our initialisation code after all. Retry
            // once uncapped and never ask again this session.
            if (gen.rcUnsupported) {
                this.log('  latexmk rejected the pass cap — rebuilding without it');
                this._capOk = false;
                gen = await compile({ ...primaryOpts, maxPasses: null });
            }
            const glyphPrimary = wantGlyphMap ? gen : null;
            let glyphFallback = null;
            // lualatex could not build this document at all (no PDF): rebuild
            // with the engine the user configured. Only a SUCCESSFUL fallback
            // proves that this particular source snapshot needs it. A failure
            // in both engines is usually a half-typed construct and must never
            // disable the exact map for the rest of the session.
            if (wantGlyphMap && !gen.ok && !gen.cancelled && !ac.signal.aborted &&
                primaryOpts.engine !== compileOpts.engine) {
                // Not "unknown reason": we are holding the exit code.
                this.log(`  lualatex produced no PDF (${gen.stopReason
                    || (gen.logWritten === false ? `exited ${describeExit(gen.exit)}, no log written`
                                                 : `${gen.errors} error(s) in the log`)}) — trying ${compileOpts.engine}`);
                glyphFallback = await compile({ ...compileOpts, maxPasses: null });
                gen = glyphFallback;
            }
            if (ac.signal.aborted) { this.log('  cancelled'); return st; }
            const refusedSnapshot = glyphMapBackoff({
                snapshot, primary: glyphPrimary, fallback: glyphFallback,
            });
            if (refusedSnapshot) {
                st.glyphMapRefused = refusedSnapshot;
                if (glyphPrimary && glyphPrimary.ok) {
                    this.log('  the wbmap hook produced no glyph map — using SyncTeX until the source changes or Compile is pressed');
                } else {
                    this.log(`  ${compileOpts.engine} succeeded — using its approximate map until the source changes or Compile is pressed`);
                }
            } else if (glyphPrimary && glyphPrimary.ok && glyphPrimary.glyphMapPath) {
                st.glyphMapRefused = null;
            }
            // A NATIVE MAP IS BUILT BEFORE ANYTHING IS ASSIGNED, in slices
            // (makeMapAsync), so the generation and its map change together.
            let prebuilt = null;
            if (gen.nativeView && gen.nativeSource) {
                try { prebuilt = await makeMapAsync({ generation: gen, model: this._modelFor(root), pageSize: this._pageSize(gen) }); }
                catch (_) { prebuilt = null; /* makeMap below throws it again, as before */ }
                if (ac.signal.aborted) { this.log('  cancelled'); return st; }
            }
            let currentSnapshot = null;
            // Capture the assets from before the build, not after it: an image
            // changed mid-build must not make an older PDF look current.
            gen.assetFiles = assetFiles;
            gen.assetSnapshotHash = assetSnapshotHash;
            const assetsCurrent = this._assetsCurrent(st, gen);
            try { currentSnapshot = snapshotSources(st.files, this.liveOverlay(root)); }
            catch (_) { currentSnapshot = null; }
            // Git can deliver the clean-buffer reload after the disk watcher
            // already captured those exact bytes. Its revision bump is not a
            // reason to throw away a completed batch and compile it again.
            const sameExternalSource = external && sameRenderedSource(st,gen.sourceSnapshotHash,currentSnapshot) && assetsCurrent;
            if (background && (((st.sourceRevision || 0) !== sourceRevision && !sameExternalSource) ||
                gen.ok && (!sameRenderedSource(st,gen.sourceSnapshotHash,currentSnapshot) || !assetsCurrent))) {
                st.sourceAhead = true;
                this.log('  background result dropped: source changed');
                return st;
            }
            const diagnosticRevision = sameExternalSource ? st.sourceRevision || 0 : sourceRevision;
            if ((st.sourceRevision || 0) === diagnosticRevision && gen.sourceSnapshotHash === currentSnapshot) {
                st.compileDiagnostics = { revision:diagnosticRevision, at:Date.now(),
                    sequence:st.diagnosticsSequence = (st.diagnosticsSequence || 0) + 1, list:gen.diagnostics || [] };
            }
            if ((st.sourceRevision || 0) === diagnosticRevision && gen.sourceSnapshotHash === currentSnapshot) {
                const problem = gen.diagnostics?.find(d => d.severity === 'error');
                st.livePreviewError = problem ? { revision:diagnosticRevision,
                    reason:`${problem.line ? `Line ${problem.line}: ` : ''}${problem.message}` } : null;
                this._clearPreviewRecovery(root);
            }
            const prevGen = st.generation;
            // prevMap and map may now SHARE one parsed SyncTeX doc. That is
            // safe because the doc is never mutated after construction — the
            // only mutation in RenderMap is the overlay remap, which the reuse
            // path skips — and prevMap is read only by diffAgainst.
            const prevDoc = st.map && st.map.doc;
            const model = this._modelFor(root);
            // The parsed GlyphMap is reused the same way when its bytes did
            // not move (glyphMapHash): a rebuild that ships nothing new costs
            // no re-parse either.
            const prevGlyph = st.map && st.map.gm;
            const keepNativeOutput = !gen.ok && !gen.pdfPath && !!st.nativeLane &&
                prevGen?.runner === 'wlatex' && !!prevGen.pdfPath;
            if (keepNativeOutput) {
                // A native or explicit conventional TeX error must not erase
                // the live worker's last artifact or editable provenance. These bytes
                // still describe the previous source snapshot: never label
                // them current, successful, or verified merely because they
                // remain on screen. Keep the failed report for inspection.
                st.generation = { ...prevGen, ok:false, diagnostics:gen.diagnostics,
                    errors:gen.errors, warnings:gen.warnings, stopped:gen.stopped,
                    stopReason:gen.stopReason, logPath:gen.logPath, ms:gen.ms,
                    finishedAt:gen.finishedAt, failedBuild:gen };
                if (st.nativeLane) this._scheduleNativeRefresh(st, st.nativeLane);
            } else {
                st.prevMap = st.map;
                st.generation = gen;
                st.map = prebuilt || makeMap({
                    generation: gen,
                    model,
                    pageSize: this._pageSize(gen),
                    synctexDoc: (prevDoc && synctexUnchanged(prevGen, gen)) ? prevDoc : null,
                    glyphDoc: (prevGlyph && prevGen && gen.glyphMapHash && prevGen.glyphMapHash === gen.glyphMapHash) ? prevGlyph : null,
                });
            }
            st.dependencyIssue = gen.dependencyIssue || null;
            // A compile can finish while the reader is still typing. Resume
            // tracing only when the generation describes the bytes that are
            // current NOW, not merely those captured when this run started.
            // Failed/unavailable builds never make an old page current.
            st.sourceAhead = !(gen.ok && gen.pdfPath && gen.sourceSnapshotHash &&
                sameRenderedSource(st,gen.sourceSnapshotHash,currentSnapshot) && assetsCurrent);
            if (st.map.exact) this.log(st.map.native ? '  render map: native provenance' : '  render map: exact (GlyphMap)');
            // The preview shows this. "compile produced no PDF" sent a user round
            // the same loop; name the launch failure instead when that is what it is.
            st.lastError = gen.dependencyIssue?.summary || (gen.ok ? null
                : gen.stopReason
                || (gen.logWritten === false
                    ? `latexmk exited ${describeExit(gen.exit)} without running — see the WPaper output channel`
                    : 'compile produced no PDF'));
            if (gen.dependencyIssue) this._reportDependencyIssue(gen.dependencyIssue);
            saveGeneration(gen);
            // Tune the debounce to what this paper actually costs. gen.ms, not
            // the wall time: queue time is an artefact of the previous build,
            // and feeding it back would inflate the wait that caused it.
            if (live && gen.ok && !gen.cancelled) st.liveMsEwma = blendLiveMs(st.liveMsEwma, gen.ms);
            // "0 error(s)" IS A CLAIM ABOUT THE DOCUMENT, so only make it when
            // a log was actually read. A compile that died before LaTeX started
            // has no error count — it has no evidence at all (issue #21).
            const counts = (gen.ok || gen.logWritten !== false)
                ? `${gen.errors} error(s) · ${gen.warnings} warning(s) · `
                : 'no log written · ';
            this.log(`  ${gen.ok ? 'ok' : 'FAILED'} · ${gen.pageCount ?? '?'} pages · ` +
                counts +
                `${gen.passes ?? '?'} pass(es)${gen.passesLimited ? ' (capped)' : ''}` +
                `${gen.runner === 'wlatex' ? (gen.rerunWanted ? ' (WLaTeX; references pending)' : ' (WLaTeX)')
                    : gen.rerunWanted ? ' (cross-references one pass behind)' : ''} · ` +
                `${gen.ms} ms${gen.queuedMs ? ` (+${gen.queuedMs} ms queued)` : ''} · ` +
                `${Date.now() - t0} ms total`);
            if (!gen.ok && gen.stopReason) this.log(`  stopped: ${gen.stopReason}`);
            // Everything the process told us that we used to discard.
            for (const line of describeCompileFailure(gen)) this.log(`  ${line}`);
            // A BUILD THAT LEFT SOMETHING BEHIND SCHEDULES ITS OWN CORRECTION,
            // even if the reader types nothing more — which is the case that
            // matters for a new \label: it is typed once and then the reader
            // just LOOKS at the `??` on the page waiting for it to resolve.
            if (gen.passesLimited || gen.rerunWanted) {
                this._armAuthoritative(root, nextLiveDelayMs({
                    lastMs: st.liveMsEwma,
                    ceilingMs: Math.max(200, cfg.get('liveRenderDelayMs', 900)),
                }));
            }
        } catch (e) {
            if (ac.signal.aborted || ['AbortError', 'StaleBuild', 'Cancelled'].includes(e?.name)) {
                this.log('  Build superseded');
            } else {
                st.lastError = e && e.message ? e.message : String(e);
                this.log(`  ERROR ${st.lastError}`);
                if (!wantNative && /ENOENT/.test(st.lastError)) {
                    st.lastError = 'latexmk not found on PATH — install TeX Live, or set wolfbook.tex.compile to "off"';
                }
            }
        } finally {
            if (progressDone) progressDone();
            if (st.running === ac) {
                st.compiling = false;
                st.liveCompiling = false;
                st.forcedCompiling = false;
                st.backgroundCompiling = false;
                st.running = null;
                st.runningSnapshot = null;
            }
            if (!this._disposed) this._emitter.fire(st);
        }
        // Somebody typed while this was running. Go round again — but on the
        // COOLDOWN, not the ordinary debounce.
        //
        // The ordinary one is a ceiling by design, so a paper that takes longer
        // to build than that ceiling would fire again almost as soon as it
        // landed and spend most of its wall-clock compiling. Reported as the
        // editor lagging with "a long queue of compilations" behind it: the
        // queue is only ever one deep, but a latexmk running two thirds of the
        // time feels exactly like a queue. The first pause after typing keeps
        // the ceiling and stays responsive; only this path backs off.
        if (st.liveQueued && !this._disposed) {
            st.liveQueued = false;
            const cfg = vscode.workspace.getConfiguration('wolfbook.tex');
            const wait = cooldownDelayMs({
                lastMs: st.liveMsEwma,
                ceilingMs: Math.max(200, cfg.get('liveRenderDelayMs', 900)),
            });
            try { this.scheduleLive(doc, wait); } catch (_) { /* the next keystroke will */ }
        }
        return st;
    }

    _reportDependencyIssue(issue) {
        if (!issue || this._reportedDependencyIssues.has(issue.key)) return;
        this._reportedDependencyIssues.add(issue.key);
        const help = formatDependencyHelp(issue);
        if (help) this.output.appendLine(help);
        const show = 'Show setup instructions';
        const open = 'Open setup page';
        Promise.resolve(vscode.window.showErrorMessage(
            `WPaper setup required: ${issue.summary}`,
            show, open,
        )).then((pick) => {
            if (pick === show) this.output.show(true);
            if (pick === open && issue.helpUrl) vscode.env.openExternal(vscode.Uri.parse(issue.helpUrl));
        }).catch(() => { /* a setup hint must never break compiling */ });
    }

    _modelFor(root) {
        for (const d of vscode.workspace.textDocuments) {
            if (d.uri.fsPath === root) return this.projection.get(d).model;
        }
        return null;
    }

    /** Page geometry from the PDF, so a non-A4 class is not silently assumed. */
    _pageSize(gen) {
        // The compile already read it out of the buffer it had open. The read
        // below stays for generations restored from an older record.
        if (gen && gen.pageSize && gen.pageSize.widthBp > 0) return gen.pageSize;
        try {
            const fs = require('fs');
            const buf = fs.readFileSync(gen.pdfPath);
            const s = buf.toString('latin1', 0, Math.min(buf.length, 200000));
            const m = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(s);
            if (m) {
                return { widthBp: Number(m[3]) - Number(m[1]), heightBp: Number(m[4]) - Number(m[2]) };
            }
        } catch (_) { /* fall through */ }
        return { widthBp: 595.276, heightBp: 841.89 };
    }

    log(msg) {
        if (this.output) this.output.appendLine(msg);
        appendTimingLog(msg);
    }
}

// --- the three surfaces -----------------------------------------------------

/** `p.4 ▰▰▰▰▱ equation · fresh` in the status bar, following the cursor. */
/**
 * The timing log, in the system temp dir — deliberately NOT in the workspace.
 *
 * The workspace here is a Dropbox folder, and a log file that syncs on every
 * line is both slow and noise in someone's file history. This is diagnostic
 * output: it belongs somewhere disposable, and it survives a window reload so a
 * slow first load can be read back after the fact.
 */
const TIMING_LOG = path.join(os.tmpdir(), 'wolfbook-tex', 'timing.log');

function appendTimingLog(msg) {
    try {
        fs.mkdirSync(path.dirname(TIMING_LOG), { recursive: true });
        // Keep it from growing without bound across sessions.
        try { if (fs.statSync(TIMING_LOG).size > 1_000_000) fs.rmSync(TIMING_LOG); } catch (_) { /* new */ }
        fs.appendFileSync(TIMING_LOG, `${new Date().toISOString()}  ${msg}\n`);
    } catch (_) { /* diagnostics must never break the feature */ }
}

function makeStatusItem(coord, projection) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    item.command = 'wolfbook.tex.compile';

    const update = () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed || !/\.tex$/i.test(ed.document.uri.fsPath)) { item.hide(); return; }
        const st = coord.stateFor(ed.document);
        if (st && st.compiling && !st.liveCompiling) {
            item.text = '$(sync~spin) compiling…';
            item.tooltip = 'WPaper is compiling this paper';
            item.show();
            return;
        }
        if (st && st.sourceAhead && st.livePreviewAt >= (st.lastEditAt || Infinity) &&
            (st.livePreviewRevision ?? 0) === (st.sourceRevision || 0)) {
            const t = st.livePreviewStats || {};
            const ms = v => (v == null ? '?' : `${Math.round(v)} ms`);
            // WLaTeX Pro, and how long the last key took to reach the page.
            item.text = `$(zap) WLaTeX Pro · live${t.sinceKeyMs != null ? ` ${ms(t.sinceKeyMs)}` : ''}` +
                `${st.liveCompiling || st.authoritativeRunning ? ' $(sync~spin)' : ''}`;
            item.tooltip = 'WLaTeX Pro: the page shows your latest text (live preview); click-to-source works on it. ' +
                'The PDF settles when typing pauses.' +
                `\n\nLast preview: first changed page after ${ms(t.firstChangedMs)}, ` +
                `${t.recomputed ?? '?'} page(s) recomputed, ${t.reused ?? '?'} reused, ${ms(t.totalMs)} in the engine; ` +
                `${ms(t.sinceKeyMs)} from the keystroke to the finished preview.`;
            item.show();
            return;
        }
        if (st && st.sourceAhead) {
            item.text = `$(history) page behind${st.liveCompiling || st.authoritativeRunning ? ' $(sync~spin)' : ''}`;
            item.tooltip = 'The WPaper page is behind the editor. Tracing is paused until the matching compile is visible.';
            item.show();
            return;
        }
        // A live rebuild is not an event the writer asked for, so it must not
        // take over the status item: the position readout stays, and the spin
        // is appended. Falling through here is deliberate.
        // Say which engine made the page on screen: a native WLaTeX preview
        // and a latexmk build look the same in the viewer, and the lane can
        // fall back between builds.
        const gen = st && st.generation;
        const nativeGen = !!gen && gen.runner === 'wlatex';
        const engineIcon = nativeGen ? '$(zap) Pro ' : '';
        const engineNote = !gen ? '' : nativeGen
            ? `\n\nRendered by **WLaTeX Pro** (native build${gen.rerunWanted ? ', a tool still pending' : ', settled'}).`
            : `\n\nRendered by ${gen.runner || 'latexmk'}${gen.engine ? ` (${gen.engine})` : ''}.`;
        const map = st && st.map;
        if (!map || !map.available) {
            item.text = `${engineIcon}$(circle-slash) no render map`;
            item.tooltip = new vscode.MarkdownString(
                (st && st.lastError ? `**${st.lastError}**\n\n` : '') +
                'Click to compile this paper and build the render map.' + engineNote);
            item.show();
            return;
        }

        // The background full rebuild borrows the same quiet spinner the live
        // rebuild earned: it is background work either way, and the position
        // readout is what the item is for.
        const live = st && (st.liveCompiling || st.authoritativeRunning) ? ' $(sync~spin)' : '';
        const line = ed.selection.active.line + 1;
        const file = ed.document.uri.fsPath;
        const r = map.sourceToRender(file, line);
        const { model } = projection.get(ed.document);
        const obj = model.objects.filter(o =>
            o.sourceRange.startLine <= line && o.sourceRange.endLine >= line &&
            !['label', 'ref', 'cite', 'include'].includes(o.kind))
            .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
                (b.sourceRange.endLine - b.sourceRange.startLine))[0];

        if (r.page == null) {
            item.text = `$(circle-slash) p.? ${obj ? shortKind(obj) : ''}`.trim();
            item.tooltip = new vscode.MarkdownString(
                `No render position for line ${line}.\n\n_${r.reason || 'unmapped'}_`);
            item.show();
            return;
        }
        const occ = map.pageOccupancy(r.page);
        const bars = '▰'.repeat(occ.bars) + '▱'.repeat(5 - occ.bars);
        item.text = `${engineIcon}${FLAG_ICON[r.flag] || ''} p.${r.page} ${bars}${obj ? ' ' + shortKind(obj) : ''}` + live;
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**Page ${r.page}** of ${map.pageCount}  ·  ${Math.round(occ.fill * 100)}% full\n\n`);
        if (obj) md.appendMarkdown(`\`${obj.stableKey}\`\n\n`);
        md.appendMarkdown(`Position is **${FLAG_WORD[r.flag]}**`);
        if (r.flag === FLAG.PROBABLY_CURRENT) {
            md.appendMarkdown(r.exact === false && r.matchedLine !== line
                ? ` — nearest record is line ${r.matchedLine}.`
                : ' — the source moved since the last compile.');
        } else if (r.flag === FLAG.FRESH) {
            md.appendMarkdown('.');
        }
        // Say so when the ink is current but the numbering may not be.
        if (st && st.generation && st.generation.passesLimited) {
            md.appendMarkdown('\n\nTypeset in a single pass — cross-references and page ' +
                'numbers may lag until the full rebuild lands. It runs when you pause.');
        }
        md.appendMarkdown(engineNote);
        md.appendMarkdown('\n\nClick to recompile.');
        item.tooltip = md;
        item.show();
    };
    return { item, update };
}

const shortKind = (o) =>
    o.kind === 'display-equation' ? (o.label ? `eq ${o.label}` : 'equation')
        : o.kind === 'section-heading' ? '§'
            : o.label ? `${o.kind} ${o.label}` : o.kind;

/** Subtle "page N" markers in the right margin where a page begins. */
function makePageMarkers() {
    return vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
}

function applyPageMarkers(editor, coord, decoration) {
    if (!editor || !/\.tex$/i.test(editor.document.uri.fsPath)) return;
    const map = coord.mapFor(editor.document);
    if (!map || !map.available) { editor.setDecorations(decoration, []); return; }
    const file = editor.document.uri.fsPath;
    const approx = map.displaced || map._baseFlag() !== FLAG.FRESH;
    const opts = [];
    for (const b of map.pageBreaks(file)) {
        if (b.page === 1) continue;                    // page 1 begins at the top
        const line = Math.max(0, Math.min(b.firstLine - 1, editor.document.lineCount - 1));
        opts.push({
            range: new vscode.Range(line, 0, line, 0),
            renderOptions: {
                after: { contentText: `  ─── page ${b.page}${approx ? ' (approx.)' : ''} ───` },
            },
        });
    }
    editor.setDecorations(decoration, opts);
}

/**
 * Compile diagnostics, placed on the OBJECT they belong to.
 *
 * "Overfull \hbox (4.42pt too wide) at lines 30--32" becomes "paragraph
 * exceeds the text width by 1.6 mm", on the paragraph. The millimetres matter:
 * 4.42pt means nothing to an author, 1.6 mm is a thing you can see.
 */
/**
 * What a paper says about its engine: the one it is written for, declared
 * or shown (`paperEngineIntent`: `% !TEX program`, `\pdfoutput=1`, pdfTeX- or
 * LuaTeX-only code), and a digest of its preamble (the text before
 * `\begin{document}`), which is what decides whether another engine is needed.
 */
function paperEngineHints(root, overlay, configuredEngine = 'pdflatex') {
    let text = overlay?.get?.(root);
    if (text == null) { try { text = fs.readFileSync(root, 'utf8'); } catch (_) { return null; } }
    const intent = paperEngineIntent(text);
    const begin = text.indexOf('\\begin{document}');
    const preamble = require('crypto').createHash('sha256')
        .update(begin < 0 ? text : text.slice(0, begin)).digest('hex');
    return { program: intent?.program || null, intent, preamble, engine:paperCompileEngine(text, configuredEngine) };
}

function renderDiagnostics(doc, coord, projection) {
    const st = coord.stateFor(doc);
    if (!st) return [];
    const file = doc.uri.fsPath;
    const { model } = projection.get(doc);
    const out = [];

    const objectAt = (line) => model.objects.filter(o =>
        o.sourceRange.startLine <= line && o.sourceRange.endLine >= line &&
        !['label', 'ref', 'cite', 'include'].includes(o.kind))
        .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
            (b.sourceRange.endLine - b.sourceRange.startLine))[0];

    // A retained PDF is not the latest diagnostic report. The newest current
    // completion wins, including a clean live preview after correcting TeX.
    const revision = st.sourceRevision || 0;
    const completed = [st.compileDiagnostics, st.liveDiagnostics]
        .filter(d => d && d.revision === revision)
        .sort((a,b) => (b.sequence || 0) - (a.sequence || 0) || b.at - a.at);
    const latest = completed[0];
    const diagnostics = latest ? latest.list : !st.sourceAhead ? st.generation?.diagnostics || [] : [];
    for (const diagnostic of diagnostics) {
        const d = latest === st.liveDiagnostics ? { ...diagnostic, live:true } : diagnostic;
        // Only this file's problems. A diagnostic with no file is the root's.
        if (d.file && path.resolve(d.file) !== path.resolve(file) &&
            path.basename(d.file) !== path.basename(file)) continue;
        if (d.line == null) continue;               // lineUnavailable: nowhere to put it
        const line = Math.max(0, Math.min(d.line - 1, doc.lineCount - 1));
        const obj = objectAt(d.line);

        let message = d.message;
        if (/overfull-hbox/.test(d.kind) && d.overByMm != null) {
            message = `${obj ? capitalise(objectWord(obj)) : 'This line'} exceeds the text width by ` +
                `${d.overByMm.toFixed(1)} mm.`;
        } else if (/underfull-hbox/.test(d.kind)) {
            message = `${obj ? capitalise(objectWord(obj)) : 'This line'} is loosely set (underfull).`;
        } else if (/overfull-vbox/.test(d.kind) && d.overByMm != null) {
            message = `Page content overruns its height by ${d.overByMm.toFixed(1)} mm.`;
        }

        const diag = new vscode.Diagnostic(
            doc.lineAt(line).range, message,
            d.severity === 'error' ? vscode.DiagnosticSeverity.Error
                : d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning
                    : vscode.DiagnosticSeverity.Information);
        diag.source = d.live ? 'wolfbook-tex (live)' : 'wolfbook-tex (compile)';
        diag.code = d.kind;
        out.push(diag);
    }
    return out;
}

const objectWord = (o) =>
    o.kind === 'display-equation' ? 'this equation'
        : o.kind === 'paragraph' ? 'this paragraph'
            : o.kind === 'table' || o.kind === 'tabular' ? 'this table'
                : o.kind === 'figure' ? 'this figure' : `this ${o.kind}`;
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

module.exports = {
    RenderCoordinator,
    makeStatusItem,
    makePageMarkers,
    applyPageMarkers,
    renderDiagnostics,
    FLAG_WORD,
};
