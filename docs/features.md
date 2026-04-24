# Features Reference

→ [Back to README](../README.md)

---

## Notebook Interface

### Cell types

Wolfbook notebooks (`.wb` files) contain two kinds of cells:

**Code cells** — Wolfram Language code, evaluated against the live kernel with `Shift+Enter`. Results render below the cell.

**Markdown cells** — styled text with full LaTeX math support via KaTeX. Press `Shift+Enter` to render; click inside to return to source.

Markdown math syntax:

| Type | Source | Result |
|---|---|---|
| Inline math | `$E = mc^2$` | E = mc² |
| Display math | `$$\int_0^\infty e^{-x}\,dx = 1$$` | centred equation |
| Aligned | `$$\begin{aligned} a &= b \\ c &= d \end{aligned}$$` | aligned block |

### Output rendering

Each code cell output has format buttons in its header. Two button sets are available depending on output type:

**Symbolic/expression outputs:**

- **WL** — InputForm text (plain Wolfram Language)
- **SVG** — rasterized image
- **SVG.T** — rasterized TraditionalForm typeset image
- **LaTeX** — KaTeX rendering via the wolfbook-btl addon (usually better quality)
- **src** — raw LaTeX source from wolfbook-btl

**Graphics outputs** (plots, `Graphics[…]`, images):

- **WL** — InputForm text
- **SVG** — rasterized image
- **TikZ** — TikZ source for pasting into LaTeX documents

Double-click any format button to set it as the notebook default for that output type.

### LaTeX rendering pipeline

Wolfbook has two paths for typesetting symbolic output:

**LaTeX path** (via wolfbook-btl) — uses `MakeBoxes[expr, TraditionalForm]`, passes the box structure through the bespoke C++ `boxToLatex` addon, renders with KaTeX. Better for complex expressions that do not convert well via `TeXForm`. About 10× faster.
We implemented the line breaking algorithm which tries to adjust the output to page width at the moment of evaluation. If you are preparing a paper you can adjust the editor size to fit your paper width and the output will be typeset accordingly.
The raw LaTeX source is always available via the **src** button — copy it directly into your paper.

---

## Kernel Control

### Abort and restart

- **Abort** (`Cmd+.` / `Ctrl+.`) — sends an interrupt to the running evaluation. The kernel remains live and ready for new input. 
Note: this is something not available in official Wolfram extension.
- **Restart** (`Cmd+Shift+R` / `Ctrl+Shift+R`) — relaunches the kernel cleanly. All definitions are cleared; the notebook text is preserved.

To verify the kernel is alive after an abort, evaluate `2+2` — it should return immediately.

### Dynamic widgets

`Dynamic[expr]` creates a live-updating output slot that refreshes while the kernel runs other cells:

```wolfram
Dynamic[n]                          (* shows current value of n, updates live *)
Dynamic[ListPlot[Range[n]]]         (* plot re-renders every ~500 ms *)
```

**Expiry options** control when the widget stops:

| Option | What it counts | Stops when… |
|---|---|---|
| `LiveTime -> t` | wall-clock seconds | `t` seconds elapsed |
| `LiveEvaluations -> n` | sub-expression dispatches | after `n` dispatches |
| `LiveCells -> n` | cell-level evaluations | after `n` Shift+Enters |

Options can be combined; the first condition that fires wins:

```wolfram
Dynamic[n, LiveTime -> 30, LiveEvaluations -> 5]
```

**Early-start in mixed cells** — if `Dynamic[expr]` appears before other expressions in the same cell, the widget starts updating immediately while the rest of the cell evaluates:

```wolfram
Dynamic[n, LiveEvaluations -> 2]    (* starts live immediately *)
Do[n = k; Pause[0.5], {k, 1, 20}]  (* runs concurrently *)
```

---

## Step-by-Step Debugger

Ever wondered why a loop gives the wrong answer after 10 iterations? Watch it happen — one statement at a time.

### Starting a debug session

Press `Cmd+Shift+D` on any code cell to start a debug session. Or click the **▶ Debug** button in the Watch Panel.

### Debugger controls

| Action | Key | What happens |
|---|---|---|
| Start debug | `Cmd+Shift+D` | Pauses execution at each statement |
| Step Over | `F10` | Run current statement, stop at next |
| Step Into | `F11` | Enter the body of a loop |
| Step Out | `⇧F11` | Finish current loop body, return to outer level |
| Continue to Breakpoint | `F5` | Run until next breakpoint |
| Run to End | `Ctrl+F5` | Run the rest without pausing |
| Stop session | `⇧F5` | Abort and clean up |
| Toggle Breakpoint | `F9` or click gutter | Mark a line |
| Evaluate Selection | `Cmd+Shift+E` | Evaluate selected expression; result in Watch Panel |
| Add to Watch | `Cmd+Shift+W` | Add selected expression to watch list |

### The Watch Panel

Open it from the Run & Debug sidebar → Wolfbook Watch. During a debug session it shows:

- Current step position and loop iterator values (`i = 3`, `j = 1`, …)
- Live table of watched variables — add by typing a name or selecting and pressing `Cmd+Shift+W`
- Timing annotations (`⏱ 12.3 ms`) that appear inline in the cell after each statement
- All registered breakpoints — click `×` to remove individual ones

Outside a debug session (live watch mode): shows just the watch table and the Evaluate Selection result area. Values refresh after every cell evaluation — useful for monitoring intermediate results across multiple cells without setting up a debug session.

### Auto-advance

When a cell finishes debugging cleanly, the session automatically continues with the next code cell — useful for stepping through a sequence of cells.

---

## Evaluate Selection

Select any Wolfram Language expression in a cell and press `Cmd+Shift+E` to evaluate it instantly without running the full cell (works even in the middle of an evaluation).

- Result renders in the Watch Panel sidebar with full formatting (LaTeX, SVG, MathML)
- Works even when the kernel is busy evaluating another cell (uses the same `Dialog[]` interrupt path as Dynamic)
- Large results are automatically truncated; a link opens the full output in the editor
- The last evaluation is cached and re-displayed if you close and reopen the Watch Panel

---

## Importing and Exporting

### WBExport — save as Mathematica `.nb`

```wolfram
WBExport[]               (* saves as <notebook-name>.nb next to the .wb file *)
WBExport["output.nb"]    (* relative path from the notebook's directory *)
WBExport["/abs/path/to/result.nb"]
```

Note: this converts the notebook to a standard Mathematica `.nb` file. Markdown headings become Wolfram Title/Section/Subsection cells. Never sent to the kernel — intercepted by the extension. It is not one to one conversion, but it is a good approximation.

```wolfram
WBExport["notebook.pdf"]               (* saves as notebook.pdf in the same directory as the .wb file *)
WBExport["output.tex"]                (* saves as output.tex in the same directory as the .wb file *)
WBExport["output.html"]               (* saves as output.html in the same directory as the .wb file *)
```


### WBInclude — import a Mathematica `.nb`

```wolfram
WBInclude["SolvingBaxter.nb"]          (* relative path *)
WBInclude["/abs/path/to/library.nb"]   (* absolute path *)
```

Inlines a Mathematica notebook into the current one. A Markdown header is inserted, followed by all converted cells. Never sent to the kernel.

---

## Editor Features

### Syntax highlighting

Full syntax highlighting for `.wl`, `.wls`, `.m`, `.wb`, `.vsnb`, `.evsnb` files.

### Language server (LSP)

Powered by Wolfram's `LSPServer` package: hover for usage messages, completions, and error underlining.

### Code formatter

Press `Opt+Shift+F` (Mac) / `Alt+Shift+F` (Windows) to format the current cell. Also converts named symbols (`\[Alpha]`) to Unicode.

### Multi-cursor

Click a symbol, then press `Cmd+D` / `Ctrl+D` repeatedly to select all occurrences. Type a new name — all instances rename simultaneously.

### Paste image as cell (macOS)

Copy any image to the clipboard, then:
- `⌘V` with a cell selected (not in edit mode) — inserts the image as a new Markdown cell below
- `⌘⇧V` anywhere — shows a prompt to insert above or below

Images are saved as PNGs inside `img/<notebook-name>/` next to the notebook.

---

## Smart Scroll Behaviour

`Shift+Enter` uses intelligent scroll behaviour:

- **Advance mode** (unchanged cell) — the cell snaps to the top of the viewport before output arrives; focus advances to the next cell
- **Refine mode** (cell was edited) — the viewport stays still; focus returns to the same cell with cursor preserved for continued editing

The active mode is shown in the status bar and can be forced with the toolbar button.

---

## Collab Mode — Working Alongside an AI Agent

Collab mode is designed for interactive sessions where you and an AI agent (Copilot, Claude Code, etc.) work in the same notebook simultaneously.

### How it works

Enable via **Settings → `wolfbook.collabMode: true`** (or add to your workspace `.code-workspace` file):

```json
{
  "settings": {
    "wolfbook.collabMode": true
  }
}
```

With collab mode on:

- Wolfbook ensures a **second split editor** is always open for your notebook (right column)
- The **right panel follows the agent** — every cell the agent evaluates, inserts, or edits is scrolled into view there
- The **left panel is yours** — the agent never disturbs your scroll position or cursor
- The blue highlight flash after each agent operation appears in the right panel only

Without collab mode:

- If you have **two editors open** side by side, the same rule applies: right follows agent, left stays still
- If you have **one editor open**, the agent's scroll follows the evaluated cell freely — no viewport guard

This means the collab mode setting only controls whether the second editor is opened automatically. The scroll behaviour is identical once two editors exist.

### Recommended setup

1. Open your notebook
2. Add `"wolfbook.collabMode": true` to your workspace settings
3. Reload the window
4. The notebook opens with a split view automatically when the first agent tool runs
5. Work in the left panel; watch the agent operate in the right one

---

## Extension Settings Reference

| Setting | Default | What it does |
|---|---|---|
| `wolfbook.systemKernel` | `Automatic` | Path to the Wolfram kernel executable. Use `Wolfbook: Select Kernel` command to set from a picker. |
| `wolfbook.collabMode` | `false` | Enable Collab mode (see above). Scope: window. |
| `wolfbook.mcpEnabled` | `true` | Enable the MCP server so Claude Code and other MCP agents can connect. Disable to block external connections. Requires window reload. |
| `wolfbook.autoReplaceEscapeSequences` | `true` | Auto-replace `\[Name]` with Unicode as you type. |
| `wolfbook.timeout_warning_enabled` | `true` | Show a warning if the kernel does not start within 15 seconds. |
| `wolfbook.notebook.rendering.outputFormat` | `LaTeX` | Default rendering format for symbolic outputs. |
| `wolfbook.notebook.rendering.imageScalingFactor` | `0.8` | Controls output image size. |
| `wolfbook.notebook.rendering.invertBrightnessInDarkThemes` | `true` | Invert image brightness in dark themes. |
| `wolfbook.editor.globalSymbolColor` | `""` | Colour for `Global`` context symbols. Leave empty for auto (theme-aware). Set `off` to disable. |

