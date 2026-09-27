const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bibEntries, bblEntries, refItems, insertion } = require('../../tex/texPickers');

test('the .bib entries a picker lists', () => {
    const bib = `@comment{x}
@Article{knuth84,
  author = {Donald E. Knuth},
  title = {Literate {P}rogramming},
  year = 1984,
}
@book{lamport, author = "Leslie Lamport and Someone Else and Third Person", title = "LaTeX", year = "1994"}`;
    assert.deepEqual(bibEntries(bib), [
        { key: 'knuth84', type: 'article', year: '1984', title: 'Literate Programming', author: 'Knuth' },
        { key: 'lamport', type: 'book', year: '1994', title: 'LaTeX', author: 'Lamport et al.' },
    ]);
});

test('a shipped .bbl lists its items', () => {
    const bbl = '\\begin{thebibliography}{9}\n\\bibitem[Knuth(1984)]{knuth84}\nD.~E. Knuth, \\newblock {\\em Literate Programming}.\n\\bibitem{lamport} L. Lamport.\n\\end{thebibliography}';
    const items = bblEntries(bbl);
    assert.deepEqual(items.map(i => [i.key, i.label]), [['knuth84', 'Knuth(1984)'], ['lamport', '']]);
    assert.match(items[0].title, /Knuth.*Literate Programming/);
});

test('labels with their numbers and what they are on', () => {
    const labels = new Map([['eq:e', { printed: '3', page: 2 }], ['sec:i', { printed: '1', page: 1 }]]);
    const objects = [{ kind: 'display-equation', label: 'eq:e' }, { kind: 'section-heading', label: 'sec:i', title: 'Intro', cmd: 'section' },
        { kind: 'label', name: 'fresh' }];
    assert.deepEqual(refItems(labels, objects), [
        { key: 'eq:e', printed: '3', page: 2, kind: 'equation', title: '' },
        { key: 'sec:i', printed: '1', page: 1, kind: 'section', title: 'Intro' },
        { key: 'fresh', printed: '', page: null, kind: 'label', title: '' },
    ]);
});

test('inserting at the caret, idiomatically', () => {
    const at = (text, kind, key, o) => { const i = text.indexOf('|'); const t = text.replace('|', ''); const r = insertion(t, i, kind, key, o);
        const n = t.slice(0, r.start) + r.insert + t.slice(r.end); return n.slice(0, r.caret) + '|' + n.slice(r.caret); };
    assert.equal(at('as in Section |', 'ref', 'sec:i'), 'as in Section~\\ref{sec:i}|');
    assert.equal(at('number |', 'ref', 'sec:i'), 'number \\ref{sec:i}|', 'no tie after an ordinary word');
    assert.equal(at('\\usepackage{amsmath}\nby |', 'ref', 'eq:e', { equation: true }), '\\usepackage{amsmath}\nby \\eqref{eq:e}|');
    assert.equal(at('by |', 'ref', 'eq:e', { equation: true }), 'by (\\ref{eq:e})|');
    assert.equal(at('shown |', 'cite', 'knuth84'), 'shown~\\cite{knuth84}|');
    assert.equal(at('shown~\\cite{a}|', 'cite', 'b'), 'shown~\\cite{a,b}|', 'a citation joins the one before it');
});
