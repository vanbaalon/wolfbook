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
let _katexEmbeddedCSS = null;     // katex.min.css with base64 fonts (for HTML export)
let _katexLocalFontCSS = null;    // katex.min.css with file:// font URLs (for PDF/screenshot)
let _katexFontsDir = null;        // absolute path to bundled katex fonts/
let _katexInlineJS = null;        // katex.min.js + auto-render.min.js concatenated (for HTML export)

// Directory of the .wslide file being exported (set by exportDeckPdf).
// Used to rewrite relative image paths to absolute file:// URLs for Chrome.
let _pdfDeckDir = null;

// Load KaTeX CSS and JS from local node_modules.
// CSS loading and JS loading are independent so that HTML exports always get
// inline JS auto-render even when require('katex') fails (e.g. in bundled builds).
try {
    const katexDist = path.join(__dirname, '..', '..', 'node_modules', 'katex', 'dist');
    const cssPath  = path.join(katexDist, 'katex.min.css');
    const fontsDir = path.join(katexDist, 'fonts');
    const jsPath   = path.join(katexDist, 'katex.min.js');
    const arPath   = path.join(katexDist, 'contrib', 'auto-render.min.js');

    if (fs.existsSync(cssPath)) {
        const rawCSS = fs.readFileSync(cssPath, 'utf8');
        if (fs.existsSync(fontsDir)) {
            // HTML export: embed fonts as base64 data URIs — self-contained, works from file:// URLs
            _katexEmbeddedCSS = rawCSS.replace(/url\(fonts\/([\w.\-]+)\)/g, (match, fontFile) => {
                const fontPath = path.join(fontsDir, fontFile);
                if (!fs.existsSync(fontPath)) return match;
                const ext = path.extname(fontFile).slice(1).toLowerCase();
                const mime = ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : 'font/truetype';
                const b64 = fs.readFileSync(fontPath).toString('base64');
                return `url(data:${mime};base64,${b64})`;
            });
            // PDF/screenshot: absolute file:// font paths so Chrome headless finds them
            const fontsUrl = 'file://' + fontsDir.replace(/\\/g, '/') + '/';
            _katexLocalFontCSS = rawCSS.replace(/url\(fonts\//g, `url(${fontsUrl}`);
            _katexFontsDir = fontsDir;
        } else {
            _katexEmbeddedCSS = rawCSS.replace(/url\(fonts\//g, 'url(https://cdn.jsdelivr.net/npm/katex@0.16/dist/fonts/');
            _katexLocalFontCSS = _katexEmbeddedCSS;
        }
    }

    // Inline JS: katex engine + auto-render plugin, bundled together.
    // Embedded so the HTML export works from file:// without any CDN or network access.
    if (fs.existsSync(jsPath) && fs.existsSync(arPath)) {
        _katexInlineJS = fs.readFileSync(jsPath, 'utf8') + '\n' + fs.readFileSync(arPath, 'utf8');
    }
} catch(_) { /* katex not in node_modules — will fall back to CDN */ }

// Server-side pre-render module (speeds up export; optional — auto-render JS is the real fallback)
try { _katex = require('katex'); } catch(_) {}

// Per-level heading sizes/weights that mirror the .wslide editor's
// .slide-content headings (media/wslide-editor.html lines ~201-204). Bare
// h1..h6 selectors, shared by the static/screenshot/PDF templates so their
// output matches the live viewer. exportDeck() inlines its own .reveal-scoped
// copy of these same values.
// Not !important: a block's own inline style (fontSize/color/...) must win,
// exactly as in the editor's built-in .slide-content headings.
// Heading sizes in em (relative to the 36px slide base) so a slide/deck `scale`
// set as font-size on the content container scales them too (feedback §C). At
// scale 1 these equal the original 64/48/40/34px.
const _HEADING_CSS =
    'h1,h2,h3,h4,h5,h6{text-transform:none;letter-spacing:normal;padding:0;}\n' +
    'h1{font-size:1.7778em;font-weight:700;line-height:1.15;margin:0 0 16px;}\n' +
    'h2{font-size:1.3333em;font-weight:700;line-height:1.2;margin:0 0 12px;}\n' +
    'h3{font-size:1.1111em;font-weight:600;line-height:1.25;margin:0 0 10px;}\n' +
    'h4{font-size:0.9444em;font-weight:600;line-height:1.3;margin:0 0 8px;}';

// Default 'box' styling — mirrors the editor's renderBox() (media/wslide-editor.html).
// A block's own inline style is appended after this so it overrides per-box.
const _BOX_DEFAULT_CSS = 'background:rgba(0,100,180,.07);border-left:4px solid #0064b4;border-radius:0 7px 7px 0;padding:14px 20px;';

// Base slide-content typography — must match the editor's `.slide-content` rule
// (media/wslide-editor.html) so HTML/PDF exports render text identically to the
// live viewer: 36px base, line-height 1.4, near-black #1a1a2e (NOT var(--navy),
// which the viewer does NOT use for body text). Applied to each export's content
// container; a slide `scale` sets font-size inline and overrides the 36px here.
const _BASE_TEXT_CSS = "font-family:'Helvetica Neue', Arial, sans-serif;font-size:36px;line-height:1.4;color:#1a1a2e;";

// Block-element spacing — must match the editor's `.slide-content {p,ul,ol,li,a,
// .two-col}` rules so paragraph/list spacing, link colour and two-column layout
// render identically in exports. Bare selectors (used by the static/step/pdf
// containers); the Reveal export needs section-scoped copies to beat its theme.
const _SLIDE_BLOCK_CSS =
    'p{margin:0 0 12px;}\n' +
    'ul,ol{margin:0 0 12px;padding-left:1.2em;}\n' +
    'li{margin-bottom:6px;}\n' +
    'a{color:var(--blue);text-decoration:underline;}\n' +
    '.two-col{display:flex;gap:40px;}.two-col>*{flex:1;}';

// Mirror of langToPrism() in media/wslide-editor.html so the exported <code>
// language class matches the viewer's (and Prism highlights the same way).
function _langToPrism(lang) {
    const map = {
        'mathematica':'wolfram','Mathematica':'wolfram','wolfram':'wolfram','Wolfram':'wolfram',
        'python':'python','Python':'python','javascript':'javascript','JavaScript':'javascript',
        'latex':'latex','LaTeX':'latex','tex':'latex',
    };
    return map[lang] || String(lang).toLowerCase();
}

// ── Server-side Prism highlighting ─────────────────────────────────────────
// The live viewer loads prismjs (1.29.0 + prism-tomorrow theme) from a CDN and
// highlights code at runtime. To render code IDENTICALLY in HTML/PDF exports —
// and offline, without a CDN/headless-timing dependency — we pre-render tokens
// here with the same bundled prismjs version + the same theme CSS.
let _prism = null;          // Prism module, or false if unavailable
let _prismThemeCss = null;  // cached prism-tomorrow.min.css text
function _getPrism() {
    if (_prism !== null) return _prism || null;
    try {
        const Prism = require('prismjs');
        require('prismjs/components/')(['wolfram', 'python', 'javascript', 'latex']);
        _prism = Prism;
    } catch (_) { _prism = false; }
    return _prism || null;
}
function _prismThemeCSS() {
    if (_prismThemeCss != null) return _prismThemeCss;
    try {
        const pkg = require.resolve('prismjs/package.json');
        _prismThemeCss = fs.readFileSync(path.join(path.dirname(pkg), 'themes', 'prism-tomorrow.min.css'), 'utf8');
    } catch (_) { _prismThemeCss = ''; }
    return _prismThemeCss;
}
// ── Export dependency check ────────────────────────────────────────────────
// Exports must render identically to the live viewer, which relies on KaTeX
// (equations) and Prism (code highlighting). If either package is missing from
// node_modules, exports silently degrade (raw $…$ / un-highlighted code) — so we
// surface a clear warning + install instructions at every export entry point.
function checkExportDependencies() {
    const missing = [];
    if (!_katex) missing.push({
        pkg: 'katex',
        purpose: 'equation rendering (KaTeX)',
        consequence: 'equations export as raw $…$ source (PDF) instead of typeset math',
    });
    if (!_getPrism()) missing.push({
        pkg: 'prismjs',
        purpose: 'code syntax highlighting',
        consequence: 'code blocks export as plain monochrome text instead of highlighted',
    });
    return missing;
}

/** Human-readable warning + install command, or null if all deps are present. */
function exportDependencyWarning() {
    const missing = checkExportDependencies();
    if (!missing.length) return null;
    const pkgs = missing.map(m => m.pkg).join(' ');
    return [
        '⚠ Slide export is missing render package(s) — output will NOT match the editor:',
        ...missing.map(m => `   • ${m.pkg} — needed for ${m.purpose}; without it ${m.consequence}.`),
        '',
        'Install so exports render identically to the viewer:',
        `   cd "Extension Development" && npm install ${pkgs}`,
    ].join('\n');
}

// Highlight code → token HTML matching the viewer; falls back to escaped plain text.
function _highlightCode(content, language) {
    const escaped = String(content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (!language) return escaped;
    const prismLang = _langToPrism(language);
    if (prismLang === 'plain') return escaped;
    const Prism = _getPrism();
    if (!Prism || !Prism.languages[prismLang]) return escaped;
    try { return Prism.highlight(String(content || ''), Prism.languages[prismLang], prismLang); }
    catch (_) { return escaped; }
}

// Default 'code' styling — mirrors the editor's .code-block (media/wslide-editor.html).
// The editor paints code blocks dark-navy; the export stylesheets historically had
// NO .code-block rule, so exported/printed code came out unstyled grey. See feedback §B.
const _CODE_CSS =
    '.code-block{position:relative;background:#0d1b30;border:1px solid rgba(255,255,255,.12);border-radius:6px;' +
    'padding:16px 20px;font-family:\'SF Mono\',\'Fira Code\',\'Consolas\',monospace;white-space:pre-wrap;' +
    'word-break:break-word;line-height:1.5;color:#e8edf5;}\n' +
    // Force the monospace stack on the whole code subtree with !important so it beats
    // both the reveal.js theme (.reveal pre/code) and Prism's own font stack — exactly
    // the monospace the editor shows (.code-block in media/wslide-editor.html).
    '.code-block,.code-block pre,.code-block code,.code-block code *{font-family:\'SF Mono\',\'Fira Code\',\'Consolas\',monospace!important;}\n' +
    // The <pre> UA default is white-space:pre (no wrap), which overrides the
    // inherited pre-wrap and makes long code lines overflow the block. The editor
    // sets pre-wrap inline on the <pre>; mirror that so code wraps identically.
    '.code-block pre{background:none!important;margin:0;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;}\n' +
    '.code-block code[class*="language-"],.code-block pre[class*="language-"]{color:inherit;background:none!important;}\n' +
    '.code-block .code-lang{position:absolute;top:4px;right:10px;font-size:11px;color:#7fb8d8;font-weight:600;text-transform:uppercase;letter-spacing:.05em;pointer-events:none;}';

/**
 * Pre-render $...$ and $$...$$ inside an HTML string using katex.renderToString.
 * Skips text inside HTML tags (< ... >).  Safe to call on already-HTML content.
 *
 * BUG GUARD: $\Gamma<0$ contains '<' which fools a naive HTML-tag splitter —
 * it would treat <0$...$\Gamma> as a fake tag and skip the math inside.
 * Fix: protect all math spans with placeholders BEFORE splitting on HTML tags.
 */
function renderMathInContent(html) {
    if (!_katex || !html || typeof html !== 'string') return html || '';

    // Step 1 — protect $...$ and $$...$$ so '<' inside math doesn't confuse the splitter.
    const mathSpans = [];
    let s = html.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, m => {
        const k = `\x01${mathSpans.length}\x01`;
        mathSpans.push(m);
        return k;
    });

    // Step 2 — split on HTML tags (now safe: no '<' left in protected math).
    const parts = s.split(/(<[^>]*>)/);

    // Step 3 — restore and render math only in text nodes (even-indexed parts).
    return parts.map((part, i) => {
        if (i % 2 === 1) {
            // HTML tag — restore any accidentally-captured math placeholders and return as-is.
            return part.replace(/\x01(\d+)\x01/g, (_, idx) => mathSpans[Number(idx)]);
        }
        return part.replace(/\x01(\d+)\x01/g, (_, idx) => {
            const src = mathSpans[Number(idx)];
            if (src.startsWith('$$')) {
                const inner = src.slice(2, -2).trim();
                try { return _katex.renderToString(htmlDecode(inner), { displayMode: true,  output: 'html', throwOnError: false }); }
                catch(_) { return src; }
            }
            const inner = src.slice(1, -1).trim();
            try { return _katex.renderToString(htmlDecode(inner), { displayMode: false, output: 'html', throwOnError: false }); }
            catch(_) { return src; }
        });
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
        if (forPdf) {
            // Screenshots: CSS only — Chrome's JS engine isn't needed, pre-render handles it
            return `<style>\n${css}\n</style>`;
        }
        // HTML export: CSS + inline auto-render JS (works from file:// URLs, no CDN needed).
        // Auto-render is the reliable fallback when server-side pre-render misses something.
        const autoRenderTag = _katexInlineJS ? [
            `<script>${_katexInlineJS}</script>`,
            `<script>document.addEventListener('DOMContentLoaded',function(){`,
            `  if(typeof renderMathInElement!=='undefined')`,
            `    renderMathInElement(document.body,{throwOnError:false,output:'html',`,
            `      delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]});`,
            `});</script>`,
        ].join('\n') : '';
        return `<style>\n${css}\n</style>\n${autoRenderTag}`;
    }
    // CDN fallback — only reached when katex is not in node_modules at all
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

/**
 * Export a deck (or a filtered subset of slides) as a self-contained Reveal.js HTML file.
 *
 * @param {object} deck        - The parsed .wslide deck object.
 * @param {object} [opts]
 * @param {string} [opts.deckDir]   - Absolute path to the .wslide directory; when provided,
 *                                     relative image src values are rewritten to absolute
 *                                     file:// URLs so the HTML works from any temp location.
 * @param {number[]} [opts.slideIndices] - Zero-based slide indices to include.  Omit for all.
 */
function exportDeck(deck, opts) {
    const deckDir     = opts?.deckDir || null;
    const title       = deck.meta?.title || 'Presentation';
    const defaultBg   = deck.defaultBackground || '#fafcff';
    const t           = deck.theme || {};
    const navy   = t.navy   || '#0a244a';
    const blue   = t.blue   || '#0064b4';
    const cyan   = t.cyan   || '#009ac8';
    const accent = t.accent || '#be1e2d';

    const allSlides = (deck.slides || []).filter(s => !s.hidden);
    const slides = opts?.slideIndices
        ? opts.slideIndices.map(i => allSlides[i]).filter(Boolean)
        : allSlides;

    if (deckDir) {
        _pdfDeckDir = deckDir; // reuse _embedImages machinery in blockToHTML
    }
    const sections = slides.map(s => slideToHTML(s, defaultBg, deck)).join('\n');
    if (deckDir) { _pdfDeckDir = null; }

    // NOTE: deck.theme.editorCSS is intentionally NOT injected here. The .wslide
    // editor stopped applying editorCSS to the slide DOM (see media/wslide-editor.html
    // ~line 1300) — blocks now carry all their styling in their own inline `style`,
    // and headings use built-in typography. The legacy editorCSS (written for the old
    // reveal template) contains `!important` bare-element rules (h2 banner, h3 border,
    // ul bullets) that override those inline styles and make the export diverge from
    // the editor. Dropping it gives editor/export parity. (Raw-block CSS, which the
    // editor scopes to sandboxed iframes, is a separate concern — no raw blocks here.)

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
.reveal,.reveal *{box-sizing:border-box;}
/* Force the slide sans font over reveal's theme, but NOT on code (.code-block keeps
   its monospace) or KaTeX (keeps its math fonts) — matches the editor exactly. */
.reveal,.reveal *:not(.katex):not(.katex *):not(.code-block):not(.code-block *){font-family:'Helvetica Neue', Arial, sans-serif!important;}
.reveal{font-size:36px;color:#1a1a2e;line-height:1.4;background:#000!important;}
.reveal-viewport{background:#000!important;}
.reveal .slide-background{display:none!important;}
.reveal .slides section{padding:0!important;margin:0!important;top:0!important;text-align:left;line-height:1.4;overflow:hidden;width:1920px;height:1080px;}
.reveal .slides section .slide-inner{width:1920px;height:1080px;overflow:hidden;}
.eval-block svg{max-width:100%;height:auto;display:block;}
.reveal .slides section h1,.reveal .slides section h2,.reveal .slides section h3,
.reveal .slides section h4,.reveal .slides section h5,.reveal .slides section h6{
  text-transform:none!important;letter-spacing:normal!important;padding:0;}
/* Per-level sizes/weights mirror the .wslide editor's built-in .slide-content
   headings. Deliberately NOT !important so a block's own inline style (e.g.
   fontSize/color/textAlign) wins — exactly as it does in the editor. The
   selector specificity (.reveal .slides section hN) already beats reveal's theme. */
.reveal .slides section h1{font-size:1.7778em;font-weight:700;line-height:1.15;margin:0 0 16px;}
.reveal .slides section h2{font-size:1.3333em;font-weight:700;line-height:1.2;margin:0 0 12px;}
.reveal .slides section h3{font-size:1.1111em;font-weight:600;line-height:1.25;margin:0 0 10px;}
.reveal .slides section h4{font-size:0.9444em;font-weight:600;line-height:1.3;margin:0 0 8px;}
.reveal .slides section img{border:none!important;box-shadow:none!important;background:none!important;margin:0!important;}
/* Mirror the editor's .slide-content {p,ul,ol,li,a,.two-col} spacing (section-scoped to beat reveal's theme). */
.reveal .slides section p{margin:0 0 12px;}
.reveal .slides section ul,.reveal .slides section ol{margin:0 0 12px;padding-left:1.2em;text-align:left;}
.reveal .slides section li{margin-bottom:6px;}
.reveal .slides section a{color:var(--blue);text-decoration:underline;}
.reveal .slides section .two-col{display:flex;gap:40px;}
.reveal .slides section .two-col>*{flex:1;}
.reveal .slides section *{line-height:inherit;}
${_prismThemeCSS()}
${_CODE_CSS}
.wslide-canvas{position:relative;width:1920px;height:1080px;}
.wel{position:absolute;box-sizing:border-box;}
/* Reveal.js print-pdf: one page per fragment step at 1920×1080 */
@media print{@page{size:1920px 1080px;margin:0;}}
</style>
<style>
.katex,.katex *{font-family:KaTeX_Main,KaTeX_Math,KaTeX_AMS,serif!important;color:inherit!important;}
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

// Effective font scale for a slide (feedback §C) — mirrors resolveSlideScale()
// in media/wslide-editor.html. slide.scale → slide.baseFontSize/36 →
// deck.scale → deck.baseFontSize/36 → 1.
function _resolveScale(slide, deck) {
    const fromSize = v => (typeof v === 'number' && v > 0) ? v / 36
        : (typeof v === 'string' && /^\d+(\.\d+)?px$/.test(v.trim())) ? parseFloat(v) / 36 : null;
    const cands = [
        typeof slide?.scale === 'number' ? slide.scale : null,
        fromSize(slide?.baseFontSize),
        typeof deck?.scale === 'number' ? deck.scale : null,
        fromSize(deck?.baseFontSize),
    ];
    const s = cands.find(v => v != null && v > 0);
    return (s && s > 0) ? s : 1;
}

// Slide-root vertical/horizontal alignment (feedback §D). Returns a CSS snippet
// for the flex slide container. slide.justify → justify-content (main axis),
// slide.align → align-items (cross axis).
function _alignJustifyCSS(slide) {
    let css = '';
    if (slide && slide.justify) css += `justify-content:${slide.justify};`;
    if (slide && slide.align)   css += `align-items:${slide.align};`;
    return css;
}

// ── Slide → <section> ─────────────────────────────────────────────────────

// Set true during slideToStaticHTML to strip all animation fragments so every
// element renders as visible without requiring Reveal.js step navigation.
let _allVisible = false;

function slideToHTML(slide, defaultBg, deck) {
    // Apply background as inline style on the inner wrapper (not data-background)
    // so it doesn't bleed beyond the 1920x1080 slide area.
    const bgStyle = `background:${slide.background || defaultBg || '#fafcff'};`;

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
        // Font scale (feedback §C): set the container base font-size; headings are
        // em-based (see _HEADING_CSS / the .reveal heading rules) so they scale with
        // it. Inline on .slide-inner ⇒ correctly per-slide even in a multi-slide deck.
        const scale   = _resolveScale(slide, deck);
        const fontCSS = scale !== 1 ? `font-size:${(36 * scale).toFixed(2)}px;` : '';
        // align/justify only meaningful for flex (non-free) layouts (feedback §D)
        const alignCSS = layout === 'free' ? '' : _alignJustifyCSS(slide);
        const layoutCSS = layout === 'free'
            ? `position:relative;width:1920px;height:1080px;${bgStyle}${padding}${fontCSS}`
            : `position:relative;display:flex;flex-direction:${flexDir};${gap}${padding}${alignCSS}width:1920px;height:1080px;${bgStyle}${fontCSS}`;
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
    const fo        = (!_allVisible && block.fragmentOrder != null && block.fragmentOrder >= 1) ? block.fragmentOrder : null;
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
            return `<${tag} class="${fragClass.trim()}${cls}" style="${s}"${fragAttr}>${renderMathInContent(renderMarkdownInContent(block.content || ''))}</${tag}>`;
        }
        case 'text': {
            const tag = block.tag || 'div';
            let s = style;
            if (block.fontSize) s += `font-size:${block.fontSize}px;`;
            if (block.color)    s += `color:${block.color};`;
            let inner = renderMathInContent(renderMarkdownInContent(block.content || ''));
            if (block.children) inner += (block.children || []).map(blockToHTML).join('\n');
            return `<${tag} class="${fragClass.trim()}${cls}" style="${s}"${fragAttr}>${inner}</${tag}>`;
        }
        case 'image': {
            // Mirror the editor's renderImage(): fill the container only when the
            // block has an explicit height; otherwise keep the natural aspect ratio.
            const imgH = block.h != null ? '100%' : 'auto';
            const imgStyle = `width:100%;height:${imgH};display:block;object-fit:${block.fit || 'contain'};`;
            const wrapStyle = `overflow:hidden;line-height:0;${style}`;
            return `<div class="${fragClass.trim()}${cls}" style="${wrapStyle}"${fragAttr}><img src="${escapeAttr(block.src || '')}" alt="${escapeAttr(block.alt || '')}" style="${imgStyle}"></div>`;
        }
        case 'list': {
            const tag   = block.ordered ? 'ol' : 'ul';
            const items = (block.items || []).map(item => {
                const ifo = (!_allVisible && item.fragmentOrder != null && item.fragmentOrder >= 1) ? item.fragmentOrder : null;
                const ifc = ifo !== null ? ' class="fragment"'            : '';
                const ifa = ifo !== null ? ` data-fragment-index="${ifo - 1}"` : '';
                let inner = renderMathInContent(renderMarkdownInContent(item.content || ''));
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
            return `<div class="${fragClass.trim()}${cls}" style="${_BOX_DEFAULT_CSS}${style}"${fragAttr}>\n${inner}\n</div>`;
        }
        case 'raw': {
            return `<div class="${fragClass.trim()}${cls}"${styleAttr}${fragAttr}>${block.html || ''}</div>`;
        }
        case 'code': {
            // Mirror the editor's renderCode(): Prism-mapped language class on <code>,
            // a raw-language chip in the corner, and block.fontSize honoured.
            const langClass = block.language ? ` class="language-${escapeAttr(_langToPrism(block.language))}"` : '';
            const codeHtml = _highlightCode(block.content, block.language);
            let s = style;
            if (block.fontSize) s += `font-size:${block.fontSize}px;`;
            const chip = block.language ? `<span class="code-lang">${escapeHtml(block.language)}</span>` : '';
            return `<div class="code-block${fragClass}${cls}" style="${s}"${fragAttr}><pre style="margin:0;"><code${langClass}>${codeHtml}</code></pre>${chip}</div>`;
        }
        case 'arrow': {
            return buildArrowSVG(block, `${fragClass.trim()}${cls}`, fragAttr, posStyle);
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
                    inner = `<pre class="eval-output-text" style="margin:0;padding:16px 20px;font-family:monospace;font-size:14px;white-space:pre-wrap;color:#c9d1d9;">${escaped}</pre>`;
                }
            }
            // Mirror the editor's .eval-block container (border/min-height/position);
            // the editor-only "▶ Mathematica" badge + spinner are intentionally omitted.
            return `<div class="eval-block${fragClass}${cls}" style="position:relative;min-height:60px;border:1px solid rgba(255,255,255,.1);border-radius:6px;overflow:hidden;background:${block.evalBg || 'transparent'};${style}"${fragAttr}>${inner}</div>`;
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
 * SVG marker-end="url(#id)" is unreliable in Chrome headless print mode, so we
 * draw the arrowhead triangle manually — but sized/positioned to MATCH the
 * editor's marker exactly (media/wslide-editor.html renderArrow): polygon
 * "0 0,10 3.5,0 7", markerWidth 10, markerHeight 7, refX 9, and the default
 * markerUnits="strokeWidth" (so the head scales with stroke width). In user
 * units that is: length 10·sw, half-height 3.5·sw, tip 1·sw beyond the path
 * vertex (refX 9 of 10), base 9·sw behind it.
 */
function buildArrowSVG(block, cls, extraAttr, extraStyle) {
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
    const headLen   = 10 * sw;                   // marker length (markerUnits=strokeWidth)
    const tipAhead  = 1 * sw;                     // refX 9 of 10 → tip sits 1·sw past the vertex
    const arrowHalf = 3.5 * sw;                   // markerHeight 7 → half = 3.5

    // Tip is just beyond the vertex; base sits headLen behind the tip.
    const tx = x1 + ux * tipAhead, ty = y1 + uy * tipAhead;
    const ex = tx - ux * headLen,  ey = ty - uy * headLen;   // base centre = path end

    // Arrowhead triangle: tip at (tx,ty), two base corners perpendicular at the base centre
    const b1x = ex - uy * arrowHalf, b1y = ey + ux * arrowHalf;
    const b2x = ex + uy * arrowHalf, b2y = ey - ux * arrowHalf;
    const pts  = `${tx.toFixed(1)},${ty.toFixed(1)} ${b1x.toFixed(1)},${b1y.toFixed(1)} ${b2x.toFixed(1)},${b2y.toFixed(1)}`;
    const clsAttr = cls.trim() ? ` class="${cls.trim()}"` : '';

    const xtraStyle = extraStyle ? extraStyle : '';
    return `<div${clsAttr} style="position:absolute;left:0;top:0;width:1920px;height:1080px;pointer-events:none;${xtraStyle}"${extraAttr}>` +
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

// ─────────────────────────────────────────────────────────────────────────────
// Markdown rendering — **bold**, *italic*, GFM tables
// Applied to text/heading/list-item content before LaTeX rendering.
// LaTeX spans ($...$  $$...$$) are protected with placeholders so markdown
// regexes never touch them.
// ─────────────────────────────────────────────────────────────────────────────

/** Convert basic Markdown in a content string to HTML.
 *  Handles: **bold**, *italic*, and GFM pipe tables.
 *  Skips HTML tags and preserves $...$ / $$...$$ LaTeX spans untouched.
 */
function renderMarkdownInContent(content) {
    if (!content || typeof content !== 'string') return content || '';
    // Fast-exit: no markdown indicators
    if (!/\*\*|\*[^*\s]|\|/.test(content)) return content;

    // Step 1: protect LaTeX spans with non-printable placeholders
    const latexSpans = [];
    let s = content.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*?\$/g, m => {
        const k = `\x00${latexSpans.length}\x00`;
        latexSpans.push(m);
        return k;
    });

    // Step 2: block-level — GFM tables (multi-line pipe syntax)
    s = _mdTables(s);

    // Step 3: inline — **bold** and *italic* in text nodes (not inside HTML tags)
    const parts = s.split(/(<[^>]+>)/);
    s = parts.map((p, i) => {
        if (i % 2 === 1) return p; // HTML tag — skip
        p = p.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
        p = p.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
        return p;
    }).join('');

    // Step 4: restore LaTeX spans
    s = s.replace(/\x00(\d+)\x00/g, (_, i) => latexSpans[Number(i)]);
    return s;
}

function _mdTables(content) {
    const lines = content.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        // Table: header row |..| followed immediately by separator row |:---|
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
            const headers = _splitTableRow(line);
            const aligns = lines[i + 1].split('|').slice(1, -1).map(c => {
                c = c.trim();
                if (/^:.*:$/.test(c)) return 'center';
                if (/^:/.test(c))     return 'left';
                if (/:$/.test(c))     return 'right';
                return '';
            });
            let j = i + 2;
            const rows = [];
            while (j < lines.length && /^\s*\|/.test(lines[j])) { rows.push(_splitTableRow(lines[j])); j++; }
            let html = '<table style="border-collapse:collapse;width:100%;"><thead><tr>';
            headers.forEach((h, k) => {
                const a = aligns[k] ? ` style="text-align:${aligns[k]};"` : '';
                html += `<th${a} style="padding:4px 10px;border-bottom:2px solid currentColor;">${h}</th>`;
            });
            html += '</tr></thead><tbody>';
            rows.forEach(r => {
                html += '<tr>';
                r.forEach((c, k) => {
                    const a = aligns[k] ? ` style="text-align:${aligns[k]};"` : '';
                    html += `<td${a} style="padding:3px 10px;border-bottom:1px solid rgba(0,0,0,.12);">${c}</td>`;
                });
                html += '</tr>';
            });
            html += '</tbody></table>';
            out.push(html);
            i = j;
        } else {
            out.push(line);
            i++;
        }
    }
    return out.join('\n');
}

function _splitTableRow(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

/**
 * Embed image block src values as base64 data URIs, reading from deckDir.
 * Handles both relative `img/…` paths and vscode-webview-resource:// URIs.
 * Returns a deep-cloned slide with srcs replaced where possible.
 */
function _embedImages(slide, deckDir) {
    const cloned = JSON.parse(JSON.stringify(slide));
    function resolveSrc(src) {
        if (!src || src.startsWith('data:')) return src;
        let fsPath = null;
        if (src.startsWith('img/')) {
            fsPath = path.join(deckDir, src);
        } else if (src.includes('vscode')) {
            // vscode-webview-resource:// or https://file+.vscode-resource.vscode-cdn.net/…
            try {
                const u = new URL(src);
                let p_ = decodeURIComponent(u.pathname);
                if (/^\/[A-Za-z]:/.test(p_)) p_ = p_.slice(1);
                fsPath = p_;
            } catch(_) {}
        }
        if (!fsPath) return src;
        try {
            const data = fs.readFileSync(fsPath);
            const ext  = path.extname(fsPath).slice(1).toLowerCase() || 'png';
            const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
            return `data:${mime};base64,${data.toString('base64')}`;
        } catch(_) { return src; }
    }
    function walkBlock(b) {
        if (!b) return;
        if (typeof b.src === 'string') b.src = resolveSrc(b.src);
        (b.children || []).forEach(walkBlock);
        (b.items    || []).forEach(walkBlock);
        (b.elements || []).forEach(walkBlock);
    }
    (cloned.children || cloned.elements || []).forEach(walkBlock);
    return cloned;
}

/**
 * Render a single slide to a self-contained static HTML page with ALL
 * animation fragments visible at once (no Reveal.js, no step navigation).
 * Used by wolfslide_getSlideHtml as the default "final state" preview.
 * Accepts the same deck theme for consistent styling.
 */
function slideToStaticHTML(slide, deck, deckDir) {
    const t = (deck && deck.theme) || {};
    const navy   = t.navy   || '#0a244a';
    const blue   = t.blue   || '#0064b4';
    const cyan   = t.cyan   || '#009ac8';
    const accent = t.accent || '#be1e2d';
    // editorCSS intentionally not applied — see the note in exportDeck(). Blocks
    // carry their own inline styles; the editor ignores editorCSS for slide DOM.
    const userCSS = '';
    const katexCSS = katexHeadAssets(false);

    // Embed images as data URIs when deckDir is provided (avoids broken relative paths in returned HTML)
    const slideForRender = deckDir ? _embedImages(slide, deckDir) : slide;

    _allVisible = true;
    let section;
    try { section = slideToHTML(slideForRender, null, deck); } finally { _allVisible = false; }

    const bg = slide.background || '#fafcff';
    const bgStyle = slide.background ? `background:${slide.background};` : '';
    // Wrap in a simple scaling viewport — no Reveal.js, pure CSS
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Slide — ${escapeHtml(slide.label || '')}</title>
${katexCSS}
<style>
:root{--navy:${navy};--blue:${blue};--cyan:${cyan};--accent:${accent};}
html,body{margin:0;padding:0;background:${bg};width:100%;height:100%;}
*{box-sizing:border-box;}
.slide-viewport{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;background:#333;}
.slide-scaler{width:1920px;height:1080px;transform-origin:top left;overflow:hidden;position:relative;}
.slide-inner{position:relative;width:1920px;height:1080px;overflow:hidden;${_BASE_TEXT_CSS}}
${_HEADING_CSS}
${_prismThemeCSS()}
${_CODE_CSS}
img{border:none!important;box-shadow:none!important;background:none!important;margin:0!important;}
${_SLIDE_BLOCK_CSS}
.wslide-canvas{position:relative;width:1920px;height:1080px;}
.wel{position:absolute;box-sizing:border-box;}
table{border-collapse:collapse;}
th,td{padding:4px 10px;}
</style>
${userCSS}
</head>
<body>
<div class="slide-viewport">
  <div class="slide-scaler" id="scaler" style="${bgStyle}">
    ${section}
  </div>
</div>
<script>
(function(){
  function fit(){
    const s=document.getElementById('scaler');
    const vw=window.innerWidth,vh=window.innerHeight;
    const scale=Math.min(vw/1920,vh/1080);
    s.style.transform='scale('+scale+')';
    s.style.marginLeft=((vw-1920*scale)/2)+'px';
    s.style.marginTop=((vh-1080*scale)/2)+'px';
  }
  fit();window.addEventListener('resize',fit);
})();
</script>
</body>
</html>`;
}

/**
 * Render one (slide, animationStep) pair as a standalone full HTML page sized
 * exactly 1920×1080 for Chrome headless screenshot mode.
 * Unlike exportDeckPdf, there is no @media print context — Chrome renders it
 * with its full GPU pipeline, preserving shadows, gradients, and all CSS effects.
 */
function exportSlideStepHtml(slide, step, deck, deckDir) {
    const t = deck?.theme || {};
    const navy   = t.navy   || '#0a244a';
    const blue   = t.blue   || '#0064b4';
    const cyan   = t.cyan   || '#009ac8';
    const accent = t.accent || '#be1e2d';
    // editorCSS intentionally not applied — see the note in exportDeck(). Blocks
    // carry their own inline styles; the editor ignores editorCSS for slide DOM.
    const userCSS = '';
    // Screenshot path: local file:// font CSS (25 KB) + inline auto-render JS (269 KB).
    // The JS is a fallback for the rare case where server-side pre-render is unavailable.
    // We avoid embedding base64 fonts (1.7 MB/frame) to keep temp file sizes manageable.
    const _shotAutoRender = _katexInlineJS
        ? `<script>${_katexInlineJS}</script>\n<script>document.addEventListener('DOMContentLoaded',function(){` +
          `if(typeof renderMathInElement!=='undefined')renderMathInElement(document.body,{throwOnError:false,output:'html',` +
          `delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]});});</script>`
        : '';
    const katexCSS = _katexLocalFontCSS
        ? `<style>\n${_katexLocalFontCSS}\n</style>\n${_shotAutoRender}`
        : katexHeadAssets(false); // CDN fallback (rare: katex not in node_modules)

    _pdfDeckDir = deckDir || null;
    const slideForRender = deckDir ? _embedImages(slide, deckDir) : slide;

    // Fall back to deck.defaultBackground so slides without an explicit background
    // still show the theme's default colour instead of white.
    const slideBg = slide.background || deck?.defaultBackground || '#fafcff';
    const bg = `background:${escapeAttr(slideBg)};`;
    const layout  = slide.layout || 'column';
    const padding = slide.padding ? `padding:${slide.padding};` : '';
    const gap     = slide.gap != null ? `gap:${slide.gap}px;` : '';
    const scale   = _resolveScale(slide, deck);
    const fontCSS = scale !== 1 ? `font-size:${(36 * scale).toFixed(2)}px;` : '';
    let contentStyle;
    if (layout === 'free') {
        contentStyle = `position:relative;width:1920px;height:1080px;${padding}${fontCSS}`;
    } else {
        const dir = layout === 'row' ? 'row' : 'column';
        contentStyle = `position:relative;display:flex;flex-direction:${dir};${gap}${padding}${_alignJustifyCSS(slide)}width:1920px;height:1080px;${fontCSS}`;
    }
    const inner = (slideForRender.children || []).map(b => blockToHTMLAtStep(b, step)).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
:root{--navy:${navy};--blue:${blue};--cyan:${cyan};--accent:${accent};}
/* Exclude .katex from resets so KaTeX fonts/colours are never overridden */
*:not(.katex):not(.katex *){box-sizing:border-box;margin:0;padding:0;}
html,body{width:1920px;height:1080px;overflow:hidden;margin:0;padding:0;
  font-family:'Helvetica Neue', Arial, sans-serif;font-size:36px;line-height:1.4;color:#1a1a2e;}
/* NOTE: no universal "font-family:inherit" — it would override html,body and resolve
   to the UA serif on the root element, turning the whole slide serif. Body font is
   inherited naturally; .code-block (mono) and .katex (math) override it. */
img{border:none;background:none;max-width:100%;max-height:100%;display:block;object-fit:contain;}
${_SLIDE_BLOCK_CSS}
${_HEADING_CSS}
${_prismThemeCSS()}
${_CODE_CSS}
.hidden-step{visibility:hidden;}
.eval-block svg{max-width:100%;height:auto;display:block;}
</style>
${katexCSS}
${userCSS}
<style>
/* Re-assert KaTeX font/colour after editorCSS — theme rules like "span{color:...}"
   would otherwise tint all math glyphs the wrong colour. */
.katex,.katex *{font-family:KaTeX_Main,KaTeX_Math,KaTeX_AMS,serif!important;color:inherit!important;}
</style>
</head>
<body style="${bg}">
<div style="${contentStyle}">
${inner}
</div>
</body>
</html>`;
}

module.exports = { exportDeck, exportDeckPdf, exportSlideStepHtml, slideToHTML, slideToStaticHTML, assembleSerializedDeck, assembleSerializedReveal, checkExportDependencies, exportDependencyWarning };

// ─────────────────────────────────────────────────────────────────────────────
// PDF-frames export  —  print-ready HTML: one page per animation step
// Open the resulting HTML in a browser and print → PDF to get Beamer-style
// output where each click step is a separate page.
// ─────────────────────────────────────────────────────────────────────────────

function exportDeckPdf(deck, deckDir, opts) {
    _pdfDeckDir = deckDir || null;
    // finalOnly: one page per slide at its final state (all fragments visible) — the
    // editor-accurate "publishing" view, shared by the HTML export and the print PDF.
    const finalOnly = !!(opts && opts.finalOnly);
    const title      = deck.meta?.title || 'Presentation';
    const navy   = deck.theme?.navy   || '#0a244a';
    const blue   = deck.theme?.blue   || '#0064b4';
    const cyan   = deck.theme?.cyan   || '#009ac8';
    const accent = deck.theme?.accent || '#be1e2d';

    // embedImages: inline images as base64 data URIs (portable, shareable HTML).
    // Otherwise blockToHTMLAtStep emits file:// paths via _pdfDeckDir (local print).
    const embed = !!(opts && opts.embedImages) && !!deckDir;
    if (embed) _pdfDeckDir = null;

    const defaultBg = deck.defaultBackground || '#fafcff';
    const pages = [];
    for (const slide0 of (deck.slides || [])) {
        if (slide0.hidden) continue;
        const slide = embed ? _embedImages(slide0, deckDir) : slide0;
        const maxFrag = maxFragOrder(slide);
        if (finalOnly) {
            pages.push(slideToPageHTML(slide, maxFrag, defaultBg, deck));
        } else {
            // One page for the base state, one more page per fragment step
            for (let step = 0; step <= maxFrag; step++) {
                pages.push(slideToPageHTML(slide, step, defaultBg, deck));
            }
        }
    }

    // editorCSS intentionally not applied — see the note in exportDeck().
    const userCSS = '';

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
/* Force Chrome to preserve all colors, backgrounds, and shadows in print mode */
*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{background:#888;font-family:'Helvetica Neue', Arial, sans-serif;}
.slide-page{
  position:relative;width:1920px;height:1080px;overflow:hidden;
  background:#fafcff;
  font-family:'Helvetica Neue', Arial, sans-serif;
  font-size:36px;line-height:1.4;color:#1a1a2e;
  transform-origin:top left;
}
/* All img elements: constrain to their container, never overflow */
img{border:none;background:none;max-width:100%;max-height:100%;display:block;object-fit:contain;}
${_SLIDE_BLOCK_CSS}
${_HEADING_CSS}
${_prismThemeCSS()}
${_CODE_CSS}
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
/* Screen preview: pages are 1920px; a script below scales each to fit the
   viewport width so the deck is readable in a browser. Print uses @page. */
@media screen{
  html,body{background:#222;}
  body{padding:0;display:flex;flex-direction:column;align-items:center;}
  .slide-wrap{margin:10px 0;box-shadow:0 2px 16px rgba(0,0,0,.5);overflow:hidden;}
  .slide-page{box-shadow:none;}
}
@media print{ .slide-wrap{margin:0;box-shadow:none;} }
</style>
${userCSS}
</head>
<body>
<!-- One 1920×1080 page per slide, all fragments revealed — same renderer as the PDF. -->
${pages.map(p => `<div class="slide-wrap">${p}</div>`).join('\n')}
<script>
(function(){
  // Scale each 1920×1080 page down to fit the viewport width (screen only).
  function fit(){
    var vw = document.documentElement.clientWidth;
    var scale = Math.min(1, (vw - 4) / 1920);
    document.querySelectorAll('.slide-wrap').forEach(function(w){
      var page = w.querySelector('.slide-page');
      page.style.transform = 'scale(' + scale + ')';
      page.style.transformOrigin = 'top left';
      w.style.width = (1920 * scale) + 'px';
      w.style.height = (1080 * scale) + 'px';
    });
  }
  if (!matchMedia('print').matches){ fit(); addEventListener('resize', fit); }
})();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialized-deck export  —  assemble the page from the webview's LIVE rendered
// DOM (KaTeX + Prism already applied, images inlined) + the editor's own slide
// CSS. This is the editor's exact output, so the export cannot drift from the
// viewer. KaTeX/Prism *theme* CSS (cross-origin in the webview) is supplied here
// from the bundled packages.
//   parts = { slides:[{background,hidden,html}], slideCSS, themeVars }
// ─────────────────────────────────────────────────────────────────────────────
function assembleSerializedDeck(parts, opts) {
    const all = (parts && parts.slides) || [];
    const slides = all.filter(s => s && !s.hidden);
    const pages = slides.map(s =>
        `<div class="slide-wrap"><div class="slide-page" style="background:${escapeAttr(s.background || '#fafcff')}">${s.html || ''}</div></div>`
    ).join('\n');
    const prismCss = _prismThemeCSS();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml((opts && opts.title) || 'Presentation')}</title>
<style>
@page{size:20in 11.25in;margin:0;}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
${parts.themeVars || ''}
html,body{margin:0;padding:0;}
.slide-page{position:relative;width:1920px;height:1080px;overflow:hidden;transform-origin:top left;}
.slide-page > .slide-content{width:1920px;height:1080px;}
@media screen{
  html,body{background:#222;}
  body{display:flex;flex-direction:column;align-items:center;}
  .slide-wrap{margin:10px 0;box-shadow:0 2px 16px rgba(0,0,0,.5);overflow:hidden;}
}
@media print{
  /* Undo the on-screen fit() scaling so each slide prints at full 1920×1080
     per @page (the JS sets an inline transform + sized wrappers for screen). */
  .slide-wrap{margin:0!important;box-shadow:none;width:auto!important;height:auto!important;overflow:visible!important;}
  .slide-page{transform:none!important;break-after:page;break-inside:avoid;}
  .slide-wrap:last-child .slide-page{break-after:auto;}
}
</style>
<style>
/* The editor's own slide CSS, captured live from the webview. */
${parts.slideCSS || ''}
</style>
${prismCss ? `<style>\n${prismCss}\n</style>` : ''}
${katexHeadAssets(false)}
<style>
/* Keep code monospace over Prism's theme font stack (matches the editor). */
.code-block,.code-block pre,.code-block code,.code-block code *{font-family:'SF Mono','Fira Code','Consolas',monospace!important;}
</style>
</head>
<body>
${pages}
<script>
(function(){
  if (matchMedia('print').matches) return;
  function fit(){
    var vw = document.documentElement.clientWidth;
    var sc = Math.min(1, (vw - 4) / 1920);
    document.querySelectorAll('.slide-wrap').forEach(function(w){
      var p = w.querySelector('.slide-page');
      p.style.transform = 'scale(' + sc + ')';
      p.style.transformOrigin = 'top left';
      w.style.width = (1920 * sc) + 'px';
      w.style.height = (1080 * sc) + 'px';
    });
  }
  fit(); addEventListener('resize', fit);
})();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialized-deck Reveal.js export  —  same live DOM as assembleSerializedDeck,
// but wrapped in Reveal.js <section>s so navigation, fragment animation and the
// per-slide transition (from the deck JSON) work. The slide CONTENT is the
// editor's own DOM/CSS; Reveal only adds the presentation shell.
// ─────────────────────────────────────────────────────────────────────────────
function assembleSerializedReveal(parts, opts) {
    const all = (parts && parts.slides) || [];
    const slides = all.filter(s => s && !s.hidden);
    const sections = slides.map(s => {
        let trans = s.transition || '';
        if (trans === 'random') trans = ['fade','slide','convex','concave','zoom'][Math.floor(Math.random() * 5)];
        const tAttr = trans ? ` data-transition="${escapeAttr(trans)}"` : '';
        const bg = s.background || '#fafcff';
        const notes = s.notes ? `\n<aside class="notes">${escapeAttr(s.notes)}</aside>` : '';
        return `<section${tAttr} style="background:${escapeAttr(bg)};">${s.html || ''}${notes}</section>`;
    }).join('\n');
    const prismCss = _prismThemeCSS();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml((opts && opts.title) || 'Presentation')}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css">
<style>
/* Reveal shell only — slide CONTENT styling comes from the editor's own CSS below.
   No theme stylesheet is loaded, so nothing recolours/uppercases the content. */
/* The editor uses border-box globally; without this, width:1920px + padding would
   overflow the slide (the slide-content/cards size content-box). */
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:#000;}
.reveal{background:#000;}
.reveal .slides{text-align:left;}
.reveal .slides section{padding:0!important;margin:0!important;top:0!important;width:1920px;height:1080px;overflow:hidden;}
.reveal .slides section>.slide-content{width:1920px;height:1080px;}
.reveal .slides section h1,.reveal .slides section h2,.reveal .slides section h3,
.reveal .slides section h4,.reveal .slides section h5,.reveal .slides section h6{text-transform:none;letter-spacing:normal;}
.reveal .slide-background-content{background:#000;}
${parts.themeVars || ''}
</style>
<style>
/* The editor's own slide CSS, captured live from the webview. */
${parts.slideCSS || ''}
</style>
${prismCss ? `<style>\n${prismCss}\n</style>` : ''}
${katexHeadAssets(false)}
<style>
.code-block,.code-block pre,.code-block code,.code-block code *{font-family:'SF Mono','Fira Code','Consolas',monospace!important;}
</style>
</head>
<body>
<div class="reveal"><div class="slides">
${sections}
</div></div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>
<script>Reveal.initialize({hash:true,slideNumber:'c/t',width:1920,height:1080,margin:0,minScale:0.1,maxScale:2,transition:'slide',center:false,controls:true,progress:true});</script>
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
function slideToPageHTML(slide, step, defaultBg, deck) {
    const bg = `background:${escapeAttr(slide.background || defaultBg || '#fafcff')};`;
    const layout  = slide.layout || 'column';
    const padding = slide.padding ? `padding:${slide.padding};` : '';
    const gap     = slide.gap != null ? `gap:${slide.gap}px;` : '';
    const scale   = _resolveScale(slide, deck);
    const fontCSS = scale !== 1 ? `font-size:${(36 * scale).toFixed(2)}px;` : '';

    let contentStyle;
    if (layout === 'free') {
        contentStyle = `position:relative;width:1920px;height:1080px;${padding}${fontCSS}`;
    } else {
        const dir = layout === 'row' ? 'row' : 'column';
        contentStyle = `position:relative;display:flex;flex-direction:${dir};${gap}${padding}${_alignJustifyCSS(slide)}width:1920px;height:1080px;${fontCSS}`;
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
            return `<${tag} class="${cls.trim()}" style="${s}">${renderMathInContent(renderMarkdownInContent(block.content || ''))}</${tag}>`;
        }
        case 'text': {
            const tag = block.tag || 'div';
            let s = style;
            if (block.fontSize) s += `font-size:${block.fontSize}px;`;
            if (block.color)    s += `color:${block.color};`;
            let inner = renderMathInContent(renderMarkdownInContent(block.content || ''));
            if (block.children) inner += (block.children || []).map(b => blockToHTMLAtStep(b, step)).join('\n');
            return `<${tag} class="${cls.trim()}" style="${s}">${inner}</${tag}>`;
        }
        case 'image': {
            let imgSrc = block.src || '';
            if (_pdfDeckDir && imgSrc && !imgSrc.startsWith('http') && !imgSrc.startsWith('file:') && !imgSrc.startsWith('data:')) {
                imgSrc = 'file://' + path.join(_pdfDeckDir, imgSrc).replace(/\\/g, '/');
            }
            // Match the editor: fill only when an explicit height is set; otherwise keep aspect ratio.
            const imgH2 = block.h != null ? '100%' : 'auto';
            const imgStyle2 = `width:100%;height:${imgH2};display:block;object-fit:${block.fit || 'contain'};`;
            const wrapStyle2 = `overflow:hidden;line-height:0;${style}`;
            return `<div class="${cls.trim()}" style="${wrapStyle2}"><img src="${escapeAttr(imgSrc)}" alt="${escapeAttr(block.alt||'')}" style="${imgStyle2}"></div>`;
        }
        case 'list': {
            const ltag  = block.ordered ? 'ol' : 'ul';
            const items = (block.items || []).map(item => {
                const ifo    = (item.fragmentOrder != null && item.fragmentOrder >= 1) ? item.fragmentOrder : null;
                const ihide  = (ifo != null && ifo > step) ? ' class="hidden-step"' : '';
                let inner = renderMathInContent(renderMarkdownInContent(item.content || ''));
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
            return `<div class="${cls.trim()}" style="${_BOX_DEFAULT_CSS}${style}">\n${inner}\n</div>`;
        }
        case 'raw':
            return `<div class="${cls.trim()}"${styleAttr}>${block.html || ''}</div>`;
        case 'code': {
            const langClass = block.language ? ` class="language-${escapeAttr(_langToPrism(block.language))}"` : '';
            const codeHtml = _highlightCode(block.content, block.language);
            let s = style;
            if (block.fontSize) s += `font-size:${block.fontSize}px;`;
            const chip = block.language ? `<span class="code-lang">${escapeHtml(block.language)}</span>` : '';
            return `<div class="code-block${cls}" style="${s}"><pre style="margin:0;"><code${langClass}>${codeHtml}</code></pre>${chip}</div>`;
        }
        case 'arrow': {
            return buildArrowSVG(block, cls, '', style);
        }
        case 'eval': {
            let inner = '';
            if (block.output) {
                if      (block.output.type === 'svg'   && block.output.data) inner = `<div style="padding:8px;overflow:hidden;">${block.output.data}</div>`;
                else if (block.output.type === 'latex'  && block.output.html) inner = `<div style="padding:16px 20px;color:#c9d1d9;overflow-x:auto;">${block.output.html}</div>`;
                else if (block.output.type === 'image'  && block.output.data) inner = `<img src="${escapeAttr(block.output.data)}" style="max-width:100%;max-height:100%;display:block;object-fit:contain;">`;
                else if (block.output.type === 'text'   && block.output.text) {
                    const esc = (block.output.text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                    inner = `<pre class="eval-output-text" style="margin:0;padding:16px 20px;font-family:monospace;font-size:14px;white-space:pre-wrap;color:#c9d1d9;">${esc}</pre>`;
                }
            }
            return `<div class="eval-block${cls}" style="position:relative;min-height:60px;border:1px solid rgba(255,255,255,.1);border-radius:6px;overflow:hidden;background:${block.evalBg || 'transparent'};${style}">${inner}</div>`;
        }
        default:
            return `<div class="${cls.trim()}"${styleAttr}>${block.content || ''}</div>`;
    }
}

