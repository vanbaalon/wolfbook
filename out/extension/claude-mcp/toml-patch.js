'use strict';
// ---------------------------------------------------------------------------
// Minimal, conservative TOML edit: make sure `[table] key = [ "…", … ]` holds
// some strings, leaving everything else in the file byte-for-byte alone.
//
// Used for ~/.claude-science/config.toml, which belongs to another app — so it
// refuses (throws) on any layout it does not fully understand (dotted keys,
// inline tables, a non-array value) instead of guessing. The caller then shows
// the user the snippet to paste by hand.
// ---------------------------------------------------------------------------

const HEADER_RE = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/;

function _normTable(raw) {
    return raw.split('.').map(p => p.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')).join('.');
}

function tomlString(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Parse the array literal starting at text[i] === '['. Returns { values, end } (end = index after ']'). */
function _parseStringArray(text, i) {
    if (text[i] !== '[') throw new Error('value is not an array');
    const values = [];
    let j = i + 1;
    while (j < text.length) {
        const c = text[j];
        if (c === ']') return { values, end: j + 1 };
        if (c === '#') { while (j < text.length && text[j] !== '\n') j++; continue; }
        if (/[\s,]/.test(c)) { j++; continue; }
        if (c === "'") {
            const k = text.indexOf("'", j + 1);
            if (k < 0) throw new Error('unterminated string');
            values.push(text.slice(j + 1, k)); j = k + 1; continue;
        }
        if (c === '"') {
            let out = '', k = j + 1;
            for (; k < text.length && text[k] !== '"'; k++) {
                if (text[k] === '\\') {
                    const n = text[++k];
                    if (n === 'u' || n === 'U') {
                        const len = n === 'u' ? 4 : 8;
                        out += String.fromCodePoint(parseInt(text.slice(k + 1, k + 1 + len), 16));
                        k += len;
                    } else out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' })[n] ?? n;
                } else out += text[k];
            }
            if (k >= text.length) throw new Error('unterminated string');
            values.push(out); j = k + 1; continue;
        }
        throw new Error('array holds a non-string value');
    }
    throw new Error('unterminated array');
}

/**
 * Ensure `values` are all present in `[table] key`. Returns { text, changed, added }.
 * Throws when the file uses a layout this function will not edit safely.
 */
function ensureStringArray(text, table, key, values) {
    text = String(text || '');
    const lines = text.split('\n');
    // Locate headers. `[[array.of.tables]]` never matches HEADER_RE (it needs [^\[\]]).
    const headers = [];
    lines.forEach((ln, idx) => {
        const m = HEADER_RE.exec(ln);
        if (m && !/^\s*\[\[/.test(ln)) headers.push({ idx, name: _normTable(m[1]) });
    });
    // Refuse alternative spellings of the same data we cannot merge with.
    const top = table.split('.')[0];
    const firstHeader = headers.length ? headers[0].idx : lines.length;
    for (let i = 0; i < firstHeader; i++) {
        if (new RegExp(`^\\s*${top}\\s*[.=]`).test(lines[i])) {
            throw new Error(`"${top}" is set with a dotted key or inline table at the top of the file`);
        }
    }
    const parts = table.split('.');
    for (let d = 1; d < parts.length; d++) {
        const parent = parts.slice(0, d).join('.');
        const child = parts[d];
        const ph = headers.find(h => h.name === parent);
        if (!ph) continue;
        const next = headers.find(h => h.idx > ph.idx);
        for (let i = ph.idx + 1; i < (next ? next.idx : lines.length); i++) {
            if (new RegExp(`^\\s*${child}\\s*[.=]`).test(lines[i])) {
                throw new Error(`"${table}" is set with a dotted key or inline table inside [${parent}]`);
            }
        }
    }
    const matching = headers.filter(h => h.name === table);
    if (matching.length > 1) throw new Error(`[${table}] appears more than once`);

    const want = [...new Set(values.map(String))];
    if (!matching.length) {
        const block = `[${table}]\n${key} = [${want.map(tomlString).join(', ')}]\n`;
        const base = text.replace(/\s*$/, '');
        return { text: base ? `${base}\n\n${block}` : block, changed: true, added: want };
    }

    const start = matching[0].idx;
    const next = headers.find(h => h.idx > start);
    const end = next ? next.idx : lines.length;
    // Offsets of each line in the original text.
    const offsets = []; let off = 0;
    for (const ln of lines) { offsets.push(off); off += ln.length + 1; }
    const keyRe = new RegExp(`^(\\s*)${key}\\s*=\\s*`);
    for (let i = start + 1; i < end; i++) {
        const m = keyRe.exec(lines[i]);
        if (!m) continue;
        const valueAt = offsets[i] + m[0].length;
        const { values: have, end: valueEnd } = _parseStringArray(text, valueAt);
        const added = want.filter(v => !have.includes(v));
        if (!added.length) return { text, changed: false, added: [] };
        const merged = [...have, ...added];
        const replacement = `${m[1]}${key} = [${merged.map(tomlString).join(', ')}]`;
        return { text: text.slice(0, offsets[i]) + replacement + text.slice(valueEnd), changed: true, added };
    }
    // Table exists without the key: add it after the table's last non-blank line.
    let insertAfter = start;
    for (let i = start + 1; i < end; i++) if (lines[i].trim()) insertAfter = i;
    lines.splice(insertAfter + 1, 0, `${key} = [${want.map(tomlString).join(', ')}]`);
    return { text: lines.join('\n'), changed: true, added: want };
}

/** Read `[table] key` as a string array ([] when absent). Throws on an unreadable layout. */
function readStringArray(text, table, key) {
    const probe = ensureStringArray(text, table, key, []);
    if (probe.changed) return [];   // table or key absent
    const lines = String(text).split('\n');
    let inTable = false;
    let off = 0;
    for (const ln of lines) {
        const m = HEADER_RE.exec(ln);
        if (m && !/^\s*\[\[/.test(ln)) inTable = _normTable(m[1]) === table;
        else if (inTable) {
            const km = new RegExp(`^\\s*${key}\\s*=\\s*`).exec(ln);
            if (km) return _parseStringArray(String(text), off + km[0].length).values;
        }
        off += ln.length + 1;
    }
    return [];
}

module.exports = { ensureStringArray, readStringArray, tomlString };
