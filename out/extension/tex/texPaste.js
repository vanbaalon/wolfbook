// texPaste.js — paste a picture into a .tex and get a figure.
//
// Taking a screenshot of a plot and dropping it into the paper is a dozen
// manual steps: save it somewhere, pick a name, remember where `img/` is,
// write the float, remember `\centering`, invent a label. All of it is
// mechanical, and all of it interrupts the sentence you were writing.
//
// THE FILENAME IS A CONTENT HASH, exactly as the notebook importer's is
// (`nb_<sha1-12>.png`). Pasting the same picture twice — which happens
// constantly, because the clipboard still holds it — must not litter the
// project with `paste_1.png`, `paste_2.png`, `paste_3.png`. Same bytes, same
// file, written once.
//
// PURE. The provider that calls this lives in index.js; everything decidable
// without a workspace is decided here, so it can be tested without one.

const path = require('path');
const crypto = require('crypto');

/** The extensions we accept, keyed by the MIME type the clipboard offers. */
const MIME_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
};

/**
 * WHAT TO ASK VS CODE FOR, and why it is not the list above.
 *
 * Registering the exact types (`image/png`, …) looked right and produced a
 * provider that never fired on a pasted screenshot. The built-in Markdown image
 * paste — the one that demonstrably works — asks for the `files` bucket and a
 * WILDCARD instead:
 *
 *     mimeTypes = [textUriList, "files", "image/*", "video/*", "audio/*"]
 *
 * so that is what we ask for too. The exact list stays, but as the thing that
 * decides an extension once an item is in hand, never as the subscription.
 */
const PASTE_MIMES = ['files', 'image/*'];

/**
 * Where a pasted image belongs, relative to the .tex that received it.
 *
 * `img/<paper>/` mirrors the notebook side, which writes its images into
 * `img/<notebook>/`: one folder per document, so deleting a paper's folder
 * cannot take another's pictures with it.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {string} texPath   absolute path of the .tex being edited
 * @param {string} mime
 * @returns {{dir:string, file:string, rel:string, abs:string}}
 */
function imagePathFor(bytes, texPath, mime) {
    const ext = MIME_EXT[String(mime || '').toLowerCase()] || 'png';
    const hash = crypto.createHash('sha1').update(Buffer.from(bytes)).digest('hex').slice(0, 12);
    const base = path.basename(texPath || 'paper.tex').replace(/\.tex$/i, '') || 'paper';
    const dir = path.join(path.dirname(texPath || '.'), 'img', base);
    const file = `paste_${hash}.${ext}`;
    // FORWARD SLASHES IN THE SOURCE, ALWAYS. A Windows path separator in
    // \includegraphics is an escape character to TeX, so the relative path is
    // spelled the way LaTeX reads it whatever platform wrote it.
    const rel = ['img', base, file].join('/');
    return { dir, file, rel, abs: path.join(dir, file) };
}

/** A label suggestion from the file's own name: `fig:` plus something sane. */
function labelSuggestion(rel) {
    const stem = path.basename(String(rel || ''), path.extname(String(rel || '')));
    const clean = stem.replace(/^paste_/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `fig:${clean || 'pasted'}`;
}

/**
 * The snippet a paste inserts.
 *
 * A FIGURE, not a bare \includegraphics — that is what the user asked for and
 * it is also what makes the picture citable: a float carries a caption and a
 * label, so the thing you just pasted can be referred to from the text five
 * minutes later. The caption and the label are TABSTOPS, so the two decisions
 * a picture actually needs are the two things the caret visits.
 *
 * The exception is pasting INSIDE an existing figure. Nesting floats is a LaTeX
 * error, and someone whose caret is between `\begin{figure}` and `\end{figure}`
 * is adding a panel to the figure they are already building.
 *
 * @param {{rel:string, inFigure?:boolean, width?:string}} o
 * @returns {string} a SnippetString body
 */
function figureSnippet(o) {
    const rel = String(o.rel || '');
    const width = o.width || '0.8\\linewidth';
    if (o.inFigure) {
        return `\\includegraphics[width=${width}]{${rel}}`;
    }
    const label = labelSuggestion(rel);
    return [
        '\\begin{figure}[htbp]',
        '  \\centering',
        `  \\includegraphics[width=${width}]{${rel}}`,
        '  \\caption{${1:A caption for the pasted image.}}',
        `  \\label{\${2:${label}}}`,
        '\\end{figure}',
        '',
    ].join('\n');
}

/**
 * Is the caret inside a float already?
 *
 * A scan backwards through the source, counting float delimiters. Deliberately
 * simple and deliberately conservative: it looks only at `figure`/`table` and
 * their starred forms, so anything it is unsure about produces the full float,
 * which is the safe answer — an extra `\begin{figure}` is visible immediately,
 * whereas a bare `\includegraphics` dropped into running prose is not.
 *
 * @param {string} text   the whole document
 * @param {number} offset the caret
 */
function insideFloat(text, offset) {
    const before = String(text || '').slice(0, Math.max(0, offset));
    const re = /\\(begin|end)\s*\{(figure\*?|table\*?)\}/g;
    let depth = 0;
    let m;
    while ((m = re.exec(before))) depth += m[1] === 'begin' ? 1 : -1;
    return depth > 0;
}

/** Does this preamble load graphicx (or a class that implies it)? */
function hasGraphicx(text) {
    const t = String(text || '');
    return /\\usepackage(\[[^\]]*\])?\{[^}]*\bgraphic[sx]\b[^}]*\}/.test(t) ||
        /\\documentclass(\[[^\]]*\])?\{(revtex|beamer)/.test(t);
}

/**
 * The first image-like item in a DataTransfer, whatever mime it arrived under.
 *
 * Clipboard images reach an extension under names that vary by platform and by
 * how the picture was copied, so the type is not searched for by name — every
 * entry is examined and the first that is a FILE with an image extension (or an
 * image mime) wins. `dataTransfer` is iterable as [mime, item] pairs.
 *
 * @returns {{item:object, mime:string, name:string}|null}
 */
function findImageItem(dataTransfer) {
    if (!dataTransfer) return null;
    const pairs = [];
    try {
        if (typeof dataTransfer.forEach === 'function') {
            dataTransfer.forEach((item, mime) => pairs.push([mime, item]));
        } else {
            for (const [mime, item] of dataTransfer) pairs.push([mime, item]);
        }
    } catch (_) { return null; }

    for (const [mime, item] of pairs) {
        if (!item) continue;
        let file = null;
        try { file = typeof item.asFile === 'function' ? item.asFile() : null; } catch (_) { file = null; }
        const name = (file && file.name) || '';
        const byName = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
        const byMime = /^image\//i.test(String(mime || '')) ||
            /^image\//i.test(String((file && file.mimeType) || ''));
        if (!file || (!byName && !byMime)) continue;
        // Prefer the extension the FILE claims; a wildcard subscription means
        // `mime` here can be the bucket name "files" rather than a type.
        const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [])[1];
        const e = String(ext || '').toLowerCase();
        const resolved = /^image\//i.test(String(mime || '')) ? String(mime).toLowerCase()
            : e === 'jpg' || e === 'jpeg' ? 'image/jpeg'
                : MIME_EXT[`image/${e}`] ? `image/${e}` : 'image/png';
        return { item, file, mime: resolved, name };
    }
    return null;
}

module.exports = {
    MIME_EXT, PASTE_MIMES, imagePathFor, labelSuggestion,
    figureSnippet, insideFloat, hasGraphicx, findImageItem,
};
