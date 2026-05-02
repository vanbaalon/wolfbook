# Wolfbook WB-Prefixed Functions

Wolfbook injects several custom Wolfram Language functions into the kernel at startup. These functions extend the standard WL environment with Wolfbook-specific capabilities — exporting notebooks, including files, interacting with AI agents, querying versions, and resolving notebook directories.

---

## `WBVersion[]`

Print version information for all Wolfbook components to the cell output.

**Usage:**
```wolfram
WBVersion[]
```

**Example output:**
```
Wolfbook extension : 2.7.0  (installed: 2026-04-25)
BTL (box-to-LaTeX) : 2.2.32  (built: 2026-04-25)
WSTP addon         : 1.1.29  (built: 2026-04-25)
Mathematica kernel : 14.2.0 for Mac OS X ARM (64-bit)
```

Use this to verify which versions are installed and detect stale component updates.

---

## `WBDirectory[]`

Returns the directory of the currently active Wolfbook notebook, analogous to Mathematica's `NotebookDirectory[]` but in the VS Code context.

**Usage:**
```wolfram
WBDirectory[]
```

This is automatically updated each time a cell is evaluated and reflects the directory of the notebook being evaluated. Protected against accidental overwrite.

---

## `WBInclude["path"]`

Import the contents of an external Wolfram Language or Mathematica notebook file as cells directly into the current notebook. The imported cells are inserted immediately after the `WBInclude` cell.

**Usage:**
```wolfram
WBInclude["path/to/file.wl"]
WBInclude["path/to/file.nb"]
WBInclude["path/to/file.m"]
```

**Supported file types:** `.wl`, `.wls`, `.m`, `.nb`, `.evsnb`, `.wb`

The converter uses the bundled `resources/convert_nb_to_vsnb.wls` script, which internally calls WolframScript to parse `.nb` files and convert them to Wolfbook's plain-text cell format. Markdown cells and code cells are both preserved.

**Example:**
```wolfram
(* Include utility functions from a shared library *)
WBInclude["~/wolfram-lib/utils.wl"]

(* Import a Mathematica notebook as editable cells *)
WBInclude["calculations.nb"]
```

> **Note:** `WBInclude` is intercepted by the extension before reaching the kernel — the file path must be a static string literal (no runtime evaluation). The kernel never sees the `WBInclude[...]` call; the extension handles it directly.

---

## `WBExport[]` / `WBExport["path"]`

Export the current Wolfbook notebook as a Mathematica `.nb` file or as a PDF.

**Usage:**
```wolfram
(* Export as .nb alongside the current .wb file *)
WBExport[]

(* Export as .nb to a specific location *)
WBExport["path/to/output.nb"]
```

**What gets exported:**
- Code cells become Mathematica `Input` cells
- Markdown cells become `Text` cells (with headings mapped to Section/Subsection/Subsubsection/Title styles based on `#` level)
- Outputs are **not** exported (the result is a clean, re-evaluatable notebook)

**Under the hood:** The extension calls `ExportString[Notebook[...], "NB"]` via a kernel session, using a reverse Unicode mapping to convert non-ASCII characters (é, α, etc.) back to `\[Name]` form for Mathematica compatibility.

> **Note:** Like `WBInclude`, `WBExport` is intercepted before reaching the kernel. The argument must be a static string literal.

---

## `WBPrompt["prompt"]` / `WBPrompt["prompt", "wolfbook"->True/False]`

Send a natural-language prompt to the AI agent from within a notebook cell. The extension opens the Copilot Agent Chat panel with your query pre-filled.

**Usage:**
```wolfram
WBPrompt["Explain this calculation and simplify the result"]

WBPrompt["Find the roots of this polynomial and plot them"]

WBPrompt["Refactor this code to use functional programming style"]

WBPrompt["Send without @wolfbook", "wolfbook"->False]
```

**Options:**
- `"wolfbook"->True` (default) — Routes the prompt to the `@wolfbook` chat participant, which has full access to kernel evaluation, documentation lookup, cell editing, and debugging tools.
- `"wolfbook"->False` — Sends the raw prompt to plain Copilot chat (no Wolfbook-specific context).

**What happens:**
1. The extension replaces the cell output with a "Sending to @wolfbook agent…" placeholder.
2. Copilot Agent Chat opens with the prompt pre-filled and submitted.
3. The agent can read the notebook, evaluate expressions, edit cells, and insert results.

**Example workflow:**
```wolfram
(* Define a complex expression *)
expr = Integrate[1/(x^4 + a^4), x]

(* Ask the agent to analyze it *)
WBPrompt["Simplify the result of the integral above and verify it by differentiation"]
```

**Common use cases:**
- Debugging errors — paste the error context and ask the agent to fix it
- Code refactoring — ask to rewrite procedural code in functional style
- Mathematical analysis — ask to verify, simplify, or extend a computation
- Documentation — ask to add comments and explanatory markdown cells

---

## `WBPrint[args…]`

Display an in-place updating status line within a cell evaluation. Unlike `Print[]`, which appends a new line for every call, `WBPrint` **replaces** its previous output on each call — ideal for loop progress indicators and live status updates.

**Usage:**
```wolfram
WBPrint[expr]
WBPrint[expr1, expr2, …]
```

**Examples:**
```wolfram
(* Loop progress bar *)
Do[
    Pause[0.2];
    WBPrint["Step: ", i, " / 20"],
    {i, 1, 20}
]

(* Live norm tracking *)
Do[
    v = RandomReal[{-1,1}, 10];
    WBPrint["Iteration ", i, ":  ||v|| = ", Norm[v]],
    {i, 100}
]
```

**Key behaviours:**
- Each `WBPrint` call **replaces** the previous WBPrint output for the same cell — there is only ever one WBPrint block visible at a time.
- The WBPrint block **disappears automatically** when any new cell starts evaluating (it is considered transient progress output).
- Accepts the same argument types as `Print[]`: strings, numbers, expressions, and `Graphics` objects. Multiple arguments are rendered inline on a single line.
- If you want output that **persists** after evaluation, use `Print[]` instead.

**Comparison with `Print[]`:**

| | `Print[]` | `WBPrint[]` |
|---|---|---|
| Multiple calls | Accumulates — one line per call | Replaces — only last call shown |
| After evaluation ends | Output remains | Output disappears |
| Best for | Logging results | Live progress / status |

> **Note:** `WBPrint` is defined in the Wolfbook kernel initialisation (`resources/init.wl`) and is available in all notebook cells without any explicit import.

---

## Summary

| Function | Purpose | Intercepted? | Kernel sees it? |
|---|---|---|---|
| `WBVersion[]` | Print component versions | No | Yes |
| `WBDirectory[]` | Current notebook directory | No | Yes (dynamic variable) |
| `WBPrint[args…]` | In-place updating status output | No | Yes |
| `WBInclude["path"]` | Import file as notebook cells | Yes | No |
| `WBExport["path"]` | Export notebook as .nb / PDF | Yes | No |
| `WBPrompt["text"]` | Send prompt to AI agent | Yes | No |

Functions marked "Intercepted" are handled by the extension's checkout pipeline before reaching the kernel. Their arguments must be static string literals.
