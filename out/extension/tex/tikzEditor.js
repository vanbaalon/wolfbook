'use strict';
// THE PICTURE EDITOR'S OPERATIONS, AS EDITS.
//
// `plan(op, texts)` turns one gesture of the viewer's TikZ editor into the
// source edits that make it — per file, in that file's current offsets —
// plus what to select afterwards. It is pure: `texts` maps absolute file
// paths to their current text, and nothing is applied here, so every gesture
// can be tested without VS Code. The host applies the edits as one
// WorkspaceEdit (one undo step) and keeps their inverses for its own undo.
//
// Statements are named by `{start, text}` as the viewer last resolved them;
// the picture is re-parsed from the current text, and a statement whose text
// is no longer where it was is looked up by its text, or the gesture is
// refused — never applied to the wrong statement.
//
// Geometry comes in big points relative to the picture's origin (y up) and
// leaves in the picture's units: centimetres over its `scale=`.

const model = require('./tikzModel');
const palette = require('./tikzPalette');
const { withTransform } = require('./tikzEdit');

const BP_PER_CM = 72 / 2.54;

function fail(error) { return { edits: {}, select: null, error }; }

/** The statement a viewer reference names, in the freshly parsed picture. */
function findStmt(picture, ref) {
    if (!ref) return null;
    const exact = picture.statements.find(s => s.start === ref.start && s.text === ref.text);
    if (exact) return exact;
    const same = picture.statements.filter(s => s.text === ref.text);
    return same.length === 1 ? same[0] : null;
}

/** Offsets move under edits applied before them; `edits` are in pre-edit offsets. */
function shiftThrough(edits, offset) {
    let shift = 0;
    for (const e of edits) if (e.start < offset || (e.start === offset && e.end > e.start)) shift += e.text.length - (e.end - e.start);
    return offset + shift;
}

/**
 * The inverse of `edits` on `text`, in post-edit offsets: applying it to the
 * edited text restores `text`.
 */
function inverse(text, edits) {
    const sorted = [...edits].sort((a, b) => a.start - b.start);
    let delta = 0;
    return sorted.map(e => {
        const start = e.start + delta;
        delta += e.text.length - (e.end - e.start);
        return { start, end: start + e.text.length, text: text.slice(e.start, e.end) };
    });
}

/** Apply edits (pre-edit offsets) to text. */
function apply(text, edits) {
    return [...edits].sort((a, b) => b.start - a.start).reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), text);
}

/**
 * One gesture as edits. `op.picture = {file, begin}` names the picture;
 * `op.root` is the main file, whose preamble loads what new items need.
 * Returns `{edits: {[file]: [...]}, select, reveal, error}`.
 */
function plan(op, texts) {
    const edits = {};
    const add = (file, list) => { const xs = list.filter(Boolean); if (xs.length) (edits[file] ||= []).push(...xs); };
    const needs = n => { if (n && op.root && texts[op.root] != null) add(op.root, model.preambleEdits(texts[op.root], n)); };

    if (op.op === 'newPicture') {
        const template = palette.TEMPLATES.find(t => t.id === op.template);
        const text = texts[op.file];
        if (!template || text == null) return fail('unknown template');
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const block = template.lines.join(eol);
        add(op.file, [{ start: op.offset, end: op.offset, text: `${block}${eol}` }]);
        needs(template.needs);
        const select = { file: op.file, start: shiftThrough(edits[op.file].filter(e => e.start !== op.offset || e.text !== `${block}${eol}`), op.offset) };
        return { edits, select, error: null };
    }

    const file = op.picture?.file;
    const text = texts[file];
    if (text == null) return fail('the picture\'s file is not open');
    const picture = model.parsePicture(text, op.picture.begin);
    if (!picture) return fail('the picture changed — select it again');
    // Big points per picture unit, per axis (`x=`, `y=`, `scale`, `xscale`, `yscale`).
    const unitX = BP_PER_CM * picture.unitX, unitY = BP_PER_CM * picture.unitY;
    const toUnits = ([x, y]) => {
        let [u, v] = [x / unitX, y / unitY];
        if (op.snap !== false) [u, v] = [Math.round(u * 10) / 10, Math.round(v * 10) / 10];
        return [u, v];
    };
    const stmts = (op.refs || (op.ref ? [op.ref] : [])).map(r => findStmt(picture, r));
    if (stmts.some(s => !s)) return fail('the source changed — select it again');
    let select = null, reveal = null, selects = null, created = null;
    const selectInserted = (insert, first) => {
        const all = [...(edits[file] || [])];
        const shifted = shiftThrough(all.filter(e => e !== insert), insert.start);
        select = { file, start: shifted + insert.text.indexOf(first) };
    };

    switch (op.op) {
    case 'add': {
        const item = palette.byId.get(op.item);
        if (!item || item.kind === 'edge') return fail('unknown tool');
        const params = { text: op.text, momentum: op.momentum };
        if (item.kind === 'points') params.points = (op.points || []).map(toUnits);
        else { params.a = toUnits(op.points?.[0] || [0, 0]); if (op.points?.[1]) params.b = toUnits(op.points[1]); }
        if (item.names || item.prefix) params.name = model.freshName(picture, item.prefix || 'n');
        const lines = item.build(params);
        if (!lines) return fail('nothing to add');
        const [insert] = model.insertEdits(text, picture, lines, { feynman: item.feynman });
        add(file, [insert]);
        needs(item.needs);
        selectInserted(insert, lines[0]);
        break;
    }
    case 'chain': {
        // A root of a diagram and the bond from the previous one, in one step
        // (the super Dynkin chain tool).
        const root = palette.byId.get(op.item), bond = palette.byId.get(op.bond || 'dynkin-single');
        if (!root || root.kind !== 'point' || !bond || bond.kind !== 'edge') return fail('unknown chain item');
        const name = model.freshName(picture, root.prefix || 'r');
        const lines = [...root.build({ a: toUnits(op.points?.[0] || [0, 0]), name })];
        if (op.fromName && model.names(picture).has(op.fromName)) lines.push(...bond.build({ from: op.fromName, to: name }));
        const [insert] = model.insertEdits(text, picture, lines);
        add(file, [insert]);
        needs(root.needs);
        selectInserted(insert, lines[0]);
        created = name;
        break;
    }
    case 'edge': {
        const item = palette.byId.get(op.item);
        if (!item || item.kind !== 'edge') return fail('unknown edge');
        const [from, to] = stmts;
        if (!from || !to || from === to) return fail('an edge needs two different nodes');
        if (![from, to].every(s => ['node', 'coordinate', 'vertex'].includes(s.kind))) return fail('edges join nodes');
        const taken = new Set();
        const nameOf = s => {
            if (s.name) return s.name.value;
            const fresh = model.freshName(picture, 'n', taken);
            taken.add(fresh);
            add(file, [model.nameEdit(s, fresh)]);
            return fresh;
        };
        const lines = item.build({ from: nameOf(from), to: nameOf(to), momentum: op.momentum });
        const [insert] = model.insertEdits(text, picture, lines, { feynman: item.feynman, after: Math.max(from.end, to.end) });
        add(file, [insert]);
        needs(item.needs);
        selectInserted(insert, lines[0]);
        break;
    }
    case 'move': {
        for (const [k, s] of stmts.entries()) {
            const d = op.deltas?.[k] || [op.dx || 0, op.dy || 0];
            add(file, [model.moveEdit(s, d[0] / unitX, d[1] / unitY)]);
        }
        select = { file, start: shiftThrough(edits[file] || [], stmts[0].start) };
        selects = stmts.map(st => shiftThrough(edits[file] || [], st.start));
        break;
    }
    case 'transform': {
        const [s] = stmts;
        const c = [op.cx / unitX, op.cy / unitY];
        const t = op.kind === 'rotate' ? { kind: 'rotate', degrees: op.degrees, cx: c[0], cy: c[1] }
            : { kind: 'scale', factor: op.factor, cx: c[0], cy: c[1] };
        const next = withTransform(s.text, t);
        if (!next) return fail('this statement cannot be transformed');
        add(file, [{ start: s.start, end: s.end, text: next }]);
        select = { file, start: s.start };
        break;
    }
    case 'delete': {
        const doomed = new Map(stmts.map(s => [s.start, s]));
        if (op.dependents !== false) for (const s of stmts) if (s.name) for (const d of model.dependents(picture, s.name.value)) doomed.set(d.start, d);
        const ranges = [...doomed.values()].map(s => model.deleteEdit(text, s)).sort((a, b) => a.start - b.start);
        const merged = [];
        for (const r of ranges) { const last = merged.at(-1); if (last && r.start < last.end) last.end = Math.max(last.end, r.end); else merged.push({ ...r }); }
        add(file, merged);
        break;
    }
    case 'copy': {
        // The selected statements' source, for the clipboard.
        return { edits: {}, select: null, selects: [], clipboard: stmts.map(st => st.text.replace(/\r?\n\s*/g, ' ')).join('\n'), error: null };
    }
    case 'paste': {
        // Statements from the clipboard, renamed so they do not clash; an edge
        // whose nodes would not exist here is left out.
        const source = String(op.text || '');
        const temp = model.parsePicture(`\\begin{tikzpicture}\n${source}\n\\end{tikzpicture}`, 0);
        if (!temp || !temp.statements.length) return fail('the clipboard holds no TikZ statements');
        const known = new Set([...model.names(picture), ...temp.statements.map(st => st.name?.value).filter(Boolean)]);
        const kept = temp.statements.filter(st => st.refs.every(n => known.has(n)));
        if (!kept.length) return fail('nothing on the clipboard can go in this picture');
        const lines = model.duplicateLines(picture, kept, (op.dx || 0) / unitX, (op.dy || 0) / unitY);
        const feynman = kept.some(st => st.kind === 'vertex' || st.kind === 'diagram');
        const [insert] = model.insertEdits(text, picture, lines, { feynman });
        add(file, [insert]);
        if (feynman) needs({ feynman: true });
        selectInserted(insert, lines[0]);
        selects = lines.map(l => select.start + insert.text.indexOf(l) - insert.text.indexOf(lines[0]));
        break;
    }
    case 'duplicate': {
        const lines = model.duplicateLines(picture, stmts, (op.dx || 0) / unitX, (op.dy || 0) / unitY);
        const [insert] = model.insertEdits(text, picture, lines, { feynman: stmts.some(s => s.kind === 'vertex' || s.kind === 'diagram') });
        add(file, [insert]);
        selectInserted(insert, lines[0]);
        selects = lines.map(l => select.start + insert.text.indexOf(l) - insert.text.indexOf(lines[0]));
        break;
    }
    case 'style': {
        let value = op.value;
        if (op.group === 'color' || op.group === 'fill') { const c = palette.colorValue(value); value = c.value; needs(c.needs); }
        const o = palette.styleOption(op.group, value);
        if (!o) return fail('unknown style');
        for (const s of stmts) add(file, [model.setOptionEdit(s, o.key, o.value, o.replaces)]);
        if (op.group === 'arrows' && op.value.includes('Stealth')) needs({ libraries: ['arrows.meta'] });
        select = { file, start: shiftThrough(edits[file] || [], stmts[0]?.start) };
        selects = stmts.map(st => shiftThrough(edits[file] || [], st.start));
        break;
    }
    case 'option': {
        for (const s of stmts) add(file, [model.setOptionEdit(s, op.key, op.value ?? null)]);
        select = { file, start: shiftThrough(edits[file] || [], stmts[0]?.start) };
        selects = stmts.map(st => shiftThrough(edits[file] || [], st.start));
        break;
    }
    case 'label': {
        const [s] = stmts;
        if (!s.label) return fail('this statement has no text');
        add(file, [{ start: s.label.start, end: s.label.end, text: String(op.text ?? '') }]);
        select = { file, start: s.start };
        break;
    }
    case 'place': {
        const [s] = stmts;
        const e = model.placeEdit(s, op.x, op.y);
        if (!e) return fail('this statement has no coordinates to set');
        add(file, [e]);
        select = { file, start: s.start };
        break;
    }
    case 'insert': {
        const lines = String(op.text || '').split('\n');
        const [insert] = model.insertEdits(text, picture, lines);
        add(file, [insert]);
        needs(palette.catalogueNeeds(op.text || ''));
        const all = edits[file];
        const base = shiftThrough(all.filter(e => e !== insert), insert.start);
        const bullet = insert.text.indexOf('•');
        if (bullet >= 0) reveal = { file, start: base + bullet, end: base + bullet + 1 };
        else selectInserted(insert, lines[0]);
        break;
    }
    case 'reorder': {
        const [s] = stmts;
        const k = picture.statements.indexOf(s);
        const other = picture.statements[k + (op.dir < 0 ? -1 : 1)];
        if (!other) return fail(op.dir < 0 ? 'already first' : 'already last');
        add(file, [{ start: s.start, end: s.end, text: other.text }, { start: other.start, end: other.end, text: s.text }]);
        select = { file, start: op.dir < 0 ? other.start : s.start + (other.text.length - s.text.length) + (other.start - s.start) };
        break;
    }
    default:
        return fail(`unknown operation ${op.op}`);
    }
    // Edits in one file must not overlap (a gesture that would needs splitting).
    for (const list of Object.values(edits)) {
        const sorted = [...list].sort((a, b) => a.start - b.start);
        for (let k = 1; k < sorted.length; k++) if (sorted[k].start < sorted[k - 1].end) return fail('overlapping edits');
    }
    return { edits, select, selects: selects || (select ? [select.start] : []), reveal, created, error: null };
}

module.exports = { plan, inverse, apply, findStmt, BP_PER_CM };
