'use strict';
// Built-ins shadowed by a scoping construct's local variable — pure, vscode-free.
//
//   Module[{cd, N = 7, rules}, … N[Abs[x], 3] …]
//
// is legal, and the kernel says nothing: N[Abs[x], 3] simply becomes
// 7[Abs[x], 3], which TraditionalForm draws as 7(x, 3). A field report
// (feedbac10, 2026-09-30) read that as a rendering bug. Warn instead.

// Functions whose shadowing breaks a call inside the scope, and constants
// whose shadowing silently changes arithmetic.
const FUNCTIONS = new Set(['N', 'D', 'O', 'C', 'Dt', 'Re', 'Im', 'Tr', 'Det', 'Max', 'Min', 'Sum',
    'Product', 'Log', 'Exp', 'Gamma', 'Beta', 'Zeta', 'Abs', 'Sqrt', 'Sin', 'Cos', 'Series', 'Limit']);
// A local named E or I is often just a variable (E = Table[…]); flag it only
// where it is used AS the constant.
const CONSTANT_USE = {
    E: /(?<![A-Za-z0-9$`])E\s*\^/,
    I: /(?:\d\s*\*?\s*I|(?<![A-Za-z0-9$`])I\s*\*\s*[\dA-Za-z(])(?![A-Za-z0-9$`])/,
    Pi: /(?<![A-Za-z0-9$`])Pi(?![A-Za-z0-9$`])/,
};
const CONSTANTS = new Set(Object.keys(CONSTANT_USE));
const SCOPES = /\b(Module|Block|With|DynamicModule)\s*\[\s*\{/g;

// Blank out strings and (* comments *) so neither can match; offsets are kept.
function _mask(src) {
    const out = src.split('');
    let i = 0, depth = 0;
    while (i < src.length) {
        if (depth === 0 && src[i] === '"') {
            out[i] = ' '; i++;
            while (i < src.length && src[i] !== '"') {
                if (src[i] === '\\') { out[i] = ' '; i++; }
                if (i < src.length) { if (src[i] !== '\n') out[i] = ' '; i++; }
            }
            if (i < src.length) { out[i] = ' '; i++; }
            continue;
        }
        if (src[i] === '(' && src[i + 1] === '*') { depth++; out[i] = out[i + 1] = ' '; i += 2; continue; }
        if (depth > 0 && src[i] === '*' && src[i + 1] === ')') { depth--; out[i] = out[i + 1] = ' '; i += 2; continue; }
        if (depth > 0 && src[i] !== '\n') out[i] = ' ';
        i++;
    }
    return out.join('');
}

// Index just past the bracket that closes the one opened at `open`.
function _close(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        const c = s[i];
        if (c === '[' || c === '{' || c === '(') depth++;
        else if (c === ']' || c === '}' || c === ')') { if (--depth === 0) return i + 1; }
    }
    return s.length;
}

/**
 * @param {string} src  cell source
 * @returns {Array<{name, scope, offset, length, useOffset, message}>}
 */
function findShadowedBuiltins(src) {
    const s = _mask(String(src || ''));
    const found = [];
    SCOPES.lastIndex = 0;
    let m;
    while ((m = SCOPES.exec(s))) {
        const listOpen = m.index + m[0].length - 1;
        const listEnd = _close(s, listOpen);
        const callEnd = _close(s, s.indexOf('[', m.index));
        const body = s.slice(listEnd, callEnd);
        // Top-level items of the variable list.
        let depth = 0, start = listOpen + 1;
        const items = [];
        for (let i = listOpen + 1; i < listEnd - 1; i++) {
            const c = s[i];
            if (c === '[' || c === '{' || c === '(') depth++;
            else if (c === ']' || c === '}' || c === ')') depth--;
            else if (c === ',' && depth === 0) { items.push([start, i]); start = i + 1; }
        }
        items.push([start, listEnd - 1]);
        for (const [a, b] of items) {
            const item = s.slice(a, b);
            const idm = /^\s*([A-Za-z$][A-Za-z0-9$]*)\s*(?::?=|$)/.exec(item);
            if (!idm) continue;
            const name = idm[1];
            const isFn = FUNCTIONS.has(name), isConst = CONSTANTS.has(name);
            if (!isFn && !isConst) continue;
            // A function only breaks when it is CALLED inside (x[[i]] is Part on
            // the local value — fine); a constant only where used as one.
            let use;
            if (isFn) {
                // A local function the body itself defines (C[x_] := …) is deliberate.
                if (new RegExp(`(?<![A-Za-z0-9$\`])${name}\\s*\\[[^\\]]*_[^\\]]*\\]\\s*:?=`).test(body)) continue;
                use = new RegExp(`(?<![A-Za-z0-9$\`])${name}\\s*\\[(?!\\[)`).exec(body);
            } else {
                use = CONSTANT_USE[name].exec(body);
            }
            if (!use) continue;
            found.push({
                name, scope: m[1], offset: a + idm.index + idm[0].indexOf(name), length: name.length,
                useOffset: listEnd + use.index,
                message: isFn
                    ? `${m[1]} variable "${name}" shadows the built-in ${name}: ${name}[…] inside this ${m[1]} ` +
                      `calls the local value, not System\`${name} (e.g. ${name} = 7 turns ${name}[x, 3] into 7[x, 3]). Rename the variable.`
                    : `${m[1]} variable "${name}" shadows the built-in constant ${name} inside this ${m[1]}. Rename the variable.`,
            });
        }
    }
    return found;
}

module.exports = { findShadowedBuiltins, FUNCTIONS, CONSTANTS };
