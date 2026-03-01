# Changelog

All notable changes to **Wolfbook** are documented here.

---

## [2.0.3] - 2026-03-01

### Added
- **Dynamic widget** — a new `Dynamic[expr]` cell type that displays live-updating output
  while a computation is running.  Place `Dynamic[expr]` on its own line (or mixed with
  static expressions in the same cell); a placeholder badge appears immediately and the
  slot re-renders every ~500 ms by interrupting the kernel into a `Dialog[]` subsession
  and evaluating `expr` there, or via a direct `sub()` call when the kernel is idle.
  - **Busy-path** (kernel computing): sends one `interrupt()`, opens `Dialog[]`, evaluates
    all Dynamic slots sequentially, closes the dialog, renders each result image via the
    render subkernel, then waits 500 ms and repeats.
  - **Idle-path** (nothing queued): evaluates each slot directly via `session.sub()` at
    most once per second, serialised with a per-cell mutex to prevent concurrent `sub()`
    calls on the same WSTP link.
  - Multiple `Dynamic[...]` expressions in one cell all update in the same dialog cycle.
  - Mixed cells (`Dynamic[n]\n1+1\nDynamic[m]`) — static sub-expressions evaluate
    normally; Dynamic slots update live alongside them.

- **`LiveTime -> t` expiry option** — widget loop exits and cell output is cleared after
  `t` wall-clock seconds.  Fires immediately (mid-computation if necessary).

- **`LiveEvaluations -> n` expiry option** — widget loop exits after `n`
  *sub-expression dispatches* to the kernel since the widget started (one Shift+Enter on
  a multi-line cell can count as multiple dispatches).  Expiry fires once the Nth
  sub-expression *finishes* (queue drains), so the computation is never interrupted at
  exactly the limit boundary.

- **`LiveCells -> n` expiry option** — like `LiveEvaluations` but counts *cell-level*
  dispatches (one per Shift+Enter, regardless of how many sub-expressions the cell
  contains).  A separate `_cellEpoch` counter increments once per cell execution.

- **Dynamic early-start** — when `Dynamic[expr]` appears before other sub-expressions in
  the same cell (e.g. `Dynamic[n]\nDo[...]`), the widget loop starts *inline*, before
  the remaining sub-expressions run.  Output slot is updated in-place via the owned
  `NotebookCellExecution`'s `replaceOutputItems()` while the cell is still executing,
  then switches to `createNotebookCellExecution` after `execution.end()`.  Enables
  fully live updates during a long computation started in the same cell.

- **Render subkernel prewarm** — when the first `Dynamic[...]` cell is registered, a
  second kernel process is launched in the background immediately (`_prewarmSubKernel`).
  By the time the first Dialog render is needed, `init.wl` is already loaded and the
  subkernel responds instantly instead of paying a ~1–2 s cold-start penalty.

- **`NotebookDirectory[]` auto-set on kernel start** — at the end of `launchKernel`,
  the extension locates the active wolfram notebook editor, extracts its directory, and
  evaluates:
  ```mathematica
  Unprotect[NotebookDirectory];
  NotebookDirectory[] = "/path/to/notebook/dir";
  Protect[NotebookDirectory];
  ```
  This makes `Get["data.m"]`, `Import["results.csv"]`, etc. resolve relative to the
  notebook file automatically, matching the behaviour of the Wolfram Desktop.

### Fixed
- **`LiveEvaluations` WSTP corruption bug** — when `LiveEvaluations->N` was set and the
  Nth sub-expression was still running (`busy=true`), the widget loop entered the
  interrupt path and sent `interrupt()` mid-`Dialog[]`.  This caused `dialogEval` to
  time out after 8 s, `exitDialog` to fail three times, and the WSTP link to corrupt —
  the cell would hang forever.  **Fix:** the busy-path interrupt is now skipped entirely
  when `_evalsSinceStart >= liveEvalLimit`; the `!busy` expiry check fires cleanly once
  the computation completes.

- **`LiveEvaluations` epoch semantics** — `_dispatchEpoch` now increments per
  *sub-expression* (just before each `session.evaluate(subExpr)`) rather than once per
  cell.  The previous per-cell increment meant a multi-line cell counted as 1 dispatch
  regardless of how many sub-expressions it contained.

- **Input cell height truncation** — the scroll-suppression code briefly set
  `inputCollapsed: true` on the next cell before `execution.end()`, then restored `{}`
  20 ms later.  VS Code used the collapsed state to measure the Monaco editor height and
  cached the wrong 2-line value — the cell appeared permanently truncated until manually
  collapsed and uncollapsed.  **Fix:** only `outputCollapsed: true` is set; the Monaco
  editor is never touched.

- **Output cell height after font load** — on first open of a saved notebook, MathML
  web-fonts are not yet cached; VS Code measures output iframe height with fallback
  metrics and caches a too-short value.  **Fix:** a sentinel `<div>` is appended and
  immediately removed inside `fonts.ready.then(...)` (or a 300 ms fallback) to trigger
  a height re-measurement after fonts are available.

- **Cell background colours preserved when kernel goes offline** — the `_applyKernelOfflineUI`
  / `_clearKernelOfflineUI` methods now also desaturate / restore the
  `workbench.colorCustomizations` notebook keys (`notebook.cellEditorBackground`,
  `notebook.editorBackground`, etc.).  Previously the output webview turned grayscale but
  the cell editor backgrounds kept their original colours (e.g. light green), creating a
  visual mismatch.  The conversion uses luminance weighting
  ($0.299R + 0.587G + 0.114B$) so perceived brightness is preserved.

---

## [2.0.2] - 2026-02-28

### Fixed
- **Dialog cleanup — no more hanging promises**: A new `closeAllDialogs()` method on
  `WstpSession` atomically drains the internal dialog queue, immediately rejecting every
  pending `dialogEval()` / `exitDialog()` promise. Previously these could hang forever
  after an abort or when `isDialogOpen` was stale (drain loop exited but flag not cleared).
- **`abort()` clears dialog state**: `abort()` now calls `closeAllDialogs()` internally,
  so the JS-side `isDialogOpen` flag and all pending dialog promises are cleaned up
  atomically with sending `WSAbortMessage`.
- **`exitDialog()` stale-state guard**: If `isDialogOpen=true` but the evaluation loop
  has already exited (`busy=false`), `exitDialog()` now resolves immediately and resets
  the flag instead of enqueuing a request nobody would ever service.
- **Recovery paths simplified**: All `try { exitDialog() } catch(_) {}` workarounds in
  the extension's dynamic widget loops replaced with the reliable `closeAllDialogs()`
  call.

---

## [2.0.0] - 2026-02-22

### Highlights (Wolfbook release)

- **Rebranded to Wolfbook** — publisher `wolfbook.wolfbook`, new README and LICENSE (Nikolay Gromov)
- **GitHub** — source published at https://github.com/vanbaalon/wolfbook
- **Cell status bar hidden** — built-in execution count below cells removed (`Out[N]=` already provides this)
- **Wrap button right-aligned** — Wrap toggle is now flush-right on the output header row
- **Silent abort and restart** — no VS Code notifications or Output panel messages on abort/restart
- **Race condition fix** — silent recovery from `Cannot modify cell output after calling resolve` error
- **Improved diagnostic filter** — LSP warnings for Unicode chars, `unexpected expression at top level`, and `Suspicious use of session symbol` are suppressed

---

## [1.1.3] - 2026-02-18

### Added
- **Kernel not ready warning**: If you evaluate a cell before the kernel has finished starting, a clear red warning is shown instead of a silent failure.
- **Wrap toggle button**: MathML outputs have a small "⤓ Wrap" button in the top-right corner to toggle between horizontal scrolling and line-wrapping for wide expressions.

### Improved
- **Graphics and Plot rendering**: Graphics outputs (Plot, Plot3D, etc.) now render as crisp SVG vector images. If SVG export fails, a compact PNG fallback is used.
- **Graphics no longer show "Output Truncated"**: Plot and other graphics outputs are always shown in full — the truncation warning only appears for large symbolic/numeric outputs.
- **Large output truncation for multi-output cells**: When a cell produces several outputs and some are large (e.g. `Range[600]; Range[100]`), each output is independently truncated and expanded correctly.
- **Expand button targets the right output**: Clicking "Expand" on a truncated output in a multi-output cell now replaces only that specific output, not the first one.

### Fixed
- **Evaluations no longer hang on large graphics**: Evaluating cells with complex plots no longer causes the kernel to hang indefinitely.
- **Range[601] and similar large outputs complete correctly**: Previously, very large list outputs could cause the kernel message loop to stall — this is now resolved.

---

## [1.1.2] - 2026-02-17

### Added
- **Output Truncation System**: Large outputs (>10KB ByteCount) automatically truncated
  - Uses `Short[expr, 5]` for truncated preview
  - Full expression stored in `$fullOutputStore` Association
  - Orange warning box indicates truncation
  - "Expand Truncated Output" toolbar button to show full output
  - ZMQ protocol: `expand-output` request → `show-full-output` response
- **Enhanced Debug Logging**: Comprehensive logging in init.wl and controller.js
  - **Log location changed to `~/wolfram-kernel-debug.log`** for easy access
  - Consistent location across kernel restarts
  - Timestamps in HH:MM:SS format

### Changed
- **Output Size Limit**: Reduced from 100KB to 10KB for testing (configurable via `outputSizeLimit`)
- **ByteCount Detection**: Switched from LeafCount to ByteCount for accurate size measurement
- **$Line/In/Out Protection**: Now unprotected once at startup instead of every evaluation
  - Eliminates protection messages entirely
  - Cleaner code without Off/On cycles

### Fixed
- **$Line Protection Messages**: Completely resolved by unprotecting at startup
- **Log File Location**: Changed from temp directory to `~/wolfram-kernel-debug.log`
  - No more spaces in filename
  - Easy to find and tail
  - Consistent location

**Technical Details:**
- Files: init.wl (40-60: logging setup, 88-91: unprotect at startup, 758-773: simplified evaluation)
- New Config: `outputSizeLimit` in KB
- New Storage: `$fullOutputStore[UUID]`
- New Messages: `expand-output`, `show-full-output`
- Log Path: `$logPath = ~/wolfram-kernel-debug.log`

---

## [1.1.1] - 2026-02-15

### Added
- **Syntax Error Highlighting**: Visual highlighting with pulsing animation at error positions
  - Parses "Syntax error at character N" messages
  - Creates VS Code diagnostic decorations with pulsing red background
  - Auto-clears on cell edit
- **Clear Cell Output**: Manual toolbar button to clear current cell output
- **Enhanced Toolbar**: New buttons for output management

### Fixed
- **Restart Override**: Restart now properly overrides abort state (no more "still sending abort")
- **Empty Output Clearing**: Auto-clear properly removes empty outputs

**Technical Details:**
- Files: controller.js (decorations), extension.js (commands), package.json (toolbar)
- Decoration: `backgroundColor: rgba(255, 0, 0, 0.3)` with CSS pulsing
- Pattern: `/Syntax error at character (\d+)/`

---

## v1.1.0 - 17 Feb, 2026 (Unofficial Fork)

**IMPORTANT**: This is an unofficial fork of the original Wolfram VSCode extension.

### Major Enhancements

- **Output Format Controls**: UI for selecting output format (Image/HTML/MathML/InputForm)
  - Per-notebook setting with toolbar picker
  - Config properly passed to kernel
- **Notebook Color Customization**: 3-color harmonious background scheme picker
  - Main background, heading background, output background
  - Stored in notebook metadata
- **Auto-clear Empty Outputs**: Automatically removes empty output cells after evaluation
- **MathML/SVG Rendering Pipeline**: Automatic detection and rendering of Graphics/Plot objects as SVG, all other expressions as MathML with 50% larger font for better readability
- **Improved Numeric Display**: Real numbers (including scientific notation like 10^-16) now render beautifully in MathML instead of plain text
- **Enhanced Output Quality**: All outputs use proper mathematical typesetting via MathML, dramatically improving readability

### Fixed
- **Config Not Reaching Kernel**: outputFormat now properly sent via `getKernelRelatedConfigs()`
- **Render Function**: Fixed `renderWrapper` to handle different format types

### Technical Details

- Graphics detection at depth {0,1} ensures `Legended[Graphics[...]]` renders as SVG while `x * Graphics[...]` renders as MathML
- SVG export with validation (>100 bytes) and automatic MathML fallback
- Error handling for $Failed and Failure expressions
- All kernel communication uses Association serialized to JSON
- Files Modified: init.wl (config, rendering), controller.js (config passing), extension.js (UI), package.json (settings)

---

## Upstream history (wolframresearch.wolfram)

Wolfbook is forked from `wolframresearch.wolfram` v2.0.1. Upstream changes prior to the fork
(VS Code notebook support, themes, auto-completion, syntax updates through 2019-2024)
are available in the upstream repository: https://github.com/WolframResearch/vscode-wolfram
