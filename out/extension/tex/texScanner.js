// texScanner.js — a pragmatic structural scanner for .tex.
//
// Source -> semantic objects. Zero dependencies, no vscode, no fs, NEVER
// throws. Graduated unchanged in substance from the Stage 0 spike
// (Experiments/wolfbook-tex/lib/tex-objects.mjs), where it was validated
// against the Porto corpus: object counts match `grep` exactly for every
// countable class (labels 26/9/31/18, sectioning commands 60 and 69,
// 17 equation + 3 align = 20 display equations), with one warning across the
// whole corpus -- a genuine duplicated \end{equation} in spinchain_report.tex
// that pdflatex then failed on at the same line.
//
// It is deliberately NOT a TeX parser. A full one is impossible (TeX is
// Turing-complete at parse time and every document redefines the language).
// This is a verbatim-aware, brace-matching scanner that recognises the
// structures Wolfbook addresses and degrades everything else to an opaque
// block with a correct range. "Never crashes, always has a range" beats
// "understands everything" for every use we have.
//
// Lines are 1-BASED, matching both \inputlineno and SyncTeX records. A
// 0-based index here costs an off-by-one at every comparison with the render
// map, which is why it is stated here rather than discovered in Stage 2.

const MATH_ENVS = new Set([
    'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*',
    'gather', 'gather*', 'multline', 'multline*', 'flalign', 'flalign*',
    'eqnarray', 'eqnarray*', 'displaymath', 'dmath', 'dmath*',
]);
const FLOAT_ENVS = new Set(['figure', 'figure*', 'table', 'table*', 'wrapfigure', 'sidewaysfigure']);
const THEOREM_ENVS = new Set([
    'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark',
    'example', 'proof', 'conjecture', 'claim', 'observation',
]);
// Environments whose body is not LaTeX and must be skipped wholesale.
const VERBATIM_ENVS = new Set(['verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt', 'comment', 'filecontents', 'filecontents*']);
const LIST_ENVS = new Set(['itemize', 'enumerate', 'description']);

// Environments that carry a number and can therefore own a \label.
const LABELABLE_KINDS = new Set(['display-equation', 'figure', 'table', 'theorem']);

const SECTION_CMDS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];
const SECTION_LEVEL = Object.fromEntries(SECTION_CMDS.map((c, i) => [c, i]));

function classifyEnv(name) {
    if (MATH_ENVS.has(name)) return 'display-equation';
    if (FLOAT_ENVS.has(name)) return name.startsWith('table') ? 'table' : 'figure';
    if (THEOREM_ENVS.has(name)) return 'theorem';
    if (VERBATIM_ENVS.has(name)) return 'verbatim';
    if (LIST_ENVS.has(name)) return 'list';
    if (name === 'tabular' || name === 'tabularx' || name === 'longtable') return 'tabular';
    if (name === 'abstract') return 'abstract';
    if (name === 'document') return 'document';
    return 'environment';
}

/**
 * @param {string} src
 * @param {{file?: string}} opts
 * @returns {{objects: object[], lines: string[], warnings: string[], file: string}}
 *
 * Each object: { kind, envName?, label?, cmd?, level?, startLine, endLine,
 *                startOffset, endOffset, sectionPath, text, opaque }
 * Lines are 1-based, matching both TeX's `\inputlineno` and SyncTeX's records —
 * a 0-based index here would cost an off-by-one at every comparison.
 */
/**
 * Verbatim-like environments are PROJECT-DEFINED, so a hardcoded list is always
 * wrong. Measured on the Porto corpus: wolfbook_tutorial.tex declares `wbcell`
 * via \newtcblisting, and its Wolfram-language bodies are full of `\[Alpha]`
 * named characters that a scanner reads as display math and then hunts for a
 * `\]` that never comes. Read the declarations out of the preamble instead.
 */
function discoverVerbatimEnvs(src) {
    const found = new Set();
    const decls = [
        /\\lstnewenvironment\s*\{([^}]+)\}/g,
        /\\newtcblisting\s*\{([^}]+)\}/g,
        /\\DefineVerbatimEnvironment\s*\{([^}]+)\}/g,
        /\\newminted\s*\{([^}]+)\}/g,
        /\\NewTCBListing\s*\{([^}]+)\}/g,
    ];
    for (const re of decls) {
        let m;
        while ((m = re.exec(src)) !== null) found.add(m[1].trim());
    }
    // \newenvironment{x}{...\begin{lstlisting}...}{...} — a wrapper around a
    // listing is a listing for our purposes.
    const wrap = /\\(?:new|renew)environment\s*\{([^}]+)\}([\s\S]{0,400})/g;
    let m;
    while ((m = wrap.exec(src)) !== null) {
        if (/\b(lstlisting|verbatim|Verbatim|minted|alltt)\b/.test(m[2])) found.add(m[1].trim());
    }
    return found;
}

function scanTex(src, opts = {}) {
    const file = opts.file || '<string>';
    const warnings = [];
    const objects = [];
    const lines = src.split('\n');
    const verbatimEnvs = new Set([...VERBATIM_ENVS, ...discoverVerbatimEnvs(src), ...(opts.verbatimEnvs || [])]);
    const envMacros = discoverEnvMacros(src);
    const refMacros = discoverRefMacros(src);

    // Line-start offsets, so a character offset maps to a line in O(log n).
    const lineStart = new Array(lines.length);
    { let o = 0; for (let i = 0; i < lines.length; i++) { lineStart[i] = o; o += lines[i].length + 1; } }
    const lineAt = (off) => {
        let lo = 0; let hi = lineStart.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= off) lo = mid; else hi = mid - 1; }
        return lo + 1;
    };

    // --- masking pass: comments and verbatim bodies become inert ------------
    // Anything inside them must not be seen as structure. We keep the original
    // string and track a parallel "active" view so offsets stay true.
    const masked = maskInert(src, warnings, verbatimEnvs);

    const envStack = [];
    const sectionStack = [];   // {level, title, line}
    const sectionPath = () => sectionStack.map(s => s.title);

    // The lookbehinds are load-bearing. `\\[2pt]` is a LINE BREAK with extra
    // spacing — pervasive inside align and tabular — and its `\[` tail was
    // being read as the start of display math, which then swallowed the rest of
    // the file looking for a `\]` that does not exist. Same story for `\$$`.
    const RE = /\\(begin|end)\s*\{([^}\n]*)\}|\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\s*\*?\s*(?:\[[^\]]*\])?\s*\{|\\(label|ref|eqref|cite|citep|citet|autoref|input|include|subfile)\s*(?:\[[^\]]*\])?\s*\{([^}\n]*)\}|(?<!\\)\\\[|(?<!\\)\$\$|\\([A-Za-z@]+)/g;

    let m;
    while ((m = RE.exec(masked)) !== null) {
        const off = m.index;
        const line = lineAt(off);

        if (m[1]) {                                   // \begin{...} / \end{...}
            const name = m[2].trim();
            if (m[1] === 'begin') {
                envStack.push({ name, startOffset: off, startLine: line, sectionPath: sectionPath() });
            } else {
                const openIdx = findMatchingOpen(envStack, name);
                if (openIdx < 0) { warnings.push(`${file}:${line}: \\end{${name}} with no matching \\begin`); continue; }
                // Anything left above it was never closed.
                for (let i = envStack.length - 1; i > openIdx; i--) {
                    warnings.push(`${file}:${envStack[i].startLine}: \\begin{${envStack[i].name}} never closed (recovered at \\end{${name}})`);
                }
                const open = envStack[openIdx];
                envStack.length = openIdx;
                const endOffset = off + m[0].length;
                const kind = verbatimEnvs.has(name) ? 'verbatim' : classifyEnv(name);
                if (kind !== 'document') {
                    objects.push(makeObject({
                        kind, envName: name, label: open.label,
                        startOffset: open.startOffset, endOffset,
                        startLine: open.startLine, endLine: lineAt(endOffset),
                        sectionPath: open.sectionPath, src, file,
                    }));
                }
            }
            continue;
        }

        if (m[3]) {                                   // sectioning command
            const cmd = m[3];
            const level = SECTION_LEVEL[cmd];
            const braceOpen = off + m[0].length - 1;
            const close = matchBrace(masked, braceOpen);
            const title = close > 0 ? stripTex(src.slice(braceOpen + 1, close)) : '';
            while (sectionStack.length && sectionStack[sectionStack.length - 1].level >= level) sectionStack.pop();
            sectionStack.push({ level, title, line });
            objects.push(makeObject({
                kind: 'section-heading', cmd, level, title,
                startOffset: off, endOffset: close > 0 ? close + 1 : off + m[0].length,
                startLine: line, endLine: close > 0 ? lineAt(close) : line,
                sectionPath: sectionPath(), src, file,
            }));
            continue;
        }

        if (m[4]) {                                   // \label \ref \cite \input ...
            const cmd = m[4];
            const arg = m[5];
            if (cmd === 'label') {
                // A \label belongs to the innermost enclosing environment THAT
                // CAN CARRY A NUMBER — an equation, float, or theorem. Generic
                // containers cannot: `\begin{document}` is always on the stack,
                // so attaching to "the innermost environment" gave every
                // top-level label to the document and left sections unlabelled.
                // Measured on Superrotations/notes.tex, where `\section{...}`
                // followed by `\label{sec:intro}` produced a section with no
                // label and an agent asking for `sec:intro` got the bare marker
                // instead of the section it names.
                let target = null;
                for (let k = envStack.length - 1; k >= 0; k--) {
                    const kk = verbatimEnvs.has(envStack[k].name)
                        ? 'verbatim' : classifyEnv(envStack[k].name);
                    if (LABELABLE_KINDS.has(kk)) { target = envStack[k]; break; }
                    if (envStack[k].name === 'document') break;
                }
                if (target) target.label = arg;
                else if (objects.length) objects[objects.length - 1].label ||= arg;
                objects.push(makeObject({
                    kind: 'label', name: arg, startOffset: off, endOffset: off + m[0].length,
                    startLine: line, endLine: line, sectionPath: sectionPath(), src, file,
                }));
            } else if (['input', 'include', 'subfile'].includes(cmd)) {
                objects.push(makeObject({
                    kind: 'include', cmd, target: arg, startOffset: off, endOffset: off + m[0].length,
                    startLine: line, endLine: line, sectionPath: sectionPath(), src, file,
                }));
            } else {
                objects.push(makeObject({
                    kind: cmd.startsWith('cite') ? 'cite' : 'ref', cmd, target: arg,
                    startOffset: off, endOffset: off + m[0].length,
                    startLine: line, endLine: line, sectionPath: sectionPath(), src, file,
                }));
            }
            continue;
        }

        if (m[6]) {                                   // a bare control word
            // A stand-in for \label / \ref / \cite, e.g. \la{eq:x}.
            const refAct = refMacros.get(m[6]);
            if (refAct) {
                const braceAt = skipSpaceTo(masked, off + m[0].length, '{');
                if (braceAt < 0) continue;
                const braceEnd = matchBrace(masked, braceAt);
                if (braceEnd < 0) continue;
                const arg = src.slice(braceAt + 1, braceEnd).trim();
                RE.lastIndex = braceEnd + 1;
                if (!arg) continue;
                if (refAct.cmd === 'label') {
                    let target = null;
                    for (let k = envStack.length - 1; k >= 0; k--) {
                        const kk = verbatimEnvs.has(envStack[k].name)
                            ? 'verbatim' : classifyEnv(envStack[k].name);
                        if (LABELABLE_KINDS.has(kk)) { target = envStack[k]; break; }
                        if (envStack[k].name === 'document') break;
                    }
                    if (target) target.label = arg;
                    else if (objects.length) objects[objects.length - 1].label ||= arg;
                    objects.push(makeObject({
                        kind: 'label', name: arg, cmd: m[6], viaMacro: true,
                        startOffset: off, endOffset: braceEnd + 1,
                        startLine: line, endLine: lineAt(braceEnd),
                        sectionPath: sectionPath(), src, file,
                    }));
                } else {
                    objects.push(makeObject({
                        kind: refAct.cmd, cmd: m[6], target: arg, viaMacro: true,
                        startOffset: off, endOffset: braceEnd + 1,
                        startLine: line, endLine: lineAt(braceEnd),
                        sectionPath: sectionPath(), src, file,
                    }));
                }
                continue;
            }

            // Or a stand-in for \begin/\end.
            const act = envMacros.get(m[6]);
            if (!act) continue;
            for (const name of act.opens) {
                envStack.push({ name, startOffset: off, startLine: line, sectionPath: sectionPath(), viaMacro: m[6] });
            }
            for (const name of act.closes) {
                const openIdx = findMatchingOpen(envStack, name);
                if (openIdx < 0) continue;            // silent: the macro may be defensive
                const open = envStack[openIdx];
                envStack.length = openIdx;
                const endOffset = off + m[0].length;
                const kind = verbatimEnvs.has(name) ? 'verbatim' : classifyEnv(name);
                if (kind !== 'document') {
                    objects.push(makeObject({
                        kind, envName: name, label: open.label,
                        startOffset: open.startOffset, endOffset,
                        startLine: open.startLine, endLine: lineAt(endOffset),
                        sectionPath: open.sectionPath, src, file,
                    }));
                }
            }
            continue;
        }

        if (m[0] === '\\[' || m[0] === '$$') {        // unnamed display math
            const closer = m[0] === '\\[' ? '\\]' : '$$';
            const end = masked.indexOf(closer, off + m[0].length);
            if (end < 0) { warnings.push(`${file}:${line}: unterminated ${m[0]} display math`); continue; }
            RE.lastIndex = end + closer.length;
            objects.push(makeObject({
                kind: 'display-equation', envName: m[0] === '\\[' ? '\\[..\\]' : '$$..$$',
                startOffset: off, endOffset: end + closer.length,
                startLine: line, endLine: lineAt(end), sectionPath: sectionPath(), src, file,
            }));
        }
    }

    for (const open of envStack) {
        warnings.push(`${file}:${open.startLine}: \\begin{${open.name}} never closed`);
        objects.push(makeObject({
            kind: classifyEnv(open.name), envName: open.name, opaque: true,
            startOffset: open.startOffset, endOffset: src.length,
            startLine: open.startLine, endLine: lines.length,
            sectionPath: open.sectionPath, src, file,
        }));
    }

    objects.push(...scanParagraphs(src, masked, lineAt, objects, file));
    objects.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
    return { objects, lines, warnings, file };
}

function findMatchingOpen(stack, name) {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === name) return i;
    return -1;
}

function makeObject(o) {
    const { src, ...rest } = o;
    const text = src.slice(o.startOffset, o.endOffset);
    return {
        ...rest,
        text: text.length > 4000 ? text.slice(0, 4000) : text,
        label: o.label ?? undefined,
        opaque: !!o.opaque,
    };
}

/**
 * Replace comment bodies and verbatim-environment bodies with spaces, keeping
 * every offset and newline intact. Structure inside them is invisible to the
 * scanner but the string stays the same length, so offsets map straight back.
 * `\%` is an escaped percent and does NOT start a comment; `\\%` is a line
 * break followed by one that does.
 */
function maskInert(src, warnings, verbatimEnvs = VERBATIM_ENVS) {
    const out = src.split('');
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '\\') {
            // A MACRO DEFINITION BODY IS A TEMPLATE, NOT STRUCTURE.
            //
            // Measured on two real arXiv papers, both of which define
            //   \newcommand{\neqa}{\nonumber\end{eqnarray}}
            // — a common idiom for ending an eqnarray without a number. Read
            // literally, that \end{eqnarray} has no \begin, and every later
            // use of \neqa leaves an eqnarray the scanner thinks is still
            // open. On LongPaper.tex that was 4 spurious warnings, which in
            // the editor is 4 squiggles on correct TeX — the fastest way to
            // teach someone to switch diagnostics off. Blank the body; the
            // macro only becomes structure where it is USED.
            const defBody = macroDefinitionBody(src, i);
            if (defBody) {
                // Blank the WHOLE construct, not just the body. The name being
                // defined is a control word too, and leaving `\beq` visible in
                // `\newcommand{\beq}{\begin{equation}}` made the definition
                // line itself register as an equation once begin/end aliases
                // were understood — two phantom objects in a five-line file.
                // Discovery (discoverEnvMacros, discoverVerbatimEnvs) reads the
                // RAW source, so nothing is lost by hiding it here.
                for (let k = i; k <= defBody.to && k < n; k++) {
                    if (out[k] !== '\n') out[k] = ' ';
                }
                i = defBody.to + 1;
                continue;
            }
        }
        if (c === '\\') {
            // A control sequence: skip the backslash and one following char so
            // that \% and \\ cannot be misread.
            if (i + 1 < n) {
                const name = /^[A-Za-z]+/.exec(src.slice(i + 1, i + 40));
                if (name && verbatimEnvs.size) {
                    // \begin{verbatim-ish} — blank the body through \end{...}
                    const beg = /^\\begin\s*\{([^}\n]+)\}/.exec(src.slice(i, i + 80));
                    if (beg && verbatimEnvs.has(beg[1].trim())) {
                        const closeTag = `\\end{${beg[1].trim()}}`;
                        const end = src.indexOf(closeTag, i);
                        const stop = end < 0 ? n : end;
                        if (end < 0) warnings.push(`unterminated \\begin{${beg[1].trim()}}`);
                        for (let k = i + beg[0].length; k < stop; k++) if (out[k] !== '\n') out[k] = ' ';
                        i = stop;
                        continue;
                    }
                }
                i += name ? 1 + name[0].length : 2;
                continue;
            }
            i++;
            continue;
        }
        if (c === '%') {
            let k = i;
            while (k < n && src[k] !== '\n') { out[k] = ' '; k++; }
            i = k;
            continue;
        }
        i++;
    }
    return out.join('');
}

/**
 * Paragraphs = runs of body text between blank lines, outside any environment
 * we already emitted and outside the preamble. Deliberately crude: paragraphs
 * are the object class SyncTeX handles WORST, so Spike A needs them present and
 * approximately right rather than perfect.
 */
function scanParagraphs(src, masked, lineAt, objects, file) {
    const docStart = masked.indexOf('\\begin{document}');
    if (docStart < 0) return [];
    const from = docStart + '\\begin{document}'.length;
    const docEnd = masked.indexOf('\\end{document}', from);
    const to = docEnd < 0 ? src.length : docEnd;

    // Spans already claimed by a block-level object.
    const blocked = objects
        .filter(o => ['display-equation', 'figure', 'table', 'theorem', 'verbatim', 'list', 'tabular', 'abstract', 'environment'].includes(o.kind))
        .map(o => [o.startOffset, o.endOffset])
        .sort((a, b) => a[0] - b[0]);
    const isBlocked = (a, b) => blocked.some(([s, e]) => a < e && b > s);

    const paras = [];
    const re = /\n[ \t]*\n/g;
    re.lastIndex = from;
    let start = from;
    let m;
    const push = (s, e) => {
        while (s < e && /\s/.test(masked[s])) s++;
        while (e > s && /\s/.test(masked[e - 1])) e--;
        if (e - s < 40) return;                       // too short to be prose
        if (isBlocked(s, e)) return;
        const body = masked.slice(s, e);
        if (!/[A-Za-z]{3}/.test(body)) return;        // no words: not a paragraph
        if (/^\s*\\(section|subsection|chapter|part|maketitle|bibliography|appendix|newcommand|def|usepackage)/.test(body)) return;
        paras.push(makeObject({
            kind: 'paragraph', startOffset: s, endOffset: e,
            startLine: lineAt(s), endLine: lineAt(e - 1),
            sectionPath: [], src, file,
        }));
    };
    while ((m = re.exec(masked)) !== null && m.index < to) {
        push(start, m.index);
        start = m.index + m[0].length;
    }
    push(start, to);
    return paras;
}


/**
 * If a macro definition starts at `at`, return the [from, to) span of its BODY.
 *
 * Handles the shapes that occur in practice:
 *   \newcommand{\x}[2][d]{BODY}   \newcommand\x[1]{BODY}
 *   \renewcommand*{\x}{BODY}      \providecommand{\x}{BODY}
 *   \DeclareRobustCommand{\x}{BODY}
 *   \def\x#1#2{BODY}
 * The NAME group and any [..] argument specs are stepped over first, so the
 * body is the last brace group rather than the first.
 */

/**
 * Macros that stand in for \begin{env} / \end{env}.
 *
 * MEASURED on real arXiv sources: physicists routinely define
 *   \newcommand{\beq}{\begin{equation}}   \newcommand{\eeq}{\end{equation}}
 *   \newcommand{\neqa}{\nonumber\end{eqnarray}}
 * and then never write the environment out longhand again. A scanner that does
 * not know this sees a document full of environments that open and never close;
 * on LongPaper.tex that was 3 spurious "no matching \begin" warnings on
 * perfectly correct TeX, which is exactly the kind of noise that gets
 * diagnostics switched off.
 *
 * Only definitions whose body is ONLY structure are honoured — a body that also
 * typesets something is not a pure delimiter and is left alone.
 *
 * @returns {Map<string,{opens:string[],closes:string[]}>} keyed WITHOUT backslash
 */
/**
 * Macros that stand in for \label / \ref / \cite.
 *
 * MEASURED on a real 3 400-line paper: it defines
 *   \newcommand{\la}[1]{\label{#1}}      -- 140 uses
 *   \newcommand{\eq}[1]{(\ref{#1})}      -- 84 uses
 * against 88 literal \label and 261 literal \ref. Without this, a third of the
 * paper's cross-references are invisible: labels that exist are reported
 * missing, and \eq{...} references resolve to nothing.
 *
 * The body may carry literal decoration around the call — `(\ref{#1})` wraps it
 * in parentheses and is still a reference. What disqualifies a macro is doing
 * TWO referential things, or taking no argument to pass through.
 *
 * @returns {Map<string,{cmd:'label'|'ref'|'cite'}>} keyed WITHOUT backslash
 */
function discoverRefMacros(src) {
    const map = new Map();
    // `(?:\[..\]|#\d)*` — \newcommand declares arity as [1] while \def uses TeX
    // parameter text, `\def\lab#1{\label{#1}}`. Allowing only the first form
    // silently skipped every \def-style alias.
    const re = /\\(?:(?:new|renew|provide)command|[egx]?def)\s*\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*(?:\[[^\]]*\]|#\d)*\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const name = m[1] || m[2];
        const open = re.lastIndex - 1;
        const close = matchBrace(src, open);
        if (close < 0) continue;
        const body = src.slice(open + 1, close);

        const calls = [...body.matchAll(/\\(label|ref|eqref|autoref|cref|Cref|cite|citep|citet)\s*\{\s*#(\d)\s*\}/g)];
        if (calls.length !== 1) continue;            // zero, or ambiguous
        const cmd = calls[0][1];
        // The whole body must be that call plus inert decoration; anything that
        // itself opens structure means this is not a plain alias.
        if (/\\(begin|end|newcommand|def)\b/.test(body)) continue;
        map.set(name, {
            cmd: /^(cite|citep|citet)$/.test(cmd) ? 'cite'
                : cmd === 'label' ? 'label' : 'ref',
            via: cmd,
        });
    }
    return map;
}

function discoverEnvMacros(src) {
    const map = new Map();
    // \def as well as \newcommand: LongPaper.tex opens its equations with
    // `\def\be{\begin{eqnarray}}` on line 280 and closes some of them longhand,
    // which is correct TeX that a \newcommand-only discovery reads as three
    // unmatched \end{eqnarray}.
    const re = /\\(?:(?:new|renew|provide)command|[egx]?def)\s*\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*(?:\[[^\]]*\]|#\d)*\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const name = m[1] || m[2];
        const open = re.lastIndex - 1;
        const close = matchBrace(src, open);
        if (close < 0) continue;
        const body = src.slice(open + 1, close);
        const opens = []; const closes = [];
        const envRe = /\\(begin|end)\s*\{([^}\n]+)\}/g;
        let e;
        while ((e = envRe.exec(body)) !== null) {
            (e[1] === 'begin' ? opens : closes).push(e[2].trim());
        }
        if (!opens.length && !closes.length) continue;
        // Strip the structure and anything harmless around it; if real content
        // is left, this macro does more than delimit and we must not fake it.
        const rest = body
            .replace(/\\(begin|end)\s*\{[^}\n]+\}/g, '')
            .replace(/\\(nonumber|noalign|displaystyle|small|footnotesize|centering|label\s*\{[^}]*\})/g, '')
            .replace(/[\s%]/g, '');
        if (rest.length) continue;
        map.set(name, { opens, closes });
    }
    return map;
}

function macroDefinitionBody(src, at) {
    const m = /^\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|newenvironment|renewenvironment|def|edef|gdef|xdef)\b\*?/
        .exec(src.slice(at, at + 40));
    if (!m) return null;
    const isDef = /^(def|edef|gdef|xdef)$/.test(m[1]);
    // \newenvironment takes TWO bodies (begin and end); blanking both is right
    // for the same reason.
    const bodies = /environment$/.test(m[1]) ? 2 : 1;
    let i = at + m[0].length;

    const skipSpace = () => { while (i < src.length && /\s/.test(src[i])) i++; };

    if (isDef) {
        skipSpace();
        if (src[i] !== '\\') return null;
        i++;
        while (i < src.length && /[A-Za-z@]/.test(src[i])) i++;
        // parameter text runs up to the opening brace
        while (i < src.length && src[i] !== '{') {
            if (src[i] === '\n' && src[i + 1] === '\n') return null;   // not a definition after all
            i++;
        }
    } else {
        skipSpace();
        if (src[i] === '{') {
            const close = matchBrace(src, i);
            if (close < 0) return null;
            i = close + 1;
        } else if (src[i] === '\\') {
            i++;
            while (i < src.length && /[A-Za-z@]/.test(src[i])) i++;
        } else return null;
        skipSpace();
        while (src[i] === '[') {
            const close = src.indexOf(']', i);
            if (close < 0) return null;
            i = close + 1;
            skipSpace();
        }
    }

    let from = null; let to = null;
    for (let b = 0; b < bodies; b++) {
        skipSpace();
        if (src[i] !== '{') break;
        const close = matchBrace(src, i);
        if (close < 0) break;
        if (from === null) from = i + 1;
        to = close;
        i = close + 1;
    }
    return from !== null && to > from ? { from, to } : null;
}

/** Index of the next `ch` at or after `from`, skipping only whitespace. */
function skipSpaceTo(s, from, ch) {
    let i = from;
    while (i < s.length && /\s/.test(s[i])) i++;
    return s[i] === ch ? i : -1;
}

function matchBrace(s, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === '{') depth++;
        else if (s[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function stripTex(s) {
    return s
        // A title wrapped across lines ends the first one with `%`, which is a
        // line-continuation comment and not part of the title. Without this,
        // real section names come out as "…Removes the Trivial Line%".
        .replace(/(^|[^\\])%[^\n]*/g, '$1')
        .replace(/\\[A-Za-z]+\s*/g, '')
        .replace(/[{}$]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The preamble: everything from the top of the file down to the line before
 * `\begin{document}`.
 *
 * Worth its own fold because it is where a real paper hides its bulk — the
 * user's 3 432-line draft.tex spends its first 410 lines on packages and macro
 * definitions, none of which is the paper. The fold starts at the first
 * non-blank line so that `\documentclass{...}` stays visible as the header
 * rather than a blank line.
 *
 * @returns {{startLine:number, endLine:number}|null} 1-based, or null when the
 *   file has no \begin{document} (a fragment, an \input-ed section).
 */
function preambleSpan(src) {
    const text = String(src);
    const m = /(^|\n)[ \t]*\\begin\s*\{document\}/.exec(text);
    if (!m) return null;
    const at = m.index + (m[1] ? 1 : 0);
    const endLine = text.slice(0, at).split('\n').length - 1;   // line BEFORE it
    if (endLine < 1) return null;

    const lines = text.split('\n');
    let startLine = 1;
    while (startLine <= endLine && !lines[startLine - 1].trim()) startLine++;
    return endLine > startLine ? { startLine, endLine } : null;
}

/** Objects that occupy vertical space on a page — what Spike A measures. */
const MEASURABLE_KINDS = new Set([
    'display-equation', 'figure', 'table', 'theorem', 'paragraph',
    'section-heading', 'tabular', 'list', 'verbatim', 'abstract',
]);

function summarise(objects) {
    const by = {};
    for (const o of objects) by[o.kind] = (by[o.kind] || 0) + 1;
    return by;
}

module.exports = {
    scanTex,
    MATH_ENVS,
    preambleSpan,
    classifyEnv,
    discoverVerbatimEnvs,
    summarise,
    MEASURABLE_KINDS,
};
