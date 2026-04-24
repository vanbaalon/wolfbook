# AI Integration — GitHub Copilot Agent Mode

→ [Back to README](../README.md)

Wolfbook is the first Wolfram Language notebook with deep GitHub Copilot agent integration. In Agent mode, Copilot gains live access to your running kernel: it can read your entire notebook, evaluate expressions, look up documentation, insert and edit cells, and drive the debugger — all without leaving VS Code.

---

## Activating Agent Mode

1. Open the Copilot Chat panel: `⌃⌘I` (Mac) / `Ctrl+Alt+I` (Windows)
2. Use the dropdown at the top of the panel to switch to **Agent** mode
3. Open a Wolfbook notebook (`.wb`) and start the kernel
4. Ask anything — Copilot reads your full notebook context automatically

---

## Tool Reference

| Tool | Reference | What it does |
|---|---|---|
| Get notebook context | `#wolfbookContext` | Reads all cells and their outputs — Copilot sees exactly what you have computed |
| Evaluate expression | `#wolfbookEval` | Runs any Wolfram Language expression in the live kernel |
| Look up symbol | `#wolfbookLookup` | Retrieves full usage docs, options table, and documentation link for any symbol |
| Full web help | `#wolfbookWebHelp` | Fetches the complete Wolfram reference page for a built-in symbol |
| Insert cell | `#wolfbookInsert` | Adds a new code or Markdown cell at any position |
| Edit cell | `#wolfbookEdit` | Replaces the source of an existing cell; set `evaluate:true` to run immediately |
| Run cell | `#wolfbookRun` | Executes an existing cell and stores the result as its output |
| Delete cell | `#wolfbookDelete` | Removes a cell; source is saved to `ai_deleted_cells.md` before deletion |
| Kernel state | `#wolfbookState` | Lists all user-defined symbols matching a context pattern with their current values |
| Save notebook | `#wolfbookSaveNotebook` | Saves the active notebook to disk |
| Restart kernel | `#wolfbookRestart` | Restarts the kernel (with confirmation) |
| Abort evaluation | `#wolfbookAbort` | Interrupts the currently running evaluation |
| Debug session | `#wolfbookDebug` | Full AI control of the step-through debugger |

---

## Example Prompts

### Understanding your notebook

```
What does the function BBrel do in my notebook?
```
```
What symbols have I defined so far? Show me the kernel state.
```
```
Verify that x + 1/x = u/g for the ZhukovskyX function using u=5, g=0.1
```

### Writing and fixing code

```
Add a cell at the end that plots the residuals of my QSC equations
```
```
My Solve call is returning {} — debug it using the values in cell 3
```
```
Fix the bug in cell 7 without adding a new cell
```
```
Re-run cell 5 to refresh its output after the kernel restart
```

### Documentation lookup

```
What are all the options for FindRoot? I want to set WorkingPrecision.
```
```
What are all the Method options for NIntegrate? I need to integrate Sin[1000 x] over a large range. Which method should I use and why?
```
```
Fetch the NIntegrate documentation page and show me the available Method options
```

### Agent-driven physics calculations

```
Find all physical Bethe roots for the XXX spin chain with L=8 sites and M=3 magnons.
Physical solutions must satisfy: all |Im(u)| < 1, solutions come in conjugate pairs or are real,
and exp(iP) must be a root of unity. Use the kernel to find and filter them. Make a table of
energies and momenta, and a plot of the configurations.
```

### Debugging

```
Analyze the step structure of cell 4, set a breakpoint at line 6, then step through it
```
```
Add x and i to the watch list, then debug cell 3 and tell me what goes wrong
```

---

## Tool Discovery — Always Do This First

Before any serious agent session, paste this prompt:

```
List all the Wolfbook tools available to you. For each tool, call it once on
a trivial example so you understand its interface. Show me the result of each call.
```

This calibrates the agent's understanding of what it can do. An agent that has probed its own tools makes far fewer mistakes. Use a fast model for this warm-up, then switch to a stronger one.

---

## Kernel Safety

The tools are kernel-aware and safe to use at any time:

- **Kernel busy detection** — if a notebook cell is currently evaluating, `#wolfbookEval` and `#wolfbookLookup` refuse to dispatch and return a clear "kernel is busy" message
- **Dynamic widget awareness** — if `Dynamic[...]` widgets are active, tools remain safe (Dynamic runs on a separate sub-channel)
- **Timeout abort** — if an evaluation exceeds `timeoutSeconds`, the kernel is cleanly interrupted and ready for the next request
- **Eval log** — `ai_eval_log.md` records every expression Copilot evaluates with its result; cleared on kernel restart

---

## Inline AI (Editor Mode)

Before using Agent mode, note that Copilot also works directly in the editor without the chat panel:

| Feature | Mac | Windows | What it does |
|---|---|---|---|
| Ghost text (auto) | just type | just type | Grey suggestion appears; Tab to accept |
| Accept suggestion | `Tab` | `Tab` | Accepts ghost text |
| Partial accept | `Cmd+→` | `Ctrl+→` | Accepts one word of ghost text |
| Force suggestion | `Opt+\` | `Alt+\` | Trigger completion immediately |
| Inline fix | 💡 → Fix using Copilot | same | Fix a bug without opening the chat |
| Inline chat | `Cmd+I` | `Ctrl+I` | Prompt bar appears inside the editor |

**Comment-driven generation** is particularly powerful: write only a comment describing your intent, position the cursor below it, and Copilot generates the full Wolfram Language body. For example:

```wolfram
(* Plot the one-loop twist-2 anomalous dimension in N=4 SYM as a function of spin s *)
```

Wait or press `Opt+\` — Copilot generates the full expression.

---

## Staged Plan-Driven Agent Workflows

For complex calculations, the most reliable approach is to give the agent a structured plan rather than a single open-ended prompt.

### How it works

1. Describe your problem to any LLM (Claude, ChatGPT, Gemini) and ask it to produce a `plan.md` — a staged Markdown instruction file with explicit verification steps
2. Edit `plan.md` yourself: tighten the verifications, add stages, fix the physics
3. Hand it to the agent: *"Follow plan.md stage by stage. Do not move to the next stage until the verification step passes."*

### What a good plan stage looks like

```markdown
## Stage 2 — Effective potential

Purpose: Compute V_eff(r) for a massive test particle.

Implementation: Define Veff[r_,L_] := ... from the geodesic equations derived in Stage 1.

Verification: At large r, Series[Veff[r,L],{r,Infinity,3}] must reproduce the Newtonian
result V → L²/(2r²) − GM/r. Check numerically: Veff[100,1] vs the Newtonian approximation.
```

### Generating plan.md

Ask any LLM:

```
TASK: [state your problem in 1–3 sentences]

CONVENTIONS: [state your notation — signature, units, coupling definitions]

Write a Markdown instruction file for a GitHub Copilot agent running inside Wolfbook
(Wolfram Language notebooks) that carries out the task above.

Requirements:
- Split into STAGES, each with PURPOSE and a mandatory VERIFICATION step.
  The agent must not advance until verification passes.
- Begin with a stage that fixes notation and defines the core symbolic objects.
- No Print statements. Expose intermediate results without trailing ; so Wolfbook renders them as LaTeX.
- Keep each logical expression on one line — Mathematica is sensitive to line breaks.
- Prefer symbolic Mathematica over numerics; switch to numerics only after symbolic groundwork.
```

→ See [Best Practices](best-practices.md) for more on this workflow.

---

## Recovery Prompts

When the agent stalls or produces unexpected output:

| Situation | Recovery prompt |
|---|---|
| Verification fails | "The check failed. Diagnose: compare our result with the expected analytic limit." |
| Agent skips a check | "You must verify before moving on." |
| Numerics diverge | "Try increasing WorkingPrecision or switch to a different Method. Explain the choice." |
| Cell produces no output | "The cell produced no output. Read the current kernel context and check what went wrong." |
| Agent is confused | "Re-read plan.md and tell me which stage we are on and what the next action is." |

---

## Debugger Control via AI

Copilot can drive the debugger autonomously via `#wolfbookDebug`. Available actions:

| Action | What Copilot does |
|---|---|
| `analyze` | Inspect a cell's step structure — sees step count, depth levels, loop variables |
| `start` / `stop` | Start or abort a debug session on any cell by number |
| `status` | Read the current position (depth, step, iterator values) |
| `stepOver` / `stepInto` / `stepOut` | Issue step commands and get back the new position |
| `continue` / `runToEnd` | Run to the next breakpoint or to completion |
| `addBreakpoint` / `removeBreakpoint` | Set or remove a breakpoint on a specific line |
| `clearBreakpoints` / `listBreakpoints` | Clear or list breakpoints |
| `addWatch` / `removeWatch` / `listWatch` | Manage the Watch Panel variable list |

Example prompt:
```
Analyze the step structure of cell 4, set a breakpoint at line 6, watch x and i,
then start a debug session and report the variable values when the breakpoint is hit.
```
