'use strict';

// Review PDFs are immutable snapshots, compiled away from the live viewer.
// The complete document preserves packages, macros, counters and references.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { compile } = require('./compileService');
const { RenderMap } = require('./renderMap');
const { scanTex } = require('./texScanner');
const { buildModel } = require('./texModel');
const { buildObjectMap, sourceTokens, renderedGlyphs, symbolicFonts } = require('./glyphAlign');
const { collectMacros } = require('./texWords');
const { refineHunk } = require('./texDiff');

function contextRange(text, file, range, model) {
    const lines = text.split(/\r?\n/);
    let startLine = Math.max(1, range.startLine), endLine = Math.min(lines.length, Math.max(startLine, range.endLine - 1));
    model ||= buildModel(scanTex(text), { file });
    for (const obj of model.objects) {
        const r = obj.sourceRange;
        if (r && r.startLine <= endLine && r.endLine >= startLine && obj.kind !== 'label') {
            startLine = Math.min(startLine, r.startLine); endLine = Math.max(endLine, r.endLine);
        }
    }
    // Run-in headings and their body are one printed paragraph, even when
    // the scanner cannot emit a paragraph beside a following display.
    if (/\\(?:sub)?paragraph\b/.test(lines.slice(startLine - 1, endLine).join('\n'))) {
        while (endLine < lines.length) {
            const next = lines[endLine];
            if (!next.trim() || /^\s*\\(?:begin|end|part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\b|^\s*\\\[/.test(next)) break;
            endLine++;
        }
    }
    return { lines, startLine, endLine, model };
}

function inkCrops(glyphs) {
    return [...new Set(glyphs.map(g => g.page))].sort((a,b) => a - b).map(page => {
        const gs = glyphs.filter(g => g.page === page);
        const x = Math.max(0, Math.min(...gs.map(g => g.x)) - 4);
        const y = Math.max(0, Math.min(...gs.map(g => g.inkY ?? g.y)) - 4);
        return { page, x, y, w:Math.max(...gs.map(g => g.x + g.w)) - x + 4,
            h:Math.max(...gs.map(g => (g.inkY ?? g.y) + (g.inkH ?? g.h))) - y + 4 };
    });
}

function mergeCrops(crops) {
    return [...new Set(crops.map(c => c.page))].sort((a,b) => a - b).map(page => {
        const cs = crops.filter(c => c.page === page);
        const x = Math.min(...cs.map(c => c.x)), y = Math.min(...cs.map(c => c.y));
        return { page, x, y, w:Math.max(...cs.map(c => c.x + c.w)) - x,
            h:Math.max(...cs.map(c => c.y + c.h)) - y };
    });
}

function proseClips(items) {
    // Clip row envelopes, not individual PDF glyph boxes: radicals, accents
    // and rules can extend outside the text layer's font rectangle.
    const rows = [];
    for (const it of items.slice().sort((a,b) => a.page - b.page || a.baseline - b.baseline)) {
        let row = rows.at(-1);
        if (!row || row.page !== it.page || it.baseline - row.baseline > 4) {
            row = { page:it.page, baseline:it.baseline, x:it.x, y:it.inkY ?? it.y,
                right:it.x + it.w, bottom:it.inkY != null ? it.inkY + it.inkH : it.baseline };
            rows.push(row);
        } else {
            row.x = Math.min(row.x, it.x); row.y = Math.min(row.y, it.inkY ?? it.y);
            row.right = Math.max(row.right, it.x + it.w);
            row.bottom = Math.max(row.bottom, it.inkY != null ? it.inkY + it.inkH : it.baseline);
        }
    }
    return rows.map(r => ({ page:r.page, x:r.x - 2, y:r.y - 2, w:r.right - r.x + 4, h:r.bottom - r.y + 4 }));
}

function anchoredItems(context, macros, items) {
    // SyncTeX gives a page, not a dependable paragraph boundary. Locate long
    // literal prose runs in that page's text before aligning individual math
    // glyphs. This cannot mistake a few shared t/a/b symbols for a paragraph.
    const tokens = sourceTokens({ ...context, macros, inMath:false });
    // PDF content order retains short continuation rows. The display layout
    // heuristic can mistake a narrow final prose row for a subscript.
    const glyphs = items.flatMap(it => renderedGlyphs([it]));
    const keys = glyphs.map(g => g.key).join('');
    const runs = []; let run = '';
    for (const t of tokens) {
        if (t.inMath) { if (run) runs.push(run); run = ''; }
        else run += t.key;
    }
    if (run) runs.push(run);
    const anchors = [];
    for (const text of runs.filter(s => s.length >= 8)) {
        for (const part of new Set([text.slice(0, 32), text.slice(-32)])) {
            const at = keys.indexOf(part);
            // Repeated prose is not enough evidence to choose an occurrence.
            if (at < 0 || keys.indexOf(part, at + 1) >= 0) continue;
            // Keys can fold ligatures into multiple letters.
            let offset = 0;
            for (const g of glyphs) {
                if (offset < at + part.length && offset + g.key.length > at) anchors.push(g);
                offset += g.key.length;
            }
        }
    }
    if (!anchors.length) return null;
    const bands = [...new Set(anchors.map(g => g.page))].map(page => {
        const gs = anchors.filter(g => g.page === page);
        return { page, top:Math.min(...gs.map(g => g.baseline)) - 4,
            bottom:Math.max(...gs.map(g => g.baseline)) + 4 };
    });
    return items.filter(it => bands.some(b => b.page === it.page &&
        it.baseline >= b.top && it.baseline <= b.bottom));
}

function changedRanges(hunk, side) {
    const text = side === 'before' ? hunk.theirText : hunk.ourText;
    if (!text) return [];
    if (hunk.verb === 'add' || hunk.verb === 'del')
        return text.split(/\r?\n/).map((s, line) => ({ line, col:0, len:s.length }));
    const diff = refineHunk(hunk.ourText, hunk.theirText, hunk.wordContext);
    return side === 'before' ? diff.bRanges : diff.aRanges;
}

function marksFor(snapshot, detail, items) {
    const { context, ranges, startLine } = detail;
    if (detail.regions?.length) {
        const results = detail.regions.map(region => marksFor(snapshot, {
            ...detail, regions:null, context:{ ...context, startLine:region.startLine, endLine:region.endLine },
            crops:region.rows, rows:region.rows, inMath:region.inMath,
            ranges:ranges.filter(r => startLine + r.line >= region.startLine && startLine + r.line <= region.endLine),
        }, items));
        const error = results.find(r => r.error)?.error;
        return { marks:error ? [] : results.flatMap(r => r.marks),
            crops:error ? [] : mergeCrops(results.flatMap(r => r.crops || [])),
            clipRects:error ? [] : results.flatMap(r => r.clipRects || []),
            mapped:error ? 0 : results.reduce((n,r) => n + r.mapped,0), changed:ranges.length, ...(error ? { error } : {}) };
    }
    // Restrict PDF items to the source block's measured rows, rather than
    // matching repeated words in neighbouring paragraphs or page headers.
    // A display's SyncTeX row can describe only its equation tag. The context
    // crop includes its body too; align all ink inside that bounded context.
    const prose = !detail.inMath;
    const measured = items.filter(it => (detail.crops || detail.rows).some(r => r.page === it.page &&
        it.baseline >= r.y - 2 && it.baseline <= r.y + r.h + 2 && it.x < r.x + r.w + 2 && it.x + it.w > r.x - 2));
    const anchored = prose && anchoredItems(context, snapshot.macros, items);
    // This context can contain both prose and complete display environments.
    // Project math arguments too (e.g. \boxed); the prose-only projection
    // intentionally treats those commands as opaque.
    // PDF content retains TeX's fraction/script order. Reconstructing it from
    // geometry hoists nested superscripts ahead of their bases and can make
    // a correctly compiled equation fail the coverage check altogether.
    const fonts = symbolicFonts(items);
    const project = selected => {
        // Free outer gaps leave generated tags unpaired. Filtering numeric
        // PDF runs first can also remove real superscripts inside fractions.
        return buildObjectMap({ ...context, items:selected, macros:snapshot.macros, inMath:!prose,
            glyphs:selected.flatMap(it => renderedGlyphs([it], 4, fonts)), order:'source',
            alignOptions:{ freeRenderedEnds:true, srcLevels:null, renLevels:null } });
    };
    const coverageOf = map => map.tokens.length ? map.matched / map.tokens.length : 0;
    let selected = anchored || measured, map = project(selected);
    // Literal anchors can stop before a final line consisting mostly of
    // inline maths. Retry the measured source rows, still requiring the full
    // source coverage so an unrelated display cannot become the paragraph.
    if (anchored && coverageOf(map) < .8) {
        const fallback = project(measured);
        if (coverageOf(fallback) > coverageOf(map)) { selected = measured; map = fallback; }
    }
    // Coverage must describe the source, not whichever side happens to be
    // shorter. A small unrelated formula can match most of its own symbols.
    const coverage = coverageOf(map);
    if (coverage < .8) return { marks:[], crops:[], mapped:0, changed:ranges.length,
        error:`The printed ${prose ? 'paragraph' : 'equation'} could not be located reliably.` };
    const marks = [], mapped = new Set();
    for (let i = 0; i < map.tokens.length; i++) {
        const token = map.tokens[i], j = map.srcToRen[i];
        if (j == null || j < 0) continue;
        const g = map.glyphs[j];
        for (let k = 0; k < ranges.length; k++) {
            const r = ranges[k], line = startLine + r.line;
            if (token.line > line || token.endLine < line ||
                token.line === line && token.startCol >= r.col + r.len ||
                token.endLine === line && token.endCol <= r.col) continue;
            marks.push({ page:g.page, x:g.x, y:g.inkY ?? g.y, w:g.w, h:g.inkH ?? g.h });
            mapped.add(k); break;
        }
    }
    const indices = [...new Set([...map.srcToRen].filter(j => j >= 0))];
    const matched = indices.map(j => map.glyphs[j]);
    // Keep unprojectable ink inside the located formula too: for example
    // PDF fonts can report Delta as ∆ instead of Δ, or draw two bars for |.
    // Highlighting needs exact matches; rendering needs the whole formula.
    const first = Math.min(...indices); let end = Math.max(...indices) + 1;
    if (!prose) {
        // A wide display can put its tag on a separate baseline. Retain the
        // complete trailing tag rather than clipping its tail into the prose.
        const tail = map.glyphs.slice(end).map(g => g.ch).join('');
        const tag = /^(?:\([0-9]+[A-Za-z.]*\)|\[[0-9]+[A-Za-z.]*\])/.exec(tail);
        if (tag) end += [...tag[0]].length;
    }
    const ink = prose ? matched : map.glyphs.slice(first, end);
    return { marks, crops:inkCrops(ink),
        // Keep a following display's raised numerator out of the blank space
        // beside a short final prose row, even when their vertical ink overlaps.
        clipRects:prose ? proseClips(selected) : inkCrops(ink),
        mapped:mapped.size, changed:ranges.length };
}

function regionsFor(snapshot, context, file) {
    const displays = context.model.objects.filter(obj => /equation/.test(obj.kind) &&
        obj.sourceRange.startLine >= context.startLine && obj.sourceRange.endLine <= context.endLine)
        .sort((a,b) => a.sourceRange.startLine - b.sourceRange.startLine);
    const regions = []; let from = context.startLine;
    const prose = (a,b) => {
        if (b < a) return;
        const rs = [];
        for (let n = a; n <= b; n++) rs.push(...snapshot.map.lineRows(file, n));
        if (sourceTokens({ lines:context.lines, startLine:a, endLine:b, macros:snapshot.macros, inMath:false }).length)
            regions.push({ startLine:a, endLine:b, rows:rs, inMath:false });
    };
    for (const obj of displays) {
        const r = obj.sourceRange;
        prose(from, r.startLine - 1);
        regions.push({ startLine:r.startLine, endLine:r.endLine,
            rows:snapshot.map.objectRenderBoxes(obj).rects, inMath:true });
        from = r.endLine + 1;
    }
    prose(from, context.endLine);
    return displays.length ? regions : null;
}

function frozenNativeMap(map, overlay, generation) {
    // Copy measured rows, not a SourceSession that becomes stale on typing.
    // A windowed or live map cannot describe the complete settled PDF.
    if (!map?.native || map.live || !map.available || map.displaced ||
        map.generation?.generation !== generation?.generation ||
        map.materializedPages?.length !== generation?.pageCount) return null;
    const rows = new Map();
    for (const [file, text] of overlay) {
        for (let line = 1, count = text.split('\n').length; line <= count; line++)
            rows.set(`${file}\0${line}`, map.lineRows(file, line).map(r => ({ page:r.page, x:r.x, y:r.y, w:r.w, h:r.h })));
    }
    return { lineRows:(file,line) => rows.get(`${file}\0${line}`) || [],
        objectRenderBoxes(obj) {
            const r = obj.sourceRange, rects = [];
            for (let line = r.startLine; line <= r.endLine; line++) rects.push(...this.lineRows(r.file, line));
            return { rects:mergeCrops(rects) };
        } };
}

class ReviewRenderer {
    constructor(o = {}) {
        this.compile = o.compile || compile;
        this.cache = new Map();
        this.pending = new Map();
        this.failures = new Map();
        this.fragments = new Map();
        this.orphans = new Set();
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-review-'));
        this.abort = null;
    }
    cancel() {
        this.abort?.abort(); this.abort = null;
        this.pending.clear(); this.failures.clear(); this.fragments.clear();
    }
    dispose() {
        this.disposed = true; this.cancel(); this.cache.clear();
        if (!this.active) fs.rmSync(this.dir, { recursive:true, force:true });
    }
    snapshotKey(o, overlay) {
        const hash = crypto.createHash('sha256').update(o.root).update('\0').update(o.engine);
        for (const [file, text] of [...overlay].sort(([a],[b]) => a.localeCompare(b))) hash.update(file).update('\0').update(text).update('\0');
        return hash.digest('hex');
    }
    async snapshot(o, overlay, signal) {
        const key = this.snapshotKey(o, overlay);
        if (this.cache.has(key)) {
            const snapshot = this.cache.get(key);
            this.cache.delete(key); this.cache.set(key, snapshot);
            return snapshot;
        }
        if (this.failures.has(key)) throw this.failures.get(key);
        if (this.pending.has(key)) return this.pending.get(key);
        const pending = this._snapshot(o, overlay, signal, key);
        this.pending.set(key, pending);
        try { return await pending; }
        catch (error) { if (!signal.aborted) this.failures.set(key, error); throw error; }
        finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
    }
    async _snapshot(o, overlay, signal, key) {
        const outDir = path.join(this.dir, key);
        // A settled PDF with the identical source bytes is already a preview.
        // Read its bytes and parse its map now; never retain a mutable live map
        // or remove the viewer's own artifacts on cache eviction.
        const candidate = o.generation;
        const sameSource = candidate?.ok && !candidate.errors && candidate.root === o.root && candidate.pdfPath &&
            require('./compileService').generationIsCurrent(candidate, [...overlay.keys()], overlay);
        const nativeMap = sameSource && candidate.runner === 'wlatex' && o.engine === 'xelatex'
            ? frozenNativeMap(o.map, overlay, candidate) : null;
        const reuse = sameSource && (nativeMap || candidate.engine === o.engine && candidate.synctexPath);
        const gen = reuse ? { ...candidate } : await this.compile({ root:o.root, projectDir:o.projectDir, engine:o.engine,
            sourceFiles:[...overlay.keys()], overlay, outDir, signal,
            timeoutMs:o.timeoutMs || 180000 });
        if (signal.aborted) { this.orphans.add(outDir); throw new Error('Preview cancelled'); }
        if (!gen.ok || gen.errors || !gen.pdfPath) {
            const diagnostic = gen.diagnostics?.find(x => x.severity === 'error');
            fs.rmSync(outDir, { recursive:true, force:true });
            throw new Error(diagnostic?.message || gen.issue?.message || 'This version did not compile. Use Code to inspect its LaTeX.');
        }
        const snapshot = { overlay, gen, pdfBase64:fs.readFileSync(gen.pdfPath).toString('base64'),
            key, ownedDir:reuse ? null : outDir, models:new Map(),
            map:nativeMap || new RenderMap({ generation:gen, pageSize:gen.pageSize }), macros:new Map() };
        for (const text of overlay.values()) for (const [name, value] of collectMacros(text)) snapshot.macros.set(name, value);
        this.cache.set(key, snapshot);
        while (this.cache.size > 4) {
            const oldest = this.cache.keys().next().value, stale = this.cache.get(oldest);
            this.cache.delete(oldest);
            if (stale.ownedDir) fs.rmSync(stale.ownedDir, { recursive:true, force:true });
        }
        return snapshot;
    }
    async render(o) {
        if (this.disposed) throw new Error('Review closed');
        const key = `${this.snapshotKey(o, o.before)}|${this.snapshotKey(o, o.after)}|${o.file}|${JSON.stringify(o.hunk)}|${!!o.skipAfter}`;
        if (this.fragments.has(key)) return this.fragments.get(key);
        this.active = (this.active || 0) + 1;
        try {
            // Selection changes share a build. Only source/review changes or
            // closing the viewer cancel the immutable snapshot preparation.
            const ac = this.abort ||= new AbortController();
            const result = {};
            await Promise.all((o.skipAfter ? ['before'] : ['before','after']).map(async side => {
                const range = side === 'before' ? o.hunk.theirRange : o.hunk.ourRange;
                const overlay = side === 'before' ? o.before : o.after;
                try {
                    if(range.endLine<=range.startLine){result[side]={empty:true};o.onSide?.(side,result[side]);return;}
                    const snapshot=await this.snapshot(o,overlay,ac.signal);
                    if(ac.signal.aborted)throw new Error('Preview cancelled');
                    const text = overlay.get(o.file);
                    if (!snapshot.models.has(o.file)) snapshot.models.set(o.file, buildModel(scanTex(text), { file:o.file }));
                    const context = contextRange(text, o.file, range, snapshot.models.get(o.file)), rows = [];
                    for (let line = context.startLine; line <= context.endLine; line++) rows.push(...snapshot.map.lineRows(o.file, line));
                    for (const obj of context.model.objects) {
                        const r = obj.sourceRange;
                        if (r && r.startLine >= context.startLine && r.endLine <= context.endLine &&
                            /equation|figure|table|tikz/.test(obj.kind)) rows.push(...snapshot.map.objectRenderBoxes(obj).rects);
                    }
                    if (!rows.length) throw new Error('This change has no printed content. Use Code to see the source change.');
                    const crops = [];
                    for (const page of [...new Set(rows.map(r => r.page))].sort((a,b) => a - b)) {
                        const rs = rows.filter(r => r.page === page);
                        const x = Math.max(0, Math.min(...rs.map(r => r.x)) - 5), y = Math.max(0, Math.min(...rs.map(r => r.y)) - 4);
                        crops.push({ page, x, y, w:Math.max(...rs.map(r => r.x + r.w)) - x + 5,
                            h:Math.max(...rs.map(r => r.y + r.h)) - y + 4 });
                    }
                    const detail = { snapshot, context, rows, crops, ranges:changedRanges(o.hunk, side), startLine:range.startLine };
                    detail.regions = regionsFor(snapshot, context, o.file);
                    result[side] = { pdfId:snapshot.key, pdfBase64:snapshot.pdfBase64, crops, detail };
                } catch (error) {
                    if (ac.signal.aborted) throw error;
                    result[side] = { error:error.message };
                }
                if(!ac.signal.aborted)o.onSide?.(side,result[side]);
            }));
            if (ac.signal.aborted) throw new Error('Preview cancelled');
            this.fragments.set(key, result);
            return result;
        } finally {
            this.active--;
            if (!this.active) {
                const kept = new Set([...this.cache.values()].map(s => s.ownedDir));
                for (const dir of this.orphans) if (!kept.has(dir)) fs.rmSync(dir, { recursive:true, force:true });
                this.orphans.clear();
            }
            if (this.disposed && !this.active) fs.rmSync(this.dir, { recursive:true, force:true });
        }
    }
    async preload(o, hunks) {
        const pdfs = new Map();
        for (const hunk of hunks) {
            if (this.disposed || o.isCurrent?.() === false) return;
            const result = await this.render({ ...o, hunk });
            for (const side of ['before', 'after']) {
                const preview = result[side];
                if (!preview?.pdfId) continue;
                if (!pdfs.has(preview.pdfId)) pdfs.set(preview.pdfId, {
                    pdfId:preview.pdfId, pdfBase64:preview.pdfBase64, pages:new Set() });
                for (const crop of preview.crops) pdfs.get(preview.pdfId).pages.add(crop.page);
            }
            // Leave input and live-render messages a turn between fragments.
            await new Promise(resolve => setImmediate(resolve));
        }
        return [...pdfs.values()].map(p => ({ ...p, pages:[...p.pages].sort((a,b) => a-b) }));
    }
}

module.exports = { ReviewRenderer, contextRange, changedRanges, marksFor, regionsFor };
