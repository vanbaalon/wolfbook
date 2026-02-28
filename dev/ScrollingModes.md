# Wolfbook — Evaluation Scroll Modes

Design document for the two-mode post-evaluation scroll and focus behaviour.

---

## Motivation

There are two fundamentally different workflows when evaluating notebook cells:

**A. Exploring / advancing** — the user is running a sequence of cells top-to-bottom. After each evaluation they want to see the output and then move on to the next cell.

**B. Refining / iterating** — the user is tweaking a single cell and re-running it many times. They do not want the view to jump around or lose cursor focus on the cell they are editing.

The old single-mode scroll (always scroll to output, always advance to next cell) is wrong for workflow B. The new system detects which workflow is active and behaves accordingly — with a manual override toggle when the auto-detection guess is incorrect.

---

## The two modes

### Mode A — Advance

**Trigger (auto-detect):** the cell source is identical to what was last evaluated (unchanged cell).

**Behaviour after evaluation:**
1. VS Code's built-in selection advance (current cell → next code cell, skipping Markdown) is **allowed** to stand.
2. After the first output token arrives, the view scrolls to align the TOP of the evaluated cell's output at the top of the viewport (`NotebookEditorRevealType.AtTop`, deferred by `SCROLL_DELAY_MS` to let the webview finish layout).
3. Focus is now on the next input cell — ready for the user to write or run the next cell.

This matches the classic Jupyter Shift+Enter flow.

---

### Mode B — Refine

**Trigger (auto-detect):** the cell source has been **modified** since its last evaluation (the user edited it and re-ran it).

**Behaviour after evaluation:**
1. VS Code's selection advance is **cancelled** — the selection is returned to the evaluated cell synchronously (same tick as `execute()`).
2. The cell editor is re-entered (edit mode re-activated) 50 ms after the advance is cancelled, using `notebook.focusPreviousCell` + `notebook.cell.edit`.
3. **No scroll** at all — neither the counter-scroll (`_counterScrollNow`) nor the deferred output scroll (`_scrollToOutputCell`) changes the viewport position.
4. The view stays exactly where it was. The output area updates in-place below the cell.

---

## Manual override toggle

In addition to auto-detection, the user can force one of three override modes:

| Override | Context key value | Meaning |
|---|---|---|
| **Auto** | `wolframEvalMode == 'auto'` | Use auto-detection (default) |
| **Advance** | `wolframEvalMode == 'advance'` | Always Mode A regardless of cell changes |
| **Refine** | `wolframEvalMode == 'refine'` | Always Mode B regardless of cell changes |

The override cycles **Auto → Advance → Refine → Auto** each time the toolbar button or status bar item is clicked.

---

## UI indicator

Two places display the active mode:

### Notebook toolbar button

Three mutually exclusive toolbar entries with `when` clauses on `wolframEvalMode`:

| Active override | Button shown | Icon | Tooltip (click to advance to next override) |
|---|---|---|---|
| `auto` | `$(symbol-misc) Auto` | ○◑ | "Auto-detect mode — click to force Advance" |
| `advance` | `$(arrow-down) Advance` | ↓ | "Always advance after eval — click to force Refine" |
| `refine` | `$(sync) Refine` | ⟳ | "Always stay on cell for refinement — click to reset to Auto" |

### Status bar item

A persistent status bar item (right side, priority 99) shows the same label and responds to click with the same cycle command. It is always visible when a Wolfram notebook is open.

---

## Auto-detection data structure

`controller._cellLastSource: Map<cellUri: string, source: string>`

- Key: `cell.document.uri.toString()` — stable across kernel restarts.
- Value: the exact source string that was last evaluated.
- Populated: at the **start** of `checkoutExecutionQueue()` for each cell, just before kernel evaluation begins.
- A cell with **no entry** (never evaluated) is treated as Mode A (first run = advance).

### Detection logic in `execute()` (single-cell keyboard executions only):

```js
const currentSrc   = cells[0].document.getText();
const cellUri      = cells[0].document.uri.toString();
const lastSrc      = this._cellLastSource.get(cellUri);
const autoDetected = (lastSrc !== undefined && lastSrc !== currentSrc) ? 'refine' : 'advance';
const effective    = (this._evalModeOverride !== 'auto') ? this._evalModeOverride : autoDetected;
```

Multi-cell runs (Run All, programmatic) always use Mode A.

---

## Implementation checklist

- [x] `controller._cellLastSource = new Map()` — added in constructor
- [x] `controller._evalModeOverride = 'auto'` — added in constructor, initialised from `wolfram.evalMode` setting
- [x] `controller._pendingScrollMode = null | 'advance' | 'refine'` — added alongside `_pendingScrollCellIndex`
- [x] `controller._evalModeStatusBar` — status bar item created in constructor
- [x] `markKeyboardExecution(cell, mode)` — now accepts mode parameter
- [x] `execute()` — determines mode, calls `markKeyboardExecution` with mode, for Refine mode schedules refocus
- [x] `checkoutExecutionQueue()` — gates `_scrollToOutputCell` on `_pendingScrollMode === 'advance'`; stores source in `_cellLastSource`
- [x] `setEvalMode(mode)` — updates `_evalModeOverride`, `setContext`, status bar
- [x] `package.json` — commands `wolfram.evalMode.auto/advance/refine`, toolbar + status bar entries, `wolfram.evalMode` setting
- [x] `extension.js` — registers the three commands

---

## Known limitations / open questions

- **Refine mode refocus**: re-entering edit mode relies on `notebook.focusPreviousCell` + `notebook.cell.edit`. This is brittle because it assumes the selection was advanced by exactly 1 cell. On the last cell of the notebook (diff=0 case) no `focusPreviousCell` is needed, only `notebook.cell.edit`. The implementation guards for this.
- **Multi-cell run**: batch runs (Run All) are always Mode A — scrolling is already suppressed for batch runs by the existing `cells.length > 1` guard.
- **_cellLastSource GC**: entries accumulate until the notebook is closed. This is acceptable — the map is bounded by the number of cells in open notebooks and holds only strings.
- **Setting persistence**: `wolfram.evalMode` is a workspace setting, so override preference persists across sessions. The `_evalModeOverride` field is initialised from this setting on startup.
