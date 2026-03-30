'use strict';

/**
 * Wolfram Language FoldingRangeProvider.
 *
 * Folds any bracket pair that spans more than one line:
 *   ( )   [ ]   { }   [[ ]]   <| |>   (* *)
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
