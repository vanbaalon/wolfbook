# Wolfbook AI Compatibility — Development TODO

A step-by-step plan to make Wolfbook maximally useful with GitHub Copilot.
Each task is self-contained. Work through them in order — later tasks build on earlier ones.

---

## Phase 1 — Expose outputs to AI (quick wins)

### TODO-1a: Expose symbolic outputs as `text/plain` MIME alongside HTML

**Goal:** Every symbolic cell output is currently stored *only* as `x-application/wolfram-language-html`
containing a base64-encoded LaTeX string inside a `data-latex-b64` attribute. Copilot cannot read this.
The fix is to decode that base64 LaTeX at the point where outputs are stored and attach it as an
additional `text/plain` MIME item on the same `NotebookCellOutput`. Copilot (and `#file` context)
will then see clean LaTeX like `Out[16]= -Q_{1,2}(u) + \mathbb{P}_1(u+i/2)...` instead of nothing.

**Implementation note:** Three output modes exist in `processWLLatexBoxes`: Mode A (prerendered
KaTeX — `vscode-wolfram-wllatex-prerendered`), Mode B (raw latex div — `vscode-wolfram-wllatex-raw-latex`
with `data-latex-b64`), Mode C (src latex div — `vscode-wolfram-wllatex-src-latex` with `data-latex-b64`).
Modes B and C already store `data-latex-b64`. Mode A must be patched to also embed `data-latex-b64`
on the prerendered div so that all three modes are handled uniformly by `extractPlainText`.

**Where to change:** `output/renderer.js` — add `data-latex-b64` attribute to the Mode A prerendered
div in `processWLLatexBoxes`, and add an `extractPlainText(html, outName, isGfx, cellSource)` helper.
Then, in `execution/checkout.js`, call `extractPlainText` after HTML is built (before truncation/wrapping)
and attach the result as a second `text/plain` item on each `NotebookCellOutput`. Also in the
`deserializeNotebook` serializer, so that notebooks loaded from disk retroactively expose their stored
outputs via the same helper.

**Format of the text/plain string:** `Out[N]= <latex string>` — mirroring the label already shown
in the output header.

**Test:**  Create a test notebook with different types of cells, evaluate them and check.

---

### TODO-1b: PNG/graphics outputs — emit WL source as `text/plain` fallback

**Goal:** When an output is a PNG image (no LaTeX available), the AI currently sees nothing.
For graphics outputs, attach a `text/plain` item containing the cell source expression that
produced the output, prefixed with a comment like `(* output: graphics *)`. This tells Copilot
*what was computed* even if it cannot see the image.

**Where to change:** Same output-storage path as TODO-1a, but branching on the `data-output-is-graphics="1"`
marker already present in the HTML header.

**Test:** Find the one PNG output in QQrelations (Out[401], a big shifted-determinant expression).
After the fix, `#file` context should include a readable description of that cell's computation
rather than a blank.

---

### TODO-1c: Suppress spurious outputs on markdown cells

**Goal:** Several markdown cells (the `### $\boxed{...}$` headings) accumulate kernel outputs:
a `ToExpression::sntx` warning and a `No output at Out[607]=` placeholder. These are noise that
pollutes AI context and wastes tokens. The outputs should be filtered out at serialization time —
markdown cells should never have their outputs written to the `.evsnb` file.

**Where to change:** The `serializeNotebook` function. Skip writing the `outputs` array for any
cell with `kind === NotebookCellKind.Markup`.

**Test:** run a notebook with makrdown cells grep the raw JSON for `ToExpression::sntx`. It should
not appear. Also confirm the notebook renders identically to before.

---

### TODO-1d: Stop evaluating markdown cells in the kernel

**Goal:** The root cause of TODO-1c is that markdown cells are being sent to the kernel at all.
The controller's `executeHandler` should check cell kind and immediately return without evaluation
for `NotebookCellKind.Markup` cells. This also eliminates the `ToExpression::sntx` warning
appearing live in the notebook. Also we should make sure that the markdown cells are exposed to copilot in a clear readable format and the language marked correctly making it absolutely clear to copilot on their content and the format.

**Where to change:** The `executeHandler` in the notebook controller, add an early return for
Markup cells.

**Test:** Select a markdown cell containing a `$\boxed{...}$ equation and press Shift+Enter.
No output should appear, no amber warning, and the kernel should remain idle.

---

### TODO-1e: Expose kernel error/warning messages as `text/plain`

**Goal:** Kernel messages (amber `::` warnings like `Set::wrsym`, `ToExpression::sntx`,
`General::stop`, recursion-limit errors, etc.) are currently stored only as
`x-application/wolfram-language-html`. Copilot sees a blank where the warning is. The fix is to
add a `text/plain` MIME item containing the raw message string on every message output, so Copilot
can read the warning and suggest a fix — the same way it handles Python exceptions.

**Where to change:**
- `execution/checkout.js` — two sites:
  1. `onMessage` callback (fires during normal evaluation): add `text/plain` item with `msg`
  2. `renderResult.messages` loop (fires during `VsCodeRender[]`): add `text/plain` item with `renderMsg`
- `output/renderer.js` — `extractPlainText`: add a fallback branch matching
  `vscode-wolfram-message-output` divs for retroactive extraction from saved files.

**Status: ✅ Implemented in v2.1.0**

**Test:** Evaluate `1/0` or `x = 1; x = 2` (Protected symbol). The amber warning that appears
should be visible in `text/plain`. The inspector cell in the test notebook will confirm.

---

### TODO-1f: `run_notebook_cell` Copilot tool support

**Goal:** The VS Code Copilot `run_notebook_cell` tool works with `.wb` notebooks but requires
the **full cell ID including the `#` prefix** (e.g. `#VSC-9408b581`), exactly as returned by
`copilot_getNotebookSummary`. Without the `#` the tool returns "Cell not found". This is already
working — no code change needed. Document for future reference.

**Status: ✅ Working — use `#VSC-XXXXXXXX` format from `copilot_getNotebookSummary` output**

---

### TODO-1g: Dynamic cell outputs — prevent AI confusion

**Goal:** `Dynamic[...]` cells produce a live-updating widget. The stored output HTML contains a
placeholder div with `data-dynamic-id` and no semantic content. When Copilot reads this it sees
nothing useful, or worse, may misinterpret the widget scaffolding as meaningful code. Two problems:

1. **No readable snapshot.** There is no `text/plain` attached, so Copilot has no idea what the
   Dynamic expression currently displays.
2. **Stale output on reload.** The last-rendered frame of a Dynamic widget is meaningless after
   the kernel is gone — it shows a frozen state from a previous session.

**Proposed fix:**
- In `execution/checkout.js` / `_startDynamicCell`: when writing the initial Dynamic placeholder
  output, attach a `text/plain` item:
  `(* Dynamic output — expression: <cell source> — live value not available in static context *)`
- In `cleanupImgDir` or a new `prepareForSave` hook: strip Dynamic outputs entirely before save
  (they are useless without a running kernel), similar to how markdown outputs are stripped.
  Leave a `text/plain` note instead.
- Alternatively, on each Dynamic tick, update the `text/plain` item with the current
  `InputForm` value so Copilot always sees the last known value.

**Status: 📋 Planned — implement after Phase 1 is fully stable**

---

## Phase 2 — Give Copilot a clean notebook transcript

### TODO-2a: On-demand AI transcript (generated by tool, not auto-saved)

NOTE: do not implement only do the 4a form the memory option, no file

**Goal:** A clean, human- and AI-readable transcript of the entire notebook: section headings
from markdown cells, code cell sources, and outputs as `text/plain` (the strings from TODO-1a).
Images are replaced with `(* graphics output *)`.

**Design decision:** The transcript is generated **on demand** only — either when the
`wolfbook_getNotebookContext` tool (TODO-4a) is called, or when the user explicitly invokes a
"Save transcript" command. There is **no background watcher and no auto-save on every notebook
save**. This keeps the implementation simple and avoids constant file I/O for large notebooks.

The tool in TODO-4a is the primary consumer (returns the transcript in-memory to Copilot). The
optional "Save transcript" command writes it as `<notebook-name>.md` next to the notebook file
as a convenience for `#file` context inclusion — but this is a one-shot action, not a watcher.

**Format:**
```
# <notebook title>

## [markdown] Cell#
<markdown source>

## [wolfram] Input Cell#
## [wolfram] Out[10]–Out[13]
<code source>

### Outputs
Out[10]= <latex>
Out[11]= <latex>
...
```

---

### TODO-2b: Per-cell `aiSummary` metadata field in the `.evsnb` and `.wb` format

NOTE: do not implement - looks too hard to maintain

**Goal:** Add an optional `metadata.aiSummary` string field to each cell in the `.evsnb` JSON.
Initially this is auto-populated from the cell's `text/plain` output (TODO-1a) and input. Later it can be
user-edited (e.g. to add a sentence explaining the mathematical purpose of a cell). The sidecar
(TODO-2a) and future tools (Phase 4) use this field as a first-class source of context.

We should think about details of the interface here - may be some small (i) button which reveals the summary?
Can we make copilot to populate it with the cheap models (like the one used for autocoplition)?

---

## Phase 3 — Fix markdown editing experience for Copilot

### TODO-3a: Verify all markdown cells use `languageId: 'markdown'`

**Goal:** Copilot inline completion activates in notebook cells when `languageId === 'markdown'`.
Audit every code path that creates a new cell (paste, insert above/below, deserializer) to confirm
markdown cells always get `languageId: 'markdown'` and never a custom or empty string.
Also currently there is diff noise when changing the language of markdown cell to markdown - needs to be removed.
And copilot does not suggest complition for markdowns. This seems to be disabled for Python notebooks too, but we need to enable this, may be with a new type of cell?

**Where to change:** Cell creation helpers and the deserializer's mapping logic.

**Test:** Create a new markdown cell. Start typing `## ` — Copilot should offer inline completions
for a section heading. Also open the `.evsnb` JSON and confirm all `kind: 1` cells have
`"languageId": "markdown"`.

---

## Phase 4 — Custom Copilot Tools

All four tools are registered in `package.json` under `contributes.languageModelTools` and
implemented as classes in the extension. They become available in Copilot agent mode and can be
invoked as `#toolName` in chat. Would be good to make copilot avare about the tools available automatically and make them readily available.

### TODO-4a: Tool `wolfbook_getNotebookContext`

**Goal:** A tool that returns the full AI transcript of the currently active notebook (the same
content as the sidecar from TODO-2a, but live and reflecting the current in-memory state including
any unsaved changes). Copilot's agent mode calls this automatically to orient itself before
generating or editing WL code.

**`modelDescription` (the text the LLM uses to decide when to call this):**
*"Returns a structured text representation of the currently open Wolfram Language notebook.
Includes all cell sources (code and markdown), section headings, and cell outputs as LaTeX.
Use this before writing or editing Wolfram Language code to understand what symbols are already
defined, what has been computed, and what the mathematical goal of the notebook is."*

**`inputSchema`:** No inputs required.

**Output format:** The sidecar transcript format from TODO-2a.


### TODO-4b: Tool `wolfbook_evaluateExpression`

**Goal:** A tool that sends a WL expression string to the live kernel and returns the result. 
Copilot can use this to verify that
code it is about to suggest actually evaluates to what it expects — crucial for a correctness-
sensitive mathematical notebook. This should trunkate too long outputs to make sure the context is not overloaded (showing corresponding message when trunkation is applied - may provide paging for the model as a parameter?)
Include timeout as input parameter.

**`modelDescription`:**
*"Evaluates a Wolfram Language expression in the active notebook's live kernel and returns the
result as LaTeX or InputForm text. Use this to verify that an expression simplifies correctly,
check that a residual is zero, or explore the output of a function before inserting code into
the notebook. Do not use for long-running computations."*

**`inputSchema`:** `{ expression: string }` — a valid WL expression. File paths should be absolute.

**Output format:** `Out= <latex or InputForm>`, or an error string if evaluation fails or times out
(suggested timeout: 10 seconds).

**Confirmation message shown to user before invocation:**
`Evaluate in kernel: <expression>` — so the user can see and approve what will run.

**Test:** In Copilot chat type "does BBrel[{},{},u]/.slP simplify to zero?". The agent should
call this tool with `Simplify[BBrel[{},{},u]/.slP]`, receive `0`, and confirm yes.


---
# STOP HERE do not implemente phase 5 yet

## Phase 5 — `@wolfbook` Chat Participant

### TODO-5a: Register a `@wolfbook` chat participant

**Goal:** A dedicated Copilot chat participant (`@wolfbook`) that users invoke directly. It
automatically calls `wolfbook_getNotebookContext` (TODO-4a) on every request, prepending the
notebook transcript to the system context. It also carries a fixed system prompt encoding the
notation conventions of this codebase:

- `Q[a][i][u]` means $Q_{a|i}(u)$
- `slP` is the substitution rule renaming internal `Q[...]` to the blackboard-bold notation
- `[u+I/2]` means $f^+(u) = f(u+i/2)$
- The BB/FF/BF taxonomy of QQ-relations
- The pattern that residuals should simplify to 0 after applying `/.slOrder/.slP`

**`description` shown in chat:** *"Ask questions about your Wolfram Language notebook, get help
writing WL code, verify mathematical results, or extend the notebook with new computations."*

**Test 1 (context):** `@wolfbook what is the current definition of G[u]?` — should answer from
the notebook without needing `#file`.

**Test 2 (code generation):** `@wolfbook write a cell that verifies all 16 BF relations are zero`
— should generate correct WL using `Table[BFrel[a,i,A,J,...]]` syntax consistent with the notebook.

**Test 3 (mathematical):** `@wolfbook explain what slQai encodes mathematically` — should explain
that it is the solution for the mixed Q-functions $\mathbb{Q}_{a|i}$ in terms of the edge functions.

---

## Running checklist

- [ ] TODO-1a: `text/plain` LaTeX output item  
- [ ] TODO-1b: `text/plain` fallback for PNG outputs  
- [ ] TODO-1c: Don't serialise markdown cell outputs  
- [ ] TODO-1d: Don't evaluate markdown cells  
- [ ] TODO-2a: Sidecar `.evsnb.md` transcript  
- [ ] TODO-2b: Per-cell `aiSummary` metadata  
- [ ] TODO-3a: Verify markdown `languageId`  
- [ ] TODO-4a: Tool `wolfbook_getNotebookContext`  
- [ ] TODO-4b: Tool `wolfbook_evaluateExpression`  
- [ ] TODO-4c: Tool `wolfbook_lookupSymbol`  
- [ ] TODO-4d: Tool `wolfbook_insertCell`  
- [ ] TODO-5a: `@wolfbook` chat participant