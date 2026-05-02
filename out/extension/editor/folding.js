'use strict';

/**
 * Wolfram Language FoldingRangeProvider.
 *
 * Two kinds of fold regions:
 *
 * 1. Bracket folds — any bracket pair spanning >1 line: ( ) [ ] { } [[ ]] <| |> (* *)
 *
 * 2. Chunk folds — a top-level sub-expression (as defined by the kernel chunk splitter)
 *    that spans multiple lines gets folded as a unit. The first line stays visible;
 *    the remaining lines are hidden.  Example:
 *
 *      F[u_] = a + b +    ← first line stays visible
 *      c + d + e          ← folded
 *      + f;               ← folded (last line of chunk)
 *
 *    becomes:  F[u_] = a + b + …
 *
 * Reuses the tokenizer and pair-matcher from selectionRange.js.
 * Comments are handled by a dedicated scanner that tracks nesting depth
 * and records every (* *) pair (foldable if multiline).
 */

const vscode = require('vscode');
const { tokenizeBrackets, buildBracketPairs, skipString } = require('./selectionRange');

// ─── Comment pair scanner ─────────────────────────────────────────────────────

/**
 * Find all (* *) comment pairs in `text`, including nested ones.
 * Each nesting level that spans multiple lines gets its own entry.
 * Returns array of { openOffset, closeOffset }.
 */
function findCommentPairs(text) {
    const pairs = [];
    const stack = []; // stack of open offsets
    let i = 0;
    while (i < text.length) {
        if (text[i] === '"') {
            // skip string — brackets/comments inside strings are not real
            i++;
            while (i < text.length) {
                if (text[i] === '\\') { i += 2; continue; }
                if (text[i] === '"')  { i++; break; }
                i++;
            }
            continue;
        }
        if (text[i] === '(' && text[i + 1] === '*') {
            stack.push(i);
            i += 2;
            continue;
        }
        if (text[i] === '*' && text[i + 1] === ')') {
            if (stack.length > 0) {
                pairs.push({ openOffset: stack.pop(), closeOffset: i });
            }
            i += 2;
            continue;
        }
        i++;
    }
    return pairs;
}

// ─── Chunk splitter (mirrors checkout.js / wl-formatter.js logic) ─────────────

/**
 * Split `text` into top-level sub-expression chunks, returning each chunk's
 * start and end line numbers (0-based, inclusive).
 *
 * A chunk is determined by bracket depth: lines inside any open bracket pair
 * always belong to the same chunk.  At bracket depth 0, a bare newline ends
 * a chunk UNLESS a continuation operator appears at the end of the current
 * line or the start of the next line.  Example:
 *
 *   F[u_] = a + b +    ← depth 0, ends with +, continues
 *   c + d              ← depth 0, no next op, chunk ends here
 */
function splitChunks(text) {
    const ENDS_OP_RE   = /(&&|\|\||->|:>|\/\/\.|\/\/|\/\/@|\/@|@@|<>|~~|;;|\^:=|:=|\+=|-=|\*=|\/=|[+\-*\/=,&|~@?])$/;
    const STARTS_OP_RE = /^(&&|\|\||->|:>|\/\/\.|\/\/|<>|!=|>=|<=|[=+\-*/,|~@?])/;

    const lines = text.split('\n');

    // Pass 1: compute bracket depth at the END of each line, skipping strings/comments.
    // Lines inside open brackets always belong to the same chunk.
    const lineEndDepth = new Int32Array(lines.length);
    let depth = 0;
    let inString = false;
    let commentDepth = 0;

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        let i = 0;
        while (i < line.length) {
            const ch = line[i];
            if (inString) {
                if (ch === '\\') { i += 2; continue; }
                if (ch === '"') inString = false;
                i++; continue;
            }
            if (commentDepth > 0) {
                if (ch === '(' && line[i + 1] === '*') { commentDepth++; i += 2; continue; }
                if (ch === '*' && line[i + 1] === ')') { commentDepth--; i += 2; continue; }
                i++; continue;
            }
            if (ch === '"') { inString = true; i++; continue; }
            if (ch === '(' && line[i + 1] === '*') { commentDepth++; i += 2; continue; }
            if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
            if (ch === ')' || ch === ']' || ch === '}') { if (depth > 0) depth--; i++; continue; }
            if (ch === '<' && line[i + 1] === '|') { depth++; i += 2; continue; }
            if (ch === '|' && line[i + 1] === '>') { if (depth > 0) depth--; i += 2; continue; }
            if (ch === '\u301a') { depth++; i++; continue; }              // 〚
            if (ch === '\u301b') { if (depth > 0) depth--; i++; continue; } // 〛
            i++;
        }
        lineEndDepth[li] = depth;
    }

    // Pass 2: split into chunks.
    const chunks = [];
    let chunkStart = 0;

    for (let i = 0; i < lines.length; i++) {
        const trimmed  = lines[i].trim();
        const depthAfter = lineEndDepth[i];

        if (trimmed === '') {
            // Blank line: only end chunk if at bracket depth 0
            if (depthAfter === 0 && i > chunkStart) {
                chunks.push({ startLine: chunkStart, endLine: i - 1 });
            }
            if (depthAfter === 0) chunkStart = i + 1;
            continue;
        }

        if (depthAfter > 0) {
            // Inside open brackets — cannot end a chunk here
            continue;
        }

        // Depth is 0 after this line: check continuation operators
        const next = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
        const endsWithOp   = ENDS_OP_RE.test(trimmed);
        const nextStartsOp = next.length > 0 && STARTS_OP_RE.test(next);

        if (!endsWithOp && !nextStartsOp) {
            chunks.push({ startLine: chunkStart, endLine: i });
            chunkStart = i + 1;
        }
        // else: continuation — extend chunk to next line
    }

    // Trailing chunk
    if (chunkStart < lines.length && lines[chunkStart]?.trim() !== '') {
        chunks.push({ startLine: chunkStart, endLine: lines.length - 1 });
    }
    return chunks;
}

// ─── Line number helper ───────────────────────────────────────────────────────

/** Build an array mapping character offset → line number (0-based). O(n). */
function buildLineMap(text) {
    const map = new Uint32Array(text.length + 1);
    let line = 0;
    for (let i = 0; i < text.length; i++) {
        map[i] = line;
        if (text[i] === '\n') line++;
    }
    map[text.length] = line;
    return map;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

function provideFoldingRanges(document) {
    const text    = document.getText();
    const lineMap = buildLineMap(text);
    const ranges  = [];

    // ---- Bracket pairs (all non-comment bracket types) ----
    const tokens = tokenizeBrackets(text);
    const pairs  = buildBracketPairs(tokens);
    for (const p of pairs) {
        const openLine  = lineMap[p.openStart];
        const closeLine = lineMap[p.closeStart];
        // Use closeLine-1 so the closing bracket stays visible when folded.
        // This also ensures adjacent folds (where one closes on the same line
        // another opens) never share a boundary — VS Code won't show a fold
        // indicator on a line that is simultaneously the end of another fold.
        if (closeLine - 1 > openLine) {
            ranges.push(new vscode.FoldingRange(openLine, closeLine - 1, vscode.FoldingRangeKind.Region));
        }
    }

    // ---- Comment pairs (* *) ----
    const commentPairs = findCommentPairs(text);
    for (const cp of commentPairs) {
        const openLine  = lineMap[cp.openOffset];
        const closeLine = lineMap[cp.closeOffset];
        if (closeLine > openLine) {
            ranges.push(new vscode.FoldingRange(openLine, closeLine, vscode.FoldingRangeKind.Comment));
        }
    }

    // ---- Chunk folds — multi-line top-level sub-expressions ----
    const chunks = splitChunks(text);
    for (const ch of chunks) {
        if (ch.endLine > ch.startLine) {
            // Fold from startLine to endLine: first line stays visible, rest hidden.
            ranges.push(new vscode.FoldingRange(ch.startLine, ch.endLine, vscode.FoldingRangeKind.Region));
        }
    }

    return ranges;
}

// ─── Registration ─────────────────────────────────────────────────────────────

function register(context) {
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            [
                { language: 'wolfram' },
                { language: 'wolfram', notebookType: '*' },
                { scheme: 'vscode-notebook-cell' },
            ],
            {
                provideFoldingRanges(document, _context, _token) {
                    if (document.languageId === 'markdown') return [];
                    try {
                        return provideFoldingRanges(document);
                    } catch (err) {
                        console.error('[WolframFolding] error:', err);
                        return [];
                    }
                },
            }
        )
    );
}

module.exports = { register };
