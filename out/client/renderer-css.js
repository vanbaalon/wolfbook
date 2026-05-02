/*
 * renderer-css.js — DEV_MODE flag, console gate, and WL_CSS stylesheet constant.
 * Extracted from index-with-messaging.js (Round 10 refactor).
 *
 * Licensed under the Apache License, Version 2.0
 */

// ---- Developer mode flag ----
// Gate all diagnostic console.log / console.warn behind this flag so end-user
// installs produce no renderer noise.  Set to true manually on the dev machine.
// (Webviews run in a sandboxed browser context with no Node.js access, so
// auto-detection via os.userInfo() is not available here.)
const DEV_MODE = false;
if (!DEV_MODE) { const _noop = () => {}; console.log = _noop; console.warn = _noop; }

// CSS for WL custom elements (wrow, w, wsub, wsup, wfrac…) + MathML helpers
const WL_CSS = `
:root { --fraction-line-width: max(0.08em,1px); --script-font-size: max(71%,8pt); --line-height: 1.1; }
w,wb,wrow,wsub,wsup,wsubsup,wover,wunder,wunderover,wfrac,wsqrt,wgraph,wgrid,wframe,wpane,wunknown,wfailed {
  margin:0;padding:0;border:0;font-size:100%;font:inherit;vertical-align:baseline;
  display:inline-block;white-space:nowrap;line-height:var(--line-height); }
.wexpr { font-family: Consolas, Courier, monospace; line-height: var(--line-height); }
.wexpr.traditional-form { font-family: 'Times New Roman', Times, serif; }
.wexpr > wrow, .wexpr > w, wframe > wrow, wframe > w, wpane > wrow, wpane > w
  { display:inline;white-space:normal;word-break:normal;overflow-wrap:anywhere; }
wrow > wrow, wrow > w { white-space:inherit;word-break:inherit;overflow-wrap:inherit; }
w.italic { font-style:italic; }
wfrac { text-align:center;margin:0 0.2ch;padding:0 0.2ch; }
wfrac > :first-child { display:block; }
wfrac > :last-child { display:grid; }
wfrac > :last-child > :first-child { border-top:solid var(--fraction-line-width);
  height:calc(1em * var(--line-height));margin-top:calc(-0.45em * var(--line-height));
  margin-bottom:calc(-0.4em * var(--line-height));transform:translateY(calc(0.6em * var(--line-height))); }
wfrac > :last-child > :last-child { display:block;z-index:1; }
wsup > :last-child { font-size:var(--script-font-size);vertical-align:1.3ex; }
wsub > :last-child { font-size:var(--script-font-size);vertical-align:-0.7ex; }
pre { font-family: Consolas, Courier, monospace; }
pre > .wl-message { color: var(--vscode-editorError-foreground); }
pre.vscode-wolfram-print-output { font-size:0.85em; margin:0; padding:0; line-height:1.3; }
div.wl-print-output { text-align:left; }
/* Output header: pointer cursor signals double-click-to-navigate */
div.wl-output-header { cursor: pointer; user-select: none; }
/* Each Print/WBPrint call → one flex row; args flow inline on the same line */
div.wl-print-line { display:flex; flex-wrap:wrap; align-items:baseline; gap:0.2em; margin:1px 0; }
span.wl-ps { font-family:var(--vscode-editor-font-family,monospace); font-size:0.85em; white-space:pre-wrap; line-height:1.3; }
span.wl-pg img { max-width:420px; max-height:300px; height:auto; width:auto; background:transparent; vertical-align:middle; }
div.wl-print-output .vscode-wolfram-wllatex-prerendered { font-size:0.82em; }
/* KaTeX display-mode inside a print line: render inline so it sits beside text args */
div.wl-print-line .katex-display { display:inline-block !important; text-align:left !important; margin:0 !important; }
pre.vscode-wolfram-text-output, pre.vscode-wolfram-tex-source {
  font-family: var(--vscode-editor-font-family, var(--vscode-font-family, Consolas, monospace));
  font-size: var(--vscode-editor-font-size, 13px);
  background: #1e1e1e;
  color: #d4d4d4;
  border: 1px solid rgba(80,80,80,0.5);
  border-radius: 3px; padding: 3px 10px 3px 3.2em;
  white-space: pre-wrap; overflow-wrap: break-word; line-height: 1.5; margin: 0; }
.wl-line-gutter { position:absolute;left:0;top:0;bottom:0;width:2.5em;padding:3px 3px 3px 0;
  text-align:right;color:rgba(180,180,180,0.5);font-size:0.82em;line-height:1.5;
  user-select:none;pointer-events:none;overflow:hidden;background:#1e1e1e;
  font-family:var(--vscode-editor-font-family,Consolas,monospace); }
@keyframes wl-fmt-flash {
  0%   { outline:2px solid rgba(218,165,32,0.85);outline-offset:1px; }
  70%  { outline:2px solid rgba(218,165,32,0.5);outline-offset:1px; }
  100% { outline:2px solid rgba(218,165,32,0);outline-offset:1px; }
}
button.wl-nb-default-fmt { animation:wl-fmt-flash 1.5s ease-out forwards; }
button[data-fmt-key]:hover { opacity:0.9 !important; }
img.vscode-wolfram-svg-output, img.vscode-wolfram-png-output { background: transparent; }
.vscode-wolfram-svg-output > svg > rect:first-child { fill: none !important; }
div.mathml-output { overflow-x:auto; }
div.vscode-wolfram-tex-output { overflow-x:auto; padding: 1px 0; }
div.vscode-wolfram-wllatex-prerendered,
div.vscode-wolfram-wllatex-raw-latex,
div.vscode-wolfram-tex-output {
  margin: 0;
}
.katex-display { margin: 4px 0 !important; }
.output { margin-top: 1px !important; margin-bottom: 1px !important; }
/* Inline syntax highlight tokens */
.wl-hl-str  { color: #ce9178; }
.wl-hl-cmt  { color: #6a9955; font-style: italic; }
.wl-hl-num  { color: #b5cea8; }
.wl-hl-sym  { color: #4ec9b0; }
.wl-hl-cmd  { color: #569cd6; }
.wl-hl-math { color: #c586c0; }
.wl-hl-brk  { color: #ffd700; }
`;

export { DEV_MODE, WL_CSS };
