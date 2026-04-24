# Best Practices — Working Effectively with Wolfbook and AI Agents

→ [Back to README](../README.md)

This document distils what works well when using Wolfbook for research-level computations with AI assistance. The recommendations are based on experience from the CERN April 2026 workshop and ongoing research use.

---

## General Principles

### 1. Plan before you prompt

Split large tasks into staged instruction files (`plan.md`) with explicit verification steps at each stage. Draft the plan with any LLM, then edit it yourself before handing it to the agent. The quality of the plan directly determines the quality of the computation.

A good stage has:
- **Purpose** — what is being established
- **Implementation** — what Wolfram Language code to write
- **Verification** — an independent check (analytic limit, symmetry, known benchmark) that must pass before moving on

The agent must not advance past a stage until verification passes. If you enforce this, most pathological behaviour becomes recoverable.

### 2. Start simpler than you think you need to

Ask the agent to reproduce a known result first — a textbook formula, a benchmark from a paper — before attacking the real question. If it gets the known result right, you can trust its next step. If it gets it wrong on a simple case, the error will be much easier to diagnose than if it surfaces inside a complex computation.

### 3. Verify continuously, not at the end

Ask the agent to explain its code. A result you cannot explain is a result you cannot trust. Prefer symbolic intermediates (no trailing `;`) over `Print[]` statements: they render in LaTeX via the btl pipeline and feed back cleanly on the next turn.

### 4. Use LaTeX output as a check

Because Wolfbook renders results via KaTeX, you can read symbolic output directly in the notebook. If the agent writes something wrong, you will see it immediately in the rendered math — before any numerical step amplifies the error.

### 5. Separate symbolic from numeric stages

Have the agent do all symbolic manipulation first (derive equations, simplify, expand in limits), then switch to numerics. Mixing the two leads to premature loss of exactness and hard-to-diagnose numerical noise.

---

## Kernel and Context Management

### Restart before trusting results

Re-run the notebook top-to-bottom on a clean kernel before treating any result as final. Hidden state from previous sessions can produce outputs that look correct but depend on definitions that will not be there in a fresh run.

### Keep sessions focused

Use separate chat sessions for different tasks. Mixing too many topics in one long session causes context drift and confused tool calls. When a session drifts:

1. Ask the current agent to summarise what was done into a Markdown cell
2. Review and edit the summary yourself
3. Start a fresh session with: *"Here is a summary of the previous session. Use it as context and continue with the next task."*

### Watch the eval log

Wolfbook writes every expression the agent evaluates to `ai_eval_log.md`. Check it periodically — it tells you exactly what the agent has run and what results it got back.

### No trailing semicolons in plan.md

Intermediate results should be visible to both you and the agent. Avoid trailing `;` in the code the agent writes unless the output is genuinely not needed. Exposed outputs render in LaTeX and give the agent (and you) a signal for whether the computation is on track.

---

## Working with the Debugger

### Set breakpoints before long loops

If you have a loop that you suspect produces wrong results, set a breakpoint (`F9` or click the gutter) before running it. Press `Cmd+Shift+D` to start a debug session and step through with `F10`.

### Use the Watch Panel for intermediate values

Add variables to the Watch Panel (`Cmd+Shift+W`) before starting a computation. The panel refreshes after every step — much less disruptive than adding `Print[]` statements.

### Evaluate selections mid-computation

While a long cell is running, select any sub-expression and press `Cmd+Shift+E` to evaluate it without interrupting the main computation. Useful for checking whether an intermediate value is what you expect.

### Let the AI debug for you

For tricky bugs, describe the symptom to the agent:

```
The function QSCNumerical is returning complex values for real coupling.
Debug cell 7 — set a breakpoint at line 12, step through, and tell me 
what value of the intermediate variable causes the problem.
```

---

## Writing Prompts for Physics Calculations

### State conventions upfront

Different sources use different conventions — signature, units, coupling definitions, index placement. State yours explicitly at the start of the plan and tell the agent to translate everything it looks up into your conventions. Do not assume the agent knows which convention you mean.

### Put physics constraints in the plan, not in chat

If your problem has symmetry requirements, conservation laws, or boundary conditions, specify them in `plan.md` as verification criteria — not as corrections you provide interactively. This makes the run reproducible.

### Use literature review early

Even for a calculation you know well, ask the agent to search for relevant papers and identify benchmark values. This catches whether someone has already published the result, surfaces better algorithms, and gives you verification targets.

Suggested prompt for the literature warm-up stage:

```
Search for 3–5 key papers most relevant to [YOUR TOPIC]. For each, create a Markdown cell 
with: the full reference, a 2–3 sentence summary of the main result, and the key formula 
in LaTeX. Then identify one benchmark result we can use to verify our first numerical output.
```

### Keep expressions on one line

Wolfram Language is sensitive to line breaks in some contexts. When writing code in plan.md, keep each logical expression on one line.

---

## Version Control

Use git for your notebooks. Because `.wb` files are plain text, `git diff` shows exactly what changed — which cells were added, which expressions were modified, which outputs changed.

Commit after each successful stage. This gives you checkpoints to revert to if a later stage breaks something:

```bash
git add calculation.wb plan.md
git commit -m "Stage 3 verified: effective potential matches Newtonian limit"
```

---

## Reproducibility

The real test of a Wolfbook calculation is:

1. Clear the kernel completely
2. Run all cells top-to-bottom in order
3. Get the same results

If step 3 fails, there is hidden state somewhere. Common causes:
- A variable set in the chat/agent eval log that was never put in a cell
- A `WBInclude` that pulls in definitions from another file
- A cell that was deleted after being evaluated

Before publishing results, always do a full clean-run verification.

---

## Writing Up Results

Once the calculation is solid, ask the agent to draft write-up notes:

```
Write a self-contained LaTeX document summarising the method, the key formulas, 
and the main results. Include all significant plots as figures. Make sure the LaTeX compiles.
```

Then review the notes yourself — the agent may omit caveats or gloss over subtleties. Use the raw LaTeX output from the **src** button on each cell's output to copy formulas directly into your paper.
