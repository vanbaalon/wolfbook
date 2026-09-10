// WPaper dependency diagnosis — pure Node, no TeX installation required.

const assert = require('assert');
const {
    inferManager, missingToolIssue, missingFileFromMessage,
    missingFileKind, missingTexFileIssue, formatDependencyHelp,
} = require('../../tex/dependencyHelp');

assert.strictEqual(inferManager('pdfTeX (MiKTeX 24.1)'), 'miktex');
assert.strictEqual(inferManager('TeX Live 2026'), 'texlive');
assert.strictEqual(missingFileFromMessage("LaTeX Error: File `physics.sty' not found."), 'physics.sty');
assert.strictEqual(missingFileKind('revtex4-2.cls'), 'document class');

const fileIssue = missingTexFileIssue([{
    kind: 'missing-file', message: "LaTeX Error: File `physics.sty' not found.",
}], { platform: 'win32', manager: 'texlive' });
assert.ok(fileIssue);
assert.strictEqual(fileIssue.filename, 'physics.sty');
assert.strictEqual(fileIssue.packageHint, 'physics');
assert.match(formatDependencyHelp(fileIssue), /tlmgr search --global --file/);
assert.match(formatDependencyHelp(fileIssue), /tlmgr install <package-name>/);

assert.strictEqual(missingTexFileIssue([{
    kind: 'missing-file', message: "LaTeX Error: File `chapter.tex' not found.",
}], { platform: 'win32' }), null, 'project files are not mistaken for packages');

const noTex = missingToolIssue('latexmk', { platform: 'win32' });
const noTexHelp = formatDependencyHelp(noTex);
assert.match(noTexHelp, /Install MiKTeX/);
assert.match(noTexHelp, /install “latexmk”/);
assert.match(noTexHelp, /Restart every VS Code window/);

const noXe = missingToolIssue('xelatex', { platform: 'win32', manager: 'texlive' });
assert.match(formatDependencyHelp(noXe), /tlmgr install xetex/);

console.log('WPaper dependency diagnostics: OK');
