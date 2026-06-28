'use strict';
/**
 * Oberon — SkilXiv skill citation helpers.
 *
 * Produces a "Skills used" markdown block for the working/clean notebooks: the
 * recalled skill(s), a link to the skill page, a one-line usefulness conclusion, and
 * a suggested citation (inline + BibTeX) so a user can cite the skill in a paper.
 *
 * Pure functions — no vscode / fs dependency, unit-testable.
 */

/**
 * Parse a SkilXiv skill ref like "@namespace/name@version" (version optional).
 * @param {string} ref
 * @returns {{ namespace: string, name: string, version: string|null }}
 */
function parseSkillRef(ref) {
    const s = String(ref || '').trim();
    const m = s.match(/^@?([^/]+)\/([^@]+)(?:@(.+))?$/);
    if (!m) return { namespace: '', name: s.replace(/^@/, ''), version: null };
    return { namespace: m[1], name: m[2], version: m[3] || null };
}

/**
 * Build the public skill-page URL. The /n/ route uses the bare namespace (no '@').
 * @param {string} baseUrl
 * @param {string} ref
 * @returns {string}
 */
function skillPageUrl(baseUrl, ref) {
    const { namespace, name } = parseSkillRef(ref);
    const base = String(baseUrl || 'https://skilxiv.org').replace(/\/+$/, '');
    return `${base}/n/${namespace}/${name}`;
}

function _bibKey(ref) {
    const { namespace, name } = parseSkillRef(ref);
    return `skilxiv_${namespace}_${name}`.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * One-line usefulness conclusion derived from how the skill was used.
 * @param {{ used: boolean, outcome?: string }} info
 * @returns {string}
 */
function usefulnessConclusion({ used, outcome }) {
    if (used && outcome === 'used_reproduced') {
        return 'Useful — its method was applied and the result was reproduced (verified on a fresh kernel).';
    }
    if (used) return 'Useful — its method was applied during the derivation.';
    return 'Consulted for reference; not directly applied in the final derivation.';
}

/**
 * Build the "Skills used" markdown block.
 *
 * @param {{
 *   skills: Array<{ ref: string, used: boolean, outcome?: string, conclusion?: string }>,
 *   baseUrl?: string,
 *   accessedDate?: string,   // ISO date; defaults to today
 * }} args
 * @returns {string}  markdown, or '' when no skills.
 */
function buildSkillsUsedMarkdown({ skills, baseUrl = 'https://skilxiv.org', accessedDate, runReport } = {}) {
    const list = (skills || []).filter(s => s && s.ref);
    if (!list.length) return '';
    const date = accessedDate || new Date().toISOString().slice(0, 10);

    const lines = ['## Skills used', '',
        'This derivation drew on the following [SkilXiv](https://skilxiv.org) skill(s):', ''];

    for (const s of list) {
        const url = skillPageUrl(baseUrl, s.ref);
        const concl = s.conclusion || usefulnessConclusion({ used: s.used, outcome: s.outcome });
        lines.push(`- **\`${s.ref}\`** — [skill page](${url})`);
        lines.push(`  - ${concl}`);
    }
    lines.push('');

    if (runReport && String(runReport).trim()) {
        lines.push('**This run\'s report:**', '', `> ${String(runReport).trim()}`, '');
    }

    // Suggested citation (inline + BibTeX) for the FIRST/primary skill.
    const primary = list[0];
    const { name, version } = parseSkillRef(primary.ref);
    const url = skillPageUrl(baseUrl, primary.ref);
    lines.push('### Suggested citation', '',
        'If this skill helped your work, please cite it:', '',
        `> *${name}*${version ? ` (v${version})` : ''}. SkilXiv — Executable Knowledge Commons. \`${primary.ref}\`. ${url} (accessed ${date}).`,
        '',
        '```bibtex',
        `@misc{${_bibKey(primary.ref)},`,
        `  title        = {${name}},`,
        `  howpublished = {SkilXiv skill \\texttt{${primary.ref}}},`,
        `  year         = {${date.slice(0, 4)}},`,
        `  url          = {${url}},`,
        `  note         = {Accessed ${date}}`,
        '}',
        '```');

    return lines.join('\n');
}

/**
 * Build a "Literature consulted" markdown block from literature briefs. Lists the
 * papers the literature sub-agent surfaced, with a BibTeX entry per paper. Equations
 * are NOT reproduced here — they are reproduced and recorded in the chain itself.
 *
 * @param {Array<{ question?:string, papers?:Array<object> }>} briefs
 * @returns {string}  markdown, or '' when there is no literature.
 */
function buildLiteratureCitations(briefs) {
    const all = Array.isArray(briefs) ? briefs : [];
    // Dedupe papers across briefs by ref/title.
    const seen = new Map();
    for (const b of all) {
        for (const p of (b && b.papers) || []) {
            const key = String(p.ref || p.title || '').trim();
            if (key && !seen.has(key)) seen.set(key, p);
        }
    }
    const papers = [...seen.values()];
    if (!papers.length) return '';

    const lines = ['## Literature consulted', '',
        'The following papers were surfaced by the literature sub-agent. Any equation taken ' +
        'from them was reproduced in the kernel before use — see the derivation chain above.', ''];

    for (const p of papers) {
        const authors = (p.authors || []).slice(0, 4).join(', ');
        const yr = p.year ? ` (${p.year})` : '';
        const linkBits = [];
        if (p.arxivId) linkBits.push(`[arXiv:${p.arxivId}](https://arxiv.org/abs/${p.arxivId})`);
        if (p.doi)     linkBits.push(`[doi](https://doi.org/${p.doi})`);
        if (p.inspireId) linkBits.push(`[INSPIRE](https://inspirehep.net/literature/${p.inspireId})`);
        const links = linkBits.length ? ` — ${linkBits.join(' · ')}` : '';
        lines.push(`- **${p.title || '(untitled)'}**${yr}${authors ? ` — ${authors}` : ''}${links}`);
    }
    lines.push('');

    lines.push('```bibtex');
    for (const p of papers) {
        const key = (p.texkey || p.arxivId || p.ref || p.title || 'paper').replace(/[^A-Za-z0-9_]/g, '_');
        lines.push(`@article{${key},`);
        if (p.title)   lines.push(`  title   = {${p.title}},`);
        if ((p.authors || []).length) lines.push(`  author  = {${p.authors.join(' and ')}},`);
        if (p.year)    lines.push(`  year    = {${p.year}},`);
        if (p.arxivId) lines.push(`  eprint  = {${p.arxivId}},`);
        if (p.arxivId) lines.push(`  archivePrefix = {arXiv},`);
        if (p.doi)     lines.push(`  doi     = {${p.doi}},`);
        lines.push('}');
    }
    lines.push('```');

    return lines.join('\n');
}

/**
 * Build a LIVE summary cell for working.wb when a literature search completes —
 * what was searched/read, the relevant papers with WHY, the extracted key relations
 * and observations (flagged unverified), and what was read-and-rejected.
 *
 * @param {object} brief  the literature brief from literature.runResearch
 * @returns {string} markdown (empty string if no brief)
 */
function buildLiteratureBriefMarkdown(brief) {
    if (!brief || !brief.question) return '';
    const d = brief.diagnostics || {};
    const papers   = brief.papers || [];
    const eqs      = brief.key_equations || [];
    const obs      = brief.observations || [];
    const rejected = (brief.considered || []).filter(c => !c.relevant);

    const lines = [`## 📚 Literature: ${brief.question}`, ''];
    lines.push(`_searched ${d.searched || 0} · read ${d.read || 0} (full text ${d.fullText || 0}) · **${papers.length} relevant**_`, '');

    if (!papers.length) {
        lines.push(brief.note ? `> ${brief.note}` : '> No relevant papers found — proceeding with direct derivation.', '');
    } else {
        lines.push('**Relevant papers**');
        for (const p of papers) {
            const yr = p.year ? `, ${p.year}` : '';
            lines.push(`- **${p.title || '(untitled)'}** (${p.ref}${yr})${p.fullText ? '' : ' _[abstract only]_'}` + (p.reason ? ` — ${p.reason}` : ''));
        }
        lines.push('');
        if (eqs.length) {
            lines.push('**Key relations** _(UNVERIFIED — reproduce in the kernel before recording)_');
            for (const e of eqs.slice(0, 12)) {
                const s = e.statement ? `${e.statement} — ` : '';
                const l = e.latex ? `\`${e.latex}\`` : '';
                lines.push(`- ${s}${l}${e.source ? ` _(${e.source})_` : ''}`);
            }
            lines.push('');
        }
        if (obs.length) {
            lines.push('**Observations**');
            for (const o of obs.slice(0, 8)) lines.push(`- ${o.text}${o.source ? ` _(${o.source})_` : ''}`);
            lines.push('');
        }
    }
    if (rejected.length) {
        lines.push(`**Read & rejected (${rejected.length})**`);
        for (const r of rejected.slice(0, 6)) lines.push(`- ${r.title || r.ref} — ${r.reason || 'not relevant'}`);
    }
    return lines.join('\n').trim();
}

module.exports = { parseSkillRef, skillPageUrl, usefulnessConclusion, buildSkillsUsedMarkdown, buildLiteratureCitations, buildLiteratureBriefMarkdown };
