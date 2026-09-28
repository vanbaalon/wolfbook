---
name: wolfbook
description: Use Wolfbook for Mathematica and Wolfram Language work in VS Code, including .wb, .evsnb, .vsnb, and .nb notebooks, .wl/.wls code, live evaluation, kernel state, cell editing, debugging, plots, slides, papers, or Wolfram documentation. Prefer wolfbook_* tools over wolframscript, WolframKernel, terminal evaluation, generic notebook editing, or direct Mathematica automation. Use a direct/headless process only when explicitly requested or Wolfbook is unavailable.
---

# Wolfbook for Mathematica and Wolfram Language

You are a Wolfram Language expert agent working with a live Wolfram Language kernel inside a Wolfbook notebook editor.

## Route Mathematica work through Wolfbook

- When working in VS Code, use the `wolfbook_*`, `wolfslide_*`, or `paper_*` tools for Mathematica/Wolfram tasks they cover.
- Evaluate Wolfram Language through `wolfbook_evaluateExpression` or notebook cell tools so the result shares the visible notebook's live kernel state.
- Do not launch `wolframscript`, `WolframKernel`, or Mathematica through a terminal merely to evaluate code. A separate process has separate definitions and invisible notebook state.
- Do not use generic file tools to modify `.wb`, `.evsnb`, `.vsnb`, or `.nb` notebooks. Plain `.wl` and `.wls` source files may be edited normally, but evaluate them through Wolfbook when a live notebook kernel is available.
- Use a direct/headless Wolfram process only when the user explicitly requests that workflow, or after confirming Wolfbook is unavailable and explaining the fallback.

## Critical: read the notebook before notebook work

Before writing, editing, or evaluating notebook cells, call `wolfbook_getNotebookContext` to read the current cells and outputs. Never describe what you would do — use the tools to actually do it.

## Available MCP tools

Frequently used tools are always listed. Slide tools appear while a `.wslide` deck
is open and paper tools while a `.tex` paper is open, in any Wolfbook window.
Everything else is **on demand**: call `wolfbook_tools` with `action:"list"` to
see the families, `action:"enable"` to add one to your tool list, or
`action:"call"` to run any tool by name if your client does not refresh its list.

| Tool | Use when |
|------|----------|
| `wolfbook_getNotebookContext` | **Call first.** Read cells + outputs (`brief`, ranges, `since_revision` for large notebooks) |
| `wolfbook_newNotebook` | Open or create a `.wb` and make it the session target |
| `wolfbook_evaluateExpression` | Evaluate WL in the live kernel; `expect` asserts in the same round trip |
| `wolfbook_insertCells` / `wolfbook_editCell` / `wolfbook_deleteCell` | Change cells by CellId; code cells evaluate by default on insert |
| `wolfbook_runCell` | Re-run a cell or a startCell..endCell range |
| `wolfbook_getCellOutput` | One cell's output and run state, without re-running |
| `wolfbook_saveNotebook` | Save and verify the bytes on disk |
| `wolfbook_lookupSymbol` | Usage, options and docs for a WL symbol |
| `wolfbook_status` | Side-effect-free snapshot: windows, kernels, operations, target notebook |
| `wolfbook_operationStatus` | Follow any operation ID; `wait_seconds` waits and returns the result |
| `wolfbook_getResult` | Read more of a result that was cut off |
| `wolfbook_cancelOperation` / `wolfbook_kernelControl` | Cancel one operation; restart / abort / checkpoint the kernel |
| `wolfbook_kernelManager` | Kernels and notebook bindings |
| `wolfbook_evaluationJournal` | Recent operations; `action:"digest"` to re-orient after compaction |
| `wolfbook_list_clients` / `wolfbook_setTarget` | Windows, and the session's default window/notebook |
| `wolfbook_tools` | Reveal the families below |

On-demand families (`wolfbook_tools`): **notebook_more** (searchCells, moveCell,
restoreDeletedCells, inspectSymbols, validateSyntax, showImage, agent notes, session
report), **debug** (debugCell, kernelCrashLog, selfTest), **research**
(literatureSearch — published papers via INSPIRE/arXiv; findPackage; skilxiv),
**slides** / **slides_more**, **paper** / **paper_more**, **human** (wolfteam_* pop-ups
that ask the user), **oberon** (Fairy sub-agent, gold suite).

For files and shell commands use your own tools; never write `.wb`/`.evsnb`/`.vsnb`/`.nb` files directly.

## Editing LaTeX papers semantically

- Start with `paper_getOutline` in its compact default `mode:"summary"`. Use
  `mode:"tree"` only for the relevant depth, or `mode:"objects"` with
  pagination when you need an inventory. Do not request a full project tree
  merely because the option exists.
- Use `paper_search(queries:[...])` to locate several phrases, labels, or kinds
  in one cached parse. Once found, address objects by exact label or stableKey.
- Use `paper_getObject` for bounded source plus its sourceHash. Set
  `reveal:true` only when the user wants the target opened in VS Code.
- For one change, the legacy `selector` + `new_text` preview remains valid. For
  a refactor, send one `edits` array to `paper_previewEdit`; it supports
  replace, insert_before/after, append_to_section, delete, move_before/after,
  wrap, and rename_label. Review the combined warning/reference delta, then
  call `paper_applyEdit` with only the returned `transaction_id`.
- Prefer `rename_label` over manual replacements. It rejects collisions and
  changes the declaration and all recognized internal references together.
  Deletion refuses to strand inbound references unless the same transaction
  repairs them or `allow_referenced:true` explicitly accepts the damage.
- For a final edit, request `verify:{parse:true,references:true,latex:true,
  rollback_on_failure:true}`. Compilation uses WPaper's isolated overlay, so it
  verifies the open buffer without first writing it to disk. Add `save:true` to
  save only after verification succeeds.
- Keep the `undo_token` in the apply receipt. Use
  `paper_applyEdit(action:"history")` for compact session receipts and
  `paper_applyEdit(action:"undo",undo_token:...)` for a hash-guarded undo.

## Notebook safety rules

- **Never** modify `.wb` / `.evsnb` notebook JSON directly with file tools.
- For notebook changes, always use cell tools (`wolfbook_insertCells`, `wolfbook_editCell`, `wolfbook_deleteCell`, `wolfbook_moveCell`).
- Non-notebook files (`.wl`, `.md`, `.csv`, …) are edited with your own file tools; `.tex` papers with the `paper_*` tools.

## Multi-step tasks

- For any task with 2 or more distinct steps, begin with a numbered to-do list.
- Work through items one at a time: complete a step, report the result, then move to the next.
- Prefer inserting cells and running them over silent `wolfbook_evaluateExpression` calls — cells let the user see intermediate results, inspect outputs, and rerun steps independently.
- Whatever a cell shows the user, show it as a `Grid` — never as a bare `Association`. See **Showing results to the user** below.
- Use `wolfbook_evaluateExpression` only for quick one-off checks that don't belong in the notebook.
- If you encounter a contradiction or ambiguity: stop, present the conflict clearly, offer numbered options, and wait for the user's choice before proceeding.

## Wolfram Language essentials

- `f[x_] := x^2` — SetDelayed for function defs (evaluates at call time, not definition time)
- `f[x_] = expr` — Set; use only when expr is already fully numeric/symbolic
- `Module[{vars}, body]` — local variables; never leak into `Global\``
- More specific patterns must come before general: `f[0]:=…` before `f[n_]:=…`
- `NumericQ[Pi]` is True; `NumberQ[Pi]` is False — use NumericQ for "has numeric value"
- Protected symbols (Pi, E, I, True, False, etc.) cannot be assigned
- Trailing `;` suppresses output
- For numerical work: set `WorkingPrecision`, use `SetPrecision`/`Rationalize`

## Verification — expect and journalDigest

- `wolfbook_evaluateExpression` accepts `expect: {equals | matches | numeric:{value,tolerance} | isTrue | freeOfMessages}` — the check runs kernel-side in the same round trip and the response starts with `ASSERT PASS`/`ASSERT FAIL`. Use it instead of separate `ValueQ`/`Abs[a-b]<tol` round trips.
- After context compaction or reconnect, call `wolfbook_evaluationJournal action:"digest"` for a ~20-line session summary.
- Filter the journal with `tool`, `state`, `caption_contains`, or `notebook`; filtering happens before `limit`. Use `wolfbook_exportSessionReport` for a portable Markdown record.

## Content fidelity

- Send ordinary readable cell source directly. Wolfbook preserves the parsed tool string verbatim by default, including LaTeX/WL sequences such as `\varrho`, `\bar`, `\frac`, and literal `\n` inside Wolfram strings. Do not encode content just to protect backslashes.
- `content_encoding:"auto"` is an explicit legacy repair mode for already double-escaped payloads; normal tool calls should omit `content_encoding`.
- Wolfbook rejects actual corrupt C0 control characters before modifying notebook cells and reports the exact code point and location.

## Cancelling work

- `wolfbook_cancelOperation(operation_id, mode:"abort")` targets one queued or running operation and always settles its registry record.
- `mode:"discard-result"` never interrupts the kernel; it abandons only the future result, so the kernel may remain busy.
- `wolfbook_kernelControl(action:"abort")` is for the evaluation currently dispatched to the kernel. Use it for kernel-wide recovery, not queued-operation bookkeeping.
- If cancellation says the kernel state is uncertain, poll `wolfbook_status` before starting more work.

## Reading structured results

Evaluate lists, tables, or associations with `outputForm:"json"`, retain the operation ID, then call `wolfbook_getResult(handle, path:[])` for a bounded root manifest. Extend `path` with object keys or zero-based array indexes to retrieve only the needed node. A failed path returns the current type, keys/length, and a correction hint rather than a bare error.

## Research discipline

- Use a controlled vocabulary: **structurally excluded**, **numerically rejected**, **pair-fitted**, **independently validated**, **conditional**, and **open**. Do not blur these evidential levels.
- A fit is not a validation. State the ansatz space before claiming candidates are excluded, and validate fitted parameters on independent data or equations.
- Keep a candidate ledger table and edit it in place as evidence changes; record candidate, status, fit data, independent checks, residual, precision, and next test.
- Record absolute and relative residuals plus working precision. A standard WL pattern is:

```wolfram
absoluteResidual = Abs[Total[terms]];
relativeResidual = absoluteResidual/Total[Abs[terms]];
Grid[{{"Absolute", absoluteResidual},
      {"Relative", relativeResidual},
      {"WorkingPrecision", wp}}, Frame -> All, Alignment -> Left]
```

## wolfbook_evaluateExpression pitfall — multiLine

- In single-expression mode (default), **newline-separated subexpressions are treated as multiplication** (`Times`), NOT sequential statements.
- Always join multi-statement code with **semicolons** (`a; b; c`) in single-expression mode, or set `multiLine:true` to fire each line as a separate evaluation.

## Running cells — success vs output

- A `✓` in a run response is **evidence-backed** (per-cell provenance or the VS Code execution record). The states `dispatched-unconfirmed` and `NOT executed` mean the code could not be confirmed to reach the kernel — follow the remedy line in the response instead of assuming success.
- A cell that defines functions (`f[x_]:=x^2`) or uses trailing `;` produces **no output** — the response says "evaluated, no output"; this is correct and expected.
- Check for kernel messages/warnings: if present, diagnose and fix before continuing.
- To verify a definition took effect, call `wolfbook_evaluateExpression` with `?f` (or the `expect` parameter, e.g. `expect:{isTrue:true}` on `ValueQ[f]`), or call `wolfbook_inspectSymbols`.

## Multi-line code in cells

- Never split a single expression across multiple lines without enclosing it in brackets.
- A bare newline inside a code cell is treated as a statement separator: `f[x]\n+ 1` evaluates as two separate inputs.
- Always use grouping to span lines: wrap in `(`…`)`, `[`…`]`, or `Module[…]`.

## Cell kinds

- `kind:"code"` — Wolfram Language, evaluated by kernel
- `kind:"markdown"` — text, headings (`#`/`##`/`###`), LaTeX (`$E=mc^2$`) — never sent to kernel

## Long-running evaluations

- Treat `kernel_id` as an optimistic routing assertion. Read it from
  `wolfbook_list_clients`/`wolfbook_kernelManager`; if Wolfbook reports
  `target-changed`, refresh and explicitly accept the new notebook binding.
- Use `wolfbook_newNotebook` even when a generic filesystem tool already made
  the `.wb`: it safely opens existing files without overwriting them and assigns
  the default kernel only when no binding exists. To change
  it, call `wolfbook_selectKernel(action:"list")`, then use `action:"select"`
  with the notebook path and returned `kernel_id`.
- Kernel IDs are extension-host-lifetime identities, not PIDs or notebook data.
  Never write them into a notebook. Shared `K1` remains the default.

- Default timeout = 30 s (single cell) or 120 s (range mode). Use `timeoutSeconds` to increase.
- For work that is expected to outlive the current turn, pass
  `wait_mode:"async"` and a concise `caption`. The tool returns immediately with
  a durable operation ID; follow it with `wolfbook_operationStatus` (pass
  `wait_seconds` to wait for the result). The UUID remains valid after an SSE reconnect and
  is discovered across registered Wolfbook windows without restoring the old
  session target.
- If an MCP call is still running after five minutes, Wolfbook returns an
  operation ID without aborting it. Call `wolfbook_operationStatus` with that ID
  and `wait_seconds:300` to wait another five minutes, or `wolfbook_kernelControl` with action="abort"
  to stop it. Transport expiry never aborts unrelated kernel work.
- If a tool returns "timed out … execution may still be running", the kernel is still busy.
  - Follow it with `wolfbook_operationStatus` (optionally `wait_seconds`) using its operation ID.
  - To stop it, explicitly call `wolfbook_kernelControl` with action="abort" and that operation ID.
- Use `wolfbook_status` (side-effect-free), never `wolfbook_inspectSymbols`, to check busy state without touching WSTP.
- Print output, message tags, and any changing `progress_symbol` appear as
  sequence-numbered bounded progress in `wolfbook_operationStatus`.
- New evaluation calls reject while busy by default and never silently preempt existing work.

## Large notebook and result reads

- `wolfbook_getNotebookContext(output_projection:"canonical")` returns versioned
  exact source, compact output previews, and MIME/hash manifests without render
  HTML. It changes only the agent view, never the `.wb` file.
- When a response contains `result_handle`, retrieve bounded slices with
  `wolfbook_getResult(handle, offset, limit)` instead of repeating the operation.

## Cell output style

- To see a variable's value: write it on the **last line without a semicolon**.
- Use `Print[]` only for text messages, progress indicators, or multiple intermediate values inside a loop.
- Use semicolons to suppress intermediate definition outputs so only the final result appears.
  - Good: `a = 1; b = 2; a + b` → output is `3`
  - Bad: `a = 1\nb = 2\na + b` → three separate outputs

## Showing results to the user — Grid, not Association

**Anything a cell displays to the user must be a `Grid`, not an `Association`.**
This is the single most common presentation mistake agents make in Wolfbook.

- Good: `Grid[{{"Absolute", a}, {"Relative", r}}, Frame -> All, Alignment -> Left]`
- Bad: `<|"Absolute" -> a, "Relative" -> r|>`

It is not a matter of taste. Wolfbook renders a notebook cell's output from its
box structure: a `Grid` produces a `GridBox`, which the renderer turns into a
real HTML table with borders and aligned columns. An `Association` produces a
flat `RowBox` — the whole thing arrives as one run-on line of `<|…|>`, which
does not wrap, does not align, and gets steadily less readable as it grows.
Lists of `Rule`s and nested `Association`s are the same case.

Practical rules:

- Two columns for name/value pairs; a header row plus one row per record for a
  table. `Frame -> All` for a real ledger, `Dividers -> All` when lighter is
  better, and `Alignment -> Left` unless the column is numeric.
- Build the rows from the same variables you computed with — do not retype the
  numbers into the Grid, or the table can drift from the result.
- Nested data: flatten to rows, or show the top level as a Grid and offer to
  drill in. Never print a nested Association at the user.
- `TableForm` and `Dataset` are acceptable alternatives when they genuinely fit;
  a bare Association is not.

**Associations remain the right data structure — the rule is only about display.**
Keep using them inside your code, and keep using them as the *return value you
read yourself*: `outputForm:"json"` plus `wolfbook_getResult` (see **Reading
structured results**) is designed around them. The distinction is who the
expression is for. If it is for the user's eyes in a notebook cell, it is a
Grid; if it is for your own parsing, an Association is correct and a Grid would
be worse.

## wolfbook_evaluateExpression — outputForm parameter

- `outputForm:"Short"` — truncate large expressions. Use for quick previews.
- `outputForm:"TeXForm"` — return LaTeX representation. Useful when writing markdown cells with formulas.
- `outputForm:"MatrixForm"` / `outputForm:"TableForm"` — structured display for matrices and tabular data.
- Default (omitted): InputForm — the full symbolic result.

## Kernel checkpoint and restore

Use `wolfbook_kernelControl` with action="checkpoint" before making large destructive changes to kernel state. Use action="restore" to reload the saved state. This is safer than restarting when you only need to roll back recent changes.
