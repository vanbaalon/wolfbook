// reviewUi.js — the four surfaces of a review, and the only place they live.
//
// The session (tex/reviewSession.js) knows WHAT is undecided; this knows how
// the reader is told and how they answer. One fact, one place, one visual
// language:
//
//   the status bar   there is something to look at, and how much
//   one toast        a batch arrived while you were not looking (once, never nagging)
//   the editor       every pending change marked in the standard diff colours,
//                    with a CodeLens carrying the two verdicts
//   WPaper           the list, grouped by arrival, and the change on the page
//
// WHAT THIS DELIBERATELY DOES NOT DO: touch the reader's selection. Focusing a
// change used to SET `editor.selection`, which throws away whatever the reader
// had selected and paints a blue block that reads as neither a diff nor a
// cursor. A decoration and a reveal say the same thing and cost nothing.

const vscode = require('vscode');
const path = require('path');

const { ReviewSession } = require('./reviewSession');
const { refineHunk, splitLines } = require('./texDiff');
const bus = require('./reviewBus');

const CMD = {
    OPEN: 'wolfbook.tex.review',
    NEXT: 'wolfbook.tex.reviewNext',
    PREV: 'wolfbook.tex.reviewPrev',
    KEEP: 'wolfbook.tex.reviewKeep',
    UNDO: 'wolfbook.tex.reviewUndo',
    KEEP_ALL: 'wolfbook.tex.reviewKeepAll',
    UNDO_ALL: 'wolfbook.tex.reviewUndoAll',
    SHOW: 'wolfbook.tex.reviewShow',
    CLOSE: 'wolfbook.tex.reviewClose',
};

/** The standard diff colours, so a reviewed paper looks like every other diff. */
function makeDecorations() {
    const lane = (vscode.OverviewRulerLane && vscode.OverviewRulerLane.Left) ?? 1;
    const line = (bg, ruler, gutter, color) => vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor(bg),
        overviewRulerColor: new vscode.ThemeColor(ruler),
        overviewRulerLane: lane,
        before: {
            contentText: gutter,
            color: new vscode.ThemeColor(color),
            margin: '0 6px 0 0',
            width: '10px',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    return {
        add: line('diffEditor.insertedTextBackground', 'editorOverviewRuler.addedForeground', '+', 'gitDecoration.addedResourceForeground'),
        change: line('diffEditor.insertedTextBackground', 'editorOverviewRuler.modifiedForeground', '~', 'gitDecoration.modifiedResourceForeground'),
        // A deletion has no lines of its own: mark the seam it happened at.
        del: vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            borderWidth: '0 0 2px 0',
            borderStyle: 'solid',
            borderColor: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
            overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
            overviewRulerLane: lane,
            before: {
                contentText: '−',
                color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
                margin: '0 6px 0 0',
                width: '10px',
            },
        }),
        // The words that differ, a step stronger than the line wash.
        word: vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
            borderRadius: '2px',
        }),
        // The one being looked at.
        focus: vscode.window.createTextEditorDecorationType({
            border: '1px solid',
            borderColor: new vscode.ThemeColor('focusBorder'),
            borderRadius: '3px',
            isWholeLine: true,
        }),
    };
}

function safeStatusItem() {
    try {
        const align = (vscode.StatusBarAlignment && vscode.StatusBarAlignment.Right) ?? 2;
        const item = vscode.window.createStatusBarItem(align, 98);
        if (item && typeof item.show === 'function') return item;
    } catch (_) { /* no status bar in this host */ }
    return { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
}

/** A decoration set that draws nothing — used when the host has no API for it. */
function noDecorations() {
    const nul = { dispose() {} };
    return { add: nul, change: nul, del: nul, word: nul, focus: nul };
}

class ReviewUi {
    /**
     * @param {object} o
     * @param {object} o.coord      the render coordinator (roots, stateFor, rootFor)
     * @param {object} o.viewer     the WPaper panel
     * @param {object} o.output     the output channel
     * @param {(file:string)=>object} o.mapView   the injected compare view
     */
    constructor(o = {}) {
        this.coord = o.coord;
        this.viewer = o.viewer;
        this.output = o.output || { appendLine() {} };
        this.mapView = o.mapView || (() => ({}));
        this.sessions = new Map();      // file -> ReviewSession
        this.focused = new Map();       // file -> hunk id
        this._decor = null;
        this._disposables = [];
        this._lensEmitter = new vscode.EventEmitter();
        this._toasting = new Set();

        // A SURFACE MUST NEVER BE ABLE TO BREAK WHAT IT REPORTS ON. Hosts
        // differ in what they expose (a test stub has no status bar at all),
        // and a review that cannot draw its own item is still a review.
        this.status = safeStatusItem();
        this.status.command = CMD.OPEN;
        this._disposables.push(this.status, this._lensEmitter);
    }

    get decor() {
        if (!this._decor) {
            try { this._decor = makeDecorations(); }
            catch (_) { this._decor = noDecorations(); }
        }
        return this._decor;
    }

    dispose() {
        for (const d of this._disposables) { try { d.dispose(); } catch (_) { /* going away */ } }
        if (this._decor) for (const t of Object.values(this._decor)) { try { t.dispose(); } catch (_) { /* idem */ } }
    }

    // ------------------------------------------------------------- sessions --

    sessionFor(file) { return this.sessions.get(file) || null; }

    /**
     * An agent changed the paper. `baseText` is what the file held BEFORE the
     * change and is used only when a session is opened — an arriving change
     * never moves the baseline of a review already in progress, which is the
     * whole of the reported "the previous changes disappear as if approved".
     */
    async noteAgentChange(o = {}) {
        const file = o.file;
        if (!file) return null;
        let s = this.sessions.get(file);
        if (!s) {
            if (typeof o.baseText !== 'string') return null;
            s = new ReviewSession({ file, baseText: o.baseText });
            this.sessions.set(file, s);
        }
        s.noteBatch({ source: o.source || 'disk', note: o.note || '' });
        await this.refresh(file, { announce: true });
        return s;
    }

    /** Re-diff and repaint every surface. Never throws. */
    async refresh(file, opts = {}) {
        const s = this.sessions.get(file);
        if (!s) { this.paint(file); this.updateStatus(); this.push(file); return; }
        let text = null;
        const doc = (vscode.workspace.textDocuments || []).find(d => d.uri.fsPath === file);
        if (doc) text = doc.getText();
        else {
            try { text = require('fs').readFileSync(file, 'utf8'); } catch (_) { text = null; }
        }
        if (text == null) return;
        try { s.update({ currentText: text, map: this.mapView(file) }); }
        catch (e) { this.output.appendLine(`review: ${e.message}`); }

        if (s.isEmpty) this.sessions.delete(file);
        this.paint(file);
        this.updateStatus();
        this.push(file);
        this._lensEmitter.fire();
        if (opts.announce) this.announce(file);
    }

    /** Close a review without deciding anything: the changes simply stay. */
    close(file) {
        this.sessions.delete(file);
        this.focused.delete(file);
        this.paint(file);
        this.updateStatus();
        this.push(file);
        this._lensEmitter.fire();
    }

    // -------------------------------------------------------------- notice --

    /** One toast per batch, and only when the list is not already on screen. */
    announce(file) {
        const s = this.sessions.get(file);
        if (!s) return;
        const unseen = s.unseenBatches;
        if (!unseen.length) return;
        const showing = this.viewer && this.viewer.isOpen && this.viewer.isOpen() &&
            this.viewer.root === file && this.viewer.reviewVisible;
        for (const b of unseen) s.markSeen(b.id);
        if (showing || this._toasting.has(file)) return;
        const n = s.pendingCount;
        this._toasting.add(file);
        const name = path.basename(file);
        vscode.window.showInformationMessage(
            `The agent changed ${n} place${n === 1 ? '' : 's'} in ${name}.`,
            'Review', 'Keep all',
        ).then(async (pick) => {
            this._toasting.delete(file);
            if (pick === 'Review') await vscode.commands.executeCommand(CMD.OPEN);
            else if (pick === 'Keep all') await this.keepAll(file);
        }, () => { this._toasting.delete(file); });
    }

    updateStatus() {
        let pending = 0;
        for (const s of this.sessions.values()) pending += s.pendingCount;
        if (!pending) { this.status.hide(); return; }
        this.status.text = `$(git-compare) ${pending} change${pending === 1 ? '' : 's'} to review`;
        this.status.tooltip = 'WPaper: review what the agent changed';
        this.status.backgroundColor = undefined;
        this.status.show();
    }

    /** The panel's copy of the list. */
    push(file) {
        if (!this.viewer || !this.viewer.showReview) return;
        if (this.viewer.root && file && this.viewer.root !== file) return;
        const s = file ? this.sessions.get(file) : null;
        this.viewer.showReview(s ? s.payload({ focus: this.focused.get(file) || null }) : null);
    }

    // -------------------------------------------------------------- editor --

    /** Every pending change, marked in the editors showing that file. */
    paint(file) {
        const editors = (vscode.window.visibleTextEditors || [])
            .filter(e => e.document && e.document.uri.fsPath === file);
        if (!editors.length) return;
        const s = this.sessions.get(file);
        const d = this.decor;
        if (!s || s.isEmpty) {
            for (const e of editors) {
                for (const t of [d.add, d.change, d.del, d.word, d.focus]) {
                    try { e.setDecorations(t, []); } catch (_) { /* editor going away */ }
                }
            }
            return;
        }
        const focusId = this.focused.get(file);
        for (const e of editors) {
            const doc = e.document;
            const clamp = (l) => Math.max(0, Math.min(l, doc.lineCount - 1));
            const buckets = { add: [], change: [], del: [], word: [], focus: [] };
            for (const h of s.hunks) {
                const from = clamp(h.ourRange.startLine - 1);
                const to = clamp(h.ourRange.endLine - 2);
                const whole = new vscode.Range(from, 0, Math.max(from, to), 0);
                if (h.verb === 'del') {
                    const seam = clamp(h.ourRange.startLine - 2);
                    buckets.del.push({
                        range: new vscode.Range(seam, 0, seam, 0),
                        hoverMessage: removedHover(h),
                    });
                } else {
                    buckets[h.verb === 'add' ? 'add' : 'change'].push({
                        range: whole,
                        hoverMessage: changeHover(h),
                    });
                    if (h.verb === 'change') {
                        for (const r of wordRanges(doc, h, clamp)) buckets.word.push(r);
                    }
                }
                if (h.id === focusId) buckets.focus.push({ range: whole });
            }
            for (const k of ['add', 'change', 'del', 'word', 'focus']) {
                try { e.setDecorations(d[k], buckets[k]); } catch (_) { /* idem */ }
            }
        }
    }

    /** `✓ Keep · ↺ Undo · ▸ Show on page`, above each pending change. */
    lensProvider() {
        const self = this;
        return {
            onDidChangeCodeLenses: this._lensEmitter.event,
            provideCodeLenses(doc) {
                const s = self.sessions.get(doc.uri.fsPath);
                if (!s || s.isEmpty) return [];
                const out = [];
                for (const h of s.hunks) {
                    const line = Math.max(0, Math.min(h.ourRange.startLine - 1, doc.lineCount - 1));
                    const at = new vscode.Range(line, 0, line, 0);
                    const arg = [doc.uri.fsPath, h.id];
                    out.push(new vscode.CodeLens(at, { title: '$(check) Keep', command: CMD.KEEP, arguments: arg }));
                    if (!s.edited.has(h.id)) {
                        out.push(new vscode.CodeLens(at, { title: '$(discard) Undo', command: CMD.UNDO, arguments: arg }));
                    }
                    out.push(new vscode.CodeLens(at, { title: '$(book) Show on page', command: CMD.SHOW, arguments: arg }));
                    out.push(new vscode.CodeLens(at, { title: describeHunk(h, s), command: '' }));
                }
                return out;
            },
        };
    }

    // ------------------------------------------------------------ verdicts --

    async keep(file, id) {
        const s = this.sessions.get(file);
        if (!s) return;
        const r = s.keep(id);
        if (!r.ok) { this.say(r.reason, 'warn'); return; }
        await this.refresh(file);
    }

    async keepAll(file) {
        const s = this.sessions.get(file);
        if (!s) return;
        const n = s.pendingCount;
        const r = s.keepAll();
        if (!r.ok) { this.say(r.reason, 'warn'); return; }
        await this.refresh(file);
        this.say(`kept ${n} change${n === 1 ? '' : 's'}`, 'ok');
    }

    async keepBatch(file, batchId) {
        const s = this.sessions.get(file);
        if (!s) return;
        s.keepBatch(batchId);
        await this.refresh(file);
    }

    async undo(file, id) {
        const s = this.sessions.get(file);
        if (!s) return;
        const r = s.undo(id);
        if (!r.ok) { this.say(r.reason, 'warn'); return; }
        const applied = await this.applyEdits(file, r.edits);
        if (applied) { s.noteUndone(id); await this.refresh(file); }
    }

    async undoAll(file) {
        const s = this.sessions.get(file);
        if (!s) return;
        const r = s.undoAll();
        if (!r.edits.length) { this.say('nothing here can be undone', 'warn'); return; }
        const applied = await this.applyEdits(file, r.edits);
        if (applied) {
            await this.refresh(file);
            this.say(`undid ${r.undone.length} change${r.undone.length === 1 ? '' : 's'}` +
                (r.refused.length ? `, kept ${r.refused.length} you had edited` : ''), 'ok');
        }
    }

    /**
     * ONE WorkspaceEdit, SO IT IS ONE ⌘Z. The session speaks in whole lines;
     * this is where they become a range in a real document — clamped, because a
     * range that runs past the end of the file is rejected outright and would
     * lose the whole undo.
     */
    async applyEdits(file, edits) {
        if (!edits || !edits.length) return false;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file)); }
        catch (e) { this.say(`could not open ${path.basename(file)}: ${e.message}`, 'err'); return false; }
        const we = new vscode.WorkspaceEdit();
        this._applying = true;
        for (const e of edits) {
            const startLine = Math.max(0, Math.min(e.startLine - 1, doc.lineCount));
            const endLine = Math.max(startLine, Math.min(e.endLine - 1, doc.lineCount));
            const atEof = endLine >= doc.lineCount;
            const start = new vscode.Position(startLine, 0);
            const end = atEof
                ? new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
                : new vscode.Position(endLine, 0);
            let text = e.lines.length ? e.lines.join('\n') : '';
            if (text && !atEof) text += '\n';
            if (!text && atEof && startLine > 0) {
                we.delete(doc.uri, new vscode.Range(new vscode.Position(startLine - 1, doc.lineAt(startLine - 1).text.length), end));
                continue;
            }
            we.replace(doc.uri, new vscode.Range(start, end), text);
        }
        let ok = false;
        try { ok = await vscode.workspace.applyEdit(we); }
        catch (e) { this.say(`the undo could not be applied: ${e.message}`, 'err'); }
        this._applying = false;
        if (!ok) this.say('the undo was rejected by the editor', 'err');
        return ok;
    }

    /** Show a change: the page scrolls to it, the editor reveals it. */
    async show(file, id) {
        const s = this.sessions.get(file);
        if (!s) return;
        const h = s.hunks.find(x => x.id === id);
        if (!h) return;
        this.focused.set(file, id);
        this.paint(file);
        this.push(file);
        if (this.viewer && this.viewer.focusReviewHunk) this.viewer.focusReviewHunk(h);
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            const line = Math.max(0, Math.min(h.ourRange.startLine - 1, doc.lineCount - 1));
            const editor = (vscode.window.visibleTextEditors || [])
                .find(e => e.document && e.document.uri.fsPath === file) ||
                await vscode.window.showTextDocument(doc, {
                    viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false,
                });
            // THE SELECTION IS THE READER'S. Reveal, never select.
            if (editor) {
                editor.revealRange(new vscode.Range(line, 0, line, 0),
                    vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                this.paint(file);
            }
        } catch (_) { /* the page marker is the main event */ }
    }

    step(file, delta) {
        const s = this.sessions.get(file);
        if (!s || s.isEmpty) return;
        const ids = s.hunks.map(h => h.id);
        const cur = ids.indexOf(this.focused.get(file));
        const next = ids[((cur < 0 ? -1 : cur) + delta + ids.length * 2) % ids.length];
        return this.show(file, next);
    }

    say(text, kind) {
        this.output.appendLine(`review: ${text}`);
        if (this.viewer && this.viewer.status) this.viewer.status(text, kind);
        else if (kind === 'err') vscode.window.showWarningMessage(text);
    }

    // ------------------------------------------------------------- wiring ---

    /** The file the commands act on: the paper in front, else the only review. */
    activeFile() {
        const ed = vscode.window.activeTextEditor;
        if (ed && /\.tex$/i.test(ed.document.uri.fsPath) && this.sessions.has(ed.document.uri.fsPath)) {
            return ed.document.uri.fsPath;
        }
        if (this.viewer && this.viewer.root && this.sessions.has(this.viewer.root)) return this.viewer.root;
        const keys = [...this.sessions.keys()];
        return keys.length === 1 ? keys[0] : (keys[0] || null);
    }

    register(context) {
        const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
        const withFile = (fn) => async (file, id) => {
            const f = typeof file === 'string' ? file : this.activeFile();
            if (!f) { this.say('nothing is waiting to be reviewed', 'warn'); return; }
            await fn(f, id);
        };
        reg(CMD.OPEN, withFile(async (f) => {
            if (this.viewer && this.viewer.openReview) await this.viewer.openReview();
            this.push(f);
        }));
        reg(CMD.KEEP, withFile((f, id) => this.keep(f, id || this.focused.get(f))));
        reg(CMD.UNDO, withFile((f, id) => this.undo(f, id || this.focused.get(f))));
        reg(CMD.SHOW, withFile((f, id) => this.show(f, id || this.focused.get(f))));
        reg(CMD.KEEP_ALL, withFile((f) => this.keepAll(f)));
        reg(CMD.UNDO_ALL, withFile((f) => this.undoAll(f)));
        reg(CMD.NEXT, withFile((f) => this.step(f, +1)));
        reg(CMD.PREV, withFile((f) => this.step(f, -1)));
        reg(CMD.CLOSE, withFile((f) => this.close(f)));

        // The reader's own typing moves the baseline with them (see the session)
        // — except inside a pending change, which it flags instead.
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
            const file = e.document.uri.fsPath;
            const s = this.sessions.get(file);
            if (!s || !e.contentChanges.length) return;
            if (!this._applying) {
                for (const c of e.contentChanges) {
                    try { s.noteReaderEdit({ offset: c.rangeOffset, length: c.rangeLength, text: c.text }); }
                    catch (_) { /* an unmirrorable edit is not fatal */ }
                }
            }
            clearTimeout(this._debounce);
            this._debounce = setTimeout(() => { this.refresh(file); }, 250);
        }));
        context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
            for (const f of this.sessions.keys()) this.paint(f);
        }));

        // An edit made through the MCP tool never reaches the file watcher —
        // it goes through a WorkspaceEdit on the open buffer. Without this the
        // tool the agent is told to use is the one whose edits cannot be seen.
        context.subscriptions.push(bus.onAgentEdit(async (ev) => {
            try {
                await this.noteAgentChange({
                    file: ev.file, baseText: ev.baseText,
                    source: ev.source || 'paper_applyEdit', note: ev.note || '',
                });
            } catch (e) { this.output.appendLine(`review: ${e.message}`); }
        }));

        context.subscriptions.push({ dispose: () => this.dispose() });
    }
}

// ----------------------------------------------------------------- helpers --

function describeHunk(h, s) {
    const n = Math.max(h.ourRange.endLine - h.ourRange.startLine,
        h.theirRange.endLine - h.theirRange.startLine);
    const what = h.verb === 'add' ? `${n} line${n === 1 ? '' : 's'} added`
        : h.verb === 'del' ? `${n} line${n === 1 ? '' : 's'} removed`
            : `${h.changedWords || 0} word${h.changedWords === 1 ? '' : 's'} changed`;
    return s.edited.has(h.id) ? `${what} · you have edited this since` : what;
}

function changeHover(h) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(h.verb === 'add' ? '**The agent added this.**\n\n' : '**The agent changed this.**\n\n');
    if (h.verb === 'change' && h.theirText) {
        md.appendMarkdown('Before:\n');
        md.appendCodeblock(h.theirText.slice(0, 800), 'latex');
    }
    return md;
}

function removedHover(h) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**The agent removed this.**\n\n');
    md.appendCodeblock(String(h.theirText || '').slice(0, 800), 'latex');
    return md;
}

/** The words that differ inside a changed hunk, as ranges in the document. */
function wordRanges(doc, h, clamp) {
    const out = [];
    try {
        const { aRanges } = refineHunk(h.ourText, h.theirText);
        const lines = splitLines(h.ourText);
        for (const r of aRanges) {
            if (r.line >= lines.length) continue;
            const line = clamp(h.ourRange.startLine - 1 + r.line);
            const text = doc.lineAt(line).text;
            const from = Math.min(r.col, text.length);
            const to = Math.min(r.col + r.len, text.length);
            if (to > from) out.push({ range: new vscode.Range(line, from, line, to) });
        }
    } catch (_) { /* the line wash is enough */ }
    return out;
}

module.exports = { ReviewUi, CMD, makeDecorations, describeHunk };
