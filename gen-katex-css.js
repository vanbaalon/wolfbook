/*
 * gen-katex-css.js — regenerate out/client/katex-css.js from node_modules/katex.
 *
 * The notebook renderer must style pre-rendered KaTeX HTML at the moment
 * VS Code measures the output height (synchronously after renderOutputItem).
 * A CDN <link> arrives too late: outputs are measured unstyled, then jump
 * when the stylesheet and web fonts land. This script inlines katex.min.css
 * with every woff2 font embedded as a base64 data: URI, producing a single
 * ES module the renderer imports and injects synchronously.
 *
 * Run after upgrading the katex package:
 *   node gen-katex-css.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'node_modules', 'katex', 'dist');
const OUT = path.join(__dirname, 'out', 'client', 'katex-css.js');

const version = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'node_modules', 'katex', 'package.json'), 'utf8')
).version;

let css = fs.readFileSync(path.join(DIST, 'katex.min.css'), 'utf8');

// Each @font-face src lists woff2, woff and ttf fallbacks. Modern Electron
// always picks woff2, so inline only that and drop the fallback URLs.
css = css.replace(
    /src:url\(fonts\/([A-Za-z0-9_-]+\.woff2)\) format\("woff2"\)(?:,url\(fonts\/[^)]+\) format\("[^"]+"\))*/g,
    (m, woff2Name) => {
        const b64 = fs.readFileSync(path.join(DIST, 'fonts', woff2Name)).toString('base64');
        return `src:url(data:font/woff2;base64,${b64}) format("woff2")`;
    }
);

if (/url\(fonts\//.test(css)) {
    throw new Error('gen-katex-css: some font URLs were not inlined — check the regex against this katex version');
}

const banner =
    '/*\n' +
    ` * katex-css.js — AUTO-GENERATED from katex@${version} by gen-katex-css.js. Do not edit.\n` +
    ' * katex.min.css with all woff2 fonts inlined as data: URIs, so math outputs\n' +
    ' * are fully styled at first layout (no CDN, works offline, no height jumps).\n' +
    ' */\n';

fs.writeFileSync(OUT, banner + 'export const KATEX_CSS = ' + JSON.stringify(css) + ';\n');
console.log('Wrote', OUT, '(' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB, katex', version + ')');
