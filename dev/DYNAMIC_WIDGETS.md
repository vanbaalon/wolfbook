# Dynamic Widgets — Architecture and Implementation

## 1. What `Dynamic[expr]` does in Wolfbook

When a cell contains `Dynamic[expr]`, the expression is **never sent to the kernel for evaluation**.

Instead, the checkout loop detects it (by pattern matching the text), skips it in the main evaluation, and after the cell finishes running starts a background **widget loop** that periodically samples the kernel state by entering a `Dialog[]` session.

This means:

```wolfram
Do[Print[n]; Pause[1], {n, 1, 100}]   (* runs in kernel *)
Dynamic[n]                              (* widget loop on JS side *)
```

Both can coexist: the `Do` loop runs while the widget loop periodically interrupts it, enters Dialog[], reads `n`, exits Dialog[], then lets the Do loop resume — all transparent to the user.

---

## 2. Full lifecycle of a Dynamic cell

### 2.1 Detection (checkout loop, `checkoutExecutionQueue`)

In `_splitTopLevelExprs(code)`, each top-level expression is scanned. An expression is marked `isDynamic` if it matches `/^\s*Dynamic\s*\[/`. Each is assigned a `slotIndex` corresponding to its position in the cell's output array.

Dynamic expressions are **skipped** in the main eval loop (they are not sent to `session.evaluate()`). A placeholder output is appended at their `slotIndex`.

### 2.2 Widget loop launch

After `executionQueue.end()` (the cell evaluation is complete from VS Code's perspective), `_startDynamicCell(cell, dynExprs, imgDir, imgRel, null)` is called. This registers the widget in `this._dynamicWidgets` (keyed by cell URI) and starts the `runLoop` async function.

### 2.3 `runLoop` — the core repeating cycle

Every ~300ms (idle) or immediately after a dialog cycle (busy), the loop runs:

```
busy? ──no──→ show 'paused' badge (once on transition), sleep 300ms
       │
      yes
       │
_renderingActive? ──yes──→ sleep 150ms (kernel doing SVG/ExportString)
       │
      no
       │
isDialogOpen? ──yes──→ sleep 200ms (another widget cycle still open)
       │
      no
       │
acquire _dynDialogMutex ──→ (queues behind other widget loops and abort)
       │
interrupt kernel (session.interrupt())
       │
wait up to 2500ms for isDialogOpen == true
       │
dialogEval each slot:
  ToString[Quiet[ToExpression["<dynInner>"]],InputForm]
       │
exitDialog (up to 3 attempts)
       │
wait for isDialogOpen == false (up to 2s)
       │
release _dynDialogMutex
       │
update outputs via _putAllOutputs(htmlBySlot, 'live')
```

### 2.4 `busy` definition

```javascript
const busy = !this._abortPending
          && this.executionQueue.queue.length > 0
          && this.executionQueue.queue[0].started;
```

`busy=true` means there is an active kernel evaluation in the JS queue. Widgets only fire their interrupt cycle when busy. When the evaluation ends (queue drains), widgets go to `'paused'` state.

### 2.5 Widget termination

The loop exits when:
- `state.active === false` → set by `stopDynamicWidgets()` or kernel restart/epoch change
- `this._sessionEpoch !== epoch` → kernel was restarted; epoch is snapshot at loop start

---

## 3. The Dialog cycle in detail

### 3.1 Why Dialog[]?

The kernel is running user code (e.g. `Do[..., Pause[1]]`). To read a variable from it, we need to interrupt execution and inject a read. Wolfram's `Dialog[]` mechanism is the only way to do this safely: it creates a nested evaluation loop inside the running computation, allowing WSTP to send/receive packets while the outer computation is paused at the interrupt point.

### 3.2 How interrupt → Dialog[] is wired

In `init.wl`:
```wolfram
Off[Interrupt::dgbgn]; Off[Interrupt::dgend];
Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]];
```

When `session.interrupt()` sends a `WSInterruptMessage`, the kernel's interrupt handler fires `Dialog[]`. The WSTP C++ layer detects `BEGINDLGPKT` and sets `session.isDialogOpen = true`.

### 3.3 dialogEval expression

```wolfram
VsCodeRenderExpr[Quiet[CheckAbort[ToExpression["<escaped code>"], $Failed]], "Auto", 0.8]
```

- **`ToExpression["..."]`** — code is embedded as a WL string literal, so syntax errors or unmatched brackets in the dynamic expression cannot break the outer call. The string is escaped (`\` → `\\`, `"` → `\"`).
- **`CheckAbort[..., $Failed]`** — if an abort fires during evaluation (e.g. a recursive expression), returns `$Failed` cleanly instead of propagating the abort.
- **`Quiet[...]`** — suppresses any messages generated during evaluation. Without this, messages flow up through the global `$Messages` channel into the main WSTP packet stream, confusing the packet parser.
- **`VsCodeRenderExpr[..., "Auto", scale]`** — the same rendering pipeline as normal cell outputs:
  - Graphics/Graphics3D/Image → **SVG** (file-based, via `$wolframImgDir`)
  - All other expressions → **MathML** (or WLLatex if configured)
  - Falls back to InputForm `<pre>` block if all rendering paths fail
  - All internal `ExportString`/`Rasterize` calls are wrapped with `CheckAbort` so interrupts inside `Dialog[]` are safe
- The result is already HTML — `_fixImageUris()` is applied to rewrite relative `src=` paths to `vscode-resource://` URIs.
- `$wolframImgDir` is already set by the checkout loop's `VsCodeSetImgDir` call before `_startDynamicCell` is invoked, so SVG files are written to the correct per-notebook directory.
- Timeout is 12s (vs 8s for the old ToString path) to allow for SVG export of complex graphics.

### 3.4 exitDialog

`session.exitDialog()` sends `Return[]` into the Dialog[] loop, causing the kernel to emit `ENDDLGPKT` and resume the outer evaluation. Up to 3 attempts are made. After exit, we wait up to 2s for `isDialogOpen` to clear before releasing the mutex.

---

## 4. Concurrency and mutex

### 4.1 `_dynDialogMutex`

A promise-chain mutex. Each widget loop that wants to use Dialog[] does:

```javascript
const _prevDlg = this._dynDialogMutex;
this._dynDialogMutex = new Promise(r => _releaseDlg = r);
await _prevDlg;          // wait for previous holder
// ... interrupt, dialogEval, exitDialog ...
_releaseDlg();           // release for next waiter
```

This ensures only **one** widget loop holds the Dialog[] at a time across all cells, preventing nested `Dialog[]` sessions (which hang the kernel).

### 4.2 Multi-cell scenario

If two cells each have `Dynamic[...]` running simultaneously, their loops race. Whichever acquires `_dynDialogMutex` first gets the Dialog[] slot; the other waits ~150-300ms and retries. The mutex serialises both loops cleanly.

### 4.3 `_renderingActive` flag

Set to `true` around every `session.evaluate("VsCodeRender[N, fmt, scale]")` call in the checkout loop. Widget loops check this flag and skip their interrupt cycle during rendering.

**Why this is critical**: `VsCodeRender[N]` calls `ExportString[expr, "SVG"]` in the kernel. If a widget interrupt fires mid-`ExportString`, the abort propagates through `ExportString`'s internal state machine, potentially leaving the SVG/typesetting subsystem in a broken state. Subsequent calls return `$Aborted` or hang indefinitely.

The fix: give `_renderingActive` priority over the busy check. Widget loops do:

```javascript
if (this._renderingActive) {
    await new Promise(r => setTimeout(r, 150));
    continue;   // don't acquire mutex, don't interrupt
}
```

Rendering typically takes 0.5–3s. After it completes, `_renderingActive` is cleared in a `finally` block and widgets resume normally.

---

## 5. Abort handling

### 5.1 `_abortPending` flag

Set at the start of `abortEvaluation()`. Immediately makes widgets see `busy=false` so they switch to 'paused' state and stop sending interrupts without waiting for the current dialog cycle to finish.

### 5.2 Abort queues on `_dynDialogMutex`

`abortEvaluation()` takes a snapshot of the current mutex and replaces it with a new pending promise, then races it against a 2s timeout. The actual `session.abort()` call runs only after the current widget's dialog cycle finishes. This prevents calling `session.abort()` while `session.dialogEval()` is waiting — which would leave the kernel stranded with an open Dialog[].

### 5.3 `isAborting` guard

`isAborting` is set only when `hasActiveCheckout` is true (a checkout loop is alive and will receive the `$Aborted` packet). If the checkout loop has already finished, `isAborting` is not set (nothing to clear it), preventing a permanent stuck state.

---

## 6. Output rendering

`_putAllOutputs(htmlBySlot, status)` creates a single `NotebookCellExecution` and replaces the cell's outputs atomically, preserving static outputs (from non-Dynamic expressions) at their slot indices.

Each Dynamic slot shows:
```html
<!-- status badge ('live' green / 'paused' grey / 'waiting' amber) -->
<div class="wl-dyn-badge ...">● live</div>
<!-- value from ToString[Quiet[ToExpression["..."]], InputForm] -->
<pre style="...">{ 1, 2, 3, ... }</pre>
```

`lastBusy` prevents repeated `createNotebookCellExecution` calls while idle (every 300ms would spam VS Code's execution API and flicker the output gutter).

---

## 7. SVG warm-up at kernel launch

`init.wl` includes at the end:
```wolfram
Quiet[CheckAbort[ExportString[Graphics[{}], "SVG"], Null]];
```

This runs synchronously during `launchKernel` (before any cells or widgets exist), pre-initialising Wolfram's SVG/typesetting pipeline. Without it, the first `Plot[]` output takes 2–4 extra seconds as the pipeline initialises on demand — and if a Dynamic widget is already running at that moment, the initialisation can be interrupted.

All `ExportString`/`Rasterize` calls in `VsCodeRenderExpr` are wrapped with `CheckAbort[..., $Failed]` so an interrupt returns `$Failed` gracefully rather than corrupting pipeline state.

---

## 8. Known limitations

| Limitation | Notes |
|---|---|
| ~300ms–1s update rate | One dialog cycle per loop iteration. SVG rendering of graphics inside Dialog[] adds 0.5–3s per cycle depending on complexity. |
| Only `Dynamic[expr]` at top level | Nested `Dynamic` (e.g. inside `Row[]` or `Column[]`) is not detected. |
| Widget stops when eval ends | When the `Do[]` loop finishes, `busy=false` and the widget shows 'paused'. Unlike real Mathematica Dynamic, it does not auto-update when variables change in subsequent cells. |

---

## 10. Lifetime options — `LiveTime` and `LiveEvaluations`

### 10.1 Overview

Two options allow a Dynamic widget to self-destruct after a condition is met:

```wolfram
Dynamic[expr, LiveTime -> t]           (* stop after t seconds *)
Dynamic[expr, LiveEvaluations -> n]    (* stop after n dialog-cycle evaluations *)
Dynamic[expr, LiveTime -> t, LiveEvaluations -> n]   (* stop when EITHER fires *)
```

When the condition triggers:
1. The widget loop exits immediately.
2. **All outputs of the cell are cleared** (`replaceOutput([])`) — the Dynamic widget disappears from the notebook as if the cell was never executed.

This is intentionally different from an abort or kernel restart: the cell source remains intact and can be re-run.

### 10.2 `LiveTime -> t`

`t` is a positive real number (seconds). The clock starts when `_startDynamicCell` is called (immediately after the cell execution finishes). 

- The expiry is checked at the **top of every loop iteration** (before any interrupt/dialog work). This guarantees that no additional dialog cycle is initiated after the deadline.
- The last rendered value is **not** shown before clearing: the expiry fires at cycle start, so the widget disappears cleanly without a final flash.

Example: keeps the widget live for 30 seconds after the loop starts, then removes the output.
```wolfram
Do[Pause[1]; n++, {1000}]
Dynamic[n, LiveTime -> 30]
```

### 10.3 `LiveEvaluations -> n`

`n` is a positive integer. It counts the number of **cell-level dispatches** sent to the main Mathematica kernel that have occurred *after* this Dynamic widget started. Every time a cell is sent for evaluation (`_dispatchEpoch` increments), the counter advances. The widget expires — and its output is cleared — when the kernel goes **idle after the Nth dispatch** (i.e. the Nth evaluation has finished, the queue has drained). This means the widget stays live for the entire duration of the last counted evaluation and disappears once it completes.

This lets the user say "monitor variables for the next two evaluations only":

```wolfram
(* Run this, then run your two computation cells — widget disappears after the 2nd finishes *)
Dynamic[n, LiveEvaluations -> 2]
```

- **Does not count** the Dynamic cell itself.
- **Does count** aborted evaluations.
- A loop dispatched *before* the widget is NOT counted (its epoch increment already happened).
- Expiry fires in the `!busy` (idle) path, not at the start of the Nth cycle.

### 10.4 Combining both options

Both options can be present on the same `Dynamic[]`. The widget expires when **either** condition is first satisfied (OR semantics). Multi-slot cells use the most restrictive value across all slots: `liveTimeSec = min(LiveTime)`, `liveEvalLimit = min(LiveEvaluations)`.

Example: expires after whichever fires first — 30 seconds, or 2 cell dispatches:
```wolfram
Dynamic[n, LiveTime -> 30, LiveEvaluations -> 2]
```

### 10.5 Option parsing — `_splitTopLevelExprs`

`_splitAtTopLevelCommas(s)` splits a string at commas where bracket depth is zero (respecting nested `[`, `(`, `{`, strings). Called on the inner content of `Dynamic[...]`:

```
Dynamic[Plot[Sin[x n], {x, 0, 2 Pi}], LiveTime -> 10, LiveEvaluations -> 3]
inner = "Plot[Sin[x n], {x, 0, 2 Pi}], LiveTime -> 10, LiveEvaluations -> 3"
parts = ["Plot[Sin[x n], {x, 0, 2 Pi}]", "LiveTime -> 10", "LiveEvaluations -> 3"]
dynInner   = "Plot[Sin[x n], {x, 0, 2 Pi}]"
dynLiveTime  = 10
dynLiveEvals = 3
```

Each expression object returned by `_splitTopLevelExprs` gains two new fields:
- `dynLiveTime`  — number or `null`
- `dynLiveEvals` — number or `null`

### 10.6 Implementation summary (controller.js)

| Location | Change |
|---|---|
| `_splitAtTopLevelCommas(s)` (new method) | Helper: split string at depth-0 commas |
| `_splitTopLevelExprs` return | Parse opts; set `dynLiveTime`, `dynLiveEvals` |
| `_startDynamicCell` init | Compute `liveTimeSec`, `liveEvalLimit`, `_liveStartTime`, `_epochAtStart = this._dispatchEpoch` |
| `runLoop` top of while | LiveTime only: expire immediately when wall-clock deadline passes |
| `runLoop` top of `!busy` block | LiveEvaluations: expire when queue drains after the Nth dispatch (last eval has finished) |
| Expiry path | `replaceOutput([])` + `return` to clear widget output |

### 10.7 Syntax completion

A `registerCompletionItemProvider` in `extension.js` triggers on `,`, ` `, and `L` inside cells where the line prefix contains `Dynamic[` and a comma. Offers `LiveTime -> ` and `LiveEvaluations -> ` with descriptions.

---

## 9. Key flags and state

| Variable | Type | Purpose |
|---|---|---|
| `_dynDialogMutex` | `Promise` | Serializes dialog cycles across all widget loops |
| `_abortPending` | `bool` | Makes widgets see `busy=false` immediately on abort |
| `_renderingActive` | `bool` | Prevents widget interrupts during `ExportString` |
| `_dynamicWidgets` | `Map<uri, {active, epoch}>` | Registry of running widget loops |
| `_dynCells` | `Map<uri, {cell, outputs}>` | Per-cell output snapshot for `_putAllOutputs` |
| `_sessionEpoch` | `number` | Incremented on kernel restart; widgets exit on mismatch |
| `lastBusy` | `bool` (local) | Tracks busy→idle transition to avoid output spam |
