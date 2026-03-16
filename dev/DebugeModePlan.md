# Wolfbook Loop Debugger — Implementation Spec

## What We're Building

A debugger for Wolfram Language notebook cells that lets users step through loops (`Do`, `For`, `While`, `Table`) statement by statement, inspect variables, see per-step execution timing, set breakpoints, and navigate nested loops with Step Over / Step Into / Step Out.

The debugger uses Wolfram's built-in `Dialog[]` subsession mechanism. When the kernel hits `Dialog[]`, it pauses and enters a subsession where the extension can evaluate arbitrary expressions (query variables, timings) via WSTP. `Return[]` resumes execution to the next pause point. This is the same mechanism Mathematica's own debugger uses. The WSTP protocol signals this with `BeginDialogPacket` (type 75) and `EndDialogPacket` (type 76).

## User Experience

### Entering debug mode

- **Bug icon ($(debug-alt))** appears in each cell's toolbar (next to Run) and in the notebook toolbar. Clicking it starts debugging the focused cell.
- **Ctrl+Shift+D / Cmd+Shift+D** keyboard shortcut when focused in a cell.
- **Command Palette**: "Wolfbook Debug: Debug Cell"
- If the cell contains no recognised loop, show an info message and do nothing.

### During debugging

The user sees:
- **Yellow highlight** on the current statement (using `editor.stackFrameHighlightBackground`)
- **Timing annotations** at the end of each completed statement's line: `⏱ 0.23 ms` in muted grey (like CodeLens). These accumulate as you step and persist after debug ends until the cell is edited.
- **Red dot breakpoints** in the gutter, toggled with F9
- **Watch panel** in the debug sidebar showing current step/depth, iterator variable values, and watched variable values with add/remove controls
- **Debug controls** in the notebook toolbar: Step Over, Step Into, Step Out, Continue, Stop

### Keyboard shortcuts (standard debug shortcuts)

| Action | Key | Meaning |
|---|---|---|
| Step Over | F10 | Execute next statement; skip inner loops entirely |
| Step Into | F11 | Execute next statement; if it's a loop, pause at first inner statement |
| Step Out | Shift+F11 | Finish current loop level, pause at parent level |
| Continue | F5 | Run until next breakpoint or end |
| Run to End | Ctrl+F5 | Run to completion, ignore breakpoints |
| Stop | Shift+F5 | Abort kernel evaluation |
| Toggle Breakpoint | F9 | Set/remove breakpoint on current line |

All use `when: wolfbook.debugActive` to avoid conflicts with VSCode's built-in debugger (which uses `inDebugMode`).

### After debugging

Timing annotations remain on the cell as a profiling aid. The yellow highlight and debug controls disappear. Timings clear when the user edits the cell or starts a new debug session.

---

## Architecture Overview

### The instrumentation approach

The extension transforms the cell's code before sending it to the kernel. Each top-level statement inside a loop body gets:
1. A `wolfbookDebug$BeforeStep[depth, localStep, {iterVars...}]` call before it — this is where `Dialog[]` fires to pause
2. A `wolfbookDebug$Timed[depth, localStep, <original expression>]` wrapper — this captures `AbsoluteTiming`

For nested loops, the transformer recurses: inner loop bodies are instrumented at `depth + 1`, and iterator variables accumulate (inner steps see all enclosing loop variables).

### How stepping modes work

A single kernel variable `wolfbookDebug$TargetDepth` controls all three step modes. The `BeforeStep` function pauses (calls `Dialog[]`) only when `depth <= TargetDepth`:

- **Step Over**: set `TargetDepth = CurrentDepth` → inner steps have `depth > TargetDepth`, so they're skipped
- **Step Into**: set `TargetDepth = Infinity` → everything pauses
- **Step Out**: set `TargetDepth = CurrentDepth - 1` → current level and deeper are skipped; parent level pauses

Edge cases resolve naturally:
- Step Out at outermost depth (1) → target becomes 0 → nothing pauses → runs to completion
- Step Into on a non-loop statement → next BeforeStep at same depth pauses → behaves like Step Over

### How breakpoints work

Breakpoints are stored as `{depth, localStep}` pairs. `BeforeStep` also pauses if the current step is in the breakpoint set, regardless of `TargetDepth` or step mode. When a breakpoint is hit during Continue mode, step mode is re-enabled so the user can step from there.

### How timing works

`wolfbookDebug$Timed[depth, localStep, expr]` wraps each statement in `AbsoluteTiming` and stores the result in `wolfbookDebug$StepTimings[{depth, localStep}]`. When paused, the extension queries the timing of the previous step and displays it. After the debug session, all timings are queried at once for a final display pass.

Display format: `⏱ X` where X auto-scales (μs for <0.1ms, ms for <1s, s for ≥1s). Shown as an `after` decoration in `editorCodeLens.foreground` colour.

---

## Implementation Stages

Build in this order. Each stage is independently testable.

### Stage 0 ✅ DONE — Full-Cell Mode (Integrated into Stage 1)

**Motivation**: A typical notebook cell often has setup code before a loop:
```wolfram
1+1;
Print["setup"];
T = 1;
Do[
    Print[i];
    x = i^2;
, {i, 1, 10}]
```
Without full-cell mode, the debugger would only instrument the `Do[...]` body (depth 1), silently executing the 3 pre-loop statements. The user would have no way to step through `1+1`, `Print["setup"]`, `T = 1` individually.

**Full-cell mode (default)**: Instead of treating only the first loop body as the root, the transformer treats the *entire cell* as a depth-0 body. All top-level statements (split by `;` at bracket depth 0) become **depth-0 steps**. When a top-level statement is itself a recognised loop, the transformer recurses into its body at depth 1+ exactly as before.

**Instrumented output example** for the cell above:
```wolfram
wolfbookDebug$BeforeStep[0, 1, {}];
wolfbookDebug$Timed[0, 1, (1+1)];
wolfbookDebug$BeforeStep[0, 2, {}];
wolfbookDebug$Timed[0, 2, (Print["setup"])];
wolfbookDebug$BeforeStep[0, 3, {}];
wolfbookDebug$Timed[0, 3, (T = 1)];
wolfbookDebug$BeforeStep[0, 4, {}];
wolfbookDebug$Timed[0, 4, (Do[
    wolfbookDebug$BeforeStep[1, 1, {i}];
    wolfbookDebug$Timed[1, 1, (Print[i])];
    wolfbookDebug$BeforeStep[1, 2, {i}];
    wolfbookDebug$Timed[1, 2, (x = i^2)];
, {i, 1, 10}])]
```

**Stepping behaviour**: Starting with `TargetDepth = 0`:
- Steps through depth-0 statements one by one (pre-loop AND the loop call itself)
- When paused on the loop step (depth 0, step 4), user can:
  - **Step Over**: executes the whole `Do[...]`, moves to the next depth-0 step (or end)
  - **Step Into**: sets `TargetDepth = ∞`, enters the loop body (next pause is depth 1, step 1)
- Deep inside, **Step Out** sets `TargetDepth = CurrentDepth - 1`, returning to the parent depth

**No-loop cells**: Cells with only top-level statements (no loop) become depth-0 steps only. `result.hasLoop` is `false`. The user can still step through them one statement at a time. The info message says "(no loop — stepping through top-level statements)" instead of reporting a loop head.

**API change**: `transformCode(code)` now ALWAYS instruments the full cell. It returns `null` only for empty cells. The `hasLoop` field indicates whether any loop was found (i.e. whether Step Into is meaningful). Previously it returned `null` when no loop was present; update any callers that checked `if (!result)` to mean "no loop" — it now means "cell was empty".

**Backward compat**: Pass `{ loopOnly: true }` to get the old behaviour (finds first outermost loop, instruments only its body at depth 1+, returns `null` if no loop).

---

### Stage 1 ✅ DONE — Code Transformer

**File: `out/extension/debugger/codeTransformer.js`** (complete, 9/9 unit tests pass)

**Goal**: Given a cell's Wolfram code and optionally a set of breakpoint line numbers, produce instrumented code with `BeforeStep` and `Timed` calls inserted, plus metadata mapping step IDs to source ranges.

**Requirements**:
- Find the outermost loop (`Do`, `For`, `While`, `Table`) using bracket matching. Not a full parser — regex to find the head, then bracket counting to find the matching `]`.
- Extract the loop body (1st arg for Do/Table/While, 4th arg for For).
- Split the body on `;` at bracket depth 0, respecting string literals (`"..."`) and comments (`(* ... *)`).
- **Recurse** into any statement that is itself a recognised loop, incrementing depth.
- Accumulate iterator variables: inner steps receive all enclosing loop variables.
- For each statement, record its source range (line/char offsets) in the original cell code, and whether it contains an inner loop.
- Produce the instrumented code string and a flat list of all step metadata.

**Key data the result must contain**:
- The instrumented code string
- For each step: `{depth, localStep}` ID, source range in original code, whether it contains an inner loop
- The loop variable name at each depth
- The maximum nesting depth
- Mapping from breakpoint source lines to `{depth, localStep}` pairs

**Test cases** (unit tests, no kernel needed):
- Simple `Do[a; b; c, {i, 1, 10}]` — 3 steps at depth 1
- `For[i=1, i<=10, i++, a=f[i]; b=g[a]]` — 2 steps at depth 1
- Nested: `Do[x=1; Do[a=j; b=j^2, {j,3}]; y=2, {i,5}]` — 3 steps at depth 1, 2 steps at depth 2
- Single statement body: `Do[Print[i], {i,5}]` — 1 step
- No loop: `x = 5` → returns null
- String with semicolons: `Do[Print["a;b"]; x=1, {i,3}]` — 2 steps, semicolon inside string not split
- Breakpoints: verify line-to-step mapping works

### Stage 2 ✅ DONE — Kernel Debug Support Code

**File: `out/extension/debugger/kernelDebugInit.wl`** (complete, all 6 kernel tests pass — including HoldRest fix on `wolfbookDebug$Timed`)

**Goal**: Wolfram Language code evaluated in the kernel before the instrumented cell runs. Defines all `wolfbookDebug$*` functions and state variables.

**What it must define**:

State variables:
- `wolfbookDebug$Active` (Boolean) — master switch
- `wolfbookDebug$StepMode` (Boolean) — True = pause at every eligible step
- `wolfbookDebug$TargetDepth` (Integer or Infinity) — controls Step Over/Into/Out
- `wolfbookDebug$CurrentDepth`, `wolfbookDebug$CurrentStep` — where we are
- `wolfbookDebug$CurrentIterVars` — current values of all iterator variables
- `wolfbookDebug$WatchList` — list of variable name strings to query
- `wolfbookDebug$Breakpoints` — list of `{depth, step}` pairs
- `wolfbookDebug$StepTimings` — Association mapping `{depth, step}` → seconds

Functions:
- `wolfbookDebug$BeforeStep[depth, localStep, iterVarValues]` — updates current position, checks whether to pause (stepMode AND depth ≤ targetDepth, OR breakpoint hit), calls `Dialog[]` if yes. When breakpoint hit during Continue, re-enables step mode.
- `wolfbookDebug$Timed[depth, localStep, expr]` — evaluates expr inside `AbsoluteTiming`, stores timing, returns the result. Must use `:=` (delayed) so expr isn't evaluated at definition time.
- `wolfbookDebug$GetWatchValues[]` — returns Association of name → {fullInputForm, shortForm} for all watched variables.
- `wolfbookDebug$GetStepInfo[]` — returns Association with current depth, step, iter vars, and the timing of the previous step.
- `wolfbookDebug$GetAllTimings[]` — returns the entire StepTimings Association.

**Test**: Load into a kernel session manually. Run an instrumented `Do` loop. Verify that `Dialog[]` fires, you can evaluate expressions in the subsession, `Return[]` resumes, and timings are recorded.

### Stage 3 ✅ DONE (built into C++ addon) — WSTP Dialog Packet Handling

**No code changes required here.** The native WSTP addon (`WSTP Backend/src/addon.cc`) already fully implements everything this stage described:

| C++ API | Description |
|---------|-------------|
| `session.isDialogOpen` | getter — `true` while kernel is in `Dialog[]` |
| `session.dialogEval(expr)` | Evaluate inside the open dialog via `EvaluatePacket`; rejects if not open |
| `session.exitDialog(retVal?)` | Close a dialog via `EnterTextPacket["Return[]"]`; rejects if not open |
| `onDialogBegin` callback | `evaluate()` option — fires (via TSFN) when `BEGINDLGPKT` arrives |
| `onDialogEnd` callback | `evaluate()` option — fires when `ENDDLGPKT` arrives |

**Key protocol notes** (from `WSTP Backend/DESIGN.md`):
- `dialogEval('Return[]')` does **not** close a dialog — only `exitDialog()` does, because it sends `EnterTextPacket` not `EvaluatePacket`.
- The step control helpers in `kernelDebugInit.wl` (e.g. `wolfbookDebug$StepOver[]`) each contain `Return[]`. In the context of `dialogEval`, that `Return[]` returns from the function body, not from `Dialog[]` — it is harmless. The dialog is always closed by the JS controller calling `session.exitDialog()` explicitly.
- Both `dialogEval` and `exitDialog` reject immediately if `dialogOpen_ == false`, so no guard checks are needed in the controller.

### Stage 4: Breakpoint Manager

**New file: `out/extension/debugger/breakpointManager.js`**

**Goal**: Manage breakpoint state per notebook cell and render red dot gutter markers.

**Requirements**:
- Store breakpoints as a `Map<string, Set<number>>` keyed by cell document URI → set of 0-indexed line numbers.
- `toggleBreakpoint(editor)` — toggle the breakpoint on the current cursor line.
- `getBreakpointsForCell(cell)` — return the set of breakpoint line numbers for a cell.
- `clearBreakpoints(cell)` — remove all breakpoints for a cell.
- Render breakpoints as gutter icons using `TextEditorDecorationType` with a red dot SVG (`media/breakpoint.svg` — a 16x16 SVG with a red circle).
- Re-apply decorations when the editor becomes visible (listen for `onDidChangeActiveTextEditor` or equivalent for notebook cells).

### Stage 5: Debug Controller

**New file: `out/extension/debugger/debugController.js`**

**Goal**: Orchestrate the entire debug session using the existing C++ addon API (`session.isDialogOpen`, `session.dialogEval`, `session.exitDialog`).

**Lifecycle**:

1. `startDebugCell(cell)`:
   - Get cell code and breakpoints from the Breakpoint Manager
   - Run `transformCode(code, breakpointLines)` (Stage 1) to get instrumented code + step map
   - If result is `null` (empty cell), show info message and return
   - Set `wolfbook.debugActive` VS Code context key
   - Evaluate `kernelDebugInit.wl` content via `session.evaluate()` to reset all state
   - Set breakpoints and watch list: `session.evaluate('wolfbookDebug$Breakpoints = ...; wolfbookDebug$WatchList = ...')`
   - Start the instrumented code **asynchronously** (do not await):
     ```js
     this._evalPromise = controller.session.evaluate(result.instrumentedCode, {
         onDialogBegin: () => this._onDialogBegin(),
         onDialogEnd:   () => this._onDialogEnd(),
     });
     this._evalPromise.then(() => this._finishDebug()).catch(err => this._onEvalError(err));
     ```
   - Wait up to 30 s for `session.isDialogOpen` using a poll loop (the first `BeforeStep` fires immediately)

2. `_onDialogBegin()` — called by `onDialogBegin` TSFN callback when kernel pauses:
   - Query step info and watch values **inside** the dialog:
     ```js
     const stepInfoWexpr = await session.dialogEval('wolfbookDebug$GetStepInfo[]');
     const watchWexpr    = await session.dialogEval('wolfbookDebug$GetWatchValues[]');
     ```
   - Parse the returned WExpr (Association) into a JS object
   - Look up the current step's source range from the step map
   - Apply yellow highlight decoration to the current step's lines
   - Update the watch panel webview with step info + variable values
   - **Do not** call `exitDialog()` here — wait for a user step command

3. Step commands — each calls a WL helper then `exitDialog()`:
   ```js
   async stepOver()  { await s.dialogEval('wolfbookDebug$StepOver[]');  await s.exitDialog(); }
   async stepInto()  { await s.dialogEval('wolfbookDebug$StepInto[]');  await s.exitDialog(); }
   async stepOut()   { await s.dialogEval('wolfbookDebug$StepOut[]');   await s.exitDialog(); }
   async continueRun() { await s.dialogEval('wolfbookDebug$Continue[]'); await s.exitDialog(); }
   async runToEnd()  { await s.dialogEval('wolfbookDebug$RunToEnd[]');  await s.exitDialog(); }
   async stop()      { controller.abortEvaluation(); }
   ```
   After `exitDialog()`, the kernel runs to the next `Dialog[]` pause; `onDialogBegin` fires again automatically.

4. `_onEvalError(err)` / `_finishDebug()` — called when `evaluate()` resolves or rejects:
   - Query all timings: `await session.evaluate('wolfbookDebug$GetAllTimings[]', { interactive: false })`
   - Apply final timing decorations (⏱) to each completed step's last line
   - Clear yellow highlight
   - Clear `wolfbook.debugActive` context key
   - Evaluate `wolfbookDebug$Cleanup[]` to reset kernel state

**Editor decorations managed by the controller**:
- **Current step highlight**: `editor.stackFrameHighlightBackground`, whole line. Applied to the current step's source range. Cleared on each new pause and on finish.
- **Timing annotations**: `editorCodeLens.foreground`, italic, rendered as `after` decoration text (`⏱ 0.23 ms`) at the end of each completed step's last line. Auto-format: μs / ms / s. Accumulate across steps; persist after debug ends.
- **Clearing timings**: Clear when cell `onDidChangeTextDocument` fires, or when a new debug session starts.

**Safety**: 30-second timeout polling `session.isDialogOpen` after `startDebugCell`; if dialog never opens, abort and show error. Guard all `dialogEval`/`exitDialog` calls with `if (!session.isDialogOpen) return` to avoid rejection if the evaluation finished between a step command and its API call.

### Stage 6: Watch Panel

**New file: `out/extension/debugger/watchPanel.js`**

**Goal**: A `WebviewViewProvider` registered in the `"debug"` view container that shows live debugging state.

**View registration** in `package.json`: a webview view with id `wolfbook.watchPanel`, name "Wolfbook Watch", visible when `wolfbook.debugActive` is true. Place it in the `"debug"` views container (Run & Debug sidebar).

**What it displays**:
- **Step header**: "Step 1.2 / 1.3 — i = 5, j = 2" with timing of last step. The `depth.localStep` notation indicates nesting. Timing auto-formats μs/ms/s.
- **Variable table**: rows of `name | value | ×` where value is the Short form and hovering shows the full InputForm as a tooltip.
- **Add watch input**: text field + Add button at the bottom. Enter key also triggers add.

**Communication with extension**:
- Extension → Webview: `postMessage({command: 'update', stepInfo, variables})` to refresh display
- Webview → Extension: `postMessage({command: 'addWatch', name})` and `removeWatch`

**Styling**: Use VSCode CSS variables throughout (`--vscode-editor-foreground`, `--vscode-input-background`, `--vscode-button-background`, `--vscode-badge-background`, `--vscode-list-hoverBackground`, etc.) for native look and feel.

### Stage 7: Commands, Keybindings, Menus, and Wiring

**Modified files: `out/extension/extension.js` (extend existing), `out/extension/extension.js` package.json**

Register all commands:
- `wolfbook.debug.debugCell` — start debug on selected cell
- `wolfbook.debug.stepOver`, `wolfbook.debug.stepInto`, `wolfbook.debug.stepOut`
- `wolfbook.debug.continueToBreakpoint`, `wolfbook.debug.continueToEnd`
- `wolfbook.debug.stop`
- `wolfbook.debug.toggleBreakpoint`
- `wolfbook.debug.clearTimings`

Register keybindings as specified in the table above. All debug action keybindings gated on `when: wolfbook.debugActive`. Toggle breakpoint gated on `wolfbook.notebookActive`. Debug cell gated on `wolfbook.notebookActive && !wolfbook.debugActive`.

Register menus:
- `notebook/cell/title` (inline): Debug Cell button — bug icon, visible when not debugging
- `notebook/toolbar` (navigation): Debug Cell when not debugging; Step Over, Step Into, Step Out, Continue, Stop when debugging

Wire everything in `activate()`:
- Instantiate BreakpointManager, WatchPanelProvider, DebugController
- Register WebviewViewProvider for the watch panel
- Register all command handlers delegating to the controller and breakpoint manager
- Set up context keys: `wolfbook.notebookActive` when a Wolfbook notebook is focused, `wolfbook.debugActive` managed by the controller

---

## Constraints and Decisions to Preserve

These decisions are load-bearing — don't change them without understanding why:

1. **Dialog[], not custom pausing**: Dialog is the only mechanism that (a) pauses the kernel, (b) keeps all local variables accessible, (c) accepts arbitrary evaluations, and (d) is supported by WSTP's packet protocol.

2. **Code transformation, not TraceDialog**: TraceDialog pauses at every sub-evaluation (hundreds per statement). We need control over exactly where pauses occur.

3. **Hierarchical step IDs, not flat integers**: Flat IDs break down with nested loops because the same flat index would appear in different loop levels.

4. **TargetDepth mechanism for Step Over/Into/Out**: All three modes reduce to a single comparison `depth <= TargetDepth` in BeforeStep. Don't add separate boolean flags for each mode.

5. **Breakpoints are {depth, localStep} pairs**: They must be step-level, not just line-level, because a single source line could correspond to steps at different depths.

6. **Timing via AbsoluteTiming wrapper, not external measurement**: The kernel-side timing is the only accurate way to measure Wolfram evaluation time. Extension-side timing would include WSTP round-trip overhead.

7. **WebviewView, not TreeView or fake DAP session**: We need KaTeX/MathML rendering for Wolfram output in the watch panel, which requires HTML. TreeView is text-only. A DAP adapter is unnecessary complexity.

8. **Timing decorations persist after debug ends**: This is a deliberate feature — the debugger doubles as a line-level profiler. Clear on cell edit or new debug session.

---

## Not In Scope (explicitly deferred)

- **Stepping into user-defined functions**: Requires instrumenting function bodies, which means either rewriting `DownValues` or using a runtime hook. Architecturally possible with the same Dialog mechanism, but deferred.
- **Stepping through `If`/`Which`/`Switch` branches**: Not loops, but could be instrumented the same way. Deferred.
- **Stepping through `Map`/`Fold`/`NestList` with implicit functions**: The "loop body" is internal to the kernel. Would require converting to explicit `Do` form. Deferred.
- **Conditional breakpoints**: Would require evaluating a condition expression in `BeforeStep`. Easy to add later but not in this iteration.
- **Multi-cell debugging**: Each debug session operates on a single cell. Deferred.

---

## Checklist

### Stage 1: Code Transformer ✅ DONE
- [x] Bracket-matching utility (handles strings, comments)
- [x] Top-level loop finder (Do, For, While, Table) — linear scanner skips `(* comments *)` and strings
- [x] Loop body extractor (correct argument position per loop type)
- [x] Semicolon splitter at depth 0 (string/comment-aware)
- [x] Recursive instrumentation of nested loops
- [x] Iterator variable accumulation across depths
- [x] Source range tracking for each step
- [x] `containsInnerLoop` flag per step
- [x] Breakpoint line → step ID mapping
- [x] Unit tests: 9/9 pass (including comment-false-match regression)

### Stage 2: Kernel Debug Code ✅ DONE
- [x] All state variables defined
- [x] `BeforeStep` with depth/TargetDepth check and breakpoint check
- [x] `Timed` wrapper with AbsoluteTiming — `HoldRest` attribute (required! without it args are pre-evaluated)
- [x] `GetWatchValues`, `GetStepInfo`, `GetAllTimings` query functions
- [x] Step control helpers: StepOver, StepInto, StepOut, Continue, RunToEnd
- [x] Kernel tests (cells 52–57 in test.wb): all 6 pass

### Stage 3: WSTP Dialog Packets ✅ DONE (C++ addon)
- [x] `BEGINDLGPKT` / `ENDDLGPKT` handled in `DrainToEvalResult` in `addon.cc`
- [x] `session.isDialogOpen` getter
- [x] `session.dialogEval(expr)` — `EvaluatePacket` path in dialog inner loop
- [x] `session.exitDialog(retVal?)` — `EnterTextPacket` path closes dialog
- [x] `onDialogBegin` / `onDialogEnd` TSFN callbacks in `evaluate()` options
- [x] All normal packets (Text, Message, etc.) handled during dialog

### Stage 4: Breakpoint Manager
- [ ] Toggle breakpoint on/off per line
- [ ] Red dot gutter decoration via SVG
- [ ] `getBreakpointsForCell()` returns line set
- [ ] Decorations re-applied on editor focus change

### Stage 5: Debug Controller
- [ ] `startDebugCell()` full flow
- [ ] `stepOver()` — TargetDepth = CurrentDepth
- [ ] `stepInto()` — TargetDepth = Infinity
- [ ] `stepOut()` — TargetDepth = CurrentDepth - 1
- [ ] `continueToBreakpoint()` — StepMode = False
- [ ] `continueToEnd()` — StepMode = False + clear breakpoints
- [ ] `stop()` — abort kernel
- [ ] Yellow highlight on current step
- [ ] Timing decorations with auto-format (μs/ms/s)
- [ ] Timings persist after debug, clear on edit
- [ ] 30s safety timeout on waitForBeginDialog

### Stage 6: Watch Panel
- [ ] WebviewViewProvider in debug sidebar
- [ ] Step header with depth.step notation and timing
- [ ] Variable table with Short values and InputForm tooltips
- [ ] Add/remove watch via webview messaging
- [ ] VSCode CSS variable theming throughout

### Stage 7: Wiring
- [ ] All 9 commands registered
- [ ] All keybindings: F9, F10, F11, Shift+F11, F5, Ctrl+F5, Shift+F5, Ctrl+Shift+D
- [ ] Cell toolbar: Debug Cell button (inline, bug icon)
- [ ] Notebook toolbar: debug controls when active
- [ ] Context keys: wolfbook.notebookActive, wolfbook.debugActive
- [ ] breakpoint.svg in media/

### Integration Tests
- [ ] Do loop, 3 statements: step through all, verify timings appear
- [ ] Nested Do[Do[...]]: Step Into enters inner, Step Out returns to outer, Step Over skips inner
- [ ] Breakpoint: set one, Continue, verify it stops there
- [ ] Watch panel: add variable, step, see value update
- [ ] Stop: verify kernel aborted cleanly
- [ ] Step Out at depth 1: runs to completion