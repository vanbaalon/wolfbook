'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// slideExporter.js  —  Generates standalone Reveal.js HTML and print-PDF HTML
// from a .wslide deck object.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs   = require('fs');

// ── KaTeX setup ──────────────────────────────────────────────────────────────
// Try to use the locally bundled katex for server-side pre-rendering so that
// the exported HTML works offline without any browser-side katex JS.
let _katex = null;
let _katexEmbeddedCSS = null;     // katex.min.css with CDN font URLs (for HTML export)
let _katexLocalFontCSS = null;    // katex.min.css with file:// font URLs (for PDF export)
let _katexFontsDir = null;        // absolute path to bundled katex fonts/

// Directory of the .wslide file being exported (set by exportDeckPdf).
// Used to rewrite relative image paths to absolute file:// URLs for Chrome.
let _pdfDeckDir = null;

try {
    _katex = require('katex');

    const cssPath  = path.join(__dirname, '..', '..', 'node_modules', 'katex', 'dist', 'katex.min.css');
    const fontsDir = path.join(__dirname, '..', '..', 'node_modules', 'katex', 'dist', 'fonts');
    if (fs.existsSync(cssPath)) {
        const rawCSS = fs.readFileSync(cssPath, 'utf8');
        // For HTML export: embed fonts as base64 data URIs — self-contained, works offline
        // and guarantees KaTeX renders with its own fonts (not as browser MathML fallback).
        if (fs.existsSync(fontsDir)) {
            _katexEmbeddedCSS = rawCSS.replace(/url\(fonts\/([\w.\-]+)\)/g, (match, fontFile) => {
                const fontPath = path.join(fontsDir, fontFile);
                if (!fs.existsSync(fontPath)) return match;
                const ext = path.extname(fontFile).slice(1).toLowerCase();
                const mime = ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : 'font/truetype';
                const b64 = fs.readFileSync(fontPath).toString('base64');
                return `url(data:${mime};base64,${b64})`;
            });
        } else {
            // Fallback: CDN font URLs
            _katexEmbeddedCSS = rawCSS
                .replace(/url\(fonts\//g, 'url(https://cdn.jsdelivr.net/npm/katex@0.16/dist/fonts/');
        }
        // For PDF export: rewrite relative font paths to absolute file:// so Chrome headless
        // loads fonts locally (guaranteed, no network needed)
        if (fs.existsSync(fontsDir)) {
            const fontsUrl = 'file://' + fontsDir.replace(/\\/g, '/') + '/';
            _katexLocalFontCSS = rawCSS
                .replace(/url\(fonts\//g, `url(${fontsUrl}`);
            _katexFontsDir = fontsDir;
        } else {
            _katexLocalFontCSS = _katexEmbeddedCSS;
        }
    }
} catch(_) { /* will fall back to CDN tags */ }

/**
 * Pre-render $...$ and $$...$$ inside an HTML string using katex.renderToString.
 * Skips text inside HTML tags (< ... >).  Safe to call on already-HTML content.
 */
function renderMathInContent(html) {
    if (!_katex || !html || typeof html !== 'string') return html || '';
    // We split by HTML tags so we only touch text nodes.
    const parts = html.split(/(<[^>]*>)/);
    return parts.map((part, i) => {
        if (i % 2 === 1) return part; // HTML tag — leave untouched

        // Display math: $$...$$ (non-greedy, no nested $$)
        part = part.replace(/\$\$([^$]+?)\$\$/g, (match, src) => {
            try { return _katex.renderToString(htmlDecode(src.trim()), { displayMode: true,  output: 'html', throwOnError: false }); }
            catch(_) { return match; }
        });
        // Inline math: $...$ (not $$) — allow newlines inside the math
        part = part.replace(/(?<!\$)\$([^$]+?)\$(?!\$)/g, (match, src) => {
            try { return _katex.renderToString(htmlDecode(src.trim()), { displayMode: false, output: 'html', throwOnError: false }); }
            catch(_) { return match; }
        });
        return part;
    }).join('');
}

/**
 * Return the HTML snippet that provides KaTeX in an exported file.
 * If we have local katex and pre-render everything, only the CSS is needed
 * (no JS). Otherwise fall back to CDN with corrected delimiters.
 * @param {boolean} forPdf  If true, use file:// font paths (for Chrome headless).
 */
function katexHeadAssets(forPdf) {
    const css = forPdf ? _katexLocalFontCSS : _katexEmbeddedCSS;
    if (css) {
        return `<style>\n${css}\n</style>`;
    }
    // CDN fallback — Note: $$ delimiters are 2 dollar signs, not 4.
    return [
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css">',
        '<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js"></script>',
        `<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/contrib/auto-render.min.js"`,
        ` onload="renderMathInElement(document.body,{throwOnError:false,output:'html',delimiters:`,
        `[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]})">`,
        `</script>`,
    ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML (Reveal.js) export
// ─────────────────────────────────────────────────────────────────────────────

function exportDeck(deck) {
    const title      = deck.meta?.title || 'Presentation';
    const sections   = (deck.slides || []).filter(s => !s.hidden).map(slideToHTML).join('\n');
    const navy   = deck.theme?.navy   || '#0a244a';
    const blue   = deck.theme?.blue   || '#0064b4';
    const cyan   = deck.theme?.cyan   || '#009ac8';
    const accent = deck.theme?.accent || '#be1e2d';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/theme/white.css">
${katexHeadAssets()}
<style>
:root{--navy:${navy};--blue:${blue};--cyan:${cyan};--accent:${accent};--slidebg:#fafcff;}
html,body{margin:0;padding:0;background:#000;}
.reveal,.reveal *:not(.katex):not(.katex *){font-family:'Helvetica Neue',Helvetica,Arial,sans-serif!important;box-sizing:border-box;}
.reveal{font-size:36px;color:var(--navy);background:#000!important;}
.reveal-viewport{background:#000!important;}
.reveal .slide-background{display:none!important;}
.reveal .slides section{padding:0!important;margin:0!important;top:0!important;text-align:left;overflow:hidden;width:1920px;height:1080px;}
.reveal .slides section .slide-inner{width:1920px;height:1080px;overflow:hidden;}
.eval-block svg{max-width:100%;height:auto;display:block;}
.reveal .slides section h1,.reveal .slides section h2,.reveal .slides section h3,
.reveal .slides section h4,.reveal .slides section h5,.reveal .slides section h6{
  text-transform:none!important;letter-spacing:normal!important;font-weight:700;margin:0;padding:0;}
.reveal .slides section h2{background:var(--navy);color:#fff;padding:14px 36px;font-size:1.1em;width:100%;}
.reveal .slides section img{border:none!important;box-shadow:none!important;background:none!important;margin:0!important;}
.reveal .slides section ul,.reveal .slides section ol{margin:0;padding-left:1.4em;text-align:left;}
.reveal .slides section p{margin:0;}
.reveal .slides section *{line-height:inherit;}
.wslide-canvas{position:relative;width:1920px;height:1080px;}
.wel{position:absolute;box-sizing:border-box;}
</style>
</head>
<body>
<div class="reveal"><div class="slides">
${sections}
</div></div>
<button id="fs-btn" style="position:fixed;top:12px;right:12px;z-index:9999;padding:8px 18px;font-size:14px;font-weight:600;background:rgba(0,0,0,.7);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;cursor:pointer;font-family:sans-serif;backdrop-filter:blur(4px);" onclick="document.documentElement.requestFullscreen?document.documentElement.requestFullscreen():document.documentElement.webkitRequestFullscreen&&document.documentElement.webkitRequestFullscreen();this.style.display='none'">▶ Present</button>
<script>document.addEventListener('fullscreenchange',function(){if(!document.fullscreenElement)document.getElementById('fs-btn').style.display='block';});</script>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>
<script>Reveal.initialize({hash:true,slideNumber:'c/t',width:1920,height:1080,margin:0.04,minScale:0.1,maxScale:2,transition:'none',center:false,controls:true,progress:true});</script>
</body>
</html>`;
}

// ── Slide → <section> ─────────────────────────────────────────────────────

function slideToHTML(slide) {
    // Apply background as inline style on the inner wrapper (not data-background)
    // so it doesn't bleed beyond the 1920x1080 slide area.
    const bgStyle = slide.background ? `background:${slide.background};` : '';

    // v2 format: block tree (children[])
    if (slide.children) {
        const sectionClass = slide.background === '#0a244a'
            ? (slide.label === 'Title' ? ' class="title-slide"' : ' class="part-slide"')
            : slide.background === '#fffce6' ? ' class="breaking"' : '';
        const inner   = (slide.children || []).map(blockToHTML).join('\n');
        const layout  = slide.layout || 'column';
        const padding = slide.padding ? `padding:${slide.padding};` : '';
        const gap     = slide.gap != null ? `gap:${slide.gap}px;` : '';
        const flexDir = layout === 'row' ? 'row' : layout === 'free' ? '' : 'column';
        const layoutCSS = layout === 'free'
            ? `position:relative;width:1920px;height:1080px;${bgStyle}${padding}`
            : `display:flex;flex-direction:${flexDir};${gap}${padding}width:1920px;height:1080px;${bgStyle}`;
        const notesHtml = slide.notes ? `\n<aside class="notes">${escapeAttr(slide.notes)}</aside>` : '';
        const resolvedTransition = slide.transition === 'random' ? ['fade','slide','convex','concave','zoom'][Math.floor(Math.random() * 5)] : slide.transition;
        const transition = resolvedTransition ? ` data-transition="${escapeAttr(resolvedTransition)}"` : '';
        return `<section${sectionClass}${transition}>\n<div class="slide-inner" style="${layoutCSS}">\n${inner}\n</div>${notesHtml}\n</section>`;
    }

    // v1 format: elements[]
    const elements = slide.elements || [];
    if (elements.length === 1 && elements[0].type === 'raw' &&
        elements[0].x === 0 && elements[0].y === 0 &&
        elements[0].w === 1920 && elements[0].h === 1080) {
        const sectionClass = slide.background === '#0a244a'
            ? ' class="title-slide"' : slide.background === '#fffce6' ? ' class="breaking"' : '';
        return `<section${sectionClass}>\n<div class="slide-inner" style="width:1920px;height:1080px;overflow:hidden;${bgStyle}">${elements[0].html || ''}</div>\n</section>`;
    }
    const elems = elements.map(elToHTML).join('\n  ');
    return `<section>\n  <div class="wslide-canvas" style="${bgStyle}">\n  ${elems}\n  </div>\n</section>`;
}

// ── v2 block → HTML ───────────────────────────────────────────────────────

function blockToHTML(block) {
    if (!block) return '';
    const fo        = (block.fragmentOrder != null && block.fragmentOrder >= 1) ? block.fragmentOrder : null;
    const fragClass = fo !== null ? ' fragment' : '';
    const fragAttr  = fo !== null ? ` data-fragment-index="${fo - 1}"` : '';

    let posStyle = '';
    if (block.position === 'absolute') {
        posStyle += 'position:absolute;';
        if (block.x != null) posStyle += `left:${block.x}px;`;
        if (block.y != null) posStyle += `top:${block.y}px;`;
    }
    if (block.w    != null) posStyle += `width:${block.w}px;`;
    if (block.h    != null) posStyle += `height:${block.h}px;`;
    if (block.flex)         posStyle += `flex:${block.flex};`;
    if (block.offset && (block.offset.dx || block.offset.dy)) {
        posStyle += `transform:translate(${block.offset.dx||0}px,${block.offset.dy||0}px);`;
    }

    let inlineCSS = '';
    if (block.style && typeof block.style === 'object') {
        for (const [k, v] of Object.entries(block.style)) {
            inlineCSS += `${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}:${v};`;
        }
    }

    const cls       = block.className ? ` ${block.className}` : '';
    const style     = posStyle + inlineCSS;
    const styleAttr = style ? ` style="${style}"` : '';

    switch (block.type) {
        case 'container': {
            const layout = block.layout || 'column';
            let layoutCSS = '';
            if (layout === 'free') {
                layoutCSS = 'position:relative;';
            } else {
                layoutCSS = `display:flex;flex-direction:${layout === 'row' ? 'row' : 'column'};`;
                if (block.gap    != null) layoutCSS += `gap:${block.gap}px;`;
                if (block.align)          layoutCSS += `align-items:${block.align};`;
                if (block.justify)        layoutCSS += `justify-content:${block.justify};`;
            }
            if (block.padding) layoutCSS += `padding:${typeof block.padding === 'number' ? block.padding + 'px' : block.padding};`;
            const inner = (block.children || []).map(blockToHTML).join('\n');
            return `<div class="${fragClass.trim()}${cls}" style="${layoutCSS}${style}"${fragAttr}>\n${inner}\n</div>`;
        }
        case 'heading': {
            const tag = 'h' + Math.min(block.level || 2, 6);
            let s = style;
            if (block.fontSize) s += `font-size:${block.fontSize}px;`;
            if (block.color)    s += `color:${block.color};`;
            return `<${tag} class="${fragClass.trim()}${cls}" style="${s}"${fragAttr}>${renderMathInContent(block.content || '')}</${tag}>`;
        }
        case 'text': {
            const tag = block.tag || 'div';
            let s = style;
            if (block.fontSize) s += `font-size:${block.fontSize}px;`;
            if (block.color)    s += `color:${block.color};`;
            let inner = renderMathInContent(block.content || '');
            if (block.children) inner += (block.children || []).map(blockToHTML).join('\n');
            return `<${tag} class="${fragClass.trim()}${cls}" style="${s}"${fragAttr}>${inner}</${tag}>`;
        }
        case 'image': {
            const imgStyle = `width:100%;height:100%;display:block;object-fit:${block.fit || 'contain'};`;
            return `<div class="${fragClass.trim()}${cls}"${styleAttr}${fragAttr}><img src="${escapeAttr(block.src || '')}" alt="${escapeAttr(block.alt || '')}" style="${imgStyle}"></div>`;
        }
        case 'list': {
            const tag   = block.ordered ? 'ol' : 'ul';
            const items = (block.items || []).map(item => {
                const ifo = (item.fragmentOrder != null && item.fragmentOrder >= 1) ? item.fragmentOrder : null;
                const ifc = ifo !== null ? ' class="fragment"'            : '';
                const ifa = ifo !== null ? ` data-fragment-index="${ifo - 1}"` : '';
                let inner = renderMathInContent(item.content || '');
                if (item.children) inner += (item.children || []).map(blockToHTML).join('\n');
                return `<li${ifc}${ifa}>${inner}</li>`;
            }).join('\n');
            return `<${tag} class="${fragClass.trim()}${cls}"${styleAttr}${fragAttr}>\n${items}\n</${tag}>`;
        }
        case 'math': {
            let rendered;
            if (_katex) {
                try {
                    rendered = _katex.renderToString(block.mathSrc || '', { displayMode: true, output: 'html', throwOnError: false });
                } catch(_) { rendered = `$$${block.mathSrc || ''}$$`; }
            } else {
                rendered = `$$${block.mathSrc || ''}$$`;
            }
            return `<div class="${fragClass.trim()}${cls}"${styleAttr}${fragAttr}>${rendered}</div>`;
        }
        case 'box': {
            const inner = (block.children || []).map(blockToHTML).join('\n');
            return `<div class="box-blue${fragClass}${cls}" style="${style}"${fragAttr}>\n${inner}\n</div>`;
        }
        case 'raw': {
            return `<div class="${fragClass.trim()}${cls}"${styleAttr}${fragAttr}>${block.html || ''}</div>`;
        }
        case 'code': {
            const lang = block.language ? ` class="language-${escapeAttr(block.language)}"` : '';
            const escaped = (block.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            return `<div class="code-block${fragClass}${cls}" style="${style}"${fragAttr}><pre style="margin:0;"><code${lang}>${escaped}</code></pre></div>`;
        }
        case 'arrow': {
            return buildArrowSVG(block, `${fragClass.trim()}${cls}`, fragAttr);
        }
        case 'eval': {
            let inner = '';
            if (block.output) {
                if (block.output.type === 'svg' && block.output.data) {
                    inner = `<div style="padding:8px;overflow:hidden;">${block.output.data}</div>`;
                } else if (block.output.type === 'latex' && block.output.html) {
                    inner = `<div style="padding:16px 20px;color:#c9d1d9;overflow-x:auto;">${block.output.html}</div>`;
                } else if (block.output.type === 'image' && block.output.data) {
                    inner = `<img src="${escapeAttr(block.output.data)}" style="max-width:100%;max-height:100%;display:block;object-fit:contain;">`;
                } else if (block.output.type === 'text' && block.output.text) {
                    const escaped = (block.output.text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                    inner = `<pre style="margin:0;padding:16px 20px;font-family:monospace;font-size:14px;white-space:pre-wrap;color:#e0e0e0;">${escaped}</pre>`;
                }
            }
            return `<div class="eval-block${fragClass}${cls}" style="border-radius:6px;overflow:hidden;background:${block.evalBg || 'transparent'};${style}"${fragAttr}>${inner}</div>`;
        }
        default:
            return `<div class="${fragClass.trim()}${cls}"${styleAttr}${fragAttr}>${block.content || ''}</div>`;
    }
}

// ── v1 element → HTML ─────────────────────────────────────────────────────

function elToHTML(el) {
    const pos      = `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;`;
    const extra    = el.style || '';
    const fo       = (el.fragmentOrder != null && el.fragmentOrder >= 1) ? el.fragmentOrder : null;
    const fragClass = fo !== null ? ' fragment' : '';
    const fragAttr  = fo !== null ? ` data-fragment-index="${fo - 1}"` : '';
    switch (el.type) {
        case 'raw':     return `<div class="wel${fragClass}" style="${pos}${extra}"${fragAttr}>${el.html || ''}</div>`;
        case 'image':   return `<img class="wel${fragClass}" src="${escapeAttr(el.src || '')}" style="${pos}${extra}" alt="${escapeAttr(el.alt || '')}"${fragAttr}>`;
        case 'text':    return `<div class="wel${fragClass}" style="${pos}font-size:${el.fontSize || 32}px;${extra}"${fragAttr}>${el.html || ''}</div>`;
        case 'box':     return `<div class="wel ${escapeAttr(el.cls || 'box-blue')}${fragClass}" style="${pos}${extra}"${fragAttr}>${el.html || ''}</div>`;
        case 'heading': return `<h2 class="wel${fragClass}" style="${pos}${extra}"${fragAttr}>${el.html || ''}</h2>`;
        default:        return `<div class="wel${fragClass}" style="${pos}${extra}"${fragAttr}>${el.html || ''}</div>`;
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────

/**
 * Build arrow SVG with inline arrowhead geometry (no SVG marker refs).
 * SVG marker-end="url(#id)" is unreliable in Chrome headless print mode.
 * Instead we compute the arrowhead triangle manually from the bezier tangent.
 */
function buildArrowSVG(block, cls, extraAttr) {
    const color = block.color || '#be1e2d';
    const sw    = block.strokeWidth || 3;
    const x0 = block.x0 != null ? block.x0 : 300;
    const y0 = block.y0 != null ? block.y0 : 500;
    const mx = block.mx != null ? block.mx : 600;
    const my = block.my != null ? block.my : 250;
    const x1 = block.x1 != null ? block.x1 : 900;
    const y1 = block.y1 != null ? block.y1 : 500;

    // Tangent direction at t=1 of quadratic bezier: (x1-mx, y1-my)
    const dx = x1 - mx, dy = y1 - my;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len, uy = dy / len;          // unit forward
    const arrowLen  = Math.max(sw * 4.5, 14);    // triangle height
    const arrowHalf = Math.max(sw * 2.2,  7);    // half-width of base

    // Shorten the bezier endpoint so the path stops at the arrowhead base
    const ex = x1 - arrowLen * ux, ey = y1 - arrowLen * uy;

    // Arrowhead triangle: tip at (x1,y1), two base corners perpendicular
    const b1x = ex - uy * arrowHalf, b1y = ey + ux * arrowHalf;
    const b2x = ex + uy * arrowHalf, b2y = ey - ux * arrowHalf;
    const pts  = `${x1.toFixed(1)},${y1.toFixed(1)} ${b1x.toFixed(1)},${b1y.toFixed(1)} ${b2x.toFixed(1)},${b2y.toFixed(1)}`;
    const clsAttr = cls.trim() ? ` class="${cls.trim()}"` : '';

    return `<div${clsAttr} style="position:absolute;left:0;top:0;width:1920px;height:1080px;pointer-events:none;"${extraAttr}>` +
        `<svg width="1920" height="1080" style="position:absolute;left:0;top:0;overflow:visible;">` +
        `<path d="M ${x0} ${y0} Q ${mx} ${my} ${ex.toFixed(1)} ${ey.toFixed(1)}" stroke="${color}" stroke-width="${sw}" fill="none"/>` +
        `<polygon points="${pts}" fill="${color}"/>` +
        `</svg></div>`;
}

/** Decode HTML entities in a string (for math source embedded in HTML content). */
function htmlDecode(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { exportDeck, exportDeckPdf, slideToHTML };

// ─────────────────────────────────────────────────────────────────────────────
// PDF-frames export  —  print-ready HTML: one page per animation step
// Open the resulting HTML in a browser and print → PDF to get Beamer-style
// output where each click step is a separate page.
// ─────────────────────────────────────────────────────────────────────────────

function exportDeckPdf(deck, deckDir) {
    _pdfDeckDir = deckDir || null;
    const title      = deck.meta?.title || 'Presentation';
    const navy   = deck.theme?.navy   || '#0a244a';
    const blue   = deck.theme?.blue   || '#0064b4';
    const cyan   = deck.theme?.cyan   || '#009ac8';
    const accent = deck.theme?.accent || '#be1e2d';

    const pages = [];
    for (const slide of (deck.slides || [])) {
        if (slide.hidden) continue;
        const maxFrag = maxFragOrder(slide);
        // One page for the base state, one more page per fragment step
        for (let step = 0; step <= maxFrag; step++) {
            pages.push(slideToPageHTML(slide, step));
        }
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — PDF frames</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${katexHeadAssets(true)}
<style>
/* @page is always active — Chrome headless --print-to-pdf respects it.
   1920×1080 px at 96dpi = 20in × 11.25in exactly (16:9). */
@page{size:20in 11.25in;margin:0;}
:root{--navy:${navy};--blue:${blue};--cyan:${cyan};--accent:${accent};}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#888;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;}
.slide-page{
  position:relative;width:1920px;height:1080px;overflow:hidden;
  background:#fafcff;
  font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;
  font-size:36px;color:var(--navy);
  transform-origin:top left;
}
/* All img elements: constrain to their container, never overflow */
img{border:none;box-shadow:none;background:none;max-width:100%;max-height:100%;display:block;object-fit:contain;}
/* Flex items must be able to shrink below natural content size */
[style*="flex:"]{min-width:0;min-height:0;}
ul,ol{padding-left:1.4em;}
p{margin:0;}
h1,h2,h3,h4,h5,h6{margin:0;padding:0;font-weight:700;text-transform:none;letter-spacing:normal;}
h2{background:var(--navy);color:#fff;padding:14px 36px;font-size:1.1em;width:100%;}
.hidden-step{visibility:hidden;}
/* When Chrome headless renders via --print-to-pdf it uses @media print */
@media print{
  body{background:none;}
  .slide-page{
    break-after:page;
    break-inside:avoid;
    transform:none !important;
    box-shadow:none;
    margin:0 !important;
  }
  .slide-page:last-child{break-after:auto;}
}
/* Screen preview: scale pages to fit the viewport */
@media screen{
  body{padding:8px;}
  .slide-page+.slide-page{margin-top:4px;}
  .slide-page{box-shadow:0 2px 16px rgba(0,0,0,.5);}
}
</style>
<script>
// Scale slides to fit the browser window for preview
function fitSlides(){
  var w=window.innerWidth-16;
  var s=Math.min(1,w/1920);
  var all=document.querySelectorAll('.slide-page');
  all.forEach(function(el){el.style.transform='scale('+s+')';el.style.marginBottom=(1080*s-1080)+'px';});
}
window.addEventListener('load',fitSlides);
window.addEventListener('resize',fitSlides);
</script>
</head>
<body>
<!-- Print this page to PDF.  Each section becomes one page (1920×1080 pts ~ 16:9). -->
${pages.join('\n')}
</body>
</html>`;
}

/** Compute the maximum fragmentOrder in a slide's block tree */
function maxFragOrder(slide) {
    let m = 0;
    walkBlocksFlat(slide, b => { if ((b.fragmentOrder || 0) > m) m = b.fragmentOrder; });
    return m;
}

/** Flat walker — visits all blocks in a slide recursively */
function walkBlocksFlat(node, fn) {
    (node.children || []).forEach(b => { fn(b); walkBlocksFlat(b, fn); });
    (node.items    || []).forEach(b => { fn(b); walkBlocksFlat(b, fn); });
}

/**
 * Render one slide at animation step `step`.
 * Blocks with fragmentOrder <= step (or null) are fully visible;
 * blocks with fragmentOrder > step get class .hidden-step (visibility:hidden
 * so they still occupy space, matching Reveal.js behaviour where space is
 * reserved for fragments).
 */
function slideToPageHTML(slide, step) {
    const bg = slide.background ? `background:${escapeAttr(slide.background)};` : '';
    const layout  = slide.layout || 'column';
    const padding = slide.padding ? `padding:${slide.padding};` : '';
    const gap     = slide.gap != null ? `gap:${slide.gap}px;` : '';

    let contentStyle;
    if (layout === 'free') {
        contentStyle = `position:relative;width:1920px;height:1080px;${padding}`;
    } else {
        const dir = layout === 'row' ? 'row' : 'column';
        contentStyle = `display:flex;flex-direction:${dir};${gap}${padding}width:1920px;height:1080px;`;
    }

    const inner = (slide.children || []).map(b => blockToHTMLAtStep(b, step)).join('\n');
    const notes = slide.notes ? `<!-- NOTES: ${slide.notes.replace(/-->/g, '')} -->` : '';
    return `<div class="slide-page" style="${bg}">\n<div style="${contentStyle}">\n${inner}\n</div>${notes}\n</div>`;
}

/**
 * Like blockToHTML but marks blocks with fragmentOrder > step as .hidden-step.
 * Uses visibility:hidden (not display:none) so layout doesn't shift when
 * earlier steps are shown — identical to Reveal.js fragment behaviour.
 */
function blockToHTMLAtStep(block, step) {
    if (!block) return '';
    const fo = block.fragmentOrder;
    const hidden = (fo != null && fo >= 1 && fo > step);
    const hiddenClass = hidden ? ' hidden-step' : '';

    let posStyle = '';
    if (block.position === 'absolute') {
        posStyle += 'position:absolute;';
        if (block.x != null) posStyle += `left:${block.x}px;`;
        if (block.y != null) posStyle += `top:${block.y}px;`;
    }
    if (block.w    != null) posStyle += `width:${block.w}px;`;
    if (block.h    != null) posStyle += `height:${block.h}px;`;
    if (block.flex)         posStyle += `flex:${block.flex};`;
    if (block.offset && (block.offset.dx || block.offset.dy)) {
        posStyle += `transform:translate(${block.offset.dx||0}px,${block.offset.dy||0}px);`;
    }

    let inlineCSS = '';
    if (block.style && typeof block.style === 'object') {
        for (const [k, v] of Object.entries(block.style)) {
            inlineCSS += `${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}:${v};`;
        }
    }

    const cls      = (block.className ? ' ' + block.className : '') + hiddenClass;
    const style    = posStyle + inlineCSS;
    const styleAttr = style ? ` style="${style}"` : '';

    switch (block.type) {
        case 'container': {
            const layout = block.layout || 'column';
            let layoutCSS = '';
            if (layout === 'free') {
                layoutCSS = 'position:relative;';
            } else {
                layoutCSS = `display:flex;flex-direction:${layout === 'row' ? 'row' : 'column'};`;
                if (block.gap    != null) layoutCSS += `gap:${block.gap}px;`;
                if (block.align)          layoutCSS += `align-items:${block.align};`;
                if (block.justify)        layoutCSS += `justify-content:${block.justify};`;
            }
            if (block.padding) layoutCSS += `padding:${typeof block.padding === 'number' ? block.padding + 'px' : block.padding};`;
            const inner = (block.children || []).map(b => blockToHTMLAtStep(b, step)).join('\n');
            return `<div class="${cls.trim()}" style="${layoutCSS}${style}">\n${inner}\n</div>`;
        }
        case 'heading': {
            const tag = 'h' + Math.min(block.level || 2, 6);
            let s = style;
            if (block.fontSize) s += `font-size:${block.fontSize}px;`;
            if (block.color)    s += `color:${block.color};`;
            return `<${tag} class="${cls.trim()}" style="${s}">${renderMathInContent(block.content || '')}</${tag}>`;
        }
        case 'text': {
            const tag = block.tag || 'div';
            let s = style;
            if (block.fontSize) s += `font-size:${block.fontSize}px;`;
            if (block.color)    s += `color:${block.color};`;
            let inner = renderMathInContent(block.content || '');
            if (block.children) inner += (block.children || []).map(b => blockToHTMLAtStep(b, step)).join('\n');
            return `<${tag} class="${cls.trim()}" style="${s}">${inner}</${tag}>`;
        }
        case 'image': {
            let imgSrc = block.src || '';
            if (_pdfDeckDir && imgSrc && !imgSrc.startsWith('http') && !imgSrc.startsWith('file:') && !imgSrc.startsWith('data:')) {
                imgSrc = 'file://' + path.join(_pdfDeckDir, imgSrc).replace(/\\/g, '/');
            }
            const imgStyle2 = `width:100%;height:100%;display:block;object-fit:${block.fit || 'contain'};`;
            return `<div class="${cls.trim()}"${styleAttr}><img src="${escapeAttr(imgSrc)}" alt="${escapeAttr(block.alt||'')}" style="${imgStyle2}"></div>`;
        }
        case 'list': {
            const ltag  = block.ordered ? 'ol' : 'ul';
            const items = (block.items || []).map(item => {
                const ifo    = (item.fragmentOrder != null && item.fragmentOrder >= 1) ? item.fragmentOrder : null;
                const ihide  = (ifo != null && ifo > step) ? ' class="hidden-step"' : '';
                let inner = renderMathInContent(item.content || '');
                if (item.children) inner += (item.children || []).map(b => blockToHTMLAtStep(b, step)).join('\n');
                return `<li${ihide}>${inner}</li>`;
            }).join('\n');
            return `<${ltag} class="${cls.trim()}"${styleAttr}>\n${items}\n</${ltag}>`;
        }
        case 'math': {
            let rendered;
            if (_katex) {
                try { rendered = _katex.renderToString(block.mathSrc || '', { displayMode: true, output: 'html', throwOnError: false }); }
                catch(_) { rendered = `$$${block.mathSrc || ''}$$`; }
            } else { rendered = `$$${block.mathSrc || ''}$$`; }
            return `<div class="${cls.trim()}"${styleAttr}>${rendered}</div>`;
        }
        case 'box': {
            const inner = (block.children || []).map(b => blockToHTMLAtStep(b, step)).join('\n');
            return `<div class="box-blue${cls}" style="${style}">\n${inner}\n</div>`;
        }
        case 'raw':
            return `<div class="${cls.trim()}"${styleAttr}>${block.html || ''}</div>`;
        case 'code': {
            const lang = block.language ? ` class="language-${escapeAttr(block.language)}"` : '';
            const esc  = (block.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            return `<div class="code-block${cls}" style="${style}"><pre style="margin:0;"><code${lang}>${esc}</code></pre></div>`;
        }
        case 'arrow': {
            return buildArrowSVG(block, cls, '');
        }
        case 'eval': {
            let inner = '';
            if (block.output) {
                if      (block.output.type === 'svg'   && block.output.data) inner = `<div style="padding:8px;overflow:hidden;">${block.output.data}</div>`;
                else if (block.output.type === 'latex'  && block.output.html) inner = `<div style="padding:16px 20px;">${block.output.html}</div>`;
                else if (block.output.type === 'image'  && block.output.data) inner = `<img src="${escapeAttr(block.output.data)}" style="max-width:100%;max-height:100%;display:block;object-fit:contain;">`;
                else if (block.output.type === 'text'   && block.output.text) {
                    const esc = (block.output.text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                    inner = `<pre style="margin:0;padding:16px 20px;font-family:monospace;font-size:14px;white-space:pre-wrap;">${esc}</pre>`;
                }
            }
            return `<div class="eval-block${cls}" style="border-radius:6px;overflow:hidden;background:${block.evalBg || 'transparent'};${style}">${inner}</div>`;
        }
        default:
            return `<div class="${cls.trim()}"${styleAttr}>${block.content || ''}</div>`;
    }
}

