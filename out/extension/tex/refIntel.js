// refIntel.js — what a cross-reference actually points at.
//
// `\eqref{eq:inversion-transpose}` tells you nothing on its own. What a writer
// wants to know, without leaving the line they are on, is: which equation is
// that, what number did it come out as, what page is it on, and what does it
// say. All four are already known — the model has the object, the `.aux` has
// the number and the page — they were simply never joined up.
//
// PURE: the caret is a (line, column), the answer is data. The vscode-shaped
// Hover/Definition/Reference providers in index.js are thin shells over this,
// which is what makes the resolution testable without a window.

/** The commands a cross-reference can be written with. */
const REF_CMDS = /\\(eq)?ref|\\autoref|\\cref|\\Cref|\\pageref|\\cite[a-zA-Z]*/;

/**
 * The `\ref`-like or `\cite`-like command the caret is inside, if any.
 *
 * Scans the LINE rather than the model, because a caret sitting in the middle
 * of `\eqref{eq:foo}` is a position, not an object — and because the model's
 * ref objects do not carry columns. Handles a multi-key `\cite{a,b,c}` by
 * returning the key the caret is actually in: hovering `b` should not answer
 * about `a`.
 *
 * @param {string} lineText
 * @param {number} column
 * @returns {{cmd:string, name:string, kind:'ref'|'cite'|'label',
 *            start:number, end:number, nameStart:number, nameEnd:number}|null}
 */
function refAt(lineText, column) {
    const text = String(lineText || '');
    const re = /\\([a-zA-Z]+)\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(text))) {
        const cmd = m[1];
        const kind = /^cite/.test(cmd) ? 'cite'
            : cmd === 'label' ? 'label'
                : /^(eqref|ref|autoref|cref|Cref|pageref|nameref|vref)$/.test(cmd) ? 'ref'
                    : null;
        if (!kind) continue;
        const start = m.index;
        const end = m.index + m[0].length;
        // Half-open, so a caret at the closing brace still belongs to it but a
        // caret just past does not.
        if (column < start || column > end) continue;
        const argStart = m.index + m[0].indexOf('{') + 1;
        const arg = m[2];
        // \cite{a,b,c}: which key is the caret in?
        let nameStart = argStart;
        let nameEnd = argStart + arg.length;
        let name = arg.trim();
        if (kind === 'cite' && arg.includes(',')) {
            let at = argStart;
            for (const part of arg.split(',')) {
                const partEnd = at + part.length;
                if (column <= partEnd || partEnd === argStart + arg.length) {
                    nameStart = at; nameEnd = partEnd; name = part.trim();
                    break;
                }
                at = partEnd + 1;
            }
        }
        return { cmd, kind, name, start, end, nameStart, nameEnd };
    }
    return null;
}

/** Trim a source fragment to something worth putting in a hover. */
function trimSource(text, maxLines = 12) {
    const lines = String(text || '').replace(/\s+$/, '').split('\n');
    if (lines.length <= maxLines) return lines.join('\n');
    return lines.slice(0, maxLines).join('\n') + `\n…(${lines.length - maxLines} more lines)`;
}

/** A one-line description of what a label is attached to. */
function describeOwner(obj) {
    if (!obj) return 'label';
    switch (obj.kind) {
        case 'display-equation': return 'equation';
        case 'figure': return 'figure';
        case 'table': case 'tabular': return 'table';
        case 'theorem': return obj.envName || 'theorem';
        case 'section-heading': return obj.cmd || 'section';
        default: return obj.kind || 'object';
    }
}

/**
 * Everything known about the reference under the caret.
 *
 * @param {{
 *   ref: ReturnType<typeof refAt>,
 *   objects: Array<object>,
 *   printedFor?: (name:string) => {printed?:string, page?:number}|null,
 *   citeFor?: (name:string) => {printed?:string}|null,
 *   bibEntry?: (key:string) => string|null,
 *   sourceOf?: (obj:object) => string|null,
 * }} o
 * @returns {{kind, name, printed, page, owner, ownerKind, source, bib,
 *            target:{file,startLine,endLine}|null, resolved:boolean,
 *            uses:Array<{cmd:string,line:number}>}|null}
 */
function resolveRef(o) {
    const { ref, objects = [], printedFor = null, citeFor = null,
        bibEntry = null, sourceOf = null } = o || {};
    if (!ref || !ref.name) return null;

    const uses = [];
    for (const x of objects) {
        if (x.kind !== 'ref' && x.kind !== 'cite') continue;
        const targets = String(x.target || '').split(',').map(t => t.trim());
        if (!targets.includes(ref.name)) continue;
        uses.push({ cmd: x.cmd, line: x.sourceRange ? x.sourceRange.startLine : x.startLine });
    }

    if (ref.kind === 'cite') {
        const printed = citeFor ? (citeFor(ref.name) || {}).printed || '' : '';
        const bib = bibEntry ? bibEntry(ref.name) : null;
        return {
            kind: 'cite', name: ref.name, printed, page: null,
            owner: null, ownerKind: 'citation', source: null,
            bib: bib ? trimSource(bib, 16) : null,
            target: null, resolved: !!bib, uses,
        };
    }

    // The declaration: the standalone `label` object carries the exact line the
    // \label sits on; the OWNER is the thing that will actually be jumped to.
    const decl = objects.find(x => x.kind === 'label' && x.name === ref.name) || null;
    const owner = objects.find(x => x.label === ref.name && x.kind !== 'label') || null;
    const info = printedFor ? printedFor(ref.name) || {} : {};
    const jump = owner || decl;
    return {
        kind: 'ref', name: ref.name,
        printed: info.printed || '',
        page: Number.isFinite(info.page) ? info.page : null,
        owner: owner ? (owner.title || owner.label || '') : '',
        ownerKind: describeOwner(owner),
        source: owner && sourceOf ? trimSource(sourceOf(owner)) : null,
        bib: null,
        target: jump && jump.sourceRange ? {
            file: jump.sourceRange.file,
            startLine: jump.sourceRange.startLine,
            endLine: jump.sourceRange.endLine,
        } : null,
        resolved: !!(decl || owner),
        uses,
    };
}

/**
 * The hover text, as markdown.
 *
 * States what is KNOWN and stays quiet about what is not: with no `.aux` there
 * is no number, and inventing one — or saying "unknown" in three places — is
 * worse than a shorter hover.
 */
function hoverMarkdown(r) {
    if (!r) return '';
    const out = [];
    if (r.kind === 'cite') {
        const head = r.printed ? `**\\cite{${r.name}}** → [${r.printed}]` : `**\\cite{${r.name}}**`;
        out.push(r.resolved ? head : `${head} — not in the bibliography`);
        if (r.bib) out.push('```bibtex\n' + r.bib + '\n```');
    } else if (!r.resolved) {
        out.push(`**${r.name}** — no \\label with that name in this file.`);
    } else {
        const bits = [`**${r.ownerKind}** \`${r.name}\``];
        if (r.printed) bits.push(`→ **${r.printed}**`);
        if (r.page) bits.push(`· p.${r.page}`);
        out.push(bits.join(' '));
        if (r.owner) out.push(`*${r.owner}*`);
        if (r.source) out.push('```latex\n' + r.source + '\n```');
    }
    if (r.uses.length) {
        out.push(`${r.uses.length} reference${r.uses.length === 1 ? '' : 's'}: ` +
            r.uses.slice(0, 8).map(u => `line ${u.line}`).join(', ') +
            (r.uses.length > 8 ? ', …' : ''));
    }
    return out.join('\n\n');
}

module.exports = { refAt, resolveRef, hoverMarkdown, trimSource, describeOwner, REF_CMDS };
