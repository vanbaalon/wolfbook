# Wolfbook Rendering Pipeline

## Overview

The rendering pipeline converts a Wolfram Language expression from kernel evaluation
to visible HTML in the VS Code notebook output cell. The primary path for mathematical
expressions uses **WLLatex**: kernel → box expressions → base64 → C++ BTL addon →
LaTeX → KaTeX pre-render → HTML.

```
Cell Code
  │
  ▼
JS: session.evaluate(subExpr)          ← kernel evaluates, stores Out[N]
  │
  ▼
JS: session.evaluate(VsCodeRender[N, fmt, scale])
  │
  ▼
KERNEL (api.wl):  VsCodeRender
  │ ├─ Size check: LeafCount > 1000 or ByteCount > outputSizeLimit?
  │ │   YES → Shallow[expr, {Infinity, breadth}]   ← ACTUAL truncation (not Short!)
  │ │          set isSkeleton = True
  │ │   NO  → displayExpr = expr
  │ ▼
  │ VsCodeRenderExpr[displayExpr, format, scale]
  │
  ▼
KERNEL (render-expr.wl):  VsCodeRenderExpr
  │ ├─ Format dispatch:
  │ │   "WLLatex"  → MakeBoxes[expr, TraditionalForm]
  │ │                 expandAllTemplateBoxes[boxes]
  │ │                 ToString[boxes, InputForm]
  │ │                 ExportString[boxStr, "Base64"]
  │ │                 → <div class="vscode-wolfram-wllatex-boxes"
  │ │                        data-boxes-b64="...base64..."></div>
  │ │
  │ │   "SVG"      → ExportString[expr, "SVG"] → <img src="file.svg"/>
  │ │   "MathML"   → ExportString[expr, "MathML"] → <math>...</math>
  │ │   "TeX"      → ToString[expr, TeXForm] → <div data-tex-src="...">
  │ │   etc.
  │ ▼
  │ If isSkeleton: wrap in <div data-wolfram-is-skeleton="1" data-wolfram-atom-count="N">
  │
  ▼
JS: _processWLLatexBoxes(html)         ← checkout.js calls this
  │
  ▼
RENDERER (renderer.js):  processWLLatexBoxes
  │ ├─ Regex: finds <div class="vscode-wolfram-wllatex-boxes" data-boxes-b64="...">
  │ │
  │ ▼ For each match:
  │   1. Base64-decode → raw box string (WL InputForm)
  │   2. wlUTFtoNames(): convert Unicode chars → \[Name] form
  │      (e.g. U+F761 → \[LeftSkeleton], U+03B1 → \[Alpha])
  │   3. Call C++ addon: _btlAddon.boxToLatex(boxStr, btlOpts)
  │      btlOpts = { trigOmitParens, trigPowerForm, maxRows }
  │      Returns: { latex: "...", pages: [...] or null, error: "..." or null }
  │   4a. If pages.length > 1 (matrix paging):
  │       → KaTeX pre-render each page
  │       → Build pager HTML with ◀ Page N/M ▶ navigation
  │   4b. Single page:
  │       → Optional line-breaking: _btlAddon.lineBreakLatex(latex, lbOpts)
  │       → KaTeX pre-render: _btlPrerenderLatex(latex, displayMode=true)
  │       → Wrap in <div class="vscode-wolfram-wllatex-prerendered">
  │   5. Write to btl.log (input boxes + output LaTeX + metadata)
  │
  ▼
JS: Skeleton / size-based truncation check (checkout.js)
  │ ├─ isSkeleton?  → detected via data-wolfram-is-skeleton attribute
  │ ├─ html.length > maxLen (105 KB)?  → clip at safe HTML tag boundary
  │ │
  │ │ If either:
  │ │   → Generate truncation banner (▶ Full, +… More, 📄 Text)
  │ │   → Store in truncatedOutputCells map for expand handlers
  │ │
  │ ▼
  │ Wrap in: <div class="wl-output-block">
  │            <div class="wl-output-header">Out[N]=</div>
  │            <div class="wl-output-content">...rendered HTML...</div>
  │          </div>
  │          [optional truncation banner]
  │
  ▼
VS Code: NotebookCellOutput with MIME "x-application/wolfram-language-html"
  │
  ▼
CLIENT (index-with-messaging.js):  renderOutputItem
  │ ├─ Inject KaTeX CSS fonts link
  │ ├─ Attach button handlers:
  │ │   ▶ expand → postMessage('expand-truncated-output', uuid)
  │ │   +… more → postMessage('expand-more-output', uuid)
  │ │   📄 text → postMessage('open-truncated-as-text', uuid)
  │ │   ◀▶ pager → client-side page switching (no server roundtrip)
  │ ▼
  │ User sees rendered output
```

## Why Base64?

The box expression string from `ToString[boxes, InputForm]` contains:
- Arbitrary Unicode (Greek, math operators, WL private-use-area chars U+F700–F7FF)
- Nested quotes, backslashes, special chars
- Can be hundreds of KB

Embedding this directly in HTML attributes would require complex escaping that could
break on any special character. Base64 encoding provides a **lossless, safe transport**
through the HTML attribute → WSTP string → JS string pipeline without any escaping issues.

## BTL (Box-To-LaTeX) C++ Addon

**Location**: `VSCodeWolfbookLaTeX/src/native/`
**Built artifact**: `wolfbook_btl.node` (N-API native addon)

### What it does
- Parses WL box expressions (RowBox, FractionBox, SqrtBox, GridBox, SubscriptBox, etc.)
- Translates to LaTeX (\\frac{}{}, \\sqrt{}, \\begin{pmatrix}, \\subscript, etc.)
- Handles ~60 box types + WL special character names → LaTeX symbol mapping

### Matrix Paging
When `maxRows > 0` and the outermost GridBox has more rows than `maxRows`:
- Splits into pages of `maxRows` rows each
- Each page gets proper `\begin{env}…\end{env}` wrapping
- The `env` is determined by surrounding delimiters: `(` → pmatrix, `{` → cases, etc.
- Returns pages in `result.pages[]` array
- `gridBoxDepth_` counter ensures only the outermost matrix is paged (nested matrices are not split)

### Line Breaking
`lineBreakLatex(latex, opts)`: splits long LaTeX into multiple lines using `\\\\` breaks
at operator boundaries, respecting delimiter nesting depth.

## Truncation & Expansion System

### Initial Render (Large Output Detection)

**Kernel side** (`api.wl` → `VsCodeRender`):
- LeafCount > 1000 OR ByteCount > outputSizeLimit (default 1 MB)
- Applies `Shallow[expr, {Infinity, breadth}]` where breadth ∈ [5, 20]
- `Shallow` **actually truncates** at the kernel level, producing `<<N>>` skeleton markers
- (Note: `Short[]` is a front-end display hint — does nothing in a headless kernel)
- Sets `isSkeleton = True`, wraps HTML in `data-wolfram-is-skeleton="1"`

**JS side** (`checkout.js`):
- Detects `data-wolfram-is-skeleton` in HTML → `isSkeleton = true`
- Also checks: `html.length > maxLen` (105 KB) for raw size truncation
- If either triggers: generates banner + stores info in `truncatedOutputCells` map

### Expand Buttons

| Button | Handler | What happens |
|--------|---------|-------------|
| ▶ Full | `expand-truncated-output` | Calls `VsCodeRenderFull[outN]` (no size limit), processes through BTL, replaces output. Falls back to InputForm text if >1 MB or timeout. |
| +… More | `expand-more-output` | Calls `VsCodeRenderShallow[outN, breadth+20]` — progressive Shallow expansion. Returns JSON `{html, hasSkeleton}`. When `hasSkeleton=false`, removes banner (fully expanded). |
| 📄 Text | `open-truncated-as-text` | Calls `VsCodeOpenAsText[outN]` — writes `ToString[expr, InputForm]` to temp .wls file and opens it. |

### Progressive Expansion (+… Button)

Each click increases `shallowBreadth` by 20:
```
Click 1: Shallow[Out[N], {Infinity, 40}]   → shows 40 elements per level
Click 2: Shallow[Out[N], {Infinity, 60}]   → shows 60 elements per level
Click 3: Shallow[Out[N], {Infinity, 80}]   → shows 80 elements per level
...
Click K: if hasSkeleton=false → banner removed, expression fully shown
```

`VsCodeRenderShallow` checks `\[LeftSkeleton]` (U+F761) in the generated boxes
to determine if the expression is still truncated.

## Skeleton Characters

| Char | Unicode | WL Name | Renders as |
|------|---------|---------|-----------|
| « | U+F761 | `\[LeftSkeleton]` | `<<` |
| » | U+F762 | `\[RightSkeleton]` | `>>` |

These are WL private-use-area characters. In the rendering pipeline:
1. Kernel: `Shallow[]` inserts them as `RowBox[{"\[LeftSkeleton]", "N", "\[RightSkeleton]"}]`
2. Base64: they survive inside the base64 blob (invisible to HTML-level regex)
3. BTL: `wlUTFtoNames()` converts U+F761 → `\[LeftSkeleton]`, then BTL renders as `\langle\!\langle N \rangle\!\rangle`
4. KaTeX: renders as ⟨⟨N⟩⟩

## Format Resolution

Priority chain (highest to lowest):
1. Per-output override (`cellUri:outN` key)
2. Per-cell override (`cellUri` key)
3. Notebook-level default (separate for expressions vs graphics)
4. Extension setting `outputFormat` (default: **WLLatex**)

Kernel-side: `VsCodeRenderExpr` receives the format string.
- `"WLLatex"` → TraditionalForm boxes → Base64 → BTL → KaTeX (primary path)
- `"Auto"` → `"SVG"` for graphics, `"MathML"` for expressions
- `"SVG"` → ExportString SVG/PNG → `<img>` tag
- `"MathML"` → ExportString MathML → `<math>` tag (legacy, rarely used)

## File Map

| File | Role |
|------|------|
| `resources/api.wl` | VsCodeRender, VsCodeRenderFull, VsCodeRenderShallow, VsCodeOpenAsText |
| `resources/render-expr.wl` | VsCodeRenderExpr — format dispatch, MakeBoxes, Base64, SVG export |
| `out/extension/execution/checkout.js` | Eval loop — calls VsCodeRender, processes HTML, truncation detection |
| `out/extension/output/renderer.js` | processWLLatexBoxes, BTL addon loading, KaTeX pre-render, makeTruncationBanner |
| `out/extension/controller.js` | Message handlers: expand, expand-more, open-text, format-switch |
| `out/client/index-with-messaging.js` | Webview-side button handlers, pager navigation |
| `VSCodeWolfbookLaTeX/src/native/` | C++ BTL addon: box_to_latex.cpp, addon.cpp |

## btl.log

Written to `<notebook-dir>/img/<notebook-name>/btl.log` for every BTL call.
Contains: timestamp, source label, kernel raw output, cleaned box input, LaTeX output,
line-break status, paging info. Trimmed to last 400 lines on expand operations.
