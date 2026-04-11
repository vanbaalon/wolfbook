# Evaluable Block — Implementation Plan

## Concept

A new block type `eval` for the wolfslide editor that stores **Wolfram Language input** and displays the **evaluated output** (rendered image or text). The output is a cached snapshot — re-evaluable on demand.

---

## User-Facing Behaviour

### In the Editor (WYSIWYG canvas)

| State | What the user sees |
|---|---|
| **Has output** | The rendered output (PNG image, typically a plot/graphic). A small `▶ Mathematica` badge in the top-right corner. |
| **No output yet** | A placeholder box: `⊞ Eval: <first 40 chars of input>` with a dimmed code preview. |
| **Evaluating** | A spinner overlay with "Evaluating…" text. |
| **Error** | Red-bordered box with the error message. |

### Interactions

- **Single-click** → select (like any block — outline, resize handles, move handle).
- **Double-click** → opens the **Eval Editor modal** (same pattern as the code-block editor):
  - A modal with a code textarea showing the Wolfram input.
  - A "Run ▶" button that evaluates and updates the output.
  - A "Apply" button that saves input changes without running.
  - A "Cancel" button.
- **Context**: Right-click or Props Panel → "Run" button to re-evaluate without opening the modal.

### In Presentation Mode

Shows only the cached output image — no badge, no interactivity.

---

## Data Model

```jsonc
{
  "type": "eval",
  "id": "blk_abc123",
  "input": "Plot[Sin[x], {x, 0, 2Pi}]",       // Wolfram Language source
  "output": {                                    // null if never evaluated
    "type": "image",                             // "image" | "text" | "error"
    "data": "data:image/png;base64,iVBOR...",    // base64 data URI (for images)
    "text": "...",                                // plain text (for text output or InputForm fallback)
    "error": "...",                               // error message (when type=error)
    "evaluatedAt": "2026-04-08T12:00:00Z"        // timestamp
  },
  // Standard block properties:
  "position": "absolute", "x": 100, "y": 200, "w": 800, "h": 500,
  "fragmentOrder": null
}
```

Output is stored inline as a data URI. This keeps the `.wslide` file self-contained. Typical plot PNGs are 20-80 KB base64, acceptable for slide files.

---

## Evaluation Pipeline

```
User/AI triggers eval
       │
       ▼
 Webview posts { cmd: 'evalBlock', blockId, input }
       │
       ▼
 Provider receives message
       │
       ├─ Gets controller via getController()
       ├─ Checks kernel status (must be 'resolved', not busy)
       │
       ▼
 Provider sends to kernel:
   ExportString[
     Rasterize[ToExpression["<input>"], ImageSize -> <w>],
     {"Base64", "PNG"}
   ]
   (wrapped in TimeConstrained + error handling)
       │
       ▼
 Kernel returns base64 string (or error)
       │
       ▼
 Provider posts { cmd: 'evalBlockResult', blockId, output: {...} }
       │
       ▼
 Webview updates block.output, re-renders, marks dirty
```

### Evaluation Expression (WL)

```mathematica
Block[{$res, $img},
  $res = TimeConstrained[ToExpression["<input>"], <timeout>];
  If[$res === $Failed || Head[$res] === $Failed,
    (* error *)
    "ERROR:" <> ToString[$MessageList],
    (* success: try to rasterize *)
    $img = Quiet[ExportString[Rasterize[$res, ImageSize -> <width>], {"Base64", "PNG"}]];
    If[StringQ[$img],
      "IMAGE:" <> $img,
      "TEXT:" <> ToString[$res, InputForm]
    ]
  ]
]
```

The result prefix (`IMAGE:`, `TEXT:`, `ERROR:`) lets us parse the response type.

---

## AI Tools

### `wolfslide_insertEvalBlock`

Insert a new eval block with Wolfram input. Optionally auto-evaluate.

**Parameters:**
- `slideIndex` / `slideId` — target slide
- `input` (string, required) — Wolfram Language expression
- `autoEval` (boolean, default true) — evaluate immediately after inserting
- `position`, `x`, `y`, `w`, `h` — placement (same as insertBlock)

### `wolfslide_evalBlock`

Evaluate (or re-evaluate) an existing eval block.

**Parameters:**
- `blockId` (string, required) — the eval block to run
- `input` (string, optional) — new input to set before evaluating. If omitted, uses existing input.
- `slideIndex` / `slideId` — to resolve the block
- `timeoutSeconds` (number, default 30)

**Returns:** Status message including output type and preview.

### Existing tool updates

- `wolfslide_insertBlock` — add `type: "eval"` support with `input` field.
- `wolfslide_editBlock` — allow patching `input` on eval blocks.
- `wolfslide_getSlide` — show eval block input + output status in the ASCII layout.

---

## Use Cases

1. **AI generates a plot**: "Add a slide with a plot of Sin[x]" →
   AI calls `wolfslide_insertEvalBlock` with `input: "Plot[Sin[x], {x, 0, 2Pi}]"` and `autoEval: true`.
   The block appears, evaluates, and shows the plot.

2. **User edits input**: Double-click the eval block → modal opens → edit code → click "Run ▶" → output updates.

3. **AI refines a plot**: AI calls `wolfslide_evalBlock` with updated input → re-evaluates.

4. **Complex graphics**: AI generates ListPlot, BarChart, Graphics3D, etc. — all rasterized to PNG.

5. **Non-graphic output**: Table, matrix, symbolic expression → falls back to text rendering (InputForm).

6. **Presentation**: Output image shown full-size, no code visible.

---

## Implementation Checklist

### Phase 1: Core Infrastructure
- [ ] Add `evalBlock` / `evalBlockResult` message handlers to `slideEditorProvider.js`
- [ ] Implement kernel evaluation helper in provider (with error handling, timeout, busy-check)
- [ ] Add `eval` case to `renderBlock()` in webview
- [ ] Add `eval` case to `buildPresBlock()` in webview
- [ ] CSS for eval block states (has-output, no-output, evaluating, error)
- [ ] Eval Editor modal (textarea + Run + Apply + Cancel)

### Phase 2: AI Tools
- [ ] `WolfslideInsertEvalBlockTool` class + registration
- [ ] `WolfslideEvalBlockTool` class + registration
- [ ] Update `wolfslide_getSlide` to show eval block details
- [ ] package.json tool schemas

### Phase 3: Polish
- [ ] Props panel section for eval blocks (show input preview, Run button)
- [ ] Re-evaluate button in toolbar or context action
- [ ] Handle kernel-not-running gracefully (show message in webview)
