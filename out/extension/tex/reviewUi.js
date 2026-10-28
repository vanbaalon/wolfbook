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
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const textHash = text => typeof text === 'string' ? crypto.createHash('sha256').update(text).digest('hex') : undefined;

const { ReviewSession } = require('./reviewSession');
const { refineHunk, splitLines, diffLines } = require('./texDiff');
const { mergeThreeWay } = require('./threeWay');
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
            backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
            borderWidth: '0 0 2px 0',
            borderStyle: 'solid',
            borderColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
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
        this._agentWriting = new Map();   // file -> when the tool started writing
        this._merging = new Set();        // files whose buffer we are rebasing right now
        this._placeTimer = null;          // coalesces re-placement across one compile
        this._archived = new Map();
        this._observed = new Map();
        this._store = null;
        this._hidden = new Set();
        this._buffers = new Map();
        this._userWriting = new Map();
        this._readerPending = new Map(); // known user text awaiting VS Code's dirty metadata

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
        if (this._placeTimer) { clearTimeout(this._placeTimer); this._placeTimer = null; }
        for (const d of this._disposables) { try { d.dispose(); } catch (_) { /* going away */ } }
        if (this._decor) for (const t of Object.values(this._decor)) { try { t.dispose(); } catch (_) { /* idem */ } }
    }

    // ------------------------------------------------------------- sessions --

    /**
     * One place a session is born, so the grouping window is the same wherever
     * a change comes from — the file watcher, the MCP tool, or a merge.
     */
    _historyOptions(file) {
        try {
            const cfg=vscode.workspace.getConfiguration('wolfbook.tex.review',vscode.Uri.file(file));
            return {historyLimit:cfg.get('historyLimit',20),historyMaxMB:cfg.get('historyMaxMB',20)};
        } catch (_) {return {};}
    }
    _newSession(file, baseText, currentText) {
        let seconds = 60;
        try {
            const cfg = vscode.workspace.getConfiguration('wolfbook.tex.review');
            const v = cfg && cfg.get('groupWindowSeconds', 60);
            if (Number.isFinite(v) && v >= 0) seconds = v;
        } catch (_) { /* no configuration in this host */ }
        const previous = this._archived.get(file);
        let checkpoint;
        if (previous?.isEmpty && (previous.baseText === currentText ||
            (previous.reviewedObservedHash && previous.reviewedObservedHash === textHash(baseText)))) {
            // Keep can approve an unsaved buffer. The disk observation may
            // still predate that approval when the next host starts.
            checkpoint = previous.reviewedObservedHash || textHash(baseText);
            baseText = previous.baseText;
        }
        const session = new ReviewSession({ file, baseText, groupWindowMs: seconds * 1000,...this._historyOptions(file) });
        session.reviewedObservedHash = checkpoint;
        if (previous) { session.feedback = previous.feedback.slice(); session.feedbackDraft = previous.feedbackDraft; session.arrivals = previous.arrivals.slice(); }
        return session;
    }

    sessionFor(file) { this._syncStored(file); return this.sessions.get(file) || null; }

    _restoreRecord(record) {
        if (typeof record.observed === 'string') this._observed.set(record.file, record.observed);
        const s = record.session ? ReviewSession.restore(record.session,this._historyOptions(record.file)) : null;
        // Another window's approval changes the baseline only. Reuse this
        // viewer's current map when the stored source still matches, so its
        // remaining corrections do not become permanently "Preparing".
        if (s && this._currentText(record.file)===s._lastText) {
            try { s.update({currentText:s._lastText,map:this.mapView(record.file)}); } catch (_) { /* no current map yet */ }
        }
        this.sessions.delete(record.file);
        if (!s) this._archived.delete(record.file);
        else {
            this._archived.set(record.file, s);
            if (!s.isEmpty) this.sessions.set(record.file, s);
        }
    }
    _syncStored(file) {
        if (!this._store) return;
        try {
            const record = this._store.changed(file);
            if (record) this._restoreRecord(record);
        } catch (error) { this.say('Saved review could not be refreshed: ' + error.message, 'err'); }
    }
    _checkpointFinished(file, session) {
        if (session.isEmpty && session._everHad) session.reviewedObservedHash = textHash(this._observed.get(file));
    }
    persist(file, session = this.sessions.get(file) || this._archived.get(file)) {
        if (!this._store) return true;
        try {
            const result = this._store.save({ file, observed: this._observed.get(file), session: session?.serialize() || null });
            if (result?.conflict) { this._restoreRecord(result.conflict); return false; }
            return true;
        } catch (error) { this.say('Review could not be saved: ' + error.message, 'err'); return false; }
    }
    observe(file, text, { ownSave = false } = {}) {
        if (typeof text !== 'string') return;
        this._syncStored(file);
        const previous = this._archived.get(file);
        if (ownSave && previous?.isEmpty && text !== previous.baseText) {
            // A later saved reader edit is a newer cursor. Do not resurrect
            // the completed review's older checkpoint on a future arrival.
            previous.reviewedObservedHash = undefined;
        }
        this._observed.set(file, text); this.persist(file);
        if (ownSave && this._readerPending.get(file)?.text === text) this._readerPending.delete(file);
    }
    async keepWithComment(file, id, comment) {
        const session = this.sessions.get(file);
        if (!session?.hunks.some(h => h.id === id)) return;
        if (comment == null) comment = await vscode.window.showInputBox({
            title: 'Accept with comment', prompt: 'Question or feedback for the agent (saved locally; not sent)',
            placeHolder: 'Why is this assumption needed?' });
        if (comment == null || !String(comment).trim()) return;
        if (!session.addFeedback(id, String(comment).trim())) return;
        const saved = session.feedback[session.feedback.length - 1];
        this.persist(file, session);
        // Review feedback is an annotation on the paper, not a private review
        // transcript. Feed it into the viewer's shared .timeline.comments
        // sidecar before the hunk is accepted and disappears from the review.
        if (saved && this.viewer && typeof this.viewer.addRevisionComment === 'function') {
            await this.viewer.addRevisionComment(saved);
        }
        return this.keep(file, id);
    }
    async exportFeedback(file) {
        const s = this.sessions.get(file) || this._archived.get(file);
        const text = s?.feedbackDraft ?? (s?.feedback || []).map(c => `### ${c.file}:${c.line}${c.name ? ' — ' + c.name : ''}\n` +
            `Accepted with comment at ${new Date(c.at).toISOString()} · ${c.author?.name || 'external/unknown'}${c.author?.sessionId ? ' · ' + c.author.sessionId : ''}\n` +
            `Change ID: ${c.id} (line number at review time)\n\n${c.comment}\n`).join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: text || 'No review comments yet.' });
        await vscode.window.showTextDocument(document, { preview: false });
    }
    async exportHistory(file) {
        this._syncStored(file);
        const s = this.sessions.get(file) || this._archived.get(file);
        const text = (s?.arrivals || []).map((a, i) => `# External arrival ${i + 1} · ${new Date(a.at).toISOString()}\n` +
            `Source: ${a.source} · ${a.author?.name || 'unknown author'}\n\nBEFORE\n${a.before}\n\nAFTER\n${a.after}\n`).join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: text || 'No external arrivals recorded yet.' });
        await vscode.window.showTextDocument(document, { preview: false });
    }

    /** Current source, including a reader edit awaiting dirty metadata. */
    _currentText(file) {
        const doc = (vscode.workspace.textDocuments || []).find(d => d.uri.fsPath === file);
        const text = doc?.getText();
        const pending = this._readerPending.get(file);
        if (doc && (doc.isDirty || (pending?.document === doc &&
            pending.version === doc.version && pending.text === text))) return text;
        try { return fs.readFileSync(file, 'utf8'); } catch (_) { return text ?? null; }
    }

    /**
     * An agent changed the paper. `baseText` is what the file held BEFORE the
     * change and is used only when a session is opened — an arriving change
     * never moves the baseline of a review already in progress, which is the
     * whole of the reported "the previous changes disappear as if approved".
     */
    async noteAgentChange(o = {}) {
        const file = o.file;
        if (!file) return null;
        this._syncStored(file);
        const current = this._currentText(file);
        this._hidden.delete(file);
        let s = this.sessions.get(file);
        if (!s) {
            const agreed = this._archived.get(file);
            if (agreed?.isEmpty && agreed.baseText === current) return agreed;
            if (typeof o.baseText !== 'string') return null;
            s = this._newSession(file, o.baseText, current);
            this.sessions.set(file, s);
        }
        s.noteBatch({ source: o.source || 'disk', note: o.note || '', author: o.author || null });
        if (typeof current === 'string') s.recordArrival({ text: current, source: o.source || 'disk', author: o.author || null });
        await this.refresh(file, { announce: true });
        this.output.appendLine(`review: ${o.source || 'disk'} changed ${path.basename(file)} — ` +
            `${s.pendingCount} change${s.pendingCount === 1 ? '' : 's'} waiting`);
        return s;
    }

    /**
     * TRACK MY CHANGES. With `wolfbook.tex.trackMyChanges` on, what the reader
     * does on the page (typing in the ink, the card, a table, a figure, a
     * move, a drop — every edit WPaper's viewer announces) opens or extends
     * the review as a change by "You", to keep or undo like an agent's. It is
     * held out of the baseline mirror while it applies, as an agent's write
     * is; unlike one, it keeps no before/after copy of the file per write and
     * raises no "the agent changed" notice.
     */
    noteOwnChange(ev) {
        const file = ev.file;
        if (ev.phase === 'begin') {
            this._agentWriting.set(file, Date.now());
            this._userWriting.set(file, Date.now());
            const base = typeof ev.baseText === 'string' ? ev.baseText : this._buffers.get(file) ??
                (vscode.workspace.textDocuments || []).find(d => d.uri.fsPath === file)?.getText();
            if (!this.sessions.has(file) && typeof base === 'string') this.sessions.set(file, this._newSession(file, base));
            return;
        }
        try {
            const s = this.sessions.get(file);
            if (!s) return;
            this._hidden.delete(file);
            s.noteBatch({ source: 'you', note: ev.note || '', author: YOU });
            clearTimeout(this._ownRefresh);
            this._ownRefresh = setTimeout(() => { this.refresh(file).catch(() => {}); }, 250);
        } finally {
            this._agentWriting.delete(file);
            this._userWriting.delete(file);
        }
    }

    /** True while this file's buffer is being rebased — the watcher must wait. */
    isMerging(file) { return this._merging.has(file); }

    /**
     * THE READER WAS TYPING WHEN THE AGENT WROTE THE FILE.
     *
     * VS Code cannot reload a dirty buffer, so it keeps the two apart and
     * refuses the next save — "the content of the file is newer" — and the
     * reader is left with a modal offering to discard one side or the other.
     * Reported exactly that way: *this does not trigger the internal review,
     * and then I cannot review with our tools*.
     *
     * There is no single text to review because there are three, so this makes
     * one: the agent's changes are merged into the reader's buffer wherever the
     * two do not overlap (tex/threeWay.js), and the result becomes the
     * document. The review then does what it always does — diff the reader's
     * text against the buffer — and every merged-in change is a pending hunk
     * with Keep and Undo, which is the point of the exercise.
     *
     * WHY THE BUFFER IS REVERTED FIRST. VS Code's refusal is about staleness,
     * not content: it compares the file's mtime against the one it read, so a
     * buffer that has been open across an external write can never be saved,
     * whatever it contains. Reloading is the only thing that gives it a current
     * mtime — so the buffer is reloaded from disk (which is the agent's text)
     * and the reader's own edits are then applied back on top as ONE
     * WorkspaceEdit. The reader keeps unsaved edits, exactly as before; the
     * save that used to be refused now just works.
     *
     * The cost, stated plainly: the buffer's fine-grained undo history is
     * replaced by one step. Nothing else is lost — conflicting hunks are not
     * applied, and their text is kept in the result for the caller to show.
     *
     * @returns {null | {applied:number, conflicts:object[]}}  null when this
     *   could not be handled, and the caller should fall back to asking.
     */
    async mergeExternalChange(o = {}) {
        const { file, doc } = o;
        if (!file || !doc) return null;
        if (typeof o.base !== 'string' || typeof o.ours !== 'string' || typeof o.theirs !== 'string') return null;
        const merge = mergeThreeWay({ base: o.base, ours: o.ours, theirs: o.theirs });
        if (merge.failed) return null;
        // Nothing of theirs to bring in and nothing contested: the reader's
        // buffer already says everything the file does.
        if (!merge.applied.length && !merge.conflicts.length) return null;

        this._merging.add(file);
        this._agentWriting.set(file, Date.now());   // a rebase is not typing
        try {
            // The baseline is the reader's text as it stood — that is what they
            // agreed to, and diffing it against the merge is precisely the set
            // of changes the agent is asking for.
            if (!this.sessions.has(file)) {
                this.sessions.set(file, this._newSession(file, o.ours));
            }
            this.sessions.get(file).noteBatch({
                source: o.source || 'disk',
                note: merge.conflicts.length ? 'merged with your unsaved edits' : '',
            });
            this.sessions.get(file).recordArrival({ text: o.theirs, source: o.source || 'disk', author: o.author || null });
            this.persist(file);

            const ok = await this._rebaseBuffer(doc, merge.text);
            if (!ok) {
                // Leave nothing half-done: without the buffer we have no review.
                if (this.sessions.get(file) && this.sessions.get(file).isEmpty) this.sessions.delete(file);
                return null;
            }
            await this.refresh(file, { announce: true });
            this.output.appendLine(
                `review: ${path.basename(file)} changed on disk while you had unsaved edits — ` +
                `merged ${merge.applied.length} change${merge.applied.length === 1 ? '' : 's'} in` +
                (merge.conflicts.length ? `, ${merge.conflicts.length} could not be merged` : ''));
            if (merge.conflicts.length) this._offerConflicts(file, doc, o.theirs, merge.conflicts);
            return { applied: merge.applied.length, conflicts: merge.conflicts };
        } catch (e) {
            this.output.appendLine(`review: could not merge ${path.basename(file)}: ${e.message}`);
            return null;
        } finally {
            this._merging.delete(file);
            this._agentWriting.delete(file);
        }
    }

    /**
     * Reload the buffer from disk and put `text` back into it as one edit.
     *
     * Reverting is what clears VS Code's "this buffer is older than the file"
     * state; the edit that follows is the reader's own work going back on top.
     */
    async _rebaseBuffer(doc, text) {
        const file = doc.uri.fsPath;
        try {
            // The revert needs the buffer active; in viewer-only that must not
            // read as the reader asking for the editor.
            const revert = async () => {
                await vscode.window.showTextDocument(doc, { preview: false });
                await vscode.commands.executeCommand('workbench.action.files.revert');
            };
            await (this.viewer && this.viewer.keepViewerLayout ? this.viewer.keepViewerLayout(revert) : revert());
        } catch (e) {
            this.output.appendLine(`review: could not reload ${path.basename(file)}: ${e.message}`);
            return false;
        }
        const now = doc.getText();
        if (now === text) return true;          // the reader's edits were all merged away
        // Only the lines that differ, so the edit is the reader's work and not
        // a whole-file replacement that would throw away every folded region.
        const edits = [];
        try {
            for (const h of diffLines(splitLines(text), splitLines(now))) {
                edits.push({
                    startLine: h.bStart,
                    endLine: h.bEnd,
                    lines: splitLines(text).slice(h.aStart - 1, h.aEnd - 1),
                });
            }
        } catch (e) {
            this.output.appendLine(`review: could not rebase ${path.basename(file)}: ${e.message}`);
            return false;
        }
        if (!edits.length) return true;
        return this.applyEdits(file, edits);
    }

    /**
     * The changes that could not be merged, parked where they can be looked at.
     *
     * They are NOT in the buffer: the reader's own words are what stands there.
     * The agent's version of those lines would otherwise exist only in the file
     * the reload just overwrote, so it is written to a temp copy and offered as
     * an ordinary diff — the one thing VS Code does well here.
     */
    _offerConflicts(file, doc, theirs, conflicts) {
        const name = path.basename(file);
        const n = conflicts.length;
        const where = conflicts.slice(0, 3)
            .map(c => `line ${c.baseRange[0]}`).join(', ');
        vscode.window.showWarningMessage(
            `${n} change${n === 1 ? '' : 's'} to ${name} touched lines you were editing (${where}) ` +
            'and were left out. Yours are what the file holds.',
            'Compare…',
        ).then(async (pick) => {
            if (pick !== 'Compare…') return;
            try {
                const tmpDir = path.join(os.tmpdir(), 'wolfbook-tex', 'ondisk');
                fs.mkdirSync(tmpDir, { recursive: true });
                const tmp = path.join(tmpDir, `${Date.now()}-${name}`);
                fs.writeFileSync(tmp, theirs, 'utf8');
                await vscode.commands.executeCommand('vscode.diff',
                    vscode.Uri.file(tmp), doc.uri,
                    `${name} (what the agent wrote) ↔ ${name} (yours)`);
            } catch (e) {
                vscode.window.showErrorMessage(`Could not show the comparison: ${e.message}`);
            }
        }, () => { /* dismissed */ });
    }

    /** Re-diff and repaint every surface. Never throws. */
    async refresh(file, opts = {}) {
        this._syncStored(file);
        const s = this.sessions.get(file);
        if (!s) { this.paint(file); this.updateStatus(); this.push(file); return; }
        // WHICH TEXT IS "NOW" — AND THE RACE THAT MADE THE WHOLE FEATURE
        // INVISIBLE.
        //
        // A write to an open, CLEAN file is noticed by the watcher before VS
        // Code has finished reloading the buffer, so `doc.getText()` at that
        // moment is still the text from BEFORE the write. Diffing the baseline
        // against it found nothing, the empty session was thrown away, and the
        // pages then quietly changed under the reader with nothing to review —
        // A known reader WorkspaceEdit can update the source before isDirty
        // changes. Keep that exact document version through an early compile
        // refresh instead of comparing against the older saved copy.
        const text = this._currentText(file);
        if (text == null) return;
        const placementOnly=opts.placementOnly && text===s._lastText && s.baseText===s._lastBaseText;
        try { s.update({ currentText: text, map: this.mapView(file) }); }
        catch (e) { this.output.appendLine(`review: ${e.message}`); }

        // Page hints do not change decisions, source or history. Avoid writing
        // and hashing the whole saved review for each discovery batch.
        if (placementOnly) {
            this.paint(file); this.updateStatus(); this.push(file); this._lensEmitter.fire();
            return;
        }

        // A SESSION IS CLOSED BY BEING FINISHED, NOT BY BEING EARLY. It goes
        // when it once had changes and now has none — everything was decided.
        // A session that has never shown one is simply waiting for the buffer
        // to catch up, and throwing it away is what lost the change.
        if (s.hunks.length) s._everHad = true;
        this._checkpointFinished(file, s);
        if (!this.persist(file, s)) {
            this.paint(file); this.updateStatus(); this.push(file); this._lensEmitter.fire();
            return;
        }
        this._archived.set(file, s);
        if (s.isEmpty && s._everHad) this.sessions.delete(file);
        this.paint(file);
        this.updateStatus();
        this.push(file);
        this._lensEmitter.fire();
        if (opts.announce) this.announce(file);
        this._resolveGitAuthors(s);
    }

    _resolveGitAuthors(s) {
        const key=textHash(s.baseText)+'/'+textHash(s._lastText);
        if(s._gitLookupKey===key)return;
        s._gitLookupKey=key;
        const eligible=s.hunks.filter(h=>/disk|external|git|overleaf/.test(
            s.batches.find(b=>b.id===s.firstSeen.get(h.id))?.source || ''));
        if(!eligible.length)return;
        const before=s.baseText,after=s._lastText;
        require('./reviewGit').gitReviewAuthors({file:s.file,before,after,hunks:eligible}).then(result=>{
            if(!result || s._gitLookupKey!==key || s.baseText!==before || s._lastText!==after ||
                this.sessionFor(s.file)!==s)return;
            for(const h of eligible)if(result.authors[h.id])s.gitAuthors.set(h.id,result.authors[h.id]);
            this.persist(s.file,s);this.push(s.file);this.paint(s.file);
        }).catch(()=>{});
    }

    /**
     * Re-place every open review against the render that is on screen NOW.
     *
     * Rects are measured through the render map of whatever compile existed
     * when the change was located. A live rebuild lands a second or two later,
     * the page reflows, and nothing asked the question again — so the boxes
     * kept the coordinates of a page that no longer exists, and the reader saw
     * highlighting sitting beside the text it belongs to instead of on it.
     *
     * The comparison surface has been re-placed on every render since it was
     * written (`viewer.refreshComparison`); this is the same move for the
     * review. Coalesced, because a single compile fires several coordinator
     * events — one for the run starting, one for the generation landing, one
     * for the authoritative pass — and re-diffing on each is work for nothing.
     */
    refreshPlacement() {
        if (!this.sessions.size) return;
        if (this._placeTimer) return;
        this._placeTimer = setTimeout(() => {
            this._placeTimer = null;
            for (const file of [...this.sessions.keys()]) {
                this.refresh(file, {placementOnly:true}).catch(() => { /* a placement is never fatal */ });
            }
        }, 60);
    }

    /** Close a review without deciding anything: the changes simply stay. */
    close(file) {
        this._hidden.add(file);
        this.focused.delete(file);
        this.persist(file);
        this.paint(file);
        this.updateStatus();
        if (this.viewer?.showReview) this.viewer.showReview(null);
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
        if (this._hidden.has(file)) { this.viewer.showReview(null); return; }
        const s = file ? (this.sessions.get(file) || this._archived.get(file)) : null;
        this.viewer.showReview(s ? s.payload({ focus: this.focused.get(file) || null }) : null);
    }

    // -------------------------------------------------------------- editor --

    /** Selecting a correction changes only the focus decoration. */
    paintFocus(file,hunk) {
        const editors=(vscode.window.visibleTextEditors || []).filter(e=>e.document?.uri.fsPath===file);
        if(!editors.length)return;
        for(const editor of editors) {
            const clamp=line=>Math.max(0,Math.min(line,editor.document.lineCount-1));
            const from=clamp(hunk.ourRange.startLine-1),to=Math.max(from,clamp(hunk.ourRange.endLine-2));
            try {editor.setDecorations(this.decor.focus,[{range:new vscode.Range(from,0,to,0)}]);} catch(_) {}
        }
    }

    /** Every pending change, marked in the editors showing that file. */
    paint(file) {
        const editors = (vscode.window.visibleTextEditors || [])
            .filter(e => e.document && e.document.uri.fsPath === file);
        if (!editors.length) return;
        const s = this.sessions.get(file);
        const d = this.decor;
        if (!s || s.isEmpty || this._hidden.has(file)) {
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
            // Who made each change: the agent, or the reader on the page (track my changes).
            const whoOf = h => s.gitAuthors.get(h.id)?.name || s.batches.find(b => b.id === s.firstSeen.get(h.id))?.author?.name ||
                (s.batches.find(b => b.id === s.firstSeen.get(h.id))?.source === 'you' ? 'You' : 'External / unknown');
            for (const h of s.hunks) {
                const from = clamp(h.ourRange.startLine - 1);
                const to = clamp(h.ourRange.endLine - 2);
                const whole = new vscode.Range(from, 0, Math.max(from, to), 0);
                if (h.verb === 'del') {
                    const seam = clamp(h.ourRange.startLine - 2);
                    buckets.del.push({
                        range: new vscode.Range(seam, 0, seam, 0),
                        hoverMessage: removedHover(h, whoOf(h)),
                    });
                } else {
                    buckets[h.verb === 'add' ? 'add' : 'change'].push({
                        range: whole,
                        hoverMessage: changeHover(h, whoOf(h)),
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

    /**
     * The change that FOLLOWS the one just decided.
     *
     * Worked out BEFORE the verdict is applied, because afterwards the decided
     * change is gone from the list and "the next one" no longer has anything to
     * be next to. Falls back to the change now occupying that position — the
     * list closed up over the one that left — and then to the last one, so
     * deciding the final change leaves the focus somewhere real.
     */
    _afterDeciding(file, id) {
        const s = this.sessions.get(file);
        if (!s) return null;
        const ids = s.hunks.map(h => h.id);
        const at = ids.indexOf(id);
        if (at < 0) return null;
        return { at, ids, page: s.hunks[at] && s.hunks[at].page };
    }

    /** Continue the review worklist, regardless of page distance. The viewer
     * bookmarks the reader's starting position before their first decision. */
    async _advanceAfter(file, plan) {
        if (!plan) return;
        const s = this.sessions.get(file);
        if (!s || s.isEmpty) return;
        const left = s.hunks.map(h => h.id);
        if (!left.length) return;
        // The one that took its place, else the one before it.
        const next = left[Math.min(plan.at, left.length - 1)];
        if (next) {
            await this.show(file, next);
            return;
        }
        this.focused.delete(file);
        this.paint(file);
        this.push(file);
    }

    _commitKeep(file, ids, wholeText) {
        // Persist before yielding. If another host won a write, reapply only
        // these content-derived IDs against its baseline, preserving both
        // hosts' decisions rather than saving an old pending snapshot.
        for (let attempt = 0; attempt < 3; attempt++) {
            this._syncStored(file);
            const s = this.sessions.get(file) || this._archived.get(file);
            if (!s) return { ok:false, reason:'that review is no longer in the list' };
            const current=this._currentText(file);
            if (typeof current==='string' && current!==s._lastText) s.update({currentText:current,map:this.mapView(file)});
            if (ids.length && !s.hunks.some(h=>ids.includes(h.id)))
                return {ok:false,reason:'that change is no longer in the list'};
            if (s.hunks.length) s._everHad = true;
            const all = typeof wholeText === 'string' && wholeText === s._lastText && s.hunks.every(h => ids.includes(h.id));
            const r = s.keepMany(ids);
            if (all) s.baseText = wholeText;
            this._checkpointFinished(file, s);
            if (this.persist(file, s)) return r;
        }
        return { ok:false, reason:'Keep could not be saved; the latest saved review was restored. Please try again.' };
    }

    async keep(file, id) {
        this._syncStored(file);
        const s = this.sessions.get(file);
        if (!s) return;
        if (!s.hunks.some(h => h.id === id)) { this.say('that change is no longer in the list', 'warn'); return; }
        const plan = this._afterDeciding(file, id);
        const r = this._commitKeep(file, [id]);
        if (!r.ok) { this.say(r.reason, 'warn'); return; }
        await this._refreshAfterKeep(file);
        await this._advanceAfter(file, plan);
    }

    async keepAll(file) {
        this._syncStored(file);
        const s = this.sessions.get(file);
        if (!s) return;
        const n = s.pendingCount;
        const r = this._commitKeep(file, s.hunks.map(h => h.id), s._lastText);
        if (!r.ok) { this.say(r.reason, 'warn'); return; }
        await this._refreshAfterKeep(file);
        this.say(`kept ${n} change${n === 1 ? '' : 's'}`, 'ok');
    }

    async keepBatch(file, batchId) {
        this._syncStored(file);
        const s = this.sessions.get(file);
        if (!s) return;
        const ids = s.hunks.filter(h => s.firstSeen.get(h.id) === batchId).map(h => h.id);
        const plan = this._afterDeciding(file, ids[0]);
        const r = this._commitKeep(file, ids);
        if (!r.ok) { this.say(r.reason, 'warn'); return; }
        await this._refreshAfterKeep(file);
        await this._advanceAfter(file, plan);
    }

    /** Keep a set the reader pointed at as one — a section, a batch, a picking. */
    async keepMany(file, ids) {
        this._syncStored(file);
        const s = this.sessions.get(file);
        if (!s || !Array.isArray(ids) || !ids.length) return;
        const plan = this._afterDeciding(file, s.hunks.find(h => ids.includes(h.id))?.id);
        const r = this._commitKeep(file, ids);
        if (!r.ok) { this.say(r.reason, 'warn'); return; }
        await this._refreshAfterKeep(file);
        await this._advanceAfter(file, plan);
        const n = (r.kept || []).length;
        if (n) this.say(`kept ${n} change${n === 1 ? '' : 's'}`, 'ok');
    }

    async _refreshAfterKeep(file) {
        const s=this.sessions.get(file) || this._archived.get(file);
        // An agent may have written during the decision. That real source
        // change still needs a normal comparison; approval alone needs none.
        if (!s || this._currentText(file)!==s._lastText) return this.refresh(file);
        if (s.isEmpty && s._everHad) this.sessions.delete(file);
        this.paint(file);this.updateStatus();this.push(file);this._lensEmitter.fire();
    }

    async undo(file, id) {
        this._syncStored(file);
        const s = this.sessions.get(file);
        if (!s) return;
        const plan = this._afterDeciding(file, id);
        const r = s.undo(id);
        if (!r.ok) { this.say(r.reason, 'warn'); return; }
        const applied = await this.applyEdits(file, r.edits);
        if (applied) { s.noteUndone(id); await this.refresh(file); await this._advanceAfter(file, plan); }
    }

    async undoAll(file) {
        this._syncStored(file);
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
        let h = s.hunks.find(x => x.id === id);
        if (!h) return;
        this.focused.set(file, id);
        this.paintFocus(file,h);
        // Reuse the already published text/marks. Rebuilding payload() here
        // diffs every hunk and sends the entire paper's corrections per click.
        if(!this.viewer?.selectReviewHunk?.(file,id))this.push(file);
        if (this.viewer && this.viewer.focusReviewHunk) {
            // The page lacks the change (the agent wrote the file after it
            // was built): the full compile first, then the focus, which
            // waits for that PDF (TexViewer.compileForReview).
            const behind = this.viewer.reviewPageBehind && this.viewer.reviewPageBehind(s.generation, h);
            if (!behind && !h.rects?.length && this.viewer.ensureReviewPlacement) {
                await this.viewer.ensureReviewPlacement(file, h);
                if (this.focused.get(file) !== id) return;
                h = this.sessions.get(file)?.hunks.find(x => x.id === id) || h;
            }
            // Behind: no generation, so the focus waits for the placement
            // on the new PDF instead of going to the old page now.
            this.viewer.focusReviewHunk(h, behind ? null : s.generation);
            if (behind && this.viewer.compileForReview) this.viewer.compileForReview();
        }
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            const line = Math.max(0, Math.min(h.ourRange.startLine - 1, doc.lineCount - 1));
            // Viewer-only (WPaper alone): the page is where the change is
            // shown. Opening the .tex would cover WPaper until the layout put
            // it back — reveal only in an editor that is already visible.
            const visible = (vscode.window.visibleTextEditors || [])
                .find(e => e.document && e.document.uri.fsPath === file);
            const editor = visible || (this.viewer && this.viewer.viewerOnly ? null
                : await vscode.window.showTextDocument(doc, {
                    viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false,
                }));
            // THE SELECTION IS THE READER'S. Reveal, never select.
            if (editor) {
                editor.revealRange(new vscode.Range(line, 0, line, 0),
                    vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                // A newly opened source editor needs its initial decorations.
                // An already visible editor only changed the focus above.
                if(!visible)this.paint(file);
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
        for (const doc of vscode.workspace.textDocuments || []) {
            if (/\.tex$/i.test(doc.uri.fsPath)) this._buffers.set(doc.uri.fsPath, doc.getText());
        }
        if (vscode.workspace.onDidOpenTextDocument) context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
            if (/\.tex$/i.test(doc.uri.fsPath)) {
                this._syncStored(doc.uri.fsPath);
                this._buffers.set(doc.uri.fsPath, doc.getText());
            }
        }));
        if (context.globalStorageUri?.fsPath) {
            try {
                const { ReviewStore } = require('./reviewStore');
                this._store = new ReviewStore(path.join(context.globalStorageUri.fsPath, 'paper-reviews'),file=>this._historyOptions(file));
                // Histories contain immutable whole-document arrivals and can
                // be large. Other projects belong on disk, not in every host.
                // _syncStored restores a file on open/observe/agent arrival.
                const files = (vscode.workspace.textDocuments || [])
                    .filter(doc => /\.tex$/i.test(doc.uri.fsPath)).map(doc => doc.uri.fsPath);
                for (const record of this._store.load(files)) {
                    this._restoreRecord(record);
                }
                if (this._store.errors.length) this.say(`${this._store.errors.length} saved review record(s) could not be read; originals were preserved.`, 'err');
            } catch (error) { this.say('Saved review could not be restored: ' + error.message, 'err'); }
        }
        const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
        const withFile = (fn) => async (file, id) => {
            const f = typeof file === 'string' ? file : this.activeFile();
            if (!f) { this.say('nothing is waiting to be reviewed', 'warn'); return; }
            await fn(f, id);
        };
        reg(CMD.OPEN, withFile(async (f) => {
            this._hidden.delete(f); this.paint(f);
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
            if (!/\.tex$/i.test(file)) return;
            const previous = this._buffers.get(file);
            this._buffers.set(file, e.document.getText());
            const s = this.sessions.get(file);
            if (!e.contentChanges.length) { this._readerPending.delete(file); return; }
            const userBusy = Date.now() - (this._userWriting.get(file) || 0) < 5000;
            if (userBusy && !e.document.isDirty) {
                this._readerPending.set(file, { document:e.document, version:e.document.version,
                    text:e.document.getText() });
            } else this._readerPending.delete(file);
            const inEditor = vscode.window.activeTextEditor?.document === e.document;
            const unannouncedExternal = !inEditor && !userBusy && !this._agentWriting.has(file) && !this._applying && e.document.isDirty;
            if (unannouncedExternal && typeof previous === 'string') {
                this.noteAgentChange({ file, baseText: previous, source: 'external/buffer' }).catch(error => this.say(error.message, 'err'));
                return;
            }
            if (!s) return;
            // A RELOAD IS NOT THE READER TYPING. When an agent writes the file
            // and VS Code refreshes a clean buffer, this event describes the
            // agent's change — mirroring it into the baseline would agree to it
            // on the reader's behalf and the change would never be seen. Typing
            // leaves the buffer DIRTY; a reload leaves it clean.
            // …and not while the MCP tool is writing through this very buffer:
            // its edit arrives here looking exactly like typing. A stale flag
            // cannot strand the mirror — it is ignored after a few seconds.
            const writing = this._agentWriting.get(file);
            const agentBusy = writing != null && Date.now() - writing < 5000;
            if (!this._applying && !agentBusy && (e.document.isDirty || userBusy)) {
                // Offsets describe the buffer immediately BEFORE this event,
                // not the last debounced paint. Rapid typing otherwise compares
                // keystrokes against an increasingly stale snapshot and turns
                // the reader's text into apparent external changes.
                if (typeof previous === 'string' && s._lastText !== previous) s.update({ currentText: previous });
                // Multi-cursor edits share pre-event coordinates. Work from
                // right to left so advancing the baseline preserves them.
                for (const c of [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
                    try { s.noteReaderEdit({ offset: c.rangeOffset, length: c.rangeLength, text: c.text }); }
                    catch (_) { /* an unmirrorable edit is not fatal */ }
                }
                s.update({ currentText: e.document.getText(),readerChanges:e.contentChanges });
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
            if (ev.origin === 'user') {
                if (trackingMine(ev)) { this.noteOwnChange(ev); return; }
                if (ev.phase === 'begin') this._userWriting.set(ev.file, Date.now());
                else this._userWriting.delete(ev.file);
                return;
            }
            try {
                if (ev.phase === 'begin') {
                    // The tool edits the OPEN BUFFER, so the change event it
                    // provokes is indistinguishable from typing — and mirroring
                    // it into the baseline would agree to the agent's own edit
                    // on the reader's behalf. Hold the mirror until it is done.
                    this._agentWriting.set(ev.file, Date.now());
                    // Open the session NOW, on the text as it is before the
                    // write: that is exactly the baseline this change is against.
                    if (!this.sessions.has(ev.file) && typeof ev.baseText === 'string') {
                        this.sessions.set(ev.file, this._newSession(ev.file, ev.baseText));
                    }
                    return;
                }
                await this.noteAgentChange({
                    file: ev.file, baseText: ev.baseText,
                    source: ev.source || 'paper_applyEdit', note: ev.note || '', author: ev.author || null,
                });
            } catch (e) { this.output.appendLine(`review: ${e.message}`); }
            finally { if (ev.phase !== 'begin') this._agentWriting.delete(ev.file); }
        }));

        context.subscriptions.push({ dispose: () => this.dispose() });
    }
}

// ----------------------------------------------------------------- helpers --

const YOU = { name: 'You (on the page)' };

/** A page edit of the reader's, while they have asked for their changes to be tracked. */
function trackingMine(ev) {
    return /^wpaper\./.test(ev?.source || '') &&
        vscode.workspace.getConfiguration('wolfbook.tex').get('trackMyChanges', false) === true;
}

function describeHunk(h, s) {
    const n = Math.max(h.ourRange.endLine - h.ourRange.startLine,
        h.theirRange.endLine - h.theirRange.startLine);
    const what = h.verb === 'add' ? `${n} line${n === 1 ? '' : 's'} added`
        : h.verb === 'del' ? `${n} line${n === 1 ? '' : 's'} removed`
            : `${h.changedWords || 0} word${h.changedWords === 1 ? '' : 's'} changed`;
    return s.edited.has(h.id) ? `${what} · you have edited this since` : what;
}

function changeHover(h, who = 'The agent') {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(h.verb === 'add' ? `**${who} added this.**\n\n` : `**${who} changed this.**\n\n`);
    if (h.verb === 'change' && h.theirText) {
        md.appendMarkdown('Before:\n');
        md.appendCodeblock(h.theirText.slice(0, 800), 'latex');
    }
    return md;
}

function removedHover(h, who = 'The agent') {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${who} removed this.**\n\n`);
    md.appendCodeblock(String(h.theirText || '').slice(0, 800), 'latex');
    return md;
}

/** The words that differ inside a changed hunk, as ranges in the document. */
function wordRanges(doc, h, clamp) {
    const out = [];
    try {
        const { aRanges } = refineHunk(h.ourText, h.theirText, h.wordContext);
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
