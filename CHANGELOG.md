# Changelog

All notable changes to **Wolfbook** are documented here.

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
