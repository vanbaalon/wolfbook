// WLaTeX page views -> WPaper's synchronous render-map contract.
// Every source position comes from the worker. No token alignment or line shifts.
const path = require('path');
const { RenderMap, FLAG } = require('./renderMap');
const { spToBp, bpToSp } = require('./texGeometry');

function rectangle(geometry, header) {
    const scale = header.magnification / 1000;
    // xdvipdfmx adds the DVI one-inch origin. TeX hoffset/voffset are already
    // present in the raw coordinates and must not be added from the header.
    const x = 72 + spToBp(geometry.position.x) * scale;
    const baseline = 72 + spToBp(geometry.position.y) * scale;
    const end = x + spToBp(geometry.width) * scale;
    const top = baseline - spToBp(geometry.height) * scale;
    const bottom = baseline + spToBp(geometry.depth) * scale;
    return { x: Math.min(x, end), y: Math.min(top, bottom),
        w: Math.abs(end - x), h: Math.abs(bottom - top), baseline };
}

// A translated enclosing range may contain newly inserted lines with no ink.
// Keep its endpoints only; exact cursor admission remains a worker query.
function originLines(location) {
    return location.end.line === location.start.line || location.end.column_utf16 === 0
        ? [location.start.line] : [location.start.line, location.end.line];
}

const fs = require('fs');

/** A file's lines, read once per map (these files do not change under it). */
function linesOf(cache, file) {
    if (!cache.has(file)) {
        let lines = null;
        try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (_) { /* absent */ }
        cache.set(file, lines);
    }
    return cache.get(file);
}

/** The project's files with `extension`, a few levels deep, hidden ones skipped. */
function projectFiles(dir, extension, depth = 3) {
    const out = [];
    const walk = (d, level) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const full = path.join(d, e.name);
            if (e.isDirectory()) { if (level < depth) walk(full, level + 1); }
            else if (e.name.toLowerCase().endsWith(extension)) out.push(full);
        }
    };
    walk(dir, 0);
    return out;
}

/**
 * Whether the end of `text` — which starts at a defining command
 * (`\newcommand{\foo}[1]{…`, `\def\foo#1{…`) — is inside the definition's
 * body: the name, then the argument groups this kind of definition takes (one
 * body; `\newenvironment` and `\NewDocumentCommand` two), not yet all closed.
 */
function insideDefinition(text) {
    const head = /^\\([A-Za-z]+)\*?/.exec(text);
    if (!head) return false;
    let i = head[0].length;
    const spaces = () => { while (i < text.length && /\s/.test(text[i])) i++; };
    const controlSequence = () => { i++; if (/[A-Za-z]/.test(text[i] || '')) while (/[A-Za-z]/.test(text[i] || '')) i++; else i++; };
    let needed;
    spaces();
    if (/^[gex]?def$/.test(head[1])) {
        if (text[i] === '\\') controlSequence();
        needed = 1;
    } else {
        const braced = text[i] !== '\\';
        if (!braced) controlSequence();
        needed = (braced ? 1 : 0) + ({ NewDocumentCommand: 2, RenewDocumentCommand: 2, DeclareDocumentCommand: 2,
            newenvironment: 2, renewenvironment: 2 }[head[1]] || 1);
    }
    let depth = 0, closed = 0;
    for (; i < text.length; i++) {
        const c = text[i];
        if (c === '\\') { i++; continue; }
        if (c === '%') { while (i < text.length && text[i] !== '\n') i++; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0 && ++closed >= needed) return false;
    }
    return depth > 0;
}

class NativeMap extends RenderMap {
    constructor(o = {}) {
        super({ ...o, generation: { ...o.generation, synctexPath: null }, synctexDoc: null });
        this.native = true;
        this.view = o.nativeView;
        this.source = o.nativeSource;
        this.projectDir = path.resolve(o.projectDir || o.generation?.projectDir || '.');
        // Where the build wrote its auxiliary files (the .bbl, the .toc), for
        // text the paper printed from them.
        this.outDir = o.generation?.outDir || null;
        this._files = new Map();
        this._invalidated = false;
        this._entries = [];
        this._byItem = new Map();
        this._hasDisplaced = false;
        this._pages = new Map();
        this._headers = new Map();
        this._lines = new Map();
        // A LIVE MAP answers for the pages the incremental engine drew over the
        // PDF: each page's map is bound to the text that page was typeset
        // from, and the worker translates it through every later edit. It has
        // no artifact and belongs to no PDF.
        this.live = this.view?.live === true;
        this.pageCount = this.view?.artifact?.page_count || 0;
        if (!this.view || !this.source || !this.source.isCurrentView(this.view)) return;
        if (!this.live && o.generation?.pdfHash && o.generation.pdfHash !== this.view.artifact.pdf_hash)
            throw Error('Native map does not belong to the displayed PDF');
        for (const page of this.view.pages) {
            if (!(page.header.magnification > 0)) throw Error('Invalid native magnification');
            this._headers.set(page.page, page.header);
            const entries = [];
            for (const hit of page.hits) {
                const rect = rectangle(hit.item.geometry, page.header);
                const preferred = hit.preferred_source;
                const file = preferred ? path.resolve(this.projectDir, preferred.file) : null;
                const boxes = hit.box_path.filter(([, box]) => box.kind === 'Horizontal');
                const row = boxes.length ? boxes[boxes.length - 1][0] : `baseline:${rect.baseline}`;
                const entry = { hit, ...rect, boxHeight: rect.h, h: rect.baseline - rect.y, page: page.page, file, fileId: file,
                    line: preferred?.location.start.line || null, row,
                    i: hit.item_id, fontId: hit.item.glyph?.font || 0,
                    str: '', kind: !file ? 5 : hit.box_path.some(([,b]) => b.kind === 'EquationNumber') ? 3
                        : hit.box_path.some(([,b]) => b.kind === 'Display') ? 2 : 0, lv: 0,
                    emTop: rect.y, emBottom: rect.y + rect.h,
                    d: rect.y + rect.h - rect.baseline };
                entries.push(entry);
                this._entries.push(entry);
                this._byItem.set(entry.i, entry);
                this._hasDisplaced ||= hit.mapped_origins.some(o => o.source.location.accuracy !== 'Exact');
                const seen = new Set();
                for (const origin of hit.mapped_origins || []) {
                    const source = origin.source;
                    const absolute = path.resolve(this.projectDir, source.file);
                    for (const line of originLines(source.location)) {
                        const key = `${absolute}\0${line}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        if (!this._lines.has(key)) this._lines.set(key, []);
                        this._lines.get(key).push(entry);
                    }
                }
            }
            this._pages.set(page.page, entries);
        }
    }
    get available() { return !this._invalidated && !!this.source?.isCurrentView(this.view); }
    /** Whether this view materialized the page (views are windowed). */
    hasPage(page) { return this._pages.has(page); }
    /** The pages this view materialized, ascending. */
    get materializedPages() { return [...this._pages.keys()].sort((a, b) => a - b); }
    get exact() { return this.available; }
    get displaced() {
        return this.available && this._hasDisplaced;
    }
    // Exact provenance describes this preview's geometry, not parity with
    // the authoritative compiler. No parity receipt is admitted yet.
    _baseFlag() { return this.available ? FLAG.PROBABLY_CURRENT : FLAG.UNMAPPED; }
    // The coordinator still calls these legacy notifications. Never approximate
    // native positions with line deltas; replace this map after worker refresh.
    noteEdit() { this._invalidated = true; }
    clearEdits() {}
    _toGenerationLine(file, line) { return { line, shifted: false }; }
    _toCurrentLine(file, line) { return line; }
    /** The glyph entries of a page this view holds (for moving a caret by rows). */
    entriesOnPage(page) { return this.available ? this._pages.get(page) || [] : []; }
    glyphsForLine(file, line) {
        return this.available ? this._lines.get(`${path.resolve(file)}\0${line}`) || [] : [];
    }
    async _forward(file, line, column) {
        try { return await (this.live ? this.source.forward(file, line, column, { live: true }) : this.source.forward(file, line, column)); }
        catch (error) {
            // A failed live query cannot leave cached source actions enabled.
            // Recovery admits a fresh map; this view stays invalid permanently.
            this._invalidated = true;
            throw error;
        }
    }
    async forwardAt(file, line, column) {
        if (!this.available) return null;
        const relative = path.relative(this.projectDir, path.resolve(file)).split(path.sep).join('/');
        if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return null;
        const answer = await this._forward(relative, line, column);
        // The worker admits the actual anchor, not its translated enclosing
        // range: newly inserted text must not borrow an old glyph's geometry.
        if (!this.available) return null;
        if (!answer.hits.length) return this._nearestPrinted(file, line, column);
        const selected = [];
        for (const hit of answer.hits) {
            const entry = this._byItem.get(hit.item_id);
            if (!entry || entry.page !== hit.item.page) return null;
            selected.push(entry);
        }
        return selected.map(e => ({ page:e.page, x:e.x, y:e.y, w:e.w, h:e.boxHeight }));
    }
    async forwardRange(file, start, end, { isCurrent = () => true } = {}) {
        const current = () => this.available && isCurrent();
        if (!current()) return null;
        const absolute = path.resolve(file);
        const relative = path.relative(this.projectDir, absolute).split(path.sep).join('/');
        const text = this.source.files?.get(relative)?.text;
        if (typeof text !== 'string') return null;
        const lines = text.split('\n'), starts = [];
        let offset = 0;
        for (const line of lines) { starts.push(offset); offset += line.length + 1; }
        const at = p => {
            if (!p || !Number.isInteger(p.line) || p.line < 1 || p.line > lines.length ||
                !Number.isInteger(p.column_utf16) || p.column_utf16 < 0) return null;
            const line = lines[p.line - 1];
            if (p.column_utf16 > line.length - (line.endsWith('\r') ? 1 : 0)) return null;
            const n = starts[p.line - 1] + p.column_utf16;
            if (n > 0 && /[\uD800-\uDBFF]/.test(text[n - 1]) && /[\uDC00-\uDFFF]/.test(text[n] || '')) return null;
            return n;
        };
        const a = at(start), b = at(end);
        if (a === null || b === null || a > b) throw Error('Invalid native source selection');
        if (a === b) return [];
        const chosen = new Set(), uncertain = [];
        for (const entry of this._entries) for (const origin of entry.hit.mapped_origins) {
            if (path.resolve(this.projectDir, origin.source.file) !== absolute) continue;
            const loc = origin.source.location, left = at(loc.start), right = at(loc.end);
            if (left === null || right === null) return null;
            const lo = Math.max(a, left), hi = Math.min(b, right);
            if (left === right ? !(a <= left && left < b) : lo >= hi) continue;
            if (loc.accuracy === 'Exact' && left < right) chosen.add(entry.i);
            else uncertain.push({ id:entry.i, lo, hi });
        }
        // Sweep uncertain intervals in source order. Every point answer admits
        // all candidate items it contains, and later intervals skip the prefix
        // already queried. This avoids retaining a set of hits per character or
        // rescanning the same empty inserted text for every overlapping origin.
        const candidates = new Set(uncertain.map(origin => origin.id));
        uncertain.sort((a,b) => a.lo-b.lo || a.hi-b.hi);
        let scannedUntil = -1;
        for (const { id, lo, hi } of uncertain) {
            if (chosen.has(id)) continue;
            for (let n = Math.max(lo, scannedUntil); n < hi || n === lo; ) {
                if (!current()) return null;
                let low = 0, high = starts.length;
                while (low + 1 < high) {
                    const mid = (low + high) >> 1;
                    if (starts[mid] <= n) low = mid; else high = mid;
                }
                const answer = await this._forward(relative, low + 1, n - starts[low]);
                if (!current()) return null;
                for (const hit of answer.hits) {
                    if (!candidates.has(hit.item_id)) continue;
                    const entry = this._byItem.get(hit.item_id);
                    if (!entry || entry.page !== hit.item.page) return null;
                    chosen.add(hit.item_id);
                }
                n += text[n] === '\r' && text[n + 1] === '\n' ? 2 : text.codePointAt(n) > 0xffff ? 2 : 1;
                scannedUntil = n;
                if (chosen.has(id)) break;
            }
        }
        if (!current()) return null;
        return [...chosen].map(id => this._byItem.get(id))
            .map(e => ({ page:e.page, x:e.x, y:e.y, w:e.w, h:e.boxHeight }))
            .sort((a,b) => a.page-b.page || a.y-b.y || a.x-b.x);
    }
    fontOf() { return null; }
    fileOf(fileId) { return typeof fileId === 'string' ? fileId : null; }
    glyphAt(page, x, y) {
        if (!this.available) return { glyph: null, distance: Infinity };
        const entries = (this._pages.get(page) || []).filter(e => e.file &&
            x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.boxHeight);
        return { glyph: entries.at(-1) || null, distance: entries.length ? 0 : Infinity };
    }
    lineAtPoint(page, x, y) {
        const { glyph } = this.glyphAt(page, x, y);
        return glyph ? { file: glyph.file, line: glyph.line, dx: 0, dy: 0, distance: 0,
            lead: glyph.boxHeight, glyph, exact: glyph.hit.preferred_source.location.accuracy === 'Exact' } : null;
    }
    renderToSource(page, x, y) {
        const hit = this._wordTyped(page, this._under(page, x, y));
        if (!hit) return this._generatedAt(page, x, y) || this._nearestAt(page, x, y) ||
            { flag: FLAG.UNMAPPED, reason: 'no native source box contains this point' };
        return this._sourceOf(hit, page, x, y);
    }

    /**
     * NEAR, RATHER THAN NOTHING. A point on ink with no source of its own (a
     * gap between glyph boxes, a rule, a letter a macro built) answers with
     * the nearest sourced glyph — on the same line first: at most a line's
     * height away, an inch along it. Farther (a margin, inside a figure) it
     * answers nothing, rather than somewhere unrelated. Marked `approximate`.
     */
    _nearestAt(page, x, y) {
        if (!this.available) return null;
        let best = null, cost = Infinity;
        for (const e of this._pages.get(page) || []) {
            if (!e.file) continue;
            const dx = Math.max(0, e.x - x, x - (e.x + e.w)), dy = Math.max(0, e.y - y, y - (e.y + e.boxHeight));
            if (dy > Math.max(6, e.boxHeight) || dx > 72) continue;
            const c = dx + 4 * dy;
            if (c < cost) { cost = c; best = e; }
        }
        const hit = best && this._wordTyped(page, [best]);
        return hit ? { ...this._sourceOf(hit, page, x, y), approximate: true, exact: false } : null;
    }

    /**
     * The glyphs printed nearest a source position that prints none itself
     * (a letter `\MakeUppercase` rebuilt, a character a macro swallowed): on
     * its line, the glyph whose source column is closest; else on the nearest
     * line within two that prints. Empty when nothing near prints.
     */
    _nearestPrinted(file, line, column) {
        const absolute = path.resolve(file);
        for (const delta of [0, -1, 1, -2, 2]) {
            let best = null, distance = Infinity;
            for (const e of this.glyphsForLine(absolute, line + delta)) {
                for (const origin of e.hit.mapped_origins || []) {
                    const at = origin.source.location.start;
                    if (at.line !== line + delta || path.resolve(this.projectDir, origin.source.file) !== absolute) continue;
                    const d = delta === 0 ? Math.abs(at.column_utf16 - column) : at.column_utf16;
                    if (d < distance) { distance = d; best = e; }
                }
            }
            if (best) return [{ page: best.page, x: best.x, y: best.y, w: best.w, h: best.boxHeight, approximate: true }];
        }
        return [];
    }

    /** Every glyph under the point, sourced or not, in paint order. */
    _under(page, x, y) {
        if (!this.available) return [];
        return (this._pages.get(page) || []).filter(e => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.boxHeight);
    }

    /** Whether a glyph's own characters were typed in the project (its
     *  definition is a project position), not only called from there. */
    _typed(e) {
        const d = e?.hit?.item?.provenance?.definition;
        return !!(e?.file && d?.tag && (e.hit.mapped_origins || []).some(o =>
            o.span.tag === d.tag && o.span.line === d.line && o.span.column === d.column));
    }

    /**
     * THE WORD, NOT THE LETTER. `\MakeUppercase` (expl3's case changer, in
     * running heads, amsart's author line) builds each changed character as a
     * new token: it prints with no source, or only with the command that
     * called it (`\maketitle`), while a letter it left alone still points into
     * `\author{…}`. The letters of one printed word sit edge to edge, so a
     * glyph that is not typed takes the source of the nearest typed glyph of
     * its word. Falls back to the topmost sourced glyph under the point.
     */
    _wordTyped(page, under) {
        const top = under.filter(e => e.file).at(-1) || under.at(-1) || null;
        if (!top || this._typed(top)) return top && top.file ? top : null;
        const row = (this._rowsOf ||= new Map());
        const key = `${page}|${top.row}`;
        if (!row.has(key)) row.set(key, (this._pages.get(page) || []).filter(e => e.row === top.row).sort((a, b) => a.x - b.x));
        const line = row.get(key);
        const at = line.indexOf(top);
        const gap = Math.max(0.5, 0.12 * top.boxHeight);
        for (const step of [-1, 1]) {
            for (let i = at + step, prev = top; i >= 0 && i < line.length; prev = line[i], i += step) {
                const e = line[i];
                const apart = step < 0 ? prev.x - (e.x + e.w) : e.x - (prev.x + prev.w);
                if (apart > gap) break;
                if (this._typed(e)) return e;
            }
        }
        return top.file ? top : null;
    }

    /**
     * TEXT THE BUILD WROTE ITSELF. A bibliography entry is typeset from the
     * .bbl BibTeX wrote, a contents line from the .toc: no project source, but
     * a reader clicking one wants the entry in the .bib, or the heading. The
     * worker says where in the generated file the text came from
     * (`generated_source`); this follows it back. Null when it cannot.
     */
    _generatedAt(page, x, y) {
        if (!this.available) return null;
        const entry = (this._pages.get(page) || []).filter(e => e.hit.generated_source &&
            x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.boxHeight).at(-1);
        if (!entry) return null;
        const generated = entry.hit.generated_source;
        const target = this._followGenerated(generated);
        if (!target) return null;
        return { flag: FLAG.PROBABLY_CURRENT, file: target.file, line: target.line, column: target.column || 0,
            exact: false, generated,
            box: { page, xBp: entry.x, yTopBp: entry.y, wBp: entry.w, hBp: entry.boxHeight, kind: 'native-generated', line: target.line },
            object: this.objectAtLine(target.file, target.line) || undefined, glyph: entry, nativeHit: entry.hit };
    }

    _followGenerated(generated) {
        const key = `${generated.file}\0${generated.line}`;
        this._followed ||= new Map();
        if (this._followed.has(key)) return this._followed.get(key);
        let target = null;
        const lines = [this.projectDir, this.outDir].filter(Boolean)
            .map(dir => linesOf(this._files, path.join(dir, generated.file))).find(Boolean);
        const extension = path.extname(generated.file).toLowerCase();
        if (lines && extension === '.bbl') {
            // The entry's key, from the \bibitem (or amsrefs' \bib{key}{type})
            // at or above the line.
            let bibkey = null;
            for (let i = Math.min(generated.line, lines.length) - 1; i >= 0 && !bibkey; i--)
                bibkey = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}|\\bib\s*\{([^}]+)\}\s*\{/.exec(lines[i])?.slice(1).find(Boolean) || null;
            if (bibkey) {
                const pattern = new RegExp(`^\\s*@\\w+\\s*[{(]\\s*${bibkey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`);
                for (const bib of projectFiles(this.projectDir, '.bib')) {
                    const at = (linesOf(this._files, bib) || []).findIndex(l => pattern.test(l));
                    if (at >= 0) { target = { file: bib, line: at + 1, column: 0, bibkey }; break; }
                }
            }
            // No .bib record (an arXiv source ships only its .bbl): the entry
            // in the project's own .bbl, the file the writer edits then.
            const shipped = path.join(this.projectDir, generated.file);
            if (!target && linesOf(this._files, shipped)) target = { file: shipped, line: generated.line, column: generated.column || 0 };
        } else if (lines && ['.toc', '.lof', '.lot'].includes(extension)) {
            // \contentsline{section}{\numberline{1}Title}{page}{anchor}: the heading with that title.
            const line = lines[generated.line - 1] || '';
            const m = /\\contentsline\s*\{(\w+)\}\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(line);
            if (m) {
                const title = m[2].replace(/\\numberline\s*\{[^}]*\}/, '').replace(/\s+/g, ' ').trim();
                const command = { figure: 'caption', table: 'caption' }[m[1]] || m[1];
                const wanted = new RegExp(`\\\\${command}\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{`);
                // Words of the title only: not the commands around it (amsart's
                // \tocsection{}{1.1}{Title}), nor numbers.
                const words = title.replace(/\\[a-zA-Z]+\*?/g, ' ').match(/[A-Za-z]{3,}/g) || [];
                // The heading holding most of the title's words (a title
                // written with macros keeps some of them in the source).
                let best = 0;
                for (const tex of projectFiles(this.projectDir, '.tex')) {
                    const source = linesOf(this._files, tex) || [];
                    source.forEach((l, at) => {
                        if (!words.length || !wanted.test(l)) return;
                        const score = words.filter(w => l.includes(w)).length / words.length;
                        if (score > best && score >= 0.5) {
                            best = score;
                            target = { file: tex, line: at + 1, column: Math.max(0, l.search(wanted)) };
                        }
                    });
                }
            }
        }
        this._followed.set(key, target);
        return target;
    }
    /**
     * Point-to-source through the worker's inverse query, so overlapping ink is
     * resolved by the engine's paint order rather than by the last cached
     * rectangle. Falls back to the local containment answer when the page is
     * not materialized or the worker cannot answer.
     */
    async renderToSourceViaWorker(page, x, y) {
        const header = this._headers.get(page);
        if (!this.available || !header || !this.source?.inverse) return this.renderToSource(page, x, y);
        const scale = header.magnification / 1000;
        const xSp = Math.round(bpToSp((x - 72) / scale)), ySp = Math.round(bpToSp((y - 72) / scale));
        let reply;
        try { reply = await (this.live ? this.source.inverse(page, xSp, ySp, { live: true }) : this.source.inverse(page, xSp, ySp)); }
        catch (_) { return this.renderToSource(page, x, y); }
        if (!this.available) return { flag: FLAG.UNMAPPED, reason: 'the native map changed during the query' };
        const glyph = this._wordTyped(page, (reply.hits || []).map(h => this._byItem.get(h.item_id)).filter(Boolean));
        if (!glyph) return this._generatedAt(page, x, y) || this._nearestAt(page, x, y) ||
            { flag: FLAG.UNMAPPED, reason: 'no native source glyph under this point' };
        return this._sourceOf(glyph, page, x, y);
    }
    /**
     * WHERE THE READER MEANT. A glyph's characters are written where they are
     * defined; for a macro's body (`\DeclareMathOperator{\Gr}{Gr}`, a
     * `\newcommand`) that is the preamble or a package, far from the `\Gr`
     * in the text that printed it. A click answers with that call site when
     * the definition is in a preamble or package and the call is not; text
     * typed in the body (a macro's argument) keeps its own position.
     */
    _clickSource(hit) {
        const preferred = hit.preferred_source;
        const { definition, invocation } = hit.item?.provenance || {};
        if (!preferred || !definition?.tag || !invocation?.tag) return preferred;
        const origin = span => (hit.mapped_origins || []).find(o =>
            o.span.tag === span.tag && o.span.line === span.line && o.span.column === span.column)?.source;
        const defined = origin(definition), called = origin(invocation);
        if (!defined || !called || defined === called) return preferred;
        return this._inDefinition(defined) && !this._inDefinition(called) ? called : preferred;
    }

    /**
     * Whether a source position is inside a macro definition — the body of a
     * `\newcommand`, `\def`, `\DeclareMathOperator`, … (the command on its
     * line or up to eight lines above, its braces still open there) — or in a
     * package or class file. Not the rest of a preamble: `\title{…}` and
     * `\author{…}` are typed there and print where `\maketitle` puts them.
     */
    _inDefinition(source) {
        const file = path.resolve(this.projectDir, source.file);
        if (!/\.(tex|ltx)$/i.test(file)) return true;
        const relative = path.relative(this.projectDir, file).split(path.sep).join('/');
        const lines = (this.source?.files?.get?.(relative)?.text ?? (linesOf(this._files, file) || []).join('\n')).split('\n');
        const { line, column_utf16: column } = source.location.start;
        const DEFINES = /\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|(?:re)?newenvironment|[gex]?def|NewDocumentCommand|RenewDocumentCommand|DeclareDocumentCommand)\b/;
        for (let first = line - 1; first >= Math.max(0, line - 9); first--) {
            const at = (lines[first] || '').replace(/(^|[^\\])%.*$/, '$1').search(DEFINES);
            if (at < 0) continue;
            const span = first === line - 1
                ? (lines[first] || '').slice(at, Math.max(at, column))
                : [(lines[first] || '').slice(at), ...lines.slice(first + 1, line - 1), (lines[line - 1] || '').slice(0, column)].join('\n');
            if (insideDefinition(span)) return true;
        }
        return false;
    }

    _sourceOf(glyph, page, x, y) {
        const chosen = this._clickSource(glyph.hit);
        const location = chosen.location;
        const file = chosen === glyph.hit.preferred_source ? glyph.file : path.resolve(this.projectDir, chosen.file);
        const exact = location.accuracy === 'Exact';
        const origin = glyph.hit.mapped_origins.find(o => o.source.file === chosen.file &&
            o.source.location.start.line === location.start.line && o.source.location.start.column_utf16 === location.start.column_utf16 &&
            o.source.location.end.line === location.end.line && o.source.location.end.column_utf16 === location.end.column_utf16);
        return { flag: FLAG.PROBABLY_CURRENT, file,
            line: location.start.line, column: location.start.column_utf16, sourceRange: location,
            generationLine: exact ? origin?.span.line : undefined,
            box: { page, xBp: glyph.x, yTopBp: glyph.y, wBp: glyph.w, hBp: glyph.boxHeight, kind: 'native', line: location.start.line },
            object: this.objectAtLine(file, location.start.line) || undefined,
            candidates: (this._pages.get(page) || []).filter(e => x >= e.x && x <= e.x+e.w && y >= e.y && y <= e.y+e.boxHeight).length,
            exact, glyph, nativeHit: glyph.hit };
    }
    _rows(entries) {
        const rows = new Map();
        for (const e of entries) {
            const key = `${e.page}|${e.row}`;
            const row = rows.get(key) || { page: e.page, row: e.row, x0: Infinity, y0: Infinity,
                x1: -Infinity, y1: -Infinity, yBaselineBp: e.baseline, xs: [], ids: new Set() };
            if (row.ids.has(e.i)) continue;
            row.ids.add(e.i);
            row.x0 = Math.min(row.x0, e.x); row.y0 = Math.min(row.y0, e.y);
            row.x1 = Math.max(row.x1, e.x+e.w); row.y1 = Math.max(row.y1, e.y+e.boxHeight);
            row.xs.push(e.x, e.x+e.w); rows.set(key, row);
        }
        return [...rows.values()].map(r => ({ page:r.page, row:r.row, x:r.x0, y:r.y0,
            w:r.x1-r.x0, h:r.y1-r.y0, yBaselineBp:r.yBaselineBp,
            xs:r.xs.sort((a,b)=>a-b), glyphs:r.ids.size })).sort((a,b)=>a.page-b.page || a.y-b.y || a.x-b.x);
    }
    lineRows(file, line) { return this._rows(this.glyphsForLine(file, line)); }
    rangeRows(file, start, end) {
        const entries = [];
        for (let line=start; line<=end; line++) entries.push(...this.glyphsForLine(file,line));
        return this._rows(entries);
    }
    sourceToRender(file, start, end=start) {
        const rows = this.rangeRows(file,start,end), pages = [...new Set(rows.map(r=>r.page))];
        return { flag: rows.length ? this._baseFlag() : FLAG.UNMAPPED, pages, page: pages[0] || null,
            boxes: rows.map(r=>({page:r.page,kind:'native-row',line:start,xBp:r.x,yTopBp:r.y,wBp:r.w,hBp:r.h})),
            exact: !!rows.length && !this.displaced, matchedLine: rows.length ? start : null };
    }
    linesOnPage(page, file) {
        if (!this.available) return [];
        const absolute = path.resolve(file), lines = new Set();
        for (const e of this._pages.get(page) || []) for (const o of e.hit.mapped_origins)
            if (path.resolve(this.projectDir,o.source.file) === absolute)
                for (const line of originLines(o.source.location)) lines.add(line);
        return [...lines].sort((a,b)=>a-b);
    }
    coverage(file,total) {
        let covered=0;
        for(let line=1;line<=total;line++) if(this.glyphsForLine(file,line).length) covered++;
        return {covered,total,fraction:total ? covered/total : 0};
    }
    pageOccupancy(page) {
        if (!this.available || !this._pages.has(page)) return {flag:FLAG.UNMAPPED,page,fill:0,bars:0};
        const rows=this._rows(this._pages.get(page).filter(e=>e.file));
        const intervals=rows.map(r=>[r.y,r.y+r.h]).sort((a,b)=>a[0]-b[0]);
        let covered=0, end=-Infinity;
        for(const [a,b] of intervals) { covered+=Math.max(0,b-Math.max(a,end)); end=Math.max(end,b); }
        const height=this.pageSize.heightBp, fill=Math.min(1,covered/height);
        return {flag:this._baseFlag(),page,fill,bars:Math.round(fill*5),coveredBp:covered,textHeightBp:height,rows:rows.length,records:this._pages.get(page).length};
    }
    window(file,line) { return this.glyphsForLine(file,line).length ? {startLine:line,endLine:line,collector:line} : null; }
    lineMap(o={}) {
        if (!this.available) return null;
        const entries=this.glyphsForLine(o.file,o.line), glyphs=[], tokens=[], pairs=[];
        for(const e of entries) {
            const origins=e.hit.mapped_origins.filter(origin=>path.resolve(this.projectDir,origin.source.file)===path.resolve(o.file) &&
                origin.source.location.accuracy==='Exact' && origin.source.location.start.line===o.line);
            if (!origins.length) continue;
            const g=glyphs.length;
            glyphs.push({page:e.page,x:e.x,y:e.y,w:e.w,h:e.boxHeight,inkY:e.y,inkH:e.boxHeight,baseline:e.baseline,font:`native:${e.fontId}`,ch:'',level:'base',nativeHit:e.hit});
            for(const origin of origins) {
                const loc=origin.source.location;
                if(loc.end.line!==loc.start.line || loc.end.column_utf16<=loc.start.column_utf16) continue;
                const ch=(o.lines?.[loc.start.line-1] || '').slice(loc.start.column_utf16,loc.end.column_utf16);
                pairs.push({g,token:{line:loc.start.line,startCol:loc.start.column_utf16,endLine:loc.end.line,endCol:loc.end.column_utf16,ch,key:ch}});
            }
        }
        if (!pairs.length) return null;
        pairs.sort((a,b)=>a.token.line-b.token.line || a.token.startCol-b.token.startCol || a.token.endCol-b.token.endCol);
        const srcToRen=new Int32Array(pairs.length), renToSrc=new Int32Array(glyphs.length).fill(-1);
        pairs.forEach((p,i)=>{tokens.push(p.token);srcToRen[i]=p.g;if(renToSrc[p.g]<0)renToSrc[p.g]=i;});
        return {native:true,tokens,glyphs,srcToRen,renToSrc,matched:pairs.length,confidence:1,window:this.window(o.file,o.line)};
    }
}
module.exports = { NativeMap, rectangle };
