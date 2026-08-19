# Changelog

All notable changes to **Wolfbook** are documented here.

---

## Unreleased

### Added

- **Long MCP evaluations can be continued instead of being disconnected.** If
  a tool is still running after five minutes, Wolfbook returns an operation ID
  and lets the model choose `wolfbook_waitEvaluation` to wait another five
  minutes or `wolfbook_kernelControl(action:"abort")` to stop. Each continuation
  renews a ten-minute transport lease. Transport expiry never aborts kernel
  work it cannot prove it owns. This also replaces the shorter two-minute
  cutoff for tools routed to another VS Code window.
- **Safe kernel arbitration and resumable execution operations.** Agent calls
  now reject with structured busy state instead of silently aborting an active
  user or agent computation. New `wolfbook_kernelStatus`,
  `wolfbook_operationStatus`, `wolfbook_evaluationJournal`, and bounded
  `wolfbook_getResult` tools expose lifecycle, captions, progress and results.
- Long evaluations accept a short `caption` and optional `progress_symbol` for
  bounded semantic progress monitoring through the existing subsession channel.
- Added `wolfbook_saveNotebook`, which reads saved bytes back and reports their
  SHA-256, size, mtime, dirty state and document version.
- Cell edits, deletion and movement accept optimistic source/kind/ID
  preconditions; stale mutations return conflict details without changing the
  notebook. Single-cell edit-and-evaluate now uses the notebook execution
  pipeline and reports committed cell output.
- Range execution distinguishes structured messages from `$Failed`/`$Aborted`;
  messages are collected by default rather than stopping the range.
- The in-memory MCP operation registry now carries cell execution provenance
  (operation ID, source SHA-256 and lifecycle state) without changing `.wb`
  metadata or serialization. Results produced for a source that changed during
  execution are marked stale and are not attached; `getCellOutput` distinguishes
  current-session states and reports `unknown` when provenance is unavailable.
- Worker windows reliably re-register after a fast primary-window restart, so
  multi-window notebook targeting does not silently lose healthy clients.
- MCP client listings normalize and deduplicate repeated notebook paths.
- Kernel execution tools now accept `wait_mode:"async"` and return immediately
  with a durable operation UUID. Transport and execution layers share that UUID,
  so status/results remain recoverable after SSE reconnects and across registered
  worker windows even when the new session has no remembered target.
- Operation status includes bounded, sequence-numbered `Print` output, kernel
  messages and monitored-symbol progress. Completed operations retain a bounded
  result preview and retrieval-expiry timestamp; timeout responses recover the
  committed cell result after the kernel becomes idle.
- Expiring a transport waiter only forgets the network-side waiter. It never
  aborts kernel work; explicit attributed cancellation remains available by
  operation ID.
- **Explicit kernel identity and optional notebook isolation.** Every window now
  exposes an opaque kernel ID and visible controller labels such as `Wolfram K1`
  and `Wolfram K2`. The kernel picker shows lifecycle/process metadata and can
  select, create, rename, restart, or stop the targeted kernel. Machine-local
  live leases keep numbered labels distinct across VS Code windows. Notebook
  bindings are kept in local VS Code workspace state, shown in MCP discovery/context output, and
  asserted by `kernel_id` so rebinding cannot silently redirect an agent.
  `wolfbook_kernelManager` lists bindings and, behind the experimental setting,
  creates and binds bounded isolated kernels without changing `.wb` files.
  The existing multi-window MCP worker bridge also brokers transactional cell
  execution, allowing the kernel picker to bind a notebook to a kernel owned by
  another live VS Code window without transferring WSTP ownership. Owner-host
  generation changes fail stale instead of silently falling back to K1.
- The kernel picker can now start another local Wolfram process even when
  isolation was not pre-enabled. Local logical kernel slots, their `K1`/`K2`/…
  labels, and notebook bindings persist in VS Code workspace state and are
  recreated after extension-host reload; stopping a kernel removes its saved
  slot. Runtime routing IDs remain fresh, and no kernel state is written to the
  `.wb` file.
- The native kernel picker now also provides **Stop Unattached Wolfram
  Kernel…**. It lists only idle kernels with no notebook bindings, confirms the
  loss of in-memory definitions, and asks the owning VS Code window to stop a
  remotely owned process through the existing MCP worker broker.
- Kernel labels and the Wolfbook status item show how many notebooks are
  attached (for example, `Wolfram K2 · 3 notebooks`). Counts are aggregated
  across VS Code windows, so sharing one stateful kernel between several `.wb`
  files remains fully supported and visible.
- Shift+Enter in a newly created notebook now opens Wolfbook's kernel picker
  when no explicit kernel association exists. After K1/K2 or a new kernel is
  chosen, the original cell execution continues instead of being silently
  dropped by VS Code's unassociated-controller path.
- `wolfbook_newNotebook` now persists an explicit default-kernel binding before
  returning the new notebook as an MCP target. A focused
  `wolfbook_selectKernel` MCP tool lets agents list kernels and select the
  default, an existing shared kernel, or a newly created kernel without using
  VS Code UI.
- `wolfbook_newNotebook` is now an idempotent open-or-create operation. A `.wb`
  written by a generic filesystem tool can be opened and targeted through the
  same tool without adding another MCP command: existing bytes and an existing
  K2/K3 binding are preserved, while an unbound file receives the window's
  default kernel automatically.

### Fixed

- Abort and Restart no longer disappear from a Wolfbook toolbar when another
  local or remote controller changes a legacy global `wolframKernelActive`
  context flag. In the multi-kernel design, availability is notebook-specific;
  the controls therefore remain visible for every Wolfbook notebook and route
  to its current binding when invoked.
- The optional remote-host kernel poller no longer emits an exception every
  second when a multi-kernel window has no active notebook from which to infer
  an unambiguous target.
- **Measured MCP canonical output projection.** An opt-in versioned projection
  returns exact source, compact plain/LaTeX previews and MIME/hash manifests
  instead of renderer HTML. A 587-notebook corpus measured 89.33% aggregate and
  72.53% median size reduction with zero source/item-count mismatches. Optional
  content-addressed render caching and uniform expiring result handles remain
  outside notebook storage and are separately gated by settings.
- Notebook background colour and image choices are now stored per notebook URI
  in the local VS Code user settings. Changing appearance no longer edits the
  shared `.wb` file or workspace settings, preventing Dropbox collaborators'
  appearance choices from repeatedly overwriting one another.

---

## [2.8.8] - 2026-08-16

### Added

- **Interactive 3D graphics.** Drag `Graphics3D` and 3D plot outputs to switch
  from the static preview to an in-place rotatable WebGL view. The **3D** output
  control opens the interactive view directly.
- **Coordinate tooltips for 2D plots.** Hover plotted curves to inspect their
  coordinates without leaving the notebook.
- Settings `wolfbook.notebook.rendering.interactive3D` and
  `wolfbook.notebook.rendering.plotTooltips` independently disable the extra
  interactive data when static output is preferred.

### Changed

- Updated the README demonstrations for 3D rotation, Mathematica `.nb`
  conversion, notebook formatting and plot tooltips. Demo media now ships under
  `images/demos/`, so links work in GitHub, the Marketplace and VS Code's local
  extension details view.
- Notebook formatting preserves the active selection and cursor position.

### Fixed

- **Evaluate Selection is reliable alongside Live Watch.**
  **Cmd+Shift+E** (macOS) / **Ctrl+Shift+E** (Windows and Linux) evaluates the
  selected Wolfram Language expression in the Watch panel, including while a
  notebook cell is running. Selection evaluation and live-watch updates now
  serialize access to the shared WSTP channel, preventing the spurious
  “Evaluation returned no result” failure. The active selection and notebook
  image context are preserved when focus moves to the Watch panel.
- `Shift+Enter` in a read-only imported Mathematica `.nb` input cell now uses
  Wolfbook's WSTP notebook controller instead of sending the expression to the
  integrated terminal.
- `Shift+Enter` in standalone `.wl`, `.m`, `.wls` and `.cdf` editors now
  evaluates the selection—or the complete top-level expression under the cursor
  when nothing is selected—through the Wolfbook WSTP kernel instead of the
  integrated terminal. Recognised subexpressions run sequentially and their
  InputForm results appear as transient gray editor decorations. The existing
  **Cmd/Ctrl+Shift+E** selection evaluator remains available in these files and
  renders the selected expression in the Watch panel, as it does in `.wb` cells.
- Imported `.nb` graphics now replace their temporary filename placeholders
  after rasterisation, including when notebook opening races extension
  activation. Cached PNGs are reused on subsequent opens.

---

## [2.8.7] - 2026-08-15

### Fixed — LaTeX `\\( … \\)` and `\\[ … \\]` now render as math

Markdown written with LaTeX's own delimiters was not treated as math: markdown
ate the backslashes and formulas appeared as literal text — `(F(w,\\bar w)\\to
f(w))` instead of typeset output. Only `$ … $` and `$$ … $$` were recognised.

That form arrives constantly — pasted from papers and `.tex` sources, and
emitted by AI assistants, which overwhelmingly prefer `\\(` / `\\[`.

- **Notebook markdown cells**: a renderer extending the built-in markdown-it
  pipeline translates the delimiters before math parsing.
- **Slides** (editor, preview and HTML export): the KaTeX auto-render
  configuration now lists the LaTeX delimiters, which it supports natively.

Markdown inserted through the agent/MCP tools is also normalised to `$` form at
insert time, so the stored `.wb` renders in other viewers too (GitHub, exported
HTML) rather than only in Wolfbook — with a one-line note back to the author
stating the convention. Code cells are never touched.

Wolfram named characters are unaffected: `\\[Alpha]`, `\\[Rule]` and friends
close with a plain `]`, whereas display math closes with an escaped `\\]`, so the
two are distinguished. Code — fenced blocks and inline spans — is never
rewritten.

---

## [2.8.6] - 2026-08-15

### Fixed — MCP server showing "Failed" after an extension update

- The registered bridge path contains the extension **version**
  (`~/.vscode/extensions/wolfbook.wolfbook-<version>/…`), and VS Code deletes the
  old directory on update. The config was only refreshed for workspaces that
  happened to be **open** at activation, so every other project kept a dead path
  and its MCP server failed with no usable message — Node exits with
  `MODULE_NOT_FOUND` before the bridge can report anything.
- Activation now repairs **all** projects in `~/.claude.json`, not just open
  ones. Entries whose bridge still resolves are left untouched (a deliberate
  custom bridge is preserved), nothing is written unless something changed, and
  the file is written atomically — it holds the user's entire CLI state.

### Changed — every handled file type is now registered

- `.wb`, `.evsnb` and `.vsnb` were claimed only by the notebook selector, so
  VS Code did not recognise them as file types Wolfbook owns. They are now a
  registered language (`wolfbook-notebook`); opening still routes to the
  notebook editor.
- Icon theme: `.nb`, `.wslide`, `.wl`, `.wls`, `.wlt`, `.mt` had no icon.

---

## [2.8.5] - 2026-08-15

### Fixed — Linux: the kernel never launched

- **`Session is closed` on every evaluation (Linux only).** The Linux WSTP addon
  cannot fork the kernel itself — doing so inside Electron trips FD-ownership
  enforcement (SIGTRAP) — so it opens a *listen* link and relies on the
  extension to spawn a kernel that connects back to it. 2.8.4 constructed the
  listen-mode session and then never spawned anything, leaving the link Idle
  with no peer: cells hung on "Kernel is starting…" forever.
  The launch path now detects which addon flavour is bundled (a listen-mode
  build is the only one that exposes a link name) and performs
  listen → spawn → connect when required. macOS and Windows, whose addon uses
  `-linkmode launch`, are unchanged.
- **Externally spawned kernels are now reaped** on stop, restart and relaunch.
  The addon only kills kernels it launched itself, so a listen-mode restart
  would otherwise leave the old kernel alive holding a licence seat.
- **Linux kernel discovery enumerates installed versions again** instead of
  matching a hardcoded list, so releases newer than the list (14.3+) and
  `/opt` install prefixes are found. Version ordering is numeric, so 14.10
  correctly outranks 14.9.

With thanks to the Linux testers for a diagnosis that identified the exact
regression, ruled out the addon binary, and shipped with a working patch.

---

## [2.8.4] - 2026-08-13

### Added — open existing Mathematica `.nb` notebooks

- **Double-click any Mathematica `.nb` file and it opens in the Wolfbook notebook
  editor** — cells, Markdown text, typeset output and graphics. Conversion is
  pure JavaScript and in-process (~20 ms for a typical file): **no Wolfram kernel
  is required**, and nothing has to be exported from Mathematica first.
- **Read-only by design.** The original `.nb` is never overwritten with `.wb`
  JSON — any VS Code-initiated save (auto-save, hot-exit, the close prompt) is a
  byte-identical no-op. **⌘S / Ctrl-S** instead writes a sibling `.wb` copy,
  keeping your edits, and opens it.
- Outputs are re-typeset through the same LaTeX/KaTeX renderer as native
  notebooks; graphics are rasterised to PNGs beside the notebook and cached by
  content hash, so reopening needs no kernel at all.
- `WBInclude["file.nb"]` now uses the same importer — no `wolframscript`
  round-trip, and outputs are preserved.
- A parse failure yields a banner plus the raw source in one cell — never a blank
  notebook.

### Changed

- `.nb` is registered as a Wolfram Language file type, so VS Code recognises the
  format and can offer Wolfbook when one is opened.

---

## [2.8.1] - 2026-08-13

### Fixed

- **Marketplace landing page: broken documentation links.** The README's top
  navigation is raw HTML, and `vsce` only rewrites *Markdown*-syntax links to
  absolute repository URLs — raw `<a href="docs/…">` was left relative, so every
  nav link 404'd on the Marketplace page. All HTML links are now absolute.

---

## [2.8.0] - 2026-08-12

The headline of this release is that Wolfbook now does more than *let* an AI use
your kernel — it can run a whole verified calculation on its own. Alongside that,
the slide editor has been reworked, and a long tail of `.wb` and tooling bugs is
fixed.

### Added — Oberon, an EXPERIMENTAL research agent (off by default)

> ⚠️ **Experimental preview.** Oberon is off unless you configure your own LLM
> API key. It spends real money per run, writes files into your workspace, and
> its commands, settings and file layout **will change between releases**. No
> other Wolfbook feature depends on it. If you do not configure a key, nothing
> in this section runs and nothing leaves your machine.

- **Autonomous research agent (experimental, opt-in).** Give Oberon a brief and it
  plans the calculation, probes the live kernel, records the steps that survive,
  compiles them into a clean notebook, then **restarts the kernel and re-runs that
  notebook from scratch** to verify it. A clean replay *is* the verification —
  nothing is graded by a language model judging its own work.
- **Two modes:** *Quick compute* for one self-contained calculation, and
  *Director* for multi-stage programmes that plan, run dependent stages, bank
  verified key results, and write a LaTeX report.
- **Machine-checked expectations.** Probes and recorded steps can carry WL
  booleans that the kernel adjudicates on the spot, so a plausible-but-wrong
  result fails immediately instead of propagating.
- **Live transparency.** A `working.wb` notebook fills in as the agent computes —
  failed probes stay visible with their errors rather than being quietly deleted —
  plus a Control Room sidebar, a Run Inspector, and a self-postmortem the agent
  writes about its own run.
- **Bounded by design.** Per-run cost and call ceilings, per-phase probe/turn
  budgets, and a Director budget cap. Off entirely until you configure an API key.
- Providers: DeepSeek (default, cheapest), Anthropic, OpenAI; per-role model
  binding so judgment and execution can use different models.
- See [docs/oberon-agent.md](docs/oberon-agent.md) for setup, budgets and a full
  statement of what data goes where.

### Added — SkilXiv.org integration (experimental; part of the Oberon agent)

- **Skill recall.** Before starting, the agent searches
  [SkilXiv.org](https://skilxiv.org) — a public registry of versioned, citeable,
  executable know-how — and injects a matching *skill* into its context. On hard
  problems this is the difference between rediscovering a method by trial and
  error and applying it directly.
- Skills are treated as **untrusted reference material**: anything taken from one
  must still be reproduced in the kernel before it is recorded, and a skill whose
  claim the kernel disproves gets a correction filed against it.
- **Contribution flow.** A run that establishes something novel can draft a
  candidate skill from the verified notebook. Nothing publishes automatically:
  drafts go to a local review panel, must execute cleanly in a fresh kernel, and
  are submitted as **private** drafts that only you can publish.
- All SkilXiv traffic can be disabled with `wolfbook.oberon.recall.enabled`.

### Changed — `.wslide` presentations: reworked interface and AI editing

- **Redesigned editor:** cleaner canvas, proper multi-block selection, alignment
  and arrange tooling, and a rebuilt side panel.
- **AI editing in the editor itself:** select blocks and press **⌘K** to say what
  you want ("tidy this", "make these equal width", "turn into 3 bullets"). The
  assistant proposes concrete changes you accept or reject before anything is
  written to the file.
- **Deterministic quick actions** for common tidy-ups — instant, no model call.
- Expanded slide tooling for agents, including bulk insert, block patching,
  arrangement and HTML export.

### Fixed

- `.wb` notebooks: output round-tripping and serialization fixes; markup cells no
  longer persist stale outputs; execution summaries are no longer written into
  the file (they caused spurious diffs and sync conflicts).
- Notebook deliverables produced by the agent are now saved in their **verified**
  state — previously a passing verification could be written only to the open
  editor, leaving a stale copy on disk.
- Kernel launch failures now produce a readable diagnosis (not-installed, licence,
  crash, hang, WSTP link, missing addon) instead of a raw error.
- Slide editor: the ⌘K assistant bar now dismisses on click-outside and on Escape
  from anywhere, instead of staying pinned over the canvas.
- Numerous robustness fixes across the agent tool surface: dependency analysis of
  Wolfram code (destructuring assignments, `Function` parameters, iterator and
  Association-key false positives), provider retry with backoff on transient
  network errors, and output-size guards that prevent a huge result from flooding
  the session.

### Acknowledgements

Special thanks to **Ruben Myers** for his help compiling the Unix build of the
native binaries. The WSTP bridge and the `btl` math renderer are native addons
that must be built per platform, and that work is what makes Wolfbook usable
beyond macOS and Windows.

---

## [2.7.0] - 2026-05-02

### Added — WBPrint: live updating output for Print/WBPrint in loops

`WBPrint[expr]` is a new Wolfram function (injected via `init.wl`) that sends output back to the notebook using a dedicated `*WBP*` packet.  Unlike `Print[]`, which accumulates one line per call, `WBPrint` **replaces** the previous WBPrint output each time — so a loop like

```mathematica
Do[WBPrint["Step ", k, ": ", k^2]; Pause[0.1], {k, 1, 100}]
```

shows a single updating output line rather than 100 accumulated lines.  Each call renders all its arguments inline (strings, numbers, expressions, and even SVG graphics) on one flex-row using the same KaTeX renderer as regular outputs.

`Print[]` continues to work as before (accumulates lines); only `WBPrint[]` does live-replace.

### Added — Double-click output header navigates to source line

Every output has a thin header bar showing the expression index (Output 1, Output 2, …).  Double-clicking that bar now scrolls the code editor to the corresponding source line inside the cell.

### Added — Remote bridge (`wolfbook.remote.*`) — iOS/web companion surface

A new `remote/` module registers a `wolfbook.remote.*` command surface consumed by the **Wolfbook Remote Host** companion extension (otherwise nothing is translated outside for safety reasons).  It proxies notebook operations over WebRTC to a paired iOS app:

- `handshake`, `listDocuments`, `focusDocument`, `getDocumentState`
- `getCell`, `editCell`, `evalCell`, `abortEval`, `saveFile`, `restartKernel`
- `copilotSubmit` / `copilotAbort` — triggers the Copilot chat panel remotely
- `subscribe` / `pull` / `unsubscribe` — event-stream for the iOS timeline

Connection status (connected / disconnected) is shown as a dot in the Wolfbook sidebar panel.

### Added — `wolfbook_remote_checkpoint` tool — agent durable working memory

New MCP tool that persists a Markdown checkpoint file alongside the notebook (under `<notebook>.img/wolfremote/checkpoints/`).  The tool's reply includes a listing of prior checkpoints so agents can resume work across sessions without losing context.  Emits a `checkpoint` event on the internal event bus so the iOS companion can display the agent's plan on-device.

### Added — `formatWithUTF` replaces `[[` with `〚〛` and `==` with `⩵`

`Option+Shift+F` (Format with UTF) now additionally:
- Replaces `[[` / `]]` (Part operator) with `〚` / `〛` (U+301A/U+301B)
- Replaces `==` (Equal) with `⩵` (U+2A75)

### Added — `〚` / `〛` fully integrated as brackets

After replacing Part brackets with the Unicode glyphs, they now behave like first-class bracket characters:
- **Bracket colouring & matching** — VS Code highlights the matching `〚`/`〛` pair under the cursor (via `language-configuration.json`)
- **Smart selection** — Shift+Alt+Right expands selection to the contents and then across `〚…〛` (via `selectionRange.js`)
- **Folding** — multi-line `〚…〛` expressions can be folded (via `folding.js`)
- **Surrounding pairs** — selecting text and typing `〚` wraps it in `〚…〛`

### Added — Chunk folding

Multi-line top-level expressions are now foldable as a unit.  A bracket-depth-aware two-pass algorithm in `folding.js` identifies expression boundaries: lines inside open brackets always belong to the same chunk; at depth 0, a bare newline ends a chunk unless a continuation operator is present at the end of the current line or the start of the next.  The first line stays visible when folded.

### Fixed — `WBDirectory[]` evaluates to unevaluated symbol on first kernel start

`WBDirectory[]` returned the symbol `WBDirectory[]` unevaluated if the kernel started before any notebook was opened.  The kernel init now always defines `$WBNotebookDirectory` (falling back to `$HomeDirectory`) so `WBDirectory[]` is always defined immediately after startup.

### Fixed — Trailing semicolon dropped by formatter inside brackets

Formatting `Do[Print[k];, {k, 4}]` dropped the trailing `;` after `Print[k]`, producing invalid code.  The formatter now correctly identifies when a range ends with a semicolon (vs a semicolon separator between two expressions) and re-emits it.

### Fixed — Formatter trailing semicolon in any nested context

The same trailing-semicolon fix applies to any `expr;` inside brackets: `Block[{}, a; b;]`, `Module[{x}, x=1;]`, function bodies with trailing `Null`-returning semicolons, etc.

### Fixed — Horizontal scrollbar causes scroll-jump when cells leave viewport

Code cells with long lines showed a horizontal scrollbar, which disappeared when VS Code virtualised the cell outside the viewport, causing a ~17 px height change and a visible scroll jump.  `editor.scrollbar.horizontalScrollbarSize` is now set to `0` for Wolfram files — the scrollbar gutter reserves no height so cell height is stable, while horizontal scrolling via trackpad still works.

### Fixed — Spurious LSP diagnostic warnings suppressed

Three additional warning classes from the Wolfram Language Server are now filtered out of the Problems panel:
- `"Unexpected prefix +."` — legitimate unary `+` is flagged as a prefix error
- `"Suspicious use of … session token."` — false positive on common patterns
- `"Unexpected letterlike character …"` — false positive on Unicode operator symbols

### Fixed — Autoconfigure Cline MCP on activate

The extension now automatically injects the Wolfbook MCP entry into the Cline configuration file on first activation (if Cline is installed), without requiring the user to run `wolfbook.configureCline` manually.

### Fixed — `InformationData` / `?Symbol` output now renders cleanly

When `?Symbol` was evaluated, the kernel emitted an `InterpretationBox` containing `InformationData[<|…|>]` with dynamic widget boxes that BTL could not render.  The output renderer now detects this box structure and builds clean HTML directly from the association data, showing usage messages and attributes without garbled LaTeX.

---

## [2.6.51] - 2026-04-24

### Added — `wolfbook_editCell` batch mode

`wolfbook_editCell` now accepts a `cells` array for batch editing:

```json
{ "cells": [{ "cellId": "abc", "content": "f[x_]:=x^2" }, …] }
```

- Cells are edited and evaluated sequentially through the real kernel pipeline (not a scratch-pad) — outputs appear in the notebook and errors surface immediately.
- `evaluate` defaults to **`true`** in batch mode; pass `evaluate:false` on individual items or at the top level to skip.
- Returns a per-cell diff + output/message summary in a single tool response.
- `timeoutSeconds` (default 30) applies per cell.

### Fixed — `wolfbook_editCell` was single-cell only (Q1 2026 feedback)

Previous feedback: batch editing required multiple sequential `wolfbook_editCell` calls. Now a single call handles all cells in one round-trip.

### Fixed — CellId verbosity (token waste)

Cell IDs in all tool results were the full `vscode-notebook-cell:/path/to/notebook.wb#fragment` URI (100+ chars). They are now just the short fragment (e.g. `Y113sZmlsZQ%3D%3D`) — unique per cell, stable within a session, and ~10× shorter. Old full-URI IDs from prior sessions are automatically resolved via fragment matching.

### Fixed — `\[Rule]` and `\[RuleDelayed]` arrows missing from BTL rendering

`Solve[x^2==1,x]` output the `→` arrow symbol (WL private-use U+F522) as invisible. Added `\[Rule]→\to` and `\[RuleDelayed]→\mapsto` to `special_chars.cpp` (both named-form and raw-UTF-8 entries). Rebuilt native BTL addon.

---

## [2.6.50] - 2026-04-22

### Fixed — Multi-editor LaTeX width

When two notebook editors were open side-by-side, the LaTeX line-breaking width used by the BTL native addon was a single shared scalar, so both notebooks rendered at the width of the narrower editor. Width is now tracked per-notebook via a URI-keyed `Map`, and all `_processWLLatexBoxes` call sites pass the evaluating cell's notebook URI.

### Fixed — External tool guard leaking into Shift+Enter output

The "External tool guard" block in the cell execution path could emit a `WolframToolError: WOLFBOOK TOOL ERROR` header into a user's output when Shift+Enter-evaluating a cell. The guard block was removed; the internal `_wolframExecPending` flag is still cleared as before.

### Fixed — `Cmd+/` comment shortcut

`wolfram.language-configuration.json` defines no `lineComment`, so VS Code's default `editor.action.commentLine` wrapped the entire line in `(* *)` instead of the selection. Added a keybinding override that routes `Cmd+/` / `Ctrl+/` to `editor.action.blockComment` when editing a Wolfram notebook cell.

### Rewritten — WL code formatter (`wl-formatter.js`)

The formatter was rewritten around a Wadler/Oppen-style **Doc IR** (`nil · text · line · softline · hardline · nest · group · cat`) with fits-or-broken group layout:

- Recursive `docForRange`: splits each range at the weakest top-level binary operator (ASSIGN, POSTFIX, RULE_APPLY, ARROW, `||`, `&&`, COMPARE, `+`/`-`, `*`/`/`, `<>`, `@`).
- Unary `+`/`-` detected in a pre-pass (`t.isUnary = true`) so they never receive spaces and never trigger false operator splits.
- `ASSIGN` and `ARROW` cling to the LHS end; other operators break at the start of the next line (standard math convention).
- Per-group independent `groupFits` check — no Wadler fits cascade, so small inner groups stay on one line when the outer group is already broken.
- Brackets descend into their own `group(open · nest(4, softline · inner) · softline · close)`.

### Added — Formatter token-equivalence safety guard

After formatting, the output is re-tokenized and compared token-by-token to the input (ignoring `SPACE` / `NEWLINE` only). Any added, removed, or changed non-whitespace token causes the formatter to return the original source unchanged. Any exception during formatting is caught and the original is returned. Result: **the formatter can never invalidate a cell's syntax**, no matter what the input is.

### Improved — Multi-expression cell splitter

`checkout.js` sub-expression splitter now also recognises `<>`, `!=`, `>=`, `<=` as continuation operators when they appear at the start of a new line, matching the formatter's break styles.

### Fixed — LSP "Expected an operand" false positive

Added `/expected.*operand/i` to the LSP `handleDiagnostics` filters (both push and pull paths) to suppress the red wavy line that the Wolfram LSP emits on legitimate multi-line expressions such as `(...) / (...) /. rule`.

---

## [2.6.47] - 2026-04-16

### Added — `wolfteam_askSpecialist` tool

New team tool that opens a **Ask Specialist** panel in the Wolfbook sidebar, letting the AI agent pause and ask you a domain question before continuing:

- Renders the question (and optional context) with full **Markdown + KaTeX** math.
- A blinking highlight and a double-beep audio cue (Web Audio API) draw attention when the panel becomes active.
- Large textarea with `Ctrl+Enter` submit and a **Dismiss** button.
- Agent blocks until a reply is received — ideal for genuine branch-point decisions that require physics or domain expertise.
- Panel declared in `package.json` as a `webview` view and retains context when hidden (`retainContextWhenHidden: true`).

### Improved — PDF / HTML export

**Full Markdown rendering** — the hand-rolled line-by-line parser in `generatePdfHtml` is replaced by [`marked`](https://marked.js.org/) (GFM mode). All standard Markdown now exports correctly:

- Tables (`| col |`) — styled headers, alternating row colours, border-collapse.
- Fenced code blocks (`` ```lang ``) — monospace background, border, padding.
- Ordered and unordered lists.
- Blockquotes (left-border rule).
- Multi-line display math (`$$...$$` spanning several lines).

Math spans are extracted to `\x00MATHn\x00` placeholders before `marked` runs so LaTeX is never mangled, then restored as KaTeX-rendered HTML.

**Theme-aware colours** — background, text, headings, code blocks, table cells, blockquotes, links, and text-output `<pre>` elements now pick up the VS Code active colour theme at export time (`vscode.window.activeColorTheme.kind`). Dark themes produce a full dark-palette export; light themes produce the traditional white export.

**Wolfbook footer** — every exported PDF/HTML ends with a thin separator line, the Wolfbook logo (inlined as a base64 PNG), and "Created with Wolfbook" in small dimmed text, coloured to match the theme.

---

## [2.6.29] - 2026-04-11

### Added — `wolfslide_imageAsset` tool

Full image asset lifecycle management for `.wslide` decks. Seven actions in one tool:

- **`list`** — shows all images in `img/<deckName>.wslide/` with file size, pixel dimensions, which slides reference each image, and annotation preview. Flags unused files.
- **`info`** — full details for one image plus a ready-to-paste image block JSON snippet.
- **`copy`** — imports an external file into the deck's `img/` folder and returns the canonical `src` path and a ready-to-use block definition. Accepts an optional `annotation` to write provenance at copy time.
- **`delete`** — removes an image file; warns if still referenced by any block (use `force:true` to override).
- **`rename`** — renames the file **and** automatically patches all `src` references in the deck JSON in one atomic operation.
- **`annotate`** — writes or updates a `.ann.json` sidecar file beside the image with `description`, `source`, and `tags` fields.
- **`insert`** — combines copy + block insertion in one call: imports the file, writes optional annotation, and adds an `image` block to the specified slide (with correct `src`, inferred dimensions, `alt`, `fit`).

Annotation sidecars (`<filename>.ann.json`) survive renames and never pollute the deck JSON.

### Updated — `wslide-agent.instructions.md`

Expanded "Images" section with `wolfslide_imageAsset` quick-reference, block JSON structure, and step-by-step workflows for adding Wolfram Language plots.

---

## [2.6.28] - 2026-04-11

### Fixed — Wolfslide tools (from CERN-deck feedback)

- **`wolfslide_setTheme` warns on unknown parameters** — if an unknown key (e.g. `overrides`, a common mistake) is passed, the tool now returns a clear error message listing valid parameters and refusing to apply the call. Previously unknown keys were silently ignored, causing intended theme/CSS changes to be discarded without warning.

- **`wolfslide_getContext` returns full `editorCSS`** — was truncated to 120 characters, making it impossible for the agent to verify what CSS was actually saved after a `setTheme` call. Now the entire `editorCSS` string is included (with character count), so the agent can diff it against its intent.

- **Block IDs in ASCII slide diagram** — `wolfslide_getSlide` ASCII output now annotates every block with its short ID (e.g. `#xcgxoe34`). Previously block IDs were only visible in the raw JSON section, requiring the agent to correlate ASCII position with JSON manually.

- **Getting-started guide on new (empty) decks** — `wolfslide_getContext` now detects when the active deck has 0 slides and appends a comprehensive onboarding section covering: theme setup, `bulkInsert` JSON structure examples, layout rules (explicit px heights), inline-style discipline, fragments, math, images, eval blocks, editing workflow, and a common-mistakes table.

### Added

- **`wslide-agent.instructions.md`** (user-level Copilot instructions) — an `.instructions.md` file with `applyTo: "**/*.wslide"` frontmatter is installed in the user prompts folder. Copilot automatically injects it whenever a `.wslide` file is active, providing the agent with complete tool reference, JSON examples, and pitfall table without requiring the user to prompt for it.

---

## [2.6.27] - 2026-04-11

### Added — Paper search tool (`#wolfbookPaper`)
- **`wolfbook_paperSearch` now returns citation counts** — INSPIRE-HEP citation counts included in every `search` result (`citations` field).
- **Old-format arXiv IDs fully supported** — pre-2007 legacy IDs like `hep-th/0212208` are now resolved via the INSPIRE `/api/arxiv/<id>` endpoint directly, not via `find eprint` query, giving reliable lookups that the query path could not guarantee.
- **Freeform INSPIRE query syntax** — the `query` parameter now accepts raw INSPIRE query strings beginning with `find` (e.g. `find a Gromov and t "Bethe ansatz"`); they are forwarded as-is without double-prefixing.
- **Reference labels always populated** — reference lists fall back to sequential numbering (`1`, `2`, …) when the API omits a label, so no entry is ever `null`.

### Changed
- **`package.json` tool `modelDescription`** — updated to describe all five actions, citation counts, both arXiv ID formats, and the `query` freeform syntax.
- **README** — `wolfbook_paperSearch` added to the tool table, quick-reference list, and example prompts section; tool count updated from Nine to Ten.

---

## [2.6.26] - 2026-04-11

### Changed
- **Kernel restart no longer blocks in Bypass Approvals mode** — previously, restarting the kernel always popped up a confirmation dialog even when VS Code's "Bypass Approvals" setting was active. The restart now shows a descriptive message in the tool call strip (so you can still see it happening and cancel if needed) but auto-approves when bypass is on. Use `action:"abort"` to interrupt a stuck evaluation without restarting.

---

## [2.6.25] - 2026-04-11

### Added — Copilot / AI tools

- **Kernel checkpoint & restore** — two new actions on the `wolfbook_kernelControl` tool:
  - `action:"checkpoint"` saves all your current Global definitions to a `.mx` file (`/tmp/wolfbook-checkpoint-*.mx`). Fast and non-destructive — cell outputs are unaffected. Pass an optional `tag` (e.g. `tag:"before-refactor"`) to label it.
  - `action:"restore"` reloads the most recent checkpoint (or a specific file via `path`), clearing the current state first. This is the notebook equivalent of a git stash — create a safe rollback point before risky refactors, then restore if something goes wrong.

- **`outputForm` parameter for Evaluate Expression** — ask Copilot to evaluate and return the result in a specific format:
  - `outputForm:"Short"` — gives a truncated preview of very large expressions
  - `outputForm:"TeXForm"` — returns the LaTeX representation (handy when writing markdown math)
  - `outputForm:"MatrixForm"` / `outputForm:"TableForm"` — structured display for matrices and tables
  - Default (omitted): full symbolic result in InputForm

- **Edit Cell diff summary** — when Copilot edits a cell, the response now includes a compact diff showing which lines were added or removed (up to 5 lines shown). Makes it easy to verify what changed without reading the whole cell.

- **`newContent` accepted as alias for `content` in Edit Cell** — models that prefer `newContent` as the parameter name now work without any extra prompting.

### Changed
- **Default evaluation timeout raised from 10 s → 30 s** — more headroom for symbolic computations that take a moment to settle. You can still override with `timeoutSeconds` for very long-running work.

---

## [2.6.21] - 2026-04-10

### Fixed — Copilot / AI tools

- **MultiLine evaluation no longer produces "Incomplete expression" errors** — when Copilot uses `multiLine:true` mode in Evaluate Expression, each block of code is now split by a proper Wolfram Language parser (tracking bracket depth, strings, and nested comments) rather than naively on newlines. Multi-line constructs like `Module[...]` spread across several lines are now handled correctly and submitted as a single statement.

- **Syntax highlighting no longer colours symbols inside strings** — variable names inside `"..."` strings were incorrectly highlighted as user-defined symbols. The highlighter now correctly skips both string literals and `(* ... *)` comments.

- **KaTeX validation on AI-inserted markdown** — when Copilot inserts or edits a markdown cell, the math (`$...$` and `$$...$$`) is now validated before the edit is committed. Any LaTeX errors are reported back to the agent so it can fix the formula immediately rather than leaving broken math in the cell.

### Changed
- **Insert Cells now evaluates automatically** — when Copilot inserts new code cells, the last cell is evaluated immediately by default. Pass `evaluate:false` to insert without running.
- **Newly inserted cells get a brief blue highlight** — a one-second glow animation marks every cell Copilot inserts, making it easy to spot the new content in a long notebook.
- **All AI cell edits and insertions are logged** — `img/<notebook>/ai_eval_log.md` now records not just kernel evaluations but also every cell the AI edits or inserts, giving a complete audit trail of Copilot's changes.

---

## [2.6.20] - 2026-04-06

### Added
- **`WBVersion[]` diagnostic command** — evaluate `WBVersion[]` in any notebook cell to print a formatted version summary of all Wolfbook components:
  - Wolfbook extension version + install date (from `package.json` mtime)
  - BTL (box-to-LaTeX) C++ addon version + build date (embedded at compile time)
  - WSTP native addon version + build date (embedded at compile time)
  - Mathematica/Wolfram Engine kernel version (`$Version`)

  Output appears as plain `Print[]` lines in the cell output, bypassing all rendering pipelines.

### Infrastructure
- **Build-time date stamping** — `BTL` and `WSTP` native addons now embed their build date (UTC `YYYY-MM-DD`) in the binary alongside the version string, exported as `buildDate`. The BTL `build.sh` writes `build_version.h` with both `WOLFBOOK_BTL_VERSION` and `WOLFBOOK_BTL_BUILD_DATE`; the WSTP `build.sh` passes `-DWSTP_ADDON_BUILD_DATE` directly to `clang++`. The extension derives its date from the `package.json` file modification time.

---

## [2.6.17] - 2026-04-05

### Fixed
- **Trig argument spacing** — `\sin(t)` (single bare-letter argument) now renders as `\sin t` instead of the invalid `\sint`. Space is inserted between the LaTeX command and the argument whenever the argument does not begin with `\` (i.e. is a plain letter or digit rather than a Greek symbol or sub-expression). Both `trigOmitParens` (Rule 1) and `trigPowerForm` (Rule 2) cases are fixed. BTL bumped to **v2.1.1**.

### Infrastructure
- Added `release.sh` — one-command release script that rebuilds BTL, syncs binaries, packages the platform VSIX (`-darwin-arm64.vsix`), pushes both repos, and creates/updates the GitHub Release via the `gh` CLI.
- GitHub Actions workflow (`release.yml`) updated to opt into **Node.js 24** (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`) eliminating the Node 20 deprecation warning/error.

---

## [2.6.16] - 2026-04-05

### Added
- **Trig style options (`trigOmitParens`, `trigPowerForm`)** — two new rendering preferences, both defaulting to `true`, controllable per-call from JS and globally from VS Code settings (`wolfbook.notebook.rendering.trigOmitParens` / `wolfbook.notebook.rendering.trigPowerForm`).
  - **`trigOmitParens`**: `\sin(\phi) → \sin\phi` — drops parentheses when the trig argument is a single symbol.
  - **`trigPowerForm`**: `(\sin\phi)^n → \sin^n\phi` — moves the exponent immediately after the command for the canonical typographic form.
- Both rules are implemented in the BTL C++ native addon (`box_to_latex.cpp`) and exposed via the `BtlOptions` interface in `wolfbook_btl.d.ts`. BTL bumped to **v2.1.0**.

---

## [2.6.7] - 2026-04-03

### Fixed
- **LSP startup on macOS with Wolfram Engine symlink paths** — when the configured kernel resolved to `Wolfram Player.app` (which cannot run LSP in stdio mode), Wolfbook now falls back to a stdio-capable kernel path for LSP startup. This resolves repeated `couldn't create connection to server` crashes caused by Player-kernel process exit.

### Changed
- **LSP launch path selection** — notebook/WSTP kernel resolution and LSP kernel resolution are now treated separately so the notebook path can remain unchanged while LSP uses a compatible executable.

### Docs
- Added **AI-driven AILSP architecture plan** in `dev/AI_LSP_PLAN.md`, including a first-run metadata indexing strategy that avoids bundling Wolfram data files in the extension package.

---

## [2.6.1] - 2026-04-02

### Fixed
- **KaTeX CSS/fonts in packaged VSIX** — `katex` is now declared as a runtime dependency (`package.json`), so it is included in the packaged extension. The PDF export (`wb-export.js`) and the watch panel (`watchPanel.js`) now look for KaTeX assets in `node_modules/katex/dist/` first, with an automatic fallback to `wllatex-addon/node_modules/katex/dist/` for older local-dev layouts. This resolves `_btlPrerenderLatex is not a function` and missing-font errors in VSIX installs.

---

## [2.6.0] - 2026-04-02

### Added
- **Syntax check before Evaluate Selection** — selections are validated by the C++ `syntaxCheck` export before being sent to the kernel.  Invalid expressions (e.g. `1+3+d(`) are rejected immediately with an inline error annotation; no kernel round-trip occurs.
- **`syntaxCheck` visible in wstp.log** — the synchronous C++ syntax check now emits `→ [syntaxCheck]` / `← [syntaxCheck] ok Xms` log entries, matching the format used by all other WSTP calls.

### Changed
- **Evaluate Selection — single `subAuto` call** — the previous two-step pipeline (export result to a `.mx` file on the main kernel, then import and render on a separate sub-process) is replaced by a single `subAuto` call that evaluates and renders inline via `VsCodeRenderExpr`.  The C++ layer automatically selects the idle or busy-kernel path.
- **Sub-process subkernel removed** — the second `WolframKernel` process that was started eagerly at kernel launch for rendering is no longer used.  All rendering now runs on the main kernel.  This saves ~150 MB RAM per session and eliminates a ~1–2 s startup delay.
- **Subsession rendering** — the `⌥⇧↵` subsession output render uses a single inline `subAuto` call instead of exporting to a `.mx` file and rendering on the sub-process.

---

## [2.5.10] - 2026-03-31

### Fixed
- **Debugger — F11 enters wrong `Do` block** — when a cell contained two or more sibling loops at the same depth (e.g. `Do[…, {i,…}]; Do[…, {j,…}]`), stepping into the second loop highlighted the first loop's body instead.  Root cause: the step-instrumentation counter reset to 1 for every `instrumentBody` call, so both inner loops produced the same `{depth, localStep}` coordinates.  Fixed by threading a single monotonic counter through all recursive `instrumentBody` calls, giving every step in the cell a globally-unique coordinate pair.

- **Debugger — Cmd+Shift+D now toggles the debugger** — pressing Cmd+Shift+D (Ctrl+Shift+D on Windows/Linux) while a debug session is active now stops the debugger, mirroring the same shortcut used to start it.

- **Formatter — `/@` (Map) no longer gains a spurious space** — the `/@` operator was being tokenised as `/` followed by `@`, causing the formatter to insert a space: `f /@ list` → `f / @list`.  The tokeniser now recognises `/@` as a single operator token.

---

## [2.5.9] - 2026-03-30

### Added
- **Code folding** — fold/unfold any Wolfram Language bracket pair that spans multiple lines: `( )`, `[ ]`, `{ }`, `[[ ]]` (Part), `<| |>` (Association), and `(* *)` comments.  Closing-bracket lines are always kept visible when folded so code structure remains clear.  Works in `.wb` / `.evsnb` / `.vsnb` notebooks as well as standalone `.wl` / `.wls` / `.m` files.

---

## [2.4.0] - 2026-03-24

### Fixed
- **Standard LaTeX math operators** — functions such as `cosh`, `sinh`, `log`, `det`, `gcd`, etc. are now rendered as proper LaTeX operator commands (`\cosh`, `\sinh`, `\log`, `\det`, …) in both the C++ BTL addon and the WL fallback renderer.  This gives correct automatic spacing in math mode (e.g. `−i cosh²(ρ(σ))` no longer runs the operator letter-for-letter into adjacent terms).  ~40 standard operators are mapped; user-defined names continue to use `\mathrm{…}`.

- **Code formatter — inline comment placement** — a comment immediately following a semicolon on the same line (`var=4;(*comment*)`) is now moved to its own line without adding extra blank lines around it:
  ```
  Before: var=4; (*comment*)
  After:  var=4;
          (*comment*)
          a=5;
  ```
  Blank lines are only inserted around comments that were originally on their own line; inline-trailing comments get no surrounding blank lines.

- **Code formatter — trailing newlines preserved** — the formatter no longer normalises trailing newlines to exactly 0 or 1; the original trailing newline count is preserved.

- **Code formatter — Enter key in markdown cells** — the auto-format-on-Enter feature (when `wolfbook.formatter.autoFormat` is enabled) previously triggered inside markdown cells, reformatting them as Wolfram Language code.  It now only activates in `wolfram` language cells.

- **Global symbol colouring in new workspaces** — `wolfram.editor.globalSymbolColor` now defaults to `#333333` so unrecognised symbols are coloured immediately in any new workspace, without requiring a manual entry in `.code-workspace`.  Set the value to `off` or `none` to disable.

- **TextMate scope for global-symbol highlighting** — the extension's `configurationDefaults` now correctly specifies the `symbol.unrecognized` scope (was the non-functional `symbol.unrecognized.wolfram`).

---

## [2.3.2] - 2026-03-21

### Added
- **Cell shortcuts from editor focus** — `Cmd+Shift+A` inserts a code cell above, `Cmd+Shift+B` inserts a code cell below; both place the new cell in edit mode immediately.  `Cmd+Shift+X` deletes the current cell.  All three work while typing inside a cell — no need to leave edit mode first.
- **Right-click context menu** — *Wolfbook: Evaluate Selection* (`Cmd+Shift+E`) and *Wolfbook: Add Selection to Watch* (`Cmd+Shift+W`) are now available in the editor right-click menu inside wolfbook notebooks.

### Changed
- **Debug log location** — `wolfram-kernel-debug.log` now lives in `img/<notebookName>/` next to `btl.log` instead of `~/` or `Temporary Docs/`.  Tool, docs, and reader all updated.

### Fixed
- **Unicode symbol colouring** — global-symbol highlighting now correctly handles symbol names that contain Unicode characters (e.g. `varα2β`).  WSTP delivers non-ASCII name segments as `\:XXXX` four-digit hex escapes; these are now decoded before the colouring pass so symbols stay blue rather than reverting to the default token colour.

---

## [2.3.0] - 2026-03-18

### Added
- **`WBExport` multi-format export** — `WBExport` now supports five output formats
  selected by the file extension in the path argument.  The cell containing `WBExport`
  itself is always excluded from the export.

  | Expression | Output |
  |---|---|
  | `WBExport[]` or `WBExport["name.nb"]` | Mathematica `.nb` (unchanged) |
  | `WBExport["name.pdf"]` | PDF via Chrome headless `--print-to-pdf` |
  | `WBExport["name.html"]` | Self-contained HTML (all assets inlined) |
  | `WBExport["name.md"]` | Markdown; graphics saved to `name_images/` |
  | `WBExport["name.tex"]` | LaTeX article with `lstlisting` code blocks; graphics saved to `name_images/` |

  All formats:
  - Render with a **light background** (code cells: pale grey `#f6f8fa`, light-mode
    syntax colours matching VS Code Light+).
  - Inline or copy every graphic output (SVG/PNG) so the exported file is truly
    portable — no broken image links.
  - HTML/PDF include fully inlined KaTeX fonts and CSS so math renders offline.
  - LaTeX output includes a complete `\documentclass{article}` preamble with
    `amsmath`, `listings`, `graphicx`, `float`, `hyperref`.

- **`wolfbook_searchCells`** Copilot tool (`#wolfbookSearch`) — search notebook cells
  by text query, regex, and/or cell kind (code/markdown), with optional output
  inclusion.  Returns matching cell numbers, kinds, content previews, and output
  summaries.  Ideal for quickly locating definitions or results in large notebooks.

- **`wolfbook_getNotebookContext` range parameters** — `startCell` and `endCell`
  parameters added; Copilot can now read a specific range of cells instead of the
  entire notebook when context-window space is limited.

- **`wolfbook_runAllCells` output cap increased** — per-cell output summary raised
  from 300 to 800 characters to surface more result detail in Copilot.

### Fixed
- **BoxData backslash doubling** — WSTP backslashes in `BoxData[...]` outputs were
  double-escaped, causing stray `\\` in rendered LaTeX.  Fixed by un-doubling in the
  `flushPrint` BoxData path.
- **`InactiveD` template** — `TemplateBox[{"Inactive", expr, var}, "InactiveD"]` was
  rendered as raw text instead of `∂_var expr`.  Added a dedicated handler in the
  wolfbook-btl C++ addon.

---

## [2.2.0] - 2026-03-14

### Added
- **Live Watch Panel outside debugging** — the Wolfbook Watch sidebar now works as a
  standalone variable monitor even when no debug session is active.  The breakpoints
  list and step-control buttons are hidden automatically in live mode; only the watch
  table and the Evaluate Selection result area are shown.  Watch values are refreshed
  after every cell evaluation.

- **Evaluate Selection (`Cmd+Shift+E`)** — select any Wolfram Language expression in
  a cell and press `Cmd+Shift+E` to evaluate it in the Watch Panel sidebar without
  running the full cell.  The result is rendered with the full LaTeX/SVG/MathML
  pipeline (format switchable via the status-bar picker).  Works even while the kernel
  is busy — uses the same `Dialog[]` interrupt path as Dynamic widgets.  The last
  result is cached and re-displayed if the panel is closed and reopened.

- **Add Selection to Watch (`Cmd+Shift+W`)** — select any expression in the editor and
  press `Cmd+Shift+W` to add it to the live watch list instantly.  The expression is
  validated for balanced brackets and closed strings before being added; invalid syntax
  shows an error message without modifying the list.  The same validation runs when
  typing in the Watch Panel input field.

### Improved
- **Large eval-sel results** — if the rendered HTML exceeds ~60 KB the sidebar shows a
  size warning and a link *Open full result in editor* instead of attempting to display
  it inline (which could make the panel sluggish).  The full HTML is written to a temp
  file and opened via the standard VS Code text editor on click.

- **Eval-sel disabled during debug** — pressing `Cmd+Shift+E` while a debug session is
  active shows an informational message rather than trying to interrupt the paused
  kernel.  This prevents accidental kernel interruption mid-step.

- **WL syntax validation in watch input** — typing an expression with unbalanced
  brackets (`Sin[x)`) or an unclosed string in the Watch Panel input field now shows a
  red outline and a tooltip; the expression is not sent to the kernel.

---

## [2.1.1] - 2026-03-10

### Added
- **`WBExport[]` / `WBExport["path.nb"]`** — type `WBExport[]` in any code cell to
  save the current notebook as a standard Mathematica `.nb` file (saved next to the
  `.wb` by default, or at the specified path).  Markdown headings are mapped to
  Wolfram `Title` / `Section` / `Subsection` / `Subsubsection` cell styles; markdown
  text becomes `Text`; code cells become `Input`.  Intercepted by the extension —
  never sent to the kernel.

- **`WBInclude["file.nb"]`** — type `WBInclude["path"]` in any code cell to inline a
  Mathematica `.nb` file directly into the notebook.  The expression is intercepted by
  the extension (never sent to the kernel); the `.nb` is converted via the bundled
  toolchain (`nb2m` + `convert_nb_to_vsnb.wls`) and the resulting cells are inserted
  immediately after the `WBInclude` cell, preceded by a `## Included: filename.nb`
  markdown header.  Paths may be relative to the host notebook's directory or absolute.
  All temporary files are written to the system temp directory and cleaned up
  automatically — the user's source directories are never modified.

- **`wolfbook_restartKernel`** Copilot tool (`#wolfbookRestart`) — restarts the Wolfram
  kernel.  Shows a VS Code confirmation dialog before proceeding.

- **`wolfbook_abortEvaluation`** Copilot tool (`#wolfbookAbort`) — interrupts the
  currently running evaluation, equivalent to the Abort toolbar button.

### Fixed
- **`wolfbook_editCell` diff dialog** — switched from `NotebookEdit.replaceCells()` to
  a plain `TextEdit` on the cell's document URI, eliminating the VS Code structural-diff
  dialog that previously appeared on every AI cell edit.
- **`ai_eval_log.md` not written** — `clearEvalLog` / `appendEvalLog` now fall back to
  `visibleNotebookEditors[0]` when `activeNotebookEditor` is `null`.
- **Line-continuation split** — expressions spanning lines with a trailing operator
  (`x = a +\n b`) were incorrectly split into two separate evaluations.  The newline is
  now replaced with a space before dispatch so Wolfram sees one expression.
- **`unicode_mappings_filtered.json` missing from package** — `.vscodeignore` was
  excluding the entire `EditorVariation/` folder; now only the raw
  `unicode_mappings.json` and its README are excluded.

---

## [2.0.3] - 2026-03-01

### Added
- **Dynamic widget** — a new `Dynamic[expr]` cell type that displays live-updating output
  while a computation is running.  Place `Dynamic[expr]` on its own line (or mixed with
  static expressions in the same cell); a placeholder badge appears immediately and the
  slot re-renders every ~500 ms by interrupting the kernel into a `Dialog[]` subsession
  and evaluating `expr` there, or via a direct `sub()` call when the kernel is idle.
  - **Busy-path** (kernel computing): sends one `interrupt()`, opens `Dialog[]`, evaluates
    all Dynamic slots sequentially, closes the dialog, renders each result image via the
    render subkernel, then waits 500 ms and repeats.
  - **Idle-path** (nothing queued): evaluates each slot directly via `session.sub()` at
    most once per second, serialised with a per-cell mutex to prevent concurrent `sub()`
    calls on the same WSTP link.
  - Multiple `Dynamic[...]` expressions in one cell all update in the same dialog cycle.
  - Mixed cells (`Dynamic[n]\n1+1\nDynamic[m]`) — static sub-expressions evaluate
    normally; Dynamic slots update live alongside them.

- **`LiveTime -> t` expiry option** — widget loop exits and cell output is cleared after
  `t` wall-clock seconds.  Fires immediately (mid-computation if necessary).

- **`LiveEvaluations -> n` expiry option** — widget loop exits after `n`
  *sub-expression dispatches* to the kernel since the widget started (one Shift+Enter on
  a multi-line cell can count as multiple dispatches).  Expiry fires once the Nth
  sub-expression *finishes* (queue drains), so the computation is never interrupted at
  exactly the limit boundary.

- **`LiveCells -> n` expiry option** — like `LiveEvaluations` but counts *cell-level*
  dispatches (one per Shift+Enter, regardless of how many sub-expressions the cell
  contains).  A separate `_cellEpoch` counter increments once per cell execution.

- **Dynamic early-start** — when `Dynamic[expr]` appears before other sub-expressions in
  the same cell (e.g. `Dynamic[n]\nDo[...]`), the widget loop starts *inline*, before
  the remaining sub-expressions run.  Output slot is updated in-place via the owned
  `NotebookCellExecution`'s `replaceOutputItems()` while the cell is still executing,
  then switches to `createNotebookCellExecution` after `execution.end()`.  Enables
  fully live updates during a long computation started in the same cell.

- **Render subkernel prewarm** — when the first `Dynamic[...]` cell is registered, a
  second kernel process is launched in the background immediately (`_prewarmSubKernel`).
  By the time the first Dialog render is needed, `init.wl` is already loaded and the
  subkernel responds instantly instead of paying a ~1–2 s cold-start penalty.

- **`NotebookDirectory[]` auto-set on kernel start** — at the end of `launchKernel`,
  the extension locates the active wolfram notebook editor, extracts its directory, and
  evaluates:
  ```mathematica
  Unprotect[NotebookDirectory];
  NotebookDirectory[] = "/path/to/notebook/dir";
  Protect[NotebookDirectory];
  ```
  This makes `Get["data.m"]`, `Import["results.csv"]`, etc. resolve relative to the
  notebook file automatically, matching the behaviour of the Wolfram Desktop.

### Fixed
- **`LiveEvaluations` WSTP corruption bug** — when `LiveEvaluations->N` was set and the
  Nth sub-expression was still running (`busy=true`), the widget loop entered the
  interrupt path and sent `interrupt()` mid-`Dialog[]`.  This caused `dialogEval` to
  time out after 8 s, `exitDialog` to fail three times, and the WSTP link to corrupt —
  the cell would hang forever.  **Fix:** the busy-path interrupt is now skipped entirely
  when `_evalsSinceStart >= liveEvalLimit`; the `!busy` expiry check fires cleanly once
  the computation completes.

- **`LiveEvaluations` epoch semantics** — `_dispatchEpoch` now increments per
  *sub-expression* (just before each `session.evaluate(subExpr)`) rather than once per
  cell.  The previous per-cell increment meant a multi-line cell counted as 1 dispatch
  regardless of how many sub-expressions it contained.

- **Input cell height truncation** — the scroll-suppression code briefly set
  `inputCollapsed: true` on the next cell before `execution.end()`, then restored `{}`
  20 ms later.  VS Code used the collapsed state to measure the Monaco editor height and
  cached the wrong 2-line value — the cell appeared permanently truncated until manually
  collapsed and uncollapsed.  **Fix:** only `outputCollapsed: true` is set; the Monaco
  editor is never touched.

- **Output cell height after font load** — on first open of a saved notebook, MathML
  web-fonts are not yet cached; VS Code measures output iframe height with fallback
  metrics and caches a too-short value.  **Fix:** a sentinel `<div>` is appended and
  immediately removed inside `fonts.ready.then(...)` (or a 300 ms fallback) to trigger
  a height re-measurement after fonts are available.

- **Cell background colours preserved when kernel goes offline** — the `_applyKernelOfflineUI`
  / `_clearKernelOfflineUI` methods now also desaturate / restore the
  `workbench.colorCustomizations` notebook keys (`notebook.cellEditorBackground`,
  `notebook.editorBackground`, etc.).  Previously the output webview turned grayscale but
  the cell editor backgrounds kept their original colours (e.g. light green), creating a
  visual mismatch.  The conversion uses luminance weighting
  ($0.299R + 0.587G + 0.114B$) so perceived brightness is preserved.

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
