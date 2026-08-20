// texModel.js — scanner output -> addressable objects with STABLE IDENTITY.
//
// Pure: no vscode, no fs, never throws.
//
// The scanner (texScanner.js) answers "what is in this file right now". This
// module answers the harder question an agent actually needs: "is this the
// same equation I was looking at two edits ago?" Everything downstream depends
// on that answer holding — a hash-guarded edit is worthless if the object it
// guards was silently renumbered.
//
// Identity rules are documented in IDENTITY.md and implemented in reconcile().

const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sha8 = (s) => sha256(s).slice(0, 8);

/** Whitespace- and comment-insensitive form, for similarity and stable keys. */
function normalizeSource(text) {
    return String(text)
        .replace(/(^|[^\\])%[^\n]*/g, '$1')   // comments, but not \%
        .replace(/\s+/g, ' ')
        .trim();
}

function slugify(s, max = 32) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max) || 'untitled';
}

/**
 * A human-readable, content-addressed key that survives reformatting.
 *
 * `<sectionSlug>/<kind>/<label ?? hash8(normalizedSource)>/<ordinal>`
 *
 * A labelled object keys on its label, which is the strongest identity a TeX
 * document offers — it is what the author already chose to name it. Unlabelled
 * objects fall back to a hash of their normalised source, so retyping the same
 * equation elsewhere collides deliberately (the ordinal separates them).
 */
function stableKeyFor(obj, sectionPath, ordinal) {
    const section = slugify((sectionPath && sectionPath[sectionPath.length - 1]) || 'root');
    const ident = obj.label ? `L:${obj.label}` : sha8(normalizeSource(obj.text || ''));
    return `${section}/${obj.kind}/${ident}/${ordinal}`;
}

/** Dice coefficient over character bigrams — cheap, no deps, good enough. */
function similarity(a, b) {
    const A = normalizeSource(a); const B = normalizeSource(b);
    if (!A.length && !B.length) return 1;
    if (A.length < 2 || B.length < 2) return A === B ? 1 : 0;
    const grams = (s) => {
        const m = new Map();
        for (let i = 0; i < s.length - 1; i++) {
            const g = s.slice(i, i + 2);
            m.set(g, (m.get(g) || 0) + 1);
        }
        return m;
    };
    const ga = grams(A); const gb = grams(B);
    let shared = 0;
    for (const [g, n] of ga) shared += Math.min(n, gb.get(g) || 0);
    return (2 * shared) / ((A.length - 1) + (B.length - 1));
}

let _seq = 0;
const newObjectId = () => `obj_${(++_seq).toString(36)}_${Date.now().toString(36)}`;

/**
 * Build the model for ONE file.
 * @returns {{file, objects: object[], byId: Map, byKey: Map, byLabel: Map, warnings: string[]}}
 */
function buildModel(scan, opts = {}) {
    const file = opts.file || scan.file || '<string>';
    const ordinals = new Map();
    const objects = [];

    for (const o of scan.objects) {
        const sectionPath = o.sectionPath || [];
        const base = stableKeyFor(o, sectionPath, 0).replace(/\/0$/, '');
        const n = ordinals.get(base) || 0;
        ordinals.set(base, n + 1);

        objects.push({
            objectId: newObjectId(),
            stableKey: `${base}/${n}`,
            kind: o.kind,
            envName: o.envName,
            label: o.label,
            cmd: o.cmd,
            target: o.target,
            name: o.name,
            level: o.level,
            title: o.title,
            sectionPath,
            sourceRange: {
                file,
                startLine: o.startLine,
                endLine: o.endLine,
                startOffset: o.startOffset,
                endOffset: o.endOffset,
            },
            sourceHash: sha256(o.text || ''),
            normalizedHash: sha8(normalizeSource(o.text || '')),
            text: o.text,
            opaque: !!o.opaque,
            confidence: o.opaque ? 'opaque' : 'parsed',
        });
    }

    const byId = new Map(objects.map(o => [o.objectId, o]));
    const byKey = new Map();
    for (const o of objects) {
        if (!byKey.has(o.stableKey)) byKey.set(o.stableKey, o);
    }
    const byLabel = new Map();
    for (const o of objects) {
        if (o.kind === 'label' && o.name) byLabel.set(o.name, o);
        else if (o.label && !byLabel.has(o.label)) byLabel.set(o.label, o);
    }

    return { file, objects, byId, byKey, byLabel, warnings: scan.warnings || [] };
}

/**
 * Carry identity across a re-scan. See IDENTITY.md for the rules; the order
 * below IS the precedence, and each rule is tried to exhaustion before the
 * next, because a weaker rule must never steal a match a stronger one wants.
 *
 * @returns {{objects, matched, added, removed, split, merged}} — `objects` is
 *   the NEW model's objects with objectIds carried over where identity held.
 */
function reconcile(prev, next, opts = {}) {
    const SIM_THRESHOLD = opts.similarityThreshold ?? 0.6;
    const oldObjs = prev ? [...prev.objects] : [];
    const taken = new Set();
    const usedOld = new Set();
    const matched = []; const added = []; const removed = [];
    const split = []; const merged = [];

    const claim = (n, o, rule) => {
        n.objectId = o.objectId;
        n.previousStableKey = o.stableKey !== n.stableKey ? o.stableKey : undefined;
        n.identityRule = rule;
        taken.add(n); usedOld.add(o);
        matched.push({ objectId: o.objectId, rule, from: o.stableKey, to: n.stableKey });
    };

    // Rule 1 — same stableKey AND overlapping range. The common case.
    const prevByKey = new Map();
    for (const o of oldObjs) {
        if (!prevByKey.has(o.stableKey)) prevByKey.set(o.stableKey, []);
        prevByKey.get(o.stableKey).push(o);
    }
    for (const n of next.objects) {
        if (taken.has(n)) continue;
        const cands = (prevByKey.get(n.stableKey) || []).filter(o => !usedOld.has(o));
        const hit = cands.find(o => rangesOverlap(o.sourceRange, n.sourceRange)) || cands[0];
        if (hit) claim(n, hit, 'stableKey');
    }

    // Rule 2 — same \label, even across files or a move. A label is the
    // author's own name for the object; nothing outranks it but an exact key.
    const prevByLabel = new Map();
    for (const o of oldObjs) {
        const key = o.kind === 'label' ? o.name : o.label;
        if (key && !prevByLabel.has(key)) prevByLabel.set(key, o);
    }
    for (const n of next.objects) {
        if (taken.has(n)) continue;
        const key = n.kind === 'label' ? n.name : n.label;
        if (!key) continue;
        const o = prevByLabel.get(key);
        if (o && !usedOld.has(o) && o.kind === n.kind) claim(n, o, 'label');
    }

    // Rule 3 — identical content and kind, moved by a pure line delta. This is
    // what makes "someone inserted a paragraph above me" a non-event.
    const prevByHash = new Map();
    for (const o of oldObjs) {
        const k = `${o.kind}|${o.sourceHash}`;
        if (!prevByHash.has(k)) prevByHash.set(k, []);
        prevByHash.get(k).push(o);
    }
    for (const n of next.objects) {
        if (taken.has(n)) continue;
        const cands = (prevByHash.get(`${n.kind}|${n.sourceHash}`) || []).filter(o => !usedOld.has(o));
        if (cands.length) claim(n, cands[0], 'contentHash');
    }

    // Rule 4 — similar enough, same kind, same section. Typing inside an
    // object must not change what it is.
    for (const n of next.objects) {
        if (taken.has(n)) continue;
        let best = null; let bestScore = 0;
        for (const o of oldObjs) {
            if (usedOld.has(o) || o.kind !== n.kind) continue;
            if (sectionKey(o.sectionPath) !== sectionKey(n.sectionPath)) continue;
            const score = similarity(o.text || '', n.text || '');
            if (score > bestScore) { bestScore = score; best = o; }
        }
        if (best && bestScore >= SIM_THRESHOLD) {
            claim(n, best, `similarity:${bestScore.toFixed(2)}`);
        }
    }

    // Whatever is left is genuinely new or genuinely gone. Say so explicitly
    // rather than renumbering silently — a caller that cannot see a split
    // cannot warn about one.
    for (const n of next.objects) {
        if (!taken.has(n)) { n.identityRule = 'new'; added.push(n.stableKey); }
    }
    for (const o of oldObjs) {
        if (!usedOld.has(o)) removed.push(o.stableKey);
    }

    // A split shows up as one old object matched by one new one while another
    // new object of the same kind appeared inside the old one's former range.
    for (const n of next.objects) {
        if (n.identityRule !== 'new') continue;
        const host = oldObjs.find(o => usedOld.has(o) && o.kind === n.kind &&
            rangesOverlap(o.sourceRange, n.sourceRange));
        if (host) split.push({ from: host.stableKey, to: n.stableKey });
    }
    // A merge shows up as two old objects whose ranges both fall inside one new.
    for (const n of next.objects) {
        const inside = oldObjs.filter(o => rangesContain(n.sourceRange, o.sourceRange) && o.kind === n.kind);
        if (inside.length > 1) merged.push({ from: inside.map(o => o.stableKey), to: n.stableKey });
    }

    return { objects: next.objects, matched, added, removed, split, merged };
}

const sectionKey = (p) => (p || []).join(' › ');

function rangesOverlap(a, b) {
    if (!a || !b) return false;
    if (a.file && b.file && a.file !== b.file) return false;
    return a.startOffset < b.endOffset && b.startOffset < a.endOffset;
}
function rangesContain(outer, inner) {
    if (!outer || !inner) return false;
    if (outer.file && inner.file && outer.file !== inner.file) return false;
    return inner.startOffset >= outer.startOffset && inner.endOffset <= outer.endOffset;
}

/** Objects addressable by an agent — the rest are spans, refs and bookkeeping. */
const ADDRESSABLE = new Set([
    'display-equation', 'figure', 'table', 'tabular', 'theorem',
    'paragraph', 'section-heading', 'list', 'verbatim', 'abstract', 'environment',
]);

/** A compact projection for tool output — never the full text unless asked. */
function summariseObject(o, { includeText = false, maxText = 2000 } = {}) {
    const out = {
        objectId: o.objectId,
        stableKey: o.stableKey,
        kind: o.kind,
        envName: o.envName,
        label: o.label ?? (o.kind === 'label' ? o.name : undefined),
        sectionPath: o.sectionPath,
        file: o.sourceRange.file,
        startLine: o.sourceRange.startLine,
        endLine: o.sourceRange.endLine,
        sourceHash: o.sourceHash,
        confidence: o.confidence,
    };
    if (o.title) out.title = o.title;
    if (o.target) out.target = o.target;
    if (includeText) {
        out.text = (o.text || '').length > maxText
            ? (o.text || '').slice(0, maxText) + `\n… (${(o.text || '').length - maxText} more chars)`
            : o.text;
    }
    return out;
}

/**
 * The LINE SPAN each sectioning command governs: from its own line down to the
 * line before the next heading at the same or a shallower level.
 *
 * A `section-heading` object's own range covers only the `\section{...}`
 * command, which is correct (that IS the object) but useless for folding or for
 * asking "how much of the paper is section 3". This derives the span instead of
 * widening the object, so the two questions stay separate.
 *
 * @param {object[]} objects  model objects, in document order
 * @param {number} totalLines 1-based line count of the file
 * @param {number} [bodyEndLine] line of \end{document}, if known — the last
 *        section ends there rather than swallowing the trailing matter.
 * @returns {{objectId, stableKey, title, level, startLine, endLine}[]}
 */
function sectionSpans(objects, totalLines, bodyEndLine) {
    const heads = objects
        .filter(o => o.kind === 'section-heading')
        .sort((a, b) => a.sourceRange.startLine - b.sourceRange.startLine);
    const last = Math.max(1, Math.min(bodyEndLine || totalLines, totalLines));

    return heads.map((h, i) => {
        const level = h.level ?? 0;
        let end = last;
        for (let j = i + 1; j < heads.length; j++) {
            if ((heads[j].level ?? 0) <= level) { end = heads[j].sourceRange.startLine - 1; break; }
            end = last;
        }
        // A heading immediately followed by a deeper one still governs
        // everything under it, so only clamp against running backwards.
        if (end < h.sourceRange.startLine) end = h.sourceRange.startLine;
        return {
            objectId: h.objectId,
            stableKey: h.stableKey,
            title: h.title || '(untitled)',
            level,
            startLine: h.sourceRange.startLine,
            endLine: end,
        };
    });
}

/** Outline tree from section-heading objects. */
function buildOutline(objects) {
    const roots = [];
    const stack = [];
    for (const o of objects) {
        if (o.kind !== 'section-heading') continue;
        const node = {
            objectId: o.objectId, stableKey: o.stableKey,
            title: o.title || '(untitled)', level: o.level ?? 0,
            file: o.sourceRange.file, startLine: o.sourceRange.startLine,
            children: [],
        };
        while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
        if (stack.length) stack[stack.length - 1].children.push(node);
        else roots.push(node);
        stack.push(node);
    }
    return roots;
}

module.exports = {
    buildModel,
    reconcile,
    buildOutline,
    sectionSpans,
    summariseObject,
    stableKeyFor,
    normalizeSource,
    similarity,
    sha256,
    sha8,
    ADDRESSABLE,
};
