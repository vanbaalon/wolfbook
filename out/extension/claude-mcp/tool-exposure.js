'use strict';

// Which tools a session sees in tools/list — the "reveal on demand" policy.
//
// Popular tools are always listed. Rarely used ones belong to a FAMILY and are
// listed only when (a) the family is context-driven and its context is present
// (a .wslide deck / .tex paper is open in some Wolfbook window), or (b) the
// agent asked for it with wolfbook_tools {action:"enable"}. Nothing is removed:
// tools/call still resolves every name, and wolfbook_tools {action:"call"}
// reaches any tool even from a client that never refreshes its list.
//
// Families come from package.json languageModelTools tags: `mcp:family:<id>`.
// A tool without a family tag is core. Measured basis (8 days, 1 395 calls):
// Internal Docs/misc/MCP_TOOL_AUDIT_2026-09-25.md.
//
// vscode-free: unit-tested by kernel/tests/stability-tool-exposure.test.js.

const FAMILIES = Object.freeze({
    slides: {
        summary: 'Inspect and edit .wslide decks: fit report, slide and block edits, save.',
        context: 'slides',
    },
    slides_more: {
        summary: 'Rarer deck operations: block/arrange/theme, delete/move/duplicate/copy slides, undo/reload/export, eval blocks, image dimensions.',
    },
    paper: {
        summary: "Read and edit the user's .tex paper by semantic object, with guarded edits.",
        context: 'paper',
    },
    paper_more: {
        summary: 'Section fetch, cross-reference audit, %Mathematica block status, legacy LaTeX build.',
    },
    notebook_more: {
        summary: 'Search/move cells, restore deleted cells, symbol inspection, syntax check, show an image, agent notes, session report, legacy wait.',
    },
    debug: {
        summary: 'Step-through debugger, kernel crash logs, end-to-end self-test.',
    },
    research: {
        summary: 'Published-literature search (INSPIRE/arXiv), Wolfram package search, SkilXiv skills.',
    },
    human: {
        summary: 'Blocking pop-ups that ask the user: approve a plan, choose an option, confirm a step, ask a specialist.',
    },
    oberon: {
        summary: 'Oberon Fairy sub-agent and the gold benchmark suite (developer tools, cost real money).',
    },
});

// Synthetic tools are built in server.js, not declared in package.json.
const SYNTHETIC_FAMILY = Object.freeze({
    wolfbook_tools: null,
    wolfbook_list_clients: null,
    wolfbook_setTarget: null,
    wolfbook_waitEvaluation: 'notebook_more',
});

// Tools that must not be reachable over MCP at all. They duplicated the host
// agent's own shell/file tools while bypassing its permission and sandbox model.
const REMOVED_TOOLS = Object.freeze({
    wolfbook_runTerminal: 'Removed: use your own shell tool — it runs under your permission and sandbox rules.',
    wolfbook_fileOps: 'Removed: use your own file tools. For notebooks use the wolfbook cell tools; never write .wb files directly.',
});

const tagsOf = t => (Array.isArray(t?.tags) ? t.tags : []);

function familyOf(tool) {
    if (!tool) return null;
    if (Object.prototype.hasOwnProperty.call(SYNTHETIC_FAMILY, tool.name)) return SYNTHETIC_FAMILY[tool.name];
    const tag = tagsOf(tool).find(t => t.startsWith('mcp:family:'));
    return tag ? tag.slice('mcp:family:'.length) : null;
}

/**
 * Is `tool` listed for a session?
 * @param {object} tool       schema entry {name, tags}
 * @param {object} state      { profile, context:{slides,paper}, families:Set, tools:Set, exposeDeprecated }
 * @param {function} legacy   (tool, profile) => bool — the pre-families profile rules
 */
function isListed(tool, state, legacy) {
    const tags = tagsOf(tool);
    if (REMOVED_TOOLS[tool.name]) return false;
    if (tags.includes('mcp:hidden')) return false;
    if (tags.includes('mcp:deprecated') && !state.exposeDeprecated) return false;
    const profile = state.profile || 'auto';
    if (profile === 'full') return true;
    const family = familyOf(tool);
    const asked = (state.tools && state.tools.has(tool.name)) ||
        (family && state.families && state.families.has(family));
    if (asked) return true;
    if (profile === 'auto') {
        if (!family) return true;
        const ctx = FAMILIES[family]?.context;
        return !!(ctx && state.context && state.context[ctx]);
    }
    return legacy ? legacy(tool, profile) : !family;
}

/** Human/agent-facing catalogue for wolfbook_tools {action:"list"}. */
function catalogue(schemas, state) {
    const byFamily = new Map();
    for (const t of schemas) {
        if (REMOVED_TOOLS[t.name] || tagsOf(t).includes('mcp:hidden')) continue;
        const f = familyOf(t);
        if (!f) continue;
        if (!byFamily.has(f)) byFamily.set(f, []);
        byFamily.get(f).push(t.name);
    }
    const lines = [];
    for (const [id, meta] of Object.entries(FAMILIES)) {
        const names = byFamily.get(id) || [];
        if (!names.length) continue;
        const on = state.families?.has(id) ? 'enabled'
            : (meta.context && state.context?.[meta.context]) ? `auto (a ${meta.context === 'slides' ? '.wslide deck' : '.tex paper'} is open)`
            : 'off';
        lines.push(`${id} [${on}] — ${meta.summary}\n  ${names.join(', ')}`);
    }
    return lines.join('\n');
}

/** Resolve an enable/disable request into family ids and tool names. */
function resolveRequest(schemas, families, tools) {
    const known = new Set(schemas.map(t => t.name).concat(Object.keys(SYNTHETIC_FAMILY)));
    const fams = [], names = [], unknown = [];
    for (const f of [].concat(families || [])) {
        if (FAMILIES[f]) fams.push(f); else unknown.push(f);
    }
    for (const n of [].concat(tools || [])) {
        if (REMOVED_TOOLS[n]) unknown.push(`${n} (removed)`);
        else if (known.has(n)) names.push(n);
        else if (FAMILIES[n]) fams.push(n);    // a family passed as a tool name
        else unknown.push(n);
    }
    return { families: fams, tools: names, unknown };
}

/** Compact one-line-per-tool definitions, for the reply to an enable request. */
function brief(schema) {
    const first = String(schema.description || '').replace(/\s+/g, ' ').trim();
    const sentence = (first.match(/^.*?[.!?](\s|$)/) || [first])[0].trim();
    const params = Object.keys(schema.inputSchema?.properties || {})
        .filter(p => p !== 'client_id' && p !== 'kernel_id');
    return `${schema.name}(${params.join(', ')}) — ${sentence}`;
}

module.exports = { FAMILIES, SYNTHETIC_FAMILY, REMOVED_TOOLS, familyOf, isListed, catalogue, resolveRequest, brief };
