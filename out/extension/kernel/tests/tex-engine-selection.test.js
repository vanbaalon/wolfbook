const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paperCompileEngine } = require('../../tex/livePolicy');

test('Unicode preambles select a compatible full-PDF compiler without changing Unicode engine choices', () => {
    for (const pkg of ['fontspec', 'unicode-math', 'polyglossia']) {
        const text = `\\documentclass{article}\n\\usepackage{${pkg}}\n\\begin{document}Text`;
        assert.equal(paperCompileEngine(text), 'xelatex', pkg);
        assert.equal(paperCompileEngine(text, 'lualatex'), 'lualatex', pkg);
        assert.equal(paperCompileEngine(text, 'xelatex'), 'xelatex', pkg);
    }
    assert.equal(paperCompileEngine('\\RequirePackage[no-math]{xcolor, fontspec }'), 'xelatex');
    assert.equal(paperCompileEngine('\\usepackage[no-math]\n{fontspec}'), 'xelatex');
    for (const pkg of ['xeCJK', 'xltxtra']) {
        assert.equal(paperCompileEngine(`\\usepackage{${pkg}}`), 'xelatex');
        assert.equal(paperCompileEngine(`\\usepackage{${pkg}}`, 'lualatex'), 'xelatex', 'XeTeX-only packages need XeTeX');
    }
});

test('engine declarations and engine-specific code take precedence over font inference', () => {
    for (const [program, expected] of [['xelatex','xelatex'], ['lualatex','lualatex'], ['pdflatex','pdflatex'],
        ['xetex','xelatex'], ['luatex','lualatex'], ['pdftex','pdflatex']]) {
        assert.equal(paperCompileEngine(`% !TEX program = ${program}\n\\usepackage{fontspec}`), expected);
    }
    assert.equal(paperCompileEngine('\\documentclass{article}\n\\directlua{print("test")}\n\\usepackage{fontspec}'), 'lualatex');
    assert.equal(paperCompileEngine('\\pdfoutput=1\n\\documentclass{article}\n\\usepackage{fontspec}'), 'pdflatex');
});

test('comments, body text and engine-conditional templates do not switch the configured compiler', () => {
    for (const text of ['% \\usepackage{fontspec}\n\\documentclass{article}',
        '\\documentclass{article}\n\\begin{document}\n\\verb|\\usepackage{fontspec}|',
        '\\documentclass{article}\n\\usepackage{iftex}\n\\ifPDFTeX\\usepackage[T1]{fontenc}\\else\\usepackage{fontspec}\\fi',
        '\\documentclass{article}\n\\usepackage{fontspec-extra}',
        '\\documentclass{article}']) {
        assert.equal(paperCompileEngine(text), 'pdflatex', text);
    }
    assert.equal(paperCompileEngine(null, 'lualatex'), 'lualatex');
});
