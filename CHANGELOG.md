# Changelog - Extended VSNB Editor

All notable changes to this fork are documented here.

**📚 See also:**
- [DEVELOPMENT_GUIDE.md](DEVELOPMENT_GUIDE.md) - Complete development history and architecture
- [QUICK_REFERENCE.md](QUICK_REFERENCE.md) - Quick reference for developers
- [README.md](README.md) - User-facing documentation

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

## v2.0.0 - XX Nov, 2024

Add themes.

Add VsCode notebook support.

Add auto-completion support.

Add `Start Wolfram in terminal` command.


## v1.8.0 - 10 Oct, 2022

Add `_` to wordSeparators suggestion.

Add links to free Wolfram Engine.


## v1.7.0 - 4 July, 2022

Add light theme

13.1 syntax updates


## v1.6.0 - 12 May, 2022

Update dependencies

Add "Download Wolfram Engine" links to command palette

support new 13.1 syntax `"PackedArray"::["Real64"]`


## v1.5.0 - 7 Mar, 2022

Ensure an empty directory to use as working directory

Properly push subscription from client.start()

Increase timeout to 15 seconds and add timeout_warning_enabled setting

Syntax error for invalid `\|XXXXXX` character syntax

Remove "Open Notebook" from command palette

Rename "Open in Notebook Editor" -> "Open in System Editor"

Various "open" commands are run on different systems, and nothing guarantees opening with the FE

Minimize user confusion by not mentioning "Notebook Editor"

13.0.1 syntax updates

Merge pull request [#9](https://github.com/WolframResearch/vscode-wolfram/issues/9) from LumaKernel/patch-1
Add "Wolfram Language" as language alias for Jupyter Notebook VSCode Integration


### Fixes

Fix leftover "Example configuration" from early days

https://github.com/WolframResearch/vscode-wolfram/issues/5

Fix logic for resolving kernel paths

Should try new versions as well as older versions


## v1.4.0 - 25 Oct, 2021

Remove unused WolframLanguageSyntax files


### Fixes

Fix 415574: unrecognized symbol followed by `[` should have scope `variable.function`

Also recognize `f @ x` syntax for function call, but do NOT recognize `a ~f~ b` or `a // f`


## v1.3.3 - 11 Oct, 2021

If a kernel cannot be started, then do not also show the timeout dialog after 10 seconds, that is just extra noise.

`lsp_server_enabled` setting: Allow selectively disabling Wolfram Language LSP


## v1.3.2 - 27 Sep, 2021

### Fixes
- Fixed problem with dialog saying "Language Server kernel did not initialize properly after 10 seconds."

The kernel actually did start correctly, but the timeout for the dialog was not being handled properly.


## v1.3.1 - 22 Sep, 2021

First release from official Wolfram Research GitHub repo

https://github.com/WolframResearch/vscode-wolfram


## 1.3 - 30 Aug, 2021

Rename publisher to WolframResearch

A change in CMake \~3.20 introduced compiler_depend.ts file in the CMakeFiles directory
So exclude compiler_depend.ts files


## 0.15 - 15 Jan, 2020

Add `(\* \*)` as a kind of bracket


## 0.14 - 28 Oct, 2019

Add ConfidenceLevel setting


## 0.12 - 5 Aug, 2019

Unify the various command settings into a single wolfram.command setting
