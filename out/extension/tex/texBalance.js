// texBalance.js — a fragment you can move without breaking the file.
//
// Moving a piece of LaTeX is a cut and a paste, and a cut that lands inside a
// construct produces two broken halves. Reported: dragging a run-in paragraph
// moved "only the text after the title", because the selection began after
// `\paragraph{…}` and the command stayed where it was, orphaned.
//
// So a range is WIDENED until it is something a reader would recognise as a
// whole: braces balanced, no half a command, no `\begin` without its `\end`.
// The rule is deliberately one-directional — a fragment only ever grows, never
// shrinks — because a reader who selected too little meant the thing they were
// pointing at, while a reader who selected too much meant what they selected.
//
// PURE, offset-based, no vscode. The scanner's own masking is not reused on
// purpose: this must work on an arbitrary substring of a document, including
// one that starts in the middle of a construct, which is exactly the case a
// document-wide parse is least able to describe.

/** Positions of the comment characters, so `%` is never counted as content. */
function commentMask(text) {
    const mask = new Uint8Array(text.length);
    let inComment = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\n') { inComment = false; continue; }
        if (inComment) { mask[i] = 1; continue; }
        if (c === '\\') { i++; continue; }            // \% is not a comment
        if (c === '%') { inComment = true; mask[i] = 1; }
    }
    return mask;
}

/** The `{` that matches the `}` at `i`, or -1. */
function openFor(text, mask, i) {
    let depth = 0;
    for (let k = i; k >= 0; k--) {
        if (mask[k] || (k > 0 && text[k - 1] === '\\')) continue;
        if (text[k] === '}') depth++;
        else if (text[k] === '{') { depth--; if (depth === 0) return k; }
    }
    return -1;
}

/** The `}` that matches the `{` at `i`, or -1. */
function closeFor(text, mask, i) {
    let depth = 0;
    for (let k = i; k < text.length; k++) {
        if (mask[k] || (k > 0 && text[k - 1] === '\\')) continue;
        if (text[k] === '{') depth++;
        else if (text[k] === '}') { depth--; if (depth === 0) return k; }
    }
    return -1;
}

/**
 * Pull `from` back over the control word (and any `[options]`) that owns the
 * brace group starting there — `\paragraph{…}` must move with its argument,
 * and `\begin{figure}` with its `\begin`.
 */
function commandStart(text, mask, from) {
    let i = from - 1;
    // `[a,b]` between the command and its group.
    if (text[i] === ']') {
        let depth = 0;
        for (; i >= 0; i--) {
            if (mask[i]) continue;
            if (text[i] === ']') depth++;
            else if (text[i] === '[') { depth--; if (depth === 0) { i--; break; } }
        }
    }
    while (i >= 0 && /[ \t]/.test(text[i])) i--;
    let end = i;
    while (i >= 0 && /[A-Za-z@*]/.test(text[i])) i--;
    if (i >= 0 && text[i] === '\\' && end > i) return i;
    return from;
}

/**
 * The smallest range containing [from, to) that is not broken.
 *
 * @param {string} text  the whole document
 * @param {number} from  offset, inclusive
 * @param {number} to    offset, exclusive
 * @param {{maxRounds?:number}} [opts]
 * @returns {{from:number, to:number, widened:boolean, reason:string|null}}
 */
function balanceRange(text, from, to, opts = {}) {
    const src = String(text || '');
    const mask = commentMask(src);
    let a = Math.max(0, Math.min(from | 0, src.length));
    let b = Math.max(a, Math.min(to | 0, src.length));
    const a0 = a;
    const b0 = b;
    let reason = null;
    const rounds = opts.maxRounds || 8;

    for (let round = 0; round < rounds; round++) {
        let moved = false;

        // 1. An unmatched `}` inside the range: its `{` is outside, to the left.
        let depth = 0;
        let needOpen = -1;
        for (let i = a; i < b; i++) {
            if (mask[i] || (i > 0 && src[i - 1] === '\\')) continue;
            if (src[i] === '{') depth++;
            else if (src[i] === '}') {
                depth--;
                if (depth < 0) { needOpen = i; break; }
            }
        }
        if (needOpen >= 0) {
            const open = openFor(src, mask, needOpen);
            if (open >= 0 && open < a) {
                a = commandStart(src, mask, open);
                reason = reason || 'a brace group began before it';
                moved = true;
            }
        }

        // 2. An unclosed `{`: its `}` is outside, to the right.
        if (!moved) {
            depth = 0;
            let needClose = -1;
            for (let i = b - 1; i >= a; i--) {
                if (mask[i] || (i > 0 && src[i - 1] === '\\')) continue;
                if (src[i] === '}') depth++;
                else if (src[i] === '{') {
                    depth--;
                    if (depth < 0) { needClose = i; break; }
                }
            }
            if (needClose >= 0) {
                const close = closeFor(src, mask, needClose);
                if (close >= b) { b = close + 1; reason = reason || 'a brace group ended after it'; moved = true; }
            }
        }

        // 3. A command whose argument the range starts inside — the commonest
        //    case, and the reported one: `\paragraph{` before it, `sdfsdf}`
        //    inside. Covered by 1, but also when the range begins exactly at the
        //    argument with no stray `}`: pull back over a bare control word.
        if (!moved && a > 0 && src[a - 1] === '{') {
            // The BRACE's own position, not the position after it: the command
            // name sits before the brace, and handing this the argument's start
            // makes it look at the brace itself and find no name.
            const start = commandStart(src, mask, a - 1);
            if (start < a - 1) {
                a = start;
                reason = reason || 'it began inside a command';
                moved = true;
            }
        }

        // 4. `\begin{env}` / `\end{env}` must travel together.
        if (!moved) {
            const inner = src.slice(a, b);
            const re = /\\(begin|end)\s*\{([^}]*)\}/g;
            const stack = [];
            let dangling = null;
            let m;
            while ((m = re.exec(inner))) {
                if (m[1] === 'begin') stack.push(m);
                else if (stack.length) stack.pop();
                else { dangling = m; break; }         // an \end with no \begin
            }
            if (dangling) {
                const name = dangling[2];
                const before = src.lastIndexOf(`\\begin{${name}}`, a);
                if (before >= 0) { a = before; reason = reason || 'an environment began before it'; moved = true; }
            } else if (stack.length) {
                const name = stack[stack.length - 1][2];
                const after = src.indexOf(`\\end{${name}}`, b);
                if (after >= 0) { b = after + `\\end{${name}}`.length; reason = reason || 'an environment ended after it'; moved = true; }
            }
        }

        if (!moved) break;
    }

    return { from: a, to: b, widened: a !== a0 || b !== b0, reason };
}

module.exports = { balanceRange, commentMask, openFor, closeFor, commandStart };
