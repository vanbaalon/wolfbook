'use strict';

/**
 * Wolfram Language SmartSelect / Expand Selection provider.
 *
 * Pressing Shift+Alt+Right (or the smartSelect.expand command) progressively
 * expands the selection through:
 *   word  →  comma-arg  →  bracket-contents  →  bracket+head  →  (repeat outward)  →  full cell
 *
 * Also handles:
 *   - Double brackets [[...]] as a single bracket unit
 *   - Association <|...|>
 *   - String literals (skips bracket chars inside strings)
 *   - Nested comments (* ... *) (Wolfram comments can nest)
 *   - Cursor placed on a bracket character
 */

const vscode = require('vscode');

// ─── Text utilities ───────────────────────────────────────────────────────────

/** Skip over a "..." string starting at i (opening quote). Returns index after closing quote. */
function skipString(text, i) {
    i++; // skip opening "
    while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; } // escape sequence
        if (text[i] === '"')  return i + 1;
        i++;
    }
    return i;
}

/**
 * Skip over a (* ... *) comment starting at i (opening paren).
 * Wolfram comments nest, so (* (* *) *) requires matching depth.
 * Returns index after the matching closing *).
 */
function skipComment(text, i) {
    i += 2; // skip (*
    let depth = 1;
    while (i < text.length - 1) {
        if (text[i] === '(' && text[i + 1] === '*') { depth++; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === ')') { if (--depth === 0) return i + 2; i += 2; continue; }
        i++;
    }
    return text.length;
}

/**
 * If cursor offset is inside a string literal, return {start, end} (positions
 * of the opening and closing quote, end = index after closing quote).
 * Returns null if not inside a string.
 */
function findEnclosingString(text, offset) {
    let i = 0;
    while (i < text.length && i <= offset) {
        if (text[i] === '"') {
            const end = skipString(text, i);
            if (offset < end) return { start: i, end };
            i = end;
            continue;
        }
        if (text[i] === '(' && text[i + 1] === '*') { i = skipComment(text, i); continue; }
        i++;
    }
    return null;
}

// ─── Bracket tokenizer ────────────────────────────────────────────────────────

const OPEN_TYPES = new Set(['BBO', 'BO', 'PO', 'BRO', 'AO']);

/**
 * Tokenize text into bracket-relevant tokens, skipping string/comment content.
 * Each token: { type, offset, len }
 *
 * Types: BBO    = [[   (Part open — two chars)
 *        BO/BC  = [  ] (function application — one char each)
 *        PO/PC  = (  ) (grouping)
 *        BRO/BRC= {  } (List)
 *        AO/AC  = <| |> (Association)
 *
 * NOTE: ]] is intentionally NOT tokenized as a single "BBC" token.
 *       f[g[...]] has two separate ] chars that are NOT a Part-close.
 *       We cannot tell lexically whether ]] is Part-close or two closes,
 *       so we emit individual BC tokens and resolve in buildBracketPairs
 *       using stack context (BBO open → needs two BC to close).
 */
function tokenizeBrackets(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i], d = text[i + 1];
        if (c === '"')              { i = skipString(text, i);  continue; }
        if (c === '(' && d === '*') { i = skipComment(text, i); continue; }
        // [[ must be checked before [ so Part open is a single 2-char token
        if (c === '[' && d === '[') { tokens.push({ type: 'BBO', offset: i, len: 2 }); i += 2; continue; }
        if (c === '[') { tokens.push({ type: 'BO',  offset: i, len: 1 }); i++; continue; }
        if (c === ']') { tokens.push({ type: 'BC',  offset: i, len: 1 }); i++; continue; } // individual, never greedy ]]
        if (c === '(') { tokens.push({ type: 'PO',  offset: i, len: 1 }); i++; continue; }
        if (c === ')') { tokens.push({ type: 'PC',  offset: i, len: 1 }); i++; continue; }
        if (c === '{') { tokens.push({ type: 'BRO', offset: i, len: 1 }); i++; continue; }
        if (c === '}') { tokens.push({ type: 'BRC', offset: i, len: 1 }); i++; continue; }
        if (c === '<' && d === '|') { tokens.push({ type: 'AO', offset: i, len: 2 }); i += 2; continue; }
        if (c === '|' && d === '>') { tokens.push({ type: 'AC', offset: i, len: 2 }); i += 2; continue; }
        if (c === '\u301a') { tokens.push({ type: 'BBO', offset: i, len: 1 }); i++; continue; } // 〚 treated as [[
        if (c === '\u301b') { tokens.push({ type: 'BBC', offset: i, len: 1 }); i++; continue; } // 〛 closes 〚
        i++;
    }
    return tokens;
}

/**
 * Match bracket tokens into pairs using a stack.
 * Returns array of { openStart, openEnd, closeStart, closeEnd, type }.
 * Mismatched or unclosed brackets are silently skipped.
 *
 * Key: BC (single ]) can close either BO (single [) or BBO ([[]).
 * BBO requires two consecutive BC tokens to close — we look ahead.
 */
function buildBracketPairs(tokens) {
    const stack = [];
    const pairs = [];
    let ti = 0;
    while (ti < tokens.length) {
        const tok = tokens[ti];

        if (OPEN_TYPES.has(tok.type)) {
            stack.push(tok);
            ti++;
            continue;
        }

        if (tok.type === 'BC') {
            // Find nearest BO or BBO on the stack
            let idx = stack.length - 1;
            while (idx >= 0 && stack[idx].type !== 'BO' && stack[idx].type !== 'BBO') idx--;
            if (idx < 0) { ti++; continue; } // unmatched ]

            const open = stack[idx];
            if (open.type === 'BBO') {
                // [[ needs ]] — require two consecutive BC tokens
                const next = tokens[ti + 1];
                if (!next || next.type !== 'BC') { ti++; continue; } // malformed — skip
                stack.splice(idx); // pop BBO + any unmatched opens above it
                pairs.push({
                    openStart:  open.offset,
                    openEnd:    open.offset + 2,
                    closeStart: tok.offset,
                    closeEnd:   next.offset + 1,
                    type:       'BBO',
                });
                ti += 2; // consume both ]
            } else {
                // BO: single ]
                stack.splice(idx);
                pairs.push({
                    openStart:  open.offset,
                    openEnd:    open.offset + 1,
                    closeStart: tok.offset,
                    closeEnd:   tok.offset + 1,
                    type:       'BO',
                });
                ti++;
            }
            continue;
        }

        // BBC (〛) closes BBO (〚)
        if (tok.type === 'BBC') {
            let idx = stack.length - 1;
            while (idx >= 0 && stack[idx].type !== 'BBO') idx--;
            if (idx < 0) { ti++; continue; }
            const open = stack[idx];
            stack.splice(idx);
            pairs.push({
                openStart:  open.offset,
                openEnd:    open.offset + open.len,
                closeStart: tok.offset,
                closeEnd:   tok.offset + 1,
                type:       'BBO',
            });
            ti++;
            continue;
        }

        // PC, BRC, AC — match their specific open bracket type
        const CLOSE_MAP = { PC: 'PO', BRC: 'BRO', AC: 'AO' };
        const openType = CLOSE_MAP[tok.type];
        if (!openType) { ti++; continue; }
        let idx = stack.length - 1;
        while (idx >= 0 && stack[idx].type !== openType) idx--;
        if (idx < 0) { ti++; continue; }
        const open = stack[idx];
        stack.splice(idx);
        pairs.push({
            openStart:  open.offset,
            openEnd:    open.offset + open.len,
            closeStart: tok.offset,
            closeEnd:   tok.offset + tok.len,
            type:       open.type,
        });
        ti++;
    }
    return pairs;
}

// ─── Expression helpers ───────────────────────────────────────────────────────

function isIdentChar(c) {
    return c !== undefined && /[a-zA-Z0-9$`]/.test(c);
}

/**
 * Walk backwards from openStart to find the start of the head expression
 * immediately preceding a [ or [[ bracket, e.g. for f[...] returns start of 'f'.
 * Returns openStart if no identifier precedes the bracket.
 */
function findHeadStart(text, openStart) {
    let i = openStart - 1;
    while (i >= 0 && isIdentChar(text[i])) i--;
    return i + 1;
}

/**
 * Find the comma-separated argument around cursorOffset within pair.
 * Only counts commas at depth 0 (nesting tracked with an explicit stack,
 * never greedy — avoids the ]] = two separate ] vs Part-close ambiguity).
 * Returns {start, end} with surrounding whitespace stripped, or null.
 */
function findArgumentBounds(text, cursor, pair) {
    let i        = pair.openEnd;
    let argStart = i;
    const openStack = []; // track bracket opens inside this pair's content

    while (i <= pair.closeStart) {
        if (i === pair.closeStart) {
            if (cursor >= argStart && cursor <= i) {
                return trimRange(text, argStart, i);
            }
            break;
        }
        const c = text[i], d = text[i + 1];

        if (c === '"') { i = skipString(text, i); continue; }
        if (c === '(' && d === '*') { i = skipComment(text, i); continue; }

        // Opens — push marker
        if (c === '[' && d === '[') { openStack.push('Part');  i += 2; continue; }
        if (c === '[')              { openStack.push('Func');  i++;    continue; }
        if (c === '(')              { openStack.push('Group'); i++;    continue; }
        if (c === '{')              { openStack.push('List');  i++;    continue; }
        if (c === '<' && d === '|') { openStack.push('Assoc'); i += 2; continue; }

        // Closes — pop if stack has something
        if (c === ']') {
            const top = openStack[openStack.length - 1];
            if (top === 'Part') {
                // Part [[ needs ]] to close
                if (d === ']') { openStack.pop(); i += 2; } else { i++; } // malformed
            } else {
                if (openStack.length) openStack.pop();
                i++;
            }
            continue;
        }
        if (c === ')') { if (openStack.length) openStack.pop(); i++; continue; }
        if (c === '}') { if (openStack.length) openStack.pop(); i++; continue; }
        if (c === '|' && d === '>') { if (openStack.length) openStack.pop(); i += 2; continue; }

        // Comma at depth 0 = argument separator
        if (openStack.length === 0 && c === ',') {
            if (cursor >= argStart && cursor <= i) {
                return trimRange(text, argStart, i);
            }
            argStart = i + 1;
        }
        i++;
    }
    return null;
}

/** Trim whitespace from both ends of [start, end). Returns {start, end} or null if empty. */
function trimRange(text, start, end) {
    while (start < end && /\s/.test(text[start]))     start++;
    while (end > start && /\s/.test(text[end - 1]))   end--;
    return start < end ? { start, end } : null;
}

/**
 * Find the Wolfram identifier or number literal around cursor.
 * Returns {start, end} or null if cursor is not on a word character.
 */
function getWordOffsets(text, offset) {
    const at     = offset < text.length ? text[offset] : '';
    const before = offset > 0 ? text[offset - 1] : '';
    if (!isIdentChar(at) && !isIdentChar(before)) return null;
    let pos   = isIdentChar(at) ? offset : offset - 1;
    let start = pos, end = pos + 1;
    while (start > 0 && isIdentChar(text[start - 1])) start--;
    while (end < text.length && isIdentChar(text[end])) end++;
    return { start, end };
}

// ─── Chain builder ────────────────────────────────────────────────────────────

/**
 * Build the SelectionRange chain for a single cursor position.
 *
 * The chain runs innermost → outermost (child → parent).
 * Pressing Expand Selection follows parents, progressively widening the selection.
 */
function buildSelectionChain(document, position) {
    const text   = document.getText();
    const cursor = document.offsetAt(position);

    function R(s, e) {
        return new vscode.Range(document.positionAt(s), document.positionAt(e));
    }

    /** Append range to array, skipping empty ranges and duplicates of the last entry. */
    function push(arr, range) {
        if (!range || range.isEmpty) return;
        if (arr.length && arr[arr.length - 1].isEqual(range)) return;
        arr.push(range);
    }

    // ── Detect string literal context ───────────────────────────────────────
    const strLit = findEnclosingString(text, cursor);

    // ── Find enclosing bracket pairs, sorted innermost (smallest) first ──────
    const tokens    = tokenizeBrackets(text);
    const allPairs  = buildBracketPairs(tokens);
    // Include pair if cursor is within or on the opening/closing bracket chars
    const enclosing = allPairs
        .filter(p => p.openStart <= cursor && cursor < p.closeEnd)
        .sort((a, b) => (a.closeEnd - a.openStart) - (b.closeEnd - b.openStart));

    console.log(`[WolframSelect] cursor=${cursor} text="${text.slice(0, 60).replace(/\n/g, '\\n')}"`);
    const pairLog = allPairs.map(p => `${p.type}[${p.openStart},${p.closeEnd})`).join(', ');
    console.log(`[WolframSelect] pairs: ${pairLog || '(none)'}`);
    console.log(`[WolframSelect] enclosing: ${enclosing.map(p => `${p.type}[${p.openStart},${p.closeEnd})`).join(', ') || '(none)'}`);

    // ── Collect ranges, innermost first ──────────────────────────────────────
    const ranges = [];

    if (strLit) {
        // Cursor is inside a string literal.
        // Word (identifier chars inside the string) → entire string → full cell.
        const w = getWordOffsets(text, cursor);
        if (w) push(ranges, R(w.start, w.end));
        push(ranges, R(strLit.start, strLit.end));
    } else {
        // 1. Word / identifier at cursor
        const w = getWordOffsets(text, cursor);
        if (w) push(ranges, R(w.start, w.end));

        // 2. Comma-delimited argument within the innermost bracket (if wider than word)
        if (enclosing.length > 0) {
            const arg = findArgumentBounds(text, cursor, enclosing[0]);
            if (arg) push(ranges, R(arg.start, arg.end));
        }

        // 3. For each enclosing bracket level (innermost to outermost):
        //      a) bracket contents (between bracket chars)
        //      b) full bracket span including head if present (e.g. h[...], not just [...])
        //         For [ and [[ with a preceding head, we skip the bare-bracket selection
        //         and jump straight to head+bracket, matching Mathematica's behaviour.
        for (const p of enclosing) {
            push(ranges, R(p.openEnd, p.closeStart));   // contents only (always)

            if (p.type === 'BO' || p.type === 'BBO') {
                const headStart = findHeadStart(text, p.openStart);
                if (headStart < p.openStart) {
                    // Has preceding head: skip bare "[...]" and include head → "f[...]"
                    push(ranges, R(headStart, p.closeEnd));
                } else {
                    // No head (standalone bracket): include with brackets only
                    push(ranges, R(p.openStart, p.closeEnd));
                }
            } else {
                // Grouping ( ), List { }, Association <| |>: include with brackets
                push(ranges, R(p.openStart, p.closeEnd));
            }
        }
    }

    // 4. Full cell content (always the outermost level)
    push(ranges, R(0, text.length));

    const chainLog = ranges.map(r => `"${document.getText(r).slice(0, 30)}"`).join(' → ');
    console.log(`[WolframSelect] chain: ${chainLog || '(empty)'}`);

    if (ranges.length === 0) {
        return new vscode.SelectionRange(R(0, text.length));
    }

    // ── Build SelectionRange linked list: innermost has parent = next outer ──
    let chain = new vscode.SelectionRange(ranges[ranges.length - 1]);
    for (let i = ranges.length - 2; i >= 0; i--) {
        chain = new vscode.SelectionRange(ranges[i], chain);
    }
    return chain;
}

// ─── Registration ─────────────────────────────────────────────────────────────

function register(context) {
    // Keyboard: Shift+Alt+Right / Shift+Alt+Left
    context.subscriptions.push(
        vscode.languages.registerSelectionRangeProvider(
            [
                { language: 'wolfram' },
                { language: 'wolfram', notebookType: '*' },
                { scheme: 'vscode-notebook-cell' },
            ],
            {
                provideSelectionRanges(document, positions, _token) {
                    if (document.languageId === 'markdown') return [];
                    try {
                        return positions.map(pos => buildSelectionChain(document, pos));
                    } catch (err) {
                        console.error('[WolframSelect] provideSelectionRanges error:', err);
                        return [];
                    }
                },
            }
        )
    );
}

module.exports = { register, tokenizeBrackets, buildBracketPairs, skipString, skipComment };
