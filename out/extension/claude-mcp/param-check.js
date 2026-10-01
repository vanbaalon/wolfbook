'use strict';
// Argument check for MCP tools/call — pure, vscode-free.
//
// A tool that silently ignores a parameter it does not know answers a question
// nobody asked: editCell(old_string, new_string) said ok:true and changed
// nothing, getNotebookContext(start, end) returned the whole notebook. So:
//   1. a spelling that differs from a declared parameter only in case or
//      underscores (cell_id, after_cell_id, start_cell) is renamed to it;
//   2. a few explicit short forms are renamed (start/end → startCell/endCell);
//   3. a name some OTHER Wolfbook tool declares is let through (shared
//      helpers read those across tools — e.g. busyPolicy — so refusing them
//      would break working callers);
//   4. anything else is an error that names the valid parameters.

// Routing and transport parameters the server itself consumes.
const ROUTING = new Set(['client_id', 'kernel_id', 'notebook']);

// Undeclared names the tool code still reads (legacy aliases kept working).
// Found by scanning every `input.X` / `args.X` read against package.json.
const LEGACY_TOLERATED = new Set([
    'afterCellNumber', 'cellIndex', 'cell_index', 'newContent', 'newSource', 'newInput',
    'newKind', 'previewChars', 'longForm', 'index', 'replace', 'code', 'text', 'direction',
    'eprint', 'texkey', 'categories', 'withinSection', 'docId', 'baseVersion', 'contentHash',
    'cellVersion', 'channels', 'consent_to_publish', 'stealFocus', 'newChat', 'extensionId',
    'evalId', 'subId', 'afterSeq', 'uri', 'operationId', 'refId', 'detail', 'force',
]);

// Per-tool short forms that do not normalise onto the declared name.
const EXPLICIT_ALIASES = {
    // `mode` is declared by cancelOperation, so without this alias it would be
    // tolerated and ignored — mode:"brief" returned the full 127 k-char notebook.
    wolfbook_getNotebookContext: { start: 'startCell', end: 'endCell', from: 'startCell', to: 'endCell', mode: 'action' },
    wolfbook_runCell: { start: 'startCell', end: 'endCell' },
    wolfbook_editCell: { source: 'content', find: 'old_string', replace_with: 'new_string', run: 'evaluate' },
    wolfbook_insertCells: { source: 'content', run: 'evaluate' },
};

const norm = key => String(key).replace(/[_\-\s]/g, '').toLowerCase();

// A client that does not know a parameter's type sends it as a string —
// run:"false" became evaluate:"false", which is truthy, and editCell ran the
// cell it was told not to. Strings that spell a boolean or a number are
// turned into one when the schema says so; anything else is left alone.
function coerceToSchema(value, prop) {
    if (!prop || typeof prop !== 'object') return value;
    if (typeof value === 'string') {
        const v = value.trim();
        if (prop.type === 'boolean') {
            if (/^true$/i.test(v)) return true;
            if (/^false$/i.test(v)) return false;
        } else if ((prop.type === 'number' || prop.type === 'integer') && v !== '' && Number.isFinite(Number(v))) {
            return Number(v);
        }
        return value;
    }
    if (Array.isArray(value) && prop.type === 'array' && prop.items) {
        return value.map(item => coerceToSchema(item, prop.items));
    }
    if (value && typeof value === 'object' && prop.type === 'object' && prop.properties) {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = coerceToSchema(v, prop.properties[k]);
        return out;
    }
    return value;
}

/**
 * @param {string} toolName
 * @param {object} args          tools/call arguments (not mutated)
 * @param {object|null} schema   the tool's inputSchema
 * @param {Set<string>} [knownAnywhere]  parameter names declared by any tool
 * @returns {{ args: object, renamed: Array<[string,string]>, unknown: string[], valid: string[] }}
 */
function checkToolArguments(toolName, args, schema, knownAnywhere = null) {
    const props = schema && schema.type === 'object' && schema.properties ? schema.properties : null;
    if (!props || !args || typeof args !== 'object' || Array.isArray(args)) {
        return { args, renamed: [], unknown: [], valid: [] };
    }
    const declared = Object.keys(props);
    const byNorm = new Map(declared.map(k => [norm(k), k]));
    const explicit = EXPLICIT_ALIASES[toolName] || {};
    const out = {};
    const renamed = [];
    const unknown = [];
    for (const [key, value] of Object.entries(args)) {
        if (Object.prototype.hasOwnProperty.call(props, key)) {
            out[key] = coerceToSchema(value, props[key]);
            continue;
        }
        if (key.startsWith('_') || ROUTING.has(key)) {
            out[key] = value;
            continue;
        }
        const target = (explicit[key] && props[explicit[key]] ? explicit[key] : null) || byNorm.get(norm(key));
        if (target && !Object.prototype.hasOwnProperty.call(args, target)) {
            out[target] = coerceToSchema(value, props[target]);
            renamed.push([key, target]);
            continue;
        }
        if (LEGACY_TOLERATED.has(key) || knownAnywhere?.has(key)) { out[key] = value; continue; }
        unknown.push(key);
    }
    return { args: out, renamed, unknown, valid: declared };
}

function unknownParameterMessage(toolName, unknown, valid) {
    return `${toolName}: unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map(k => `"${k}"`).join(', ')} — ` +
        'nothing was done. Valid parameters: ' + valid.join(', ') + ' (plus client_id, kernel_id for routing).';
}

module.exports = { checkToolArguments, coerceToSchema, unknownParameterMessage, LEGACY_TOLERATED, EXPLICIT_ALIASES };
