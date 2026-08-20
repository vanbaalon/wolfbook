// texProject.js — root-file detection and the \input/\include graph.
//
// Pure logic; all I/O is injected. `deps` supplies { readFile, exists, listDir }
// so this is unit-testable with a plain object and works unchanged over
// vscode.workspace.fs or node's fs.
//
// WHY THIS IS STAGE 1 AND NOT LATER: object identity has to be PROJECT-wide.
// A `\label` moved from section3.tex into section4.tex is the same equation,
// and a per-file model cannot see that. Deferring the graph would mean
// rewriting identity once it exists.

const path = require('path');

/** Where a root declaration can come from, strongest first. */
const ROOT_SOURCE = {
    MAGIC_COMMENT: 'magic-comment',   // % !TEX root = ../paper.tex
    CONFIG: 'config',                 // .latexmkrc / latex-workshop.latex.rootFile
    DOCUMENTCLASS: 'documentclass',   // the file declares one itself
    SOLE_TEX: 'sole-tex',             // only one .tex in the directory
    FALLBACK: 'fallback',             // the file we were asked about
};

const RE_MAGIC = /^[ \t]*%[ \t]*!TEX[ \t]+root[ \t]*=[ \t]*(.+?)[ \t]*$/im;
const RE_DOCCLASS = /(^|\n)[ \t]*\\documentclass\b/;
const RE_INPUT = /\\(input|include|subfile|subfileinclude)\s*(?:\[[^\]]*\])?\s*\{([^}\n]+)\}/g;
// `\import{dir/}{file}` and `\subimport{dir/}{file}` take two arguments.
const RE_IMPORT = /\\(sub)?import\s*\{([^}\n]*)\}\s*\{([^}\n]+)\}/g;

/** TeX lets you omit `.tex`; resolve the way the engine would. */
function resolveTexPath(baseDir, ref, deps) {
    const raw = String(ref).trim().replace(/^"(.*)"$/, '$1');
    const candidates = [];
    const abs = path.isAbsolute(raw) ? raw : path.join(baseDir, raw);
    candidates.push(abs);
    if (!/\.[A-Za-z0-9]+$/.test(abs)) candidates.push(abs + '.tex');
    else if (!/\.tex$/i.test(abs)) candidates.push(abs.replace(/\.[A-Za-z0-9]+$/, '.tex'));
    for (const c of candidates) {
        if (deps.exists(c)) return c;
    }
    // Report the most likely intended path even when it does not exist, so a
    // missing \input becomes a diagnostic rather than a silent hole.
    return candidates[candidates.length - 1];
}

/** Every file this one pulls in, with the line it was pulled in on. */
function directIncludes(src, file, deps) {
    const baseDir = path.dirname(file);
    const out = [];
    const lineAt = makeLineIndex(src);

    let m;
    RE_INPUT.lastIndex = 0;
    while ((m = RE_INPUT.exec(src)) !== null) {
        const target = resolveTexPath(baseDir, m[2], deps);
        out.push({ cmd: m[1], raw: m[2], target, line: lineAt(m.index), exists: deps.exists(target) });
    }
    RE_IMPORT.lastIndex = 0;
    while ((m = RE_IMPORT.exec(src)) !== null) {
        const target = resolveTexPath(path.join(baseDir, m[2] || ''), m[3], deps);
        out.push({
            cmd: (m[1] || '') + 'import', raw: m[3], target,
            line: lineAt(m.index), exists: deps.exists(target),
        });
    }
    return out;
}

function makeLineIndex(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
    return (off) => {
        let lo = 0; let hi = starts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
        return lo + 1;
    };
}

/**
 * Find the root for `file`.
 *
 * Precedence is deliberate and matches what other LaTeX tooling does, so a
 * project already configured for LaTeX Workshop needs no second configuration:
 *   1. `% !TEX root =` in this file (the author said so explicitly)
 *   2. an injected config hint (.latexmkrc / latex-workshop.latex.rootFile)
 *   3. this file declares \documentclass — it IS a root
 *   4. exactly one .tex in the directory declares \documentclass
 *   5. give up and treat the file as its own root
 */
function findRoot(file, deps, opts = {}) {
    const seen = new Set();
    let cur = file;

    // Follow magic comments transitively; a chapter can point at a part which
    // points at the book.
    while (cur && !seen.has(cur)) {
        seen.add(cur);
        const src = safeRead(cur, deps);
        if (src == null) break;
        const m = RE_MAGIC.exec(src);
        if (!m) break;
        const next = resolveTexPath(path.dirname(cur), m[1], deps);
        if (next === cur || !deps.exists(next)) break;
        cur = next;
        if (!RE_MAGIC.test(safeRead(cur, deps) || '')) {
            return { root: cur, source: ROOT_SOURCE.MAGIC_COMMENT };
        }
    }
    if (cur !== file) return { root: cur, source: ROOT_SOURCE.MAGIC_COMMENT };

    if (opts.configRoot && deps.exists(opts.configRoot)) {
        return { root: opts.configRoot, source: ROOT_SOURCE.CONFIG };
    }

    const self = safeRead(file, deps);
    if (self != null && RE_DOCCLASS.test(self)) {
        return { root: file, source: ROOT_SOURCE.DOCUMENTCLASS };
    }

    const dir = path.dirname(file);
    let siblings = [];
    try { siblings = (deps.listDir(dir) || []).filter(f => /\.tex$/i.test(f)); } catch (_) { /* unreadable */ }
    const withClass = siblings
        .map(f => path.join(dir, f))
        .filter(p => { const s = safeRead(p, deps); return s != null && RE_DOCCLASS.test(s); });
    if (withClass.length === 1) return { root: withClass[0], source: ROOT_SOURCE.SOLE_TEX };

    // Several roots in one directory is normal (a paper and its talk). Prefer
    // one that actually reaches this file.
    for (const cand of withClass) {
        const g = buildGraph(cand, deps, { maxFiles: opts.maxFiles ?? 200 });
        if (g.files.includes(file)) return { root: cand, source: ROOT_SOURCE.SOLE_TEX };
    }

    return { root: file, source: ROOT_SOURCE.FALLBACK };
}

function safeRead(file, deps) {
    try { return deps.readFile(file); } catch (_) { return null; }
}

/**
 * Walk the include graph from `root`.
 * @returns {{root, files: string[], edges: object[], missing: object[], cycles: string[][], truncated: boolean}}
 */
function buildGraph(root, deps, opts = {}) {
    const maxFiles = opts.maxFiles ?? 200;
    const files = [];
    const edges = [];
    const missing = [];
    const cycles = [];
    const visited = new Set();
    let truncated = false;

    const walk = (file, stack) => {
        if (visited.has(file)) {
            if (stack.includes(file)) cycles.push([...stack.slice(stack.indexOf(file)), file]);
            return;
        }
        if (files.length >= maxFiles) { truncated = true; return; }
        visited.add(file);
        files.push(file);

        const src = safeRead(file, deps);
        if (src == null) return;
        for (const inc of directIncludes(src, file, deps)) {
            edges.push({ from: file, to: inc.target, cmd: inc.cmd, line: inc.line });
            if (!inc.exists) { missing.push({ from: file, line: inc.line, raw: inc.raw, target: inc.target }); continue; }
            walk(inc.target, [...stack, file]);
        }
    };
    walk(root, []);
    return { root, files, edges, missing, cycles, truncated };
}

/** `.latexmkrc` / VS Code settings hint, if the caller can supply the text. */
function rootFromConfig(dir, deps) {
    const rc = path.join(dir, '.latexmkrc');
    const src = deps.exists(rc) ? safeRead(rc, deps) : null;
    if (src) {
        const m = /@default_files\s*=\s*\(\s*['"]([^'"]+)['"]/.exec(src);
        if (m) return resolveTexPath(dir, m[1], deps);
    }
    return null;
}

module.exports = {
    findRoot,
    buildGraph,
    directIncludes,
    resolveTexPath,
    rootFromConfig,
    ROOT_SOURCE,
};
