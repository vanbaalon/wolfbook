// FIND IN THE PAPER: the text model behind the viewer's find bar.
//
// A page's text comes as runs — pdf.js text items for a PDF page, the live
// display list's glyph runs for a page the live engine drew — each with a box
// in page units (y down): `{str, x, y, w, h}`, in reading order. The runs are
// joined into one searchable string: a space where two runs are apart or on
// different lines, nothing where a word was hyphenated at a line end. Every
// character of that string remembers which run and which characters of it it
// came from, so a match maps back to boxes to highlight.
//
// Matching ignores case and accents and folds what TeX prints for what people
// type: math italic 𝑥 is x (NFKC), the ﬁ ligature is fi, − is -, curly quotes
// are straight. PURE: importable from Node for tests.

const SAME = {
    '−': '-', '‐': '-', '‑': '-', '–': '-', '—': '-',
    '‘': "'", '’': "'", '“': '"', '”': '"', '′': "'",
    '⋅': '·', '∙': '·', 'ı': 'i', 'ȷ': 'j',
};

/** What one character of printed text is searched as ('' drops it). */
export function foldChar(ch) {
    if (/\s/.test(ch)) return ' ';
    if (SAME[ch]) return SAME[ch];
    return ch.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** A query as the page text is searched: folded, spaces collapsed, trimmed. */
export function foldQuery(query) {
    let out = '';
    for (const ch of String(query || '')) out += foldChar(ch);
    return out.replace(/ +/g, ' ').trim();
}

const centre = r => r.y + r.h / 2;

/** Whether run `b` starts a new line after run `a`. */
function newLine(a, b) {
    return Math.abs(centre(b) - centre(a)) > 0.5 * Math.max(a.h, b.h, 1e-9);
}

/**
 * The page's searchable text. Returns `{text, at}`: `at[i]` is `[run, from,
 * to]` (UTF-16 offsets into that run's `str`) for each character of `text`,
 * or `null` for a space put between runs.
 */
export function pageText(items) {
    let text = '';
    const at = [];
    const push = (s, where) => {
        for (const c of s) {
            if (c === ' ' && (text === '' || text.endsWith(' '))) continue;
            text += c;
            at.push(where);
        }
    };
    let prev = null;
    items.forEach((it, i) => {
        const str = String(it.str || '');
        if (!str) return;
        if (prev) {
            const broken = newLine(prev.item, it);
            // A word hyphenated at a line end: drop the hyphen, join the halves.
            if (broken && prev.hyphen >= 0 && /^\p{Ll}/u.test(str)) {
                text = text.slice(0, prev.hyphen);
                at.length = prev.hyphen;
            } else if (broken || it.x - (prev.item.x + prev.item.w) > 0.15 * Math.max(it.h, 1e-9)) {
                push(' ', null);
            }
        }
        let offset = 0, hyphen = -1;
        for (const ch of str) {
            const folded = foldChar(ch);
            const start = text.length;
            push(folded, [i, offset, offset + ch.length]);
            hyphen = folded === '-' && text.length > start ? start : (folded.trim() ? -1 : hyphen);
            offset += ch.length;
        }
        // Only a hyphen right after a letter can be a line-end break.
        if (hyphen > 0 && !/\p{L}/u.test(text[hyphen - 1])) hyphen = -1;
        prev = { item: it, hyphen };
    });
    return { text, at };
}

/** Start and end offsets of each non-overlapping match of `query` in `text`. */
export function findAll(text, query) {
    const q = foldQuery(query);
    const out = [];
    if (!q) return out;
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) out.push([i, i + q.length]);
    return out;
}

/** The runs a match `[start, end)` covers: `[{run, from, to}]`, in order. */
export function matchSpans(model, start, end) {
    const spans = [];
    for (let i = start; i < end; i++) {
        const where = model.at[i];
        if (!where) continue;
        const [run, from, to] = where;
        const last = spans[spans.length - 1];
        if (last && last.run === run && from <= last.to) last.to = Math.max(last.to, to);
        else spans.push({ run, from, to });
    }
    return spans;
}

/**
 * Boxes to highlight, using measured character ink when available. Uniform
 * subdivision is only the fallback for a run without character geometry.
 */
export function spanRects(items, spans) {
    const out = [];
    for (const { run, from, to } of spans) {
        const it = items[run];
        const n = Math.max(1, String(it.str || '').length);
        let offset=0;
        const chars=Array.from(String(it.str || ''));
        const boxes=(it.charBoxes || []).filter((box,i)=>{
            const start=box.from ?? offset,end=box.to ?? start+(chars[i]?.length || 1);offset=end;
            return end>from && start<to && box.w>0 && (box.h ?? it.h)>0;
        });
        const r=boxes.length ? (()=>{
            const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y ?? it.y));
            return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,
                h:Math.max(...boxes.map(b=>(b.y ?? it.y)+(b.h ?? it.h)))-y};
        })() : { x: it.x + it.w * (from / n), y: it.y, w: it.w * ((to - from) / n), h: it.h };
        const last = out[out.length - 1];
        if (last && Math.abs(last.y - r.y) < 0.2 * r.h && Math.abs(last.h - r.h) < 0.2 * r.h
            && r.x - (last.x + last.w) < 0.3 * r.h && r.x + r.w > last.x) {
            const right = Math.max(last.x + last.w, r.x + r.w);
            const bottom=Math.max(last.y+last.h,r.y+r.h);
            last.x=Math.min(last.x,r.x);last.y = Math.min(last.y, r.y);
            last.h = bottom-last.y;
            last.w = right - last.x;
        } else out.push(r);
    }
    return out;
}
