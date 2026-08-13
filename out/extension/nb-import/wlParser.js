'use strict';
/**
 * wlParser.js — tokenizer + recursive-descent parser for the Wolfram expression
 * dialect that Mathematica writes into .nb files, plus an InputForm printer.
 *
 * No dependencies (no vscode, no fs) — unit-testable with plain node.
 *
 * AST nodes:
 *   {t:'call',   head, args}          Head[a, b]
 *   {t:'apply',  fn, args}            f[x][y]
 *   {t:'list',   items}               {a, b}
 *   {t:'sym',    name}                Automatic, $CellContext`u, \[Alpha]
 *   {t:'str',    value, raw}          value = decoded text; raw = WL string body
 *   {t:'num',    raw}                 kept verbatim: 3.6148802318567953`*^9
 *   {t:'rule',   lhs, rhs, delayed}   a -> b   /   a :> b
 *   {t:'infix',  op, lhs, rhs}
 *   {t:'prefix', op, arg}
 *   {t:'paren',  arg}
 *   {t:'raw',    text}                unparseable source, preserved verbatim
 *
 * Robustness: an argument that cannot be parsed does NOT fail the file — it is
 * captured as a {t:'raw'} node and parsing resumes at the next comma. A weird
 * option value inside some DynamicModuleBox can therefore never cost us the
 * whole notebook.
 */

const MAX_DEPTH = 4000;

const K_EOF = 0, K_STR = 1, K_NUM = 2, K_SYM = 3, K_PUNCT = 4, K_OP = 5;

// Longest-match-first. Only a few of these carry precedence; the rest exist so
// that error recovery can skip over them cleanly instead of stalling.
const OPERATORS = [
    '=!=', '===', '//.', '@@@', '^:=',
    ':>', '->', ';;', '/.', '//', '/@', '@@', '==', '!=', '<=', '>=', ':=',
    '+=', '-=', '*=', '/=', '&&', '||', '::', '<>', '~~', '..',
    '@', '=', '<', '>', '+', '-', '*', '/', '^', '!', '&', '|', '~', '?',
    '.', ';', '_', ':', "'"
];

function isDigit(c)    { return c >= 48 && c <= 57; }
function isLetter(c)   { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isSymStart(c) { return isLetter(c) || c === 36 /* $ */ || c >= 0x80; }
function isSymChar(c)  { return isSymStart(c) || isDigit(c) || c === 96 /* ` */; }

// ---------------------------------------------------------------------------
// String escape handling
//
// One left-to-right pass consumes backslash + the following character, so the
// ordering hazards resolve themselves: `\\[Alpha]` yields a literal backslash
// followed by the text `[Alpha]`, while `\[Alpha]` is preserved verbatim as a
// named character for wlNameToUTF to decode later.
const ESC_RX = /\\(\r\n|[\s\S])/g;

function isFold(c) { return c === '\n' || c === '\r' || c === '\r\n'; }

/** Decode a WL string body to plain text. Named chars (\[Alpha], \:03b1, octal)
 *  are deliberately left verbatim — the model layer decodes them. */
function decodeWlString(raw) {
    if (raw.indexOf('\\') === -1) return raw;
    return raw.replace(ESC_RX, (m, c) => {
        if (isFold(c)) return '';
        switch (c) {
            case '\\': return '\\';
            case '"':  return '"';
            case 'n':  return '\n';
            case 't':  return '\t';
            case 'r':  return '\r';
            case 'b':  return '\b';
            case 'f':  return '\f';
            default:   return m;
        }
    });
}

/** Remove line-continuation folds but keep every escape intact, so the result is
 *  still a valid WL string body that can be re-emitted between quotes. */
function stripFolds(raw) {
    if (raw.indexOf('\\') === -1) return raw;
    return raw.replace(ESC_RX, (m, c) => (isFold(c) ? '' : m));
}

// ---------------------------------------------------------------------------
// Tokenizer

function tokenize(src) {
    const n = src.length;
    const toks = [];
    let i = 0;

    while (i < n) {
        const c = src.charCodeAt(i);

        // whitespace
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) { i++; continue; }

        // (* nested comment *)
        if (c === 40 /* ( */ && src.charCodeAt(i + 1) === 42 /* * */) {
            let depth = 1;
            i += 2;
            while (i < n && depth > 0) {
                const a = src.charCodeAt(i);
                if (a === 40 && src.charCodeAt(i + 1) === 42) { depth++; i += 2; }
                else if (a === 42 && src.charCodeAt(i + 1) === 41) { depth--; i += 2; }
                else i++;
            }
            continue;
        }

        // "string"
        if (c === 34 /* " */) {
            const start = i;
            i++;
            while (i < n) {
                const a = src.charCodeAt(i);
                if (a === 92 /* \ */) {
                    // skip the escaped character (\r\n counts as one)
                    if (src.charCodeAt(i + 1) === 13 && src.charCodeAt(i + 2) === 10) i += 3;
                    else i += 2;
                    continue;
                }
                if (a === 34) { i++; break; }
                i++;
            }
            const body = stripFolds(src.slice(start + 1, i - 1));
            toks.push({ k: K_STR, v: decodeWlString(src.slice(start + 1, i - 1)), raw: body, s: start, e: i });
            continue;
        }

        // number
        if (isDigit(c) || (c === 46 /* . */ && isDigit(src.charCodeAt(i + 1)))) {
            const start = i;
            while (i < n && isDigit(src.charCodeAt(i))) i++;
            if (i < n && src.charCodeAt(i) === 46 && !(src.charCodeAt(i + 1) === 46)) {
                i++;
                while (i < n && isDigit(src.charCodeAt(i))) i++;
            }
            // base^^digits
            if (src.charCodeAt(i) === 94 && src.charCodeAt(i + 1) === 94) {
                i += 2;
                while (i < n && (isDigit(src.charCodeAt(i)) || isLetter(src.charCodeAt(i)) || src.charCodeAt(i) === 46)) i++;
            }
            // `precision  /  ``accuracy
            if (src.charCodeAt(i) === 96) {
                i++;
                if (src.charCodeAt(i) === 96) i++;
                while (i < n && (isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 46)) i++;
            }
            // *^exponent
            if (src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 94) {
                i += 2;
                if (src.charCodeAt(i) === 45 || src.charCodeAt(i) === 43) i++;
                while (i < n && isDigit(src.charCodeAt(i))) i++;
            }
            toks.push({ k: K_NUM, v: src.slice(start, i), s: start, e: i });
            continue;
        }

        // symbol (incl. \[Name] and context marks)
        if (isSymStart(c) || (c === 92 /* \ */ && src.charCodeAt(i + 1) === 91 /* [ */)) {
            const start = i;
            for (;;) {
                const a = src.charCodeAt(i);
                if (a === 92 && src.charCodeAt(i + 1) === 91) {
                    const close = src.indexOf(']', i + 2);
                    if (close === -1) { i = n; break; }
                    i = close + 1;
                    continue;
                }
                if (i < n && isSymChar(a)) { i++; continue; }
                break;
            }
            toks.push({ k: K_SYM, v: src.slice(start, i), s: start, e: i });
            continue;
        }

        // slot: #, #2, ##, ##3
        if (c === 35 /* # */) {
            const start = i;
            i++;
            if (src.charCodeAt(i) === 35) i++;
            while (i < n && isDigit(src.charCodeAt(i))) i++;
            toks.push({ k: K_SYM, v: src.slice(start, i), s: start, e: i });
            continue;
        }

        // punctuation
        const ch = src[i];
        if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === '(' || ch === ')' || ch === ',') {
            toks.push({ k: K_PUNCT, v: ch, s: i, e: i + 1 });
            i++;
            continue;
        }

        // operator
        let matched = null;
        for (const op of OPERATORS) {
            if (src.startsWith(op, i)) { matched = op; break; }
        }
        if (matched) {
            toks.push({ k: K_OP, v: matched, s: i, e: i + matched.length });
            i += matched.length;
            continue;
        }

        // anything else: emit as a single-char operator so recovery can skip it
        toks.push({ k: K_OP, v: ch, s: i, e: i + 1 });
        i++;
    }

    toks.push({ k: K_EOF, v: '', s: n, e: n });
    return toks;
}

// ---------------------------------------------------------------------------
// Parser

class ParseError extends Error {
    constructor(message, pos) { super(message); this.pos = pos; }
}

class Parser {
    constructor(src, toks) {
        this.src = src;
        this.toks = toks;
        this.i = 0;
        this.depth = 0;
        this.recoveries = 0;
    }

    peek()  { return this.toks[this.i]; }
    next()  { return this.toks[this.i++]; }
    isPunct(v) { const t = this.toks[this.i]; return t.k === K_PUNCT && t.v === v; }
    isOp(v)    { const t = this.toks[this.i]; return t.k === K_OP && t.v === v; }
    fail(msg)  { const t = this.peek(); throw new ParseError(msg + ' near "' + String(t.v).slice(0, 24) + '"', t.s); }

    parseExpr() {
        if (++this.depth > MAX_DEPTH) { this.depth--; throw new ParseError('expression nested too deeply', this.peek().s); }
        try { return this.parseRule(); }
        finally { this.depth--; }
    }

    parseRule() {
        const lhs = this.parseAdd();
        if (this.isOp('->') || this.isOp(':>')) {
            const delayed = this.next().v === ':>';
            return { t: 'rule', lhs, rhs: this.parseRule(), delayed };
        }
        return lhs;
    }

    parseAdd() {
        let lhs = this.parseMul();
        while (this.isOp('+') || this.isOp('-')) {
            const op = this.next().v;
            lhs = { t: 'infix', op, lhs, rhs: this.parseMul() };
        }
        return lhs;
    }

    parseMul() {
        let lhs = this.parsePower();
        for (;;) {
            if (this.isOp('*') || this.isOp('/')) {
                const op = this.next().v;
                lhs = { t: 'infix', op, lhs, rhs: this.parsePower() };
            } else if (this.startsPrimary()) {
                // implicit multiplication: `1.5 Inherited`, `2 x`
                lhs = { t: 'infix', op: '*', implicit: true, lhs, rhs: this.parsePower() };
            } else break;
        }
        return lhs;
    }

    /** True when the next token could begin a primary expression — used to
     *  detect WL's space-separated implicit multiplication. */
    startsPrimary() {
        const t = this.peek();
        if (t.k === K_STR || t.k === K_NUM || t.k === K_SYM) return true;
        return t.k === K_PUNCT && (t.v === '{' || t.v === '(');
    }

    parsePower() {
        const base = this.parseUnary();
        if (this.isOp('^')) {
            this.next();
            return { t: 'infix', op: '^', lhs: base, rhs: this.parsePower() };
        }
        return base;
    }

    parseUnary() {
        if (this.isOp('-') || this.isOp('+')) {
            const op = this.next().v;
            return { t: 'prefix', op, arg: this.parseUnary() };
        }
        return this.parsePostfix();
    }

    parsePostfix() {
        let node = this.parsePrimary();
        for (;;) {
            if (this.isPunct('[')) {
                this.next();
                const args = this.parseArgs(']');
                node = (node.t === 'sym') ? { t: 'call', head: node.name, args }
                                          : { t: 'apply', fn: node, args };
            } else if (this.isOp('&')) {          // Function shorthand: expr&
                this.next();
                node = { t: 'function', arg: node };
            } else break;
        }
        return node;
    }

    parsePrimary() {
        const t = this.peek();
        switch (t.k) {
            case K_STR: this.next(); return { t: 'str', value: t.v, raw: t.raw };
            case K_NUM: this.next(); return { t: 'num', raw: t.v };
            case K_SYM: this.next(); return { t: 'sym', name: t.v };
            case K_PUNCT:
                if (t.v === '{') { this.next(); return { t: 'list', items: this.parseArgs('}') }; }
                if (t.v === '(') {
                    this.next();
                    const inner = this.parseExpr();
                    if (this.isPunct(')')) this.next(); else this.fail('expected )');
                    return { t: 'paren', arg: inner };
                }
                break;
        }
        this.fail('unexpected token');
    }

    /** Parse a comma-separated argument list, consuming the closing bracket.
     *  An argument that fails to parse becomes a {t:'raw'} node. */
    parseArgs(closer) {
        const args = [];
        if (this.isPunct(closer)) { this.next(); return args; }

        for (;;) {
            const startIdx = this.i;
            let node;
            try {
                node = this.parseExpr();
            } catch (e) {
                if (!(e instanceof ParseError)) throw e;
                node = this.recoverArg(startIdx, closer);
            }

            if (!this.isPunct(',') && !this.isPunct(closer) && this.peek().k !== K_EOF) {
                // parsed something, but the argument did not end where it should
                const extra = this.recoverArg(startIdx, closer);
                node = extra;
            }
            args.push(node);

            if (this.isPunct(',')) { this.next(); continue; }
            if (this.isPunct(closer)) { this.next(); break; }
            if (this.peek().k === K_EOF) throw new ParseError('unexpected end of file', this.peek().s);
        }
        return args;
    }

    /** Skip forward to the next top-level comma or the closing bracket, and
     *  return the skipped source verbatim. Always makes progress. */
    recoverArg(startIdx, closer) {
        this.recoveries++;
        let depth = 0;
        let j = startIdx;
        const toks = this.toks;
        for (;;) {
            const t = toks[j];
            if (t.k === K_EOF) break;
            if (t.k === K_PUNCT) {
                if (t.v === '[' || t.v === '{' || t.v === '(') depth++;
                else if (t.v === ']' || t.v === '}' || t.v === ')') {
                    if (depth === 0 && t.v === closer) break;
                    depth--;
                    if (depth < 0) break;
                } else if (t.v === ',' && depth === 0) break;
            }
            j++;
        }
        if (j === startIdx) j++;                     // never stall
        this.i = j;
        const from = toks[startIdx].s;
        const to   = toks[j - 1] ? toks[j - 1].e : from;
        return { t: 'raw', text: this.src.slice(from, to) };
    }
}

// ---------------------------------------------------------------------------
// Printer

function printInputForm(node) {
    if (!node) return '';
    switch (node.t) {
        case 'call':   return node.head + '[' + node.args.map(printInputForm).join(', ') + ']';
        case 'apply':  return printInputForm(node.fn) + '[' + node.args.map(printInputForm).join(', ') + ']';
        case 'list':   return '{' + node.items.map(printInputForm).join(', ') + '}';
        case 'sym':    return node.name;
        case 'str':    return '"' + node.raw + '"';
        case 'num':    return node.raw;
        case 'rule':   return printInputForm(node.lhs) + (node.delayed ? ' :> ' : ' -> ') + printInputForm(node.rhs);
        case 'infix':  return printInputForm(node.lhs) + (node.implicit ? ' ' : ' ' + node.op + ' ') + printInputForm(node.rhs);
        case 'function': return printInputForm(node.arg) + '&';
        case 'prefix': return node.op + printInputForm(node.arg);
        case 'paren':  return '(' + printInputForm(node.arg) + ')';
        case 'raw':    return node.text;
        default:       return '';
    }
}

// ---------------------------------------------------------------------------
// Public API

function lineOf(src, pos) {
    let line = 1;
    for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
    return line;
}

/** Parse a single expression from `text`. */
function parseExpr(text) {
    try {
        const p = new Parser(text, tokenize(text));
        const ast = p.parseExpr();
        return { ok: true, ast, recoveries: p.recoveries };
    } catch (e) {
        return { ok: false, error: { message: e.message, pos: e.pos || 0, line: lineOf(text, e.pos || 0) } };
    }
}

/** Locate and parse the top-level Notebook[...] expression of a .nb file. */
function parseNotebookSource(text) {
    let toks;
    try { toks = tokenize(text); }
    catch (e) { return { ok: false, error: { message: 'tokenizer failed: ' + e.message, pos: 0, line: 1 } }; }

    let start = -1;
    for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].k === K_SYM && toks[i].v === 'Notebook' &&
            toks[i + 1].k === K_PUNCT && toks[i + 1].v === '[') { start = i; break; }
    }
    if (start === -1) {
        return { ok: false, error: { message: 'no Notebook[...] expression found', pos: 0, line: 1 } };
    }

    const p = new Parser(text, toks);
    p.i = start;
    try {
        const ast = p.parseExpr();
        return { ok: true, ast, recoveries: p.recoveries };
    } catch (e) {
        return { ok: false, error: { message: e.message, pos: e.pos || 0, line: lineOf(text, e.pos || 0) } };
    }
}

module.exports = {
    parseNotebookSource,
    parseExpr,
    printInputForm,
    // exported for tests
    tokenize,
    decodeWlString,
    stripFolds,
    K_EOF, K_STR, K_NUM, K_SYM, K_PUNCT, K_OP,
};
