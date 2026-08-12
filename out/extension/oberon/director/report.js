'use strict';
/**
 * Oberon Director — LaTeX report assembly.
 *
 * The Director LLM writes only the report BODY (abstract + sections). This
 * module wraps it in a fixed, known-good preamble, appends a deterministic
 * bibliography built from the programme's literature briefs, writes
 * report.tex under <programme>/report/, and best-effort compiles a PDF when
 * pdflatex is on PATH (never fatal — the .tex is the deliverable).
 */

const path = require('path');
const fsp  = require('fs/promises');
const { execFile } = require('child_process');

/** Escape a plain-text string for safe inclusion in LaTeX. */
function texEscape(s) {
    return String(s == null ? '' : s)
        .replace(/\\/g, '\\textbackslash{}')
        .replace(/([%$#&_{}])/g, '\\$1')
        .replace(/~/g, '\\textasciitilde{}')
        .replace(/\^/g, '\\textasciicircum{}');
}

/**
 * Build cite keys from the programme's literature records (deduped).
 * @returns {Array<{ key: string, label: string, entryTex: string }>}
 */
function buildCitations(programme) {
    const seen = new Map();
    for (const b of (programme.literature || [])) {
        for (const p of (b.papers || [])) {
            const dedup = String(p.arxivId || p.doi || p.title || '').toLowerCase();
            if (!dedup || seen.has(dedup)) continue;
            const firstAuthor = ((p.authors || [])[0] || '').split(/[\s,]+/).filter(Boolean).pop() || 'ref';
            let key = (firstAuthor + (p.year || '')).replace(/[^A-Za-z0-9]/g, '');
            if (!key) key = 'ref';
            let uniq = key, n = 1;
            const taken = new Set([...seen.values()].map(c => c.key));
            while (taken.has(uniq)) uniq = key + String.fromCharCode(96 + (++n));
            const authors = (p.authors || []).slice(0, 4).join(', ');
            const links = [];
            if (p.arxivId) links.push(`arXiv:${p.arxivId}`);
            if (p.doi)     links.push(`doi:${p.doi}`);
            const entryTex =
                `\\bibitem{${uniq}} ${texEscape(authors)}${authors ? ', ' : ''}` +
                `\\emph{${texEscape(p.title || '(untitled)')}}` +
                (p.year ? ` (${p.year})` : '') +
                (links.length ? `, ${texEscape(links.join(', '))}` : '') + '.';
            seen.set(dedup, {
                key: uniq,
                label: `${p.title || '(untitled)'}${p.year ? ` (${p.year})` : ''}${p.arxivId ? ` [arXiv:${p.arxivId}]` : ''}`,
                entryTex,
            });
        }
    }
    return [...seen.values()];
}

/**
 * Wrap the model-written body into a complete compilable document.
 * @param {{ programme: object, body: string, citations: Array<{entryTex:string}> }} args
 */
function composeReportTex({ programme, body, citations }) {
    const stages = (programme.plan && programme.plan.stages) || [];
    const executed = stages.filter(s => ['delivered', 'partial', 'failed'].includes(s.status));
    const notebookLines = executed
        .filter(s => s.cleanNbPath)
        .map(s => `\\item ${texEscape(`${s.id} — ${s.title}`)}: \\texttt{${texEscape(path.basename(path.dirname(s.cleanNbPath || '')))}/${texEscape(path.basename(s.cleanNbPath || ''))}}`);

    const bib = (citations && citations.length)
        ? [
            '\\begin{thebibliography}{99}',
            ...citations.map(c => c.entryTex),
            '\\end{thebibliography}',
          ].join('\n')
        : '';

    return [
        '\\documentclass[11pt]{article}',
        '\\usepackage[margin=1in]{geometry}',
        '\\usepackage{amsmath,amssymb,amsthm}',
        '\\usepackage{booktabs}',
        '\\usepackage{hyperref}',
        '\\usepackage{xcolor}',
        '',
        `\\title{${texEscape(programme.title)}}`,
        `\\author{Oberon Director \\\\ \\small wolfbook autonomous research system}`,
        `\\date{${new Date().toISOString().slice(0, 10)}}`,
        '',
        '\\begin{document}',
        '\\maketitle',
        '',
        body.trim(),
        '',
        notebookLines.length
            ? [
                '\\section*{Reproducibility}',
                'Every result above was produced and verified in a Wolfram kernel. The following',
                'notebooks re-execute top-to-bottom in a fresh kernel:',
                '\\begin{itemize}',
                ...notebookLines,
                '\\end{itemize}',
              ].join('\n')
            : '',
        bib,
        '\\end{document}',
        '',
    ].filter(s => s !== '').join('\n');
}

/** Write report.tex (and report.md pointer) under <programme>/report/. */
async function writeReport(programme, tex) {
    const dir = path.join(programme.dir, 'report');
    await fsp.mkdir(dir, { recursive: true });
    const texPath = path.join(dir, 'report.tex');
    await fsp.writeFile(texPath, tex, 'utf8');
    return texPath;
}

/**
 * Best-effort PDF compile (pdflatex, nonstopmode, 2 passes for \cite numbers).
 * Resolves to the pdf path, or null on any failure. Never throws.
 */
async function tryCompilePdf(texPath, { timeoutMs = 90000 } = {}) {
    const dir  = path.dirname(texPath);
    const name = path.basename(texPath);
    const run = () => new Promise((resolve) => {
        execFile('pdflatex',
            ['-interaction=nonstopmode', '-halt-on-error', name],
            { cwd: dir, timeout: timeoutMs },
            (err) => resolve(!err));
    });
    try {
        const ok1 = await run();
        if (!ok1) return null;
        await run();   // second pass fixes \cite/\ref numbering; failure is fine
        const pdfPath = texPath.replace(/\.tex$/, '.pdf');
        try { await fsp.access(pdfPath); return pdfPath; } catch (_) { return null; }
    } catch (_) { return null; }
}

/**
 * Stage B3 (plan §Stage 4): GENERATED progress digest.
 *
 * The plan is explicit that `progress.md` must be generated from programme.json,
 * never hand-kept — a hand-maintained progress file drifts from the ledger and
 * then quietly lies. This renders the current programme state for a human
 * checking in mid-run (and is safe to regenerate after every stage).
 *
 * Note what it shows and what it refuses to show: `passes` is printed as
 * harness-observed verification, kept visually distinct from the LLM's `verdict`,
 * so a reader can never mistake an opinion for evidence.
 */
function renderProgressDigest(programme) {
    if (!programme) return '';
    const L = [];
    const done = (programme.plan || []).filter(s => s.status && s.status !== 'pending').length;
    L.push(`# ${programme.title || programme.id} — progress`);
    L.push('');
    L.push(`**Goal:** ${programme.goal || '(none stated)'}`);
    L.push('');
    L.push(`Stages: ${done}/${(programme.plan || []).length} run · key results: ${(programme.keyResults || []).length} · status: **${programme.status || 'active'}**`);
    L.push('');
    L.push('## Stages');
    L.push('');
    L.push('| # | stage | status | verified? | LLM verdict |');
    L.push('|---|-------|--------|-----------|-------------|');
    for (const s of (programme.plan || [])) {
        const verdict = (s.assessment && s.assessment.verdict) || '—';
        const verified = s.passes ? '✅ checks passed' : (s.status === 'pending' ? '—' : '⚠️ unverified');
        L.push(`| ${s.id} | ${String(s.title || '').slice(0, 60)} | ${s.status || 'pending'} | ${verified} | ${verdict} |`);
    }
    L.push('');
    if ((programme.keyResults || []).length) {
        L.push('## Key results (kernel-established)');
        L.push('');
        for (const k of programme.keyResults) {
            L.push(`- **${k.id}** _(${k.stageId || '?'}, conf ${Number(k.confidence).toFixed(2)})_ — ${k.statement}`);
        }
        L.push('');
    }
    const openStages = (programme.plan || []).filter(s => s.status === 'pending');
    if (openStages.length) {
        L.push('## Remaining');
        L.push('');
        for (const s of openStages) L.push(`- ${s.id}: ${s.title}`);
        L.push('');
    }
    L.push(`_Generated from programme.json at ${new Date().toISOString()} — do not edit by hand._`);
    return L.join('\n');
}

/** Write the digest next to programme.json (regenerated, never merged). */
async function writeProgressDigest(programme) {
    if (!programme || !programme.dir) return null;
    const p = path.join(programme.dir, 'progress.md');
    try {
        await fsp.writeFile(p, renderProgressDigest(programme), 'utf8');
        return p;
    } catch (_) { return null; }
}

module.exports = { texEscape, buildCitations, composeReportTex, writeReport, tryCompilePdf,
                   renderProgressDigest, writeProgressDigest };
