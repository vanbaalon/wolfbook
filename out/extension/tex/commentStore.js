'use strict';

// Shared WPaper comments.  The sidecar is deliberately plain JSON and lives
// beside the source it annotates: `paper.tex` -> `paper.timeline.comments`.
//
// A line number is a LOCATION, not an identity.  Each comment therefore points
// at a persistent cell id, while the cell remembers enough of the source
// object to find it again after an external edit or a restart.  Reattachment
// is conservative: an uncertain match stays detached and visible instead of
// silently moving a reader's comment to somebody else's paragraph.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeSource, similarity, sha256 } = require('./texModel');

const VERSION = 1;
const SIDECAR_SUFFIX = '.timeline.comments';
const clean = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n');
const iso = (n) => new Date(n).toISOString();

function sidecarFor(file) {
    const value = String(file || '');
    return /\.tex$/i.test(value)
        ? value.replace(/\.tex$/i, SIDECAR_SUFFIX)
        : value + SIDECAR_SUFFIX;
}

function freshRecord(file) {
    return {
        version: VERSION,
        source: path.basename(file || ''),
        updatedAt: null,
        cells: [],
        comments: [],
    };
}

function validAuthor(value) {
    if (!value || typeof value !== 'object') return undefined;
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    return name ? { name } : undefined;
}

function validRecord(value, file) {
    if (!value || value.version !== VERSION || !Array.isArray(value.cells) ||
        !Array.isArray(value.comments)) {
        throw new Error(`Invalid WPaper comment file: ${path.basename(sidecarFor(file))}`);
    }
    const seenCells = new Set();
    const cells = value.cells.flatMap((c) => {
        if (!c || typeof c.id !== 'string' || !c.id || seenCells.has(c.id)) return [];
        seenCells.add(c.id);
        return [{
            id: c.id,
            kind: String(c.kind || 'paragraph'),
            label: c.label == null ? null : String(c.label),
            stableKey: c.stableKey == null ? null : String(c.stableKey),
            sourceHash: c.sourceHash == null ? null : String(c.sourceHash),
            source: clean(c.source),
            sectionPath: Array.isArray(c.sectionPath) ? c.sectionPath.map(String) : [],
            line: Math.max(1, Number(c.line) || 1),
            endLine: Math.max(1, Number(c.endLine) || Number(c.line) || 1),
        }];
    });
    const seenComments = new Set();
    const comments = value.comments.flatMap((c) => {
        if (!c || typeof c.id !== 'string' || typeof c.cellId !== 'string' ||
            typeof c.text !== 'string' || !seenCells.has(c.cellId) || seenComments.has(c.id)) return [];
        seenComments.add(c.id);
        return [{
            id: c.id,
            cellId: c.cellId,
            text: c.text,
            createdAt: typeof c.createdAt === 'string' ? c.createdAt : null,
            updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : null,
            author: validAuthor(c.author),
            source: c.source === 'revision' ? 'revision' : 'reader',
            revision: c.revision && typeof c.revision === 'object' ? c.revision : undefined,
        }];
    });
    return {
        version: VERSION,
        source: typeof value.source === 'string' ? value.source : path.basename(file || ''),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        cells,
        comments,
    };
}

function objectSnapshot(obj) {
    const r = obj && obj.sourceRange || {};
    const source = clean(obj && obj.text);
    return {
        kind: String(obj && obj.kind || 'paragraph'),
        label: obj && obj.label ? String(obj.label) : null,
        stableKey: obj && obj.stableKey ? String(obj.stableKey) : null,
        sourceHash: obj && obj.sourceHash ? String(obj.sourceHash) : sha256(source),
        source,
        sectionPath: Array.isArray(obj && obj.sectionPath) ? obj.sectionPath.map(String) : [],
        line: Math.max(1, Number(r.startLine) || 1),
        endLine: Math.max(1, Number(r.endLine) || Number(r.startLine) || 1),
    };
}

const sameSection = (a, b) => (a || []).join('\u001f') === (b || []).join('\u001f');

/** Return the strongest unclaimed match for one persisted cell. */
function matchCell(cell, objects, claimed) {
    const available = objects.filter(o => !claimed.has(o));
    let hit = available.find(o => cell.label && o.label === cell.label && o.kind === cell.kind);
    if (hit) return { object: hit, rule: 'label' };
    hit = available.find(o => cell.stableKey && o.stableKey === cell.stableKey);
    if (hit) return { object: hit, rule: 'stableKey' };

    // Front matter used to fall through to a synthesized paragraph, or to an
    // anonymous wrapper such as `center`. Promote only those two legacy kinds,
    // and only when the new semantic cell covers the same source line. This
    // brings already-shared comments back without allowing a nearby abstract
    // or title page to steal an unrelated equation/list comment.
    const promoted = available
        .filter(o => ((cell.kind === 'paragraph' && ['abstract', 'titlepage'].includes(o.kind)) ||
            (cell.kind === 'environment' && o.kind === 'titlepage')) &&
            o.sourceRange && Number.isFinite(cell.line) &&
            cell.line >= o.sourceRange.startLine && cell.line <= o.sourceRange.endLine)
        .sort((a, b) => {
            const ah = cell.sourceHash && a.sourceHash === cell.sourceHash ? 0 : 1;
            const bh = cell.sourceHash && b.sourceHash === cell.sourceHash ? 0 : 1;
            if (ah !== bh) return ah - bh;
            return (a.sourceRange.endLine - a.sourceRange.startLine) -
                (b.sourceRange.endLine - b.sourceRange.startLine);
        });
    if (promoted.length) return { object: promoted[0], rule: 'frontmatter-promotion' };

    hit = available.find(o => cell.sourceHash && o.sourceHash === cell.sourceHash && o.kind === cell.kind);
    if (hit) return { object: hit, rule: 'sourceHash' };

    if (!cell.source) return null;
    let best = null;
    let score = 0;
    for (const o of available) {
        if (o.kind !== cell.kind || !sameSection(o.sectionPath, cell.sectionPath)) continue;
        const s = similarity(cell.source, o.text || '');
        if (s > score) { best = o; score = s; }
    }
    return best && score >= 0.6 ? { object: best, rule: `similarity:${score.toFixed(2)}` } : null;
}

/** Update persisted anchors and return cell-id -> current object. */
function reconcileRecord(record, objects) {
    const claimed = new Set();
    const bindings = new Map();
    let changed = false;
    for (const cell of record.cells) {
        const found = matchCell(cell, objects || [], claimed);
        if (!found) continue;
        claimed.add(found.object);
        bindings.set(cell.id, found.object);
        const snap = objectSnapshot(found.object);
        for (const key of ['kind', 'label', 'stableKey', 'sourceHash', 'source', 'line', 'endLine']) {
            if (cell[key] !== snap[key]) { cell[key] = snap[key]; changed = true; }
        }
        if (!sameSection(cell.sectionPath, snap.sectionPath)) {
            cell.sectionPath = snap.sectionPath;
            changed = true;
        }
    }
    return { record, bindings, changed };
}

function excerpt(text, max = 150) {
    const compact = normalizeSource(text || '').replace(/\\[A-Za-z@]+\*?/g, '').trim();
    return compact.length > max ? compact.slice(0, max - 1).trimEnd() + '\u2026' : compact;
}

/** A bounded, otherwise untouched TeX fragment for the viewer's KaTeX preview. */
function sourcePreview(text, max = 2400) {
    const source = clean(text || '').trim();
    if (source.length <= max) return source;
    // Do not append an ellipsis inside a TeX command or environment: the
    // viewer can explain that a long source was clipped without feeding a
    // deliberately broken token to KaTeX.
    return source.slice(0, max).trimEnd();
}

function markdownFor(items, root) {
    const title = root ? path.basename(root) : 'WPaper';
    const out = [`# Comments on ${title}`];
    for (const item of items || []) {
        const place = item.detached
            ? `${path.basename(item.file)} \u2014 detached`
            : `${path.basename(item.file)}:${item.line}${item.endLine > item.line ? '-' + item.endLine : ''}`;
        out.push('', `## ${place} \u00b7 ${item.kind || 'paragraph'}`);
        if (Array.isArray(item.sectionPath) && item.sectionPath.length) {
            out.push(`Section: ${item.sectionPath.join(' › ')}`);
        }
        if (item.source === 'revision') {
            const author = item.revision && item.revision.author && item.revision.author.name;
            out.push(`From revision${author ? ` by ${author}` : ''}${item.revision && item.revision.changeId ? ` \u00b7 ${item.revision.changeId}` : ''}`);
        }
        if (item.excerpt) {
            out.push('', '### Quoted passage', '', `> ${item.excerpt.replace(/\n/g, '\n> ')}`);
        }
        out.push('', '### Comment', '', String(item.text || '').trim());
    }
    return out.join('\n').trimEnd() + '\n';
}

class CommentStore {
    constructor(deps = {}) {
        this.fs = deps.fs || fs;
        this.now = deps.now || (() => Date.now());
        this.uuid = deps.uuid || (() => crypto.randomUUID());
    }

    read(file) {
        const sidecar = sidecarFor(file);
        if (!this.fs.existsSync(sidecar)) return freshRecord(file);
        return validRecord(JSON.parse(this.fs.readFileSync(sidecar, 'utf8')), file);
    }

    write(file, record) {
        const sidecar = sidecarFor(file);
        const stamp = iso(this.now());
        const value = validRecord({ ...record, updatedAt: stamp }, file);
        value.updatedAt = stamp;
        const body = JSON.stringify(value, null, 2) + '\n';
        const tmp = `${sidecar}.${process.pid}.${this.uuid()}.tmp`;
        this.fs.mkdirSync(path.dirname(sidecar), { recursive: true });
        this.fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o664 });
        this.fs.renameSync(tmp, sidecar);
        return value;
    }

    reconcile(file, objects, { write = true } = {}) {
        const value = reconcileRecord(this.read(file), objects || []);
        if (value.changed && write) value.record = this.write(file, value.record);
        return value;
    }

    ensureCell(file, obj, objects) {
        const state = this.reconcile(file, objects || [obj], { write: false });
        for (const [id, bound] of state.bindings) {
            if (bound === obj || (obj.stableKey && bound.stableKey === obj.stableKey)) {
                if (state.changed) state.record = this.write(file, state.record);
                return { record: state.record, cell: state.record.cells.find(c => c.id === id) };
            }
        }
        const cell = { id: `cell_${this.uuid()}`, ...objectSnapshot(obj) };
        state.record.cells.push(cell);
        return { record: state.record, cell };
    }

    add(file, obj, text, meta = {}, objects) {
        const body = String(text || '').trim();
        if (!body) return null;
        const { record, cell } = this.ensureCell(file, obj, objects);
        const stamp = iso(this.now());
        const comment = {
            id: `comment_${this.uuid()}`,
            cellId: cell.id,
            text: body,
            createdAt: stamp,
            updatedAt: stamp,
            author: validAuthor(meta.author),
            source: meta.source === 'revision' ? 'revision' : 'reader',
        };
        if (comment.source === 'revision' && meta.revision) comment.revision = meta.revision;
        record.comments.push(comment);
        this.write(file, record);
        return { ...comment, cell };
    }

    update(file, commentId, text) {
        const record = this.read(file);
        const comment = record.comments.find(c => c.id === commentId);
        if (!comment) return false;
        comment.text = String(text == null ? '' : text);
        comment.updatedAt = iso(this.now());
        this.write(file, record);
        return true;
    }

    delete(file, commentId) {
        const record = this.read(file);
        const before = record.comments.length;
        record.comments = record.comments.filter(c => c.id !== commentId);
        if (record.comments.length === before) return false;
        const used = new Set(record.comments.map(c => c.cellId));
        record.cells = record.cells.filter(c => used.has(c.id));
        if (record.comments.length) this.write(file, record);
        else {
            const sidecar = sidecarFor(file);
            if (this.fs.existsSync(sidecar)) this.fs.unlinkSync(sidecar);
        }
        return true;
    }

    clear(files) {
        // Read everything first. One malformed shared file must not leave a
        // half-cleared paper after the earlier sidecars were already removed.
        const ready = [];
        let count = 0;
        for (const file of new Set(files || [])) {
            const record = this.read(file);
            count += record.comments.length;
            const sidecar = sidecarFor(file);
            if (this.fs.existsSync(sidecar)) ready.push(sidecar);
        }
        for (const sidecar of ready) this.fs.unlinkSync(sidecar);
        return count;
    }

    list(files, modelForFile) {
        const items = [];
        const errors = [];
        for (const file of new Set(files || [])) {
            try {
                const objects = (typeof modelForFile === 'function' && modelForFile(file)) || [];
                const { record, bindings } = this.reconcile(file, objects);
                const cells = new Map(record.cells.map(c => [c.id, c]));
                const headings = objects.filter(o => o && o.kind === 'section-heading')
                    .sort((a, b) => a.sourceRange.startLine - b.sourceRange.startLine);
                const sectionAt = line => {
                    const heading = headings.filter(h => h.sourceRange.startLine <= line).pop();
                    return heading && Array.isArray(heading.sectionPath)
                        ? heading.sectionPath.map(String) : [];
                };
                for (const comment of record.comments) {
                    const cell = cells.get(comment.cellId);
                    if (!cell) continue;
                    const obj = bindings.get(cell.id);
                    const r = obj && obj.sourceRange || {};
                    items.push({
                        ...comment,
                        file,
                        sidecar: sidecarFor(file),
                        cellId: cell.id,
                        kind: obj && obj.kind || cell.kind,
                        label: obj && (obj.label || obj.title || obj.name) || cell.label,
                        line: obj ? r.startLine : cell.line,
                        endLine: obj ? r.endLine : cell.endLine,
                        excerpt: excerpt(obj ? obj.text : cell.source),
                        sourcePreview: sourcePreview(obj ? obj.text : cell.source),
                        sectionPath: Array.isArray(obj && obj.sectionPath) && obj.sectionPath.length
                            ? obj.sectionPath.map(String)
                            : (sectionAt(obj ? r.startLine : cell.line).length
                                ? sectionAt(obj ? r.startLine : cell.line)
                                : (cell.sectionPath || []).map(String)),
                        detached: !obj,
                    });
                }
            } catch (error) {
                errors.push({ file, sidecar: sidecarFor(file), message: error.message });
            }
        }
        items.sort((a, b) => Number(a.detached) - Number(b.detached) ||
            a.file.localeCompare(b.file) || a.line - b.line || String(a.createdAt).localeCompare(String(b.createdAt)));
        return { items, errors };
    }
}

module.exports = {
    CommentStore,
    VERSION,
    SIDECAR_SUFFIX,
    sidecarFor,
    freshRecord,
    validRecord,
    objectSnapshot,
    reconcileRecord,
    markdownFor,
};
