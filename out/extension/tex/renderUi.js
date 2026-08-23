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
// runs on save and on demand, never on a keystroke. Between compiles the map
// stays useful: edits are fed to RenderMap.noteEdit, so answers degrade from
// `fresh` to `probably-current` with a known displacement instead of vanishing.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');

const {
    compile, saveGeneration, loadGeneration, probeInitCode, snapshotSources, MAX_PASSES_CODE, probeLualatex,
} = require('./compileService');
const { RenderMap, FLAG } = require('./renderMap');
const { GlyphMap } = require('./glyphMap');
const { findRoot, buildGraph } = require('./texProject');
const {
    nextLiveDelayMs, blendLiveMs, synctexUnchanged, generationSatisfies, authoritativeDelayMs,
} = require('./livePolicy');

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
function makeMap(o) {
    const gen = o && o.generation;
    if (gen && (gen.glyphMapPath || o.glyphDoc)) return new GlyphMap(o);
    return new RenderMap(o);
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
        // How long this paper's live rebuilds actually take, smoothed. Null
        // until the first one finishes, and null means "use the ceiling".
        this.liveMsEwma = null;
        this.authoritativeRunning = false;
    }
}

class RenderCoordinator {
    /** @param {import('./index').Projection} projection */
    constructor(projection, output) {
        this.projection = projection;
        this.output = output;
        this.roots = new Map();          // rootPath -> RootState
        this.rootOf = new Map();         // docPath  -> rootPath
        this._emitter = new vscode.EventEmitter();
        this.onDidChange = this._emitter.event;
        this._liveTimers = new Map();    // rootPath -> debounce handle
        this._idleTimers = new Map();    // rootPath -> the full-rebuild handle
        this._capOk = null;              // can latexmk take our -e? probed once
    }

    dispose() {
        for (const s of this.roots.values()) if (s.running) s.running.abort();
        for (const t of this._liveTimers.values()) clearTimeout(t);
        for (const t of this._idleTimers.values()) clearTimeout(t);
        this._liveTimers.clear();
        this._idleTimers.clear();
        this._emitter.dispose();
    }

    /**
     * The unsaved text of every file in this root's include graph.
     *
     * Only DIRTY documents go in: a clean buffer is identical to the file, and
     * shadowing it would copy the whole project for nothing.
     */
    liveOverlay(root) {
        const st = this.roots.get(root);
        if (!st) return null;
        const files = new Set(st.files || [root]);
        const m = new Map();
        for (const d of vscode.workspace.textDocuments) {
            if (!d.isDirty || d.isClosed) continue;
            const f = d.uri.fsPath;
            if (!files.has(f) && f !== root) continue;
            m.set(f, d.getText());
        }
        return m.size ? m : null;
    }

    /**
     * Recompile a little after the typing stops.
     *
     * The delay is the whole design. Compiling per keystroke queues runs that
     * are obsolete before they finish, and every one of them costs a
     * process-group kill; waiting for a pause means the compile that runs is
     * the one whose result the user still wants to see. It is also what keeps
     * the viewer calm: at most one swap per pause, never a flicker per letter.
     */
    scheduleLive(doc, delayMs) {
        const cfg = vscode.workspace.getConfiguration('wolfbook.tex');
        if (!cfg.get('liveRender', true)) return;
        // Someone who turned compiling off did not ask for it back by typing.
        if (cfg.get('compile', 'onSave') === 'off') return;
        const root = this.rootFor(doc);
        const st = this.roots.get(root);
        // THE SETTING IS THE CEILING, NOT THE VALUE. A paper that rebuilds in
        // 400 ms should feel immediate; one that takes 17 s must stay calm,
        // because firing sooner than the last build finished only queues work
        // the next keystroke will cancel.
        const wait = delayMs ?? nextLiveDelayMs({
            lastMs: st && st.liveMsEwma,
            ceilingMs: Math.max(200, cfg.get('liveRenderDelayMs', 900)),
        });
        const prev = this._liveTimers.get(root);
        if (prev) clearTimeout(prev);
        this._liveTimers.set(root, setTimeout(() => {
            this._liveTimers.delete(root);
            this.build(doc, { live: true }).catch(() => { /* reported via state */ });
        }, wait));
        // Typing also postpones the full rebuild that converges cross-references.
        this._armAuthoritative(root, wait);
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
            // Convergence normally takes one extra build; two is generous. The
            // count is per source snapshot, so the next edit starts it over.
            const tries = (st._convergeAt === g.sourceSnapshotHash ? st._convergeTries || 0 : 0);
            if (tries >= 2) return;
            st._convergeAt = g.sourceSnapshotHash;
            st._convergeTries = tries + 1;
            this.buildAuthoritative(root).catch(() => { /* reported via state */ });
        }, wait));
    }

    /** The background full rebuild. Quiet by construction: no progress toast. */
    async buildAuthoritative(root) {
        const st = this.roots.get(root);
        if (!st || st.compiling) return;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(root)); }
        catch (_) { return; }
        st.authoritativeRunning = true;
        this._emitter.fire(st);
        try { await this.build(doc, { authoritative: true, quiet: true }); }
        finally { st.authoritativeRunning = false; this._emitter.fire(st); }
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

    /** Feed an edit through, so the map can translate rather than go stale. */
    noteChange(e) {
        const st = this.stateFor(e.document);
        if (!st || !st.map) return;
        const file = e.document.uri.fsPath;
        for (const c of e.contentChanges) {
            const removed = c.range.end.line - c.range.start.line;
            const added = (c.text.match(/\n/g) || []).length;
            if (removed !== added) st.map.noteEdit(file, c.range.start.line + 1, added - removed);
        }
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
        const root = this.rootOf.get(file) || file;
        const st = this.roots.get(root);
        if (!st) return false;
        this._emitter.fire(st);
        return true;
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
        if (g.sourceSnapshotHash !== snapshot) return false;
        return generationSatisfies(g, { authoritative });
    }

    /**
     * Compile, or reuse the last generation if the sources have not moved.
     * Only one compile per root at a time; a second request cancels the first,
     * which is cheap (45-80 ms process-group kill, measured).
     */
    async build(doc, { force = false, live = false, authoritative = false, quiet = false } = {}) {
        const root = this.rootFor(doc);
        const st = this.roots.get(root);
        const overlay = this.liveOverlay(root);
        // ONE snapshot per build. It used to be computed twice — here and again
        // inside compile() — which reads and hashes every source file twice per
        // keystroke pause, and let the two disagree if a file moved between them.
        const snapshot = snapshotSources(st.files, overlay);
        // An explicit Compile is never a capped build.
        const wantFull = authoritative || force;
        // THE ENGINE EMITS THE MAP (tex/glyphMap.js). `mapEngine` auto means:
        // build the WPaper view with lualatex + the wbmap hook when lualatex is
        // installed, so the render map is read off the engine rather than
        // inferred from SyncTeX. Decided up front, because a map that is NOT
        // exact while one is wanted — the cached generation of a pdflatex
        // compile from before the upgrade, or the reused record of a warm open —
        // must not count as current: it would keep answering with the old,
        // approximate geometry until the source happened to change.
        const cfg0 = vscode.workspace.getConfiguration('wolfbook.tex');
        const mapEngine = cfg0.get('mapEngine', 'auto');
        let wantGlyphMap = false;
        if (mapEngine === 'lualatex') wantGlyphMap = true;
        else if (mapEngine === 'auto') {
            if (this._luaOk == null) this._luaOk = await probeLualatex();
            wantGlyphMap = !!this._luaOk && !st.glyphMapRefused;
        }
        const mapIsStale = wantGlyphMap && st.map && !st.map.exact;
        if (!force && !mapIsStale && this.isCurrent(st, snapshot, { authoritative: wantFull }) && st.map) return st;

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
            if (cached && !(wantGlyphMap && !cached.glyphMapPath)) {
                st.generation = cached;
                st.map = makeMap({
                    generation: cached,
                    model: this._modelFor(root),
                    pageSize: this._pageSize(cached),
                });
                st.lastError = null;
                this.log(`reused the previous compile of ${path.basename(root)} ` +
                    `(${cached.pageCount ?? '?'} pages, nothing changed)`);
                this._emitter.fire(st);
                return st;
            }
        }

        if (st.running) st.running.abort();
        const ac = new AbortController();
        st.running = ac;
        st.compiling = true;
        // A live rebuild is background work: the previous PDF stays on screen
        // and the panel shows a quiet marker, rather than the blocking
        // "compiling…" banner a deliberate Compile deserves.
        st.liveCompiling = live;
        this._emitter.fire(st);

        const t0 = Date.now();
        this.log(`compile ${path.basename(root)} …`);
        // Progress, because a first compile is seconds of nothing otherwise.
        // A LIVE rebuild is deliberately silent: it fires while you type, and a
        // notification per pause would be intolerable.
        let progress = null;
        let progressDone = null;
        if (!live && !quiet) {
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
            // ONE PASS WHILE TYPING. The correction is scheduled, not skipped:
            // a limited generation arms the idle rebuild and never satisfies a
            // save. Capped only when latexmk has been shown to accept the -e.
            const capWanted = live && !wantFull && cfg.get('liveSinglePass', true);
            if (capWanted && this._capOk === null) {
                this._capOk = await probeInitCode(MAX_PASSES_CODE(1));
                if (!this._capOk) this.log('  latexmk refused the pass cap — live builds stay full');
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
                // The skeleton only has to be walked when it might have changed.
                mirror: live ? 'auto' : 'always',
                engine: cfg.get('engine', 'pdflatex'),
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
            let gen = await compile({
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
            // lualatex could not build this document at all (no PDF): rebuild
            // with the engine the user configured and remember the refusal for
            // this document so the live loop does not pay twice per keystroke.
            if (wantGlyphMap && !gen.ok && !gen.cancelled && !ac.signal.aborted &&
                primaryOpts.engine !== compileOpts.engine) {
                this.log(`  lualatex produced no PDF (${gen.stopReason || 'unknown reason'}) — rebuilding with ${compileOpts.engine}; the render map will be approximate`);
                st.glyphMapRefused = true;
                gen = await compile({ ...compileOpts, maxPasses: null });
            }
            if (ac.signal.aborted) { this.log('  cancelled'); return st; }
            // lualatex built the document but the hook emitted no map: remember
            // it for this document, or the "not exact → rebuild" rule above
            // would recompile on every pause.
            if (wantGlyphMap && gen.ok && gen.engine === 'lualatex' && !gen.glyphMapPath) {
                st.glyphMapRefused = true;
                this.log('  the wbmap hook produced no glyph map — staying on the SyncTeX map for this document');
            }
            const prevGen = st.generation;
            // prevMap and map may now SHARE one parsed SyncTeX doc. That is
            // safe because the doc is never mutated after construction — the
            // only mutation in RenderMap is the overlay remap, which the reuse
            // path skips — and prevMap is read only by diffAgainst.
            const prevDoc = st.map && st.map.doc;
            st.prevMap = st.map;
            st.generation = gen;
            const model = this._modelFor(root);
            // The parsed GlyphMap is reused the same way when its bytes did
            // not move (glyphMapHash): a rebuild that ships nothing new costs
            // no re-parse either.
            const prevGlyph = st.map && st.map.gm;
            st.map = makeMap({
                generation: gen,
                model,
                pageSize: this._pageSize(gen),
                synctexDoc: (prevDoc && synctexUnchanged(prevGen, gen)) ? prevDoc : null,
                glyphDoc: (prevGlyph && prevGen && gen.glyphMapHash && prevGen.glyphMapHash === gen.glyphMapHash) ? prevGlyph : null,
            });
            if (st.map.exact) this.log('  render map: exact (GlyphMap)');
            st.lastError = gen.ok ? null : (gen.stopReason || 'compile produced no PDF');
            saveGeneration(gen);
            // Tune the debounce to what this paper actually costs. gen.ms, not
            // the wall time: queue time is an artefact of the previous build,
            // and feeding it back would inflate the wait that caused it.
            if (live && gen.ok && !gen.cancelled) st.liveMsEwma = blendLiveMs(st.liveMsEwma, gen.ms);
            this.log(`  ${gen.ok ? 'ok' : 'FAILED'} · ${gen.pageCount ?? '?'} pages · ` +
                `${gen.errors} error(s) · ${gen.warnings} warning(s) · ` +
                `${gen.passes ?? '?'} pass(es)${gen.passesLimited ? ' (capped)' : ''}` +
                `${gen.rerunWanted ? ' (cross-references one pass behind)' : ''} · ` +
                `${gen.ms} ms${gen.queuedMs ? ` (+${gen.queuedMs} ms queued)` : ''} · ` +
                `${Date.now() - t0} ms total`);
            if (!gen.ok && gen.stopReason) this.log(`  stopped: ${gen.stopReason}`);
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
            st.lastError = e && e.message ? e.message : String(e);
            this.log(`  ERROR ${st.lastError}`);
            // latexmk missing is the common case and deserves a real message.
            if (/ENOENT/.test(st.lastError)) {
                st.lastError = 'latexmk not found on PATH — install TeX Live, or set wolfbook.tex.compile to "off"';
            }
        } finally {
            if (progressDone) progressDone();
            st.compiling = false;
            st.liveCompiling = false;
            if (st.running === ac) st.running = null;
            this._emitter.fire(st);
        }
        return st;
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
        // A live rebuild is not an event the writer asked for, so it must not
        // take over the status item: the position readout stays, and the spin
        // is appended. Falling through here is deliberate.
        const map = st && st.map;
        if (!map || !map.available) {
            item.text = '$(circle-slash) no render map';
            item.tooltip = new vscode.MarkdownString(
                (st && st.lastError ? `**${st.lastError}**\n\n` : '') +
                'Click to compile this paper and build the render map.');
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
        item.text = `${FLAG_ICON[r.flag] || ''} p.${r.page} ${bars}${obj ? ' ' + shortKind(obj) : ''}` + live;
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
function renderDiagnostics(doc, coord, projection) {
    const st = coord.stateFor(doc);
    if (!st || !st.generation) return [];
    const file = doc.uri.fsPath;
    const { model } = projection.get(doc);
    const out = [];

    const objectAt = (line) => model.objects.filter(o =>
        o.sourceRange.startLine <= line && o.sourceRange.endLine >= line &&
        !['label', 'ref', 'cite', 'include'].includes(o.kind))
        .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
            (b.sourceRange.endLine - b.sourceRange.startLine))[0];

    for (const d of st.generation.diagnostics) {
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
        diag.source = 'wolfbook-tex (compile)';
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
