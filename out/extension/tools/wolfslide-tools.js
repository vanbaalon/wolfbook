"use strict";
// Wolfslide Copilot Tools — extracted from tools/index.js
// Manipulate .wslide custom editors via AI agent tools.

const vscode = require("vscode");
const util   = require("util");
const fs     = require("fs");
const path   = require("path");
const {
    normalizeToolContent, decodeToolContent, findControlChar, getCellToolId, resolveCellIndex,
    resolveNotebookEditor, resolveNotebookDocument, checkMarkdownKaTeX,
    acquireKernelForAgent, releaseKernelForAgent, trackedKernelEvaluate,
} = require('./shared');
// decodeWstpText is used by _parseEvalResult (SVG/BOXES branches). Without this
// require, any non-graphics eval (even `1+1`, which returns a BOXES: result)
// threw "decodeWstpText is not defined" — see Day2 wslide feedback §H.
const { decodeWstpText } = require('../utils/encoding');
const { readCommittedOutputs } = require('./cell-pipeline');

// =============================================================================
// Wolfslide tools  —  manipulate .wslide custom editors
// =============================================================================

function _getSlideProvider() {
    try { return require('../slideEditorProvider').SlideEditorProvider.getInstance(); }
    catch (_) { return null; }
}
function _slideResult(text) {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
function _uid() { return Math.random().toString(36).slice(2, 10); }

/** Smooth over two common authoring papercuts on a single block (see feedback §G):
 *   • list items given as plain strings → wrapped into {type:'text', content}
 *   • eval blocks whose expression was put in `content` → aliased to `input`
 *  Idempotent; safe to call on already-normalized blocks. */
function _normalizeBlockNode(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (node.type === 'list' && Array.isArray(node.items)) {
        node.items = node.items.map(it =>
            (typeof it === 'string') ? { type: 'text', content: it } : it);
    }
    if (node.type === 'eval' && !node.input && typeof node.content === 'string') {
        node.input = node.content;
        delete node.content;
    }
}

/** Recursively apply _normalizeBlockNode across a block tree (or array of blocks).
 *  Used at insert sites that validate block shape *before* _ensureBlockIds runs. */
function _normalizeBlockTree(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(_normalizeBlockTree); return; }
    _normalizeBlockNode(node);
    if (node.children) _normalizeBlockTree(node.children);
    if (node.items)    _normalizeBlockTree(node.items);
    if (node.elements) _normalizeBlockTree(node.elements);
}

/** Recursively assign IDs to any block (or slide children) that lacks one.
 *  Also normalizes each block (list-item strings, eval content→input). */
function _ensureBlockIds(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(_ensureBlockIds); return; }
    _normalizeBlockNode(node);
    if (node.type && !node.id) node.id = _uid();
    if (node.children) _ensureBlockIds(node.children);
    if (node.items) _ensureBlockIds(node.items);
    if (node.elements) _ensureBlockIds(node.elements);
}

/** Return a Set of every block id used anywhere in the deck. */
function _collectDeckIds(deck) {
    const ids = new Set();
    (deck.slides || []).forEach(s => _collectAllBlocks(s).forEach(b => { if (b.id) ids.add(b.id); }));
    return ids;
}

/** Return [{id, slides:[...1-based slide numbers]}] for IDs that appear more than once across the deck. */
function _detectDeckDuplicateIds(deck) {
    const seen = new Map();
    (deck.slides || []).forEach((s, i) => {
        _collectAllBlocks(s).forEach(b => {
            if (!b.id) return;
            if (!seen.has(b.id)) seen.set(b.id, []);
            seen.get(b.id).push(i + 1);
        });
    });
    return [...seen.entries()].filter(([, sl]) => sl.length > 1).map(([id, slides]) => ({ id, slides }));
}

/** Mutate any block whose id already exists in existingIds, giving it a fresh uid.
 *  Appends a warning string per rename to warnings[]. */
function _freshenConflicts(existingIds, node, warnings) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => _freshenConflicts(existingIds, n, warnings)); return; }
    if (node.id && existingIds.has(node.id)) {
        const oldId = node.id;
        node.id = _uid();
        warnings.push(`Block id="${oldId}" already exists in this deck — auto-renamed to "${node.id}" to prevent duplicate`);
    }
    _freshenConflicts(existingIds, node.children, warnings);
    _freshenConflicts(existingIds, node.items, warnings);
    _freshenConflicts(existingIds, node.elements, warnings);
}

/** Recursively collect all image blocks from a slide (v2 children or v1 elements). */
function _collectImages(node) {
    if (!node) return [];
    const imgs = [];
    function walk(b) {
        if (!b) return;
        if (b.type === 'image') imgs.push(b);
        (b.children || b.items || b.elements || []).forEach(walk);
    }
    (node.children || node.elements || []).forEach(walk);
    return imgs;
}

/** Recursively collect every block in a slide. */
function _collectAllBlocks(node) {
    if (!node) return [];
    const blocks = [];
    function walk(b) {
        if (!b) return;
        blocks.push(b);
        (b.children || b.items || b.elements || []).forEach(walk);
    }
    (node.children || node.elements || []).forEach(walk);
    return blocks;
}

/** Resolve a slide from options (slideId or slideIndex), returning { deck, idx, slide, docUri } or null. */
function _resolveSlide(options) {
    const p = _getSlideProvider();
    if (!p) return null;
    const docUri = options.input?.docUri;
    const deck = p.getDeck(docUri);
    if (!deck) return null;
    let idx;
    const slideId = options.input?.slideId;
    if (slideId) {
        idx = (deck.slides || []).findIndex(s => s.id === slideId);
        if (idx === -1) return { error: `Slide with id="${slideId}" not found. Valid ids: ${deck.slides.map(s => s.id).join(', ')}` };
    } else {
        // Accept 'slideNumber' as an alias for 'slideIndex'
        const raw = options.input?.slideIndex ?? options.input?.slideNumber;
        if (raw != null) {
            idx = Number(raw) - 1;
        } else {
            // Default to the currently visible slide
            const activeEntry = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
            idx = activeEntry?.currentSlideIndex ?? 0;
        }
    }
    const slide = deck.slides?.[idx];
    if (!slide) return { error: `Slide ${idx + 1} not found (deck has ${deck.slides?.length ?? 0}).` };
    return { deck, idx, slide, docUri, p };
}

/** Recursively find a block by id in a slide, returning { block, parent, key, index } or null. */
function _findBlockRecursive(blockId, root) {
    if (!root || !blockId) return null;
    const arrays = [
        { key: 'children', arr: root.children },
        { key: 'items',    arr: root.items },
        { key: 'elements', arr: root.elements },
    ];
    for (const { key, arr } of arrays) {
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i].id === blockId) return { block: arr[i], parent: root, key, index: i };
            const found = _findBlockRecursive(blockId, arr[i]);
            if (found) return found;
        }
    }
    return null;
}

/** Recursively find a block by name field, returning { block, parent, key, index } or null. */
function _findBlockByName(name, root) {
    if (!root || !name) return null;
    const arrays = [
        { key: 'children', arr: root.children },
        { key: 'items',    arr: root.items },
        { key: 'elements', arr: root.elements },
    ];
    for (const { key, arr } of arrays) {
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i]?.name === name) return { block: arr[i], parent: root, key, index: i };
            const found = _findBlockByName(name, arr[i]);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Resolve a block by blockId or blockName across a deck.
 * Searches resolveSlide first, then all other slides.
 * Returns { found, resolvedSlide, resolvedIdx } or { error }.
 */
function _resolveBlockRef(options, r) {
    let blockId   = options.input?.blockId;
    const blockName = options.input?.blockName;
    if (!blockId && !blockName) return { error: 'blockId or blockName is required.' };

    if (blockId) {
        const found = _findBlockRecursive(blockId, r.slide);
        if (found) return { found, resolvedSlide: r.slide, resolvedIdx: r.idx };
        // Not on current slide — search all slides
        for (let si = 0; si < r.deck.slides.length; si++) {
            if (si === r.idx) continue;
            const f = _findBlockRecursive(blockId, r.deck.slides[si]);
            if (f) return { found: f, resolvedSlide: r.deck.slides[si], resolvedIdx: si };
        }
        const allIds = _collectAllBlocks(r.slide).map(b => b.id);
        return { error: `Block "${blockId}" not found on slide ${r.idx + 1}. Valid ids: ${allIds.join(', ')}` };
    }

    // blockName path
    let nameMatch = _findBlockByName(blockName, r.slide);
    if (nameMatch) return { found: nameMatch, resolvedSlide: r.slide, resolvedIdx: r.idx };
    for (let si = 0; si < r.deck.slides.length; si++) {
        if (si === r.idx) continue;
        nameMatch = _findBlockByName(blockName, r.deck.slides[si]);
        if (nameMatch) return { found: nameMatch, resolvedSlide: r.deck.slides[si], resolvedIdx: si };
    }
    return { error: `No block with name="${blockName}" found in any slide.` };
}

/** Deep merge source into target (mutates target). Arrays are replaced, not merged.
 *  A null value means "delete this key" from target.
 */
function _deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        if (source[key] === null) {
            delete target[key]; // null means "remove this property"
        } else if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
            && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
            _deepMerge(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
    return target;
}

/** Strip HTML tags and entities from a content string, return plain-text preview. */
function _stripHtml(html) {
    if (!html) return '';
    return (html + '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

/** Short human-readable label for a block — includes frag:N/- and fs:X inline. */
function _blockLabel(b) {
    const frag = b.fragmentOrder != null ? ` frag:${b.fragmentOrder}` : ' frag:-';
    const fs = b.fontSize ? ` fs:${b.fontSize}` : (b.style?.fontSize ? ` fs:${b.style.fontSize}` : '');
    const nameTag = b.name ? ` name:${b.name}` : '';
    switch (b.type) {
        case 'heading':   return `[H${b.level || 2}${frag}${fs}${nameTag}] "${_stripHtml(b.content).slice(0, 80)}"`;
        case 'text':      return `[TEXT${frag}${fs}${nameTag}] "${_stripHtml(b.content).slice(0, 80)}"`;
        case 'code':      return `[CODE${frag} ${b.language || ''}${nameTag}] "${_stripHtml(b.content).slice(0, 60)}"`;
        case 'image': {
            const dims = (b.w && b.h) ? ` ${b.w}×${b.h}` : (b.w ? ` w=${b.w}` : (b.h ? ` h=${b.h}` : ''));
            const fname = (b.src || '').split('/').pop().replace(/\?.*$/, '') || '?';
            const altStr = b.alt ? ` alt="${b.alt.slice(0, 40)}"` : ' ⚠NO-ALT';
            return `[IMG${frag}${dims}${nameTag}] src=${fname}${altStr}`;
        }
        case 'list':      return `[LIST${frag}${nameTag}] ${(b.items || []).length} items: "${_stripHtml((b.items?.[0]?.content) || '').slice(0, 50)}"`;
        case 'container': {
            const flexSrc = b.style?.flex || b.style?.width || b.flex || '';
            const flexStr = flexSrc ? ` flex:${flexSrc}` : '';
            const gap = b.gap != null ? ` gap:${typeof b.gap === 'number' ? b.gap + 'px' : b.gap}`
                       : (b.style?.gap ? ` gap:${b.style.gap}` : '');
            const pad = b.padding != null ? ` pad:${typeof b.padding === 'number' ? b.padding + 'px' : b.padding}`
                      : (b.style?.padding ? ` pad:${b.style.padding}` : '');
            const align = (b.alignItems || b.style?.alignItems)
                         ? ` align:${b.alignItems || b.style.alignItems}` : '';
            const grid = b.style?.gridTemplateColumns ? ` grid(${b.style.gridTemplateColumns})` : '';
            const cn = b.className ? ` .${b.className}` : '';
            return `[CONT${frag} ${b.layout || 'col'}${flexStr}${gap}${pad}${align}${grid}${cn}${nameTag}]`;
        }
        case 'box': {
            const preview = _stripHtml(b.content).slice(0, 60);
            const cn = b.className ? ` .${b.className}` : '';
            // Show key style properties so agents can detect styling (gradient vs class-based)
            const styleBits = [];
            if (b.style?.background || b.style?.backgroundColor)
                styleBits.push(`bg:${(b.style.background || b.style.backgroundColor).slice(0, 40)}`);
            if (b.style?.color) styleBits.push(`color:${b.style.color}`);
            if (b.style?.borderRadius) styleBits.push(`r:${b.style.borderRadius}`);
            if (b.style?.border) styleBits.push(`border:${String(b.style.border).slice(0, 30)}`);
            const styleStr = styleBits.length ? `  style{${styleBits.join(' ')}}` : '';
            return `[BOX${frag}${fs}${cn}${nameTag}]${styleStr}${preview ? ` "${preview}"` : ''}`;
        }
        case 'math':      return `[MATH${frag}${nameTag}] "${(b.content || '').slice(0, 60)}"`;
        case 'arrow':     return `[ARROW${frag}${nameTag}] (${b.x0},${b.y0})→(${b.x1},${b.y1})`;
        case 'raw':       return `[RAW${frag}${nameTag}]`;
        case 'eval': {
            const inp = (b.input || '').slice(0, 60);
            const st = b.output ? (b.output.type === 'image' ? '✓img' : b.output.type === 'error' ? '✗err' : '✓txt') : '⏳';
            return `[EVAL${frag}${nameTag} ${st}] "${inp}"`;
        }
        default:          return `[${b.type || '?'}${frag}${nameTag}]`;
    }
}

/** Positional/size annotations for a block (fragmentOrder now in _blockLabel). */
function _blockAnno(b) {
    const parts = [];
    if (b.offset && (b.offset.dx || b.offset.dy))
        parts.push(`@(${b.offset.dx >= 0 ? '+' : ''}${b.offset.dx},${b.offset.dy >= 0 ? '+' : ''}${b.offset.dy})`);
    if (b.type !== 'image' && (b.w || b.h)) {
        let dimStr = `${b.w || '?'}×${b.h || '?'}px`;
        const mw = b.style?.maxWidth; const mh = b.style?.maxHeight;
        if (mw || mh) dimStr += `(cap:${mw ? 'mW=' + mw : ''}${mh ? ' mH=' + mh : ''})`;
        parts.push(dimStr);
    }
    return parts.length ? `  [${parts.join(' ')}]` : '';
}

/**
 * Render an indented ASCII structural tree of a slide.
 * Each block shows type, frag:N, fs:X, layout props, content preview, and full id.
 */
function _asciiSlide(slide) {
    const lines = [];
    function renderBlock(b, indent) {
        const pfx = '  '.repeat(indent);
        const idTag = b.id ? `  #${b.id}` : '';
        lines.push(pfx + _blockLabel(b) + _blockAnno(b) + idTag);
        const kids = b.type !== 'list' ? (b.children || b.elements || []) : [];
        kids.forEach(k => renderBlock(k, indent + 1));
    }

    const topBlocks = slide.children || slide.elements || [];
    topBlocks.forEach(b => renderBlock(b, 0));
    return lines.join('\n');
}

// ── Theme presets ─────────────────────────────────────────────────────────
const THEME_PRESETS = {
    'academic-light': {
        label: 'Academic Light',
        description: 'Clean white/light-grey background with navy/blue accents. Good for formal talks.',
        defaultBackground: '#fafcff',
        theme: {
            navy: '#0a244a', blue: '#0064b4', cyan: '#009ac8', accent: '#be1e2d',
            editorCSS: `.gl { color: #f59e0b; } .te { color: #2dd4bf; } .ro { color: #fb7185; } .mu { color: #a78bfa; } .bl { color: #0064b4; } .re { color: #be1e2d; } .cy { color: #009ac8; }`
        }
    },
    'dark-modern': {
        label: 'Dark Modern',
        description: 'Dark #0d1117 background with gold/teal/rose palette. Ideal for tech/science talks.',
        defaultBackground: '#0d1117',
        theme: {
            navy: '#0d1117', blue: '#58a6ff', cyan: '#2dd4bf', accent: '#f59e0b',
            editorCSS: `.gl { color: #f59e0b; } .te { color: #2dd4bf; } .ro { color: #fb7185; } .mu { color: #a78bfa; } .bl { color: #58a6ff; } .re { color: #ff7b72; } .cy { color: #2dd4bf; } h1,h2,h3 { color: #f0f6fc; } p,div,li,span { color: #c9d1d9; }`
        }
    },
    'dark-navy': {
        label: 'Dark Navy',
        description: 'Deep navy #0a1628 background with bright blue/cyan/red accents. Professional & bold.',
        defaultBackground: '#0a1628',
        theme: {
            navy: '#0a1628', blue: '#3b82f6', cyan: '#22d3ee', accent: '#ef4444',
            editorCSS: `.gl { color: #fbbf24; } .te { color: #34d399; } .ro { color: #fb7185; } .mu { color: #a78bfa; } .bl { color: #3b82f6; } .re { color: #ef4444; } .cy { color: #22d3ee; } h1,h2,h3 { color: #e2e8f0; } p,div,li,span { color: #94a3b8; }`
        }
    },
    'solarized-dark': {
        label: 'Solarized Dark',
        description: 'Warm dark #002b36 background with Solarized palette. Easy on the eyes.',
        defaultBackground: '#002b36',
        theme: {
            navy: '#002b36', blue: '#268bd2', cyan: '#2aa198', accent: '#cb4b16',
            editorCSS: `.gl { color: #b58900; } .te { color: #2aa198; } .ro { color: #dc322f; } .mu { color: #6c71c4; } .bl { color: #268bd2; } .re { color: #dc322f; } .cy { color: #2aa198; } h1,h2,h3 { color: #eee8d5; } p,div,li,span { color: #93a1a1; }`
        }
    },
    'high-contrast': {
        label: 'High Contrast',
        description: 'Pure black #000 background, vivid neon accents. Maximum contrast for projectors.',
        defaultBackground: '#000000',
        theme: {
            navy: '#000000', blue: '#4fc3f7', cyan: '#00e5ff', accent: '#ff1744',
            editorCSS: `.gl { color: #fdd835; } .te { color: #69f0ae; } .ro { color: #ff5252; } .mu { color: #b388ff; } .bl { color: #4fc3f7; } .re { color: #ff1744; } .cy { color: #00e5ff; } h1,h2,h3 { color: #ffffff; } p,div,li,span { color: #e0e0e0; }`
        }
    },
    'warm-cream': {
        label: 'Warm Cream',
        description: 'Light warm #fdf6e3 background with earth tones. Soft, friendly aesthetic.',
        defaultBackground: '#fdf6e3',
        theme: {
            navy: '#3e2723', blue: '#1565c0', cyan: '#00838f', accent: '#c62828',
            editorCSS: `.gl { color: #e65100; } .te { color: #00695c; } .ro { color: #c62828; } .mu { color: #6a1b9a; } .bl { color: #1565c0; } .re { color: #c62828; } .cy { color: #00838f; } h1,h2,h3 { color: #3e2723; } p,div,li,span { color: #5d4037; }`
        }
    },
};

class WolfslideGetContextTool {
    prepareInvocation() { return { invocationMessage: 'Getting slide editor context' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        const openUris = p ? p.listOpenEditors() : [];
        const activeEntry = p ? p.getActiveEntry() : null;
        const activeUri = activeEntry?.document?.uri?.toString() ?? null;

        // Handle scope set/clear
        const scopeInput = options?.input?.scope;
        if (scopeInput !== undefined && p) {
            p.setScope(activeUri, scopeInput || null);
        }
        const currentScope = p ? p.getScope(activeUri) : null;

        const lines = [];

        // Scope banner — always first so the model can't miss it
        if (currentScope) {
            lines.push('╔══════════════════════════════════════════════════════════════╗');
            lines.push(`║  ⚑ SCOPE: ${currentScope.padEnd(52)}║`);
            lines.push('║  Work ONLY within this scope. Ignore problems outside it.   ║');
            lines.push('║  To update: wolfslide_getContext(scope:"new task")           ║');
            lines.push('║  To clear:  wolfslide_getContext(scope:"")                   ║');
            lines.push('╚══════════════════════════════════════════════════════════════╝');
            lines.push('');
        }

        lines.push('🚫 NEVER read or write .wslide files directly with file/disk tools.');
        lines.push('   All edits MUST go through wolfslide_* tools. Direct file edits bypass');
        lines.push('   the live editor state and corrupt the undo stack.');
        lines.push('');

        // Only show real file:// URIs — filter out VS Code internal virtual docs
        // (chat-editing-text-model://, chat-editing-snapshot-text-model://, etc.)
        const fileUris = openUris.filter(u => u.startsWith('file://'));
        if (fileUris.length) {
            lines.push('Open .wslide editors:');
            for (const u of fileUris) {
                const d = p.getDeck(u);
                const title = d?.meta?.title || 'Untitled';
                const count = d?.slides?.length ?? 0;
                const marker = u === activeUri ? '  [ACTIVE]' : '';
                lines.push(`  ${u}  [${count} slides, title: "${title}"]${marker}`);
            }
        } else {
            lines.push('No .wslide editors currently open.');
        }

        // Also list workspace .wslide files that are not open in the editor
        try {
            const found = await vscode.workspace.findFiles('**/*.wslide', '**/node_modules/**', 50);
            const openSet = new Set(openUris);
            const closed = found.filter(f => !openSet.has(f.toString()));
            if (closed.length) {
                lines.push('');
                lines.push('Other .wslide files in workspace (not currently open):');
                closed.forEach(f => lines.push(`  ${f.toString()}`));
            }
        } catch (_) { /* workspace.findFiles may fail in some environments */ }

        // ── Currently visible slide ──────────────────────────────────────
        const activeDeck = activeEntry ? p.getDeck(activeUri) : null;
        if (activeDeck) {
            const idx = activeEntry.currentSlideIndex ?? 0;
            const slide = activeDeck.slides?.[idx];
            if (slide) {
                lines.push('');
                lines.push(`Currently visible slide: Slide ${idx + 1} of ${activeDeck.slides.length} — "${slide.label || '(unlabeled)'}" (slideIndex=${idx + 1} to use in tools)`);
                // Compact slide directory so the model always knows which number = which slide
                const slideDir = activeDeck.slides.map((sl, si) => `Slide ${si + 1}${sl.label ? ': "' + sl.label + '"' : ''}`).join('  |  ');
                lines.push(`All slides: ${slideDir}`);
                const ascii = _asciiSlide(slide);
                lines.push('Block tree:');
                lines.push('```');
                lines.push(ascii);
                lines.push('```');
            }
        }

        // ── Current theme ────────────────────────────────────────────────
        if (activeDeck) {
            const t = activeDeck.theme || {};
            lines.push('');
            lines.push('Current theme:');
            lines.push(`  navy=${t.navy||'#0a244a'} blue=${t.blue||'#0064b4'} cyan=${t.cyan||'#009ac8'} accent=${t.accent||'#be1e2d'}`);
            if (t.editorCSS) {
                if (options?.input?.includeCss) {
                    lines.push(`  editorCSS (${t.editorCSS.length} chars):`);
                    lines.push(t.editorCSS);
                } else {
                    lines.push(`  editorCSS: ${t.editorCSS.length} chars (omitted — pass includeCss:true to view full CSS)`);
                }
            }
        }

        // ── Renderer capabilities ────────────────────────────────────────
        lines.push('');
        lines.push('=== Renderer Capabilities ===');
        lines.push('Math: KaTeX supported — use $...$ for inline math, $$...$$ for display math in any text/heading content.');
        lines.push('Animation: add "fragmentOrder": N (integer ≥1) to any block for Reveal.js step-by-step animation within a slide.');
        lines.push('Eval blocks: type "eval" blocks evaluate Mathematica code live. Graphics produce SVG; symbolic expressions produce LaTeX (via KaTeX). Use wolfslide_insertEvalBlock to add, wolfslide_runEvalBlock to re-evaluate.');
        lines.push('  Eval blocks are ideal for: computed plots (Plot, ListPlot, Graphics), formulas (Integrate, Series), tables, and any dynamic Wolfram Language output.');
        lines.push('  The output type is automatic: graphics → crisp SVG, math expressions → beautifully typeset LaTeX, fallback → PNG image.');
        lines.push('CSS color classes available in editorCSS: .gl (gold), .te (teal), .ro (rose), .mu (mauve), .bl (blue), .re (red), .cy (cyan).');
        lines.push('  Usage: <span class="gl">highlighted text</span> inside content strings.');
        lines.push('Theme: set via wolfslide_setTheme. Colors are CSS custom properties: --navy, --blue, --cyan, --accent, --slidebg.');

        // ── Theme presets ────────────────────────────────────────────────
        lines.push('');
        lines.push('Available theme presets (use wolfslide_setTheme with preset name):');
        for (const [key, p2] of Object.entries(THEME_PRESETS)) {
            lines.push(`  "${key}" — ${p2.description}`);
        }

        // ── Style presets (deck-level reusable style bundles) ────────────
        if (activeDeck?.stylePresets && Object.keys(activeDeck.stylePresets).length > 0) {
            lines.push('');
            lines.push('Style presets (set stylePreset:"name" on any block; block.style overrides preset):');
            for (const [name, props] of Object.entries(activeDeck.stylePresets)) {
                const propList = Object.entries(props).map(([k, v]) => `${k}:${v}`).join(', ');
                lines.push(`  "${name}" — { ${propList} }`);
            }
            lines.push('Set/update via: wolfslide_setTheme(stylePresets:{ "name": { color:"#fff", ... } })');
            lines.push('Delete a preset: wolfslide_setTheme(stylePresets:{ "name": null })');
        } else {
            lines.push('Style presets: none defined yet. Create with wolfslide_setTheme(stylePresets:{ "preset-name": { color:"#fff", fontSize:"32px" } })');
        }

        // ── Style coverage + duplicate-inline-style nudge (Phase 3, Item 8b) ──
        // Steers toward global styles by surfacing how much of the deck is on a
        // preset and flagging identical inline styles worth promoting.
        if (activeDeck && (activeDeck.slides || []).length > 0) {
            const allBlocks = [];
            for (const s of activeDeck.slides) for (const b of _collectAllBlocks(s)) if (b) allBlocks.push(b);
            const total      = allBlocks.length;
            const withPreset = allBlocks.filter(b => b.stylePreset).length;
            const styled     = allBlocks.filter(b => b.style && typeof b.style === 'object' && Object.keys(b.style).length > 0);
            const pct = total ? Math.round((withPreset / total) * 100) : 0;
            lines.push('');
            lines.push(`Style coverage: ${withPreset}/${total} block(s) use a stylePreset (${pct}%); ${styled.length} carry an inline style object.`);
            // Find inline styles repeated byte-identically on ≥3 blocks.
            const sig = new Map();
            for (const b of styled) { const k = JSON.stringify(b.style); sig.set(k, (sig.get(k) || 0) + 1); }
            const dups = [...sig.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
            if (dups.length) {
                lines.push(`⚠ ${dups.length} inline style(s) are repeated on ≥3 blocks — promote each to a stylePreset so ONE edit restyles all of them:`);
                dups.slice(0, 4).forEach(([k, n], i) => {
                    const name = `shared${i + 1}`;
                    lines.push(`   ${n}× ${k}`);
                    lines.push(`     → wolfslide_setTheme(stylePresets:{ "${name}": ${k} })`);
                    lines.push(`     → then wolfslide_patchBlock per matching block: { "stylePreset":"${name}" }  (and remove the now-duplicated style keys)`);
                });
            }
        }

        // ── Critical reminders (non-obvious traps only) ──────────────────
        lines.push('');
        lines.push('=== Key Reminders ===');
        lines.push('• Single-block edits: wolfslide_patchBlock(blockId:"id", patch:{...}) — preferred, finds block anywhere in tree.');
        lines.push('⚠ editSlide children array: ONLY pure {id:"..."} stubs allowed — rejects id+fields. Use patchBlock for any property change.');
        lines.push('⚠ Image src: NEVER use absolute paths — use wolfslide_imageAsset(action:"copy") first to get a relative src.');
        lines.push('• block.style wins over top-level block properties. Structural exceptions (position, x, y, w, h, fit, offset) stay top-level.');
        lines.push('• Inspection: listSlides(slideIndex:N) for one slide tree; listSlides(verbose:true) floods context — avoid on large decks.');

        // ── New-deck onboarding ──────────────────────────────────────────
        if (activeDeck && (activeDeck.slides || []).length === 0) {
            lines.push('');
            lines.push('╔══════════════════════════════════════════════════════════════╗');
            lines.push('║  NEW DECK — AI QUICK-START GUIDE                            ║');
            lines.push('╚══════════════════════════════════════════════════════════════╝');
            lines.push('');
            lines.push('This deck has no slides yet. Here is everything you need to build it efficiently.');
            lines.push('');
            lines.push('── STEP 1: Set theme ──────────────────────────────────────────');
            lines.push('Call wolfslide_setTheme with EITHER:');
            lines.push('  • preset: "dark-modern"  (or any preset name — see list above)');
            lines.push('  • theme: { navy:"#1e3a6a", blue:"#1e5aaa", cyan:"#00bcd4", accent:"#e67820", editorCSS:"..." }');
            lines.push('NEVER use "overrides" — that key is invalid and silently ignored. Use "theme" (object).');
            lines.push('');
            lines.push('── STEP 2: Build slides with wolfslide_bulkInsert ─────────────');
            lines.push('Pass the whole deck in one call. Example slide structure:');
            lines.push('  {');
            lines.push('    "label": "Title Slide",');
            lines.push('    "background": "#0a1628",');
            lines.push('    "layout": "column",');
            lines.push('    "children": [');
            lines.push('      { "type": "heading", "level": 1, "content": "My Talk",');
            lines.push('        "style": { "color": "#e2e8f0", "fontSize": "72px", "textAlign": "center" } },');
            lines.push('      { "type": "text", "content": "Author · Institution · Date",');
            lines.push('        "style": { "color": "#94a3b8", "fontSize": "28px", "textAlign": "center" } }');
            lines.push('    ]');
            lines.push('  }');
            lines.push('');
            lines.push('── KEY LAYOUT RULES ───────────────────────────────────────────');
            lines.push('• Canvas: 1920×1080 px. Use explicit "960px" heights, NOT "100%" for full-screen rows.');
            lines.push('• Side-by-side columns: container with layout:"row", children with style:{flex:"1"} each.');
            lines.push('• Full-height layout: { "type":"container", "layout":"row", "style":{"height":"960px","display":"flex"} }');
            lines.push('• Each visual element = its own block. Do NOT concatenate multiple divs into one text block.');
            lines.push('• Every block gets a unique ID automatically — do not set "id" in bulkInsert (will be overwritten).');
            lines.push('');
            lines.push('── STYLING: PREFER GLOBAL STYLE PRESETS ───────────────────────');
            lines.push('Define a small "house style" ONCE, then reference it. Do NOT copy an inline style');
            lines.push('object onto every block — that produces decks the user cannot restyle globally.');
            lines.push('Step A — after setTheme, create 3–6 named stylePresets for your recurring roles:');
            lines.push('  wolfslide_setTheme(stylePresets:{');
            lines.push('    "lead":    { color:"#0f172a", fontSize:"44px", fontWeight:"bold" },');
            lines.push('    "body":    { color:"#1e293b", fontSize:"32px" },');
            lines.push('    "caption": { color:"#64748b", fontSize:"22px", fontStyle:"italic" } })');
            lines.push('Step B — reference them on blocks via stylePreset (NOT a copied style object):');
            lines.push('  { "type":"text", "content":"...", "stylePreset":"body" }');
            lines.push('Use an inline "style" object ONLY for a genuine one-off override (it wins over the preset).');
            lines.push('Why: stylePresets resolve to the SAME inline CSS at render AND export — just as robust as');
            lines.push('inline styling, but the user (and you) can restyle the whole deck by editing ONE preset.');
            lines.push('NOTE: editorCSS *classes* (.prob, .sol …) are the fragile ones — they need the editorCSS');
            lines.push('blob to be defined. stylePresets are NOT fragile; prefer them over both classes and inline.');
            lines.push('');
            lines.push('── ANIMATION / FRAGMENTS ──────────────────────────────────────');
            lines.push('Add "fragmentOrder": N (integer ≥1) to any block to reveal it on click N.');
            lines.push('Fragments must be SEPARATE blocks (one div per step, not one big div with all steps).');
            lines.push('Example: three bullet points revealed one by one:');
            lines.push('  { "type":"text", "content":"Point 1", "fragmentOrder":1, "style":{...} }');
            lines.push('  { "type":"text", "content":"Point 2", "fragmentOrder":2, "style":{...} }');
            lines.push('  { "type":"text", "content":"Point 3", "fragmentOrder":3, "style":{...} }');
            lines.push('');
            lines.push('── TRANSITIONS ────────────────────────────────────────────────');
            lines.push('Slide-level: set "transition":"fade" or "transition":"slide" on each slide object.');
            lines.push('Use "fade" for title/section slides; "slide" for content slides.');
            lines.push('');
            lines.push('── MATH ────────────────────────────────────────────────────────');
            lines.push('KaTeX supported in any text/heading: use $...$ inline, $$...$$ for display.');
            lines.push('Example: { "type":"text", "content":"The formula is $E = mc^2$" }');
            lines.push('');
            lines.push('── IMAGES ─────────────────────────────────────────────────────');
            lines.push('{ "type":"image", "src":"img/deck.wslide/file.png", "w":800, "h":600, "alt":"description" }');
            lines.push('Always set "alt". Use "fit":"contain" or "fit":"cover".');
            lines.push('');
            lines.push('── EVAL BLOCKS (Mathematica) ───────────────────────────────────');
            lines.push('Use wolfslide_insertEvalBlock to add live Wolfram Language code.');
            lines.push('Graphics → SVG, expressions → LaTeX (KaTeX), fallback → PNG.');
            lines.push('');
            lines.push('── EDITING INDIVIDUAL BLOCKS ───────────────────────────────────');
            lines.push('After creating slides, use wolfslide_getSlide to get the ASCII diagram with block IDs (#xxxxxxxx).');
            lines.push('Then use wolfslide_patchBlock(blockId:"xxxxxxxx", patch:{...}) to change any block property without touching anything else.');
            lines.push('Style properties merge deeply: wolfslide_patchBlock(blockId:"xx", patch:{ style:{ background:"rgba(0,0,0,0.5)" } }) only changes background, leaving all other style keys intact.');
            lines.push('');
            lines.push('── VERIFY THEME WAS APPLIED ────────────────────────────────────');
            lines.push('After wolfslide_setTheme, call wolfslide_getContext again — the full editorCSS will appear above.');
            lines.push('Check that the colors and CSS match what you intended before building slides.');
        }

        return _slideResult(lines.join('\n'));
    }
}

class WolfslideListSlidesTool {
    prepareInvocation() { return { invocationMessage: 'Listing slides' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri || undefined;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');

        // slideIndex: if given, show only that slide (verbose defaults true for single-slide queries)
        const targetIdx = options.input?.slideIndex != null ? Number(options.input.slideIndex) - 1 : null;
        const verbose = targetIdx !== null
            ? (options.input?.verbose !== false)          // single slide: default verbose=true
            : !!options.input?.verbose;                   // full listing: default verbose=false

        const scope = p.getScope ? p.getScope(docUri) : null;
        const scopeBanner = scope ? `⚑ SCOPE: ${scope}\n` : '';

        const allSlides = deck.slides || [];
        const slides = targetIdx !== null
            ? (allSlides[targetIdx] ? [{ slide: allSlides[targetIdx], i: targetIdx }] : [])
            : allSlides.map((s, i) => ({ slide: s, i }));

        if (targetIdx !== null && slides.length === 0)
            return _slideResult(`Slide ${targetIdx + 1} not found (deck has ${allSlides.length}).`);

        const lines = slides.map(({ slide: s, i }) => {
            const label   = s.label || s.meta?.title || '';
            const bg      = s.background || '';
            const hidden  = s.hidden ? '  HIDDEN' : '';
            const topBlocks = s.children || s.elements || [];
            // One-line block list: type + key content/size
            const blockDesc = topBlocks.map(b => {
                let d = _blockLabel(b);
                const ann = _blockAnno(b);
                return ann ? d + ann : d;
            }).join(' | ');
            const imgs   = _collectImages(s);
            const imgInfo = imgs.length
                ? `  images(${imgs.length}): ` + imgs.map(im => {
                    const size = (im.w && im.h) ? `${im.w}×${im.h}` : (im.w ? `w=${im.w}` : '');
                    const alt  = im.alt ? `"${im.alt}"` : '⚠NO-ALT';
                    return [alt, size].filter(Boolean).join(' ');
                }).join(', ')
                : '';
            const allBlocks = _collectAllBlocks(s);
            const fragCount = allBlocks.filter(b => b.fragmentOrder != null && b.fragmentOrder >= 1).length;
            const stepsInfo = fragCount > 0 ? `  steps:${fragCount}` : '';
            // Total text character count
            const charCount = allBlocks.reduce((sum, b) => sum + _stripHtml(b.content || '').length + (b.items || []).reduce((s2, it) => s2 + _stripHtml(it.content || '').length, 0), 0);
            const charsInfo = `  chars:${charCount}`;
            // Inline warnings
            const warnings = [];
            const noAltImgs = imgs.filter(im => !im.alt);
            if (noAltImgs.length) warnings.push('no-alt');
            if (topBlocks.length > 10) warnings.push('dense');
            const warnInfo = warnings.length ? `  ⚠${warnings.join(',')}` : '';
            const trans = s.transition ? `  transition="${s.transition}"` : '';
            const summary = `Slide ${i + 1}  (slideIndex=${i + 1})  id=${s.id}  label="${label}"  bg="${bg}"${trans}${hidden}${stepsInfo}${charsInfo}${warnInfo}\n    blocks: ${blockDesc}${imgInfo}`;
            if (verbose) {
                const ascii = _asciiSlide(s);
                return summary + '\n```\n' + ascii + '\n```';
            }
            return summary;
        });
        const header = targetIdx !== null
            ? `Slide ${targetIdx + 1} of ${allSlides.length}`
            : `${allSlides.length} slides — slideIndex:N in all tools equals the number shown as "Slide N" below${verbose ? '' : ' (pass verbose:true to include block trees)'}`;
        return _slideResult(scopeBanner + header + ':\n' + lines.join('\n'));
    }
}

class WolfslideGetSlideTool {
    prepareInvocation(options) {
        const n = options.input?.slideIndex ?? options.input?.slideNumber ?? '?';
        return { invocationMessage: `Getting slide ${n}` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');
        let idx;
        const slideId = options.input?.slideId;
        if (slideId) {
            idx = (deck.slides || []).findIndex(s => s.id === slideId);
            if (idx === -1) return _slideResult(`Slide with id="${slideId}" not found. Valid ids: ${deck.slides.map(s => s.id).join(', ')}`);
        } else {
            // Accept slideNumber as alias; default to currently visible slide
            const raw = options.input?.slideIndex ?? options.input?.slideNumber;
            if (raw != null) {
                idx = Number(raw) - 1;
            } else {
                const activeEntry = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
                idx = activeEntry?.currentSlideIndex ?? 0;
            }
        }
        const isCurrentSlide = !options.input?.slideIndex && !options.input?.slideNumber && !options.input?.slideId;
        const slide = deck.slides?.[idx];
        if (!slide) return _slideResult(`Slide ${idx + 1} not found (deck has ${deck.slides?.length ?? 0}).`);

        // ASCII structural layout — helps AI "see" the slide composition
        const label  = slide.label || slide.meta?.title || '';
        const hidden = slide.hidden ? '  ⚠ HIDDEN (skipped in presentation)' : '';
        const transition = slide.transition ? `  transition: ${slide.transition}` : '';
        const currentBanner = isCurrentSlide
            ? `▶ CURRENTLY VIEWING: Slide ${idx + 1} of ${deck.slides.length} — edit tools default to this slide when slideIndex is omitted\n`
            : '';
        const asciiHeader =
            `## Slide ${idx + 1}: "${label}"  bg: ${slide.background || 'default'}  layout: ${slide.layout || 'column'}${hidden}${transition}\n` +
            `## Canvas: 1920×1080 px  |  blocks at top level: ${(slide.children || slide.elements || []).length}\n`;
        const ascii = _asciiSlide(slide);

        // Speaker notes
        const notesSummary = slide.notes ? `\n\n## Speaker Notes\n${slide.notes}` : '';

        // Image details
        const imgs = _collectImages(slide);
        const imgSummary = imgs.length
            ? '\n\n## Images on this slide\n' + imgs.map((im, n) => {
                const size = (im.w && im.h) ? `size: ${im.w}×${im.h}px` : (im.w ? `w: ${im.w}px` : 'size: unknown');
                const alt  = `alt: "${im.alt || '⚠ NOT SET'}"`;
                const src  = `src: ${(im.src || '').split('/').pop()}`;
                const off  = im.offset ? `offset: (${im.offset.dx},${im.offset.dy})` : '';
                return `  [img ${n + 1}] ${[alt, size, src, off].filter(Boolean).join(' | ')}`;
            }).join('\n')
            : '';

        // Render warnings: unknown types, missing required fields
        const VALID_BLOCK_TYPES_GS = new Set(['container','heading','text','image','list','math','box','raw','code','arrow','eval']);
        const renderWarnings = [];
        _collectAllBlocks(slide).forEach(b => {
            if (b.type && !VALID_BLOCK_TYPES_GS.has(b.type)) {
                renderWarnings.push(`block id=${b.id||'?'} has unknown type "${b.type}" — will not render. Valid types: ${[...VALID_BLOCK_TYPES_GS].join(', ')}.`);
            }
        });
        const renderWarnStr = renderWarnings.length
            ? `\n\n## ⚠ Render Warnings (${renderWarnings.length})\n${renderWarnings.map(w => '  - ' + w).join('\n')}`
            : '';

        const brief = !!options.input?.brief;
        const currentScope = p.getScope ? p.getScope(docUri) : null;
        const scopeFooter = currentScope
            ? `\n\n⚑ SCOPE: "${currentScope}" — work here only. Ignore anything outside this scope.`
            : '';

        const output =
            currentBanner +
            asciiHeader +
            '```\n' + ascii + '\n```' +
            imgSummary +
            notesSummary +
            renderWarnStr +
            (brief ? '' : '\n\n## Raw JSON\n```json\n' + JSON.stringify(slide, null, 2) + '\n```') +
            scopeFooter;
        return _slideResult(output);
    }
}

class WolfslideInsertSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Inserting slide at position ${options.input?.afterIndex ?? 'end'}` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');
        const newSlide = options.input?.slide || {
            id: _uid(), label: '', background: '#fafcff', layout: 'column', children: [],
        };
        if (!newSlide.id) newSlide.id = _uid();
        _ensureBlockIds(newSlide.children);
        _ensureBlockIds(newSlide.items);
        _ensureBlockIds(newSlide.elements);
        // Freshen any block IDs that would collide with existing blocks in the deck
        const insertSlideWarnings = [];
        const existingIds = _collectDeckIds(deck);
        _freshenConflicts(existingIds, newSlide.children, insertSlideWarnings);
        _freshenConflicts(existingIds, newSlide.items, insertSlideWarnings);
        _freshenConflicts(existingIds, newSlide.elements, insertSlideWarnings);
        const afterIndex = options.input?.afterIndex;
        const insertAt = (afterIndex != null) ? Math.min(afterIndex, deck.slides.length) : deck.slides.length;
        deck.slides.splice(insertAt, 0, newSlide);
        await p.applyDeck(deck, docUri);
        const warnStr = insertSlideWarnings.length ? `\nWarnings:\n${insertSlideWarnings.map(w => `  ⚠ ${w}`).join('\n')}` : '';
        return _slideResult(`Inserted slide at position ${insertAt + 1} (id=${newSlide.id}).${warnStr}`);
    }
}

class WolfslideReplaceSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Replacing slide ${options.input?.slideId ?? options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const { deck, idx, slide: oldSlide, docUri, p } = r;

        const newSlide = options.input?.slide;
        if (!newSlide || typeof newSlide !== 'object' || Array.isArray(newSlide)) {
            return _slideResult('"slide" object is required (the full replacement slide, e.g. {label, background, layout, children:[...]}).');
        }

        // Preserve the existing slide id by default so any references (and the
        // editor's current-slide tracking) stay stable. Pass slide.id explicitly
        // to override.
        if (!newSlide.id) newSlide.id = oldSlide.id;

        // Normalize authoring shorthands, then validate block types (same rules
        // as bulkInsert) so a bad replacement is rejected rather than silently
        // rendering nothing.
        _normalizeBlockTree(newSlide.children);
        _normalizeBlockTree(newSlide.items);
        _normalizeBlockTree(newSlide.elements);
        const VALID_TYPES = new Set(['container','heading','text','image','list','math','box','raw','code','arrow','eval']);
        const typeWarnings = [];
        (function _check(blocks, path) {
            if (!Array.isArray(blocks)) return;
            for (const b of blocks) {
                if (!b) continue;
                if (!b.type) typeWarnings.push(`Block ${path}id=${b.id||'?'} is missing "type" — will not render.`);
                else if (!VALID_TYPES.has(b.type)) typeWarnings.push(`Block ${path}id=${b.id||'?'} has unknown type "${b.type}".`);
                _check(b.children || b.items || b.elements, `${path}${b.id||'?'}/`);
            }
        })(newSlide.children || newSlide.items || newSlide.elements, '');
        if (typeWarnings.length > 0) {
            return _slideResult(`Validation errors — slide NOT replaced:\n${typeWarnings.map(w => '  ⚠ ' + w).join('\n')}\nValid block types: ${[...VALID_TYPES].join(', ')}.`);
        }

        _ensureBlockIds(newSlide.children);
        _ensureBlockIds(newSlide.items);
        _ensureBlockIds(newSlide.elements);

        // Freshen block ids that collide with OTHER slides (ignore the slide being
        // replaced — its ids are about to disappear, so reusing them is fine).
        const warnings = [];
        const otherIds = new Set();
        deck.slides.forEach((s, i) => {
            if (i === idx) return;
            _collectAllBlocks(s).forEach(b => { if (b.id) otherIds.add(b.id); });
        });
        _freshenConflicts(otherIds, newSlide.children, warnings);
        _freshenConflicts(otherIds, newSlide.items, warnings);
        _freshenConflicts(otherIds, newSlide.elements, warnings);

        deck.slides[idx] = newSlide;
        await p.applyDeck(deck, docUri);
        const warnStr = warnings.length ? `\nWarnings:\n${warnings.map(w => `  ⚠ ${w}`).join('\n')}` : '';
        return _slideResult(`Replaced slide ${idx + 1} (id=${newSlide.id}) "${oldSlide.label || ''}" → "${newSlide.label || ''}".${warnStr}`);
    }
}

class WolfslideEditSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Editing slide ${options.input?.slideId ?? options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const patch = options.input?.patch || options.input?.updates;
        if (!patch || typeof patch !== 'object') return _slideResult('"patch" (or "updates") object is required.');

        // Validate block types and collect warnings
        const warnings = [];
        const VALID_BLOCK_TYPES = new Set(['container','heading','text','image','list','math','box','raw','code','arrow','eval']);
        function _checkBlockTypes(blocks) {
            if (!Array.isArray(blocks)) return;
            for (const b of blocks) {
                if (b && b.type && !VALID_BLOCK_TYPES.has(b.type)) {
                    warnings.push(`Unknown block type "${b.type}" (id=${b.id||'?'}). Valid types: ${[...VALID_BLOCK_TYPES].join(', ')}.`);
                }
                _checkBlockTypes(b.children || b.items || b.elements);
            }
        }
        _checkBlockTypes(patch.children || patch.items || patch.elements);

        // Stub resolution: each entry must be a pure {id:"..."} stub (enforced by pre-flight).
        // Resolve each stub to the full existing block by id, preserving order from incoming.
        function _mergeBlocks(existing, incoming) {
            if (!Array.isArray(incoming)) return incoming;
            const existingById = (existing || []).reduce((m, b) => { if (b?.id) m[b.id] = b; return m; }, {});
            return incoming.map(b => {
                if (!b || !b.id) return b;
                return existingById[b.id] || b; // stub → full existing block; unknown id → passthrough
            });
        }
        const mergedPatch = Object.assign({}, patch);
        const arrKeys = ['children', 'items', 'elements'];
        const hasChildrenInPatch = arrKeys.some(k => Array.isArray(patch[k]));

        // Pre-flight: reject ANY children entry that carries properties beyond just "id".
        // wolfslide_editSlide children arrays accept ONLY pure id-only stubs {id:"..."}.
        // Anything else silently destroys the block's type/layout/children.
        // Redirect every property change to wolfslide_patchBlock.
        if (hasChildrenInPatch) {
            const offenders = [];
            for (const key of arrKeys) {
                if (!Array.isArray(patch[key])) continue;
                for (const b of patch[key]) {
                    if (b && typeof b === 'object' && b.id && Object.keys(b).length > 1) {
                        offenders.push({ id: b.id, extraKeys: Object.keys(b).filter(k => k !== 'id') });
                    }
                }
            }
            if (offenders.length > 0) {
                const lines = [
                    `ERROR: wolfslide_editSlide children array is for STRUCTURAL layout only.`,
                    `It only accepts pure id-only stubs {"id":"..."} — no property changes.`,
                    ``,
                    `${offenders.length} block(s) carry extra fields that would destroy their type/layout/children:`,
                    ...offenders.map(o => `  ⚠ id="${o.id}"  extra fields: ${o.extraKeys.join(', ')}`),
                    ``,
                    `Use wolfslide_patchBlock for each change (safe, finds blocks anywhere in the tree):`,
                    ...offenders.map(o => `  wolfslide_patchBlock(blockId: "${o.id}", patch: { ${o.extraKeys.map(k => `${k}: ...`).join(', ')} })`),
                ];
                return _slideResult(lines.join('\n'));
            }
        }

        for (const key of arrKeys) {
            if (Array.isArray(patch[key])) {
                mergedPatch[key] = _mergeBlocks(r.slide[key], patch[key]);
            }
        }

        // dryRun: compute diff and return without saving
        const dryRun = !!options.input?.dryRun;
        if (dryRun) {
            if (!hasChildrenInPatch) {
                return _slideResult('dryRun:true requires at least one children/items/elements array in the patch to be useful.');
            }
            const lines = ['=== DRY RUN — no changes will be saved ===', ''];
            for (const key of arrKeys) {
                if (!Array.isArray(patch[key])) continue;
                const existing = r.slide[key] || [];
                const incoming = patch[key];
                const existingById = new Set(existing.map(b => b?.id).filter(Boolean));
                const incomingById = new Set(incoming.map(b => b?.id).filter(Boolean));
                const preserved = [], patched = [], added = [], deleted = [];
                for (const b of existing) {
                    if (b?.id && !incomingById.has(b.id)) deleted.push(b);
                }
                for (const b of incoming) {
                    if (!b?.id || !existingById.has(b.id)) { added.push(b); continue; }
                    if (Object.keys(b).length === 1) preserved.push(b);
                    else patched.push(b);
                }
                const existingMap = existing.reduce((m, b) => { if (b?.id) m[b.id] = b; return m; }, {});
                lines.push(`${key} changes on slide ${r.idx + 1} "${r.slide.label || r.slide.id}":`);
                lines.push(`  Preserved (id-only stubs): ${preserved.length}`);
                preserved.forEach(b => lines.push(`    • ${b.id}  ${_blockLabel(existingMap[b.id] || b)}`));
                lines.push(`  Patched (id + fields): ${patched.length}`);
                patched.forEach(b => {
                    const keys = Object.keys(b).filter(k => k !== 'id');
                    lines.push(`    • ${b.id}  ${_blockLabel(existingMap[b.id] || b)}  — keys: ${keys.join(', ')}`);
                });
                lines.push(`  New blocks added: ${added.length}`);
                added.forEach(b => lines.push(`    • ${b.id || '(auto-id)'}  type:${b.type || '?'}`));
                if (deleted.length > 0) {
                    lines.push(`  ⚠ BLOCKS THAT WOULD BE DELETED: ${deleted.length}`);
                    deleted.forEach(b => lines.push(`    ⚠ ${b.id}  ${_blockLabel(b)}`));
                } else {
                    lines.push(`  Deleted: 0  ✓ safe`);
                }
                lines.push('');
            }
            lines.push('Run without dryRun:true to apply.');
            return _slideResult(lines.join('\n'));
        }

        // Warn about blocks being silently dropped (not listed in incoming children)
        for (const key of arrKeys) {
            if (!Array.isArray(patch[key])) continue;
            const existingList = r.slide[key] || [];
            const incomingIds = new Set((patch[key]).map(b => b?.id).filter(Boolean));
            const dropped = existingList.filter(b => b?.id && !incomingIds.has(b.id));
            if (dropped.length > 0) {
                warnings.push(`${dropped.length} block(s) removed from "${key}" (not listed in incoming): ${dropped.map(b => `${b.id}(${b.type || '?'})`).join(', ')}. Add id-only stubs to preserve them: {"id":"<id>"}`);
            }
        }

        // Deprecation warning when children array is passed
        if (hasChildrenInPatch) {
            warnings.push('Passing children/items/elements to wolfslide_editSlide is deprecated. Use wolfslide_block(action:"insert"|"delete"|"move") for structural changes or wolfslide_patchBlock for property edits. Use dryRun:true first to verify which blocks will be affected.');
        }

        Object.assign(r.slide, mergedPatch);
        _ensureBlockIds(r.slide.children);
        _ensureBlockIds(r.slide.items);
        _ensureBlockIds(r.slide.elements);
        // Post-edit duplicate ID check
        if (hasChildrenInPatch) {
            const dupes = _detectDeckDuplicateIds(r.deck);
            if (dupes.length > 0) {
                warnings.push(`⚠ DUPLICATE BLOCK IDs introduced by this edit: ${dupes.map(d => `"${d.id}" on slides [${d.slides.join(',')}]`).join('; ')}. Fix with wolfslide_advanced(action:"check") or rename manually.`);
            }
        }
        await r.p.applyDeck(r.deck, r.docUri);
        const warningStr = warnings.length ? `\nWarnings:\n${warnings.map(w => `  ⚠ ${w}`).join('\n')}` : '';
        const wasCurrentSlide = options.input?.slideIndex == null && options.input?.slideNumber == null && options.input?.slideId == null;
        const whichSlide = wasCurrentSlide
            ? `Currently visible Slide ${r.idx + 1} "${r.slide.label || r.slide.id}" (id=${r.slide.id}) updated.`
            : `Slide ${r.idx + 1} "${r.slide.label || r.slide.id}" (id=${r.slide.id}) updated.`;
        return _slideResult(whichSlide + warningStr);
    }
}

class WolfslideDeleteSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Deleting slide ${options.input?.slideId ?? options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        if (r.deck.slides.length <= 1) return _slideResult('Cannot delete the last slide.');
        const [removed] = r.deck.slides.splice(r.idx, 1);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Deleted slide ${r.idx + 1} "${removed.label || removed.id}" (id=${removed.id}).`);
    }
}

class WolfslideDeleteSlidesTool {
    prepareInvocation(options) {
        const inp = options.input || {};
        if (Array.isArray(inp.slideIndices)) {
            return { invocationMessage: `Deleting ${inp.slideIndices.length} slides` };
        }
        return { invocationMessage: `Deleting slides ${inp.from ?? '?'} to ${inp.to ?? '?'}` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri || undefined;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');

        const n = deck.slides.length;
        let indices;

        if (Array.isArray(options.input?.slideIndices)) {
            // Convert 1-based to 0-based, validate
            indices = options.input.slideIndices.map(i => {
                const idx = Number(i) - 1;
                if (!Number.isInteger(idx) || idx < 0 || idx >= n) return null;
                return idx;
            });
            if (indices.some(i => i === null)) {
                return _slideResult(`One or more slideIndices are out of range (deck has ${n} slides). Use 1-based indices.`);
            }
        } else if (options.input?.from != null && options.input?.to != null) {
            const from = Number(options.input.from) - 1;
            const to   = Number(options.input.to) - 1;
            if (from < 0 || to >= n || from > to) {
                return _slideResult(`Range from=${options.input.from} to=${options.input.to} is out of range (deck has ${n} slides). Use 1-based indices.`);
            }
            indices = [];
            for (let i = from; i <= to; i++) indices.push(i);
        } else {
            return _slideResult('Provide either slideIndices (array of 1-based indices) or from+to (1-based range).');
        }

        if (indices.length >= n) {
            return _slideResult(`Cannot delete all ${n} slides — at least one slide must remain.`);
        }

        // Remove in reverse order so earlier indices stay valid
        const sorted = [...new Set(indices)].sort((a, b) => b - a);
        const removed = sorted.map(i => deck.slides[i].label || deck.slides[i].id);
        sorted.forEach(i => deck.slides.splice(i, 1));

        await p.applyDeck(deck, docUri);
        return _slideResult(`Deleted ${sorted.length} slide(s): ${removed.join(', ')}. Deck now has ${deck.slides.length} slide(s).`);
    }
}

class WolfslideMoveSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Moving slide ${options.input?.slideId ?? options.input?.slideIndex ?? ''} → position ${options.input?.toIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const to = (options.input?.toIndex || 1) - 1;
        const n = r.deck.slides.length;
        if (to < 0 || to >= n) return _slideResult(`toIndex ${to + 1} out of range (deck has ${n} slides).`);
        if (r.idx === to) return _slideResult(`Slide "${r.slide.id}" is already at position ${to + 1}, no change made.`);
        const [slide] = r.deck.slides.splice(r.idx, 1);
        r.deck.slides.splice(to, 0, slide);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Moved slide ${r.idx + 1} "${slide.label || slide.id}" (id=${slide.id}) → position ${to + 1}.`);
    }
}

class WolfslideUndoTool {
    prepareInvocation() { return { invocationMessage: 'Undoing last change in slide editor' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const entry = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
        if (!entry) return _slideResult('No active .wslide editor.');
        const stack = entry._undoStack || [];
        if (stack.length === 0) return _slideResult('Nothing to undo.');
        const prevDeck = stack.pop();
        await p.applyDeck(prevDeck, docUri, { skipUndoPush: true });
        const slideCount = (prevDeck.slides || []).length;
        return _slideResult(`Reverted to previous state. Slide count: ${slideCount}. Undo stack depth remaining: ${stack.length}.`);
    }
}

class WolfslideReloadTool {
    prepareInvocation() { return { invocationMessage: 'Reloading .wslide from disk' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const freshDeck = p.reloadDeck(docUri);
        if (!freshDeck) return _slideResult('No active .wslide editor found (or the editor is not yet resolved).');
        const slideCount = (freshDeck.slides || []).length;
        return _slideResult(`Reloaded from disk. Slide count: ${slideCount}. Undo stack cleared.`);
    }
}

class WolfslideSaveFileTool {
    prepareInvocation() { return { invocationMessage: 'Saving .wslide file' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const entry = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
        if (!entry) return _slideResult('No active .wslide editor.');
        await entry.document.save();
        return _slideResult('Saved.');
    }
}

class WolfslideDuplicateSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Duplicating slide ${options.input?.slideId ?? options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const clone = JSON.parse(JSON.stringify(r.slide));
        function reassignIds(b) {
            b.id = _uid();
            (b.children || b.items || b.elements || []).forEach(reassignIds);
        }
        clone.id = _uid();
        (clone.children || clone.elements || []).forEach(reassignIds);
        r.deck.slides.splice(r.idx + 1, 0, clone);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Duplicated slide ${r.idx + 1} → inserted at position ${r.idx + 2} (id=${clone.id}).`);
    }
}

class WolfslideSearchSlidesTool {
    prepareInvocation(options) {
        return { invocationMessage: `Searching slides for "${options.input?.query ?? ''}"` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const deck = p.getDeck(options.input?.docUri);
        if (!deck) return _slideResult('No deck found.');
        const query = (options.input?.query || '').toLowerCase().trim();
        const blockTypeFilter = (options.input?.blockType || '').toLowerCase().trim();
        const styleKey   = (options.input?.styleKey   || '').trim();
        const styleValue = (options.input?.styleValue || '').toLowerCase().trim();
        if (!query && !blockTypeFilter && !styleKey)
            return _slideResult('Provide at least one of: query, blockType, or styleKey.');
        const results = [];
        (deck.slides || []).forEach((s, i) => {
            const allBlocks = _collectAllBlocks(s);
            const matches = [];

            // Check if slide label matches query (slide-level match — no block filter needed)
            const slideLabelMatch = query && (s.label || '').toLowerCase().includes(query);

            allBlocks.forEach(b => {
                // Type filter
                if (blockTypeFilter && (b.type || '').toLowerCase() !== blockTypeFilter) return;
                // Style key/value filter
                if (styleKey) {
                    const styleObj = b.style || {};
                    const val = (styleObj[styleKey] || '').toString().toLowerCase();
                    if (!val) return;
                    if (styleValue && !val.includes(styleValue)) return;
                }
                // Text content filter
                if (query) {
                    const haystack = [
                        _stripHtml(b.content || ''),
                        b.alt || '', b.src || '', b.label || '',
                        ...(b.items || []).map(it => _stripHtml(it.content || '')),
                    ].join(' ').toLowerCase();
                    if (!haystack.includes(query)) return;
                }
                const preview = _stripHtml(b.content || b.alt || (b.items?.[0]?.content) || '').slice(0, 70);
                const styleHint = styleKey ? `  ${styleKey}=${b.style?.[styleKey]}` : '';
                matches.push(`    block id=${b.id} type=${b.type}${styleHint}: "${preview}"`);
            });

            if (slideLabelMatch && !blockTypeFilter && !styleKey) {
                // Slide label matched — report the slide even if no block content matches
                const labelNote = `    (label match: "${s.label}")`;
                results.push(`[${i + 1}] id=${s.id} label="${s.label || ''}" slideIndex=${i + 1}:\n${labelNote}${matches.length ? '\n' + matches.join('\n') : ''}`);
            } else if (matches.length) {
                results.push(`[${i + 1}] id=${s.id} label="${s.label || ''}" slideIndex=${i + 1}:\n${matches.join('\n')}`);
            }
        });
        const desc = [query && `text/label:"${query}"`, blockTypeFilter && `type:${blockTypeFilter}`, styleKey && `style.${styleKey}${styleValue ? '='+styleValue : ''}`].filter(Boolean).join(', ');
        if (!results.length) return _slideResult(`No matches for [${desc}] across ${deck.slides.length} slide(s).`);
        return _slideResult(`Matches for [${desc}] in ${results.length} slide(s):\n${results.join('\n')}`);
    }
}

// ── Block-level editing tools ─────────────────────────────────────────────

class WolfslideEditBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Editing block ${options.input?.blockId ?? options.input?.blockName ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const ref = _resolveBlockRef(options, r);
        if (ref.error) return _slideResult(ref.error);
        const { found, resolvedSlide, resolvedIdx } = ref;
        const blockId = found.block.id;
        const updates = options.input?.updates || options.input?.patch;
        if (!updates || typeof updates !== 'object') return _slideResult('updates (or patch) object is required.');

        // childrenOps: precise insert/remove/reorder within a block's children array
        const childrenOps = updates.childrenOps;
        const restUpdates = Object.assign({}, updates);
        delete restUpdates.childrenOps;

        if (childrenOps && Array.isArray(childrenOps)) {
            if (!found.block.children) found.block.children = [];
            const children = found.block.children;
            const opsLog = [];
            for (const op of childrenOps) {
                if (op.op === 'remove') {
                    const idx = children.findIndex(c => c.id === op.blockId);
                    if (idx !== -1) { children.splice(idx, 1); opsLog.push(`removed ${op.blockId}`); }
                    else opsLog.push(`remove: ${op.blockId} not found`);
                } else if (op.op === 'insert') {
                    const nb = op.block;
                    if (!nb) { opsLog.push('insert: missing block'); continue; }
                    if (!nb.id) nb.id = _uid();
                    if (op.afterId) {
                        const ai = children.findIndex(c => c.id === op.afterId);
                        if (ai !== -1) { children.splice(ai + 1, 0, nb); opsLog.push(`inserted ${nb.id} after ${op.afterId}`); }
                        else { children.push(nb); opsLog.push(`inserted ${nb.id} at end (afterId ${op.afterId} not found)`); }
                    } else {
                        const pos = op.position != null ? Math.min(op.position, children.length) : children.length;
                        children.splice(pos, 0, nb);
                        opsLog.push(`inserted ${nb.id} at pos ${pos}`);
                    }
                } else if (op.op === 'reorder') {
                    if (!Array.isArray(op.ids)) { opsLog.push('reorder: ids array required'); continue; }
                    const byId = {};
                    children.forEach(c => { byId[c.id] = c; });
                    const reordered = op.ids.map(id => byId[id]).filter(Boolean);
                    const remaining = children.filter(c => !op.ids.includes(c.id));
                    found.block.children = [...reordered, ...remaining];
                    opsLog.push(`reordered: [${op.ids.join(', ')}]`);
                } else {
                    opsLog.push(`unknown op "${op.op}" (valid: insert/remove/reorder)`);
                }
            }
            if (Object.keys(restUpdates).length) _deepMerge(found.block, restUpdates);
            _ensureBlockIds(found.block.children);
            await r.p.applyDeck(r.deck, r.docUri);
            return _slideResult(`Block ${blockId} on slide ${resolvedIdx + 1} "${resolvedSlide.label || resolvedSlide.id}" — childrenOps: ${opsLog.join('; ')}`);
        }

        _deepMerge(found.block, updates);
        _ensureBlockIds(found.block.children);
        _ensureBlockIds(found.block.items);
        _ensureBlockIds(found.block.elements);
        await r.p.applyDeck(r.deck, r.docUri);
        const wasCurrentSlide = options.input?.slideIndex == null && options.input?.slideId == null;
        const slideNote = wasCurrentSlide ? `currently visible Slide` : `Slide`;
        return _slideResult(`Block "${blockId}" updated on ${slideNote} ${resolvedIdx + 1} "${resolvedSlide.label || resolvedSlide.id}". Keys changed: ${Object.keys(updates).join(', ')}`);
    }
}

class WolfslideInsertBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Inserting block on slide ${options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const block = options.input?.block;
        if (!block || typeof block !== 'object') return _slideResult('block object is required.');
        if (!block.id) block.id = _uid();
        // Assign ids to any children that lack them
        function ensureIds(b) {
            if (!b.id) b.id = _uid();
            (b.children || b.items || b.elements || []).forEach(ensureIds);
        }
        ensureIds(block);
        const parentId = options.input?.parentBlockId || null;
        const position = options.input?.position;
        let arr;
        if (parentId) {
            const found = _findBlockRecursive(parentId, r.slide);
            if (!found) return _slideResult(`Parent block "${parentId}" not found.`);
            const parent = found.block;
            if (!parent.children) parent.children = [];
            arr = parent.children;
        } else {
            if (!r.slide.children) r.slide.children = [];
            arr = r.slide.children;
        }
        const pos = (position != null && position >= 0) ? Math.min(position, arr.length) : arr.length;
        arr.splice(pos, 0, block);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Inserted block id=${block.id} type=${block.type || '?'} at position ${pos} on slide ${r.idx + 1} "${r.slide.label || r.slide.id}".`);
    }
}

class WolfslideDeleteBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Deleting block ${options.input?.blockId ?? options.input?.blockName ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const ref = _resolveBlockRef(options, r);
        if (ref.error) return _slideResult(ref.error);
        const { found, resolvedSlide, resolvedIdx } = ref;
        found.parent[found.key].splice(found.index, 1);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Deleted block ${found.block.id} (type=${found.block.type}) from slide ${resolvedIdx + 1} "${resolvedSlide.label || resolvedSlide.id}".`);
    }
}

class WolfslideMoveBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Moving block ${options.input?.blockId ?? options.input?.blockName ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const ref = _resolveBlockRef(options, r);
        if (ref.error) return _slideResult(ref.error);
        const { found, resolvedSlide, resolvedIdx } = ref;
        // Resolve destination BEFORE removing the block (so we don't lose it if dest is not found)
        const newParentId = options.input?.newParentId || null;
        const newPosition = options.input?.newPosition;
        let arr;
        if (newParentId) {
            const dest = _findBlockRecursive(newParentId, resolvedSlide);
            if (!dest) {
                const containerIds = _collectAllBlocks(resolvedSlide)
                    .filter(b => b.type === 'container')
                    .map(b => b.id);
                return _slideResult(`Destination parent block "${newParentId}" not found on slide ${resolvedIdx + 1}. Available container ids: ${containerIds.join(', ') || '(none)'}.`);
            }
            if (!dest.block.children) dest.block.children = [];
            arr = dest.block.children;
        } else {
            if (!resolvedSlide.children) resolvedSlide.children = [];
            arr = resolvedSlide.children;
        }
        // Now remove from old location and insert at new location
        found.parent[found.key].splice(found.index, 1);
        const pos = (newPosition != null && newPosition >= 0) ? Math.min(newPosition, arr.length) : arr.length;
        arr.splice(pos, 0, found.block);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Moved block ${found.block.id} → parent:${newParentId || '(slide root)'} pos:${pos} on slide ${resolvedIdx + 1} "${resolvedSlide.label || resolvedSlide.id}". Confirm: block is now in ${newParentId || 'slide root'}.`);
    }
}

// ── Deck diagnostics ──────────────────────────────────────────────────────

class WolfslideCheckDeckTool {
    prepareInvocation() { return { invocationMessage: 'Checking deck for issues' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const deck = p.getDeck(options.input?.docUri);
        if (!deck) return _slideResult('No deck found.');
        const issues = [];
        let totalBlocks = 0, totalImages = 0, imagesWithoutAlt = 0, maxBlocks = 0;
        const labelMap = {};
        (deck.slides || []).forEach((s, i) => {
            const sn = i + 1;
            const allBlocks = _collectAllBlocks(s);
            const topBlocks = s.children || s.elements || [];
            totalBlocks += allBlocks.length;
            // Empty slide
            if (topBlocks.length === 0) {
                issues.push({ slide: sn, issue: 'empty_slide', detail: 'no children' });
            }
            // High block count
            if (topBlocks.length > 10) {
                issues.push({ slide: sn, issue: 'high_block_count', count: topBlocks.length, detail: `${topBlocks.length} top-level blocks — likely too dense` });
            }
            if (allBlocks.length > maxBlocks) maxBlocks = allBlocks.length;
            // Images without alt
            allBlocks.forEach(b => {
                if (b.type === 'image') {
                    totalImages++;
                    if (!b.alt) {
                        imagesWithoutAlt++;
                        issues.push({ slide: sn, blockId: b.id, issue: 'no_alt_text', src: (b.src || '').split('/').pop() });
                    }
                }
                // Large negative offset
                if (b.offset && (b.offset.dy < -200 || b.offset.dx < -200)) {
                    issues.push({ slide: sn, blockId: b.id, issue: 'large_negative_offset', dx: b.offset.dx, dy: b.offset.dy, detail: 'large negative offset often means fighting the layout' });
                }
            });
            // Fragment gaps
            const steps = allBlocks.filter(b => b.fragmentOrder != null && b.fragmentOrder >= 1).map(b => b.fragmentOrder).sort((a, b) => a - b);
            if (steps.length > 0) {
                const maxStep = steps[steps.length - 1];
                const missing = [];
                for (let st = 1; st <= maxStep; st++) {
                    if (!steps.includes(st)) missing.push(st);
                }
                if (missing.length) {
                    issues.push({ slide: sn, issue: 'fragment_gap', present: steps, detail: `steps ${missing.join(', ')} missing` });
                }
            }
            // Duplicate labels
            const label = (s.label || '').trim();
            if (label) {
                if (!labelMap[label]) labelMap[label] = [];
                labelMap[label].push(sn);
            }
        });
        // Report duplicate labels
        for (const [label, slides] of Object.entries(labelMap)) {
            if (slides.length > 1) {
                issues.push({ issue: 'duplicate_label', label, slides });
            }
        }
        // Report duplicate block IDs (highest priority — causes silent wrong-block edits)
        _detectDeckDuplicateIds(deck).forEach(({ id, slides }) => {
            issues.push({ issue: 'duplicate_block_id', id, slides, detail: `Block id="${id}" exists on slides [${slides.join(',')}] — wolfslide_patchBlock will always hit the first occurrence` });
        });
        const slideCount = deck.slides?.length || 0;
        const hiddenCount = (deck.slides || []).filter(s => s.hidden).length;
        const stats = {
            totalBlocks, totalImages, imagesWithoutAlt, maxBlocksPerSlide: maxBlocks,
            avgBlocksPerSlide: slideCount ? +(totalBlocks / slideCount).toFixed(1) : 0,
        };
        const output = { slideCount, hiddenCount, issues, stats };
        return _slideResult(JSON.stringify(output, null, 2));
    }
}

// ── Fragment reordering ───────────────────────────────────────────────────

class WolfslideReorderFragmentsTool {
    prepareInvocation(options) {
        return { invocationMessage: `Reordering fragments on slide ${options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const order = options.input?.order;
        if (!Array.isArray(order) || !order.length) return _slideResult('order array is required.');
        // Clear all fragmentOrder on this slide first
        const allBlocks = _collectAllBlocks(r.slide);
        allBlocks.forEach(b => { b.fragmentOrder = null; });
        // Apply new order
        const applied = [];
        order.forEach((entry, i) => {
            const blockId = typeof entry === 'string' ? entry : entry.blockId;
            const step    = typeof entry === 'string' ? i + 1 : (entry.step ?? i + 1);
            const found = _findBlockRecursive(blockId, r.slide);
            if (found) {
                found.block.fragmentOrder = step;
                applied.push(`${blockId}→step${step}`);
            }
        });
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Reordered fragments on slide ${r.idx + 1}: ${applied.join(', ')}. All other blocks set to always-visible.`);
    }
}

// ── Layout measurement ────────────────────────────────────────────────────

class WolfslideMeasureSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Measuring slide ${options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        try {
            const result = await r.p.measureSlide(r.idx, r.docUri);
            // Enrich with block type info from data
            const allBlocks = _collectAllBlocks(r.slide);
            const blockMap = {};
            allBlocks.forEach(b => { blockMap[b.id] = b; });
            const enriched = {};
            for (const [id, meas] of Object.entries(result.blocks || {})) {
                const b = blockMap[id];
                enriched[id] = {
                    type: b?.type || '?',
                    name: b?.name || undefined,
                    requestedSize: { w: b?.w || null, h: b?.h || null },
                    ...meas,
                };
            }
            // Detect issues
            const issues = [];
            for (const [id, m] of Object.entries(enriched)) {
                if (m.overflow?.clippedBottom || m.overflow?.clippedRight) {
                    issues.push({ blockId: id, issue: 'content_overflow', detail: `rendered extends beyond canvas` });
                }
                if (m.requestedSize.h && m.renderedSize.h > m.requestedSize.h + 5) {
                    issues.push({ blockId: id, issue: 'content_overflow', detail: `rendered height ${m.renderedSize.h}px exceeds allocated ${m.requestedSize.h}px` });
                }
                if (m.type === 'image' && blockMap[id] && !blockMap[id].alt) {
                    issues.push({ blockId: id, issue: 'no_alt_text' });
                }
            }
            const output = {
                slideIndex: r.idx + 1,
                canvasSize: { w: 1920, h: 1080 },
                blocks: enriched,
                issues,
                remainingVerticalSpace: result.remainingVerticalSpace,
            };
            return _slideResult(JSON.stringify(output, null, 2));
        } catch (e) {
            return _slideResult(`Measurement failed: ${e.message}`);
        }
    }
}

// ── Single-slide HTML preview ─────────────────────────────────────────────

class WolfslideGetSlideHtmlTool {
    prepareInvocation(options) {
        const n = options.input?.slideIndex ?? options.input?.slideNumber ?? '?';
        const fmt = options.input?.format || 'image';
        return { invocationMessage: `Rendering slide ${n} (${fmt})` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);

        const fmt = (options.input?.format || 'image').toLowerCase();

        // ── Image mode (default): capture via webview html2canvas ──────────
        if (fmt === 'image') {
            const outputPath = options.input?.outputPath;
            if (!outputPath) {
                return _slideResult(
                    'Error: outputPath is required for format:"image". ' +
                    'Returning a screenshot inline as base64 produces ~100 KB of text and will exhaust the context window. ' +
                    'Pass outputPath:"/absolute/path/slide.jpg" to save the file to disk instead, then use the path to reference it.'
                );
            }
            try {
                const scale = Number(options.input?.scale) || 0.5;
                const dataUrl = await r.p.screenshotSlide(r.idx, r.docUri, scale);
                // Strip the data:image/jpeg;base64, prefix to return raw base64
                const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
                require('fs').writeFileSync(outputPath, Buffer.from(base64, 'base64'));
                return _slideResult(
                    `Slide ${r.idx + 1} "${r.slide.label || ''}" screenshot saved to ${outputPath} (${Math.round(base64.length * 3/4 / 1024)}KB, scale=${scale}).`
                );
            } catch (e) {
                return _slideResult(`Screenshot failed: ${e.message}. Try format:"html" as fallback.`);
            }
        }

        // ── HTML mode: return standalone static HTML (all elements visible) ─
        try {
            const exporter = require('../slideExporter');
            const animationSteps = options.input?.animationSteps === true;
            const deckDir = r.p.getDeckDir ? r.p.getDeckDir(r.docUri) : null;
            let html;
            if (animationSteps) {
                // Full Reveal.js with step navigation. Render a single-slide deck through
                // exportDeck so it uses the EXACT same styling/code-highlighting as the
                // real Export-HTML path (no separate hand-rolled template to drift).
                const oneSlideDeck = Object.assign({}, r.deck, { slides: [r.slide] });
                html = exporter.exportDeck(oneSlideDeck, deckDir ? { deckDir } : {});
            } else {
                // Static HTML — all animation fragments visible at once (default for html mode)
                // Pass deckDir so images can be embedded as data URIs
                html = exporter.slideToStaticHTML(r.slide, r.deck, deckDir);
            }

            const depWarn = exporter.exportDependencyWarning ? exporter.exportDependencyWarning() : null;
            const warnPrefix = depWarn ? depWarn + '\n\n' : '';

            const outputPath = options.input?.outputPath;
            if (outputPath) {
                require('fs').writeFileSync(outputPath, html, 'utf8');
                return _slideResult(`${warnPrefix}Slide ${r.idx + 1} HTML written to ${outputPath} (${html.length} bytes).`);
            }
            return _slideResult(
                `${warnPrefix}Slide ${r.idx + 1} "${r.slide.label || ''}" HTML (${html.length} bytes):\n\n` +
                `\`\`\`html\n${html}\n\`\`\``
            );
        } catch (e) {
            return _slideResult(`HTML render failed: ${e.message}`);
        }
    }
}

// ── Image dimension helper ────────────────────────────────────────────────

class WolfslideGetImageDimensionsTool {
    prepareInvocation(options) {
        return { invocationMessage: `Reading image dimensions: ${options.input?.src || ''}` };
    }
    async invoke(options, _token) {
        const src = options.input?.src || '';
        if (!src) return _slideResult('Error: "src" is required (local path or http/https URL).');
        try {
            let buf;
            if (/^https?:\/\//i.test(src)) {
                buf = await _fetchImageHeader(src);
            } else {
                // Local path — resolve relative to the active deck if not absolute
                let filePath = src;
                if (!path.isAbsolute(filePath)) {
                    const p2 = _getSlideProvider();
                    const entry = p2 ? p2.getActiveEntry() : null;
                    if (entry) filePath = path.resolve(path.dirname(entry.document.uri.fsPath), filePath);
                }
                const full = require('fs').readFileSync(filePath);
                buf = Buffer.from(full.slice(0, 64));
            }
            const dims = _parseImageHeader(buf);
            if (!dims) return _slideResult(`Could not determine dimensions for "${src}". Format may be unsupported (supports PNG, JPEG, WebP).`);
            return _slideResult(JSON.stringify({ src, width: dims.w, height: dims.h, format: dims.fmt }));
        } catch (e) {
            return _slideResult(`Error reading image "${src}": ${e.message}`);
        }
    }
}

function _fetchImageHeader(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        const req = mod.get(url, { headers: { 'Range': 'bytes=0-511', 'User-Agent': 'WolfslideAgent/1.0' } }, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout reading image header')); });
    });
}

function _parseImageHeader(buf) {
    if (!buf || buf.length < 8) return null;
    // PNG: magic \x89PNG\r\n\x1a\n, width at bytes 16-19, height at 20-23
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        if (buf.length < 24) return null;
        return { fmt: 'PNG', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG: SOI = FF D8, then scan for SOF0/SOF1/SOF2 (FF C0/C1/C2)
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
        let i = 2;
        while (i + 8 < buf.length) {
            if (buf[i] !== 0xFF) break;
            const marker = buf[i + 1];
            const len = buf.readUInt16BE(i + 2);
            if (marker >= 0xC0 && marker <= 0xC3) {
                // height at i+5, width at i+7
                const h = buf.readUInt16BE(i + 5);
                const w = buf.readUInt16BE(i + 7);
                return { fmt: 'JPEG', w, h };
            }
            i += 2 + len;
        }
        return { fmt: 'JPEG', w: null, h: null }; // SOF not in first 512 bytes
    }
    // WebP: RIFF????WEBP
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
        const tag = buf.slice(12, 16).toString('ascii');
        if (tag === 'VP8 ' && buf.length >= 30) {
            const w = (buf.readUInt16LE(26) & 0x3FFF) + 1;
            const h = (buf.readUInt16LE(28) & 0x3FFF) + 1;
            return { fmt: 'WebP', w, h };
        }
        if (tag === 'VP8L' && buf.length >= 30) {
            const bits = buf.readUInt32LE(25);
            const w = (bits & 0x3FFF) + 1;
            const h = ((bits >> 14) & 0x3FFF) + 1;
            return { fmt: 'WebP', w, h };
        }
        if (tag === 'VP8X' && buf.length >= 30) {
            const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
            const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
            return { fmt: 'WebP', w, h };
        }
        return { fmt: 'WebP', w: null, h: null };
    }
    return null;
}

class WolfslideExportHtmlTool {
    prepareInvocation() { return { invocationMessage: 'Exporting slides to HTML' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');
        try {
            const exporter = require('../slideExporter');
            const depWarn = exporter.exportDependencyWarning ? exporter.exportDependencyWarning() : null;
            const warnPrefix = depWarn ? depWarn + '\n\n' : '';
            // Preferred: serialize the webview's live DOM (editor-identical). Fall
            // back to the string renderer if the webview round-trip isn't available.
            const entry0 = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
            const exDeckDir = entry0 ? require('path').dirname(entry0.document.uri.fsPath) : null;
            const deckName0 = entry0 ? require('path').basename(entry0.document.uri.fsPath, '.wslide') : 'presentation';
            let html = null;
            if (entry0 && p._buildSerializedHtml) {
                html = await p._buildSerializedHtml(entry0, null, deckName0, 'reveal');
            }
            if (!html) html = exporter.exportDeck(deck, { deckDir: exDeckDir });
            const destPath = options.input?.outputPath;
            if (destPath) {
                require('fs').writeFileSync(destPath, html, 'utf8');
                return _slideResult(`${warnPrefix}Exported ${html.length} bytes to ${destPath}.`);
            }
            // No path provided: show save dialog
            const entry = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
            const deckName = entry
                ? require('path').basename(entry.document.uri.fsPath, '.wslide')
                : 'presentation';
            const defaultUri = entry
                ? vscode.Uri.file(
                    require('path').join(
                        require('path').dirname(entry.document.uri.fsPath),
                        deckName + '.html'
                    ))
                : undefined;
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'HTML Presentation': ['html'] },
                title: 'Export Slides as Standalone HTML',
            });
            if (!saveUri) return _slideResult('Export cancelled.');
            require('fs').writeFileSync(saveUri.fsPath, html, 'utf8');
            return _slideResult(`${warnPrefix}Exported to ${saveUri.fsPath}.`);
        } catch (e) {
            return _slideResult(`Export failed: ${e.message}`);
        }
    }
}

// ── Theme tool ────────────────────────────────────────────────────────────

class WolfslideSetThemeTool {
    prepareInvocation(options) {
        return { invocationMessage: `Setting theme ${options.input?.preset || '(custom)'}` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');

        if (!deck.theme) deck.theme = {};
        const presetName = options.input?.preset;

        // Warn about unknown parameters (e.g. "overrides" — a common mistake; the correct key is "theme").
        // 'notebook' and 'client_id' are auto-injected into every MCP tool's schema by the
        // session-target wrapper (claude-mcp/server.js); accept-and-ignore them silently so
        // they don't produce a spurious "unknown parameter" warning. See feedback §I.
        const knownKeys = new Set(['preset', 'theme', 'docUri', 'applyBackground', 'defaultBackground', 'stylePresets', 'appendEditorCSS', 'editorCSSReplace', 'notebook', 'client_id']);
        const unknownKeys = Object.keys(options.input || {}).filter(k => !knownKeys.has(k));
        if (unknownKeys.length > 0) {
            return _slideResult(
                `⚠ wolfslide_setTheme: unknown parameter(s) "${unknownKeys.join('", "')}" — IGNORED.\n` +
                `Valid parameters: preset (string), theme (object with navy/blue/cyan/accent/editorCSS), defaultBackground, applyBackground, docUri.\n` +
                `Common mistake: "overrides" is not valid — use "theme": { navy:"#...", editorCSS:"..." } instead.`
            );
        }

        // Incremental editorCSS editing (feedback §F) — tweak one rule without
        // resending the whole ~5KB blob. `editorCSSReplace` runs literal string
        // substitutions ([{find,replace}] or [[find,replace]] pairs);
        // `appendEditorCSS` appends a snippet. Both operate on the current
        // deck.theme.editorCSS and can be standalone or combined with theme/preset.
        const cssOps = [];
        if (typeof options.input?.editorCSSReplace !== 'undefined') {
            const reps = options.input.editorCSSReplace;
            const list = Array.isArray(reps) ? reps : [reps];
            let css = deck.theme.editorCSS || '';
            let applied = 0, missed = 0;
            for (const rep of list) {
                const find    = Array.isArray(rep) ? rep[0] : rep?.find;
                const replace = Array.isArray(rep) ? rep[1] : rep?.replace;
                if (typeof find !== 'string') continue;
                if (css.includes(find)) { css = css.split(find).join(replace == null ? '' : String(replace)); applied++; }
                else missed++;
            }
            deck.theme.editorCSS = css;
            cssOps.push(`editorCSSReplace: ${applied} applied${missed ? `, ${missed} pattern(s) NOT found` : ''}`);
        }
        if (typeof options.input?.appendEditorCSS === 'string') {
            const cur = deck.theme.editorCSS || '';
            deck.theme.editorCSS = cur + (cur && !cur.endsWith('\n') ? '\n' : '') + options.input.appendEditorCSS;
            cssOps.push(`appendEditorCSS: +${options.input.appendEditorCSS.length} chars`);
        }
        if (cssOps.length > 0 && !presetName && !options.input?.theme &&
            !(options.input?.stylePresets && typeof options.input.stylePresets === 'object')) {
            await p.applyDeck(deck, docUri);
            return _slideResult(`editorCSS updated (${cssOps.join('; ')}). Total length: ${(deck.theme.editorCSS || '').length} chars. Note: editorCSS applies to the Reveal.js export and raw-block iframes, not the editor's built-in slide typography.`);
        }

        // Handle stylePresets update (can be combined with preset/theme or standalone)
        if (options.input?.stylePresets && typeof options.input.stylePresets === 'object') {
            if (!deck.stylePresets) deck.stylePresets = {};
            Object.assign(deck.stylePresets, options.input.stylePresets);
            // A null value means delete that preset
            for (const [k, v] of Object.entries(deck.stylePresets)) {
                if (v === null) delete deck.stylePresets[k];
            }
            if (!presetName && !options.input?.theme) {
                await p.applyDeck(deck, docUri);
                const remaining = Object.keys(deck.stylePresets);
                return _slideResult(`Style presets updated. Active presets: ${remaining.length > 0 ? remaining.map(n => `"${n}"`).join(', ') : '(none)'}.`);
            }
        }

        if (presetName) {
            const preset = THEME_PRESETS[presetName];
            if (!preset) {
                const available = Object.keys(THEME_PRESETS).join(', ');
                return _slideResult(`Unknown preset "${presetName}". Available: ${available}`);
            }
            // Apply preset theme
            Object.assign(deck.theme, preset.theme);
            // Optionally update all slide backgrounds if requested or if they are default
            if (options.input?.applyBackground !== false) {
                for (const s of deck.slides) {
                    if (!s.background || s.background === '#fafcff' || s.background === '#0d1117'
                        || s.background === '#0a1628' || s.background === '#002b36'
                        || s.background === '#000000' || s.background === '#fdf6e3') {
                        s.background = preset.defaultBackground;
                    }
                }
            }
            await p.applyDeck(deck, docUri);
            return _slideResult(`Applied theme preset "${presetName}" (${preset.label}). Default background: ${preset.defaultBackground}. Colors: navy=${preset.theme.navy} blue=${preset.theme.blue} cyan=${preset.theme.cyan} accent=${preset.theme.accent}.`);
        }

        // Custom theme properties
        const custom = options.input?.theme;
        if (custom && typeof custom === 'object') {
            Object.assign(deck.theme, custom);
            // Update slide backgrounds if provided
            if (options.input?.defaultBackground) {
                for (const s of deck.slides) {
                    if (!s.background || s.background === '#fafcff') {
                        s.background = options.input.defaultBackground;
                    }
                }
            }
            await p.applyDeck(deck, docUri);
            return _slideResult(`Theme updated with custom properties: ${Object.keys(custom).join(', ')}.`);
        }

        return _slideResult('Provide either "preset" (string) or "theme" (object) to set the theme.');
    }
}

// ── Image asset management tool ───────────────────────────────────────────

/**
 * wolfslide_imageAsset — full image asset lifecycle management for .wslide decks.
 *
 * Actions:
 *   list    — list all images in the deck's img/ folder, with usage info
 *   info    — get details for one image (size, used-on slides, annotation)
 *   copy    — copy an external file into the deck's img/ folder
 *   delete  — remove an image file (warns if still referenced)
 *   rename  — rename an image file and update all slide references
 *   annotate — write/update the annotation JSON for an image
 *   insert  — copy an image + immediately add an image block to a slide
 *
 * Annotation sidecar: <imgDir>/<filename>.ann.json
 * Format: { description, source, tags[] }
 */
class WolfslideImageAssetTool {
    prepareInvocation(options) {
        return { invocationMessage: `Image assets: ${options.input?.action || 'list'}` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const entry = p.getActiveEntry();
        if (!entry) return _slideResult('No active .wslide editor found.');
        const document = entry.document;
        const deckDir  = path.dirname(document.uri.fsPath);
        const deckName = path.basename(document.uri.fsPath, '.wslide');
        const imgDir   = path.join(deckDir, 'img', deckName + '.wslide');
        const docUri   = options.input?.docUri;
        const action   = (options.input?.action || 'list').toLowerCase();

        // ── Helper: collect all relative src values from the live deck ───
        function usedSrcs(deck) {
            const usedFiles = new Set();
            const prefix = `img/${deckName}.wslide/`;
            function walk(b) {
                if (!b) return;
                if (typeof b.src === 'string' && b.src.startsWith(prefix))
                    usedFiles.add(b.src.slice(prefix.length));
                (b.children || b.items || b.elements || []).forEach(walk);
            }
            (deck.slides || []).forEach(s => (s.children || s.elements || []).forEach(walk));
            return usedFiles;
        }

        // ── Helper: map filename → slide labels where it is referenced ───
        function usageMap(deck) {
            const map = {};            // filename → [slide label, ...]
            const prefix = `img/${deckName}.wslide/`;
            function walk(b, slideLabel) {
                if (!b) return;
                if (typeof b.src === 'string' && b.src.startsWith(prefix)) {
                    const fname = b.src.slice(prefix.length);
                    (map[fname] = map[fname] || []).push(slideLabel);
                }
                (b.children || b.items || b.elements || []).forEach(c => walk(c, slideLabel));
            }
            (deck.slides || []).forEach((s, i) => {
                const label = s.label || `Slide ${i + 1}`;
                (s.children || s.elements || []).forEach(b => walk(b, label));
            });
            return map;
        }

        // ── Helper: read annotation sidecar ──────────────────────────────
        function readAnn(filename) {
            const annPath = path.join(imgDir, filename + '.ann.json');
            if (!fs.existsSync(annPath)) return null;
            try { return JSON.parse(fs.readFileSync(annPath, 'utf8')); } catch (_) { return null; }
        }

        // ── Helper: write annotation sidecar ─────────────────────────────
        function writeAnn(filename, ann) {
            fs.mkdirSync(imgDir, { recursive: true });
            const annPath = path.join(imgDir, filename + '.ann.json');
            fs.writeFileSync(annPath, JSON.stringify(ann, null, 2), 'utf8');
        }

        // ── Helper: image dimensions (PNG/JPEG/SVG heuristic) ────────────
        function imageDimensions(fpath) {
            try {
                const buf = fs.readFileSync(fpath);
                const ext = path.extname(fpath).toLowerCase();
                if (ext === '.png') {
                    if (buf.length < 24) return null;
                    const w = buf.readUInt32BE(16);
                    const h = buf.readUInt32BE(20);
                    return { w, h };
                }
                if (ext === '.jpg' || ext === '.jpeg') {
                    // Scan for SOF marker
                    let i = 0;
                    while (i < buf.length - 8) {
                        if (buf[i] !== 0xFF) break;
                        const marker = buf[i + 1];
                        if (marker >= 0xC0 && marker <= 0xC3) {
                            return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
                        }
                        const segLen = buf.readUInt16BE(i + 2);
                        i += 2 + segLen;
                    }
                    return null;
                }
                if (ext === '.svg') {
                    const text = buf.toString('utf8', 0, Math.min(buf.length, 2000));
                    const wm = text.match(/width=["']?([\d.]+)/);
                    const hm = text.match(/height=["']?([\d.]+)/);
                    if (wm && hm) return { w: parseFloat(wm[1]), h: parseFloat(hm[1]) };
                    const vbm = text.match(/viewBox=["']?([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
                    if (vbm) return { w: parseFloat(vbm[3]), h: parseFloat(vbm[4]) };
                    return null;
                }
            } catch (_) {}
            return null;
        }

        // ── Helper: file size as human-readable string ────────────────────
        function humanSize(bytes) {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / 1048576).toFixed(2)} MB`;
        }

        // ═══════════════════════════════════════════════════════════════════
        // LIST
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'list') {
            const deck = p.getDeck(docUri);
            if (!deck) return _slideResult('No deck found.');
            if (!fs.existsSync(imgDir)) {
                return _slideResult(
                    `Image folder: img/${deckName}.wslide/\n` +
                    'No images in this deck yet.\n\n' +
                    'To add an image:\n' +
                    `  wolfslide_imageAsset({ action:"copy", srcPath:"/abs/path/to/file.png" })\n` +
                    `  wolfslide_imageAsset({ action:"insert", srcPath:"/abs/path/to/file.png", slideIndex:1, annotation:"..." })`
                );
            }
            const allFiles = fs.readdirSync(imgDir)
                .filter(f => !f.endsWith('.ann.json') && /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f));
            if (!allFiles.length) {
                return _slideResult(`Image folder img/${deckName}.wslide/ exists but contains no image files.`);
            }
            const usage = usageMap(deck);
            const lines = [
                `Image folder: img/${deckName}.wslide/  (${allFiles.length} image${allFiles.length !== 1 ? 's' : ''})`,
                '',
                'Filename'.padEnd(40) + 'Size'.padEnd(12) + 'Dimensions'.padEnd(16) + 'Used on',
                '─'.repeat(90),
            ];
            for (const f of allFiles.sort()) {
                const fpath = path.join(imgDir, f);
                const stat = fs.statSync(fpath);
                const dims = imageDimensions(fpath);
                const dimStr = dims ? `${dims.w}×${dims.h}` : '—';
                const slides = usage[f];
                const usedOn = slides ? slides.join(', ') : '⚠ UNUSED';
                const ann = readAnn(f);
                const annNote = ann?.description ? `  [📝 ${ann.description.slice(0, 60)}]` : '';
                lines.push(
                    f.slice(0, 38).padEnd(40) +
                    humanSize(stat.size).padEnd(12) +
                    dimStr.padEnd(16) +
                    usedOn + annNote
                );
            }
            lines.push('');
            lines.push('UNUSED images are not referenced by any block. Remove with action:"delete".');
            lines.push('Image src path format for blocks: "img/' + deckName + '.wslide/<filename>"');
            return _slideResult(lines.join('\n'));
        }

        // ═══════════════════════════════════════════════════════════════════
        // INFO
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'info') {
            const filename = options.input?.filename;
            if (!filename) return _slideResult('Provide "filename" for action:"info".');
            const fpath = path.join(imgDir, filename);
            if (!fs.existsSync(fpath)) return _slideResult(`File not found: img/${deckName}.wslide/${filename}`);
            const stat = fs.statSync(fpath);
            const dims = imageDimensions(fpath);
            const deck = p.getDeck(docUri);
            const usage = usageMap(deck || { slides: [] });
            const usedSlides = usage[filename] || [];
            const ann = readAnn(filename);
            const lines = [
                `## Image: ${filename}`,
                `Path on disk:  img/${deckName}.wslide/${filename}`,
                `Block src:     "img/${deckName}.wslide/${filename}"`,
                `Size:          ${humanSize(stat.size)}`,
                `Modified:      ${new Date(stat.mtime).toISOString().slice(0, 16).replace('T', ' ')}`,
                `Dimensions:    ${dims ? `${dims.w} × ${dims.h} px` : 'unknown (unsupported format)'}`,
                `Used on slides: ${usedSlides.length ? usedSlides.join(', ') : '⚠ NOT USED in any block'}`,
                '',
            ];
            if (ann) {
                lines.push('## Annotation');
                if (ann.description) lines.push(`Description: ${ann.description}`);
                if (ann.source)      lines.push(`Source:      ${ann.source}`);
                if (ann.tags?.length) lines.push(`Tags:        ${ann.tags.join(', ')}`);
            } else {
                lines.push('No annotation yet. Add one with action:"annotate".');
            }
            lines.push('');
            lines.push('Rendered block snippet (copy and paste into slide children):');
            const blockW = dims ? Math.min(dims.w, 1600) : 900;
            const blockH = dims ? Math.min(dims.h, 900) : 600;
            lines.push(JSON.stringify({
                type: 'image',
                src: `img/${deckName}.wslide/${filename}`,
                w: blockW, h: blockH,
                fit: 'contain',
                alt: ann?.description || filename,
            }, null, 2));
            return _slideResult(lines.join('\n'));
        }

        // ═══════════════════════════════════════════════════════════════════
        // COPY — import an external file into the deck's img/ folder
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'copy') {
            const srcPath = options.input?.srcPath;
            if (!srcPath) return _slideResult('Provide "srcPath" (absolute path to source image) for action:"copy".');
            if (!fs.existsSync(srcPath)) return _slideResult(`Source file not found: ${srcPath}`);
            fs.mkdirSync(imgDir, { recursive: true });
            let fname = options.input?.filename || path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
            const overwrite = !!options.input?.overwrite;
            // Avoid collisions unless overwrite:true was requested
            if (!overwrite && fs.existsSync(path.join(imgDir, fname))) {
                const ext  = path.extname(fname);
                const base = path.basename(fname, ext);
                fname = base + '_' + Date.now() + ext;
            }
            const wasOverwritten = overwrite && fs.existsSync(path.join(imgDir, fname));
            fs.copyFileSync(srcPath, path.join(imgDir, fname));
            const stat = fs.statSync(path.join(imgDir, fname));
            const dims = imageDimensions(path.join(imgDir, fname));

            // Auto-annotate if annotation provided
            const annotation = options.input?.annotation;
            if (annotation) {
                const ann = typeof annotation === 'string'
                    ? { description: annotation, source: srcPath, tags: [] }
                    : { source: srcPath, ...annotation };
                writeAnn(fname, ann);
            }

            const lines = [
                `✅ ${wasOverwritten ? 'Overwrote' : 'Copied'}: ${path.basename(srcPath)} → img/${deckName}.wslide/${fname}`,
                `   Size: ${humanSize(stat.size)}`,
                dims ? `   Dimensions: ${dims.w} × ${dims.h} px` : '',
                '',
                'Block src value to use in slides:',
                `  "src": "img/${deckName}.wslide/${fname}"`,
                '',
                'Ready-to-use image block:',
                JSON.stringify({
                    type: 'image',
                    src: `img/${deckName}.wslide/${fname}`,
                    w: dims ? Math.min(dims.w, 1600) : 900,
                    h: dims ? Math.min(dims.h, 900) : 600,
                    fit: 'contain',
                    alt: annotation && typeof annotation === 'string' ? annotation : (dims ? `${dims.w}×${dims.h} image` : fname),
                }, null, 2),
                '',
                annotation ? `Annotation saved.` : `Tip: add a description with action:"annotate", filename:"${fname}", description:"..."`,
            ].filter(l => l !== '');
            return _slideResult(lines.join('\n'));
        }

        // ═══════════════════════════════════════════════════════════════════
        // DELETE — remove an image file (warns if still referenced)
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'delete') {
            const filename = options.input?.filename;
            if (!filename) return _slideResult('Provide "filename" for action:"delete".');
            const fpath = path.join(imgDir, filename);
            if (!fs.existsSync(fpath)) return _slideResult(`File not found: img/${deckName}.wslide/${filename}`);

            const deck = p.getDeck(docUri);
            const usage = usageMap(deck || { slides: [] });
            const usedSlides = usage[filename] || [];
            if (usedSlides.length && !options.input?.force) {
                return _slideResult(
                    `⚠ img/${deckName}.wslide/${filename} is still referenced by: ${usedSlides.join(', ')}.\n` +
                    `Remove the image block(s) from those slides first, or pass force:true to delete anyway.`
                );
            }
            fs.unlinkSync(fpath);
            // Remove annotation sidecar if present
            const annPath = path.join(imgDir, filename + '.ann.json');
            if (fs.existsSync(annPath)) fs.unlinkSync(annPath);
            const warn = usedSlides.length ? `\n⚠ Blocks on [${usedSlides.join(', ')}] now have broken image references — update them.` : '';
            return _slideResult(`🗑  Deleted img/${deckName}.wslide/${filename}${warn}`);
        }

        // ═══════════════════════════════════════════════════════════════════
        // RENAME — rename file and update all block src references in deck
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'rename') {
            const filename  = options.input?.filename;
            const newName   = options.input?.newName;
            if (!filename || !newName) return _slideResult('Provide "filename" and "newName" for action:"rename".');
            const oldPath = path.join(imgDir, filename);
            const newPath = path.join(imgDir, newName);
            if (!fs.existsSync(oldPath)) return _slideResult(`File not found: img/${deckName}.wslide/${filename}`);
            if (fs.existsSync(newPath)) return _slideResult(`Target already exists: img/${deckName}.wslide/${newName}`);

            fs.renameSync(oldPath, newPath);
            // Rename annotation sidecar
            const oldAnn = path.join(imgDir, filename + '.ann.json');
            if (fs.existsSync(oldAnn)) fs.renameSync(oldAnn, path.join(imgDir, newName + '.ann.json'));

            // Update all src references in the deck
            const oldSrc = `img/${deckName}.wslide/${filename}`;
            const newSrc = `img/${deckName}.wslide/${newName}`;
            const deck = p.getDeck(docUri);
            let updateCount = 0;
            function patchSrcs(b) {
                if (!b) return;
                if (b.src === oldSrc) { b.src = newSrc; updateCount++; }
                (b.children || b.items || b.elements || []).forEach(patchSrcs);
            }
            (deck.slides || []).forEach(s => (s.children || s.elements || []).forEach(patchSrcs));
            if (updateCount > 0) {
                await p.applyDeck(deck, docUri);
            }
            return _slideResult(
                `✅ Renamed: ${filename} → ${newName}\n` +
                (updateCount > 0 ? `   Updated ${updateCount} block src reference(s) in the deck.` : '   No block references found (file was unused).')
            );
        }

        // ═══════════════════════════════════════════════════════════════════
        // ANNOTATE — write/update annotation sidecar JSON
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'annotate') {
            const filename = options.input?.filename;
            if (!filename) return _slideResult('Provide "filename" for action:"annotate".');
            const fpath = path.join(imgDir, filename);
            if (!fs.existsSync(fpath)) return _slideResult(`File not found: img/${deckName}.wslide/${filename}`);

            const existing = readAnn(filename) || {};
            if (options.input?.description !== undefined) existing.description = options.input.description;
            if (options.input?.source      !== undefined) existing.source      = options.input.source;
            if (options.input?.tags        !== undefined) existing.tags        = options.input.tags;
            writeAnn(filename, existing);
            return _slideResult(
                `✅ Annotation saved for img/${deckName}.wslide/${filename}:\n` +
                JSON.stringify(existing, null, 2)
            );
        }

        // ═══════════════════════════════════════════════════════════════════
        // INSERT — copy image + add image block to a slide in one step
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'insert') {
            const srcPath = options.input?.srcPath;
            const filename = options.input?.filename;
            if (!srcPath && !filename) return _slideResult('Provide "srcPath" (external file) or "filename" (already in img/) for action:"insert".');

            let fname = filename;
            // Copy if srcPath provided
            if (srcPath) {
                if (!fs.existsSync(srcPath)) return _slideResult(`Source file not found: ${srcPath}`);
                fs.mkdirSync(imgDir, { recursive: true });
                fname = options.input?.filename || path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
                if (fs.existsSync(path.join(imgDir, fname))) {
                    const ext = path.extname(fname); const base = path.basename(fname, ext);
                    fname = base + '_' + Date.now() + ext;
                }
                fs.copyFileSync(srcPath, path.join(imgDir, fname));
            }

            const fpath = path.join(imgDir, fname);
            if (!fs.existsSync(fpath)) return _slideResult(`File not found: img/${deckName}.wslide/${fname}`);
            const dims = imageDimensions(fpath);

            // Annotate if provided
            const annotation = options.input?.annotation;
            if (annotation) {
                const ann = typeof annotation === 'string'
                    ? { description: annotation, source: srcPath || fname, tags: [] }
                    : { source: srcPath || fname, ...annotation };
                writeAnn(fname, ann);
            }
            const altText = (typeof annotation === 'string' ? annotation : annotation?.description) || fname;

            // Resolve slide
            const deck = p.getDeck(docUri);
            if (!deck) return _slideResult('No deck found.');
            const res = _resolveSlide({ input: { slideIndex: options.input?.slideIndex, slideId: options.input?.slideId } });
            if (!res || res.error) return _slideResult(res?.error || 'Could not find slide.');
            const slide = deck.slides[res.idx];

            // Build block
            const blk = {
                id: _uid(),
                type: 'image',
                src: `img/${deckName}.wslide/${fname}`,
                w: options.input?.w || (dims ? Math.min(dims.w, 1600) : 900),
                h: options.input?.h || (dims ? Math.min(dims.h, 900)  : 600),
                fit: options.input?.fit || 'contain',
                alt: altText,
            };
            if (options.input?.style) blk.style = options.input.style;
            if (options.input?.fragmentOrder != null) blk.fragmentOrder = options.input.fragmentOrder;

            // Insert into target container or root children
            const targetBlockId = options.input?.targetBlockId;
            if (targetBlockId) {
                const found = _findBlockRecursive(targetBlockId, slide);
                if (!found) return _slideResult(`Block id="${targetBlockId}" not found on slide ${res.idx + 1}.`);
                const arr = found.block.children = found.block.children || [];
                arr.push(blk);
            } else {
                (slide.children = slide.children || []).push(blk);
            }

            await p.applyDeck(deck, docUri);
            return _slideResult(
                `✅ Image inserted on slide ${res.idx + 1} ("${slide.label || ''}").\n` +
                (srcPath ? `   Copied: ${path.basename(srcPath)} → img/${deckName}.wslide/${fname}\n` : '') +
                `   Block id: ${blk.id}\n` +
                `   Dimensions: ${dims ? `${dims.w}×${dims.h}` : 'unknown'}  |  displayed at: ${blk.w}×${blk.h}\n` +
                (annotation ? `   Annotation saved.\n` : '') +
                `\nEdit the block later with wolfslide_block({action:"edit", slideIndex:${res.idx + 1}, blockId:"${blk.id}", updates:{...}})`
            );
        }

        return _slideResult(`Unknown action "${action}". Valid actions: list, info, copy, delete, rename, annotate, insert.`);
    }
}

// ── Bulk insert tool ──────────────────────────────────────────────────────

class WolfslideBulkInsertTool {
    prepareInvocation(options) {
        const n = options.input?.slides?.length ?? '?';
        return { invocationMessage: `Bulk inserting ${n} slides` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');

        const slides = options.input?.slides;
        if (!slides || !Array.isArray(slides) || slides.length === 0) {
            return _slideResult('"slides" array is required and must be non-empty. Each slide: {label, background, layout, children:[{type, ...}]}. Block types: container, heading, text, image, list, math, box, code, arrow, eval, raw.');
        }

        // Normalize authoring shorthands (string list items, eval content→input)
        // BEFORE validation, so plain-string list items don't trip the "missing
        // type" check below. See feedback §G.
        slides.forEach(s => { _normalizeBlockTree(s.children); _normalizeBlockTree(s.items); _normalizeBlockTree(s.elements); });

        // Validate block types across all incoming slides
        const VALID_BULK_TYPES = new Set(['container','heading','text','image','list','math','box','raw','code','arrow','eval']);
        const typeWarnings = [];
        function _checkBulkTypes(blocks, path) {
            if (!Array.isArray(blocks)) return;
            for (const b of blocks) {
                if (!b) continue;
                if (!b.type) typeWarnings.push(`Block ${path}id=${b.id||'?'} is missing "type" — will not render. Valid types: ${[...VALID_BULK_TYPES].join(', ')}`);
                else if (!VALID_BULK_TYPES.has(b.type)) typeWarnings.push(`Block ${path}id=${b.id||'?'} has unknown type "${b.type}". Valid types: ${[...VALID_BULK_TYPES].join(', ')}`);
                _checkBulkTypes(b.children || b.items || b.elements, `${path}${b.id||'?'}/`);
            }
        }
        slides.forEach((s, i) => _checkBulkTypes(s.children || s.items || s.elements, `slide[${i+1}]/`));
        if (typeWarnings.length > 0) {
            return _slideResult(`Validation errors in slides — fix before inserting:\n${typeWarnings.map(w => '  ⚠ ' + w).join('\n')}`);
        }

        // Freshen any block IDs that would collide with existing blocks in the deck
        const bulkWarnings = [];
        const existingIdsBulk = _collectDeckIds(deck);
        for (const s of slides) {
            _freshenConflicts(existingIdsBulk, s.children, bulkWarnings);
            _freshenConflicts(existingIdsBulk, s.items, bulkWarnings);
            _freshenConflicts(existingIdsBulk, s.elements, bulkWarnings);
        }

        const afterIndex = options.input?.afterIndex;
        const insertAt = (afterIndex != null) ? Math.min(afterIndex, deck.slides.length) : deck.slides.length;

        for (let i = 0; i < slides.length; i++) {
            const s = slides[i];
            if (!s.id) s.id = _uid();
            if (!s.children) s.children = [];
            _ensureBlockIds(s);
            deck.slides.splice(insertAt + i, 0, s);
        }

        // Optionally set theme if provided
        if (options.input?.theme) {
            if (!deck.theme) deck.theme = {};
            if (typeof options.input.theme === 'string' && THEME_PRESETS[options.input.theme]) {
                const preset = THEME_PRESETS[options.input.theme];
                Object.assign(deck.theme, preset.theme);
                for (const s of deck.slides) {
                    if (!s.background || s.background === '#fafcff') s.background = preset.defaultBackground;
                }
            } else if (typeof options.input.theme === 'object') {
                Object.assign(deck.theme, options.input.theme);
            }
        }

        // Optionally set meta
        if (options.input?.meta && typeof options.input.meta === 'object') {
            if (!deck.meta) deck.meta = {};
            Object.assign(deck.meta, options.input.meta);
        }

        await p.applyDeck(deck, docUri);
        const bulkWarnStr = bulkWarnings.length ? `\nWarnings:\n${bulkWarnings.map(w => `  ⚠ ${w}`).join('\n')}` : '';
        return _slideResult(`Bulk-inserted ${slides.length} slides at position ${insertAt + 1}–${insertAt + slides.length}. Deck now has ${deck.slides.length} slides.${bulkWarnStr}`);
    }
}

// ── Eval block tools ──────────────────────────────────────────────────────

// Shared kernel expression builder for eval blocks:
// Graphics → SVG (with font→curves attempt); Non-graphics → boxes (BTL → LaTeX); fallback → PNG
// Fixes:
//  1. Syntax errors: ToExpression[..., Hold] detects parse failures before TimeConstrained
//  2. MakeBoxes HoldAllComplete: With[{val=res}, MakeBoxes[val,...]] injects the value
//  3. Timeout sentinel: $wbTO$ is a Block-local symbol, can never collide with a real result
function _buildEvalExpr(escaped, timeout, imgW) {
    return `Block[{$wbRes$, $wbSvg$, $wbImg$, $wbBoxes$, $wbGfx$, $wbParsed$, $wbTO$},
  (* Step 1: parse without evaluating — catches syntax errors before timeout wrapping *)
  $wbParsed$ = Quiet[ToExpression["${escaped}", InputForm, Hold]];
  If[!MatchQ[$wbParsed$, Hold[_]],
    "ERROR:Syntax error in expression",
    (* Step 2: evaluate with timeout; $wbTO$ is Block-local so it can never equal a real result *)
    $wbRes$ = TimeConstrained[ReleaseHold[$wbParsed$], ${timeout}, $wbTO$];
    If[$wbRes$ === $wbTO$,
      "ERROR:Evaluation timed out after ${timeout}s",
      $wbGfx$ = !FreeQ[$wbRes$, _Graphics | _Graphics3D | _Graph | _GeoGraphics | _Legended | _Image | _Image3D];
      If[$wbGfx$,
        (* Graphics: try SVG with text-to-outlines first, fall back to plain SVG, then PNG *)
        $wbSvg$ = Quiet[ExportString[$wbRes$, "SVG", ImageSize -> ${imgW}, Background -> None, "ConvertTextToOutlines" -> True]];
        If[!StringQ[$wbSvg$] || !StringContainsQ[$wbSvg$, "<svg"],
          $wbSvg$ = Quiet[ExportString[$wbRes$, "SVG", ImageSize -> ${imgW}, Background -> None]]];
        If[StringQ[$wbSvg$] && StringContainsQ[$wbSvg$, "<svg"],
          "SVG:" <> $wbSvg$,
          $wbImg$ = Quiet[ExportString[Rasterize[$wbRes$, ImageSize -> ${imgW}, Background -> None], {"Base64", "PNG"}]];
          If[StringQ[$wbImg$], "IMAGE:" <> $wbImg$, "TEXT:" <> ToString[$wbRes$, InputForm]]
        ],
        (* Non-graphics: With[] injects the value past MakeBoxes HoldAllComplete *)
        $wbBoxes$ = Quiet[Check[With[{$wbVal$ = $wbRes$}, ToString[MakeBoxes[$wbVal$, TraditionalForm], InputForm]], $Failed]];
        If[StringQ[$wbBoxes$] && StringLength[$wbBoxes$] > 0,
          "BOXES:" <> $wbBoxes$,
          $wbImg$ = Quiet[ExportString[Rasterize[$wbRes$, ImageSize -> ${imgW}, Background -> None], {"Base64", "PNG"}]];
          If[StringQ[$wbImg$], "IMAGE:" <> $wbImg$, "TEXT:" <> ToString[$wbRes$, InputForm]]
        ]
      ]
    ]
  ]
]`;
}

// Shared result parser — converts kernel result string to output object
function _parseEvalResult(resultStr, imgW) {
    const now = new Date().toLocaleTimeString();
    if (resultStr.startsWith('SVG:')) {
        // Decode WSTP octal escapes + un-double backslashes (same as checkout.js)
        let svg = decodeWstpText(resultStr.slice(4));
        // Clip to <svg…</svg> boundaries
        const svgStart = svg.indexOf('<svg');
        if (svgStart > 0) svg = svg.slice(svgStart);
        const svgEnd = svg.toLowerCase().lastIndexOf('</svg>');
        if (svgEnd >= 0) svg = svg.slice(0, svgEnd + 6);
        svg = svg.replace(/[\n\r]/g, '');
        svg = svg.replace(/<font[\s\S]*?<\/font>/gi, '');
        svg = svg.replace(/<font-face[\s\S]*?\/>/gi, '');
        svg = svg.replace(/MathematicaMono-Regular/g, '"Courier New", Courier, monospace');
        svg = svg.replace(/MathematicaSans-Regular/g, 'Arial, Helvetica, sans-serif');
        svg = svg.replace(/Mathematica1-Bold/g, 'serif');
        svg = svg.replace(/Mathematica1/g, 'serif');
        return { type: 'svg', data: svg, evaluatedAt: now };
    } else if (resultStr.startsWith('BOXES:')) {
        // BTL → LaTeX → KaTeX pre-render
        // Decode WSTP octal escapes + un-double backslashes, then encode to base64 in JS
        // (matches checkout.js; avoids Wolfram ExportString encoding mismatch)
        const cleanBoxes = decodeWstpText(resultStr.slice(6));
        const b64boxes = Buffer.from(cleanBoxes).toString('base64');
        try {
            const _btlDir = require('path').join(__dirname, '../../wllatex-addon');
            const _prebuilt = require('path').join(_btlDir, 'prebuilt',
                `wolfbook_btl-${process.platform}-${process.arch}.node`);
            const _fallback = require('path').join(_btlDir, 'wolfbook_btl.node');
            const _fs = require('fs');
            const _addonPath = _fs.existsSync(_prebuilt) ? _prebuilt : _fallback;
            const _addon = require(_addonPath);
            const _prerender = require(require('path').join(_btlDir, 'katexPrerender.js')).prerenderLatex;
            const _namedchars = require('../namedchars').wlUTFtoNames;

            let boxStr = Buffer.from(b64boxes, 'base64').toString('utf8');
            boxStr = _namedchars(boxStr);
            const btlOpts = { trigOmitParens: true, trigPowerForm: true };
            const result = _addon.boxToLatex(boxStr, btlOpts);
            let latex = (result && typeof result === 'object') ? result.latex : String(result);
            const pageWidthEm = Math.max(0, Math.round(imgW / 10));
            if (pageWidthEm > 5 && _addon.lineBreakLatex) {
                try { latex = _addon.lineBreakLatex(latex, { pageWidth: pageWidthEm }); } catch (_) {}
            }
            const html = _prerender(latex, true);
            return { type: 'latex', html, latex, evaluatedAt: now };
        } catch (e) {
            // BTL not available — decode boxes as text
            try {
                const boxStr = Buffer.from(b64boxes, 'base64').toString('utf8');
                return { type: 'text', text: boxStr, evaluatedAt: now };
            } catch (_) {
                return { type: 'text', text: resultStr, evaluatedAt: now };
            }
        }
    } else if (resultStr.startsWith('IMAGE:')) {
        return { type: 'image', data: 'data:image/png;base64,' + resultStr.slice(6), evaluatedAt: now };
    } else if (resultStr.startsWith('TEXT:')) {
        return { type: 'text', text: resultStr.slice(5), evaluatedAt: now };
    } else if (resultStr.startsWith('ERROR:')) {
        return { type: 'error', error: resultStr.slice(6), evaluatedAt: now };
    } else {
        return { type: 'text', text: resultStr, evaluatedAt: now };
    }
}

class WolfslideInsertEvalBlockTool {
    constructor(getController) { this._getController = getController; }
    prepareInvocation(options) {
        return { invocationMessage: `Inserting eval block on slide ${options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const input = options.input?.input;
        if (!input || typeof input !== 'string') return _slideResult('input (Mathematica expression string) is required.');
        const block = {
            id: _uid(),
            type: 'eval',
            input: input,
        };
        if (options.input?.w) block.w = options.input.w;
        if (options.input?.h) block.h = options.input.h;
        const parentId = options.input?.parentBlockId || null;
        const position = options.input?.position;
        let arr;
        if (parentId) {
            const found = _findBlockRecursive(parentId, r.slide);
            if (!found) return _slideResult(`Parent block "${parentId}" not found.`);
            if (!found.block.children) found.block.children = [];
            arr = found.block.children;
        } else {
            if (!r.slide.children) r.slide.children = [];
            arr = r.slide.children;
        }
        const pos = (position != null && position >= 0) ? Math.min(position, arr.length) : arr.length;
        arr.splice(pos, 0, block);

        // Auto-evaluate if requested (default: true)
        const autoRun = options.input?.autoRun !== false;
        if (autoRun) {
            const evalResult = await this._evalBlockExpr(input, options.input?.w || 800);
            if (evalResult) {
                block.output = evalResult;
            }
        }

        await r.p.applyDeck(r.deck, r.docUri);
        const status = block.output
            ? `Output: ${block.output.type}${block.output.error ? ' — ' + block.output.error : ''}`
            : 'Not evaluated (kernel unavailable or autoRun=false)';
        return _slideResult(`Inserted eval block id=${block.id} at position ${pos} on slide ${r.idx + 1}. ${status}`);
    }

    async _evalBlockExpr(input, imgW) {
        let controller;
        let lease;
        try {
            controller = this._getController?.();
            if (!controller?.session) return null;
            const claim = await acquireKernelForAgent(controller, {
                owner: 'wolfslide_insertEvalBlock', kind: 'slide-evaluation', caption: 'Evaluate inserted slide block'
            });
            if (!claim.lease) return { type: 'error', error: claim.busy?.message || 'Kernel is busy; evaluation was not interrupted.' };
            lease = claim.lease;
            const timeout = 30;
            const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const expr = _buildEvalExpr(escaped, timeout, imgW);
            const raceTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (timeout + 10) * 1000));
            const evalResult = await Promise.race([
                trackedKernelEvaluate(controller, expr, { interactive: false }),
                raceTimeout
            ]);
            const resultStr = (evalResult?.result?.type === 'string' && evalResult.result.value) ? evalResult.result.value : String(evalResult?.result ?? '');
            return _parseEvalResult(resultStr, imgW);
        } catch (err) {
            return { type: 'error', error: err.message || String(err) };
        } finally {
            releaseKernelForAgent(controller, lease);
        }
    }
}

class WolfslideRunEvalBlockTool {
    constructor(getController) { this._getController = getController; }
    prepareInvocation(options) {
        return { invocationMessage: `Running eval block ${options.input?.blockId ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const blockId = options.input?.blockId;
        if (!blockId) return _slideResult('blockId is required.');
        const found = _findBlockRecursive(blockId, r.slide);
        if (!found) {
            const allIds = _collectAllBlocks(r.slide).filter(b => b.type === 'eval').map(b => b.id);
            return _slideResult(`Eval block "${blockId}" not found. Eval blocks on this slide: ${allIds.join(', ') || 'none'}`);
        }
        if (found.block.type !== 'eval') return _slideResult(`Block "${blockId}" is type="${found.block.type}", not "eval".`);
        const input = options.input?.input || found.block.input;
        if (options.input?.input) found.block.input = options.input.input; // update input if provided
        if (!input) return _slideResult('Block has no input expression. Provide input parameter or edit the block first.');

        const controller = this._getController?.();
        if (!controller?.session) return _slideResult('Kernel not connected. Start a Wolfram kernel first.');
        let lease;
        try {
            const claim = await acquireKernelForAgent(controller, {
                owner: 'wolfslide_runEvalBlock', kind: 'slide-evaluation', caption: `Evaluate slide block ${blockId}`
            });
            if (!claim.lease) return claim.error;
            lease = claim.lease;
            const imgW = found.block.w || 800;
            const timeout = 30;
            const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const expr = _buildEvalExpr(escaped, timeout, imgW);
            const raceTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (timeout + 10) * 1000));
            const evalResult = await Promise.race([
                trackedKernelEvaluate(controller, expr, { interactive: false }),
                raceTimeout
            ]);
            const resultStr = (evalResult?.result?.type === 'string' && evalResult.result.value) ? evalResult.result.value : String(evalResult?.result ?? '');
            found.block.output = _parseEvalResult(resultStr, imgW);
            await r.p.applyDeck(r.deck, r.docUri);
            return _slideResult(`Evaluated eval block ${blockId}. Result: ${found.block.output.type}${found.block.output.error ? ' — ' + found.block.output.error : ''}`);
        } catch (err) {
            return _slideResult(`Evaluation failed: ${err.message || err}`);
        } finally {
            releaseKernelForAgent(controller, lease);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_getCellOutput — read current output of a single cell by num or ID
// ---------------------------------------------------------------------------

class GetCellOutputTool {
    constructor(getController) { this._getController = getController; }
    async prepareInvocation(options, _token) {
        const n = options.input?.cellId || options.input?.cellNumber;
        return { invocationMessage: `Read output of cell ${n}` };
    }

    async invoke(options, _token) {
        // Routing-neutral read: never shows or focuses the notebook.
        const notebook = await resolveNotebookDocument(options.input?.notebook);
        if (!notebook) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No Wolfram notebook resolved. Pass notebook, or set a session target.')]);

        const by = options.input?.cellId != null ? options.input.cellId : options.input?.cellNumber;
        if (by == null) {
            if (options.input?.cellIndex != null) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    'Unknown parameter "cellIndex". Use cellId (stable string, preferred) or cellNumber (1-based integer). Example: { cellId: "c3a2" } or { cellNumber: 5 }'
                )]);
            }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Required: cellId (stable string, e.g. "c3a2") or cellNumber (1-based integer, e.g. 5). Call wolfbook_getNotebookContext to get CellId values.'
            )]);
        }
        const resolved = resolveCellIndex(notebook, by, options.input?.cellId != null ? 'cellId' : 'cellNumber');
        if (resolved.error) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(resolved.error)]);
        }

        const idx        = resolved.idx;
        const cell       = notebook.cellAt(idx);
        const cellId     = getCellToolId(cell);
        const cellNumber = idx + 1;
        const controller = this._getController?.();
        const registry = controller?.operations;
        const provenance = registry?.cellState(
            notebook.uri.fsPath, cellId) || null;
        const committed = readCommittedOutputs(cell);
        let state;
        if (provenance) state = provenance.status;
        else if (registry?.hasRestarted) state = 'unknown';
        else if (committed.outputs.length || committed.messages.length) state = 'unknown';
        else state = 'never-run';
        if (state === 'success-with-output' && committed.outputs.length === 0) state = 'success-Null';
        if (committed.aborted) state = 'aborted';
        else if (committed.failed) state = 'failed';
        else if (committed.messages.length && !['running', 'stale', 'aborted', 'failed'].includes(state)) {
            state = 'completed-with-messages';
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
            cell_number: cellNumber, cell_id: cellId, state,
            output: committed.outputs.length ? committed.outputs.join('\n') : null,
            messages: committed.messages,
            provenance,
        }, null, 2))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_validateSyntax — check Wolfram Language syntax in cell(s)
// ---------------------------------------------------------------------------

class ValidateSyntaxTool {
    constructor(getController) { this._getController = getController; }

    async prepareInvocation(options, _token) {
        const n = options.input?.cellId || options.input?.cellNumber;
        if (n != null) {
            return { invocationMessage: `Validate syntax of cell ${n}` };
        }
        const s = options.input?.startCell || 1, e = options.input?.endCell || '\u2026';
        return { invocationMessage: `Validate syntax of cells ${s}\u2013${e}` };
    }

    async invoke(options, _token) {
        // Routing-neutral read: never shows or focuses the notebook.
        const notebook = await resolveNotebookDocument(options.input?.notebook);
        if (!notebook) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No Wolfram notebook resolved. Pass notebook, or set a session target.')]);

        const controller  = this._getController?.();
        const hasKernel   = controller?.session && controller.kernelStatusString === 'resolved';
        let lease;
        if (hasKernel) {
            const claim = await acquireKernelForAgent(controller, {
                owner: 'wolfbook_validateSyntax', kind: 'syntax-validation', caption: 'Validate notebook syntax'
            });
            if (!claim.lease) return claim.error;
            lease = claim.lease;
        }

        let from = 1, to = notebook.cellCount;
        if (options.input?.cellIndex != null) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Unknown parameter "cellIndex". Use cellId (stable string) or cellNumber (1-based integer) for a single cell, or startCell/endCell for a range.'
            )]);
        } else if (options.input?.cellId != null) {
            const resolved = resolveCellIndex(notebook, options.input.cellId, 'cellId');
            if (resolved.error) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(resolved.error)]);
            from = to = resolved.idx + 1;
        } else if (options.input?.cellNumber != null) {
            from = to = Math.max(1, Math.min(notebook.cellCount, Number(options.input.cellNumber)));
        } else if (options.input?.startCell != null) {
            from = Math.max(1, Number(options.input.startCell));
            to   = Math.min(notebook.cellCount, Number(options.input.endCell || notebook.cellCount));
        }

        // Helper: escape a WL string literal
        const escWl = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n');

        const codeErrors  = [];
        const katexErrors = [];
        let codeChecked   = 0;
        let mdChecked     = 0;

        try { for (let n = from; n <= to; n++) {
            const cell   = notebook.cellAt(n - 1);
            const cellId = getCellToolId(cell);

            if (cell.kind === vscode.NotebookCellKind.Markup) {
                // ── Markdown cell: check KaTeX math ───────────────────────
                const src = cell.document.getText();
                if (!src.trim()) continue;
                mdChecked++;
                const errs = checkMarkdownKaTeX(src);
                if (errs.length) {
                    for (const { display, latex, message } of errs) {
                        const delim = display ? '$$' : '$';
                        katexErrors.push(`  Cell ${n} (${cellId}): ${delim}${latex.slice(0, 80)}${latex.length > 80 ? '…' : ''}${delim}\n    → ${message}`);
                    }
                }
                continue;
            }

            // ── Code cell: check WL syntax ────────────────────────────────
            const src = cell.document.getText().trim();
            if (!src) continue;
            codeChecked++;

            if (hasKernel) {
                // SyntaxQ returns True/False; if False, SyntaxLength gives last valid position
                const esc  = escWl(src);
                const expr = `Block[{$wbSrc$="${esc}"}, If[SyntaxQ[$wbSrc$], "OK", "SYNTAX_ERROR at char " <> ToString[SyntaxLength[$wbSrc$] + 1]]]`;
                try {
                    const result = await Promise.race([
                        trackedKernelEvaluate(controller, expr, { interactive: false }),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
                    ]);
                    const val = result?.result?.value || '';
                    if (val && val !== 'OK') {
                        codeErrors.push(`  Cell ${n} (${cellId}): ${val}`);
                    }
                } catch (_) {
                    // Kernel unavailable mid-loop — fall through to bracket check
                }
            } else {
                // Offline heuristic checks (no kernel)
                let depth = 0;
                let inStr = false;
                let bad   = false;
                for (let i = 0; i < src.length; i++) {
                    const c = src[i];
                    if (inStr) {
                        if (c === '\\') { i++; continue; }
                        if (c === '"') inStr = false;
                    } else {
                        if (c === '"') { inStr = true; continue; }
                        if (c === '(' || c === '[' || c === '{') depth++;
                        else if (c === ')' || c === ']' || c === '}') depth--;
                        if (depth < 0) { bad = true; break; }
                    }
                }
                if (bad || depth !== 0 || inStr) {
                    codeErrors.push(`  Cell ${n} (${cellId}): unmatched brackets/string${depth > 0 ? ` (depth=${depth})` : ''}`);
                }
            }
        } } finally {
            releaseKernelForAgent(controller, lease);
        }

        const totalChecked = codeChecked + mdChecked;
        if (totalChecked === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No cells found in range.')]);
        }

        const lines = [];
        const noCodeErrors  = codeErrors.length === 0;
        const noKatexErrors = katexErrors.length === 0;

        if (noCodeErrors && noKatexErrors) {
            lines.push(`\u2713 All ${totalChecked} cell(s) valid (cells ${from}\u2013${to}: ${codeChecked} code, ${mdChecked} markdown).`);
            if (!hasKernel && codeChecked > 0)
                lines.push('[Note: kernel not available — ran offline bracket-matching checks only for code cells]');

        } else {
            if (codeErrors.length > 0) {
                lines.push(`\u274C ${codeErrors.length} WL syntax issue(s) in ${codeChecked} code cell(s):`);
                lines.push(...codeErrors);
                if (!hasKernel) lines.push('  [Note: kernel not available — offline bracket-check only]');
            } else if (codeChecked > 0) {
                lines.push(`\u2713 ${codeChecked} code cell(s): WL syntax OK`);
            }
            if (katexErrors.length > 0) {
                lines.push(`\u274C ${katexErrors.length} KaTeX math error(s) in ${mdChecked} markdown cell(s):`);
                lines.push(...katexErrors);
                lines.push('  Fix: check for missing braces (e.g. x_ab → x_{ab}), unsupported commands, or unclosed $ delimiters.');
            } else if (mdChecked > 0) {
                lines.push(`\u2713 ${mdChecked} markdown cell(s): KaTeX math OK`);
            }
        }

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_saveLatex — write a .tex file safely (handles large multi-line content)
// ---------------------------------------------------------------------------

class SaveLatexTool {
    async prepareInvocation(options, _token) {
        return { invocationMessage: `Save LaTeX file: ${options.input?.path || '?'}` };
    }

    async invoke(options, _token) {
        let content = options.input?.content;
        const filePath = options.input?.path;
        if (!content || !filePath) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: both content and path are required. Example: { content: "\\\\documentclass{article}...", path: "/abs/path/to/file.tex" }'
            )]);
        }
        // Unescape double-encoded escape sequences (\n, \", \\)
        try { content = decodeToolContent(content, options.input?.content_encoding); }
        catch (err) { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(err.message)]); }
        const control = findControlChar(content);
        const controlWarning = control
            ? `\nWarning: content contains U+${control.code.toString(16).toUpperCase().padStart(4, '0')} at ${control.line}:${control.col}; preserved because form-feed can be legal in TeX.`
            : '';
        // Resolve relative paths against the active notebook directory
        let absPath = filePath;
        if (!path.isAbsolute(filePath)) {
            // Base-dir lookup only — must not show/focus any notebook.
            const doc  = await resolveNotebookDocument();
            const base = doc ? path.dirname(doc.uri.fsPath) : process.cwd();
            absPath = path.join(base, filePath);
        }
        try {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, content, 'utf8');
            const lines = content.split('\n').length;
            const bytes = Buffer.byteLength(content, 'utf8');
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Saved: ${absPath}\n${lines} lines, ${bytes} bytes${controlWarning}`
            )]);
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Error writing file: ${err.message}`
            )]);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_compileLatex — run latexmk and return structured output
// ---------------------------------------------------------------------------

class CompileLatexTool {
    async prepareInvocation(options, _token) {
        return { invocationMessage: `Compile LaTeX: ${path.basename(options.input?.path || '?')}` };
    }

    async invoke(options, _token) {
        const { execFile } = require('child_process');
        const filePath = options.input?.path;
        if (!filePath) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: path to .tex file is required.'
            )]);
        }
        let absPath = filePath;
        if (!path.isAbsolute(filePath)) {
            // Base-dir lookup only — must not show/focus any notebook.
            const doc  = await resolveNotebookDocument();
            const base = doc ? path.dirname(doc.uri.fsPath) : process.cwd();
            absPath = path.join(base, filePath);
        }
        if (!fs.existsSync(absPath)) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `File not found: ${absPath}`
            )]);
        }
        const engine  = options.input?.engine || 'pdflatex';
        const workDir = path.dirname(absPath);
        const baseFile = path.basename(absPath);
        const timeoutMs = (Number(options.input?.timeoutSeconds) || 60) * 1000;

        return new Promise(resolve => {
            const args   = ['-' + engine, '-interaction=nonstopmode', '-halt-on-error', baseFile];
            const proc   = execFile('latexmk', args, { cwd: workDir, timeout: timeoutMs }, (err, stdout, stderr) => {
                const combined = (stdout || '') + (stderr || '');
                const success  = !err || err.code === 0;
                // Extract key error lines
                const errLines = combined.split('\n')
                    .filter(l => /^!|^l\.\d|latexmk.*Error/i.test(l.trim()))
                    .slice(0, 20)
                    .join('\n');
                const pdfPath = absPath.replace(/\.tex$/, '.pdf');
                const hasPdf  = fs.existsSync(pdfPath);
                let msg;
                if (success || hasPdf) {
                    msg = `\u2713 Compilation succeeded. PDF: ${pdfPath}`;
                    if (errLines) msg += `\nWarnings:\n${errLines}`;
                } else {
                    msg = `\u2717 Compilation failed.\nErrors:\n${errLines || combined.slice(-2000)}`;
                }
                resolve(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(msg)]));
            });
            proc.on('error', procErr => {
                resolve(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Failed to run latexmk: ${procErr.message}\nMake sure latexmk is installed (brew install latexmk or via TeX Live).`
                )]));
            });
        });
    }
}

// ---------------------------------------------------------------------------
// wolfbook_getLatexErrors — parse a .log file for errors and warnings only
// ---------------------------------------------------------------------------

class GetLatexErrorsTool {
    async prepareInvocation(options, _token) {
        return { invocationMessage: `Parse LaTeX log: ${path.basename(options.input?.path || '?')}` };
    }

    async invoke(options, _token) {
        const filePath = options.input?.path;
        if (!filePath) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: path to .log or .tex file is required. For .tex files, the corresponding .log is read automatically.'
            )]);
        }
        let absPath = filePath;
        if (!path.isAbsolute(filePath)) {
            // Base-dir lookup only — must not show/focus any notebook.
            const doc  = await resolveNotebookDocument();
            const base = doc ? path.dirname(doc.uri.fsPath) : process.cwd();
            absPath = path.join(base, filePath);
        }
        // Auto-detect: if .tex given, read the .log
        if (absPath.endsWith('.tex')) absPath = absPath.replace(/\.tex$/, '.log');
        if (!fs.existsSync(absPath)) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Log file not found: ${absPath}\nRun wolfbook_compileLatex first to generate it.`
            )]);
        }
        const raw = fs.readFileSync(absPath, 'utf8');
        const lines = raw.split('\n');
        const errors   = [];
        const warnings = [];

        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            // Hard errors: lines starting with !
            if (/^!/.test(l)) {
                // Grab context: the ! line + next few lines
                const ctx = lines.slice(i, Math.min(i + 4, lines.length)).join('\n');
                errors.push(ctx);
                i += 3;
                continue;
            }
            // LaTeX warnings
            if (/^(LaTeX Warning|LaTeX Font Warning|Package \w+ Warning|Overfull|Underfull)/i.test(l)) {
                let ctx = l;
                // Multi-line warnings end with a period or empty line
                let j = i + 1;
                while (j < lines.length && lines[j].trim() && !/^[(!]/.test(lines[j])) {
                    ctx += ' ' + lines[j].trim();
                    j++;
                    if (j - i > 5) break;
                }
                warnings.push(ctx.slice(0, 200));
            }
        }

        const parts = [];
        if (errors.length > 0) {
            parts.push(`**${errors.length} error(s):**\n` + errors.join('\n---\n'));
        }
        if (warnings.length > 0) {
            const shown = warnings.slice(0, 20);
            parts.push(`**${warnings.length} warning(s)${warnings.length > 20 ? ' (showing first 20)' : ''}:**\n` + shown.join('\n'));
        }
        if (parts.length === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `\u2713 No errors or warnings found in ${absPath}`
            )]);
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(parts.join('\n\n'))]);
    }
}

// ---------------------------------------------------------------------------
// Consolidated tool: wolfbook_latex — save, compile, errors, or full build pipeline
// ---------------------------------------------------------------------------

class LatexTool {
    constructor() {
        this._save = new SaveLatexTool();
        this._compile = new CompileLatexTool();
        this._errors = new GetLatexErrorsTool();
    }
    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'build';
        const file = path.basename(options.input?.path || '?');
        return { invocationMessage: `LaTeX ${action}: ${file}` };
    }
    async invoke(options, _token) {
        const action = options.input?.action;
        if (!action) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: action is required. Use "save", "compile", "errors", or "build".'
            )]);
        }
        switch (action) {
            case 'save':
                return this._save.invoke(options, _token);
            case 'compile':
                return this._compile.invoke(options, _token);
            case 'errors':
                return this._errors.invoke(options, _token);
            case 'build': {
                const saveResult = await this._save.invoke(options, _token);
                const saveText = saveResult.content?.map(p => p.value).join('') || '';
                if (saveText.startsWith('Error')) return saveResult;
                const compileResult = await this._compile.invoke(options, _token);
                const compileText = compileResult.content?.map(p => p.value).join('') || '';
                const errorsResult = await this._errors.invoke(options, _token);
                const errorsText = errorsResult.content?.map(p => p.value).join('') || '';
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `--- Save ---\n${saveText}\n\n--- Compile ---\n${compileText}\n\n--- Log ---\n${errorsText}`
                )]);
            }
            default:
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Unknown action "${action}". Use "save", "compile", "errors", or "build".`
                )]);
        }
    }
}

// ── Simple glob helper (only * is special) ────────────────────────────────
function _matchGlob(pattern, str) {
    if (!str) return false;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$').test(str);
}

// ---------------------------------------------------------------------------
// Consolidated tool: wolfslide_block — insert, edit, delete, move blocks
// ---------------------------------------------------------------------------

class WolfslideBlockTool {
    constructor() {
        this._edit = new WolfslideEditBlockTool();
        this._insert = new WolfslideInsertBlockTool();
        this._delete = new WolfslideDeleteBlockTool();
        this._move = new WolfslideMoveBlockTool();
    }
    async prepareInvocation(options, _token) {
        const action = options.input?.action || '?';
        if (action === 'bulkEdit') {
            const n = (options.input?.edits || []).length;
            return { invocationMessage: `Slide block bulkEdit (${n} edit${n !== 1 ? 's' : ''})` };
        }
        return { invocationMessage: `Slide block ${action}` };
    }
    async invoke(options, _token) {
        const action = options.input?.action;
        if (!action) {
            return _slideResult('Error: action is required. Use "insert", "edit", "delete", "move", "bulkEdit", or "getBlock".');
        }
        switch (action) {
            case 'insert':    return this._insert.invoke(options, _token);
            case 'edit':      return this._edit.invoke(options, _token);
            case 'delete':    return this._delete.invoke(options, _token);
            case 'move':      return this._move.invoke(options, _token);
            case 'bulkEdit':  return this._bulkEdit(options, _token);
            case 'getBlock':  return this._getBlock(options, _token);
            case 'bulkPatch': return this._bulkPatch(options, _token);
            default:
                return _slideResult(`Unknown action "${action}". Use "insert", "edit", "delete", "move", "bulkEdit", "getBlock", or "bulkPatch".`);
        }
    }
    async _bulkEdit(options, _token) {
        const edits = options.input?.edits;
        if (!Array.isArray(edits) || edits.length === 0)
            return _slideResult('Error: edits array is required and must be non-empty.');
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');
        const applied = [];
        const failed  = [];
        for (const edit of edits) {
            const { blockId, updates, patch, slideId, slideIndex } = edit;
            const mergeProps = updates || patch;
            if (!blockId || !mergeProps || typeof mergeProps !== 'object') {
                failed.push(`  missing blockId or updates/patch: ${JSON.stringify(edit).slice(0, 80)}`);
                continue;
            }
            // Resolve slide
            let slideObj;
            if (slideId) {
                slideObj = deck.slides.find(s => s.id === slideId);
            } else if (slideIndex != null) {
                slideObj = deck.slides[slideIndex - 1];
            } else {
                // Search all slides for the block
                for (const s of deck.slides) {
                    if (_findBlockRecursive(blockId, s)) { slideObj = s; break; }
                }
            }
            if (!slideObj) { failed.push(`  block ${blockId}: slide not found`); continue; }
            const found = _findBlockRecursive(blockId, slideObj);
            if (!found) { failed.push(`  block ${blockId}: not found on slide "${slideObj.label || slideObj.id}"`); continue; }
            _deepMerge(found.block, mergeProps);
            applied.push(`  block ${blockId} on slide "${slideObj.label || slideObj.id}": ${Object.keys(mergeProps).join(', ')}`);
        }
        if (applied.length === 0 && failed.length > 0)
            return _slideResult('All edits failed:\n' + failed.join('\n'));
        await p.applyDeck(deck, docUri);
        const lines = [`Applied ${applied.length} / ${edits.length} block edit(s):`];
        lines.push(...applied);
        if (failed.length) { lines.push(`Failed ${failed.length}:`); lines.push(...failed); }
        return _slideResult(lines.join('\n'));
    }

    _getBlock(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const ref = _resolveBlockRef(options, r);
        if (ref.error) return _slideResult(ref.error);
        const { found, resolvedSlide, resolvedIdx } = ref;
        const parentLabel = found.parent === resolvedSlide
            ? `slide root (${resolvedSlide.id || '?'})`
            : `block ${found.parent.id || '?'} (${found.parent.type || '?'})`;
        return _slideResult(
            `Block on slide ${resolvedIdx + 1} "${resolvedSlide.label || resolvedSlide.id}"\n` +
            `Parent: ${parentLabel}, array: ${found.key}, index: ${found.index}\n` +
            _blockLabel(found.block) + _blockAnno(found.block) + `  #${found.block.id || ''}\n\n` +
            `Full JSON:\n\`\`\`json\n${JSON.stringify(found.block, null, 2)}\n\`\`\``
        );
    }

    async _bulkPatch(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');

        const selector = options.input?.selector;
        const patch    = options.input?.patch;
        if (!selector || typeof selector !== 'object')
            return _slideResult('selector object is required. Supported keys: blockIds, type, className, namePattern, hasStyle, stylePreset.');
        if (!patch || typeof patch !== 'object')
            return _slideResult('patch object is required.');

        // Build matcher from selector
        function _matches(b) {
            if (!b || typeof b !== 'object') return false;
            if (selector.blockIds) {
                if (!Array.isArray(selector.blockIds)) return false;
                if (!selector.blockIds.includes(b.id)) return false;
            }
            if (selector.type !== undefined) {
                if (b.type !== selector.type) return false;
            }
            if (selector.className !== undefined) {
                const cls = b.className || '';
                if (!cls.split(/\s+/).includes(selector.className)) return false;
            }
            if (selector.namePattern !== undefined) {
                if (!_matchGlob(selector.namePattern, b.name || '')) return false;
            }
            if (selector.stylePreset !== undefined) {
                if (b.stylePreset !== selector.stylePreset) return false;
            }
            if (selector.hasStyle !== undefined) {
                if (typeof selector.hasStyle !== 'object' || !b.style) return false;
                for (const [k, v] of Object.entries(selector.hasStyle)) {
                    if (b.style[k] !== v) return false;
                }
            }
            return true;
        }

        const matched = [];
        for (let si = 0; si < deck.slides.length; si++) {
            const allBlocks = _collectAllBlocks(deck.slides[si]);
            for (const b of allBlocks) {
                if (_matches(b)) matched.push({ block: b, slideIdx: si, slide: deck.slides[si] });
            }
        }

        if (matched.length === 0) {
            return _slideResult(`No blocks matched selector ${JSON.stringify(selector)}.`);
        }

        for (const { block } of matched) {
            _deepMerge(block, patch);
        }

        await p.applyDeck(deck, docUri);

        const selectorDesc = Object.entries(selector).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(', ');
        const patchKeys = Object.keys(patch).join(', ');
        const lines = [
            `Patched ${matched.length} block(s) matching [${selectorDesc}]. Keys changed: ${patchKeys}.`,
            '',
            ...matched.map(({ block: b, slideIdx: si, slide: s }) =>
                `  slide ${si + 1} "${s.label || s.id}"  ${_blockLabel(b)}  #${b.id}${b.name ? `  name:${b.name}` : ''}`)
        ];
        return _slideResult(lines.join('\n'));
    }
}

// ---------------------------------------------------------------------------
// Consolidated tool: wolfslide_advanced — duplicate, check, reorderFragments, measure
// ---------------------------------------------------------------------------

class WolfslideAdvancedTool {
    constructor() {
        this._duplicate = new WolfslideDuplicateSlideTool();
        this._check = new WolfslideCheckDeckTool();
        this._reorder = new WolfslideReorderFragmentsTool();
        this._measure = new WolfslideMeasureSlideTool();
    }
    async prepareInvocation(options, _token) {
        const action = options.input?.action || '?';
        return { invocationMessage: `Slide advanced: ${action}` };
    }
    async invoke(options, _token) {
        const action = options.input?.action;
        if (!action) {
            return _slideResult('Error: action is required. Use "duplicate", "check", "reorderFragments", or "measure".');
        }
        switch (action) {
            case 'duplicate':        return this._duplicate.invoke(options, _token);
            case 'check':            return this._check.invoke(options, _token);
            case 'reorderFragments': return this._reorder.invoke(options, _token);
            case 'measure':          return this._measure.invoke(options, _token);
            default:
                return _slideResult(`Unknown action "${action}". Use "duplicate", "check", "reorderFragments", or "measure".`);
        }
    }
}


// ── Dedicated single-block patch (discoverability alias for wolfslide_block action:edit) ──

class WolfslidePatchBlockTool {
    constructor() { this._edit = new WolfslideEditBlockTool(); }
    prepareInvocation(options) {
        const patch = options.input?.patch ?? options.input?.updates;
        const mode = (!patch || Object.keys(patch).length === 0) ? 'inspect' : 'patch';
        return { invocationMessage: `${mode === 'inspect' ? 'Inspecting' : 'Patching'} block ${options.input?.blockId ?? options.input?.blockName ?? ''}` };
    }
    async invoke(options, _token) {
        const patch = options.input?.patch ?? options.input?.updates;
        // Inspect mode: no patch — find the block and return its current JSON
        if (!patch || (typeof patch === 'object' && Object.keys(patch).length === 0)) {
            const r = _resolveSlide(options);
            if (!r) return _slideResult('No .wslide editor is open.');
            if (r.error) return _slideResult(r.error);
            const ref = _resolveBlockRef(options, r);
            if (ref.error) return _slideResult(ref.error);
            const { found, resolvedSlide, resolvedIdx } = ref;
            return _slideResult(
                `Block "${found.block.id}" on slide ${resolvedIdx + 1} "${resolvedSlide.label || resolvedSlide.id}":\n` +
                '```json\n' + JSON.stringify(found.block, null, 2) + '\n```'
            );
        }
        // Normal patch mode: delegate to WolfslideEditBlockTool
        const wrapped = {
            input: {
                blockId:    options.input?.blockId,
                blockName:  options.input?.blockName,
                updates:    patch,
                slideIndex: options.input?.slideIndex,
                slideId:    options.input?.slideId,
                docUri:     options.input?.docUri,
            }
        };
        return this._edit.invoke(wrapped, _token);
    }
}

// ── Cross-deck slide copy ─────────────────────────────────────────────────

/**
 * Resolve { deckDir, deckName, imgDir } for a deck URI (or the active entry
 * when docUri is undefined).  Returns null if the deck is not open.
 */
function _deckInfoFromUri(p, docUri) {
    if (docUri) {
        const deckDir = p.getDeckDir(docUri);
        if (!deckDir) return null;
        try {
            const deckFsPath = vscode.Uri.parse(docUri).fsPath;
            const deckName = path.basename(deckFsPath, '.wslide');
            return { deckDir, deckName, imgDir: path.join(deckDir, 'img', deckName + '.wslide') };
        } catch (_) { return null; }
    }
    const entry = p.getActiveEntry();
    if (!entry) return null;
    const deckFsPath = entry.document.uri.fsPath;
    const deckDir    = path.dirname(deckFsPath);
    const deckName   = path.basename(deckFsPath, '.wslide');
    return { deckDir, deckName, imgDir: path.join(deckDir, 'img', deckName + '.wslide') };
}

class WolfslideCopySlides {
    prepareInvocation(options) {
        const inp = options.input || {};
        const count = Array.isArray(inp.slideIndices)
            ? inp.slideIndices.length
            : (inp.from != null ? `${inp.from}–${inp.to}` : '1 slide');
        return { invocationMessage: `Copying ${count} slide(s) to target deck` };
    }

    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');

        // ── Resolve source ──────────────────────────────────────────────────
        const srcDocUri = options.input?.sourceDocUri || undefined;
        const srcDeck   = p.getDeckOnDisk(srcDocUri);
        if (!srcDeck) return _slideResult('Source deck not found — ensure the source .wslide file is open in the editor.');
        const srcInfo = _deckInfoFromUri(p, srcDocUri);
        if (!srcInfo) return _slideResult('Could not resolve source deck path.');

        // ── Resolve target ──────────────────────────────────────────────────
        const tgtDocUri = options.input?.targetDocUri;
        if (!tgtDocUri) return _slideResult('targetDocUri is required. Run wolfslide_getContext to see the URIs of all open .wslide files.');
        const tgtDeck = p.getDeckOnDisk(tgtDocUri);
        if (!tgtDeck) return _slideResult('Target deck not found — ensure the target .wslide file is open in the editor.');
        const tgtInfo = _deckInfoFromUri(p, tgtDocUri);
        if (!tgtInfo) return _slideResult('Could not resolve target deck path.');

        if (srcInfo.imgDir === tgtInfo.imgDir) {
            return _slideResult('Source and target are the same file. Use wolfslide_duplicateSlide to copy within the same deck.');
        }

        // ── Resolve slide indices (1-based input → 0-based) ─────────────────
        const n = srcDeck.slides.length;
        let indices;
        if (Array.isArray(options.input?.slideIndices)) {
            indices = options.input.slideIndices.map(i => Number(i) - 1);
        } else if (options.input?.from != null && options.input?.to != null) {
            const from = Number(options.input.from) - 1;
            const to   = Number(options.input.to)   - 1;
            if (from < 0 || to >= n || from > to)
                return _slideResult(`Range from=${options.input.from} to=${options.input.to} out of range (source has ${n} slides).`);
            indices = Array.from({ length: to - from + 1 }, (_, k) => from + k);
        } else {
            // Default: currently visible slide in source
            const activeEntry = p.getActiveEntry();
            indices = [activeEntry?.currentSlideIndex ?? 0];
        }
        if (indices.some(i => i < 0 || i >= n))
            return _slideResult(`One or more slideIndices out of range (source has ${n} slides). Use 1-based indices.`);

        // ── Insert position in target ────────────────────────────────────────
        const wasAtEnd = options.input?.insertAtIndex == null;
        const insertAt = wasAtEnd
            ? tgtDeck.slides.length
            : Math.max(0, Math.min(Number(options.input.insertAtIndex) - 1, tgtDeck.slides.length));

        // ── Clone + remap images + fresh IDs ────────────────────────────────
        const imgWarnings = [];
        const copiedSlides = [];

        function _remapImages(node) {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(_remapImages); return; }
            if (node.type === 'image' && typeof node.src === 'string') {
                const srcPrefix = `img/${srcInfo.deckName}.wslide/`;
                if (node.src.startsWith(srcPrefix)) {
                    const filename = node.src.slice(srcPrefix.length);
                    const srcFile  = path.join(srcInfo.imgDir, filename);
                    const tgtFile  = path.join(tgtInfo.imgDir, filename);
                    if (fs.existsSync(srcFile)) {
                        try {
                            fs.mkdirSync(tgtInfo.imgDir, { recursive: true });
                            if (!fs.existsSync(tgtFile)) fs.copyFileSync(srcFile, tgtFile);
                            node.src = `img/${tgtInfo.deckName}.wslide/${filename}`;
                        } catch (e) {
                            imgWarnings.push(`Copy failed for "${filename}": ${e.message}`);
                        }
                    } else {
                        imgWarnings.push(`Source image not found: ${srcFile}`);
                    }
                }
                // External http/https or absolute paths: leave unchanged
            }
            if (node.children) _remapImages(node.children);
            if (node.items)    _remapImages(node.items);
            if (node.elements) _remapImages(node.elements);
        }

        function _freshIds(node) {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(_freshIds); return; }
            if (node.type) node.id = _uid();
            if (node.children) _freshIds(node.children);
            if (node.items)    _freshIds(node.items);
            if (node.elements) _freshIds(node.elements);
        }

        for (const srcIdx of indices) {
            const cloned = JSON.parse(JSON.stringify(srcDeck.slides[srcIdx]));
            cloned.id = _uid();
            _remapImages(cloned);
            _freshIds(cloned);
            copiedSlides.push(cloned);
        }

        // ── Apply to target ──────────────────────────────────────────────────
        tgtDeck.slides.splice(insertAt, 0, ...copiedSlides);
        await p.applyDeck(tgtDeck, tgtDocUri);

        const insertDesc = wasAtEnd ? 'appended to end' : `inserted at position ${insertAt + 1}`;
        let result = `Copied ${copiedSlides.length} slide(s) from "${srcInfo.deckName}.wslide" → "${tgtInfo.deckName}.wslide" (${insertDesc}). Target now has ${tgtDeck.slides.length} slides.`;
        if (imgWarnings.length) {
            result += `\n\nImage warnings (${imgWarnings.length}):\n` + imgWarnings.map(w => `  • ${w}`).join('\n');
        }
        return _slideResult(result);
    }
}

// ---------------------------------------------------------------------------
// Consolidated tool: wolfslide_arrange — align and/or distribute blocks on a slide
// ---------------------------------------------------------------------------

class WolfslideArrangeTool {
    prepareInvocation(options) {
        const i = options.input || {};
        const parts = [];
        if (i.align) parts.push(`align:${i.align}`);
        if (i.distribute) parts.push(`distribute:${i.distribute}`);
        return { invocationMessage: `Arrange blocks${parts.length ? ' (' + parts.join(' + ') + ')' : ''}` };
    }
    async invoke(options, _token) {
        const arrange = require('../slideArrange');
        const input = options.input || {};
        const align = input.align, distribute = input.distribute;
        if (!align && !distribute) {
            return _slideResult('Nothing to do. Pass "align" (left|hcenter|right|top|vcenter|bottom) and/or "distribute" (horizontal|vertical).');
        }
        if (align && arrange.ALIGN_EDGES.indexOf(align) < 0) {
            return _slideResult(`Invalid align "${align}". Use one of: ${arrange.ALIGN_EDGES.join(', ')}.`);
        }

        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = input.docUri;
        const deck = p.getDeck(docUri);
        if (!deck || !Array.isArray(deck.slides)) return _slideResult('No deck found.');

        // Resolve the slide (slideId > slideIndex; else the block search / first slide).
        let sIdx = -1;
        if (input.slideId) sIdx = deck.slides.findIndex(s => s.id === input.slideId);
        else if (input.slideIndex != null) sIdx = input.slideIndex - 1;
        else if (Array.isArray(input.blockIds) && input.blockIds.length) {
            sIdx = deck.slides.findIndex(s => input.blockIds.some(id => _findBlockRecursive(id, s)));
        }
        if (sIdx < 0 && !input.slideId && input.slideIndex == null && !(input.blockIds || []).length) sIdx = 0;
        const slide = deck.slides[sIdx];
        if (!slide) return _slideResult('Slide not found. Pass slideIndex (1-based), slideId, or blockIds.');

        // Gather target blocks: the given ids, else all absolute-positioned blocks on the slide.
        const all = _collectAllBlocks(slide);
        let targets, missing = [];
        if (Array.isArray(input.blockIds) && input.blockIds.length) {
            const byId = {}; all.forEach(b => { if (b && b.id) byId[b.id] = b; });
            targets = input.blockIds.map(id => byId[id]).filter(Boolean);
            missing = input.blockIds.filter(id => !byId[id]);
        } else {
            targets = all.filter(b => b && b.position === 'absolute');
        }

        // Only absolute-positioned blocks carrying real geometry can be arranged.
        const skipped = targets.filter(b => !(b.position === 'absolute' && typeof b.w === 'number' && typeof b.h === 'number')).map(b => b.id);
        const items = targets
            .filter(b => b.position === 'absolute' && typeof b.w === 'number' && typeof b.h === 'number')
            .map(b => ({ id: b.id, x: b.x || 0, y: b.y || 0, w: b.w, h: b.h, _b: b }));
        const need = distribute ? 3 : 1;
        if (items.length < need) {
            return _slideResult(
                `Need ${need}+ absolute-positioned block(s) with x/y/w/h on slide ${sIdx + 1}; found ${items.length}. ` +
                `Flow/column blocks can't be geometry-arranged — give them position:"absolute" with x/y/w/h first (wolfslide_patchBlock).` +
                (skipped.length ? `\nSkipped (not absolute or no size): ${skipped.join(', ')}` : '') +
                (missing.length ? `\nNot found on this slide: ${missing.join(', ')}` : '')
            );
        }

        const logs = [];
        if (align) {
            const relativeTo = input.relativeTo || (items.length < 2 ? 'slide' : 'selection');
            const r = arrange.align(items, { edge: align, relativeTo });
            if (r.error) return _slideResult(r.error);
            logs.push(...r.changelog);
        }
        if (distribute) {
            const r = arrange.distribute(items, { axis: distribute });
            if (r.error) return _slideResult(r.error);
            logs.push(...r.changelog);
        }

        // Write the new coordinates back onto the real blocks and persist.
        items.forEach(it => { it._b.x = Math.round(it.x); it._b.y = Math.round(it.y); });
        await p.applyDeck(deck, docUri);

        const lines = [`Arranged ${items.length} block(s) on slide ${sIdx + 1} "${slide.label || slide.id || ''}":`];
        lines.push(...logs.map(l => '  • ' + l));
        if (skipped.length) lines.push(`  (skipped ${skipped.length} non-absolute/size-less block(s): ${skipped.join(', ')})`);
        if (missing.length) lines.push(`  (blockIds not found on this slide: ${missing.join(', ')})`);
        return _slideResult(lines.join('\n'));
    }
}

module.exports = {
    WolfslideGetContextTool,
    WolfslideListSlidesTool,
    WolfslideGetSlideTool,
    WolfslideInsertSlideTool,
    WolfslideReplaceSlideTool,
    WolfslideEditSlideTool,
    WolfslideDeleteSlideTool,
    WolfslideDeleteSlidesTool,
    WolfslideMoveSlideTool,
    WolfslideUndoTool,
    WolfslideReloadTool,
    WolfslideSaveFileTool,
    WolfslideDuplicateSlideTool,
    WolfslideSearchSlidesTool,
    WolfslideEditBlockTool,
    WolfslideInsertBlockTool,
    WolfslideDeleteBlockTool,
    WolfslideMoveBlockTool,
    WolfslideCheckDeckTool,
    WolfslideReorderFragmentsTool,
    WolfslideMeasureSlideTool,
    WolfslideGetSlideHtmlTool,
    WolfslideGetImageDimensionsTool,
    WolfslideExportHtmlTool,
    WolfslideSetThemeTool,
    WolfslideImageAssetTool,
    WolfslideBulkInsertTool,
    WolfslideCopySlides,
    WolfslideInsertEvalBlockTool,
    WolfslideRunEvalBlockTool,
    WolfslideBlockTool,
    WolfslidePatchBlockTool,
    WolfslideAdvancedTool,
    WolfslideArrangeTool,
    // Non-wolfslide tools that ended up in this file
    GetCellOutputTool,
    ValidateSyntaxTool,
    SaveLatexTool,
    CompileLatexTool,
    GetLatexErrorsTool,
    LatexTool,
};
