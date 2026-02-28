# Output Format Switching — Design Document

> Status: **Implemented** (2026-02-27)

---

## Goal

Add per-cell output format control with three explicit format buttons in the output header
row, next to the existing Wrap button.  Format is remembered per cell across re-evaluations
within a session.  The three formats are:

| Button | Label | Format string | Kernel call |
|--------|-------|--------------|-------------|
| 1 | `TXT` | `"InputForm"` | `ToString[Out[N], InputForm]` with `*` → space outside strings |
| 2 | `SVG` | `"SVG"` | `VsCodeRender[N, "SVG", scale]` |
| 3 | `∑` (sigma) | `"MathML"` | `VsCodeRender[N, "MathML", scale]` |

The active format button is highlighted.  The Wrap/Scroll toggle remains, but only for MathML
outputs.  MathML outputs also get ⊕ / ⊖ zoom buttons that CSS-scale all `div.mathml-output`
divs on the page (session-level, no kernel re-render needed).

---

## Architecture

### Three-layer change

```
init.wl          (kernel side)   — InputForm clean path + LeafCount threshold bump
controller.js    (extension)     — output registry, per-cell format map, reformat handler
renderer JS      (webview)       — format buttons, zoom buttons, postMessage to controller
```

### Per-cell format state

- `_cellOutputFormat: Map<cellUri, 'MathML'|'SVG'|'InputForm'>`  — stores per-cell override.
  Populated when the user clicks a format button.  Read at the start of `checkoutExecutionQueue`
  to select the render format for the *next* evaluation of that cell.
- Falls back to the global `wolfram.outputFormat` workspace setting when no per-cell override exists.

### Output registry

Every rendered output (non-truncated and truncated) now gets a unique `outputId` embedded
as `data-output-id="…"` on the `.wl-output-header` div.  The controller keeps:

```js
this._outputRegistry = new Map();
// outputId → { cell, outN, outName, format }
```

This replaces the narrow `truncatedOutputCells` map for reformat purposes.  `truncatedOutputCells`
is kept as-is for the existing Expand / Open as Text buttons.

### Message flow for format switch

```
Renderer: user clicks SVG button
  → postMessage({ type: 'reformat-output', outputId, newFormat: 'SVG' })

Controller: _rendererMessaging.onDidReceiveMessage
  1. Look up info = _outputRegistry.get(outputId)
  2. _cellOutputFormat.set(cell.document.uri, 'SVG')   // remember for next eval
  3. html = await VsCodeRender[info.outN, 'SVG', scale]
  4. _replaceOutputById(cell, outputId, html, outN, outName, 'SVG')
```

`_replaceOutputById` scans cell outputs, finds the one whose HTML contains
`data-output-id="${outputId}"`, builds a new header+content wrapper, and replaces using
a temporary `createNotebookCellExecution` (same pattern as `_replaceOutputByUuid`).

### Message flow for MathML zoom

Zoom is pure client-side — no kernel re-render.

```
Renderer: user clicks ⊕ button
  → wolframMathmlZoom = Math.min(2.0, wolframMathmlZoom + 0.15)
  → document.querySelectorAll('div.mathml-output').forEach(d =>
        d.style.fontSize = wolframMathmlZoom + 'em')
```

`wolframMathmlZoom` is a module-level variable (not per-output), starts at 1.0, range [0.4, 2.5].
It resets on window reload but persists across evaluations within a session.

---

## Header HTML structure

Before this feature, the header was:

```html
<div class="wl-output-header" ...>
  <span style="…">Out[3]=</span>
</div>
```

After this feature, it is:

```html
<div class="wl-output-header" ...
     data-output-id="42"
     data-out-n="3"
     data-output-format="MathML">
  <span style="…">Out[3]=</span>
  <!-- buttons injected by renderer: TXT | SVG | ∑ | ⊕ | ⊖ | Wrap -->
</div>
```

The renderer injects buttons in `renderOutputItem()` by querying `.wl-output-header[data-out-n]`.

---

## InputForm clean path (kernel side — init.wl)

New branch in `VsCodeRenderExpr` for `fmt === "InputForm"`:

```wl
If[fmt === "InputForm",
    Module[{s, parts},
        s = ToString[expr, InputForm];
        (* Replace * with space only OUTSIDE "..." string literals.
           Split on quoted regions, map over odd-indexed (outside-string) parts. *)
        parts = StringSplit[s, tok : ("\"" ~~ Shortest[___] ~~ "\"") :> tok];
        s = StringJoin[MapIndexed[
            If[OddQ[First[#2]], StringReplace[#1, "*" -> "\[ThinSpace]"], #1] &,
            parts]];
        Return["<pre class=\"vscode-wolfram-text-output\" " <>
               "style=\"white-space:pre-wrap;overflow-wrap:break-word;\">" <>
               StringReplace[s, {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}] <>
               "</pre>"
        ]
    ]
];
```

---

## LeafCount / size threshold (init.wl)

| Parameter | Before | After |
|-----------|--------|-------|
| LeafCount skeleton trigger | `lc > 200` | `lc > 205` |
| `outputSizeLimit` default | 200 KB | 205 KB |
| JS `maxOutputLength` default | 100 000 chars | 105 000 chars |

---

## Button styling

All buttons share a compact style consistent with the existing Wrap button:

```
padding: 1px 6px; font-size: 11px; cursor: pointer;
background: rgba(100,100,100,0.1); border: 1px solid rgba(128,128,128,0.4);
border-radius: 3px; flex-shrink: 0;
```

Active format button gets:
```
background: rgba(100,180,255,0.2); border-color: rgba(100,180,255,0.7);
```

---

## Files changed

| File | Change |
|------|--------|
| `out/extension/controller.js` | `_outputRegistry`, `_cellOutputFormat`, embed data attrs in headers, handle `reformat-output` message, `_replaceOutputById` method |
| `out/client/index-with-messaging.js` | Format buttons + zoom buttons injected in `renderOutputItem` |
| `resources/init.wl` | `InputForm` clean path in `VsCodeRenderExpr`, threshold bumps |
| `README.md` | Document per-cell format buttons |

---

## Non-goals / later

- Persisting `_cellOutputFormat` to the `.evsnb` file across sessions (would require serializer changes).
- Zoom persisting to settings file.
- A "default format for new cells" setting (can be done via global `wolfram.outputFormat`).
