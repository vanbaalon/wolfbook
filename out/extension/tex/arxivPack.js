// arxivPack.js — a paper made ready for arXiv, as one .zip.
//
// Pure: no vscode, no fs, no child_process. The host injects file access and
// the last build's outputs; this file only decides. It is shared, unchanged,
// by WPaper and the WLaTeX desktop editor.
//
// WHAT ARXIV ASKS FOR (info.arxiv.org/help/submit_tex.html, 00README.html,
// read 2026-09-28), and what this does about each:
//
//   - The source is PUBLIC. Every `%` comment is removed (as Google's
//     arxiv_latex_cleaner does), with `comment` environments and `\iffalse`
//     blocks; a comment that ends a line of text keeps its `%`, so no space
//     appears where the line used to end.
//   - No draft or referee mode. `draft` class and package options go;
//     showkeys, showlabels, lineno, refcheck, showframe, draftwatermark and
//     friends are removed with their commands; todonotes becomes `disable`,
//     fixme and changes `final`, so every \todo still compiles to nothing.
//   - Only files the paper uses: the .tex it inputs, the figures it includes
//     (resolved the way graphicx does, through \graphicspath), listings and
//     data files it reads, and local .sty / .cls files. Nothing hidden, no
//     auxiliary files.
//   - A .bbl, not a .bib: "the name of the .bbl file must match the name of
//     the main .tex file". Likewise .ind / .gls / .nls, since arXiv does not
//     run makeindex. They come from the last build.
//   - A 00README.json naming the top-level file and the compiler (arXiv offers
//     pdflatex, latex and xelatex — not LuaLaTeX).
//   - Figures in a format the engine reads; arXiv converts nothing.

'use strict';

const zlib = require('zlib');

// --- comments ----------------------------------------------------------------

const VERBATIM = /\\begin\{(verbatim\*?|Verbatim\*?|BVerbatim|LVerbatim|lstlisting|minted|alltt|filecontents\*?)\}/;

/** Index of the first `%` that starts a comment, or -1 (skips \%, \verb|…|). */
function commentAt(line) {
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '\\') {
            const m = /^\\(verb\*?|lstinline)(?![a-zA-Z])/.exec(line.slice(i));
            if (m) {
                let j = i + m[0].length;
                if (m[1] === 'lstinline' && line[j] === '[') { const k = line.indexOf(']', j); j = k < 0 ? line.length : k + 1; }
                const open = line[j];
                if (!open) return -1;
                const close = open === '{' ? '}' : open;
                const end = line.indexOf(close, j + 1);
                if (end < 0) return -1;
                i = end;
                continue;
            }
            i++;                                  // \% , \\ , \{ … are one token
            continue;
        }
        if (c === '%') return i;
    }
    return -1;
}

/**
 * Every comment out of a LaTeX source.
 * @returns {{text:string, lines:number, blocks:number}} lines: comment lines
 *   removed (whole or trailing); blocks: comment environments / \iffalse.
 */
function stripComments(text) {
    const src = String(text || '').split('\n');
    const out = [];
    let lines = 0, blocks = 0;
    let verbatim = null;        // the environment we are inside, untouched
    let inComment = false;      // inside \begin{comment} … \end{comment}
    let skip = null;            // an \iffalse block being collected
    for (const raw of src) {
        if (verbatim) {
            out.push(raw);
            if (raw.includes(`\\end{${verbatim}}`)) verbatim = null;
            continue;
        }
        if (inComment) {
            const k = raw.indexOf('\\end{comment}');
            if (k < 0) continue;
            inComment = false;
            const rest = raw.slice(k + '\\end{comment}'.length);
            if (!rest.trim()) continue;
            // text after the environment on the same line survives
            processLine(rest);
            continue;
        }
        processLine(raw);
    }

    function processLine(raw) {
        let line = raw;
        const at = commentAt(line);
        if (at >= 0) {
            const before = line.slice(0, at);
            lines++;
            if (!before.trim()) {
                if (skip) skip.lines.push(null);
                return;                           // a whole-line comment goes
            }
            line = before.replace(/[ \t]+$/, '') + '%';
        }
        if (skip) {
            skip.lines.push(line);
            for (const m of line.matchAll(/\\(if[a-zA-Z@]*|fi|else)(?![a-zA-Z@])/g)) {
                if (m[1] === 'fi') skip.depth--;
                else if (m[1] === 'else') { if (skip.depth === 1) skip.hasElse = true; }
                else skip.depth++;
                if (skip.depth === 0) break;
            }
            if (skip.depth === 0) {
                // Only a plain \iffalse … \fi is dropped: with an \else the
                // second branch is live, and the lines stay as they were.
                const ok = !skip.hasElse && /^\s*\\fi\s*%?\s*$/.test(line) && /^\s*\\iffalse\s*%?\s*$/.test(skip.lines[0]);
                if (ok) blocks++;
                else for (const l of skip.lines) if (l != null) out.push(l);
                skip = null;
            }
            return;
        }
        if (/^\s*\\iffalse\s*%?\s*$/.test(line)) {
            skip = { depth: 1, hasElse: false, lines: [line] };
            return;
        }
        const c = line.indexOf('\\begin{comment}');
        if (c >= 0) {
            blocks++;
            const before = line.slice(0, c);
            const e = line.indexOf('\\end{comment}', c);
            if (e >= 0) {
                const kept = before + line.slice(e + '\\end{comment}'.length);
                if (kept.trim()) out.push(kept);
                return;
            }
            if (before.trim()) out.push(before);
            inComment = true;
            return;
        }
        out.push(line);
        const v = VERBATIM.exec(line);
        if (v && !line.slice(v.index).includes(`\\end{${v[1]}}`)) verbatim = v[1];
    }
    // An \iffalse that never closed is left as written.
    if (skip) for (const l of skip.lines) if (l != null) out.push(l);
    // Runs of blank lines left behind read as one paragraph break anyway.
    const text2 = out.join('\n').replace(/\n{3,}/g, '\n\n');
    return { text: text2, lines, blocks };
}

// --- draft mode -------------------------------------------------------------

/** Packages that only mark up a draft: removed, with their commands. */
const DRAFT_PACKAGES = {
    showkeys: [],
    showlabels: [/\\showlabels\s*\{[^}]*\}/g],
    lineno: [/\\(?:linenumbers|nolinenumbers|pagewiselinenumbers|runninglinenumbers|internallinenumbers)\*?\b/g,
        /\\(?:modulolinenumbers|resetlinenumber)\*?(?:\[[^\]]*\])?/g],
    refcheck: [],
    showframe: [],
    showidx: [],
    draftwatermark: [/\\SetWatermark[A-Za-z]+\s*(?:\[[^\]]*\])?\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g,
        /\\DraftwatermarkOptions\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g],
    draftfigure: [],
    vruler: [/\\setvruler\s*(?:\[[^\]]*\])*/g],
};
/** Packages that stay, told they are in a final version. */
const FINAL_OPTION = { todonotes: 'disable', fixme: 'final', changes: 'final' };
/** Packages whose `draft` option only degrades the output. */
const DRAFT_OPTION = new Set(['graphicx', 'graphics', 'hyperref', 'microtype', 'listings', 'pdfpages']);

const splitList = (s) => s.split(',').map(x => x.trim()).filter(Boolean);

/**
 * The paper in its final form: no draft options, no draft-only packages.
 * @returns {{text:string, changes:string[], warnings:string[]}}
 */
function stripDraft(text) {
    let t = String(text || '');
    const changes = [];
    const warnings = [];
    const removed = new Set();

    t = t.replace(/\\documentclass\s*\[([^\]]*)\]/, (all, opts) => {
        const list = splitList(opts);
        const kept = list.filter(o => o !== 'draft');
        if (kept.length === list.length) return all;
        changes.push('removed the draft class option');
        return kept.length ? `\\documentclass[${kept.join(',')}]` : '\\documentclass';
    });
    const cls = /\\documentclass\s*(?:\[([^\]]*)\])?/.exec(t);
    for (const o of splitList((cls && cls[1]) || '')) {
        if (/^(referee|doublespace|doublespacing|manuscript)$/.test(o)) {
            warnings.push(`the class option "${o}" typesets a referee copy; arXiv asks for the normal layout`);
        }
    }
    if (/\\doublespacing\b/.test(t)) warnings.push('\\doublespacing is on; arXiv asks not to submit in double-spaced referee mode');

    t = t.replace(/\\usepackage\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g, (all, optGroup, names) => {
        const opts = optGroup ? splitList(optGroup.slice(1, -1)) : [];
        const list = splitList(names);
        const keep = [];
        const extra = [];
        for (const p of list) {
            if (Object.prototype.hasOwnProperty.call(DRAFT_PACKAGES, p)) {
                removed.add(p);
                changes.push(`removed \\usepackage{${p}}`);
                continue;
            }
            if (FINAL_OPTION[p]) {
                const want = FINAL_OPTION[p];
                if (list.length === 1) {
                    if (opts.includes(want)) return all;
                    const o = opts.filter(x => x !== 'draft');
                    changes.push(`${p} set to ${want}`);
                    return `\\usepackage[${[...o, want].join(',')}]{${p}}`;
                }
                extra.push(`\\usepackage[${want}]{${p}}`);
                changes.push(`${p} set to ${want}`);
                continue;
            }
            keep.push(p);
        }
        let head = '';
        if (keep.length) {
            let o = opts;
            if (keep.every(p => DRAFT_OPTION.has(p)) && o.includes('draft')) {
                o = o.filter(x => x !== 'draft');
                changes.push(`removed the draft option of ${keep.join(', ')}`);
            }
            head = `\\usepackage${o.length ? `[${o.join(',')}]` : ''}{${keep.join(',')}}`;
        }
        return [head, ...extra].filter(Boolean).join('\n');
    });
    // Options given to every package at once.
    t = t.replace(/\\PassOptionsToPackage\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (all, opts, pkgs) => {
        const list = splitList(opts);
        if (!list.includes('draft') || !splitList(pkgs).every(p => DRAFT_OPTION.has(p))) return all;
        const kept = list.filter(o => o !== 'draft');
        changes.push(`removed the draft option passed to ${pkgs}`);
        return kept.length ? `\\PassOptionsToPackage{${kept.join(',')}}{${pkgs}}` : '';
    });
    for (const p of removed) {
        for (const re of DRAFT_PACKAGES[p]) {
            const before = t;
            t = t.replace(re, '');
            if (t !== before) changes.push(`removed the commands of ${p}`);
        }
    }
    // A line emptied by the removals goes with them.
    t = t.replace(/\n[ \t]*\n(?=[ \t]*\n)/g, '\n');
    return { text: t, changes, warnings };
}

// --- what the paper uses -----------------------------------------------------

/** The files a (comment-free) source names. */
function dependencies(text) {
    const t = String(text || '');
    const d = {
        inputs: [], graphics: [], graphicspath: [], files: [], packages: [], classes: [],
        bibliography: false, biblatex: false, index: false, glossary: false, nomenclature: false,
    };
    const arg = (re, into, map = x => x) => { for (const m of t.matchAll(re)) into.push(...[].concat(map(m)).filter(Boolean)); };
    arg(/\\(?:input|include|subfile|includeonly)\s*\{([^}]+)\}/g, d.inputs, m => m[1].trim());
    arg(/\\input\s+([^\s{\\%]+)/g, d.inputs, m => m[1].trim());
    arg(/\\(?:sub)?import\*?\s*\{([^}]*)\}\s*\{([^}]+)\}/g, d.inputs, m => (m[1].trim() + m[2].trim()));
    arg(/\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g, d.graphics, m => m[1].trim());
    arg(/\\includepdf\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g, d.graphics, m => m[1].trim());
    arg(/\\(?:epsfig|psfig)\s*\{[^}]*?(?:file|figure)\s*=\s*([^,}\s]+)/g, d.graphics, m => m[1].trim());
    arg(/\\(?:pgfimage|includestandalone)\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g, d.graphics, m => m[1].trim());
    for (const m of t.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\}\s*)+)\}/g)) {
        for (const p of m[1].matchAll(/\{([^}]*)\}/g)) d.graphicspath.push(p[1].trim());
    }
    arg(/\\(?:lstinputlisting|verbatiminput|VerbatimInput|LVerbatimInput)\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g, d.files, m => m[1].trim());
    arg(/\\inputminted\s*(?:\[[^\]]*\]\s*)*\{[^}]*\}\s*\{([^}]+)\}/g, d.files, m => m[1].trim());
    arg(/\btable\s*(?:\[[^\]]*\]\s*)?\{([^}\s\\]+\.[A-Za-z0-9]+)\}/g, d.files, m => m[1].trim());
    arg(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, d.packages, m => splitList(m[1]));
    arg(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, d.classes, m => m[1].trim());
    d.bibliography = /\\(?:bibliography|addbibresource|printbibliography)\b/.test(t);
    d.biblatex = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bbiblatex\b/.test(t) || /\\addbibresource\b/.test(t);
    d.index = /\\(?:printindex|makeindex)\b/.test(t);
    d.glossary = /\\printglossar(?:y|ies)\b/.test(t);
    d.nomenclature = /\\printnomenclature\b/.test(t);
    return d;
}

/** What graphicx tries, in order, for a name with no extension. */
function graphicExtensions(engine) {
    if (engine === 'latex') return ['.eps', '.ps', '.EPS', '.PS'];
    return ['.pdf', '.PDF', '.png', '.PNG', '.jpg', '.JPG', '.jpeg', '.JPEG', '.eps', '.EPS'];
}

const norm = (p) => {
    const out = [];
    for (const s of String(p).replace(/\\/g, '/').split('/')) {
        if (!s || s === '.') continue;
        if (s === '..') { if (!out.length || out[out.length - 1] === '..') out.push('..'); else out.pop(); continue; }
        out.push(s);
    }
    return out.join('/');
};
// Inkscape's `figure.pdf_tex` has an extension too.
const hasExt = (p) => /\.[A-Za-z0-9_]{1,8}$/.test(p.split('/').pop());
const baseOf = (p) => p.replace(/\.[^./]+$/, '');

/**
 * The paper, ready for arXiv.
 *
 * @param {{
 *   main: string,                          project-relative main file
 *   read: (rel:string) => string|null,     a text file of the project
 *   readBinary: (rel:string) => Buffer|null,
 *   exists: (rel:string) => boolean,
 *   built?: {bbl?:string|null, ind?:string|null, gls?:string|null, nls?:string|null},
 *   engine?: 'pdflatex'|'xelatex'|'lualatex'|'latex',
 *   texliveYear?: number|null,
 *   options?: {comments?:boolean, draft?:boolean}
 * }} o
 * @returns {{files:Array<{name:string,data:Buffer}>, report:object}}
 */
function prepareArxiv(o) {
    const engine = o.engine || 'pdflatex';
    const opts = { comments: true, draft: true, ...(o.options || {}) };
    const report = {
        main: o.main, engine, compiler: null,
        tex: [], figures: [], other: [], generated: [],
        comments: 0, commentBlocks: 0, draft: [], warnings: [], missing: [], errors: [],
    };
    const files = new Map();
    const add = (name, data) => { if (!files.has(name)) files.set(name, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')); };
    const mainDir = o.main.includes('/') ? o.main.slice(0, o.main.lastIndexOf('/') + 1) : '';

    // arXiv compiles from the submission's root; LaTeX resolves paths from
    // where it runs, so a path is tried as written and from the main file's
    // folder.
    const locate = (rel, exts) => {
        const tries = [];
        for (const base of [norm(rel), norm(mainDir + rel)]) {
            if (hasExt(base)) tries.push(base);
            for (const e of exts) tries.push(base + e);
        }
        return tries.find(p => p && !p.startsWith('..') && !p.split('/').some(s => s.startsWith('.')) && o.exists(p)) || null;
    };

    let graphicspath = [];
    const seen = new Set();
    const visit = (rel, isMain) => {
        const file = isMain ? norm(rel) : locate(rel, ['.tex']);
        if (!file) { report.missing.push(rel); return; }
        if (seen.has(file)) return;
        seen.add(file);
        let text = o.read(file);
        if (text == null) { report.missing.push(file); return; }
        // Nothing after \end{document} is read by LaTeX, and it would be
        // published: leftover notes go.
        if (isMain) {
            const end = /^[ \t]*\\end\s*\{document\}.*$/m.exec(text);
            if (end) {
                const after = text.slice(end.index + end[0].length);
                if (after.trim()) {
                    report.afterEnd = after.split('\n').filter(l => l.trim()).length;
                    text = text.slice(0, end.index + end[0].length) + '\n';
                }
            }
        }
        if (opts.comments) {
            const c = stripComments(text);
            text = c.text; report.comments += c.lines; report.commentBlocks += c.blocks;
        }
        if (opts.draft) {
            const d = stripDraft(text);
            text = d.text;
            for (const x of d.changes) report.draft.push(`${file}: ${x}`);
            for (const x of d.warnings) report.warnings.push(`${file}: ${x}`);
        }
        const dep = dependencies(text);
        if (dep.graphicspath.length) graphicspath = dep.graphicspath;
        add(file, text);
        report.tex.push(file);
        for (const g of dep.graphics) {
            const dirs = ['', ...graphicspath];
            let found = null;
            for (const d of dirs) {
                found = locate(d + g, hasExt(g) ? [] : graphicExtensions(engine));
                if (found) break;
            }
            if (!found) { report.missing.push(g); continue; }
            if (!files.has(found)) {
                const bytes = o.readBinary(found);
                if (!bytes) { report.missing.push(found); continue; }
                add(found, bytes);
                report.figures.push(found);
            }
            if (/\.e?ps$/i.test(found) && engine !== 'latex' && engine !== 'xelatex') {
                report.warnings.push(`${found}: arXiv does not convert EPS for ${engine}; convert it to PDF`);
            }
            if (/\.(pdf|png|jpe?g)$/i.test(found) && engine === 'latex') {
                report.warnings.push(`${found}: LaTeX in DVI mode needs EPS figures`);
            }
        }
        for (const f of dep.files) {
            const found = locate(f, []);
            if (!found) { report.missing.push(f); continue; }
            const bytes = o.readBinary(found);
            if (bytes) { add(found, bytes); report.other.push(found); }
        }
        for (const p of dep.packages) {
            const found = locate(p, ['.sty']);
            if (found && /\.sty$/.test(found)) { const b = o.readBinary(found); if (b) { add(found, b); report.other.push(found); } }
        }
        for (const c of dep.classes) {
            const found = locate(c, ['.cls']);
            if (found && /\.cls$/.test(found)) { const b = o.readBinary(found); if (b) { add(found, b); report.other.push(found); } }
        }
        for (const i of dep.inputs) {
            // A local .sty or .bbl named by \input is a file, not a source.
            if (/\.(sty|cls|bbl|tikz|pgf|dat|txt|csv)$/i.test(i)) {
                const found = locate(i, []);
                if (found) { const b = o.readBinary(found); if (b) { add(found, b); report.other.push(found); } }
                else report.missing.push(i);
                continue;
            }
            visit(i, false);
        }
        return dep;
    };
    const top = visit(o.main, true);
    if (!top) { report.errors.push(`${o.main} could not be read`); return { files: [], report }; }

    // What arXiv does not make: the bibliography, index and glossaries, named
    // after the main file.
    const job = baseOf(o.main);
    const built = o.built || {};
    const usesBib = [...seen].some(f => dependencies(files.get(f).toString('utf8')).bibliography);
    if (usesBib) {
        if (built.bbl) {
            add(`${job}.bbl`, built.bbl);
            report.generated.push(`${job}.bbl`);
            const biblatex = [...seen].some(f => dependencies(files.get(f).toString('utf8')).biblatex);
            if (biblatex) {
                // biblatex writes `% $ biblatex bbl format version 3.3 $`.
                const v = /biblatex bbl format version (\d+(?:\.\d+)*)/.exec(built.bbl);
                report.warnings.push('biblatex: arXiv reads the .bbl only if it was made by the same biblatex version' +
                    (o.texliveYear ? ` (this one is from TeX Live ${o.texliveYear}; arXiv has TeX Live 2025 and 2023)` : ' (arXiv has TeX Live 2025 and 2023)') +
                    (v && v[1] ? `, bbl format ${v[1]}` : ''));
            }
        } else {
            report.errors.push('the paper has a bibliography but no .bbl: build it once, then prepare again');
        }
    }
    const needs = [
        ['ind', [...seen].some(f => dependencies(files.get(f).toString('utf8')).index), 'an index (.ind)'],
        ['gls', [...seen].some(f => dependencies(files.get(f).toString('utf8')).glossary), 'a glossary (.gls)'],
        ['nls', [...seen].some(f => dependencies(files.get(f).toString('utf8')).nomenclature), 'a nomenclature (.nls)'],
    ];
    for (const [ext, used, what] of needs) {
        if (!used) continue;
        if (built[ext]) { add(`${job}.${ext}`, built[ext]); report.generated.push(`${job}.${ext}`); }
        else report.warnings.push(`the paper prints ${what} but the last build left none; arXiv does not run makeindex`);
    }

    // arXiv offers pdflatex, latex and xelatex.
    const compiler = engine === 'lualatex' ? null : engine === 'xelatex' ? 'xelatex' : engine === 'latex' ? 'latex' : 'pdflatex';
    report.compiler = compiler;
    if (!compiler) report.errors.push('arXiv does not offer LuaLaTeX (only pdflatex, latex and xelatex); the paper must build with one of them');
    const readme = {
        spec_version: 1,
        process: { compiler: compiler || 'pdflatex' },
        sources: [{ filename: o.main, usage: 'toplevel' }],
    };
    if (o.texliveYear >= 2025) readme.texlive_version = 2025;
    else if (o.texliveYear === 2023 || o.texliveYear === 2024) readme.texlive_version = 2023;
    add('00README.json', JSON.stringify(readme, null, 2) + '\n');

    for (const name of files.keys()) {
        if (!/^[A-Za-z0-9_+\-.,=/]+$/.test(name)) {
            report.warnings.push(`"${name}": arXiv asks for file names made of letters, digits and _ + - . , =`);
        }
    }
    report.missing = [...new Set(report.missing)];
    report.other = [...new Set(report.other)];
    return { files: [...files].map(([name, data]) => ({ name, data })), report };
}

/**
 * The compiler arXiv should run: what the paper declares (`% !TEX program`),
 * else xelatex when its preamble needs XeTeX (fontspec, unicode-math,
 * polyglossia, xeCJK), else pdflatex, arXiv's usual. LuaLaTeX is reported by
 * prepareArxiv, as arXiv does not offer it.
 */
function chooseEngine(mainText) {
    const t = String(mainText || '');
    const magic = /^[ \t]*%[ \t]*![ \t]*TEX[ \t]+(?:TS-)?program[ \t]*=[ \t]*([A-Za-z]+)/im.exec(t.slice(0, 4000));
    if (magic) {
        const p = magic[1].toLowerCase();
        if (['pdflatex', 'xelatex', 'lualatex', 'latex'].includes(p)) return p;
    }
    const begin = t.indexOf('\\begin{document}');
    const preamble = (begin < 0 ? t : t.slice(0, begin)).replace(/(^|[^\\])%.*$/gm, '$1');
    if (/\\directlua\b|\{[^}]*\b(?:luacode|luatexbase|luamplib)\b[^}]*\}/.test(preamble)) return 'lualatex';
    if (/\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:fontspec|unicode-math|polyglossia|xeCJK|xltxtra)\b/.test(preamble)) return 'xelatex';
    return 'pdflatex';
}

// --- zip ---------------------------------------------------------------------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** A .zip of `files` (deflated), with a fixed date so it is reproducible. */
function zip(files, date = new Date(2026, 0, 1)) {
    const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const f of files) {
        const name = Buffer.from(f.name, 'utf8');
        const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
        const deflated = zlib.deflateRawSync(data, { level: 9 });
        const useDeflate = deflated.length < data.length;
        const body = useDeflate ? deflated : data;
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);                 // UTF-8 names
        local.writeUInt16LE(useDeflate ? 8 : 0, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, body);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x031e, 4);                // made by: Unix, 3.0
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(useDeflate ? 8 : 0, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE((0o100644 << 16) >>> 0, 38);   // -rw-r--r--
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

/** A few lines saying what was done, for the host to show. */
function summary(report) {
    const out = [];
    out.push(`${report.tex.length} .tex, ${report.figures.length} figure${report.figures.length === 1 ? '' : 's'}` +
        (report.other.length ? `, ${report.other.length} other file${report.other.length === 1 ? '' : 's'}` : '') +
        (report.generated.length ? `, ${report.generated.join(', ')}` : ''));
    if (report.comments || report.commentBlocks) out.push(`${report.comments} comment line${report.comments === 1 ? '' : 's'} removed` +
        (report.commentBlocks ? `, ${report.commentBlocks} commented-out block${report.commentBlocks === 1 ? '' : 's'}` : ''));
    if (report.afterEnd) out.push(`${report.afterEnd} line${report.afterEnd === 1 ? '' : 's'} after \\end{document} removed`);
    if (report.draft.length) out.push(`draft mode: ${report.draft.map(d => d.replace(/^[^:]+: /, '')).join('; ')}`);
    if (report.compiler) out.push(`00README.json: ${report.main}, ${report.compiler}`);
    for (const m of report.missing) out.push(`missing: ${m}`);
    for (const w of report.warnings) out.push(`warning: ${w}`);
    for (const e of report.errors) out.push(`error: ${e}`);
    return out;
}

module.exports = { chooseEngine, stripComments, stripDraft, dependencies, prepareArxiv, zip, crc32, summary, commentAt, graphicExtensions };
