'use strict';
// utils/wl-parse.js — shared WL source-text parsing utilities.

/**
 * Split a WL cell's source text into top-level sub-expressions.
 * Returns an array of { text, startLine, endLine } objects.
 * Handles: bracket depth, string literals, nestable (* ... *) comments,
 * <| |> associations, CRLF, and continuation operators on either end of a newline.
 *
 * @param {string} code
 * @returns {{ text: string, startLine: number, endLine: number }[]}
 */
function splitIntoSubexpressions(code) {
    const parts = [];
    let current = "";
    let depth   = 0;        // bracket nesting ( [ {
    let inStr    = false;    // inside "..."
    let cDepth   = 0;       // inside (* ... *) — nestable
    let i = 0;
    let lineNum = 0;
    let exprStartLine = 0;
    while (i < code.length) {
        const ch   = code[i];
        const next = i + 1 < code.length ? code[i + 1] : "";
        if (inStr) {
            if (ch === '\n') lineNum++;
            current += ch;
            if      (ch === "\\") { if (i + 1 < code.length) { current += next; i++; } }
            else if (ch === '"')  { inStr = false; }
            i++; continue;
        }
        if (cDepth > 0) {
            if (ch === '\n') lineNum++;
            current += ch;
            if      (ch === "(" && next === "*") { cDepth++; current += next; i += 2; }
            else if (ch === "*" && next === ")") { cDepth--; current += next; i += 2; }
            else i++;
            continue;
        }
        if (ch === '"')                      { inStr = true;  current += ch; i++; }
        else if (ch === "(" && next === "*") { cDepth = 1; current += ch + next; i += 2; }
        else if (ch === "<" && next === "|") { depth++; current += ch + next; i += 2; }
        else if (ch === "|" && next === ">") { depth--; current += ch + next; i += 2; }
        else if (ch === "(" || ch === "[" || ch === "{") { depth++; current += ch; i++; }
        else if (ch === ")" || ch === "]" || ch === "}") { depth--; current += ch; i++; }
        else if ((ch === "\n" || ch === "\r") && depth === 0 && cDepth === 0) {
            const t = current.trim();
            const endsWithOp = t.length > 0 && /(&&|\|\||->|:>|\/\/\.|\/\/|\/\/@|\/@|@@|<>|~~|;;|\^:=|:=|\+=|-=|\*=|\/=|[+\-*\/=,|~@?])$/.test(t);
            let peekPos = i + 1;
            if (ch === '\r' && next === '\n') peekPos = i + 2;
            while (peekPos < code.length && (code[peekPos] === ' ' || code[peekPos] === '\t')) peekPos++;
            const peekCh  = peekPos < code.length ? code[peekPos] : '';
            const peekTwo = (peekPos + 1 < code.length) ? code.slice(peekPos, peekPos + 2) : peekCh;
            const startsWithOp = t.length > 0 && peekCh.length > 0 && (
                '=+-*/,|~@?'.includes(peekCh) ||
                peekTwo === '&&' || peekTwo === '||' || peekTwo === '->' || peekTwo === ':>' ||
                peekTwo === '//' || peekTwo === '<>' || peekTwo === '!=' || peekTwo === '>=' || peekTwo === '<='
            );
            if (endsWithOp || startsWithOp) {
                current += ' ';
                if (ch === '\r' && next === '\n') i++;
                i++; lineNum++;
            } else {
                if (t.length > 0) parts.push({ text: t, startLine: exprStartLine, endLine: lineNum });
                current = "";
                if (ch === "\r" && next === "\n") i++;
                i++; lineNum++;
                exprStartLine = lineNum;
            }
        } else {
            if (ch === '\n') lineNum++;
            current += ch; i++;
        }
    }
    const t = current.trim();
    if (t.length > 0) parts.push({ text: t, startLine: exprStartLine, endLine: lineNum });
    return parts.length > 0 ? parts : [{ text: code, startLine: 0, endLine: code.split('\n').length - 1 }];
}

module.exports = { splitIntoSubexpressions };
