"use strict";
// Wolfslide Copilot Tools — extracted from tools/index.js
// Manipulate .wslide custom editors via AI agent tools.

const vscode = require("vscode");
const util   = require("util");
const fs     = require("fs");
const path   = require("path");
const {
    normalizeToolContent, getCellToolId, resolveCellIndex,
    resolveNotebookEditor,
} = require('./shared');

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

/** Recursively assign IDs to any block (or slide children) that lacks one. */
function _ensureBlockIds(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(_ensureBlockIds); return; }
    if (node.type && !node.id) node.id = _uid();
    if (node.children) _ensureBlockIds(node.children);
    if (node.items) _ensureBlockIds(node.items);
    if (node.elements) _ensureBlockIds(node.elements);
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

/** Deep merge source into target (mutates target). Arrays are replaced, not merged. */
function _deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
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

/** Short human-readable label for a block. */
function _blockLabel(b) {
    const nameTag = b.name ? ` "${b.name}"` : '';
    switch (b.type) {
        case 'heading':   return `[H${b.level || 2}${nameTag}] "${_stripHtml(b.content).slice(0, 80)}"`;
        case 'text':      return `[TEXT${nameTag}] "${_stripHtml(b.content).slice(0, 80)}"`;
        case 'code':      return `[CODE${nameTag} ${b.language || ''}] "${_stripHtml(b.content).slice(0, 80)}"`;
        case 'image':     return `[IMG${nameTag}] alt="${b.alt || '⚠NOT SET'}" src=${(b.src || '').split('/').slice(-2).join('/') || '?'}`;
        case 'list':      return `[LIST${nameTag}] ${(b.items || []).length} items: "${_stripHtml((b.items?.[0]?.content) || '').slice(0, 50)}"…`;
        case 'container': {
            const flex = (b.style?.flex || b.style?.width || '').match(/[\d.]+%/) ? ` flex:${b.style.flex || b.style.width}` : (b.flex ? ` flex:${b.flex}` : '');
            const grid = b.style?.gridTemplateColumns ? ` grid(${b.style.gridTemplateColumns})` : '';
            const cn   = b.className ? ` .${b.className}` : '';
            const ch   = (b.children || []).length;
            return `[CONT${nameTag} ${b.layout || 'col'}${flex}${grid}${cn} children:${ch}]`;
        }
        case 'arrow':     return `[ARROW${nameTag}] (${b.x0},${b.y0})→(${b.x1},${b.y1})`;
        case 'raw':       return `[RAW HTML${nameTag}]`;
        case 'eval': {
            const inp = (b.input || '').slice(0, 60);
            const st = b.output ? (b.output.type === 'image' ? '✓img' : b.output.type === 'error' ? '✗err' : '✓txt') : '⏳';
            return `[EVAL${nameTag} ${st}] "${inp}"`;
        }
        default:          return `[${b.type || '?'}${nameTag}]`;
    }
}

/** Positional/animation annotations for a block. */
function _blockAnno(b) {
    const parts = [];
    if (b.name) parts.push(`name:${b.name}`);
    if (b.fragmentOrder != null) parts.push(`⚡step${b.fragmentOrder}`);
    if (b.offset && (b.offset.dx || b.offset.dy))
        parts.push(`@(${b.offset.dx >= 0 ? '+' : ''}${b.offset.dx},${b.offset.dy >= 0 ? '+' : ''}${b.offset.dy})`);
    if (b.w || b.h) {
        let dimStr = `${b.w || '?'}×${b.h || '?'}px`;
        // Show style constraints that override w/h visually
        const mw = b.style?.maxWidth; const mh = b.style?.maxHeight;
        if (mw || mh) dimStr += ` (capped:${mw ? ' maxW=' + mw : ''}${mh ? ' maxH=' + mh : ''})`;
        parts.push(dimStr);
    }
    if (b.type === 'image' && !b.alt) parts.push('⚠NO-ALT');
    return parts.length ? `  [${parts.join(' ')}]` : '';
}

/**
 * Render an ASCII structural layout diagram of a slide (78 chars wide).
 * Row-containers are rendered as side-by-side columns using box-drawing chars.
 * Flex percentages are used to proportion column widths when present.
 */
function _asciiSlide(slide) {
    const TOTAL_W = 78;
    const lines = [];

    function renderBlock(b, indent, availW) {
        const pfx = ' '.repeat(indent);
        const idTag = b.id ? ` #${b.id.slice(0, 8)}` : '';
        const header = _blockLabel(b) + _blockAnno(b) + idTag;
        lines.push((pfx + header).slice(0, availW));

        const kids = b.type !== 'list' ? (b.children || b.elements || []) : [];
        if (!kids.length) return;

        const isRow = b.type === 'container' &&
            (b.layout === 'row' || (b.style?.display === 'flex' && b.style?.flexDirection !== 'column'));

        if (isRow) {
            // Determine proportional column widths from flex percentages
            const flexVals = kids.map(k => {
                const src = k.style?.flex || k.style?.width || '';
                const m = src.match(/(\d+(?:\.\d+)?)%/);
                return m ? parseFloat(m[1]) : null;
            });
            const allFlex = flexVals.every(v => v !== null);
            const totalFlex = allFlex ? flexVals.reduce((a, v) => a + v, 0) : kids.length;
            const innerW = Math.max(kids.length * 4, availW - indent - 2);
            const rawWidths = flexVals.map((v, i) =>
                Math.max(4, v !== null
                    ? Math.round(v / totalFlex * innerW)
                    : Math.round(innerW / kids.length))
            );
            // Fix rounding so columns sum to innerW; clamp to min 1 to prevent repeat() crash
            const diff = innerW - rawWidths.reduce((a, v) => a + v, 0);
            rawWidths[rawWidths.length - 1] = Math.max(1, rawWidths[rawWidths.length - 1] + diff);
            // Clamp all widths to at least 1
            for (let i = 0; i < rawWidths.length; i++) rawWidths[i] = Math.max(1, rawWidths[i]);

            // Collect content lines for each column (max depth 3 levels)
            const colContents = kids.map((k, ci) => {
                const cw = rawWidths[ci];
                const tmp = [];
                function sub(b2, d) {
                    if (d > 3) return;
                    tmp.push((_blockLabel(b2) + _blockAnno(b2)).slice(0, cw - 2));
                    const kids2 = b2.type !== 'list' ? (b2.children || b2.elements || []) : [];
                    kids2.forEach(k2 => sub(k2, d + 1));
                }
                sub(k, 0);
                return tmp;
            });

            const maxRows = Math.max(1, ...colContents.map(c => c.length));
            const colWstr = rawWidths.map(w => '─'.repeat(w));
            lines.push(pfx + '┌' + colWstr.join('┬') + '┐');
            for (let r = 0; r < maxRows; r++) {
                let row = pfx + '│';
                colContents.forEach((cc, ci) => {
                    const cw = rawWidths[ci];
                    const txt = cc[r] || '';
                    row += txt + ' '.repeat(Math.max(0, cw - txt.length)) + '│';
                });
                lines.push(row);
            }
            lines.push(pfx + '└' + colWstr.join('┴') + '┘');
        } else {
            kids.forEach(k => renderBlock(k, indent + 2, availW));
        }
    }

    const topBlocks = slide.children || slide.elements || [];
    topBlocks.forEach((b, i) => {
        if (i > 0) lines.push('─'.repeat(TOTAL_W));
        renderBlock(b, 0, TOTAL_W);
    });
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
    async invoke(_options, _token) {
        const p = _getSlideProvider();
        const openUris = p ? p.listOpenEditors() : [];
        const activeEntry = p ? p.getActiveEntry() : null;
        const activeUri = activeEntry?.document?.uri?.toString() ?? null;

        const lines = [];

        if (openUris.length) {
            lines.push('Open .wslide editors:');
            for (const u of openUris) {
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
                lines.push(`Currently visible slide: ${idx + 1} of ${activeDeck.slides.length} — "${slide.label || '(unlabeled)'}"`);
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
                lines.push(`  editorCSS (${t.editorCSS.length} chars):`);
                lines.push(t.editorCSS);
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

        // ── Best practices ───────────────────────────────────────────────
        lines.push('');
        lines.push('=== Best Practices ===');
        lines.push('• Start with wolfslide_setTheme to set a color preset before building slides.');
        lines.push('• For new decks with many slides, use wolfslide_bulkInsert to insert all slides in one call.');
        lines.push('• Use containers with layout:"row" for side-by-side columns, layout:"column" for vertical stacking.');
        lines.push('• Add flex:"1" to child containers for equal-width columns, or flex:"60%" / flex:"40%" for proportional.');
        lines.push('• Set slide.background for per-slide backgrounds; the theme provides defaults.');
        lines.push('• Use fragmentOrder for narrative builds: 1,2,3… reveals items in order on click/advance.');
        lines.push('• Images support: w, h (pixels), fit ("contain"/"cover"), alt (accessibility text).');
        lines.push('• Font size: block.fontSize (number in px). Headings default to ~48px; body to ~28px.');
        lines.push('• Block positioning: default is flow layout. Set position:"absolute", x, y for pixel-precise placement.');
        lines.push('Inspection workflow: (1) wolfslide_listSlides — overview of all slides with block counts, steps, char counts; pass verbose:true to also get the ASCII block tree for every slide. (2) wolfslide_getSlide — full block tree + raw JSON for one slide; defaults to the currently visible slide when no index given. (3) wolfslide_searchSlides — find blocks by text query, block type, or style property across the whole deck. (4) wolfslide_getSlideHtml — render a single slide to standalone HTML instantly (avoids exporting the full 4MB deck just to check layout).');
        lines.push('• NEVER write JSON directly to .wslide files — always use wolfslide tools to keep the editor in sync.');
        lines.push('• Use eval blocks for computed content: plots, formulas, diagrams — they render as crisp SVG or LaTeX instead of static images.');
        lines.push('• Prefer eval blocks over external image files when the content can be generated by Wolfram Language (e.g., Plot, Graphics, NumberLinePlot).');
        lines.push('• Image layout contract: the image block\'s w and h properties define the wrapper div size. style.maxHeight / style.maxWidth only constrain the wrapper — without explicit w and h, the image still fills the column. Always set w, h, AND style.maxHeight/maxWidth together, OR just use w and h alone. Use wolfslide_getImageDimensions to get pixel dimensions from a local path or URL before inserting.');
        lines.push('• fragmentOrder on containers: setting fragmentOrder on a container block animates the entire container as one unit (all children appear/disappear together). Use this for revealing whole column sections at once.');
        lines.push('• External image URLs (arXiv, web): links work in the editor preview but may be blocked offline or slow to load in exported HTML. Copy images locally with wolfslide_imageAsset({action:"copy",...}) for reliable exports.');

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
            lines.push('── INLINE STYLES ARE MANDATORY ────────────────────────────────');
            lines.push('CSS classes like .prob, .sol, .stepbox only work if they are defined in editorCSS.');
            lines.push('For robust decks: use inline style objects on every block, e.g.:');
            lines.push('  { "type":"text", "content":"...", "style":{"color":"#22d3ee","fontWeight":"bold"} }');
            lines.push('Inline styles never depend on editorCSS and always render correctly.');
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
            lines.push('Then use wolfslide_editSlide(action:"editBlock") or wolfslide_block(action:"edit") with the block id.');
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
        const verbose = !!options.input?.verbose;
        const lines = (deck.slides || []).map((s, i) => {
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
            const summary = `[${i + 1}] id=${s.id}  label="${label}"  bg="${bg}"${hidden}${stepsInfo}${charsInfo}${warnInfo}\n    blocks: ${blockDesc}${imgInfo}`;
            if (verbose) {
                const ascii = _asciiSlide(s);
                return summary + '\n```\n' + ascii + '\n```';
            }
            return summary;
        });
        return _slideResult(`${lines.length} slide(s):\n` + lines.join('\n'));
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
        const slide = deck.slides?.[idx];
        if (!slide) return _slideResult(`Slide ${idx + 1} not found (deck has ${deck.slides?.length ?? 0}).`);

        // ASCII structural layout — helps AI "see" the slide composition
        const label  = slide.label || slide.meta?.title || '';
        const hidden = slide.hidden ? '  ⚠ HIDDEN (skipped in presentation)' : '';
        const transition = slide.transition ? `  transition: ${slide.transition}` : '';
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

        const output =
            asciiHeader +
            '```\n' + ascii + '\n```' +
            imgSummary +
            notesSummary +
            renderWarnStr +
            '\n\n## Raw JSON\n```json\n' + JSON.stringify(slide, null, 2) + '\n```';
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
        const afterIndex = options.input?.afterIndex;
        const insertAt = (afterIndex != null) ? Math.min(afterIndex, deck.slides.length) : deck.slides.length;
        deck.slides.splice(insertAt, 0, newSlide);
        await p.applyDeck(deck, docUri);
        return _slideResult(`Inserted slide at position ${insertAt + 1} (id=${newSlide.id}).`);
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

        // Merge semantics: for children arrays, id-only stubs mean "keep existing block unchanged"
        function _mergeBlocks(existing, incoming) {
            if (!Array.isArray(incoming)) return incoming;
            const existingById = (existing || []).reduce((m, b) => { if (b?.id) m[b.id] = b; return m; }, {});
            return incoming.map(b => {
                if (b && b.id && Object.keys(b).length === 1 && existingById[b.id]) {
                    return existingById[b.id]; // id-only stub — preserve existing
                }
                return b;
            });
        }
        const mergedPatch = Object.assign({}, patch);
        for (const key of ['children', 'items', 'elements']) {
            if (Array.isArray(patch[key])) {
                mergedPatch[key] = _mergeBlocks(r.slide[key], patch[key]);
            }
        }

        Object.assign(r.slide, mergedPatch);
        _ensureBlockIds(r.slide.children);
        _ensureBlockIds(r.slide.items);
        _ensureBlockIds(r.slide.elements);
        await r.p.applyDeck(r.deck, r.docUri);
        const warningStr = warnings.length ? `\nWarnings:\n${warnings.map(w => `  ⚠ ${w}`).join('\n')}` : '';
        return _slideResult(`Slide ${r.idx + 1} (id=${r.slide.id}) updated.${warningStr}`);
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
        return _slideResult(`Deleted slide ${r.idx + 1} (id=${removed.id}).`);
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
        return _slideResult(`Moved slide "${slide.id}" from position ${r.idx + 1} to ${to + 1}.`);
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
        entry.webviewPanel.webview.postMessage({ cmd: 'undo' });
        return _slideResult('Undo triggered.');
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
            if (matches.length) {
                results.push(`[${i + 1}] id=${s.id} label="${s.label || ''}":\n${matches.join('\n')}`);
            }
        });
        const desc = [query && `text:"${query}"`, blockTypeFilter && `type:${blockTypeFilter}`, styleKey && `style.${styleKey}${styleValue ? '='+styleValue : ''}`].filter(Boolean).join(', ');
        if (!results.length) return _slideResult(`No matches for [${desc}] across ${deck.slides.length} slide(s).`);
        return _slideResult(`Matches for [${desc}] in ${results.length} slide(s):\n${results.join('\n')}`);
    }
}

// ── Block-level editing tools ─────────────────────────────────────────────

class WolfslideEditBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Editing block ${options.input?.blockId ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const blockId = options.input?.blockId;
        if (!blockId) return _slideResult('blockId is required.');
        const found = _findBlockRecursive(blockId, r.slide);
        if (!found) {
            const allIds = _collectAllBlocks(r.slide).map(b => b.id);
            return _slideResult(`Block "${blockId}" not found on slide ${r.idx + 1}. Valid ids: ${allIds.join(', ')}`);
        }
        const updates = options.input?.updates || options.input?.patch;
        if (!updates || typeof updates !== 'object') return _slideResult('updates (or patch) object is required.');
        _deepMerge(found.block, updates);
        _ensureBlockIds(found.block.children);
        _ensureBlockIds(found.block.items);
        _ensureBlockIds(found.block.elements);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Block ${blockId} updated on slide ${r.idx + 1}. Keys changed: ${Object.keys(updates).join(', ')}`);
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
        return _slideResult(`Inserted block id=${block.id} type=${block.type || '?'} at position ${pos} on slide ${r.idx + 1}.`);
    }
}

class WolfslideDeleteBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Deleting block ${options.input?.blockId ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const blockId = options.input?.blockId;
        if (!blockId) return _slideResult('blockId is required.');
        const found = _findBlockRecursive(blockId, r.slide);
        if (!found) {
            const allIds = _collectAllBlocks(r.slide).map(b => b.id);
            return _slideResult(`Block "${blockId}" not found on slide ${r.idx + 1}. Valid ids: ${allIds.join(', ')}`);
        }
        found.parent[found.key].splice(found.index, 1);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Deleted block ${blockId} (type=${found.block.type}) from slide ${r.idx + 1}.`);
    }
}

class WolfslideMoveBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Moving block ${options.input?.blockId ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const blockId = options.input?.blockId;
        if (!blockId) return _slideResult('blockId is required.');
        const found = _findBlockRecursive(blockId, r.slide);
        if (!found) {
            const allIds = _collectAllBlocks(r.slide).map(b => b.id);
            return _slideResult(`Block "${blockId}" not found on slide ${r.idx + 1}. Valid ids: ${allIds.join(', ')}`);
        }
        // Remove from old location
        const [block] = found.parent[found.key].splice(found.index, 1);
        // Insert at new location
        const newParentId = options.input?.newParentId || null;
        const newPosition = options.input?.newPosition;
        let arr;
        if (newParentId) {
            const dest = _findBlockRecursive(newParentId, r.slide);
            if (!dest) return _slideResult(`Destination parent "${newParentId}" not found.`);
            if (!dest.block.children) dest.block.children = [];
            arr = dest.block.children;
        } else {
            if (!r.slide.children) r.slide.children = [];
            arr = r.slide.children;
        }
        const pos = (newPosition != null && newPosition >= 0) ? Math.min(newPosition, arr.length) : arr.length;
        arr.splice(pos, 0, block);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Moved block ${blockId} to ${newParentId ? 'parent ' + newParentId : 'top-level'} position ${pos} on slide ${r.idx + 1}.`);
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
        return { invocationMessage: `Rendering slide ${n} to HTML` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        try {
            const exporter = require('../slideExporter');
            const section  = exporter.slideToHTML(r.slide);
            const t = r.deck.theme || {};
            const navy   = t.navy   || '#0a244a';
            const blue   = t.blue   || '#0064b4';
            const cyan   = t.cyan   || '#009ac8';
            const accent = t.accent || '#be1e2d';
            const userCSS = t.editorCSS ? `<style>\n${t.editorCSS}\n</style>` : '';
            const html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
                `<title>Slide ${r.idx + 1} — ${(r.slide.label || '').replace(/</g,'&lt;')}</title>\n` +
                `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css">\n` +
                `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/theme/white.css">\n` +
                `<style>\n:root{--navy:${navy};--blue:${blue};--cyan:${cyan};--accent:${accent};}\n` +
                `html,body{margin:0;padding:0;background:#000;}\n` +
                `.reveal,.reveal *:not(.katex):not(.katex *){font-family:'Helvetica Neue',Helvetica,Arial,sans-serif!important;box-sizing:border-box;}\n` +
                `.reveal{font-size:36px;color:var(--navy);background:#000!important;}\n` +
                `.reveal-viewport{background:#000!important;}\n` +
                `.reveal .slides section{padding:0!important;margin:0!important;top:0!important;text-align:left;overflow:hidden;width:1920px;height:1080px;}\n` +
                `.reveal .slides section h1,.reveal .slides section h2,.reveal .slides section h3{text-transform:none!important;font-weight:700;margin:0;padding:0;}\n` +
                `.reveal .slides section h2{background:var(--navy);color:#fff;padding:14px 36px;font-size:1.1em;width:100%;}\n` +
                `.reveal .slides section img{border:none!important;box-shadow:none!important;}\n` +
                `.wslide-canvas{position:relative;width:1920px;height:1080px;}\n.wel{position:absolute;box-sizing:border-box;}\n</style>\n` +
                `${userCSS}\n</head>\n<body>\n` +
                `<div class="reveal"><div class="slides">\n${section}\n</div></div>\n` +
                `<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>\n` +
                `<script>Reveal.initialize({hash:false,width:1920,height:1080,margin:0.04,minScale:0.1,maxScale:2,transition:'none',center:false,controls:false,progress:false});</script>\n` +
                `</body>\n</html>`;

            const outputPath = options.input?.outputPath;
            if (outputPath) {
                require('fs').writeFileSync(outputPath, html, 'utf8');
                return _slideResult(`Slide ${r.idx + 1} HTML written to ${outputPath} (${html.length} bytes).`);
            }
            return _slideResult(
                `Slide ${r.idx + 1} "${r.slide.label || ''}" HTML (${html.length} bytes):\n\n` +
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
            const html = exporter.exportDeck(deck);
            const destPath = options.input?.outputPath;
            if (destPath) {
                require('fs').writeFileSync(destPath, html, 'utf8');
                return _slideResult(`Exported ${html.length} bytes to ${destPath}.`);
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
            return _slideResult(`Exported to ${saveUri.fsPath}.`);
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

        // Warn about unknown parameters (e.g. "overrides" — a common mistake; the correct key is "theme")
        const knownKeys = new Set(['preset', 'theme', 'docUri', 'applyBackground', 'defaultBackground']);
        const unknownKeys = Object.keys(options.input || {}).filter(k => !knownKeys.has(k));
        if (unknownKeys.length > 0) {
            return _slideResult(
                `⚠ wolfslide_setTheme: unknown parameter(s) "${unknownKeys.join('", "')}" — IGNORED.\n` +
                `Valid parameters: preset (string), theme (object with navy/blue/cyan/accent/editorCSS), defaultBackground, applyBackground, docUri.\n` +
                `Common mistake: "overrides" is not valid — use "theme": { navy:"#...", editorCSS:"..." } instead.`
            );
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
            // Avoid collisions
            if (fs.existsSync(path.join(imgDir, fname))) {
                const ext  = path.extname(fname);
                const base = path.basename(fname, ext);
                fname = base + '_' + Date.now() + ext;
            }
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
                `✅ Copied: ${path.basename(srcPath)} → img/${deckName}.wslide/${fname}`,
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
            return _slideResult('"slides" array is required and must be non-empty.');
        }

        // Assign IDs recursively
        function ensureIds(b) {
            if (!b) return;
            if (!b.id) b.id = _uid();
            (b.children || b.items || b.elements || []).forEach(ensureIds);
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
        return _slideResult(`Bulk-inserted ${slides.length} slides at position ${insertAt + 1}–${insertAt + slides.length}. Deck now has ${deck.slides.length} slides.`);
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
        try {
            const controller = this._getController?.();
            if (!controller?.session || controller._evalDispatched) return null;
            const timeout = 30;
            const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const expr = _buildEvalExpr(escaped, timeout, imgW);
            const raceTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (timeout + 10) * 1000));
            const evalResult = await Promise.race([
                controller.session.evaluate(expr, { interactive: false }),
                raceTimeout
            ]);
            const resultStr = (evalResult?.result?.type === 'string' && evalResult.result.value) ? evalResult.result.value : String(evalResult?.result ?? '');
            return _parseEvalResult(resultStr, imgW);
        } catch (err) {
            return { type: 'error', error: err.message || String(err) };
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
        if (controller._evalDispatched) return _slideResult('Kernel is busy. Try again shortly.');

        try {
            const imgW = found.block.w || 800;
            const timeout = 30;
            const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const expr = _buildEvalExpr(escaped, timeout, imgW);
            const raceTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (timeout + 10) * 1000));
            const evalResult = await Promise.race([
                controller.session.evaluate(expr, { interactive: false }),
                raceTimeout
            ]);
            const resultStr = (evalResult?.result?.type === 'string' && evalResult.result.value) ? evalResult.result.value : String(evalResult?.result ?? '');
            found.block.output = _parseEvalResult(resultStr, imgW);
            await r.p.applyDeck(r.deck, r.docUri);
            return _slideResult(`Evaluated eval block ${blockId}. Result: ${found.block.output.type}${found.block.output.error ? ' — ' + found.block.output.error : ''}`);
        } catch (err) {
            return _slideResult(`Evaluation failed: ${err.message || err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_getCellOutput — read current output of a single cell by num or ID
// ---------------------------------------------------------------------------

class GetCellOutputTool {
    async prepareInvocation(options, _token) {
        const n = options.input?.cellId || options.input?.cellNumber;
        return { invocationMessage: `Read output of cell ${n}` };
    }

    async invoke(options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook = editor.notebook;
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
        const decoder    = new util.TextDecoder();
        const outs       = [];
        const msgOuts    = [];

        for (const output of cell.outputs) {
            const mimes     = output.items.map(it => it.mime);
            const plainItem = output.items.find(it => it.mime === 'text/plain');
            const isErrSentinel = mimes.includes('x-application/wolfram-language-html') &&
                                  mimes.includes('application/vnd.code.notebook.error');
            if (!plainItem) continue;
            try {
                const txt = decoder.decode(plainItem.data).trim();
                if (!txt) continue;
                if (isErrSentinel) msgOuts.push(txt);
                else outs.push(txt);
            } catch (_) {}
        }

        if (outs.length === 0 && msgOuts.length === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Cell ${cellNumber} (CellId: ${cellId}): no output (not evaluated yet or suppressed result).`
            )]);
        }

        const parts = [`Cell ${cellNumber} (CellId: ${cellId}) output:`];
        if (outs.length > 0) parts.push(outs.join('\n'));
        if (msgOuts.length > 0) parts.push(`\n\u26A0 Kernel messages:\n${msgOuts.join('\n')}`);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(parts.join('\n'))]);
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
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook    = editor.notebook;
        const controller  = this._getController?.();
        const hasKernel   = controller?.session && controller.kernelStatusString === 'resolved' && !controller._evalDispatched;

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

        const errors  = [];
        let checked   = 0;

        for (let n = from; n <= to; n++) {
            const cell = notebook.cellAt(n - 1);
            if (cell.kind === vscode.NotebookCellKind.Markup) continue;
            const src = cell.document.getText().trim();
            if (!src) continue;
            checked++;
            const cellId = getCellToolId(cell);

            if (hasKernel) {
                // SyntaxQ returns True/False; if False, SyntaxLength gives last valid position
                const esc  = escWl(src);
                const expr = `Block[{$wbSrc$="${esc}"}, If[SyntaxQ[$wbSrc$], "OK", "SYNTAX_ERROR at char " <> ToString[SyntaxLength[$wbSrc$] + 1]]]`;
                try {
                    const result = await Promise.race([
                        controller.session.evaluate(expr, { interactive: false }),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
                    ]);
                    const val = result?.result?.value || '';
                    if (val && val !== 'OK') {
                        errors.push(`Cell ${n} (CellId: ${cellId}): ${val}`);
                    }
                } catch (_) {
                    // Kernel unavailable mid-loop — fall through to text check
                }
            } else {
                // Offline heuristic checks (no kernel)
                // Check for common issues: unmatched brackets, string escapes
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
                    errors.push(`Cell ${n} (CellId: ${cellId}): unmatched brackets/string${depth > 0 ? ` (depth=${depth})` : ''}`);
                }
            }
        }

        if (checked === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No code cells found in range.')]);
        }
        if (errors.length === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `\u2713 Syntax valid for all ${checked} code cell(s) checked (cells ${from}\u2013${to}).` +
                (hasKernel ? '' : '\n[Note: kernel not available — ran offline bracket-matching checks only]')
            )]);
        }
        const note = hasKernel ? '' : '\n[Note: kernel not available — ran offline bracket-matching checks only]';
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            `${errors.length} syntax issue(s) found in ${checked} code cell(s):\n${errors.join('\n')}${note}`
        )]);
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
        content = normalizeToolContent(content);
        // Resolve relative paths against the active notebook directory
        let absPath = filePath;
        if (!path.isAbsolute(filePath)) {
            const editor = await resolveNotebookEditor();
            const base   = editor ? path.dirname(editor.notebook.uri.fsPath) : process.cwd();
            absPath = path.join(base, filePath);
        }
        try {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, content, 'utf8');
            const lines = content.split('\n').length;
            const bytes = Buffer.byteLength(content, 'utf8');
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Saved: ${absPath}\n${lines} lines, ${bytes} bytes`
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
            const editor = await resolveNotebookEditor();
            const base   = editor ? path.dirname(editor.notebook.uri.fsPath) : process.cwd();
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
            const editor = await resolveNotebookEditor();
            const base   = editor ? path.dirname(editor.notebook.uri.fsPath) : process.cwd();
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
            return _slideResult('Error: action is required. Use "insert", "edit", "delete", "move", or "bulkEdit".');
        }
        switch (action) {
            case 'insert':   return this._insert.invoke(options, _token);
            case 'edit':     return this._edit.invoke(options, _token);
            case 'delete':   return this._delete.invoke(options, _token);
            case 'move':     return this._move.invoke(options, _token);
            case 'bulkEdit': return this._bulkEdit(options, _token);
            default:
                return _slideResult(`Unknown action "${action}". Use "insert", "edit", "delete", "move", or "bulkEdit".`);
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


module.exports = {
    WolfslideGetContextTool,
    WolfslideListSlidesTool,
    WolfslideGetSlideTool,
    WolfslideInsertSlideTool,
    WolfslideEditSlideTool,
    WolfslideDeleteSlideTool,
    WolfslideMoveSlideTool,
    WolfslideUndoTool,
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
    WolfslideInsertEvalBlockTool,
    WolfslideRunEvalBlockTool,
    WolfslideBlockTool,
    WolfslideAdvancedTool,
    // Non-wolfslide tools that ended up in this file
    GetCellOutputTool,
    ValidateSyntaxTool,
    SaveLatexTool,
    CompileLatexTool,
    GetLatexErrorsTool,
    LatexTool,
};
