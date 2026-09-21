// WLaTeX page views -> WPaper's synchronous render-map contract.
// Every source position comes from the worker. No token alignment or line shifts.
const path = require('path');
const { RenderMap, FLAG } = require('./renderMap');
const { spToBp } = require('./texGeometry');

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

class NativeMap extends RenderMap {
    constructor(o = {}) {
        super({ ...o, generation: { ...o.generation, synctexPath: null }, synctexDoc: null });
        this.native = true;
        this.view = o.nativeView;
        this.source = o.nativeSource;
        this.projectDir = path.resolve(o.projectDir || o.generation?.projectDir || '.');
        this._invalidated = false;
        this._entries = [];
        this._byItem = new Map();
        this._hasDisplaced = false;
        this._pages = new Map();
        this._lines = new Map();
        this.pageCount = this.view?.artifact?.page_count || 0;
        if (!this.view || !this.source || !this.source.isCurrentView(this.view)) return;
        if (o.generation?.pdfHash && o.generation.pdfHash !== this.view.artifact.pdf_hash)
            throw Error('Native map does not belong to the displayed PDF');
        for (const page of this.view.pages) {
            if (!(page.header.magnification > 0)) throw Error('Invalid native magnification');
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
    glyphsForLine(file, line) {
        return this.available ? this._lines.get(`${path.resolve(file)}\0${line}`) || [] : [];
    }
    async _forward(file, line, column) {
        try { return await this.source.forward(file, line, column); }
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
        // Exact translated ranges are contiguous surviving source. Only
        // displaced/zero-length origins need worker membership queries. Cache
        // shared positions, and stop once an item's membership is established.
        const answers = new Map();
        const query = async n => {
            if (!answers.has(n)) {
                let low = 0, high = starts.length;
                while (low + 1 < high) {
                    const mid = (low + high) >> 1;
                    if (starts[mid] <= n) low = mid; else high = mid;
                }
                const answer = await this._forward(relative, low + 1, n - starts[low]);
                answers.set(n, new Set(answer.hits.map(hit => hit.item_id)));
            }
            return answers.get(n);
        };
        for (const { id, lo, hi } of uncertain) {
            if (chosen.has(id)) continue;
            for (let n = lo; n < hi || n === lo; ) {
                if (!current()) return null;
                const ids = await query(n);
                if (!current()) return null;
                if (ids.has(id)) { chosen.add(id); break; }
                if (n >= hi) break;
                n += text[n] === '\r' && text[n + 1] === '\n' ? 2 : text.codePointAt(n) > 0xffff ? 2 : 1;
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
        const { glyph } = this.glyphAt(page, x, y);
        if (!glyph) return { flag: FLAG.UNMAPPED, reason: 'no native source box contains this point' };
        const location = glyph.hit.preferred_source.location;
        const exact = location.accuracy === 'Exact';
        const origin = glyph.hit.mapped_origins.find(o => o.source.file === glyph.hit.preferred_source.file &&
            o.source.location.start.line === location.start.line && o.source.location.start.column_utf16 === location.start.column_utf16 &&
            o.source.location.end.line === location.end.line && o.source.location.end.column_utf16 === location.end.column_utf16);
        return { flag: FLAG.PROBABLY_CURRENT, file: glyph.file,
            line: location.start.line, column: location.start.column_utf16, sourceRange: location,
            generationLine: exact ? origin?.span.line : undefined,
            box: { page, xBp: glyph.x, yTopBp: glyph.y, wBp: glyph.w, hBp: glyph.boxHeight, kind: 'native', line: glyph.line },
            object: this.objectAtLine(glyph.file, glyph.line) || undefined,
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
