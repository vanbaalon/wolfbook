// eval-fragment.js — run one fragment of Wolfram source and get something a
// document can hold: LaTeX, an SVG, a PNG, or plain text.
//
// No vscode. The caller owns the kernel, the lease and the transport; this
// module owns only the two halves that are easy to get subtly wrong — the
// expression sent to the kernel, and the interpretation of what comes back.
//
// Extracted from tools/wolfslide-tools.js, where this pipeline was written for
// .wslide eval blocks and then copied. It now has a second consumer (managed
// computations in a .tex), and a shape that is copied twice is a shape that
// will diverge, so it lives here and wolfslide-tools delegates.
//
// THREE DELIBERATE DIFFERENCES from the .wslide original, each because a paper
// is not a slide:
//
//  1. pageWidthEm is a PARAMETER. The slide path guessed `imageWidthPx / 10`,
//     which is roughly twice too wide for a one-column article and produces
//     LaTeX that overruns the text block. A paper knows its own \textwidth, so
//     it passes the real number.
//  2. KaTeX pre-rendering is OFF by default. Pre-rendered HTML is for showing
//     a result in a webview; what gets written into a .tex is the LaTeX source
//     itself. The webview asks for `katex: true` when it wants both.
//  3. `prefer: 'figure'` forces the graphics branch even when the result is not
//     graphics, so a cell declared as a figure cannot come back as an equation.

const path = require('path');
const fs = require('fs');
const { decodeWstpText } = require('../utils/encoding');

// ---------------------------------------------------------------------------
// The BTL addon
// ---------------------------------------------------------------------------

let _btl = null;
let _btlTried = false;
let _prerender = null;

/** Load wolfbook_btl.node, preferring the prebuilt for this platform+arch. */
function loadBtl() {
    if (_btlTried) return _btl;
    _btlTried = true;
    try {
        const dir = path.join(__dirname, '../../wllatex-addon');
        const prebuilt = path.join(dir, 'prebuilt', `wolfbook_btl-${process.platform}-${process.arch}.node`);
        const fallback = path.join(dir, 'wolfbook_btl.node');
        _btl = require(fs.existsSync(prebuilt) ? prebuilt : fallback);
        try { _prerender = require(path.join(dir, 'katexPrerender.js')).prerenderLatex; } catch (_) {}
    } catch (_) { _btl = null; }
    return _btl;
}

/** Escape a source string for embedding in a Wolfram string literal. */
function escapeForKernel(code) {
    return String(code).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// The expression
// ---------------------------------------------------------------------------

/**
 * Build the kernel expression that evaluates one fragment and reports the
 * result in a form JavaScript can read.
 *
 * Three details here were each a real bug and must not be simplified away:
 *
 *  1. ToExpression[…, InputForm, Hold] parses BEFORE the timeout wrapper, so a
 *     syntax error is reported as a syntax error rather than as a timeout or a
 *     confusing partial evaluation.
 *  2. $wbTO$ is Block-local, so the timeout sentinel can never be equal to a
 *     legitimate result. A string sentinel could be returned by real code.
 *  3. With[{$wbVal$ = res}, MakeBoxes[$wbVal$, …]] injects the VALUE past
 *     MakeBoxes's HoldAllComplete. Passing the symbol boxes the symbol.
 *
 * @param {string} code
 * @param {{timeoutSeconds?: number, imageWidthPx?: number, prefer?: 'auto'|'figure',
 *          escaped?: boolean, wantPdf?: boolean}} opts
 *   escaped: the caller has already escaped `code` for a Wolfram string literal.
 *   wantPdf: a graphics result is wanted as a PDF as well as a preview — see
 *            the graphics branch below for why a paper cannot use the SVG.
 */
function buildEvalExpr(code, opts = {}) {
    const timeout = Math.max(1, Math.floor(Number(opts.timeoutSeconds ?? 60)));
    const imgW = Math.max(50, Math.floor(Number(opts.imageWidthPx ?? 600)));
    const escaped = opts.escaped ? String(code) : escapeForKernel(code);
    // A cell declared as a figure is a figure even if the expression is, say, a
    // Legended[...] the graphics test would not have matched.
    const gfxTest = opts.prefer === 'figure'
        ? 'True'
        : '!FreeQ[$wbRes$, _Graphics | _Graphics3D | _Graph | _GeoGraphics | _Legended | _Image | _Image3D]';

    // A SLIDE wants a picture a browser can draw, so SVG first, PNG after.
    const gfxForScreen = `(* Graphics: try SVG with text-to-outlines first, fall back to plain SVG, then PNG *)
        $wbSvg$ = Quiet[ExportString[$wbRes$, "SVG", ImageSize -> ${imgW}, Background -> None, "ConvertTextToOutlines" -> True]];
        If[!StringQ[$wbSvg$] || !StringContainsQ[$wbSvg$, "<svg"],
          $wbSvg$ = Quiet[ExportString[$wbRes$, "SVG", ImageSize -> ${imgW}, Background -> None]]];
        If[StringQ[$wbSvg$] && StringContainsQ[$wbSvg$, "<svg"],
          "SVG:" <> $wbSvg$,
          $wbImg$ = Quiet[ExportString[Rasterize[$wbRes$, ImageSize -> ${imgW}, Background -> None], {"Base64", "PNG"}]];
          If[StringQ[$wbImg$], "IMAGE:" <> $wbImg$, "TEXT:" <> ToString[$wbRes$, InputForm]]
        ]`;

    // A PAPER CANNOT USE AN SVG AT ALL. pdflatex's \\includegraphics reads PDF,
    // PNG and JPEG; an .svg is "Unknown graphics extension" and the document
    // stops building. So the paper asks for a PDF — which is also the right
    // answer on its own merits, being vector and therefore sharp at any size
    // the float is scaled to.
    //
    // The SVG is still exported, but only as the PREVIEW shown in the card:
    // it is what a webview can draw without a PDF renderer. Both come back
    // from ONE evaluation, separated by a sentinel that cannot occur in
    // base64 (which has no '$'), so pressing Run costs one kernel round trip
    // rather than two.
    const gfxForPaper = `(* Graphics for a paper: PDF to insert, SVG to preview, PNG as the floor *)
        $wbPdf$ = Quiet[ExportString[$wbRes$, {"Base64", "PDF"}, ImageSize -> ${imgW}]];
        $wbSvg$ = Quiet[ExportString[$wbRes$, "SVG", ImageSize -> ${imgW}, Background -> None, "ConvertTextToOutlines" -> True]];
        If[!StringQ[$wbSvg$] || !StringContainsQ[$wbSvg$, "<svg"], $wbSvg$ = ""];
        If[StringQ[$wbPdf$] && StringLength[$wbPdf$] > 0,
          "FIG:" <> $wbPdf$ <> "$WBSEP$" <> $wbSvg$,
          $wbImg$ = Quiet[ExportString[Rasterize[$wbRes$, ImageSize -> ${imgW}, Background -> None], {"Base64", "PNG"}]];
          If[StringQ[$wbImg$], "IMAGE:" <> $wbImg$, "TEXT:" <> ToString[$wbRes$, InputForm]]
        ]`;

    const gfxBranch = opts.wantPdf ? gfxForPaper : gfxForScreen;
    return `Block[{$wbRes$, $wbSvg$, $wbImg$, $wbBoxes$, $wbGfx$, $wbParsed$, $wbTO$},
  (* Step 1: parse without evaluating — catches syntax errors before timeout wrapping *)
  $wbParsed$ = Quiet[ToExpression["${escaped}", InputForm, Hold]];
  If[!MatchQ[$wbParsed$, Hold[_]],
    "ERROR:Syntax error in expression",
    (* Step 2: evaluate with timeout; $wbTO$ is Block-local so it can never equal a real result *)
    $wbRes$ = TimeConstrained[ReleaseHold[$wbParsed$], ${timeout}, $wbTO$];
    If[$wbRes$ === $wbTO$,
      "ERROR:Evaluation timed out after ${timeout}s",
      $wbGfx$ = ${gfxTest};
      If[$wbGfx$,
        ${gfxBranch},
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

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/**
 * Clean an exported SVG enough for a browser to draw it.
 *
 * Chrome dropped SVG 1.1 fonts, so Mathematica's embedded <font> definitions
 * render as nothing and the glyph names have to be mapped onto real families.
 */
function cleanSvg(raw) {
    let svg = decodeWstpText(raw);
    const start = svg.indexOf('<svg');
    if (start > 0) svg = svg.slice(start);
    const end = svg.toLowerCase().lastIndexOf('</svg>');
    if (end >= 0) svg = svg.slice(0, end + 6);
    return svg
        .replace(/[\n\r]/g, '')
        .replace(/<font[\s\S]*?<\/font>/gi, '')
        .replace(/<font-face[\s\S]*?\/>/gi, '')
        .replace(/MathematicaMono-Regular/g, '"Courier New", Courier, monospace')
        .replace(/MathematicaSans-Regular/g, 'Arial, Helvetica, sans-serif')
        .replace(/Mathematica1-Bold/g, 'serif')
        .replace(/Mathematica1/g, 'serif');
}

/**
 * Boxes -> LaTeX, broken to a real page width.
 *
 * @param {string} boxStr    already WSTP-decoded box source
 * @param {{pageWidthEm?: number, katex?: boolean, btl?: object}} opts
 *   btl: supply the addon instead of loading it. The width handling is the
 *   part of this that is easy to get wrong and worth testing on a machine
 *   with no native binary, so it is injectable rather than only discoverable.
 */
function boxesToLatex(boxStr, opts = {}) {
    const btl = opts.btl || loadBtl();
    if (!btl) return null;
    const wlUTFtoNames = require('../namedchars').wlUTFtoNames;
    const result = btl.boxToLatex(wlUTFtoNames(boxStr), { trigOmitParens: true, trigPowerForm: true });
    if (result && result.error) return { error: String(result.error) };
    let latex = (result && typeof result === 'object') ? result.latex : String(result);

    const pageWidth = Math.floor(Number(opts.pageWidthEm ?? 0));
    if (pageWidth > 5 && btl.lineBreakLatex) {
        try {
            const broken = btl.lineBreakLatex(latex, { pageWidth });
            // Older builds return a bare string; newer ones return {result}.
            latex = (broken && typeof broken === 'object') ? (broken.result ?? latex) : String(broken ?? latex);
        } catch (_) { /* an unbroken line is still correct LaTeX */ }
    }
    const out = { latex };
    if (opts.katex && _prerender) {
        try { out.html = _prerender(latex, true); } catch (_) {}
    }
    return out;
}

/**
 * Interpret the kernel's prefixed reply.
 *
 * @param {string} raw
 * @param {{pageWidthEm?: number, katex?: boolean, imageWidthPx?: number}} opts
 * @returns {{kind: 'latex'|'svg'|'image'|'text'|'error', ...}}
 */
function parseEvalResult(raw, opts = {}) {
    const s = String(raw ?? '');
    const at = new Date().toISOString();

    if (s.startsWith('FIG:')) {
        // <base64 pdf>$WBSEP$<svg>. The separator cannot occur in the base64
        // half, so the FIRST occurrence is always the boundary.
        const rest = s.slice(4);
        const cut = rest.indexOf('$WBSEP$');
        const pdf = cut >= 0 ? rest.slice(0, cut) : rest;
        const svg = cut >= 0 ? rest.slice(cut + 7) : '';
        return {
            kind: 'figure',
            pdfBase64: pdf.replace(/\s+/g, ''),
            svg: svg && svg.includes('<svg') ? cleanSvg(svg) : null,
            evaluatedAt: at,
        };
    }
    if (s.startsWith('SVG:')) {
        return { kind: 'svg', svg: cleanSvg(s.slice(4)), evaluatedAt: at };
    }
    if (s.startsWith('BOXES:')) {
        const boxes = decodeWstpText(s.slice(6));
        const conv = boxesToLatex(boxes, opts);   // opts.btl forwards for tests
        if (conv && conv.latex) {
            const out = { kind: 'latex', latex: conv.latex, boxes, evaluatedAt: at };
            if (conv.html) out.html = conv.html;
            return out;
        }
        // BTL missing or refused these boxes — the boxes themselves are still
        // the most informative thing we can hand back, and saying so is better
        // than pretending the evaluation failed.
        return {
            kind: 'text', text: boxes, evaluatedAt: at,
            note: conv && conv.error ? `LaTeX conversion failed: ${conv.error}` : 'LaTeX converter unavailable',
        };
    }
    if (s.startsWith('IMAGE:')) {
        return { kind: 'image', base64: s.slice(6), mime: 'image/png', evaluatedAt: at };
    }
    if (s.startsWith('TEXT:')) {
        return { kind: 'text', text: decodeWstpText(s.slice(5)), evaluatedAt: at };
    }
    if (s.startsWith('ERROR:')) {
        return { kind: 'error', error: s.slice(6), evaluatedAt: at };
    }
    return { kind: 'text', text: s, evaluatedAt: at };
}

/**
 * The .wslide output shape, for the two call sites that still speak it.
 * Keeping the translation here rather than in the callers means there is one
 * place where the old vocabulary maps onto the new.
 */
function toSlideOutput(res, opts = {}) {
    const at = new Date().toLocaleTimeString();
    switch (res.kind) {
        case 'svg':   return { type: 'svg', data: res.svg, evaluatedAt: at };
        case 'figure': return res.svg
            ? { type: 'svg', data: res.svg, evaluatedAt: at }
            : { type: 'image', data: 'data:application/pdf;base64,' + res.pdfBase64, evaluatedAt: at };
        case 'latex': return { type: 'latex', html: res.html, latex: res.latex, evaluatedAt: at };
        case 'image': return { type: 'image', data: 'data:' + res.mime + ';base64,' + res.base64, evaluatedAt: at };
        case 'error': return { type: 'error', error: res.error, evaluatedAt: at };
        default:      return { type: 'text', text: res.text, evaluatedAt: at };
    }
}

module.exports = {
    loadBtl,
    escapeForKernel,
    buildEvalExpr,
    parseEvalResult,
    boxesToLatex,
    cleanSvg,
    toSlideOutput,
};
