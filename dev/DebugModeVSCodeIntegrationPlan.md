# Wolfbook Debugger: Rewiring to VSCode Debug Adapter Protocol

## Context

The Wolfbook debugger is fully implemented and working. This document describes how to add a DAP adapter layer so that VSCode's native debug infrastructure (Run and Debug sidebar, floating toolbar, Variables/Watch/Call Stack panels, Debug Console, native breakpoint gutter, Run menu, `inDebugMode` shortcuts) all activate during Wolfbook debug sessions.

The approach is **additive**. The existing custom UI (Watch Panel, timing decorations, yellow highlight, `⏳` pending indicator, auto-advance, print/message capture, notebook toolbar buttons) continues to work unchanged. The DAP adapter is a thin translator that delegates to the existing `DebugController`.

---

## What We Gain

| Feature | Status today | After DAP |
|---|---|---|
| Step/Continue/Stop | Custom commands + notebook toolbar + Watch Panel buttons | Also: native floating debug toolbar, Run menu items |
| F5/F10/F11 shortcuts | Custom keybindings gated on `wolfbook.debugActive && !inDebugMode` | Also work via `inDebugMode` (no more `!inDebugMode` guard needed) |
| Variable inspection | Wolfbook Watch Panel (HTML/KaTeX) | Also: native Variables panel with expandable drill-down |
| Expression evaluation | Only via Watch Panel "Add watch" | Also: Debug Console REPL, hover-to-inspect in editor |
| Breakpoints | Custom `BreakpointManager` + SVG gutter + `onDidChangeBreakpoints` interception | Native gutter dots + Breakpoints panel (custom system still works alongside) |
| Call stack | Status bar / Watch Panel header only | Native Call Stack panel showing depth frames |
| Run menu | All items greyed out | All Run menu items active during debug session |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ VSCode Native Debug UI (all free with DAP)                  │
│ Variables, Watch, Call Stack, Debug Console, Breakpoints,   │
│ floating toolbar, Run menu, hover-to-inspect, inline values │
└─────────────────────────┬───────────────────────────────────┘
                          │ DAP messages
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ WolframDebugAdapter (NEW)                                   │
│ Implements vscode.DebugAdapter                              │
│ Listens to DebugController events, delegates commands to it │
└─────────────────────────┬───────────────────────────────────┘
                          │ calls existing methods
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Existing infrastructure (ALL DONE, unchanged)               │
│                                                             │
│ DebugController  ─→  session.dialogEval / exitDialog        │
│   ._onDialogBegin()   (C++ addon)                           │
│   ._sendStep()        codeTransformer.transformCode()       │
│   ._finishDebug()     kernelDebugInit.wl                    │
│   ._applyTimingDecorations()                                │
│   ._applyStepHighlight()                                    │
│   ._applyPendingDeco()                                      │
│                                                             │
│ BreakpointManager — storage + gutter red dots               │
│ WatchPanel — WebviewViewProvider with KaTeX + debug controls│
└─────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Rewiring

### 1. Add debugger type to `package.json`

Under `contributes`, add:

```jsonc
"debuggers": [
  {
    "type": "wolfram",
    "label": "Wolfram Language",
    "languages": ["wolfram"],
    "configurationAttributes": {
      "launch": {
        "properties": {
          "cellUri": {
            "type": "string",
            "description": "URI of the notebook cell to debug (auto-filled)"
          }
        }
      }
    }
  }
],
"breakpoints": [
  { "language": "wolfram" }
]
```

The `breakpoints` entry enables native breakpoint gutter for Wolfram cells. Users will see both the native dots AND the existing custom red dots from `BreakpointManager`. This is fine initially — see step 10 for deduplication.

### 2. Add events to DebugController

The adapter needs to know when the kernel pauses and when the session ends. Add two `EventEmitter`s to `DebugController`:

**In constructor**, add:
```js
this._onDidPause = new vscode.EventEmitter();
this.onDidPause = this._onDidPause.event;    // fires {reason, stepInfo}

this._onDidFinish = new vscode.EventEmitter();
this.onDidFinish = this._onDidFinish.event;   // fires void
```

Also add:
```js
this._pauseCount = 0;         // reset to 0 in startDebugCell, incremented in _onDialogBegin
this._lastWatchValues = [];    // populated in _onDialogBegin after parsing GetWatchValues
```

**Where to emit `onDidPause`**: At the end of the existing `_onDialogBegin()` method, after all queries, decoration updates, and Watch Panel updates are done. The reason is determined by:
- `_pauseCount === 1` → `'entry'` (first pause in session)
- Current `{depth, localStep}` matches an entry in `_xfm.breakpointMap` AND the kernel re-enabled `StepMode` (i.e. a breakpoint was hit during Continue) → `'breakpoint'`
- Otherwise → `'step'`

**How to detect breakpoint hit**: `GetStepInfo[]` returns `targetDepth`. When a breakpoint is hit during Continue mode, the kernel-side `BeforeStep` re-enables `StepMode` and the step info shows `StepMode` is now true. A simple signal: if the step command before this pause was `continueRun()` or `runToEnd()` but we paused anyway, it was a breakpoint. Track the last step command type in a field `_lastStepCommand`.

**Where to emit `onDidFinish`**: At the end of `_finishDebug()`, after all cleanup and after `_cleanup()` has run.

**Where to store watch values**: In `_onDialogBegin`, after parsing the `GetWatchValues[]` WExpr, store the result:
```js
this._lastWatchValues = parsedValues;  // [{name, short, full}, ...]
```

Add a getter:
```js
get lastWatchValues() { return this._lastWatchValues || []; }
```

**No other changes to `DebugController`.** All existing logic (timing decorations, yellow highlight, `⏳`, print/message capture via `onPrint`/`onMessage`, auto-advance, Watch Panel updates, `_dynDialogMutex`, `_debugExecution` cell output management) continues to work exactly as-is.

### 3. Create WolframDebugAdapter

**New file: `out/extension/debugger/wolframDebugAdapter.js`**

This class:
- Implements `vscode.DebugAdapter` (has `handleMessage(msg)`, fires events via `onDidSendMessage`)
- Holds references to `DebugController`, `BreakpointManager`, and the kernel session getter `getController`
- Subscribes to `debugController.onDidPause` and `debugController.onDidFinish`
- Tracks `_seq` for DAP response sequence numbers

**Message dispatch**: `handleMessage(msg)` switches on `msg.command` and calls the appropriate `_on<Command>` handler. Each handler builds a DAP response object and fires it via `_sendResponse(request, body)`.

**Event sending**: `_sendEvent(eventName, body)` fires via `this._onDidSendMessage`.

**Lifecycle**: `dispose()` cleans up event subscriptions.

### 4. DAP request handlers

Each handler maps to existing `DebugController` methods and fields. The adapter performs no kernel communication of its own — it reads state the controller has already queried.

#### `initialize`

No controller call. Return capabilities:
```js
{
  supportsEvaluateForHovers: true,
  supportsTerminateRequest: true,
  supportsConfigurationDoneRequest: true,
  supportSuspendDebuggee: false,
  supportsSteppingGranularity: false,
  supportsBreakpointLocationsRequest: false,
  supportsRestartRequest: false,
  supportsSingleThreadDebuggee: true
}
```

Send `initialized` event immediately after the response.

#### `launch`

1. Find the cell from `args.cellUri`. Parse the URI, iterate `vscode.window.activeNotebookEditor.notebook.getCells()` to find the matching cell document URI.
2. If `cellUri` is absent, fall back to the currently selected cell (same logic as the existing `wolfbook.debug.debugCell` command).
3. Call `debugController.startDebugCell(cell)`.
4. Do NOT send `stopped` here — wait for `onDidPause` (which fires when `_onDialogBegin` runs after the first `Dialog[]` pause).

#### `configurationDone`

Acknowledge with an empty response. No special action needed — `startDebugCell()` already bakes breakpoints in via `transformCode(code, breakpointLines)` using `_bpMgr.getBreakpointsForCell()` at transform time. Breakpoints changed during a session are pushed to the kernel by the existing `onChange` callback in `BreakpointManager`.

#### `setBreakpoints`

Receive `{ source: {path}, breakpoints: [{line}] }` from VSCode. DAP lines are 1-based.

1. Parse the cell URI from `source.path`
2. For each requested breakpoint line:
   - Convert to 0-based: `line0 = bp.line - 1`
   - Look up `debugController._xfm.breakpointMap[line0]` to find the matching `{depth, localStep}`
   - If found: `verified: true`, return the snapped line
   - If not: `verified: false`
3. Sync with `_bpMgr`: call `clearBreakpoints(cell)` then `addBreakpointAt(uri, line0)` for each verified line
4. If session is active and `session.isDialogOpen`: push updated breakpoints to kernel via `session.dialogEval('wolfbookDebug$Breakpoints = ...')`
5. Return the validated breakpoints array

**Interaction with existing `onDidChangeBreakpoints` interception**: The interception in `extension.js` intercepts native `SourceBreakpoint` additions for `vscode-notebook-cell:` URIs, mirrors them into `_bpMgr`, then removes the native `SourceBreakpoint`. With DAP active, VSCode manages breakpoints through `setBreakpoints` DAP requests instead, so the interception may or may not fire depending on how VSCode routes gutter clicks during a debug session.

**Resolution**: Keep the interception as-is for now. `_bpMgr.addBreakpointAt` is idempotent, so double-adds are harmless. After verifying everything works, optionally gate the interception:
```js
if (vscode.debug.activeDebugSession?.type === 'wolfram') return;
```

#### `threads`

Return `[{ id: 1, name: "Wolfram Kernel" }]`.

#### `stackTrace`

Read `debugController._lastStepInfo` (which contains `{ depth, localStep, iterVars }`).

Build one frame per depth level, from current depth down to 0. For each depth:
- Find the matching step in `debugController._xfm.steps` where `step.depth === depth` and `step.localStep === localStep` (for the current depth) or the parent step that contains the inner loop (for outer depths).
- Frame fields:
  - `id`: encode as `depth` (or `depth * 1000 + localStep`)
  - `name`: Build from step metadata. E.g. `"Do loop — i = 5"` for depth 1, `"Top level — step 2/4"` for depth 0
  - `source`: `{ name: "Cell N", path: debugController._cell.document.uri.toString() }`
  - `line`: `step.startLine + 1` (DAP is 1-based)
  - `column`: `step.startChar + 1`

**Finding parent frames**: For depth d-1, find the step at depth d-1 that has `containsInnerLoop: true` or `isLoop: true` and whose source range encloses the current depth's step. In full-cell mode (depth 0), this is typically the top-level step that wraps the Do/For/While.

**Simpler v1**: Show current frame + a "Top level" frame at depth 0. Only two frames. Expand to full depth chain later.

#### `scopes`

For a given `frameId` (depth), return:
- Scope `"Iterator Variables"` with `variablesReference: 1000 + depth`
- Scope `"Watch Variables"` with `variablesReference: 2000 + depth`

#### `variables`

For `variablesReference` in the 1000-range (iterator variables):
- Read `debugController._lastStepInfo.iterVars` — this is a `{name: value}` object (from the WExpr Association `<|"i"->3, "j"->2|>`)
- Return one DAP `Variable` per entry: `{ name, value: String(val), variablesReference: 0 }`

For `variablesReference` in the 2000-range (watch variables):
- Read `debugController.lastWatchValues` → `[{name, short, full}]`
- Return one DAP `Variable` per entry: `{ name, value: short, variablesReference: 0 }`
- Put `full` (InputForm) as a tooltip hint — DAP doesn't have a native tooltip field, but `evaluateName` can be set to the variable name so hover works via `evaluate`

**v1**: All variables flat (`variablesReference: 0`). No drill-down. Hierarchical expansion (Lists, Associations) deferred.

#### `evaluate`

Called for Debug Console (`context: "repl"`), hover (`context: "hover"`), and watch (`context: "watch"`).

1. Guard: if `!session.isDialogOpen`, return error body `{ message: "Not paused" }`
2. Build the kernel expression:
   - For `hover`: `'ToString[Short[' + expr + ', 3], OutputForm]'`
   - For `repl`/`watch`: `'ToString[TimeConstrained[' + expr + ', 5], OutputForm]'`
3. Call `session.dialogEval(kernelExpr)` (via `getController().session`)
4. Parse the WExpr result: the outer result should be a string (because of `ToString`). Extract via `_wVal(result)`.
5. Return `{ result: stringValue, variablesReference: 0 }`

**Error handling**: If `dialogEval` rejects (dialog closed, expression error), return a DAP error response.

**Note on WExpr**: `dialogEval` returns WExpr objects, not strings. The `ToString[..., OutputForm]` wrapper ensures the kernel returns a string WExpr, which `_wVal` can extract. If the expression itself throws a Message, the result will contain `$Failed` or the message text — return it as-is.

#### `next` / `stepIn` / `stepOut` / `continue`

Call the corresponding `DebugController` method:
- `next` → `debugController.stepOver()`
- `stepIn` → `debugController.stepInto()`
- `stepOut` → `debugController.stepOut()`
- `continue` → `debugController.continueRun()`

Send the DAP response immediately (acknowledges the request). Do NOT send `stopped` from here — the adapter's `onDidPause` listener handles that when the controller fires the event after the kernel pauses again.

**Important**: The controller's `_sendStep()` is async — it calls `dialogEval(command)` then `exitDialog()`, then clears the step highlight. The kernel runs to the next `Dialog[]`, `onDialogBegin` fires, controller queries state, updates decorations, updates Watch Panel, and THEN emits `onDidPause`. The adapter sends `stopped` at that point. This ordering is correct.

#### `disconnect` / `terminate`

Call `debugController.stop()`. Send response. The adapter's `onDidFinish` listener sends `terminated` when the controller completes cleanup.

#### `pause`

No-op response. The kernel is already paused in Dialog.

### 5. Wire `onDidPause` → `stopped` event

In the adapter constructor, subscribe:
```js
this._pauseSub = debugController.onDidPause(({ reason }) => {
  this._sendEvent('stopped', {
    reason,              // 'entry', 'step', or 'breakpoint'
    threadId: 1,
    allThreadsStopped: true
  });
});
```

When VSCode receives `stopped`, it automatically requests `threads`, `stackTrace`, `scopes`, `variables` to refresh all debug panels.

### 6. Wire `onDidFinish` → `terminated` event

```js
this._finishSub = debugController.onDidFinish(() => {
  this._sendEvent('terminated', {});
});
```

### 7. Register factory and config provider in `extension.js`

After creating `_debugCtrl`, `_bpMgr`, `_watchPanel`, add:

```js
context.subscriptions.push(
  vscode.debug.registerDebugAdapterDescriptorFactory('wolfram', {
    createDebugAdapterDescriptor(session) {
      return new vscode.DebugAdapterInlineImplementation(
        new WolframDebugAdapter(_debugCtrl, _bpMgr, () => controller)
      );
    }
  })
);

context.subscriptions.push(
  vscode.debug.registerDebugConfigurationProvider('wolfram', {
    resolveDebugConfiguration(folder, config) {
      if (!config.cellUri) {
        const editor = vscode.window.activeNotebookEditor;
        if (editor && editor.selections.length > 0) {
          const cell = editor.notebook.cellAt(editor.selections[0].start);
          config.cellUri = cell.document.uri.toString();
        }
      }
      config.type = config.type || 'wolfram';
      config.request = config.request || 'launch';
      config.name = config.name || 'Debug Cell';
      return config;
    }
  })
);
```

### 8. Change `wolfbook.debug.debugCell` to start DAP session

Change the existing command registration from:
```js
_debugCtrl.startDebugCell(cell);
```
to:
```js
vscode.debug.startDebugging(undefined, {
  type: 'wolfram',
  request: 'launch',
  name: 'Debug Cell'
});
```

The config provider fills in `cellUri`. The adapter's `launch` handler calls `startDebugCell()`.

### 9. Auto-advance interaction

The controller's `_advanceToNextCell()` calls `startDebugCell(nextCell)` directly after a 300ms delay. With DAP, this means the new cell runs within the same DAP session. The adapter sees new `stopped` events from the controller and forwards them. No changes needed.

The DAP session stays open across auto-advances. It ends when `_finishDebug` fires without triggering a new `startDebugCell` (either because there's no next cell or because the user explicitly stopped).

### 10. Clean up keybinding guards

Current keybindings use `when: wolfbook.debugActive && !inDebugMode`. With DAP, `inDebugMode` is true during Wolfbook sessions, so `!inDebugMode` would disable them.

**Change**: Remove `&& !inDebugMode` from all custom step keybinding `when` clauses.

**Then choose one of**:

**Option A (recommended for final state)**: Remove custom keybindings for F5, F10, F11, Shift+F11, Shift+F5 entirely. DAP handles them via `inDebugMode`. Keep:
- `Ctrl+Shift+D` for `wolfbook.debug.debugCell`
- `F9` for `wolfbook.debug.toggleBreakpoint` (may coexist with native toggle)
- `Ctrl+F5` for `wolfbook.debug.continueToEnd` (Run to End is not a standard DAP command — `continue` is F5; Ctrl+F5 is Wolfbook-specific "ignore breakpoints")

**Option B (safer transitional step)**: Keep all custom keybindings with `when: wolfbook.debugActive`. Both the custom command and the DAP command fire on the same keypress. Since they both call the same controller method, this is usually harmless. If double-stepping occurs, switch to Option A.

### 11. Handle breakpoint gutter duplication

Two gutter systems will coexist:
- **Native DAP**: VSCode shows breakpoint dots for `language: "wolfram"` cells
- **Custom**: `BreakpointManager` renders red dots via `TextEditorDecorationType`

Both appear. Visually they overlap (same position). This is acceptable initially.

**Later optimisation**: When a DAP session is active, suppress the custom `BreakpointManager` gutter rendering. The data layer in `BreakpointManager` (storage, line→step mapping) is still used — only the decoration rendering is skipped.

---

## Files Changed

| File | Change |
|---|---|
| `package.json` | Add `contributes.debuggers` and `contributes.breakpoints`. Remove `!inDebugMode` from keybinding `when` clauses. |
| `out/extension/debugger/debugController.js` | Add `_onDidPause` / `_onDidFinish` EventEmitters, `_pauseCount`, `_lastStepCommand`, `_lastWatchValues` + getter. Emit events at end of `_onDialogBegin` and `_finishDebug`. |
| `out/extension/extension.js` | Register adapter factory + config provider. Change `debugCell` command to use `vscode.debug.startDebugging()`. |
| **NEW** `out/extension/debugger/wolframDebugAdapter.js` | The DAP adapter class (~200–300 lines). |

| File | NOT changed |
|---|---|
| `out/extension/debugger/codeTransformer.js` | Unchanged |
| `out/extension/debugger/kernelDebugInit.wl` | Unchanged |
| `out/extension/debugger/breakpointManager.js` | Unchanged |
| `out/extension/debugger/watchPanel.js` | Unchanged |
| `out/extension/debugger/watchPanel.webview.js` | Unchanged |
| `media/breakpoint.svg` | Unchanged |
| C++ addon (`addon.cc`) | Unchanged |

---

## Implementation Order

1. **`package.json`**: Add `debuggers` + `breakpoints`. Verify: native gutter dots appear for Wolfram cells.

2. **`debugController.js`**: Add `onDidPause`, `onDidFinish`, `_pauseCount`, `_lastWatchValues`. Emit events. Verify with console.log.

3. **`wolframDebugAdapter.js`**: Create with `initialize` + `launch` only. Register factory in `extension.js`. Verify: clicking Debug Cell opens Run and Debug sidebar.

4. **Wire `launch` → `startDebugCell`**. Wire `onDidPause` → `stopped`. Verify: debug session starts, pauses at first step, native floating toolbar appears.

5. **Wire `next`/`stepIn`/`stepOut`/`continue`/`disconnect`**. Verify: F10 steps via native toolbar. F5 continues. Shift+F5 stops.

6. **Wire `threads` + `stackTrace`**. Verify: Call Stack panel shows depth frames.

7. **Wire `scopes` + `variables`**. Verify: Variables panel shows iter vars + watch vars.

8. **Wire `evaluate`**. Verify: Debug Console REPL evaluates expressions. Hover shows values.

9. **Wire `setBreakpoints`**. Verify: native gutter breakpoints work with Continue.

10. **Clean up**: Remove `!inDebugMode` from keybindings. Optionally remove custom F5/F10/F11 keybindings.

---

## Checklist

### New file: wolframDebugAdapter.js
- [ ] Class implements `vscode.DebugAdapter` (`handleMessage`, `onDidSendMessage`, `dispose`)
- [ ] `_sendResponse(request, body)` and `_sendEvent(event, body)` helpers
- [ ] `initialize`: returns capabilities, sends `initialized` event
- [ ] `launch`: finds cell from `cellUri`, calls `startDebugCell()`
- [ ] `configurationDone`: acknowledged
- [ ] `threads`: returns single thread `{id: 1, name: "Wolfram Kernel"}`
- [ ] `stackTrace`: builds depth-based frames from `_lastStepInfo` + `_xfm.steps`
- [ ] `scopes`: returns Iterator Variables + Watch Variables scopes
- [ ] `variables`: reads `_lastStepInfo.iterVars` and `lastWatchValues`
- [ ] `evaluate`: calls `dialogEval(ToString[TimeConstrained[expr,5],OutputForm])`
- [ ] `next` → `stepOver()`, `stepIn` → `stepInto()`, `stepOut` → `stepOut()`
- [ ] `continue` → `continueRun()`
- [ ] `disconnect` / `terminate` → `stop()`
- [ ] `setBreakpoints`: maps DAP 1-based lines to 0-based, looks up `breakpointMap`, syncs `_bpMgr`
- [ ] `pause`: no-op
- [ ] Listens `onDidPause` → sends `stopped` with correct reason
- [ ] Listens `onDidFinish` → sends `terminated`
- [ ] `dispose()` cleans up event subscriptions

### Modified: debugController.js
- [ ] `_onDidPause` EventEmitter created in constructor
- [ ] `_onDidFinish` EventEmitter created in constructor
- [ ] `_pauseCount` field, reset in `startDebugCell`, incremented in `_onDialogBegin`
- [ ] `_lastStepCommand` field, set before each `_sendStep` call
- [ ] Pause reason detection: entry (count=1), breakpoint (was Continue but paused), step (else)
- [ ] `_onDidPause.fire({reason, stepInfo})` at end of `_onDialogBegin`
- [ ] `_onDidFinish.fire()` at end of `_finishDebug` (after `_cleanup()`)
- [ ] `_lastWatchValues` stored after parsing `GetWatchValues` WExpr
- [ ] `get lastWatchValues()` getter

### Modified: extension.js
- [ ] `registerDebugAdapterDescriptorFactory('wolfram', ...)` in `activate()`
- [ ] `registerDebugConfigurationProvider('wolfram', ...)` in `activate()`
- [ ] `wolfbook.debug.debugCell` calls `vscode.debug.startDebugging()`
- [ ] Import `WolframDebugAdapter` from new file

### Modified: package.json
- [ ] `contributes.debuggers` with type `"wolfram"`, label, language, configurationAttributes
- [ ] `contributes.breakpoints` for language `"wolfram"`
- [ ] Remove `&& !inDebugMode` from step keybinding `when` clauses

### Verification
- [ ] Debug Cell → Run and Debug sidebar opens automatically
- [ ] First pause: native floating toolbar appears with step buttons
- [ ] F10 via native toolbar steps through statements
- [ ] F11 steps into inner loops
- [ ] Shift+F11 steps out to parent
- [ ] F5 continues to next breakpoint
- [ ] Shift+F5 stops debug session
- [ ] Call Stack panel shows depth frames
- [ ] Variables panel shows iterator vars and watch vars
- [ ] Debug Console REPL evaluates Wolfram expressions
- [ ] Hover over variable in editor shows value
- [ ] Native gutter breakpoint + Continue stops there
- [ ] Run menu items are active during session
- [ ] Timing decorations (⏱) still appear and persist
- [ ] Yellow highlight still appears on current step
- [ ] ⏳ pending indicator still appears during step execution
- [ ] Watch Panel still updates alongside native panels
- [ ] Print/message capture in cell output still works
- [ ] Auto-advance to next cell still works
- [ ] Cell edit → restart prompt still works
- [ ] Stop then Shift+Enter executes cell normally
- [ ] `_dynDialogMutex` still prevents Dynamic race conditions