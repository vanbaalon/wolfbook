'use strict';

/**
 * Repair only backslashes that are illegal inside JSON strings.
 *
 * Early .wb writers stored Wolfram named characters as `\[Alpha]` instead of
 * JSON's required `\\[Alpha]`. JSON.parse rejects the whole notebook, and the
 * old serializer then presented it as zero cells. Valid JSON escapes — notably
 * `\\u2014` versus a literal `\\\\u2014` — are left byte-semantically intact.
 */
function escapeInvalidJsonBackslashes(raw) {
    const text = String(raw);
    let out = '', inString = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (!inString) {
            out += ch;
            if (ch === '"') inString = true;
            continue;
        }
        if (ch === '"') { out += ch; inString = false; continue; }
        if (ch !== '\\') { out += ch; continue; }

        const next = text[i + 1];
        if (next && '"\\/bfnrt'.includes(next)) {
            out += ch + next;
            i++;
            continue;
        }
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            out += text.slice(i, i + 6);
            i += 5;
            continue;
        }
        // Emit two backslashes in the repaired JSON. The following character
        // is processed normally on the next iteration.
        out += '\\\\';
    }
    return out;
}

function parseNotebookJson(raw) {
    try { return JSON.parse(String(raw)); }
    catch (originalError) {
        const repaired = escapeInvalidJsonBackslashes(raw);
        if (repaired === String(raw)) throw originalError;
        return JSON.parse(repaired);
    }
}

module.exports = { escapeInvalidJsonBackslashes, parseNotebookJson };
