"use strict";
/**
 * Wolfbook Debugger — Stage 1: Code Transformer
 *
 * Transforms a Wolfram Language cell's source code into instrumented code
 * that calls wolfbookDebug$BeforeStep and wolfbookDebug$Timed at each step.
 *
 * TWO modes, unified by a single function:
 *
 * 1. FULL-CELL mode (default): the entire cell is treated as a body at depth 0.
 *    Each top-level statement (split by `;` at bracket depth 0) becomes a step
 *    at depth 0. If a statement is a loop (Do/For/While/Table), the loop body
 *    is recursively instrumented at depth 1+ and the outer statement is still
 *    wrapped as depth-0 step. This lets the user step through "1+1; T=1; Do[...]"
 *    one statement at a time, then Step Into the loop.
 *
 * 2. LOOP-ONLY mode (legacy, for backwards compat): finds the first outermost
 *    loop in the cell and instruments only its body starting at depth 1. Used
 *    when the caller passes { loopOnly: true }.
 *
 * Returns null if the cell is empty or (in loopOnly mode) no loop is found.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.transformCode = transformCode;
exports.lineColumnFromOffset = lineColumnFromOffset;

// ─────────────────────────────────────────────────────────────────────────────
// Low-level scanner utilities
// ─────────────────────────────────────────────────────────────────────────────

function skipString(code, pos) {
    pos++;
    while (pos < code.length) {
        const ch = code[pos];
        if (ch === '\\') { pos += 2; }
        else if (ch === '"') { return pos + 1; }
        else { pos++; }
    }
    return pos;
}

function skipComment(code, pos) {
    pos += 2;
    let depth = 1;
    while (pos < code.length && depth > 0) {
        if (code[pos] === '(' && pos + 1 < code.length && code[pos + 1] === '*') { depth++; pos += 2; }
        else if (code[pos] === '*' && pos + 1 < code.length && code[pos + 1] === ')') { depth--; pos += 2; }
        else { pos++; }
    }
    return pos;
}

function isCommentStart(code, pos) {
    return code[pos] === '(' && pos + 1 < code.length && code[pos + 1] === '*';
}

// ─────────────────────────────────────────────────────────────────────────────
// Bracket-aware scanning
// ─────────────────────────────────────────────────────────────────────────────

function findClosingBracket(code, pos) {
    let depth = 1;
    while (pos < code.length) {
        const ch = code[pos];
        if (ch === '"') { pos = skipString(code, pos); }
        else if (isCommentStart(code, pos)) { pos = skipComment(code, pos); }
        else if (ch === '[') { depth++; pos++; }
        else if (ch === ']') { depth--; if (depth === 0) return pos; pos++; }
        else { pos++; }
    }
    return -1;
}

/**
 * Split code on separator at bracket depth 0 ([ { ( depth).
 * When separator is ';', also splits on bare newlines at depth 0 whose
 * immediately-preceding non-whitespace token ends a complete expression
 * (letter / digit / ] } ) " _). This handles cells where statements are
 * separated by newlines alone, like  x=1\ny=1\nDo[...]\nz=1.
 * Returns [{ content, start, end }] — start/end are offsets within code.
 */
function splitAtDepth0(code, separator) {
    const parts = [];
    let depth = 0, segStart = 0, pos = 0;
    let lastNonWS = ''; // track most recent non-whitespace char for newline heuristic
    while (pos < code.length) {
        const ch = code[pos];
        if (ch === '"') {
            pos = skipString(code, pos);
            lastNonWS = '"';
        } else if (isCommentStart(code, pos)) {
            pos = skipComment(code, pos);
            // Comments end with *) — ')' is expression-neutral; keep lastNonWS as-is
        } else if (ch === '[' || ch === '{' || ch === '(') {
            lastNonWS = ch; depth++; pos++;
        } else if (ch === ']' || ch === '}' || ch === ')') {
            depth--; lastNonWS = ch; pos++;
        } else if (ch === separator && depth === 0) {
            parts.push({ content: code.slice(segStart, pos), start: segStart, end: pos });
            segStart = pos + 1; pos++;
            lastNonWS = '';
        } else if (ch === '\n' && separator === ';' && depth === 0) {
            // Also treat a newline as a statement separator when the previous
            // non-whitespace char ends a complete expression.
            if (/[a-zA-Z0-9_\]})"\']/.test(lastNonWS)) {
                parts.push({ content: code.slice(segStart, pos), start: segStart, end: pos });
                segStart = pos + 1;
                lastNonWS = '';
            }
            pos++;
        } else {
            if (!/[ \t\r]/.test(ch)) lastNonWS = ch;
            pos++;
        }
    }
    parts.push({ content: code.slice(segStart), start: segStart, end: code.length });
    return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loop detection
// ─────────────────────────────────────────────────────────────────────────────

function findOutermostLoop(code) {
    // Linear scanner that skips strings and (* comments *) before checking
    // for loop head names — prevents false matches inside comment text.
    let pos = 0;
    while (pos < code.length) {
        const ch = code[pos];
        // Skip string literals and WL comments
        if (ch === '"') { pos = skipString(code, pos); continue; }
        if (isCommentStart(code, pos)) { pos = skipComment(code, pos); continue; }
        // Quick filter: only Do/For/While/Table start with D/F/W/T
        if (ch === 'D' || ch === 'F' || ch === 'W' || ch === 'T') {
            // Word-boundary check: preceding char must not be a symbol char
            const prevCh = pos > 0 ? code[pos - 1] : '';
            if (/[a-zA-Z0-9$`]/.test(prevCh)) { pos++; continue; }
            for (const head of ['Do', 'For', 'While', 'Table']) {
                if (head[0] !== ch) continue;
                if (!code.startsWith(head, pos)) continue;
                const afterHead = pos + head.length;
                // Word-boundary check: next char must not be a symbol char
                const nextCh = afterHead < code.length ? code[afterHead] : '';
                if (/[a-zA-Z0-9$]/.test(nextCh)) continue;
                // Skip optional whitespace then expect '['
                let i = afterHead;
                while (i < code.length && ' \t\n\r'.includes(code[i])) i++;
                if (i < code.length && code[i] === '[') {
                    const closeBracket = findClosingBracket(code, i + 1);
                    if (closeBracket >= 0) {
                        return { head, headStart: pos, openBracket: i, closeBracket };
                    }
                }
            }
        }
        pos++;
    }
    return null;
}

function extractIteratorVar(iterSpec) {
    const m = iterSpec.match(/^\s*\{\s*([a-zA-Z$][a-zA-Z0-9$]*)\s*[,}]/);
    return m ? m[1] : null;
}

function extractLoopInfo(head, argsStr) {
    const args = splitAtDepth0(argsStr, ',');
    let bodyArgIndex, iterVarName;
    if (head === 'Do' || head === 'Table') {
        bodyArgIndex = 0;
        if (args.length >= 2) iterVarName = extractIteratorVar(args[1].content.trim());
    } else if (head === 'While') {
        bodyArgIndex = 1;
        iterVarName = null;
    } else if (head === 'For') {
        bodyArgIndex = 3;
        if (args.length >= 1) {
            const assignMatch = args[0].content.trim().match(/^\s*([a-zA-Z$][a-zA-Z0-9$]*)\s*[=:]/);
            if (assignMatch) iterVarName = assignMatch[1];
        }
    }
    if (bodyArgIndex === undefined || bodyArgIndex >= args.length) return null;
    const bodyArg = args[bodyArgIndex];
    return { bodyContent: bodyArg.content, bodyOffset: bodyArg.start, iterVarName: iterVarName || null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recursive instrumentation of a body string
// ─────────────────────────────────────────────────────────────────────────────

function instrumentBody(bodyStr, depth, outerIterVars, baseOffset, originalCode, stepsOut, counter = { value: 1 }) {
    const statements = splitAtDepth0(bodyStr, ';');
    const instrParts = [];

    for (const stmt of statements) {
        const trimmed = stmt.content.trim();
        if (!trimmed) continue;

        const leadingSpaces = stmt.content.length - stmt.content.trimStart().length;
        const stmtAbsStart = baseOffset + stmt.start + leadingSpaces;
        const stmtAbsEnd   = baseOffset + stmt.end;

        const innerLoop = findOutermostLoop(trimmed);
        let codeToWrap = trimmed;

        if (innerLoop) {
            const innerArgsStr = trimmed.slice(innerLoop.openBracket + 1, innerLoop.closeBracket);
            const innerInfo = extractLoopInfo(innerLoop.head, innerArgsStr);
            if (innerInfo) {
                const innerIterVars = [...outerIterVars, ...(innerInfo.iterVarName ? [innerInfo.iterVarName] : [])];
                const innerBodyAbsOffset = stmtAbsStart + innerLoop.openBracket + 1 + innerInfo.bodyOffset;
                const innerInstrBody = instrumentBody(
                    innerInfo.bodyContent, depth + 1, innerIterVars,
                    innerBodyAbsOffset, originalCode, stepsOut,
                    counter
                );
                const preBody  = trimmed.slice(0, innerLoop.openBracket + 1) +
                                 innerArgsStr.slice(0, innerInfo.bodyOffset);
                const postBody = innerArgsStr.slice(innerInfo.bodyOffset + innerInfo.bodyContent.length) +
                                 trimmed.slice(innerLoop.closeBracket);
                codeToWrap = preBody + innerInstrBody + postBody;
            }
        }

        // Build WL Association form for iter vars: <|"i"->i, "j"->j|>
        // This lets the JS side parse names+values directly from the WExpr.
        let iterVarsExpr;
        if (outerIterVars.length > 0) {
            const pairs = outerIterVars.map(v => `"${v}"->${v}`).join(', ');
            iterVarsExpr = `<|${pairs}|>`;
        } else {
            iterVarsExpr = '<||>';
        }
        const startLC = lineColumnFromOffset(originalCode, stmtAbsStart);
        const endLC   = lineColumnFromOffset(originalCode, Math.min(stmtAbsEnd, originalCode.length));

        const localStep = counter.value++;

        stepsOut.push({
            depth, localStep,
            sourceStart: stmtAbsStart, sourceEnd: stmtAbsEnd,
            startLine: startLC.line, startChar: startLC.character,
            endLine: endLC.line, endChar: endLC.character,
            containsInnerLoop: !!innerLoop,
            isLoop: !!innerLoop && depth === 0,
            iterVarNames: [...outerIterVars],
            suppressedOutput: bodyStr[stmt.end] === ';',
        });

        instrParts.push(
            `wolfbookDebug$BeforeStep[${depth}, ${localStep}, ${iterVarsExpr}]`,
            `wolfbookDebug$Timed[${depth}, ${localStep}, (${codeToWrap})]`
        );
    }

    return instrParts.join(';\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

function lineColumnFromOffset(code, offset) {
    let line = 0, lastNewline = -1;
    const end = Math.min(offset, code.length);
    for (let i = 0; i < end; i++) {
        if (code[i] === '\n') { line++; lastNewline = i; }
    }
    return { line, character: offset - lastNewline - 1 };
}

/**
 * Transform a Wolfram Language cell for debugging.
 *
 * In full-cell mode (default): ALL top-level statements are instrumented at
 * depth 0. Loop bodies are recursively instrumented at depth 1+.
 * This handles cells like:  1+1; Print[1]; T=1; Do[...loop..., {n,10}]
 *
 * In loopOnly mode: only the first outermost loop body is instrumented,
 * starting at depth 1. Pre/post-loop statements are left unchanged.
 *
 * @param {string}   code             Full cell source code
 * @param {number[]} breakpointLines  0-indexed line numbers with breakpoints
 * @param {object}   options          { loopOnly: bool }
 * @returns result object or null if nothing to instrument
 */
function transformCode(code, breakpointLines = [], options = {}) {
    const trimmedCode = code.trim();
    if (!trimmedCode) return null;

    const steps = [];
    let instrumentedCode;
    let loopHead = null, loopVarName = null;

    if (options.loopOnly) {
        // ── Legacy mode: instrument only the body of the first outermost loop ──
        const loop = findOutermostLoop(code);
        if (!loop) return null;
        const argsStr  = code.slice(loop.openBracket + 1, loop.closeBracket);
        const loopInfo = extractLoopInfo(loop.head, argsStr);
        if (!loopInfo) return null;
        loopHead = loop.head;
        loopVarName = loopInfo.iterVarName;
        const outerIterVars = loopInfo.iterVarName ? [loopInfo.iterVarName] : [];
        const bodyAbsOffset = loop.openBracket + 1 + loopInfo.bodyOffset;
        const instrBody = instrumentBody(loopInfo.bodyContent, 1, outerIterVars, bodyAbsOffset, code, steps);
        const beforeBody = code.slice(0, loop.openBracket + 1) + argsStr.slice(0, loopInfo.bodyOffset);
        const afterBody  = argsStr.slice(loopInfo.bodyOffset + loopInfo.bodyContent.length) + code.slice(loop.closeBracket);
        instrumentedCode = beforeBody + instrBody + afterBody;
    } else {
        // ── Full-cell mode: treat the entire cell as depth-0 body ──
        // Find first loop head for metadata (may be null if no loop)
        const firstLoop = findOutermostLoop(code);
        if (firstLoop) {
            loopHead = firstLoop.head;
            const argsStr = code.slice(firstLoop.openBracket + 1, firstLoop.closeBracket);
            const li = extractLoopInfo(firstLoop.head, argsStr);
            loopVarName = li ? li.iterVarName : null;
        }
        // Instrument entire cell body at depth 0 (baseOffset = 0)
        const instrBody = instrumentBody(code, 0, [], 0, code, steps);
        instrumentedCode = instrBody;
    }

    if (steps.length === 0) return null;

    const maxDepth = Math.max(...steps.map(s => s.depth));
    const hasLoop  = steps.some(s => s.containsInnerLoop || s.depth > 0);

    // Map breakpoint lines to step IDs
    const bpSet = new Set(breakpointLines);
    const breakpointMap = {};
    for (const line of bpSet) {
        const match = steps.find(s => s.startLine <= line && line <= s.endLine);
        if (match) breakpointMap[line] = { depth: match.depth, localStep: match.localStep };
    }

    return { instrumentedCode, steps, maxDepth, loopHead, loopVarName, hasLoop, breakpointMap };
}
