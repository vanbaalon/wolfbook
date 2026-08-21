// texViewer.js — Page mode: the webview panel that shows the compiled paper.
//
// The extension half. The webview half is out/client/tex-viewer.js; the two
// speak postMessage and nothing else.
//
// WHAT MAKES THIS "PAGE MODE" AND NOT A PDF PREVIEW: clicking lands on the
// SEMANTIC OBJECT, not on "approximately line 183". The pipeline is
// RenderMap.renderToSource -> the tightest SyncTeX record -> the object whose
// range contains that line -> a selection over the object's real source range.
// Stage 0 measured the page half of that at 100% on 539 objects of a real
// 89-page paper.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const { FLAG } = require('./renderMap');
const {
    wordAtColumn, findWordInLine, collectMacros, isInMath, mathRegions,
} = require('./texWords');
const { selectionLadder, paragraphSpan, CONTAINER_KINDS } = require('./texSelect');
const { buildObjectMap, glyphAtPoint, tokenAt, symbolicFonts } = require('./glyphAlign');
const { buildComparison, describeSummary } = require('./texCompare');
const { shipDecision } = require('./livePolicy');
const { sectionSpans } = require('./texModel');

/** Kinds whose whole box is a sensible highlight when nothing finer resolves. */
const BLOCK_KINDS = ['display-equation', 'figure', 'table', 'tabular', 'theorem'];
/** Kinds whose content is maths, and so is addressable glyph by glyph. */
const MATH_KINDS = ['display-equation'];

/**
 * What a PLAIN click is allowed to select.
 *
 * Anything larger is a widening, and widening is opt-in on Cmd/Ctrl. A block
 * the reader clicked INTO — an equation, a figure — is still fair game, because
 * that is the thing under the pointer; a paragraph, a section or the whole file
 * is not.
 */
const PLAIN_CLICK_KINDS = new Set([
    'word', 'glyph', 'sentence', 'group',
    'display-equation', 'figure', 'table', 'tabular', 'theorem',
    'environment', 'align', 'abstract', 'list', 'itemize', 'enumerate', 'verbatim',
]);

const VIEW_TYPE = 'wolfbook.texViewer';
/** Where the shown paper's root is kept, so a window reload can restore it. */
const ROOT_KEY = 'wolfbook.tex.viewerRoot';

/**
 * The amber wash, in the EDITOR, fading back to an ordinary selection.
 *
 * The page marks where you are with a wash that fades over three seconds; an
 * inverse click should land the same way at the other end, or the two halves of
 * one gesture look like two unrelated things. VS Code decorations cannot
 * animate, so the fade is stepped: a handful of decoration types at falling
 * alpha, swapped on a timer and then dropped, leaving the selection VS Code
 * would have drawn anyway.
 *
 * The types are created once and reused — creating one per click leaks a
 * renderer-side object every time.
 */
class EditorFlash {
    constructor(steps = 7, ms = 2400) {
        this.steps = steps;
        this.ms = ms;
        this._types = null;
        this._timer = null;
        this._active = null;
    }

    _make() {
        if (this._types) return this._types;
        // Read the enum defensively: it is absent in some hosts, and a
        // decoration is decoration — a missing one must never be able to break
        // the jump it decorates. (A test caught exactly that: reading
        // `.Center` off undefined threw out of every single inverse click.)
        const lane = (vscode.OverviewRulerLane && vscode.OverviewRulerLane.Center) ?? 2;
        const types = [];
        for (let i = 0; i < this.steps; i++) {
            const a = 0.42 * (1 - i / this.steps);
            try {
                types.push(vscode.window.createTextEditorDecorationType({
                    backgroundColor: `rgba(255,196,0,${a.toFixed(3)})`,
                    borderRadius: '2px',
                    // The paper scrolls to what you clicked; so should the ruler.
                    overviewRulerColor: i === 0 ? 'rgba(255,196,0,0.8)' : undefined,
                    overviewRulerLane: i === 0 ? lane : undefined,
                }));
            } catch (_) { break; }
        }
        this._types = types;
        return this._types;
    }

    /** Paint `range` in `editor` and fade it out. */
    show(editor, range) {
        if (!editor || !range) return;
        this.clear();
        let types = [];
        try { types = this._make(); } catch (_) { return; }
        if (!types.length) return;
        this._active = editor;
        let i = 0;
        const step = () => {
            if (!this._active) return;
            for (let k = 0; k < types.length; k++) {
                try { this._active.setDecorations(types[k], k === i ? [range] : []); }
                catch (_) { /* the editor closed under us */ }
            }
            i++;
            if (i < types.length) {
                this._timer = setTimeout(step, this.ms / types.length);
            } else {
                this._timer = setTimeout(() => this.clear(), this.ms / types.length);
            }
        };
        step();
    }

    clear() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._active && this._types) {
            for (const t of this._types) {
                try { this._active.setDecorations(t, []); } catch (_) { /* gone */ }
            }
        }
        this._active = null;
    }

    dispose() {
        this.clear();
        for (const t of (this._types || [])) { try { t.dispose(); } catch (_) { /* gone */ } }
        this._types = null;
    }
}

class TexViewer {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {import('./renderUi').RenderCoordinator} coord
     * @param {import('./index').Projection} projection
     */
    constructor(context, coord, projection) {
        this.context = context;
        this.coord = coord;
        this.projection = projection;
        this.panel = null;
        this.root = null;          // the root .tex this panel is showing
        // The generation whose BYTES the webview holds — not simply the newest
        // one. _text.generation and _objMaps are keyed on it, so it may only
        // advance when a document actually crossed into the panel.
        this.shownGeneration = null;
        this.shownPdfHash = null;
        this.followCursor = true;
        this.shownAnything = false;
        this._ladder = null;       // {page, xBp, yBp, items, index, file}
        this._invertedAt = 0;      // when the reader last clicked IN the PDF
        this._macros = new Map();  // docPath -> {version, table}
        this._fsActions = null;    // the commands that put us in full screen
        this._autoHidden = null;   // closed by us because no .tex was active
        this._viewState = null;    // {page, frac} so hide/restore keeps the place
        this._edit = null;         // the one live mini-editor session
        this._editSeq = 0;
        this._diff = null;         // the open comparison, if any
        this._text = null;         // {generation, pages: Map<page, items>} from the webview
        this._objMaps = new Map(); // `${generation}|${stableKey}` -> the alignment
        this._docListener = null;
        this._flash = new EditorFlash();
        this._disposables = [];
    }

    get visible() { return !!this.panel; }

    get _webviewOptions() {
        return {
            enableScripts: true,
            retainContextWhenHidden: true,
            // Only our own client assets. The PDF is NOT loaded by URL — see
            // _postPdf below for why.
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'out', 'client'),
            ],
        };
    }

    /** Open (or focus) the viewer for whatever .tex is active. */
    async open(doc, { reveal = true } = {}) {
        const root = this.coord.rootFor(doc);
        if (this.panel) {
            if (reveal) this.panel.reveal(vscode.ViewColumn.Beside, true);
        } else {
            this._wire(vscode.window.createWebviewPanel(
                VIEW_TYPE, 'Paper',
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                this._webviewOptions));
            // KEEP THE COLUMN FOR THE PAPER.
            //
            // Without this, VS Code treats the viewer's group as an ordinary
            // editor group: click a search result or a file in the explorer
            // while the viewer has focus and it opens THERE, on top of the
            // paper. Locking the group makes VS Code route those elsewhere,
            // which is what makes a two-column layout usable rather than a
            // thing you have to keep tidying up.
            this._lockGroup().catch(() => { /* older builds simply do not */ });
        }
        this.root = root;
        this._rememberRoot(root);
        this._postTheme();
        await this.refresh({ force: true });
    }

    /**
     * Take ownership of a panel — a new one, or one VS Code restored.
     *
     * Everything a live panel needs is here rather than in `open`, because a
     * RELOADED panel needs exactly the same wiring and nothing else. Without
     * it the restored panel is a shell: no HTML, no message handler, no theme
     * listener — an empty grey rectangle that never syncs again, which is what
     * a window reload used to leave behind.
     */
    _wire(panel) {
        this.panel = panel;
        panel.iconPath = undefined;
        // A restored panel arrives with its options and content dropped, so
        // both are re-established rather than assumed.
        try { panel.webview.options = this._webviewOptions; } catch (_) { /* new panel: already set */ }
        panel.webview.html = this._html();
        panel.onDidDispose(() => {
            // Closing the panel must not leave the window maximised with
            // nothing in it.
            if (this._fsActions) {
                const undo = [...this._fsActions].reverse();
                this._fsActions = null;
                (async () => {
                    for (const c of undo) {
                        try { await vscode.commands.executeCommand(c); } catch (_) { /* best effort */ }
                    }
                })();
            }
            this.panel = null;
            this.shownGeneration = null;
            // A future panel is a different webview holding nothing.
            this.shownPdfHash = null;
            this.shownAnything = false;
            this._ladder = null;
            this._edit = null;
            this._docListener = null;
            this._text = null;
            this._diff = null;
            this._objMaps.clear();
            this._flash.dispose();
            for (const d of this._disposables.splice(0)) { try { d.dispose(); } catch (_) {} }
        });
        panel.webview.onDidReceiveMessage((m) => this._onMessage(m));
        // THE THEME COMES FROM VS CODE, NOT FROM THE WEBVIEW'S GUESS.
        //
        // A webview can read `prefers-color-scheme`, but that is the
        // OPERATING SYSTEM's preference: a light VS Code theme on a dark
        // desktop reports dark, and the pages would inconsistently invert.
        // `activeColorTheme.kind` is the thing the reader actually chose.
        this._disposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => this._postTheme()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('wolfbook.tex.pageTheme')) this._postTheme();
            }),
        );
    }

    /** Remember which paper this panel is showing, across a window reload. */
    _rememberRoot(root) {
        try { this.context.workspaceState.update(ROOT_KEY, root || undefined); }
        catch (_) { /* no workspace state: reload restores nothing, as before */ }
    }

    /**
     * Re-adopt the panel VS Code restored after a window reload.
     *
     * VS Code brings an open webview panel back by itself, but only as a
     * SHELL: without a registered serializer the extension never learns about
     * it, so it has no HTML, no message handler and no root — an empty
     * rectangle that never syncs again. That is what a reload used to leave.
     *
     * The root comes from workspace state, not from the webview: the page
     * cannot know which .tex it belongs to, and making it remember would put
     * the reader's own file path into restored web content.
     */
    async adopt(panel, state) {
        if (this.panel && this.panel !== panel) {
            // A live panel already exists; a second would fight it.
            try { panel.dispose(); } catch (_) { /* fine */ }
            return;
        }
        this._wire(panel);
        this._autoHidden = null;
        let root = (state && state.root) || null;
        try { root = root || this.context.workspaceState.get(ROOT_KEY) || null; } catch (_) { /* none */ }
        if (state && Number.isFinite(state.page)) {
            this._viewState = { page: state.page, frac: state.frac };
        }
        if (!root || !fs.existsSync(root)) {
            this._post({ type: 'status', text: 'reopen the paper from a .tex file', kind: 'warn' });
            return;
        }
        this.root = root;
        this._postTheme();
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(root));
            // A reload drops every in-memory compile record, so there may be
            // nothing to show until one is rebuilt. The persisted generation
            // makes that instant whenever the out dir survived.
            const st = this.coord.stateFor(doc);
            if (!st || !st.generation) await this.coord.build(doc);
            await this.refresh({ force: true });
            this.syncFromEditor(vscode.window.activeTextEditor);
        } catch (e) {
            this._post({ type: 'status', text: `could not restore the paper: ${e.message}`, kind: 'err' });
        }
    }

    /** Push the current generation's PDF into the webview. */
    async refresh({ force = false } = {}) {
        if (!this.panel || !this.root) return;
        const st = this.coord.roots.get(this.root);
        if (!st || !st.generation || !st.generation.pdfPath) {
            this._post({
                type: 'status',
                text: st && st.compiling ? 'compiling the paper…' : 'no compiled PDF yet — press Compile',
                kind: st && st.compiling ? '' : 'err',
            });
            return;
        }
        // THE PAGES ON SCREEN MAY ALREADY BE THIS COMPILE'S PAGES.
        //
        // pdfHash is a CONTENT hash (compileService.pdfContentHash), so it is
        // not fooled by /CreationDate moving on every run. When it matches,
        // shipping would base64 the whole PDF, re-parse it in pdf.js, repaint
        // every visible canvas, sweep every page's text layer and drop every
        // glyph alignment — to arrive at the pixels already displayed. Typing a
        // comment, or a word that does not reflow its line, is exactly this.
        //
        // shownGeneration is deliberately NOT advanced here: it names the
        // generation whose BYTES the webview holds, and _text.generation and
        // _objMaps are keyed on it. Bumping it would invalidate the glyph maps
        // for nothing, which is the cost this branch exists to avoid.
        const decision = shipDecision({
            force,
            shownGeneration: this.shownGeneration,
            shownPdfHash: this.shownPdfHash,
            gen: st.generation,
        });
        if (!decision.ship) {
            if (decision.reason === 'identical pdf') {
                this._log(`generation ${st.generation.generation}: ${decision.reason} — nothing shipped`);
                // The ink did not move, but the SOURCE did (that is why we
                // recompiled), so the map did. Re-answer from the new map
                // without disturbing the document the webview already holds —
                // this is the round trip the 'opened' handshake would have
                // triggered had we shipped.
                try { this.syncFromEditor(vscode.window.activeTextEditor); } catch (_) { /* best effort */ }
                this._postEditAnchor().catch(() => { /* no open card */ });
            }
            return;
        }
        if (!fs.existsSync(st.generation.pdfPath)) {
            this._post({ type: 'status', text: 'the compiled PDF has gone missing', kind: 'err' });
            return;
        }
        const t0 = Date.now();
        this.shownGeneration = st.generation.generation;
        this.panel.title = `Paper · ${path.basename(this.root)}`;
        const w = this.panel.webview;

        // THE PDF GOES ACROSS AS BYTES, NOT AS A URL.
        //
        // Compiles run out-of-tree in os.tmpdir(), and on macOS that is
        // `/var/folders/...` — a symlink to `/private/var/folders/...`. A
        // `localResourceRoots` entry built from `os.tmpdir()` does not match
        // the realpath VS Code resolves the resource to, so `asWebviewUri`
        // produces a URL the webview silently refuses to fetch: no error, no
        // pages, just an empty panel. Handing pdf.js the bytes removes the
        // whole class of problem (roots, symlinks, sandbox rules) and costs one
        // copy per compile, which is nothing beside a 17 s LaTeX run.
        let data = null;
        const tRead = Date.now();
        try { data = fs.readFileSync(st.generation.pdfPath).toString('base64'); }
        catch (e) {
            this._post({ type: 'status', text: `could not read the PDF: ${e.message}`, kind: 'err' });
            return;
        }
        const readMs = Date.now() - tRead;
        this._post({
            type: 'open',
            base: w.asWebviewUri(vscode.Uri.joinPath(
                this.context.extensionUri, 'out', 'client', 'pdfjs')).toString(),
            pdfBase64: data,
            generation: st.generation.generation,
            pages: st.generation.pageCount,
            // Restoring after an auto-hide should land where the reader was.
            revealPage: this._viewState && this._viewState.page,
            // A live rebuild replaces the pages under a reader who did not ask
            // for it, so the viewer keeps their scroll position and swaps each
            // canvas only once its replacement is drawn.
            live: !!st.generation.live && this.shownAnything,
        });
        this.shownAnything = true;
        // What the webview now holds — the key the next refresh compares.
        this.shownPdfHash = st.generation.pdfHash || null;
        this._post({ type: 'setFollow', value: this.followCursor });
        this._log(`sent generation ${st.generation.generation} ` +
            `(${(data.length / 1398101).toFixed(2)} MB of PDF) in ${Date.now() - t0} ms ` +
            `· read ${readMs} ms`);
    }

    /**
     * Recompile the paper THIS PANEL is showing.
     *
     * The toolbar's Compile button used to run `wolfbook.tex.compile`, which
     * begins `const doc = vscode.window.activeTextEditor?.document`. Pressing a
     * button inside a webview means focus is in the webview, so there IS no
     * active text editor: the command warned "Open a .tex file first" into the
     * corner of the screen and the button appeared to do nothing at all. Same
     * root cause as the repaint bug — see makePaintRender in index.js.
     *
     * The panel knows which root it is showing, so it asks for that one.
     */
    async rebuild() {
        if (!this.root) return;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.root));
            this._post({ type: 'status', text: 'compiling the paper…' });
            const st = await this.coord.build(doc, { force: true });
            if (st && st.lastError) {
                this._post({ type: 'status', text: `compile failed: ${st.lastError}`, kind: 'err' });
            } else if (st && st.generation) {
                const g = st.generation;
                this._post({
                    type: 'status',
                    text: `${g.pageCount ?? '?'} pages · ${g.errors} error(s) · ${g.warnings} warning(s)`,
                    kind: g.errors ? 'warn' : 'ok',
                });
            }
            await this.refresh({ force: true });
        } catch (e) {
            this._post({ type: 'status', text: `could not compile: ${e.message}`, kind: 'err' });
        }
    }

    // --- theme ---------------------------------------------------------------

    /** Is the reader's VS Code theme a dark one? */
    _themeIsDark() {
        const K = vscode.ColorThemeKind || {};
        const kind = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind;
        // Dark = 2, HighContrast = 3 in every published build; HighContrastLight
        // (4) was added later, so it is named rather than assumed absent.
        if (kind === K.Light || kind === 1) return false;
        if (kind === K.HighContrastLight || kind === 4) return false;
        return kind === K.Dark || kind === K.HighContrast || kind === 2 || kind === 3;
    }

    /**
     * How the PAGES should be shown, which is a separate question from how the
     * panel's chrome should be.
     *
     * A paper is a printed artefact and some readers want it to look printed
     * whatever the editor looks like — and darkening works by inverting the
     * rendered image, so a photograph comes out as a negative. Hence three
     * states rather than a boolean, with `auto` following the theme.
     */
    pageTheme() {
        const want = vscode.workspace.getConfiguration('wolfbook.tex').get('pageTheme', 'auto');
        if (want === 'light' || want === 'dark') return want;
        return this._themeIsDark() ? 'dark' : 'light';
    }

    _postTheme() {
        if (!this.panel) return;
        this._post({
            type: 'theme',
            dark: this._themeIsDark(),
            pages: this.pageTheme(),
            setting: vscode.workspace.getConfiguration('wolfbook.tex').get('pageTheme', 'auto'),
        });
    }

    /**
     * The toolbar's sun/moon. It writes the SETTING rather than holding a
     * session-only override: a reader who turns the pages white means it next
     * time too, and one source of truth keeps the Settings UI honest.
     */
    async _setPageTheme(value) {
        const v = ['auto', 'light', 'dark'].includes(value) ? value : 'auto';
        try {
            await vscode.workspace.getConfiguration('wolfbook.tex')
                .update('pageTheme', v, vscode.ConfigurationTarget.Global);
        } catch (e) {
            this._post({ type: 'status', text: `could not save the page theme: ${e.message}`, kind: 'warn' });
        }
        this._postTheme();       // configuration events can lag; say it now
    }

    /**
     * The macro table for a document, rebuilt only when the document changes.
     *
     * Without it the projection cannot see through \bx or \SoV, and a real
     * paper's equations project to almost nothing — which is what made every
     * click in an equation select the whole equation.
     */
    _macrosFor(doc) {
        const key = doc.uri.fsPath;
        const hit = this._macros.get(key);
        if (hit && hit.version === doc.version) return hit.table;
        let table = new Map();
        try { table = collectMacros(doc.getText()); } catch (_) { /* none is fine */ }
        this._macros.set(key, { version: doc.version, table });
        return table;
    }

    _log(msg) { try { if (this.coord && this.coord.log) this.coord.log(msg); } catch (_) { /* fine */ } }

    /** Lock the viewer's editor group so other files cannot open into it. */
    async _lockGroup() {
        if (!this.panel) return;
        if (!vscode.workspace.getConfiguration('wolfbook.tex').get('lockViewerGroup', true)) return;
        const all = new Set(await vscode.commands.getCommands(true));
        const cmd = ['workbench.action.lockEditorGroup', 'workbench.action.toggleEditorGroupLock']
            .find(c => all.has(c));
        if (!cmd) return;
        const back = vscode.window.activeTextEditor;
        this.panel.reveal(this.panel.viewColumn, false);      // lock acts on the ACTIVE group
        try { await vscode.commands.executeCommand(cmd); } catch (_) { /* not fatal */ }
        // Give the keyboard back to whoever had it; the reader asked for a
        // paper next to their text, not a focus change.
        if (back) {
            try { await vscode.window.showTextDocument(back.document, { viewColumn: back.viewColumn, preserveFocus: false }); }
            catch (_) { /* fine */ }
        }
    }

    /**
     * Put the paper away while the reader is not in a .tex, and bring it back
     * when they are.
     *
     * A Page view pinned open beside an unrelated file is just clutter, and it
     * invites exactly the mess this is meant to avoid. Hiding is a real close —
     * VS Code has no way to hide a webview panel — so the scroll position is
     * kept and restored, which is the only part the reader would miss.
     */
    async autoHide() {
        if (!this.panel || this._autoHidden) return;
        this._autoHidden = { root: this.root, at: Date.now() };
        const p = this.panel;
        this.panel = null;                 // dispose() must not run the teardown twice
        this.shownGeneration = null;
        this.shownPdfHash = null;
        try { p.dispose(); } catch (_) { /* already gone */ }
    }

    /** Was this panel closed by us rather than by the reader? */
    get autoHidden() { return !!this._autoHidden; }

    async autoRestore(doc) {
        if (this.panel || !this._autoHidden) return;
        this._autoHidden = null;
        await this.open(doc, { reveal: true });
    }

    /** Is the Page view actually on screen? Live rebuilds are for it alone. */
    isOpen() { return !!this.panel; }

    /** Forward sync: highlight the object under the cursor. */
    syncFromEditor(editor) {
        if (!this.panel || !this.followCursor || !editor) return;
        const doc = editor.document;
        if (!/\.tex$/i.test(doc.uri.fsPath)) return;
        const st = this.coord.stateFor(doc);
        if (!st || !st.map || !st.map.available) return;

        const line = editor.selection.active.line + 1;
        const column = editor.selection.active.character;
        const { model } = this.projection.get(doc);
        const obj = model.objects
            .filter(o => o.sourceRange.startLine <= line && o.sourceRange.endLine >= line &&
                !['label', 'ref', 'cite', 'include'].includes(o.kind))
            .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
                (b.sourceRange.endLine - b.sourceRange.startLine))[0];

        // AN EQUATION IS AN OBJECT; PROSE IS A PLACE ON A LINE.
        //
        // For a display equation or a float the object IS the unit, and its
        // box is the right highlight. For prose it is not: draft.tex line 3086
        // is a 250-character source line that wraps into three typeset lines,
        // so highlighting "the paragraph" says almost nothing about where the
        // cursor is. Prose therefore highlights the typeset ROWS of the
        // current line, and names the word under the cursor so the viewer can
        // narrow to it using the PDF's own text layer.
        const objectIsTheUnit = obj && BLOCK_KINDS.includes(obj.kind);
        const lineSrc = doc.lineAt(Math.max(0, line - 1)).text;
        // A display environment is an object; $E=mc^2$ is not. Both are maths,
        // and answering a cursor inside inline maths with the nearest PROSE
        // word is how a click meant for the formula highlighted the word before
        // it.
        const inMath = (obj && MATH_KINDS.includes(obj.kind)) || isInMath(lineSrc, column);
        const macros = this._macrosFor(doc);

        let rects = [];
        let flag = st.map._baseFlag();
        let word = null;
        let glyph = false;

        // FORWARD AND INVERSE ARE THE SAME TABLE, READ THE OTHER WAY.
        //
        // If the alignment can place the cursor's own token, it also knows the
        // exact rect of the glyph that token printed — so the highlight is that
        // glyph, with no name matching in the webview and no chance of the two
        // directions disagreeing about what corresponds to what.
        const alignObj = this._objectForLine(st, doc, line);
        const amap = this._objectMap(st, doc, alignObj);
        if (amap) {
            const t = tokenAt(amap, line, column);
            if (t.index >= 0) {
                const gi = amap.srcToRen[t.index];
                if (gi >= 0) {
                    const g = amap.glyphs[gi];
                    this._post({
                        type: 'highlight',
                        rects: [{ page: g.page, x: g.x, y: g.y, w: g.w, h: g.h }],
                        glyph: true,
                        flag: flag === FLAG.FRESH ? 'fresh' : flag === FLAG.STALE ? 'stale' : 'approx',
                        reveal: Date.now() - this._invertedAt >= 1500,
                        title: obj ? obj.stableKey : `line ${line}`,
                        label: `${JSON.stringify(amap.tokens[t.index].ch)} · p.${g.page} · ${flag}`,
                    });
                    return;
                }
            }
        }

        // MATHS NARROWS TOO. A display equation is an object, but "the whole
        // equation" is a poor answer to where the cursor is in a six-line
        // align. Its letters and digits ARE typeset literally, so the glyph at
        // the cursor is addressable the same way a prose word is; the object
        // box remains the answer only when no glyph resolves (a lone \frac, a
        // Greek letter whose printed shape we cannot predict).
        if (inMath) {
            const g = wordAtColumn(lineSrc, column, { scope: 'math', inMath: true, macros });
            if (g) {
                word = g; glyph = true;
                rects = st.map.lineRows(doc.uri.fsPath, line)
                    .map(r => ({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h }));
            }
        }
        if (!rects.length && objectIsTheUnit) {
            word = null; glyph = false;
            // THE OBJECT'S ROWS, NOT ITS BOX.
            //
            // A display's SyncTeX box includes \abovedisplayskip, so it reaches
            // up over the paragraph above it — highlighting an equation drew one
            // tall band across the prose as well. The rows its own lines
            // printed are the equation and nothing else. The box stays as the
            // fallback for objects with no character records of their own,
            // like a figure.
            const rows = [];
            for (let n = obj.sourceRange.startLine; n <= obj.sourceRange.endLine; n++) {
                for (const r of st.map.lineRows(doc.uri.fsPath, n)) {
                    rows.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h });
                }
            }
            if (rows.length) {
                rects = rows;
            } else {
                const r = st.map.objectRenderBoxes(obj);
                rects = r.rects;
                flag = r.flag || flag;
            }
        } else if (!rects.length) {
            rects = st.map.lineRows(doc.uri.fsPath, line)
                .map(r => ({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h }));
            word = wordAtColumn(lineSrc, column, { macros });
        }
        if (!rects.length) {
            this._post({ type: 'highlight', rects: [], label: `line ${line} · unmapped` });
            return;
        }

        // NEVER SCROLL BACK AT SOMEONE WHO JUST CLICKED.
        //
        // An inverse click moves the cursor, which fires this forward sync,
        // which used to reveal — so clicking a symbol scrolled the page out
        // from under the hand that clicked it. The reader is already looking
        // at the right place; only a cursor move that did NOT come from the
        // page deserves a scroll.
        const fromClick = Date.now() - this._invertedAt < 1500;
        const where = word ? `"${word.word}"` : (obj ? shortLabel(obj) : `line ${line}`);
        this._post({
            type: 'highlight',
            rects,
            word: word ? word.word : undefined,
            occurrence: word ? word.occurrence : undefined,
            glyph,
            flag: flag === FLAG.FRESH ? 'fresh' : flag === FLAG.STALE ? 'stale' : 'approx',
            reveal: !fromClick,
            title: obj ? obj.stableKey : `line ${line}`,
            label: `${where} · p.${rects[0].page} · ${flag}`,
        });
    }

    async _onMessage(m) {
        switch (m.type) {
            case 'ready': this._postTheme(); await this.refresh({ force: true }); break;
            case 'follow': this.followCursor = !!m.value; break;
            case 'recompile': await this.rebuild(); break;
            case 'click': await this._jumpToSource(m); break;
            case 'fullscreen': await this.setFullScreen(m.value); break;
            case 'viewstate':
                this._viewState = { page: m.page, frac: m.frac };
                break;
            case 'timing': {
                // The webview is the one place the extension cannot time from
                // the outside, and a VS Code webview is not the headless
                // browser the harness measures — the worker can be refused and
                // fonts arrive over a different protocol.
                const phases = (m.marks || []).map(([k, v]) => `${k} ${v}ms`).join(' · ');
                this._log(`viewer: ${phases}${m.worker ? ' · ' + m.worker : ''}`);
                break;
            }
            case 'opened':
                // The pages just changed underneath the reader. Any ladder was
                // built against the old source positions, and the old rects
                // were measured against the old compile, so both are dropped
                // and the highlight is recomputed from where the cursor is now.
                this._ladder = null;
                this.syncFromEditor(vscode.window.activeTextEditor);
                // The mini-editor's block has new geometry too — move the card.
                this._postEditAnchor().catch(() => {});
                break;
            case 'textLayer': this._onTextLayer(m); break;
            case 'textLayerDone':
                this._log(`text layer complete for generation ${m.generation}: ${m.pages} pages`);
                break;
            case 'pageTheme': await this._setPageTheme(m.value); break;
            case 'diffFocus': await this._focusHunk(m.id); break;
            case 'diffClose': this.closeComparison(); break;
            case 'compare': await this.offerComparison(); break;
            case 'editHere':
                // Open the block, THEN resolve the click inside it. A
                // right-click is still a click: it should land the caret on the
                // symbol under the pointer, in the card and in the editor
                // alike. The order matters — the jump posts its selection into
                // whatever card is open, so the card has to exist first.
                await this._openEditSession(m);
                await this._jumpToSource(m);
                break;
            case 'editChange': await this._applyEditChange(m); break;
            case 'editClose': this._edit = null; break;
            case 'editSave': await this._saveEditDoc(); break;
            case 'editReveal': await this._revealEditRange(); break;
            default: break;
        }
    }

    // --- the glyph alignment -------------------------------------------------
    //
    // SyncTeX is the COARSE anchor: it says which object a point is in, and
    // which object a cursor is in. Inside that object, the projected source
    // glyphs are aligned against the rendered ones and the alignment answers
    // both directions from one table. See glyphAlign.js for the measurements
    // that forced this — the per-line search it replaces resolved 8.8% of the
    // glyphs in this paper's display equations.

    _onTextLayer(m) {
        if (!this._text || this._text.generation !== m.generation) {
            this._text = { generation: m.generation, pages: new Map(), symbolFonts: new Set() };
            this._objMaps.clear();      // geometry from a previous compile is gone
        }
        this._text.pages.set(m.page, m.items || []);
        // Which fonts lie about their characters is a DOCUMENT-wide judgement:
        // one equation may show a ∑ and no stretched delimiter, which is not
        // enough evidence on its own. A page that adds a new one invalidates
        // the alignments built before it was known.
        let grew = false;
        for (const f of symbolicFonts(m.items || [])) {
            if (!this._text.symbolFonts.has(f)) { this._text.symbolFonts.add(f); grew = true; }
        }
        if (grew) this._objMaps.clear();
    }

    /** Is there a text layer for the generation currently on screen? */
    _textReady() {
        return !!(this._text && this._text.generation === this.shownGeneration &&
            this._text.pages.size);
    }

    /**
     * Every rendered glyph belonging to an object, aligned with its source.
     *
     * The rendered side is collected from the object's own typeset rows and
     * then filtered by the coarse anchor AGAIN, per item: `lineAtPoint` says
     * which source line printed a given piece of ink, and ink from outside the
     * object is dropped. Without that filter the sequence picked up the prose
     * around the equation — measured, the unmatched glyphs came out with the
     * letter frequencies of English — and resolution fell from 72% to 54%.
     */
    _objectMap(st, doc, obj) {
        if (!obj || !this._textReady()) return null;
        const key = `${this.shownGeneration}|${obj.stableKey || `${obj.startLine}-${obj.endLine}`}`;
        const hit = this._objMaps.get(key);
        if (hit !== undefined) return hit;

        const file = doc.uri.fsPath;
        const startLine = obj.startLine ?? obj.sourceRange?.startLine;
        const endLine = obj.endLine ?? obj.sourceRange?.endLine;
        let built = null;
        try {
            const seen = new Set();
            const items = [];
            for (let n = startLine; n <= endLine; n++) {
                for (const r of st.map.lineRows(file, n)) {
                    const rk = `${r.page}|${r.y.toFixed(2)}|${r.x.toFixed(2)}`;
                    if (seen.has(rk)) continue;
                    seen.add(rk);
                    for (const it of (this._text.pages.get(r.page) || [])) {
                        if (!it.str || !it.str.trim()) continue;
                        if (it.baseline < r.y - 2 || it.baseline > r.y + r.h + 2) continue;
                        if (it.x + it.w < r.x - 2 || it.x > r.x + r.w + 2) continue;
                        const owner = st.map.lineAtPoint(r.page, it.x + it.w / 2, it.baseline - 1);
                        if (!owner || owner.file !== file || owner.line < startLine || owner.line > endLine) continue;
                        items.push({ ...it, page: r.page });
                    }
                }
            }
            if (items.length) {
                const lines = doc.getText().split(/\r?\n/);
                built = buildObjectMap({
                    lines, startLine, endLine,
                    macros: this._macrosFor(doc),
                    inMath: MATH_KINDS.includes(obj.kind),
                    symbolFonts: this._text.symbolFonts,
                    items,
                });
                // A sequence that barely corresponds is not a map. Saying so and
                // falling back beats pointing confidently at the wrong token.
                if (built.confidence < 0.35) built = null;
            }
        } catch (e) {
            this._log(`alignment failed: ${e.message}`);
            built = null;
        }
        this._objMaps.set(key, built);
        return built;
    }

    /** The object containing a line, in the shape `_objectMap` expects. */
    _objectForLine(st, doc, line) {
        const o = st.map.objectAtLine(doc.uri.fsPath, line);
        return (o && !o.approximate) ? o : null;
    }

    /**
     * A point on the page -> {file, line, object, flag}, preferring the printed
     * ROW over the box hierarchy.
     *
     * TWO WAYS TO ASK, AND TEXT NEEDS THE SECOND ONE. renderToSource walks the
     * box hierarchy, which is right for an equation or a float. Prose is not
     * boxed: its characters are recorded as dimensionless POINTS, so a click on
     * a paragraph resolves to whatever vbox encloses it — in practice the
     * display equation below, because `\[` plants a zero-width record on the
     * paragraph's own last baseline. That is how clicking "function" selected
     * the equation. lineAtPoint asks which printed ROW the click landed on
     * instead; it is preferred whenever it lands close to real ink, with the
     * box answer as the fallback (and still the winner for floats).
     */
    _resolvePoint(st, m) {
        const row = st.map.lineAtPoint(m.page, m.xBp, m.yTopBp);
        const box = st.map.renderToSource(m.page, m.xBp, m.yTopBp);
        return (row && row.dx < 24)
            ? {
                flag: (box && box.flag) || st.map._baseFlag(),
                file: row.file,
                line: row.line,
                object: st.map.objectAtLine(row.file, row.line) || undefined,
            }
            : box;
    }

    /** INVERSE SYNC — the thing that makes this Page mode. */
    async _jumpToSource(m) {
        const st = this.root && this.coord.roots.get(this.root);
        if (!st || !st.map || !st.map.available) return;
        this._invertedAt = Date.now();

        const hit = this._resolvePoint(st, m);
        if (!hit || hit.flag === FLAG.UNMAPPED || !hit.file) {
            this._ladder = null;
            this._post({ type: 'status', text: hit && hit.reason ? hit.reason : 'nothing there', kind: 'warn' });
            return;
        }

        const uri = vscode.Uri.file(hit.file);
        const doc = await vscode.workspace.openTextDocument(uri);
        let lineIdx = Math.max(0, Math.min(hit.line - 1, doc.lineCount - 1));
        let lineSrc = doc.lineAt(lineIdx).text;
        const macros = this._macrosFor(doc);

        // WHICH WORD — DECIDED BY EVIDENCE, NOT BY GUESSING THE MODE FIRST.
        //
        // This used to ask "is this maths?" and then look only that way. The
        // question cannot be answered reliably: `objectAtLine` reports the
        // NEAREST object when none contains the line, so a prose line sitting
        // one line from a display equation came back as that equation
        // (measured: line 60 -> display-equation, approximate, 1 line away).
        // Prose was then read glyph-by-glyph, and clicking "For" selected "F".
        //
        // So both readings are computed and the better-corroborated one wins.
        // An exact prose word beats an exact glyph — a word is the more
        // meaningful unit, and inside real maths the prose reading finds
        // nothing anyway, because every token there is tagged as maths.
        //
        // Occurrence: when the source line typeset as a single row, the
        // viewer's "n-th same glyph on the row" picks among repeats exactly;
        // across wrapped rows the fraction hint stays the tie-break.
        const singleRow = st.map.lineRows(hit.file, hit.line).length === 1;
        const proseHit = m.word
            ? findWordInLine(lineSrc, m.word, m.rowFraction ?? 0.5,
                { macros, occurrence: singleRow ? m.wordOccurrence : 0 })
            : null;
        const mathHit = m.glyph
            ? findWordInLine(lineSrc, m.glyph, m.glyphFraction ?? 0.5,
                { scope: 'math', inMath: true, macros, occurrence: singleRow ? m.glyphOccurrence : 0 })
            : null;
        let w = (proseHit && proseHit.exact) ? proseHit
            : (mathHit && mathHit.exact) ? mathHit
                : (proseHit || mathHit);

        // THE ALIGNMENT ANSWERS FIRST, WHEN IT HAS AN ANSWER.
        //
        // It knows which glyph was clicked by POSITION rather than by name, so
        // it resolves the glyphs a name-based search never could: a stretched
        // `\bigl(` that the PDF reports as an unnameable control code, a symbol
        // whose command is not in any table, or a character sitting on a line
        // SyncTeX never attributed anything to. Only when it has nothing to say
        // does the older per-line search run.
        const alignObj = hit.object && !hit.object.approximate ? hit.object : null;
        const amap = this._objectMap(st, doc, alignObj);
        let aligned = null;
        if (amap) {
            const g = glyphAtPoint(amap, m.page, m.xBp, m.yTopBp);
            // 12 bp is about one line of body text: further than that and the
            // click was not really on this object's glyph.
            if (g.index >= 0 && g.distance < 12) {
                const ti = amap.renToSrc[g.index];
                if (ti >= 0) aligned = amap.tokens[ti];
            }
        }
        if (aligned) {
            hit.line = aligned.line;
            lineIdx = Math.max(0, Math.min(aligned.line - 1, doc.lineCount - 1));
            lineSrc = doc.lineAt(lineIdx).text;
            const glyphToken = {
                start: aligned.startCol,
                end: aligned.endLine === aligned.line ? aligned.endCol : lineSrc.length,
                word: aligned.ch,
                exact: true,
                occurrence: 1,
                total: 1,
                inMath: !!aligned.inMath,
            };
            // THE UNIT IS DIFFERENT IN PROSE. The alignment works character by
            // character, which is right inside an equation and wrong in a
            // sentence: clicking a word there would select one LETTER of it.
            // In prose the alignment's real contribution is the LINE — which is
            // the part SyncTeX gets wrong — so it fixes the line and the word
            // stays the unit.
            const isMath = (alignObj && MATH_KINDS.includes(alignObj.kind)) || aligned.inMath;
            if (isMath) {
                w = glyphToken;
            } else {
                const pw = m.word
                    ? findWordInLine(lineSrc, m.word, m.rowFraction ?? 0.5, { macros })
                    : null;
                w = (pw && pw.exact) ? pw : (pw || glyphToken);
            }
        }

        // A GLYPH THAT IS NOT ON ITS OWN LINE: in a multi-line display, TeX
        // attributes some records to a neighbouring source line (the \end, a
        // continuation), so the clicked symbol's real line may be another line
        // of the SAME equation. Before giving up on an exact match, search the
        // object's other lines, nearest first.
        if (!aligned && m.glyph && !(w && w.exact) && hit.object && !hit.object.approximate &&
            MATH_KINDS.includes(hit.object.kind) &&
            hit.object.endLine - hit.object.startLine < 12) {
            const near = [];
            for (let n = hit.object.startLine; n <= hit.object.endLine; n++) {
                if (n !== hit.line) near.push(n);
            }
            near.sort((a, b) => Math.abs(a - hit.line) - Math.abs(b - hit.line));
            for (const n of near) {
                if (n < 1 || n > doc.lineCount) continue;
                const src2 = doc.lineAt(n - 1).text;
                const g2 = findWordInLine(src2, m.glyph, m.glyphFraction ?? 0.5,
                    { scope: 'math', inMath: true, macros });
                if (g2 && g2.exact) {
                    w = g2;
                    hit.line = n;
                    lineIdx = n - 1;
                    lineSrc = src2;
                    break;
                }
            }
        }

        // WIDENING IS OPT-IN, ON Cmd/Ctrl.
        //
        // It used to happen on any repeat click in the same place, and that was
        // wrong: a plain click means "this symbol" essentially always, so a
        // reader clicking around to explore watched their selection grow from a
        // word to a subsection without asking for it. Now a plain click always
        // lands on the tightest thing, and holding Cmd walks outwards — the
        // first Cmd-click straight to the first container above the word, since
        // asking to widen and getting the word again would do nothing.
        const near = !!m.widen && this._ladder && this._ladder.page === m.page &&
            Math.hypot(m.xBp - this._ladder.xBp, m.yTopBp - this._ladder.yBp) < 36;
        if (near && this._ladder.items.length) {
            this._ladder.index = m.shrink
                ? Math.max(0, this._ladder.index - 1)
                : Math.min(this._ladder.items.length - 1, this._ladder.index + 1);
        } else {
            const model = this._modelFor(doc);
            const lines = doc.getText().split(/\r?\n/);
            let sections = [];
            try {
                sections = model ? sectionSpans(model.objects, lines.length, lines.length) : [];
            } catch (_) { /* the ladder still works without headings */ }
            const items = selectionLadder({
                lines, model, sections, file: hit.file, line: hit.line,
                column: w ? w.start : 0,
                word: w ? { start: w.start, end: w.end } : null,
            });
            this._ladder = {
                page: m.page, xBp: m.xBp, yBp: m.yTopBp, items, file: hit.file,
                index: m.widen ? Math.min(1, Math.max(0, items.length - 1)) : 0,
            };
        }

        let step = this._ladder.items[this._ladder.index];

        // A PLAIN CLICK NEVER SELECTS MORE THAN THE THING IT LANDED ON.
        //
        // The ladder's first rung is the word — unless no word resolved, in
        // which case the first rung is whatever comes next: the paragraph, or
        // with no paragraph, the SECTION. So a click whose word could not be
        // matched silently selected the whole section, which is what "I clicked
        // a word and got the whole paragraph" looks like from the outside.
        // Widening is opt-in on Cmd, and that has to hold even when the fine
        // resolution failed: the honest fallback is the line that was clicked.
        //
        // The commonest way to reach it is a click that lands BETWEEN words:
        // `wordAtPoint` in the webview refuses rather than claiming a glyph
        // several words away, so no word is sent, nothing resolves, and the
        // rung after `word` used to be taken instead.
        if (!m.widen && step && !PLAIN_CLICK_KINDS.has(step.kind)) step = null;
        // FULL SCREEN MUST SURVIVE A CLICK.
        //
        // Full screen is `toggleMaximizeEditorGroup`: only the viewer's group is
        // on screen. `showTextDocument` in column ONE makes that group visible
        // again, and VS Code cancels the maximize to do it — so every inverse
        // click dropped the reader out of full screen, which is precisely the
        // mode in which the mini-editor is the point.
        //
        // So while full screen: use an editor for this document only if one is
        // ALREADY visible, and otherwise move nothing. The card and the page
        // still get the answer. A double-click means "take me there" and is
        // supposed to leave full screen, so it still reveals.
        const inFullScreen = !!this._fsActions && !m.takeMe;
        const editor = inFullScreen
            ? (vscode.window.visibleTextEditors || [])
                .find(e => e.document && e.document.uri.fsPath === doc.uri.fsPath) || null
            : await vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: !m.takeMe,   // reading stays in the PDF; "go there" does not
                preview: false,
            });

        let range;
        let what;
        if (step) {
            range = new vscode.Range(
                new vscode.Position(step.start.line - 1, step.start.col),
                new vscode.Position(Math.min(step.end.line - 1, doc.lineCount - 1), step.end.col));
            const more = this._ladder.index < this._ladder.items.length - 1
                ? ` · ${process.platform === 'darwin' ? '⌘' : 'Ctrl+'}click to widen` : '';
            what = `${step.label} (line ${step.start.line})${more}`;
        } else {
            // SAY WHY THE ANSWER IS COARSE. This is the honest fallback, and
            // without a reason it reads as the feature simply misbehaving.
            range = doc.lineAt(lineIdx).range;
            what = `line ${hit.line} — ` + (m.word || m.glyph
                ? `no match for ${JSON.stringify(m.glyph || m.word)} here`
                : 'nothing under the pointer');
        }
        if (editor) {
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            // The page marks where you are with a wash that fades; the editor
            // end of the same gesture now does too, decaying into the ordinary
            // selection rather than just appearing there.
            this._flash.show(editor, range);
        }
        this._post({ type: 'status', text: `→ ${what}`, kind: 'ok' });

        // WITH A MINI-EDITOR OPEN, THE CARD IS THE EDITING SURFACE.
        //
        // The reader has a block open and clicks its rendered symbol: the caret
        // belongs where they pointed, in the card, not only in the text editor
        // behind it. Focus follows for a plain click (which leaves focus in the
        // webview anyway); a double-click means "take me to the editor", so it
        // must not be stolen back.
        this._postEditSelection(doc, range, !m.takeMe);

        // Show the widened container back in the PDF, so the reader can see
        // what a further click would grow past.
        if (step && step.kind !== 'word') this._showSpan(st, hit.file, step);

        // "Take me there": leave full screen, because the editor is what the
        // reader now wants to look at.
        if (m.takeMe && this._fsActions) await this.setFullScreen(false);
    }

    // --- comparing two versions ----------------------------------------------
    //
    // Read-only for now: what differs, named, and marked on the pages already on
    // screen. Accept comes next; see the plan's staged order and, in particular,
    // the four hazards it has to design around (checkWritable's baseline, our
    // own save waking the conflict modal, parking the other version before the
    // first write, and the compile storm).

    /**
     * Ask what to compare against, offering only what is actually available.
     *
     * A paper with no repository must not be shown a git option it cannot use,
     * and a paper identical to its file on disk must not offer that either —
     * an entry that leads to "no differences" is a wasted click.
     */
    async offerComparison() {
        if (!this.root) return;
        try {
            await vscode.commands.executeCommand('wolfbook.tex.compareWith');
        } catch (e) {
            this._post({ type: 'status', text: `could not compare: ${e.message}`, kind: 'err' });
        }
    }

    /** The render map, in the shape texCompare's placement rules expect. */
    _compareMap(st, file) {
        const map = st && st.map;
        if (!map || !map.available) return {};
        return {
            rowsFor: (line) => map.lineRows(file, line),
            objectAtLine: (line) => map.objectAtLine(file, line),
            objectRects: (obj) => {
                // objectRenderBoxes wants the model's own object, and its box
                // includes \abovedisplayskip — so prefer the object's ROWS,
                // exactly as the highlight path learned to.
                const rows = this._editRects(st, file, obj.startLine, obj.endLine);
                if (rows.length) return rows;
                const model = this._modelFor2(file);
                const real = model && model.objects.find(o => o.stableKey === obj.stableKey);
                if (!real) return [];
                const r = map.objectRenderBoxes(real);
                return (r && r.rects) || [];
            },
            locate: (startLine, endLine) => {
                const r = map.sourceToRender(file, startLine, endLine);
                return r ? { page: r.page, exact: r.exact, matchedLine: r.matchedLine } : null;
            },
        };
    }

    _modelFor2(file) {
        try {
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file);
            return doc ? this.projection.get(doc).model : null;
        } catch (_) { return null; }
    }

    /**
     * Compare the open paper against another version of it.
     *
     * @param {{text:string, label:string}} other
     */
    async compareWith(other) {
        if (!this.panel || !this.root) return;
        const st = this.coord.roots.get(this.root);
        if (!st) return;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.root)); }
        catch (e) {
            this._post({ type: 'status', text: `could not read the paper: ${e.message}`, kind: 'err' });
            return;
        }
        this._diff = {
            file: this.root,
            label: other.label,
            theirText: other.text,
            // WHICH SIDE IS OLDER. Comparing against a git revision, "theirs"
            // is the other version and a line only we have was added by us.
            // Comparing against what the file held BEFORE somebody else wrote
            // to it, the same hunk means they ADDED it. Same diff, opposite
            // reading — so the direction is carried rather than guessed, and
            // the presentation is swapped once, at the boundary.
            invert: !!other.invert,
            hunks: [], summary: {},
        };
        this.refreshComparison(doc.getText());
        const built = this._diff;
        if (!built.hunks.length) {
            this._post({ type: 'status', text: `no differences against ${other.label}`, kind: 'ok' });
        }
    }

    /**
     * Re-place the open comparison against the newest render.
     *
     * The pages move under a comparison: a recompile lands, lines shift, the
     * map is rebuilt. Rects measured against the previous generation would then
     * mark whatever now occupies that spot — the same trap the cursor highlight
     * hit, which is why it drops itself on a new generation. Here the answer is
     * to recompute rather than to discard, because the reader is in the middle
     * of working through a list.
     */
    refreshComparison(text) {
        const d = this._diff;
        if (!d) return;
        const st = this.coord.roots.get(this.root);
        if (!st) return;
        // The caller usually has the text already; otherwise find the open
        // document. If neither, keep the placement we have rather than
        // clearing a list the reader is working through.
        let ourText = typeof text === 'string' ? text : null;
        if (ourText == null) {
            const doc = (vscode.workspace.textDocuments || [])
                .find(x => x && x.uri && x.uri.fsPath === d.file);
            ourText = doc ? doc.getText() : null;
        }
        if (ourText == null) return;
        try {
            const built = buildComparison({
                ourText, theirText: d.theirText,
                map: this._compareMap(st, d.file),
            });
            d.hunks = built.hunks;
            d.summary = built.summary;
            d.baseText = ourText;
            this._postDiff();
        } catch (e) {
            this._log(`comparison failed: ${e.message}`);
        }
    }

    _postDiff() {
        const d = this._diff;
        if (!d) { this._post({ type: 'diff', session: null }); return; }
        // ONE FULL-STATE MESSAGE, not a family of incremental verbs — the
        // pattern the contribution-review panel already uses. The whole payload
        // is small because the hunk count is (a real collaborator revision of a
        // 793-line paper produced 19).
        this._post({
            type: 'diff',
            session: {
                label: d.label,
                file: path.basename(d.file),
                summary: d.summary,
                census: describeSummary(d.summary),
                hunks: d.hunks.map(h => ({
                    id: h.id,
                    // See `invert` above: presented from the reader's point of
                    // view, computed from ours.
                    kind: d.invert ? (h.kind === 'add' ? 'del' : h.kind === 'del' ? 'add' : h.kind) : h.kind,
                    where: h.where, confidence: h.confidence,
                    page: h.page, rects: h.rects, why: h.why,
                    name: h.object ? h.object.name : null,
                    startLine: h.ourRange.startLine,
                    ourText: h.ourText.slice(0, 400),
                    theirText: h.theirText.slice(0, 400),
                })),
            },
        });
    }

    closeComparison() {
        this._diff = null;
        this._post({ type: 'diff', session: null });
    }

    /** Reveal one hunk: scroll the page to it and put the cursor on its line. */
    async _focusHunk(id) {
        const d = this._diff;
        if (!d) return;
        const h = d.hunks.find(x => x.id === id);
        if (!h) return;
        this._post({ type: 'diffFocus', id, rects: h.rects, page: h.page });
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(d.file));
            const line = Math.max(0, Math.min(h.ourRange.startLine - 1, doc.lineCount - 1));
            const endLine = Math.max(0, Math.min(h.ourRange.endLine - 2, doc.lineCount - 1));
            const range = new vscode.Range(
                new vscode.Position(line, 0),
                new vscode.Position(Math.max(line, endLine), doc.lineAt(Math.max(line, endLine)).text.length));
            // While full screen, do not reveal — the same rule as an inverse
            // click, for the same reason.
            const editor = this._fsActions
                ? (vscode.window.visibleTextEditors || []).find(e => e.document && e.document.uri.fsPath === d.file)
                : await vscode.window.showTextDocument(doc, {
                    viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false,
                });
            if (editor) {
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                this._flash.show(editor, range);
            }
        } catch (_) { /* the page marker is the main event */ }
    }

    // --- the mini-editor: a block edited from the page itself ----------------
    //
    // Right-click on the page opens the paragraph or equation under the pointer
    // in a small editor pinned below its own rendered block. Everything typed
    // there is applied to the REAL text document through a WorkspaceEdit — same
    // undo stack, same live recompile, same diagnostics — so the mini-editor
    // and the text editor can never disagree: this class only tracks WHERE the
    // block is (as offsets, adjusted through every document change), never a
    // second copy of its content.

    _ensureDocListener() {
        if (this._docListener) return;
        this._docListener = vscode.workspace.onDidChangeTextDocument((e) => {
            try { this._onEditDocChange(e); } catch (_) { /* never break typing */ }
        });
        this._disposables.push(this._docListener);
    }

    /** The rows a line range printed — the card's anchor on the page. */
    _editRects(st, file, startLine, endLine) {
        const rects = [];
        if (endLine - startLine <= 60) {
            for (let n = startLine; n <= endLine; n++) {
                for (const r of st.map.lineRows(file, n)) {
                    rects.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h });
                }
            }
        }
        return rects;
    }

    async _openEditSession(m) {
        const st = this.root && this.coord.roots.get(this.root);
        if (!st || !st.map || !st.map.available) return;
        const hit = this._resolvePoint(st, m);
        if (!hit || hit.flag === FLAG.UNMAPPED || !hit.file) {
            this._post({ type: 'status', text: 'nothing editable there', kind: 'warn' });
            return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(hit.file));
        const lines = doc.getText().split(/\r?\n/);
        const line = Math.max(1, Math.min(hit.line, lines.length));

        // The CELL under the pointer: the innermost container object — an
        // equation, figure, theorem — else the prose paragraph.
        const model = this._modelFor(doc);
        const obj = ((model && model.objects) || [])
            .filter(o => o.sourceRange && CONTAINER_KINDS.has(o.kind) &&
                (!o.sourceRange.file || o.sourceRange.file === hit.file) &&
                o.sourceRange.startLine <= line && o.sourceRange.endLine >= line)
            .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
                (b.sourceRange.endLine - b.sourceRange.startLine))[0];
        let startLine; let endLine; let label;
        if (obj && obj.sourceRange.endLine - obj.sourceRange.startLine <= 80) {
            startLine = obj.sourceRange.startLine;
            endLine = obj.sourceRange.endLine;
            label = obj.label ? `${obj.kind} ${obj.label}` : (obj.envName || obj.kind);
        } else {
            const para = paragraphSpan(lines, line);
            if (para) { startLine = para.startLine; endLine = para.endLine; label = 'paragraph'; }
            else { startLine = line; endLine = line; label = `line ${line}`; }
        }

        const startPos = new vscode.Position(startLine - 1, 0);
        const endPos = new vscode.Position(endLine - 1, (lines[endLine - 1] || '').length);
        const s = {
            id: ++this._editSeq,
            file: hit.file,
            startOffset: doc.offsetAt(startPos),
            endOffset: doc.offsetAt(endPos),
            lastText: doc.getText(new vscode.Range(startPos, endPos)),
        };
        this._edit = s;
        this._ensureDocListener();
        const rects = this._editRects(st, hit.file, startLine, endLine);
        this._post({
            type: 'editOpen',
            editId: s.id,
            label,
            file: path.basename(hit.file),
            startLine,
            endLine,
            text: s.lastText,
            // With no printed rows to hang off (a figure, an unmapped block),
            // the click point itself anchors the card.
            rects: rects.length ? rects
                : [{ page: m.page, x: m.xBp - 2, y: m.yTopBp - 2, w: 4, h: 4 }],
        });
    }

    async _applyEditChange(m) {
        const s = this._edit;
        if (!s || m.editId !== s.id || typeof m.text !== 'string') return;
        if (m.text === s.lastText) return;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
            const range = new vscode.Range(
                doc.positionAt(s.startOffset), doc.positionAt(s.endOffset));
            // Set BEFORE applying: the change event this edit fires must read
            // as our own echo, not as an update to send back to the card.
            s.lastText = m.text;
            const we = new vscode.WorkspaceEdit();
            we.replace(doc.uri, range, m.text);
            const ok = await vscode.workspace.applyEdit(we);
            if (!ok) this._post({ type: 'status', text: 'the edit could not be applied', kind: 'err' });
        } catch (e) {
            this._post({ type: 'status', text: `edit failed: ${e.message}`, kind: 'err' });
        }
    }

    /**
     * Every document change — ours or the reader's — moves the tracked block.
     * Offsets are adjusted through each change; if the text inside the block
     * then differs from what the card last saw, the card is updated. Our own
     * applyEdit produces text identical to `lastText`, so it never echoes.
     */
    _onEditDocChange(e) {
        const s = this._edit;
        if (!s || !e || !e.document || e.document.uri.fsPath !== s.file) return;
        for (const c of e.contentChanges || []) {
            const grew = (c.text ? c.text.length : 0);
            const delta = grew - c.rangeLength;
            const cs = c.rangeOffset;
            const ce = c.rangeOffset + c.rangeLength;
            if (ce <= s.startOffset) { s.startOffset += delta; s.endOffset += delta; }
            else if (cs >= s.endOffset) { /* below the block — nothing moves */ }
            else {
                s.startOffset = Math.min(s.startOffset, cs);
                s.endOffset = Math.max(s.endOffset + delta, cs + grew);
            }
        }
        const doc = e.document;
        s.endOffset = Math.min(s.endOffset, doc.getText().length);
        s.startOffset = Math.max(0, Math.min(s.startOffset, s.endOffset));
        const a = doc.positionAt(s.startOffset);
        const b = doc.positionAt(s.endOffset);
        const text = doc.getText(new vscode.Range(a, b));
        if (text === s.lastText) return;
        s.lastText = text;
        this._post({
            type: 'editUpdate', editId: s.id, text,
            startLine: a.line + 1, endLine: b.line + 1,
        });
    }

    /**
     * Mirror an inverse-search hit into the open mini-editor.
     *
     * The card holds the block's text, so the same range expressed relative to
     * the block start is where the caret goes. A hit OUTSIDE the open block is
     * deliberately ignored: moving the card to wherever the reader last clicked
     * would take the block they are editing off the screen. Right-click is how
     * you move it.
     */
    _postEditSelection(doc, range, focus) {
        const s = this._edit;
        if (!s || !doc || !range || doc.uri.fsPath !== s.file) return;
        let a; let b;
        try { a = doc.offsetAt(range.start); b = doc.offsetAt(range.end); }
        catch (_) { return; }
        if (b < s.startOffset || a > s.endOffset) return;
        const clamp = (n) => Math.max(0, Math.min(n, s.endOffset) - s.startOffset);
        this._post({
            type: 'editSelect', editId: s.id, focus: !!focus,
            start: clamp(Math.max(a, s.startOffset)),
            end: clamp(Math.max(b, s.startOffset)),
        });
    }

    /** After a recompile the block has new geometry — move the card to it. */
    async _postEditAnchor() {
        const s = this._edit;
        const st = this.root && this.coord.roots.get(this.root);
        if (!s || !st || !st.map || !st.map.available) return;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
            const a = doc.positionAt(s.startOffset);
            const b = doc.positionAt(s.endOffset);
            const rects = this._editRects(st, s.file, a.line + 1, b.line + 1);
            if (rects.length) this._post({ type: 'editAnchor', editId: s.id, rects });
        } catch (_) { /* keep the old anchor */ }
    }

    async _saveEditDoc() {
        const s = this._edit;
        if (!s) return;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
            const ok = await doc.save();
            this._post({ type: 'status', text: ok ? `saved ${path.basename(s.file)}` : 'nothing to save', kind: 'ok' });
        } catch (e) {
            this._post({ type: 'status', text: `save failed: ${e.message}`, kind: 'err' });
        }
    }

    async _revealEditRange() {
        const s = this._edit;
        if (!s) return;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
        const range = new vscode.Range(doc.positionAt(s.startOffset), doc.positionAt(s.endOffset));
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false,
        });
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    /** Paint a source line range back onto the pages, within reason. */
    _showSpan(st, file, step) {
        const MAX_LINES = 60;      // a whole section is thousands of rows
        const rects = [];
        if (step.lines <= MAX_LINES) {
            for (let n = step.start.line; n <= step.end.line; n++) {
                for (const r of st.map.lineRows(file, n)) {
                    rects.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h });
                }
            }
        }
        const a = st.map.sourceToRender(file, step.start.line);
        const b = st.map.sourceToRender(file, step.end.line);
        const pages = a.page && b.page && a.page !== b.page ? ` · pp.${a.page}–${b.page}`
            : (a.page ? ` · p.${a.page}` : '');
        this._post({
            type: 'highlight',
            rects,
            flag: 'approx',
            reveal: false,
            label: `${step.label}${pages}` +
                (rects.length ? '' : ' — too large to outline'),
        });
    }

    _modelFor(doc) {
        try { return this.projection.get(doc).model; } catch (_) { return null; }
    }

    /**
     * Full screen, reversed by exactly the commands that produced it.
     *
     * VS Code offers several ways to get there and they are not all present in
     * every build, so the ones that exist are discovered at runtime and the
     * list of what actually ran is kept — undoing a toggle we never fired
     * would leave the window in a state the reader did not ask for.
     */
    async setFullScreen(on) {
        if (!this.panel) return;
        if (!!on === !!this._fsActions) return;
        if (on) {
            const mode = vscode.workspace.getConfiguration('wolfbook.tex')
                .get('fullScreenMode', 'maximize');
            const want = mode === 'zen' ? ['workbench.action.toggleZenMode']
                : mode === 'fullScreen'
                    ? ['workbench.action.toggleMaximizeEditorGroup', 'workbench.action.toggleFullScreen']
                    : ['workbench.action.toggleMaximizeEditorGroup'];
            const all = new Set(await vscode.commands.getCommands(true));
            // Maximising acts on the ACTIVE group, so the panel has to be it.
            this.panel.reveal(this.panel.viewColumn, false);
            const done = [];
            for (const c of want) {
                if (!all.has(c)) continue;
                try { await vscode.commands.executeCommand(c); done.push(c); } catch (_) { /* skip */ }
            }
            this._fsActions = done.length ? done : null;
            if (!this._fsActions) {
                this._post({ type: 'status', text: 'this VS Code build has no full-screen command', kind: 'warn' });
            }
        } else {
            for (const c of [...this._fsActions].reverse()) {
                try { await vscode.commands.executeCommand(c); } catch (_) { /* best effort */ }
            }
            this._fsActions = null;
        }
        this._post({ type: 'fullscreen', value: !!this._fsActions });
    }

    _post(msg) { if (this.panel) this.panel.webview.postMessage(msg); }

    _html() {
        const w = this.panel.webview;
        const script = w.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'out', 'client', 'tex-viewer.js'));
        const nonce = String(Math.random()).slice(2) + Date.now().toString(36);
        // pdf.js needs `wasm-unsafe-eval` for its own decoders; everything else
        // is locked down. `blob:` covers the worker pdf.js may spin up.
        const csp = [
            `default-src 'none'`,
            `img-src ${w.cspSource} blob: data:`,
            `style-src ${w.cspSource} 'unsafe-inline'`,
            `font-src ${w.cspSource} data:`,
            `script-src ${w.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
            `worker-src ${w.cspSource} blob:`,
            `connect-src ${w.cspSource} blob: data:`,
        ].join('; ');

        // The markup lives in its own file so the headless check can serve the
        // SAME bytes. It went unnoticed for a whole feature that the harness
        // was exercising a hand-written page instead of this one.
        const shell = fs.readFileSync(path.join(
            this.context.extensionUri.fsPath, 'out', 'client', 'tex-viewer.shell.html'), 'utf8');

        return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head><body>
${shell}
<script nonce="${nonce}" type="module" src="${script}"></script>
</body></html>`;
    }
}

const shortLabel = (o) =>
    o.kind === 'display-equation' ? (o.label ? `eq ${o.label}` : 'equation')
        : o.kind === 'section-heading' ? `§ ${o.title || ''}`.trim()
            : o.label ? `${o.kind} ${o.label}` : o.kind;

module.exports = { TexViewer, VIEW_TYPE };
