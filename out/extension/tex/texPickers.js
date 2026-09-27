// texPickers.js — inserting a citation or a cross-reference from the page.
//
// Typing on the page makes `\` a printed backslash, so a reference has to be
// inserted another way: a picker over what the paper can cite (its .bib, or
// the .bbl it ships) and what it can refer to (its labels, with the numbers
// the last build printed), and one idiomatic edit at the caret.
//
// Pure: no vscode, no I/O.

const { describeOwner } = require('./refIntel');

/** The entries of a .bib: `{ key, type, author, year, title }`. */
function bibEntries(text) {
    const out = [];
    const s = String(text || '');
    const re = /@(\w+)\s*\{\s*([^,\s{}]+)\s*,/g;
    let m;
    while ((m = re.exec(s))) {
        const type = m[1].toLowerCase();
        if (['comment', 'string', 'preamble'].includes(type)) continue;
        // The entry's body, brace-matched from its opening brace.
        const open = s.indexOf('{', m.index);
        let depth = 0, end = s.length;
        for (let i = open; i < s.length; i++) {
            if (s[i] === '{') depth++;
            else if (s[i] === '}' && --depth === 0) { end = i; break; }
        }
        const body = s.slice(re.lastIndex, end);
        re.lastIndex = end;
        const field = name => {
            const f = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*`, 'i').exec(body);
            if (!f) return '';
            let i = f.index + f[0].length, value = '';
            if (body[i] === '{') {
                let d = 0;
                for (; i < body.length; i++) {
                    if (body[i] === '{') { if (d++ === 0) continue; }
                    else if (body[i] === '}' && --d === 0) break;
                    value += body[i];
                }
            } else if (body[i] === '"') {
                const close = body.indexOf('"', i + 1);
                value = body.slice(i + 1, close < 0 ? body.length : close);
            } else value = /^[^,\n]*/.exec(body.slice(i))[0];
            return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
        };
        const authors = field('author').split(/\s+and\s+/i).filter(Boolean)
            .map(a => (a.includes(',') ? a.split(',')[0] : a.split(' ').pop()).trim());
        out.push({ key: m[2], type, year: field('year'), title: field('title'),
            author: authors.length > 2 ? `${authors[0]} et al.` : authors.join(' and ') });
    }
    return out;
}

/** The entries of a .bbl (a paper that ships only its bibliography): `{ key, label, title }`. */
function bblEntries(text) {
    const out = [];
    const s = String(text || '');
    const re = /\\bibitem\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g;
    const hits = [...s.matchAll(re)];
    hits.forEach((m, i) => {
        const end = i + 1 < hits.length ? hits[i + 1].index : s.indexOf('\\end{thebibliography}', m.index) >>> 0;
        const body = s.slice(m.index + m[0].length, end).replace(/\\newblock/g, ' ').replace(/\\[a-zA-Z]+\s*/g, ' ')
            .replace(/[{}~]/g, ' ').replace(/\s+/g, ' ').trim();
        out.push({ key: m[2].trim(), label: (m[1] || '').replace(/[{}]/g, '').trim(), title: body.slice(0, 160) });
    });
    return out;
}

/**
 * What the paper can refer to: its labels with the printed number and page
 * (`labels` from auxLabels.parseAux), named after what each is on (the
 * model's objects).
 */
function refItems(labels, objects = []) {
    const items = [];
    for (const [key, info] of labels || []) {
        const owner = objects.find(o => o.label === key && o.kind !== 'label') || null;
        items.push({ key, printed: info.printed || '', page: info.page ?? null,
            kind: describeOwner(owner), title: owner?.title || '' });
    }
    // Labels the build has not seen yet (just typed) are there too, unnumbered.
    for (const o of objects) {
        if (o.kind === 'label' && o.name && !items.some(i => i.key === o.name))
            items.push({ key: o.name, printed: '', page: null, kind: 'label', title: '' });
    }
    return items;
}

/** Words that name what follows them; the space after one becomes `~`. */
const NAMING = /(?:^|[\s(])(?:Section|Sections|Sec\.|Secs\.|Chapter|Appendix|Figure|Figures|Fig\.|Figs\.|Table|Tables|Tab\.|Equation|Equations|Eq\.|Eqs\.|Theorem|Lemma|Proposition|Corollary|Definition|Remark|Example|Ref\.|Refs\.|reference|references|see|in|and)\s$/;

/**
 * The edit that inserts `key` at `offset`: `{ start, end, insert, caret }`.
 * A citation right after a `\cite{…}` joins it; an equation is `\eqref` with
 * amsmath (or `(\ref{…})` without); a space after a word that names what
 * follows (or before a citation) becomes a tie.
 */
function insertion(text, offset, kind, key, { equation = false } = {}) {
    const before = text.slice(Math.max(0, offset - 40), offset);
    if (kind === 'cite') {
        const joined = /\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{[^}]*\}$/.exec(before);
        if (joined) return { start: offset - 1, end: offset - 1, insert: `,${key}`, caret: offset + key.length + 1 };
        const tie = before.endsWith(' ') && !before.endsWith('  ');
        const insert = `${tie ? '~' : ''}\\cite{${key}}`;
        return { start: tie ? offset - 1 : offset, end: offset, insert, caret: offset - (tie ? 1 : 0) + insert.length };
    }
    const amsmath = /\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:amsmath|mathtools)\b/.test(text);
    const command = equation ? (amsmath ? `\\eqref{${key}}` : `(\\ref{${key}})`) : `\\ref{${key}}`;
    const tie = NAMING.test(before);
    const insert = `${tie ? '~' : ''}${command}`;
    return { start: tie ? offset - 1 : offset, end: offset, insert, caret: offset - (tie ? 1 : 0) + insert.length };
}

module.exports = { bibEntries, bblEntries, refItems, insertion };
