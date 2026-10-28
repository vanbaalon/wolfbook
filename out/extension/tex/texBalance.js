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
    while (i >= 0 && /[ \t]/.test(text[i])) i--;
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

/** Matched delimiter spans, including commands whose spelling is not ink. */
function matchedDelimiters(src, mask) {
    const pairs = [], stacks = new Map();
    const pair = (kind, token, closing = false) => {
        const stack = stacks.get(kind) || [];
        stacks.set(kind, stack);
        if (!closing) stack.push(token);
        else if (stack.length) pairs.push([stack.pop(), token]);
    };
    const envs = [];
    let math = null;
    for (let i = 0; i < src.length; i++) {
        if (mask[i]) continue;
        const start = i, c = src[i];
        if (c === '\\') {
            const command = /^\\(?:[A-Za-z@]+|[^])/s.exec(src.slice(i));
            if (!command) continue;
            const name = command[0].slice(1);
            i += command[0].length - 1;
            if (name === 'verb') {
                if (src[i + 1] === '*') i++;
                const delimiter = src[++i];
                const end = src.indexOf(delimiter, i + 1);
                if (end >= 0) i = end;
            } else if (name === 'begin' || name === 'end') {
                const arg = /^\s*\{([^{}]+)\}/.exec(src.slice(i + 1));
                if (!arg) continue;
                i += arg[0].length;
                const token = { start, end: i + 1 };
                if (name === 'begin') {
                    if (/^(?:verbatim\*?|lstlisting|minted)$/.test(arg[1])) {
                        const endRe = new RegExp('\\\\end\\s*\\{' + arg[1].replace('*', '\\*') + '\\}', 'g');
                        endRe.lastIndex = i + 1;
                        const end = endRe.exec(src);
                        if (end) {
                            pairs.push([token, { start: end.index, end: endRe.lastIndex }]);
                            i = endRe.lastIndex - 1;
                            continue;
                        }
                    }
                    envs.push({ name: arg[1], token });
                } else if (envs.length && envs[envs.length - 1].name === arg[1]) {
                    pairs.push([envs.pop().token, token]);
                }
            } else if (name === 'left' || name === 'right') {
                // A delimiter can be one character, '.', or a control word.
                const delimiter = /^\s*(?:\\(?:[A-Za-z@]+|[^])|[^\s])/s.exec(src.slice(i + 1));
                if (delimiter) i += delimiter[0].length;
                pair('left', { start, end: i + 1 }, name === 'right');
            } else if ('()[]'.includes(name) && name.length === 1) {
                pair(name === '(' || name === ')' ? 'inline' : 'display',
                    { start, end: i + 1 }, name === ')' || name === ']');
            }
            // Escaped literal braces/parentheses and control words aren't
            // structural characters. Their arguments are scanned normally.
            continue;
        }
        if (c === '$') {
            const size = src[i + 1] === '$' ? 2 : 1;
            const token = { start, end: start + size };
            if (math && math.size === size) { pairs.push([math.token, token]); math = null; }
            else if (!math) math = { size, token };
            i += size - 1;
            continue;
        }
        const opening = '{[('.includes(c), closing = '}])'.includes(c);
        if (opening || closing) {
            const kind = closing ? '{[('['}])'.indexOf(c)] : c;
            pair(kind, { start, end: start + 1 }, closing);
        }
    }
    return pairs;
}

/**
 * The smallest range containing [from, to) with no half of a matched
 * delimiter, plus directly attached sentence/phrase punctuation. A body
 * wholly inside a construct stays a body; selecting either edge brings its
 * partner along. Only grows, and ignores comments and escaped delimiters.
 */
function balanceRange(text, from, to, opts = {}) {
    const src = String(text || '');
    const mask = commentMask(src);
    const pairs = matchedDelimiters(src, mask);
    let a = Math.max(0, Math.min(from | 0, src.length));
    let b = Math.max(a, Math.min(to | 0, src.length));
    const a0 = a, b0 = b;
    let reason = null;
    if (a === b) return { from: a, to: b, widened: false, reason };
    // Each growing pass consumes at least one previously excluded boundary.
    // No arbitrary depth limit: nested constructs must all stay balanced.
    const rounds = opts.maxRounds || pairs.length * 2 + 2;
    for (let round = 0; round < rounds; round++) {
        const beforeA = a, beforeB = b;
        for (const [open, close] of pairs) {
            const hasOpen = open.start < b && open.end > a;
            const hasClose = close.start < b && close.end > a;
            if (!hasOpen && !hasClose) continue;
            const left = open.start;
            const right = close.end;
            if (hasOpen !== hasClose || a > left || b < right) {
                a = Math.min(a, left);
                b = Math.max(b, right);
                if (src[left] === '{') a = Math.min(a, commandStart(src, mask, left));
                reason = reason || 'matched delimiters';
            }
        }
        // The visible argument of a command omits both non-printing braces.
        if (a > 0 && src[a - 1] === '{' && !mask[a - 1]) {
            const start = commandStart(src, mask, a - 1);
            if (start < a - 1) { a = start; reason = reason || 'a command argument'; }
        }
        // Even a complete brace group must take its owning control word.
        if (src[a] === '{' && !mask[a]) {
            const start = commandStart(src, mask, a);
            if (start < a) { a = start; reason = reason || 'a command argument'; }
        }
        const punctuation = /^[.,;:!?…]+/.exec(src.slice(b));
        if (punctuation && !mask[b] && b > a && !/\s/.test(src[b - 1])) {
            const end = b + punctuation[0].length;
            // A dot in 1.25 or a filename is part of its token, not a
            // sentence terminator. Never cross whitespace to find punctuation.
            if (end === src.length || /[\s\])}\\$'"”’]/.test(src[end])) {
                b = end;
                reason = reason || 'trailing punctuation';
            }
        }
        if (a === beforeA && b === beforeB) break;
    }
    return { from: a, to: b, widened: a !== a0 || b !== b0, reason };
}

module.exports = { balanceRange, commentMask, openFor, closeFor, commandStart };
