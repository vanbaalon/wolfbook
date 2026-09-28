const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const A = require('../../tex/arxivPack');

test('comments go; escaped percent signs, \\verb and verbatim stay', () => {
    const src = [
        '% a whole-line comment',
        'Text with 50\\% growth % and a remark',
        '   % indented comment',
        'A line break \\\\% then a comment',
        'Code \\verb|a%b| stays % gone',
        'Glued}%',
        '\\begin{verbatim}',
        '% kept inside verbatim',
        '\\end{verbatim}',
        'End.',
    ].join('\n');
    const r = A.stripComments(src);
    assert.equal(r.text, [
        'Text with 50\\% growth%',
        'A line break \\\\%',
        'Code \\verb|a%b| stays%',
        'Glued}%',
        '\\begin{verbatim}',
        '% kept inside verbatim',
        '\\end{verbatim}',
        'End.',
    ].join('\n'));
    assert.equal(r.lines, 6);
});

test('comment environments and \\iffalse blocks go; an \\iffalse with \\else stays', () => {
    const src = [
        'Before.',
        '\\begin{comment}',
        'hidden draft',
        '\\end{comment}',
        '\\iffalse',
        'an old paragraph',
        '\\ifx\\a\\b nested \\fi',
        '\\fi',
        '\\iffalse',
        'dead',
        '\\else',
        'live',
        '\\fi',
        'After.',
    ].join('\n');
    const r = A.stripComments(src);
    assert.equal(r.text, 'Before.\n\\iffalse\ndead\n\\else\nlive\n\\fi\nAfter.');
    assert.equal(r.blocks, 2);
});

test('draft mode: class option, draft-only packages and their commands, final options', () => {
    const src = [
        '\\documentclass[11pt,draft]{article}',
        '\\usepackage{amsmath,showkeys}',
        '\\usepackage[right]{lineno}',
        '\\usepackage[draft]{graphicx}',
        '\\usepackage[colorinlistoftodos]{todonotes}',
        '\\usepackage{fixme}',
        '\\usepackage{draftwatermark}',
        '\\SetWatermarkText{DRAFT}',
        '\\begin{document}',
        '\\linenumbers',
        '\\modulolinenumbers[5]',
        'Body.',
        '\\end{document}',
    ].join('\n');
    const r = A.stripDraft(src);
    assert.equal(r.text, [
        '\\documentclass[11pt]{article}',
        '\\usepackage{amsmath}',
        '',
        '\\usepackage{graphicx}',
        '\\usepackage[colorinlistoftodos,disable]{todonotes}',
        '\\usepackage[final]{fixme}',
        '',
        '',
        '\\begin{document}',
        '',
        '',
        'Body.',
        '\\end{document}',
    ].join('\n').replace(/\n[ \t]*\n(?=[ \t]*\n)/g, '\n'));
    assert.ok(r.changes.some(c => /showkeys/.test(c)));
    assert.ok(r.changes.some(c => /lineno/.test(c)));
    assert.ok(r.changes.some(c => /todonotes set to disable/.test(c)));
});

test('a referee layout is reported, not silently changed', () => {
    const r = A.stripDraft('\\documentclass[referee]{revtex4-2}\n');
    assert.equal(r.text, '\\documentclass[referee]{revtex4-2}\n');
    assert.match(r.warnings[0], /referee/);
});

function project(files) {
    return {
        read: (rel) => (rel in files && typeof files[rel] === 'string' ? files[rel] : null),
        readBinary: (rel) => (rel in files ? Buffer.from(files[rel]) : null),
        exists: (rel) => rel in files,
    };
}

test('only what the paper uses, a .bbl named after it, and 00README.json', () => {
    const files = {
        'paper.tex': [
            '\\documentclass{article}',
            '\\usepackage{graphicx,mymacros}',
            '\\graphicspath{{figs/}}',
            '\\begin{document}',
            '\\input{sections/intro}',
            '\\includegraphics[width=3cm]{plot}',
            '\\includegraphics{missing}',
            '\\bibliographystyle{plain}',
            '\\bibliography{refs}',
            '\\end{document}',
        ].join('\n'),
        'sections/intro.tex': 'Intro % note\n\\includegraphics{figs/photo.jpg}\n',
        'figs/plot.pdf': '%PDF',
        'figs/plot.png': 'PNG',
        'figs/photo.jpg': 'JPG',
        'figs/unused.png': 'PNG',
        'mymacros.sty': '\\def\\x{y}',
        'refs.bib': '@article{a,}',
        'notes.tex': 'unused',
    };
    const { files: out, report } = A.prepareArxiv({
        main: 'paper.tex', ...project(files), engine: 'pdflatex', texliveYear: 2025,
        built: { bbl: '\\begin{thebibliography}{1}\\end{thebibliography}' },
    });
    const names = out.map(f => f.name).sort();
    assert.deepEqual(names, ['00README.json', 'figs/photo.jpg', 'figs/plot.pdf', 'mymacros.sty',
        'paper.bbl', 'paper.tex', 'sections/intro.tex']);
    assert.deepEqual(report.missing, ['missing']);
    assert.equal(out.find(f => f.name === 'sections/intro.tex').data.toString(), 'Intro%\n\\includegraphics{figs/photo.jpg}\n');
    assert.deepEqual(JSON.parse(out.find(f => f.name === '00README.json').data), {
        spec_version: 1, process: { compiler: 'pdflatex' },
        sources: [{ filename: 'paper.tex', usage: 'toplevel' }], texlive_version: 2025,
    });
});

test('no .bbl is an error; LuaLaTeX is an error; EPS under pdflatex is a warning', () => {
    const files = {
        'm.tex': '\\documentclass{article}\\begin{document}\\includegraphics{f.eps}\\bibliography{r}\\end{document}',
        'f.eps': 'EPS',
    };
    const a = A.prepareArxiv({ main: 'm.tex', ...project(files), engine: 'pdflatex' });
    assert.ok(a.report.errors.some(e => /no \.bbl/.test(e)));
    assert.ok(a.report.warnings.some(w => /convert it to PDF/.test(w)));
    const b = A.prepareArxiv({ main: 'm.tex', ...project(files), engine: 'lualatex', built: { bbl: 'x' } });
    assert.ok(b.report.errors.some(e => /LuaLaTeX/.test(e)));
});

test('the zip is a valid archive', () => {
    const buf = A.zip([{ name: 'a.tex', data: 'hello '.repeat(100) }, { name: 'd/b.bin', data: Buffer.from([1, 2, 3]) }]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-zip-'));
    const file = path.join(dir, 'x.zip');
    fs.writeFileSync(file, buf);
    const r = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    if (r.error) return;                          // no unzip on this machine
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No errors detected/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('text after \\end{document} is not published or scanned', () => {
    const files = { 'm.tex': '\\documentclass{article}\n\\begin{document}\nA.\n\\end{document}\nold notes\n\\includegraphics{gone}\n' };
    const { files: out, report } = A.prepareArxiv({ main: 'm.tex', ...project(files), engine: 'pdflatex' });
    assert.equal(out.find(f => f.name === 'm.tex').data.toString(), '\\documentclass{article}\n\\begin{document}\nA.\n\\end{document}\n');
    assert.equal(report.afterEnd, 2);
    assert.deepEqual(report.missing, []);
});

test('the compiler: declared, else xelatex for fontspec, else pdflatex', () => {
    assert.equal(A.chooseEngine('% !TEX program = xelatex\n\\documentclass{article}'), 'xelatex');
    assert.equal(A.chooseEngine('\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}'), 'xelatex');
    assert.equal(A.chooseEngine('\\documentclass{article}\n%\\usepackage{fontspec}\n'), 'pdflatex');
    assert.equal(A.chooseEngine('\\directlua{x}'), 'lualatex');
});
