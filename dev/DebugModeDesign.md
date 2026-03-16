# Wolfbook Debug Mode — Current Design

## Overview

The Wolfbook debugger lets users step through Wolfram Language notebook cells statement by statement. It works by **instrumenting** the cell source before sending it to the kernel, causing the kernel to pause at `Dialog[]` subsessions between statements. The VS Code extension communicates with the paused kernel over WSTP to query state, apply decorations, and issue step commands.

No breakpoint file, launch configuration, or DAP protocol is involved. The entire debugger is custom-built on top of the Wolfram `Dialog[]` mechanism.

---

## File Layout

```
out/extension/debugger/
  codeTransformer.js    — transforms cell source into instrumented WL code
  kernelDebugInit.wl    — WL state variables and functions loaded before each session
  debugController.js    — orchestrates the full session: timing, decorations, UI
  breakpointManager.js  — stores breakpoint lines, renders red gutter dots
  watchPanel.js         — WebviewViewProvider: HTML shell, extension↔webview messaging
  watchPanel.webview.js — webview-side JS (CSP-safe external script)
media/
  breakpoint.svg        — red dot gutter icon for breakpoints
```

---

## 1. Code Transformer (`codeTransformer.js`)

### Purpose
Converts a cell's raw source code into instrumented WL code with `wolfbookDebug$BeforeStep` and `wolfbookDebug$Timed` wrappers around every statement.

### Modes

**Full-cell mode (default):** The entire cell is treated as a depth-0 body. Every top-level statement (split by `;` at bracket depth 0, and also by bare newlines that terminate a complete expression) becomes a step at depth 0. If a statement is a loop (`Do`, `For`, `While`, `Table`), the transformer recurses into its body at depth 1.

**Loop-only mode (legacy):** Pass `{ loopOnly: true }`. Finds the first outermost loop and instruments only its body at depth 1. Pre/post-loop statements are left as-is.

### Step splitting

Statements are split by:
- `;` at bracket depth 0 (standard WL compound expression separator)
- Bare newlines at bracket depth 0 **when** the preceding non-whitespace character ends a complete expression (`]`, `)`, `}`, word char, `"`, `_`)

This handles cells like:
```wolfram
x = 1
y = x + 1
Do[..., {i, 5}]
```

### Instrumented output example

Input:
```wolfram
T = 1;
Do[
    Print[i];
    x = i^2;
, {i, 1, 10}]
```

Output:
```wolfram
wolfbookDebug$BeforeStep[0, 1, <||>];
wolfbookDebug$Timed[0, 1, (T = 1)];
wolfbookDebug$BeforeStep[0, 2, <||>];
wolfbookDebug$Timed[0, 2, (Do[
    wolfbookDebug$BeforeStep[1, 1, <|"i"->i|>];
    wolfbookDebug$Timed[1, 1, (Print[i])];
    wolfbookDebug$BeforeStep[1, 2, <|"i"->i|>];
    wolfbookDebug$Timed[1, 2, (x = i^2)];
, {i, 1, 10}])]
```

### Step metadata

For each statement, the transformer records:

| Field | Type | Description |
|---|---|---|
| `depth` | int | 0 = top-level, 1 = first loop body, etc. |
| `localStep` | int | 1-based step index within this depth |
| `startLine`, `startChar` | int | Character-precise source start offset |
| `endLine`, `endChar` | int | Character-precise source end offset |
| `containsInnerLoop` | bool | Whether this statement wraps a loop |
| `isLoop` | bool | Whether this is a loop statement at depth 0 |
| `iterVarNames` | string[] | Iterator variable names from enclosing loops |

The full result object returned by `transformCode()`:

```js
{
  instrumentedCode,   // string: WL code ready to send to kernel
  steps,              // Step[] metadata (see above)
  maxDepth,           // deepest depth found
  hasLoop,            // whether any loop bodies were instrumented
  loopHead,           // e.g. "Do" or null
  loopVarName,        // iterator variable name or null
  breakpointMap,      // { lineNum: { depth, localStep } }
}
```

### Loop detection

`findOutermostLoop()` does a character-level scan (skipping strings and `(* *)` comments) looking for `Do`, `For`, `While`, `Table` followed by `[`. It uses bracket counting to find the matching `]`. Loop iterator variables are extracted from:
- `Do[body, {i, ...}]` → `i`
- `Table[body, {i, ...}]` → `i`
- `For[i=1, ..., ..., body]` → `i` (from the init expression)
- `While[cond, body]` → none

---

## 2. Kernel Debug Init (`kernelDebugInit.wl`)

Loaded via `Get["...kernelDebugInit.wl"]` before each debug session. Defines all `wolfbookDebug$*` symbols.

### State variables

| Variable | Type | Purpose |
|---|---|---|
| `wolfbookDebug$Active` | Bool | Whether a session is active |
| `wolfbookDebug$StepMode` | Bool | Whether stepping is enabled |
| `wolfbookDebug$TargetDepth` | Int/Infinity | Max depth that causes pauses |
| `wolfbookDebug$CurrentDepth` | Int | Depth of the next `BeforeStep` call |
| `wolfbookDebug$CurrentStep` | Int | localStep of the next `BeforeStep` call |
| `wolfbookDebug$CurrentIterVars` | Association | `<\|"i"->3, "j"->2\|>` current iterator values |
| `wolfbookDebug$WatchList` | List | `{"x", "T", ...}` user-added watch variables |
| `wolfbookDebug$Breakpoints` | List | `{{depth, step}, ...}` registered breakpoints |
| `wolfbookDebug$StepTimings` | Association | `<\| {depth,step} -> seconds, ...\|>` |
| `wolfbookDebug$LastCompletedDepth` | Int | Depth of the step that just finished |
| `wolfbookDebug$LastCompletedStep` | Int | LocalStep of the step that just finished |

### Core functions

**`wolfbookDebug$BeforeStep[depth, localStep, iterVarValues]`**
Called before each statement. Updates `CurrentDepth/Step/IterVars`. Checks if this step is a registered breakpoint. Calls `Dialog[]` (which pauses execution) if:
- `StepMode && depth <= TargetDepth`, OR
- this `{depth, localStep}` is in `Breakpoints`

If a breakpoint is hit while in Continue mode, step mode is re-enabled so the user can step from there.

**`wolfbookDebug$Timed[depth, localStep, expr]`** — `HoldRest`
Wraps `expr` in `AbsoluteTiming`. Stores the result in `StepTimings`. Updates `LastCompletedDepth/Step`. Returns the original expression result.

**`wolfbookDebug$GetStepInfo[]`**
Returns an Association with current position, iterator values, and the timing of the **last completed** step (not `currentStep - 1` — uses `LastCompleted*` to correctly handle the last step of a loop iteration crossing back to step 1):

```wolfram
<|
  "depth"           -> ...,
  "step"            -> ...,
  "targetDepth"     -> ...,
  "iterVarValues"   -> <|...|>,
  "prevTiming"      -> ...,
  "prevTimingDepth" -> ...,
  "prevTimingStep"  -> ...
|>
```

**`wolfbookDebug$GetWatchValues[]`**
Returns `<| "varName" -> <|"short" -> "...", "full" -> "..."|>, ...|>` for all variables in `WatchList`. Uses `ToExpression` → `ToString[..., OutputForm/InputForm]`.

**`wolfbookDebug$GetAllTimings[]`** → `wolfbookDebug$StepTimings`

### Step commands (evaluated in the Dialog subsession)

| Command | Effect |
|---|---|
| `wolfbookDebug$StepOver[]` | `TargetDepth = CurrentDepth` — skip deeper |
| `wolfbookDebug$StepInto[]` | `TargetDepth = Infinity` — pause at everything |
| `wolfbookDebug$StepOut[]` | `TargetDepth = CurrentDepth - 1` — finish this level |
| `wolfbookDebug$Continue[]` | `StepMode = False` — run to next breakpoint |
| `wolfbookDebug$RunToEnd[]` | `StepMode = False; Breakpoints = {}` |

**`wolfbookDebug$Cleanup[]`** — called after session ends. Sets `Active = False`, clears `LastCompleted*` and all timings.

---

## 3. Debug Controller (`debugController.js`)

### Class: `DebugController`

Constructor receives:
- `getController` — `() => WolframNotebookKernel` lambda (avoids circular dep)
- `breakpointMgr` — `BreakpointManager` instance
- `watchPanel` — `WatchPanelProvider` instance

### Session state fields

| Field | Purpose |
|---|---|
| `_active` | Whether a session is running |
| `_cell` | The `vscode.NotebookCell` being debugged |
| `_xfm` | `transformCode()` result |
| `_evalPromise` | The `session.evaluate()` promise for the instrumented code |
| `_releaseMutex` | Releases `_dynDialogMutex` on session end |
| `_lastStepInfo` | `{ depth, localStep, iterVars }` from last `_onDialogBegin` |
| `_cellEditor` | Cached `TextEditor` reference saved at session start |
| `_debugExecution` | `NotebookCellExecution` for live Print/output capture |
| `_debugPrintHtml` | Accumulated HTML for current print block |
| `_debugPrintOut` | Current `NotebookCellOutput` object for print |
| `_restartPending` | Debounce flag for cell-edit restart |
| `_timingMap` | `Map<"depth:step", seconds>` — persists after session |
| `_timingCellUri` | URI of the timed cell (for clearing on edit) |

### Decoration types (created once, reused)

| Field | Appearance | Purpose |
|---|---|---|
| `_stepHighlight` | `editor.stackFrameHighlightBackground` on character range | Current step yellow highlight |
| `_timingDeco` | Italic `editorCodeLens.foreground` text after expression | `⏱ 1.23 ms` at end of line |
| `_pendingDeco` | `⏳` after expression in `editorCodeLens.foreground` | Shows while kernel is evaluating |

### `startDebugCell(cell)` flow

1. **Guard checks** — bail if already active, no session, wrong cell kind, empty cell
2. **`transformCode()`** — get instrumented code + step metadata, including breakpoints
3. **Save state** — set `_active = true`, cache `_cellEditor` from `visibleTextEditors`, create `NotebookCellExecution`
4. **Close stale Dialog** — if a previous crashed session left a dialog open, exit it
5. **`Get["kernelDebugInit.wl"]`** — load/reset kernel-side state
6. **Push watch list + breakpoints** — set `wolfbookDebug$WatchList` and `wolfbookDebug$Breakpoints`
7. **Acquire `_dynDialogMutex`** — prevents Dynamic poll loops from racing the debug evaluation
8. **`session.evaluate(instrumentedCode, { onDialogBegin, onPrint, onMessage })`** — fire asynchronously; `.then()` → `_finishDebug(false)`, `.catch()` → `_finishDebug(true, err)`

### `session.evaluate()` callbacks wired at session start

- **`onDialogBegin`** → calls `_onDialogBegin()` — queries state, updates all UI
- **`onPrint(line)`** — appends to `_debugPrintOut` / creates it via `appendOutput`. Output appears live in the cell's output area. `\012` → `\n` decoding applied.
- **`onMessage(msg)`** — appends a red styled HTML box (`color:#f44`) to cell output. Resets the print block.

### `_onDialogBegin()` — per-pause handler

Called every time the kernel pauses at `Dialog[]`. Sequence:

1. **`GetStepInfo[]`** via `dialogEval` — gets depth, step, iterVars, lastCompleted timing
2. **`GetWatchValues[]`** via `dialogEval` — gets current values of watched variables
3. **`GetAllTimings[]`** via `dialogEval` — pulls all timings accumulated since last pause (covers Continue jumping over many steps)
4. Record the last-completed step's timing in `_timingMap`
5. Merge all timings from `GetAllTimings[]` into `_timingMap`
6. **`_clearPendingDeco()`** — remove `⏳` from previous step
7. **`_applyStepHighlight(depth, localStep)`** — yellow highlight on current step's character range
8. **`_applyTimingDecorations()`** — re-render all `⏱` decorations for every step with a known timing
9. Update `_watchPanel` with step info + variables + last timing

### Step command dispatch

`stepOver()`, `stepInto()`, `stepOut()`, `continueRun()`, `runToEnd()` all call `_sendStep(wlCommand)`:

1. Show `⏳` on the step about to run (`_applyPendingDeco`)
2. `dialogEval(command)` — sets kernel-side step mode variables
3. `exitDialog()` — releases the Dialog, kernel resumes
4. `_clearStepHighlight()` — remove yellow highlight immediately

### `_finishDebug(isError, err)` flow

Guards with `if (!this._active) return` (double-call safe). Captures `finishedCell` and `wasStopping` **before** `_cleanup()` nulls them.

1. **`_debugExecution.end()`** — stop cell spinner, make output permanent
2. **`GetAllTimings[]`** via normal `session.evaluate` — final timing snapshot (always attempted, errors swallowed — covers the last step which has no subsequent `BeforeStep`)
3. Merge all timings into `_timingMap`
4. `_applyTimingDecorations()`
5. **`wolfbookDebug$Cleanup[]`** — kernel-side cleanup
6. `_clearStepHighlight()`, `_clearPendingDeco()`
7. Final `_applyTimingDecorations()`
8. `_cleanup()` — reset all session state, release mutex
9. Schedule `refreshLiveWatch()` after 400 ms
10. If `!isError && !wasStopping` → `_advanceToNextCell(finishedCell)`

### `stop()` — bullet-proof shutdown

1. Guard: `if (!this._active) return` — idempotent.
2. Sets `_stopping = true` to suppress auto-advance.
3. If `session.isDialogOpen`: sends `wolfbookDebug$Active=False;wolfbookDebug$StepMode=False` via `dialogEval` (prevents `BeforeStep` from re-pausing), then calls `exitDialog()` to unblock the kernel thread.
4. Calls `ctrl.abortEvaluation()` (try/catch).
5. 3-second fallback `setTimeout` calls `_finishDebug(true)` if `_active` is still true — handles rare cases where the evaluation promise never settles after abort.

### Auto-advance to next code cell

After a clean completion (`!isError && !wasStopping`), `_advanceToNextCell(completedCell)` is called:
1. Iterates notebook cells after `completedCell.index` to find the first `NotebookCellKind.Code` cell.
2. Calls `nbEditor.revealRange(...)` with `InCenterIfOutsideViewport` so the cell's text editor is in `visibleTextEditors`.
3. After 300 ms, calls `startDebugCell(nextCell)`.

The `_stopping` flag (set by `stop()`, cleared by `_cleanup()`) prevents auto-advance when the user explicitly stops.

### Cell edit → restart

`vscode.workspace.onDidChangeTextDocument` fires when the debugged cell is edited. Response:
- `abortEvaluation()` is called immediately
- `_finishDebug` fires via promise rejection
- After 400 ms: `showInformationMessage("Restart debug session?", "Restart")` button triggers `startDebugCell(cell)` with the new code

### Timing decoration format

`formatTiming(sec)`:
- `< 1 μs` → `123 ns`
- `< 1 ms` → `456.7 μs`
- `< 1 s`  → `12.34 ms`
- `≥ 1 s`  → `3.456 s`

Displayed as `  ⏱ 12.34 ms` in italic `editorCodeLens.foreground` at a **zero-width range** at `(step.endLine, step.endChar)` — so each statement on the same line gets its own annotation at its own end position, not piled at the line end.

### Stop debug on Shift+Enter

When `wolfram.executeCell` fires (Shift+Enter), if `_debugCtrl.isActive`, `stop()` is called before `controller.execute()`.

### Auto-advance to next code cell

When a debug session completes cleanly (`_finishDebug(false)` and `_stopping` is `false`), `_advanceToNextCell(completedCell)` is called:
1. Iterates `completedCell.notebook.cellAt(i)` for `i > completedCell.index` to find the next `NotebookCellKind.Code` cell.
2. Calls `nbEditor.revealRange(...)` with `InCenterIfOutsideViewport` to ensure the cell's text editor will be in `visibleTextEditors` when the new session starts.
3. After 300 ms (render delay), calls `startDebugCell(nextCell)`.

If the user explicitly calls `stop()`, `_stopping = true` is set and `_advanceToNextCell` is suppressed even if the evaluation happens to finish cleanly.

---

## 4. Breakpoint Manager (`breakpointManager.js`)

### Storage

`Map<uri: string, Set<number>>` — URI of the cell's text document → set of 0-based line numbers.

### Gutter decoration

Uses `vscode.window.createTextEditorDecorationType` with:
- `gutterIconPath` → `media/breakpoint.svg` (red circle)
- `gutterIconSize: 'contain'`
- `borderWidth: '0 0 0 3px'`, `borderStyle: 'solid'`, `borderColor: debugIcon.breakpointForeground` — red left border as fallback if gutter icon layout is narrow

Decorations are re-applied on `onDidChangeActiveTextEditor` and `onDidChangeVisibleTextEditors`.

### API

| Method | Description |
|---|---|
| `toggleBreakpoint(editor)` | Toggle bp on current cursor line |
| `addBreakpointAt(uri, line)` | Add bp at specific URI + 0-based line (idempotent) |
| `hasBreakpointAt(uri, line)` | Return true if bp exists at URI + line |
| `getBreakpointsForCell(cell)` | Returns `Set<number>` for a cell |
| `clearBreakpoints(cell)` | Remove all bps for one cell |
| `removeBreakpointLine(uri, line)` | Remove one specific line |
| `clearAllBreakpoints()` | Remove all bps everywhere |
| `getAllBreakpoints()` | Returns `[{uri, cellLabel, lines}]` |
| `setOnChange(fn)` | Register callback fired on any bp change |

### Gutter click interception

VS Code fires `editor.debug.action.toggleBreakpoint` on gutter clicks, which adds a standard `SourceBreakpoint`. `vscode.debug.onDidChangeBreakpoints` in `extension.js` intercepts all `added` events:
- If `bp.location.uri.scheme === 'vscode-notebook-cell'`: toggle in `_bpMgr` (add if missing, remove if present), then immediately remove the VS Code bp via `vscode.debug.removeBreakpoints([bp])`.
- A `_guarded` Set (keyed by `"uri:line"`, expires after 300 ms) prevents the `removed` event (from our own `removeBreakpoints` call) from being processed again.
- `removed` events from external sources (VS Code Breakpoints panel) are mirrored into `_bpMgr`.

The `setOnChange` callback is wired in `DebugController` to call `watchPanel.updateBreakpoints(bpMgr.getAllBreakpoints())` whenever breakpoints change, keeping the Watch Panel in sync.

---

## 5. Watch Panel (`watchPanel.js` + `watchPanel.webview.js`)

### Provider: `WatchPanelProvider`

Implements `vscode.WebviewViewProvider`. View ID: `wolfbook.watchPanel`. Registered with `retainContextWhenHidden: true`.

The HTML shell is built dynamically in `_buildHtml()`. The webview JS is loaded as an **external script** via `webview.asWebviewUri()` (required for CSP — `'unsafe-inline'` is silently blocked in modern VS Code webviews). CSP uses `webview.cspSource` for `script-src`.

### Sections in the watch panel

**Step header** — shows current step as `depth=0 step=2` and the last timing (`⏱ 1.23 ms`).

**Variable table** — two columns: Name / Value. Iterator variables shown first (not removable), then user-added watch variables (removable with `×` button).

**Debug controls** — Step Over / Step Into / Step Out / Continue / Run to End / Stop buttons, visible only when `wolfbook.debugActive` is set.

**Add watch** — text input + Add button; Enter key also submits.

**Breakpoints section** — lists all registered breakpoints as `cellLabel:lineNumber` rows with `×` remove buttons and a "Clear all" button.

**Log tail** — last 50 lines of internal debug log (extension↔kernel communication events). Scrolled to bottom on each update.

### Extension → Webview messages

| Command | Payload | Effect |
|---|---|---|
| `update` | `{ stepInfo, variables, timing }` | Update header + variable table |
| `liveUpdate` | `{ variables }` | Update variable table in live mode |
| `clear` | — | Reset to live watch mode, clear table |
| `setDebugActive` | `{ active: bool }` | Show/hide debug control buttons |
| `updateBreakpoints` | `{ breakpoints: [{uri, cellLabel, lines}] }` | Render bp list |
| `log` | `{ text: string }` | Append to log tail |

### Webview → Extension messages

| Command | Payload | Effect |
|---|---|---|
| `addWatch` | `{ name }` | Add variable to watch list |
| `removeWatch` | `{ name }` | Remove variable from watch list |
| `refresh` | — | Trigger `refreshLiveWatch()` |
| `debugCommand` | `{ action }` | Fire step/continue/stop command |
| `removeBreakpoint` | `{ uri, line }` | Remove one bp via `bpMgr.removeBreakpointLine` |
| `clearBreakpoints` | — | Call `bpMgr.clearAllBreakpoints()` |
| `scriptLoaded` | — | Handshake: webview JS loaded successfully |

### State restoration

When the panel becomes visible (re-shown after hidden), `_sendCurrentState()` is called:
- Sends `setDebugActive`
- Triggers `onRefresh` (live watch update)
- Resends `_lastBpList` if non-empty

---

## 6. Extension Wiring (`extension.js`)

```
_bpMgr       = new BreakpointManager(context)
_watchPanel  = new WatchPanelProvider()
_debugCtrl   = new DebugController(() => controller, _bpMgr, _watchPanel)
```

Registered commands:

| Command | Key | Action |
|---|---|---|
| `wolfbook.debug.debugCell` | Cmd+Shift+D | `startDebugCell(focusedCell)` |
| `wolfbook.debug.stepOver` | F10 | `stepOver()` |
| `wolfbook.debug.stepInto` | F11 | `stepInto()` |
| `wolfbook.debug.stepOut` | Shift+F11 | `stepOut()` |
| `wolfbook.debug.continueToBreakpoint` | F5 | `continueRun()` |
| `wolfbook.debug.continueToEnd` | Ctrl+F5 | `runToEnd()` |
| `wolfbook.debug.stop` | Shift+F5 | `stop()` |
| `wolfbook.debug.toggleBreakpoint` | F9 | `bpMgr.toggleBreakpoint(activeEditor)` |

All step commands use `when: wolfbook.debugActive && !inDebugMode` to avoid conflicts with VS Code's built-in DAP debugger. `wolfbook.debugActive` is a context key set via `vscode.commands.executeCommand('setContext', ...)`.

**Shift+Enter** (`wolfram.executeCell`): if `_debugCtrl.isActive`, calls `_debugCtrl.stop()` before running the cell normally.

---

## 7. WExpr Parsing

The kernel returns data as WExpr objects via the WSTP C++ addon. The extension uses helper functions to navigate them:

```js
_wHead(w)   // → string head name, or null
_wArgs(w)   // → args array for function-type WExprs
_wVal(w)    // → JS primitive for integer/real/string/symbol
wexprToJs(w)  // → deep convert: Association→Object, List→Array, etc.
```

`wexprToJs` is **not** used for `GetAllTimings[]` because WL Association with `List[depth, step]` keys cannot round-trip through it (keys become stringified). Instead, the raw WExpr tree is walked manually using `_wHead/_wArgs/_wVal`.

---

## 8. Key Design Decisions

### Why Dialog[] instead of DAP

Wolfram's kernel has no DAP support. `Dialog[]` is its native interactive subsession mechanism — used by Mathematica's own debugger. It pauses the kernel mid-evaluation in a reentrant way, allowing arbitrary expression evaluation inside the pause. The WSTP addon exposes this as `session.dialogEval()` / `session.exitDialog()` / `session.isDialogOpen`.

### Why external webview JS file

VS Code's Content Security Policy silently ignores `'unsafe-inline'` in webview `script-src`. The only compliant approach is to load scripts via `webview.asWebviewUri()` from the extension's `out/` directory, with `webview.cspSource` in the CSP. This is why `watchPanel.webview.js` is a separate file rather than an inline `<script>`.

### Why timing is shown at `endChar` not end of line

Multiple statements on the same line (e.g. `x=1; y=1;`) would produce overlapping decorations if placed at `lineLength`. Using a zero-width range at `(endLine, endChar)` places each statement's `⏱` immediately after its own closing character.

### Why `GetAllTimings[]` is called in `_onDialogBegin`

When "Continue to Breakpoint" skips many steps, `GetStepInfo[]` only returns the single last-completed step. Calling `GetAllTimings[]` in the same dialog pause fetches all timings accumulated during the run, so all skipped steps get their decorations rendered immediately on breakpoint hit.

### Why `LastCompletedDepth/Step` instead of `currentStep - 1`

`currentStep - 1` fails at the boundary between loop iterations: when step 3 (the last in iteration N) finishes and the loop goes back to step 1 (iteration N+1), `currentStep - 1 = 0` which is invalid. `LastCompleted*` always points to the step that actually just ran, regardless of depth or iteration boundary.

---

## 9. GitHub Copilot Tool (`wolfbook_debugCell`)

Registered in `tools/index.js` as a `vscode.lm.registerTool` handler. Available to Copilot agent mode via `#wolfbookDebug`.

### Supported Actions

#### Session control

| Action | Parameters | Description |
|--------|-----------|-------------|
| `analyze` | `cellNumber?`, `showInstrumentedCode?` | Inspect the step structure of a cell (step count, depth levels, breakpoint map, instrumented code). Does not start a session. |
| `start` | `cellNumber?` | Begin a debug session. Kernel pauses at the first statement. |
| `status` | — | Check whether a session is active; returns current depth/step and iterator values if pausing. |
| `stepOver` | — | Execute current statement; pause at next statement at the same or shallower depth. |
| `stepInto` | — | Enable pausing at all depths (enter loop bodies). |
| `stepOut` | — | Finish the current depth level; pause at the next statement one level up. |
| `continue` | — | Run until the next registered breakpoint. |
| `runToEnd` | — | Disable step mode and clear breakpoints; run cell to completion. |
| `stop` | — | Abort the debug session cleanly. |

#### Breakpoint management

| Action | Parameters | Description |
|--------|-----------|-------------|
| `addBreakpoint` | `line` (1-based, required), `cellNumber?` | Add a breakpoint on the specified line of the specified (or currently selected) cell. |
| `removeBreakpoint` | `line` (1-based, required), `cellNumber?` | Remove the breakpoint on the specified line. |
| `clearBreakpoints` | `cellNumber?` | Clear all breakpoints for one cell (if `cellNumber` given) or all cells. |
| `listBreakpoints` | — | List all currently registered breakpoints with their cell and line numbers. |

#### Watch variable management

| Action | Parameters | Description |
|--------|-----------|-------------|
| `addWatch` | `variableName` (required) | Add a variable to the Watch Panel. Its value will appear at every `Dialog[]` pause. |
| `removeWatch` | `variableName` (required) | Remove a variable from the watch list. |
| `listWatch` | — | Return the current watch list. |

### Implementation notes

- **Step commands** wait 300 ms after dispatching for `_onDialogBegin` to fire, then read `dc._lastStepInfo` for a position report.
- **Breakpoint actions** call `dc._bpMgr` directly (`addBreakpointAt`, `removeBreakpointLine`, `clearBreakpoints`, `clearAllBreakpoints`, `getAllBreakpoints`). All mutations fire `_onChangeCb` which keeps the Watch Panel breakpoint list in sync.
- **Watch actions** manipulate `dc._watchPanel._watchList` directly and call `_onAddWatch`/`_onRemoveWatch` if set, so a live debug session picks up the change immediately.
- **`analyze`** calls `codeTransformer.transformCode()` without starting a session and returns step map + instrumented code.
- The tool is **stateless from Copilot's perspective** — all state lives in the `DebugController` and `BreakpointManager` which persist across tool calls within a VS Code session.

### Typical AI workflow

```
1. #wolfbookDebug action=analyze cellNumber=3
   → Copilot sees step structure, identifies which lines contain loop bodies

2. #wolfbookDebug action=addBreakpoint cellNumber=3 line=7
   → Breakpoint added at the line where the bug is suspected

3. #wolfbookDebug action=addWatch variableName="T"
4. #wolfbookDebug action=addWatch variableName="i"

5. #wolfbookDebug action=start cellNumber=3
   → Session starts, kernel pauses at step 1

6. #wolfbookDebug action=continue
   → Runs to breakpoint at line 7, then pauses

7. #wolfbookDebug action=status
   → Reports current depth/step + watch values (T, i)

8. #wolfbookDebug action=stepOver  (repeat as needed)

9. #wolfbookDebug action=stop
```

