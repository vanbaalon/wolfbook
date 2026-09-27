const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspireQuery, searchUrl, parseSearch, cleanBibitem } = require('../../tex/inspire');

test('what is typed becomes an INSPIRE query', () => {
    assert.equal(inspireQuery('1305.1939'), 'arxiv:1305.1939');
    assert.equal(inspireQuery('arXiv:1305.1939v2'), 'arxiv:1305.1939');
    assert.equal(inspireQuery('hep-th/9711200'), 'arxiv:hep-th/9711200');
    assert.equal(inspireQuery('Gromov:2013pga'), 'texkey:Gromov:2013pga');
    assert.equal(inspireQuery('  quantum spectral curve '), 'quantum spectral curve');
    assert.match(searchUrl('a b'), /^https:\/\/inspirehep\.net\/api\/literature\?size=15&fields=[^&]+&q=a%20b$/);
});

test('search answers become picker rows', () => {
    const answer = { hits: { hits: [
        { id: '1233812', metadata: { control_number: 1233812, texkeys: ['Gromov:2013pga'], titles: [{ title: 'Quantum Spectral Curve for\n Planar N=4' }],
            first_author: { full_name: 'Gromov, Nikolay' }, author_count: 4, earliest_date: '2013-05-09', arxiv_eprints: [{ value: '1305.1939' }] } },
        { metadata: { control_number: 5, titles: [{ title: 'No texkey' }] } },
        { metadata: { control_number: 7, texkeys: ['Solo:2020abc'], titles: [{ title: 'Alone' }], first_author: { full_name: 'Solo, Han' }, author_count: 1, earliest_date: '2020' } },
    ] } };
    assert.deepEqual(parseSearch(answer), [
        { key: 'Gromov:2013pga', recid: 1233812, source: 'inspire', title: 'Quantum Spectral Curve for Planar N=4', author: 'Gromov et al.', year: '2013', eprint: '1305.1939' },
        { key: 'Solo:2020abc', recid: 7, source: 'inspire', title: 'Alone', author: 'Solo', year: '2020', eprint: '' },
    ]);
});

test('an INSPIRE latex-eu entry is a clean \\bibitem', () => {
    const text = '%\\cite{Gromov:2013pga}\n\\bibitem{Gromov:2013pga}\nN.~Gromov, et al.\n%``Title,\'\'\nPhys. Rev. Lett. \\textbf{112} (2014)\n%376 citations counted in INSPIRE as of 18 Sep 2026\n';
    assert.equal(cleanBibitem(text), '\\bibitem{Gromov:2013pga}\nN.~Gromov, et al.\nPhys. Rev. Lett. \\textbf{112} (2014)');
});
