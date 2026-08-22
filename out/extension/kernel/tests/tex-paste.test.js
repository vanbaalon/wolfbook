// Pasting a picture into a .tex, and what a cross-reference resolves to.
//
//   node out/extension/kernel/tests/tex-paste.test.js
//
// Both halves are pure by construction — a paste is (bytes, caret) -> (path,
// snippet), and a reference is (line, column) -> what it points at — so the
// parts worth being sure about need no workspace, no compile and no window.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const {
    imagePathFor, figureSnippet, insideFloat, hasGraphicx, labelSuggestion,
    PASTE_MIMES, findImageItem,
} = require('../../tex/texPaste');
const { refAt, resolveRef, hoverMarkdown } = require('../../tex/refIntel');
const {
    parseAppleScriptData, looksLikePng, clipboardImageCommand, readClipboardImage,
} = require('../../tex/texClipboard');
const { scanTex } = require('../../tex/texScanner');
const { buildModel } = require('../../tex/texModel');

// --- where a pasted image goes ----------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

test('THE SAME PICTURE TWICE IS THE SAME FILE', () => {
    // The clipboard still holds the screenshot, so pasting twice is the normal
    // accident. Names derived from a counter would litter the project with
    // paste_1, paste_2, paste_3 — all identical.
    const a = imagePathFor(PNG, '/paper/main.tex', 'image/png');
    const b = imagePathFor(Buffer.from(PNG), '/paper/main.tex', 'image/png');
    assert.strictEqual(a.file, b.file);
    const other = imagePathFor(Buffer.from([9, 9, 9]), '/paper/main.tex', 'image/png');
    assert.notStrictEqual(a.file, other.file, 'different bytes, different file');
});

test('it lands in img/<paper>/, beside the .tex', () => {
    const p = imagePathFor(PNG, '/paper/main.tex', 'image/png');
    assert.ok(p.dir.endsWith('/img/main') || p.dir.endsWith('\\img\\main'), p.dir);
    assert.ok(/^paste_[0-9a-f]{12}\.png$/.test(p.file), p.file);
    assert.strictEqual(p.rel, `img/main/${p.file}`);
});

test('THE PATH IN THE SOURCE USES FORWARD SLASHES', () => {
    // A backslash is an escape character to TeX; a Windows separator in
    // \includegraphics does not merely look wrong, it fails to compile.
    const p = imagePathFor(PNG, '/paper/main.tex', 'image/png');
    assert.ok(!p.rel.includes('\\'), p.rel);
});

test('the extension follows the MIME type', () => {
    assert.ok(imagePathFor(PNG, '/p/m.tex', 'image/jpeg').file.endsWith('.jpg'));
    assert.ok(imagePathFor(PNG, '/p/m.tex', 'image/gif').file.endsWith('.gif'));
    assert.ok(imagePathFor(PNG, '/p/m.tex', 'application/octet-stream').file.endsWith('.png'),
        'an unknown type is treated as PNG rather than refused');
});

test('WE SUBSCRIBE THE WAY THE BUILT-IN IMAGE PASTE DOES', () => {
    // Registering the exact types produced a provider that never fired on a
    // pasted screenshot. The Markdown extension — which demonstrably works —
    // asks for the `files` bucket and a wildcard.
    assert.ok(PASTE_MIMES.includes('files'), PASTE_MIMES.join(','));
    assert.ok(PASTE_MIMES.includes('image/*'), PASTE_MIMES.join(','));
});

/** A DataTransfer shaped like VS Code's, iterable as [mime, item]. */
const transferOf = (entries) => ({
    forEach(fn) { for (const [mime, item] of entries) fn(item, mime); },
});
const fileItem = (name, mimeType) => ({
    asFile: () => ({ name, mimeType, data: async () => PNG }),
});

test('the image is found whatever bucket it arrived in', () => {
    const hit = findImageItem(transferOf([['files', fileItem('image.png', 'image/png')]]));
    assert.ok(hit, 'found under the generic files bucket');
    assert.strictEqual(hit.mime, 'image/png');
});

test('and under a real image mime', () => {
    const hit = findImageItem(transferOf([['image/jpeg', fileItem('shot.jpg', 'image/jpeg')]]));
    assert.ok(hit);
    assert.strictEqual(hit.mime, 'image/jpeg');
});

test('a .jpg name resolves to the jpeg type', () => {
    const hit = findImageItem(transferOf([['files', fileItem('photo.jpg', '')]]));
    assert.ok(hit);
    assert.strictEqual(hit.mime, 'image/jpeg');
});

test('PLAIN TEXT IS NOT AN IMAGE', () => {
    // The provider is consulted for every paste; claiming one would replace the
    // reader's pasted text with a figure.
    const hit = findImageItem(transferOf([
        ['text/plain', { asFile: () => undefined }],
        ['text/uri-list', { asFile: () => undefined }],
    ]));
    assert.strictEqual(hit, null);
});

test('a pasted .pdf or .tex file is not claimed either', () => {
    assert.strictEqual(findImageItem(transferOf([['files', fileItem('paper.pdf', 'application/pdf')]])), null);
    assert.strictEqual(findImageItem(transferOf([['files', fileItem('notes.tex', 'text/plain')]])), null);
});

// --- getting the picture OUT of the system clipboard -------------------------
//
// VS Code has no API for reading an image from the clipboard, so this shells
// out. The command lines and the parsing are the part that can be wrong.

const REAL_PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(40, 7),
]);
const asAppleScript = (buf) => `«data PNGf${buf.toString('hex').toUpperCase()}»\n`;

test('THE TYPE CODE ENDS IN A HEX DIGIT, AND THAT COSTS A NIBBLE', () => {
    // «data PNGf89504E47…» — taking "the first long run of hex" starts at the
    // **f of PNGf**, so every byte comes out shifted by half a byte and the PNG
    // signature never matches. Measured against the real macOS clipboard: 75
    // bytes parsed, looksLikePng false, the whole feature silently dead.
    const out = parseAppleScriptData(asAppleScript(REAL_PNG));
    assert.ok(out, 'something was parsed');
    assert.ok(looksLikePng(out),
        `and it is a PNG, not a nibble-shifted one: ${out.slice(0, 4).toString('hex')}`);
    assert.strictEqual(Buffer.compare(out, REAL_PNG), 0, 'byte for byte');
});

test('other clipboard types parse the same way', () => {
    const tiff = `«data TIFF${REAL_PNG.toString('hex').toUpperCase()}»`;
    assert.strictEqual(Buffer.compare(parseAppleScriptData(tiff), REAL_PNG), 0);
});

test('an empty or non-data answer yields nothing', () => {
    assert.strictEqual(parseAppleScriptData(''), null);
    assert.strictEqual(parseAppleScriptData('«class utxt»'), null);
    assert.strictEqual(looksLikePng(Buffer.from('not a png at all')), false);
    assert.strictEqual(looksLikePng(null), false);
});

test('each platform is asked in the way that platform answers', () => {
    assert.strictEqual(clipboardImageCommand('darwin', '/tmp/x.png').cmd, 'osascript');
    const win = clipboardImageCommand('win32', "/tmp/o'x.png");
    assert.strictEqual(win.cmd, 'powershell');
    assert.ok(win.args.includes('-STA'),
        'the clipboard is an STA API — powershell without it returns nothing at all');
    assert.ok(win.args.join(' ').includes("o''x.png"), 'and a quote in the path is escaped');
    assert.strictEqual(clipboardImageCommand('linux', '/tmp/x.png').via, 'stdout-binary');
});

test('a clipboard with no image is not an error', () => {
    // osascript exits non-zero when the clipboard holds no PNG, which is the
    // ORDINARY case — every text paste takes this path.
    const got = readClipboardImage({
        platform: 'darwin',
        run: () => ({ status: 1, stdout: Buffer.from('') }),
        readFile: () => { throw new Error('nope'); },
        exists: () => false, unlink: () => {},
    });
    assert.strictEqual(got, null);
});

test('the macOS path returns the bytes end to end', () => {
    const got = readClipboardImage({
        platform: 'darwin',
        run: () => ({ status: 0, stdout: Buffer.from(asAppleScript(REAL_PNG)) }),
        readFile: () => { throw new Error('unused'); },
        exists: () => false, unlink: () => {},
    });
    assert.ok(got && Buffer.compare(got, REAL_PNG) === 0);
});

test('the Windows path reads the file powershell wrote, and cleans up', () => {
    let removed = null;
    const got = readClipboardImage({
        platform: 'win32', tmp: 'C:\\\\tmp\\\\clip.png',
        run: () => ({ status: 0, stdout: Buffer.from('ok') }),
        readFile: () => REAL_PNG,
        exists: () => true,
        unlink: (f) => { removed = f; },
    });
    assert.ok(got && Buffer.compare(got, REAL_PNG) === 0);
    assert.strictEqual(removed, 'C:\\\\tmp\\\\clip.png', 'the temp file is not left behind');
});

test('a runner that throws is answered with nothing, never a crash', () => {
    const got = readClipboardImage({
        platform: 'darwin',
        run: () => { throw new Error('no osascript here'); },
        readFile: () => null, exists: () => false, unlink: () => {},
    });
    assert.strictEqual(got, null);
});

// --- what gets inserted ------------------------------------------------------

test('a paste in prose inserts a FIGURE with caption and label tabstops', () => {
    const s = figureSnippet({ rel: 'img/main/paste_abc.png' });
    assert.ok(s.includes('\\begin{figure}'), s);
    assert.ok(s.includes('\\end{figure}'), s);
    assert.ok(s.includes('\\centering'));
    assert.ok(s.includes('\\includegraphics[width=0.8\\linewidth]{img/main/paste_abc.png}'), s);
    assert.ok(/\\caption\{\$\{1:/.test(s), 'the caption is the first tabstop');
    assert.ok(/\\label\{\$\{2:fig:/.test(s), 'the label is the second');
});

test('INSIDE a figure it inserts a bare \\includegraphics', () => {
    // Nesting floats is a LaTeX error, and a caret inside \begin{figure} means
    // "another panel", not "another figure".
    const s = figureSnippet({ rel: 'img/main/p.png', inFigure: true });
    assert.ok(s.startsWith('\\includegraphics'), s);
    assert.ok(!s.includes('\\begin{figure}'));
});

test('insideFloat counts delimiters rather than guessing', () => {
    const src = [
        'Prose here.',                       // 0
        '\\begin{figure}',                   // 1
        '  \\includegraphics{a.png}',        // 2
        '\\end{figure}',                     // 3
        'More prose.',                       // 4
    ].join('\n');
    const at = (line) => src.split('\n').slice(0, line).join('\n').length + 1;
    assert.strictEqual(insideFloat(src, at(0)), false, 'before it');
    assert.strictEqual(insideFloat(src, at(3)), true, 'inside it');
    assert.strictEqual(insideFloat(src, at(5)), false, 'after it closed');
});

test('a label is suggested from the file name', () => {
    assert.strictEqual(labelSuggestion('img/main/paste_ab12cd34ef56.png'), 'fig:ab12cd34ef56');
});

test('graphicx is detected, including through a class that implies it', () => {
    assert.strictEqual(hasGraphicx('\\usepackage{graphicx}'), true);
    assert.strictEqual(hasGraphicx('\\usepackage[dvips]{graphics}'), true);
    assert.strictEqual(hasGraphicx('\\usepackage{amsmath,graphicx}'), true);
    assert.strictEqual(hasGraphicx('\\documentclass[aps]{revtex4-2}'), true);
    assert.strictEqual(hasGraphicx('\\documentclass{article}\n\\usepackage{amsmath}'), false);
});

// --- what a cross-reference points at ----------------------------------------

const FILE = '/paper/main.tex';
const SRC = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Inversion}\\label{sec:inv}',
    '\\begin{equation}',
    '  (S^\\pm)^{\\mathsf T} = -S^\\mp',
    '  \\label{eq:inv}',
    '\\end{equation}',
    'By \\eqref{eq:inv} and \\cite{smith2020,jones1999} the claim follows.',
    'Again \\eqref{eq:inv}, and \\ref{sec:inv}.',
    '\\end{document}',
].join('\n');
const LINES = SRC.split('\n');
const MODEL = buildModel(scanTex(SRC, { file: FILE }), { file: FILE });

test('the caret finds the command it is inside', () => {
    const line = LINES[7];
    const hit = refAt(line, line.indexOf('eq:inv'));
    assert.ok(hit);
    assert.strictEqual(hit.cmd, 'eqref');
    assert.strictEqual(hit.kind, 'ref');
    assert.strictEqual(hit.name, 'eq:inv');
});

test('a caret OUTSIDE any reference finds nothing', () => {
    assert.strictEqual(refAt(LINES[7], 0), null);
    assert.strictEqual(refAt('just prose here', 4), null);
});

test('\\cite{a,b}: THE KEY THE CARET IS IN, not the first one', () => {
    const line = LINES[7];
    const at = line.indexOf('jones1999') + 2;
    const hit = refAt(line, at);
    assert.ok(hit, 'a citation was found');
    assert.strictEqual(hit.kind, 'cite');
    assert.strictEqual(hit.name, 'jones1999',
        `hovering the second key must answer about it, got ${hit.name}`);
    const first = refAt(line, line.indexOf('smith2020') + 2);
    assert.strictEqual(first.name, 'smith2020');
});

test('a \\ref resolves to its equation, with the printed number and page', () => {
    const hit = refAt(LINES[7], LINES[7].indexOf('eq:inv'));
    const r = resolveRef({
        ref: hit,
        objects: MODEL.objects,
        printedFor: (n) => (n === 'eq:inv' ? { printed: '(12)', page: 7 } : null),
        sourceOf: (o) => SRC.slice(o.sourceRange.startOffset, o.sourceRange.endOffset),
    });
    assert.strictEqual(r.resolved, true);
    assert.strictEqual(r.printed, '(12)');
    assert.strictEqual(r.page, 7);
    assert.strictEqual(r.ownerKind, 'equation');
    assert.ok(r.target && r.target.startLine === 4,
        `F12 lands on the equation, got ${JSON.stringify(r.target)}`);
    assert.ok(r.source.includes('\\mathsf T'), 'the hover shows what it says');
    assert.strictEqual(r.uses.length, 2, 'both \\eqref sites are counted');
});

test('a \\ref to nothing says so instead of inventing a target', () => {
    const line = 'See \\eqref{eq:ghost}.';
    const r = resolveRef({ ref: refAt(line, line.indexOf('eq:ghost')), objects: MODEL.objects });
    assert.strictEqual(r.resolved, false);
    assert.strictEqual(r.target, null);
    assert.ok(/no \\label/.test(hoverMarkdown(r)), hoverMarkdown(r));
});

test('a \\cite hover carries the bibliography entry', () => {
    const line = LINES[7];
    const r = resolveRef({
        ref: refAt(line, line.indexOf('smith2020') + 2),
        objects: MODEL.objects,
        citeFor: () => ({ printed: '21' }),
        bibEntry: (k) => (k === 'smith2020' ? '@article{smith2020, title={A paper}}' : null),
    });
    assert.strictEqual(r.kind, 'cite');
    assert.strictEqual(r.printed, '21');
    const md = hoverMarkdown(r);
    assert.ok(md.includes('[21]'), md);
    assert.ok(md.includes('@article{smith2020'), md);
});

test('a section label resolves to its heading', () => {
    const line = LINES[8];
    const r = resolveRef({
        ref: refAt(line, line.indexOf('sec:inv')),
        objects: MODEL.objects,
        printedFor: () => ({ printed: '2', page: 3 }),
    });
    assert.strictEqual(r.ownerKind, 'section');
    assert.ok(r.target && r.target.startLine === 3);
});

test('the hover stays quiet about what it does not know', () => {
    // With no .aux there is no number. Saying "unknown" three times is worse
    // than a shorter hover.
    const r = resolveRef({
        ref: refAt(LINES[7], LINES[7].indexOf('eq:inv')),
        objects: MODEL.objects,
    });
    const md = hoverMarkdown(r);
    assert.ok(md.includes('equation'), md);
    assert.ok(!/unknown|undefined|null/i.test(md), md);
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); pass++; results.push('  ok   ' + name); }
        catch (e) {
            fail++;
            results.push('  FAIL ' + name + '\n         ' +
                String((e && e.stack) || e).split('\n').slice(0, 4).join('\n         '));
        }
    }
    console.log('paste-to-figure, and what a cross-reference points at\n');
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
