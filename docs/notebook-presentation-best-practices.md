---
title: Wolfbook notebook authoring and presentation best practices
guidance_version: 1
status: draft
scope: universal
---

# Wolfbook notebook authoring and presentation best practices

→ [Back to Best Practices](best-practices.md) · [AI Integration](ai-integration.md) · [MCP and Agent Tools](mcp-and-agent-tools.md)

This guide defines the project-independent standard for research notebooks written in Wolfbook, whether they are authored by a person, an AI agent, or both. It is distilled from Wolfbook’s current system prompt, agent skill, and research-notebook documentation.

The aim is not to impose one visual template. The aim is to make a notebook readable, auditable, rerunnable, and honest about what its computation establishes.

## The short version

A good Wolfbook notebook should:

1. Address one precise question and identify its main result.
2. State conventions and introduce notation before using them.
3. Alternate explanation, visible computation, and interpretation.
4. Display the mathematics that the code actually evaluates.
5. Prefer exact symbolic work before numerical approximation.
6. Use concise outputs and labelled tables rather than expression dumps.
7. Verify each important stage independently.
8. Distinguish fitting, numerical evidence, and genuine validation.
9. Run cleanly from top to bottom in a fresh kernel.
10. End with a conclusion that claims no more than was demonstrated.

## 1. Begin with a precise purpose

Give a short research notebook one main question and one principal result. State both near the beginning so that a reader knows what the computation is trying to establish.

Move the following to companion notebooks when they would obscure the main line:

- exploratory derivations;
- anomaly investigation;
- alternative formulations;
- parameter scans that are not needed for the conclusion;
- large diagnostic calculations.

Starting from a smaller known case is usually safer than beginning with the final complicated problem. Reproduce a benchmark, analytic limit, symmetry, or published special case before extending the calculation.

## 2. Plan work in verifiable stages

For a multi-stage calculation, write down the stages before implementing them. Each stage should identify:

- **Purpose:** what the stage establishes;
- **Implementation:** what definitions or computations it introduces;
- **Verification:** an independent check that must pass before continuing.

Useful checks include:

- a known analytic limit;
- a symmetry or conservation law;
- a dimensional or normalization check;
- comparison with a published benchmark;
- substitution back into the defining equation;
- an independent data point not used in a fit.

Do not move on merely because code evaluated. Evaluation without messages is necessary, but it is not evidence that the mathematics is correct.

## 3. Organize the notebook as an argument

The preferred local structure is:

1. **Markdown cell:** state the sub-question, definition, or claim.
2. **Code cell or cells:** compute or verify it visibly.
3. **Markdown cell:** interpret the result or explain the transition.

Avoid long sequences of unexplained code cells. A reader should be able to understand why a cell exists without reconstructing the argument from variable names.

Introduce notation immediately before its first use. Auxiliary notation is useful only when it clarifies the argument; do not shorten algebra at the cost of hiding the original formula.

State conventions that can change the meaning of the result, including as applicable:

- normalization and units;
- sign and metric conventions;
- branch choices;
- pole or contour prescriptions;
- index and arrow orientations;
- precision and tolerance conventions.

## 4. Keep mathematics and code aligned

Display the mathematical definition that the code actually evaluates. Do not present one formula in prose and silently implement a modified one in code.

Use proper LaTeX in Markdown cells:

- inline mathematics: `$f(x)=x^2$`;
- displayed mathematics: `$$f(x)=x^2.$$`

Avoid Unicode quasi-mathematics and ASCII approximations for displayed equations. They are harder to read and can conceal ambiguities such as precedence, subscripts, and limits.

After an analytical derivation, add a code cell that computes or verifies the result. Typical checks are:

```wolfram
FullSimplify[lhs - rhs]
```

```wolfram
FullSimplify[definingEquation /. proposedSolution]
```

```wolfram
Series[exactExpression, {parameter, limitPoint, order}]
```

Do not type numerical values by hand when Wolfram Language can derive or substitute them from the symbolic definitions already in the notebook.

Prefer the project’s public package functions over copying their internal algorithms into a notebook. Preserve meaningful symbolic objects, branch information, and prescriptions instead of replacing them silently with convenient finite or numerical forms.

When mathematical symbols improve correspondence with the displayed equations, use them consistently in code. Names should aid comparison between the derivation and its implementation.

## 5. Preserve exactness before using numerics

Separate symbolic and numerical stages where possible:

1. define the exact objects;
2. derive and simplify symbolically;
3. establish analytic checks;
4. introduce numerical values and precision deliberately;
5. validate the numerical result independently.

Avoid premature machine-precision conversion. For sensitive calculations, specify and report:

- `WorkingPrecision`;
- input precision;
- accuracy and precision goals where relevant;
- rationalization or exactification choices;
- the tolerance used by every numerical acceptance test.

Numerical agreement should be reported at a scale appropriate to the working precision, not merely as “close to zero.”

## 6. Write clear Wolfram Language cells

Keep definitions focused and avoid unnecessary wrappers. Use `Module`, `With`, `Block`, or related constructs only when they provide needed scoping, evaluation control, or numerical behavior.

In a dedicated notebook, prefer one clear context declaration near the beginning over repeatedly wrapping individual cells in context-management code.

A newline separates Wolfram Language inputs unless the expression is syntactically grouped. For a multiline expression, keep it inside matching brackets or another explicit grouping construct. Each top-level statement should be complete and unambiguous.

Use semicolons to suppress setup and intermediate definitions, but leave the meaningful final expression unsuppressed:

```wolfram
a = 1;
b = 2;
a + b
```

Use `Print` for progress messages or intentionally separate intermediate reports, not as the default way to expose results.

Prefer visible notebook cells over silent one-off evaluations when a computation forms part of the research record. A visible cell can be reviewed, rerun, versioned, and reproduced.

## 7. Present results for the reader

Show the smallest amount of output needed to establish the claim. Avoid:

- large intermediate expressions with no interpretation;
- repeated equivalent forms;
- full internal data structures when only a few fields matter;
- diagnostics unrelated to the stated conclusion.

For human-facing comparisons and multi-value summaries, use a labelled `Grid`:

```wolfram
Grid[{
  {"Check", "Result"},
  {"Defining equation", equationCheck},
  {"Boundary condition", boundaryCheck},
  {"Relative residual", relativeResidual}
}, Frame -> All, Alignment -> Left]
```

Keep `Association` for internal structured data, programmatic interchange, and package return values. Convert the relevant fields to a readable table for presentation.

A useful final diagnostic normally reports:

- the quantity being checked;
- its expected scale or target;
- absolute residual;
- relative residual;
- working precision;
- uncertainty or tolerance, when applicable.

For a sum of terms, a standard residual pair is:

```wolfram
absoluteResidual = Abs[Total[terms]];
relativeResidual = absoluteResidual/Total[Abs[terms]];
```

The relative residual is essential when large terms cancel.

## 8. Be precise about evidence

Use language that reflects the actual strength of the result. Recommended evidence labels are:

- **structurally excluded**;
- **numerically rejected**;
- **pair-fitted**;
- **independently validated**;
- **conditional**;
- **open**.

A fit is not a validation. Before claiming that candidates are excluded or selected:

1. state the ansatz or candidate space;
2. identify the data used for fitting;
3. test the fitted result on independent equations or data;
4. report residuals, precision, and tolerances;
5. record what remains untested.

When several candidates are under study, maintain one candidate ledger rather than scattering conclusions through the notebook. Include:

- candidate;
- current evidence status;
- fit data;
- independent check;
- residual and precision;
- next test.

Distinguish clearly between:

- a conceptual conclusion;
- numerical evidence for it;
- a result conditional on a convention or prescription.

## 9. Treat warnings and stale outputs as failures of the record

A definition cell or a semicolon-terminated cell may correctly produce no output. Absence of output alone is not an error.

Warnings, syntax messages, and failed assertions require attention before dependent cells are trusted. Fix the relevant source and rerun the affected sequence.

Do not retain an output that was produced by older cell source. An output is evidence only when it corresponds to the current code and the current kernel state.

When an evaluation times out or returns an uncertain state, determine whether the original operation is still running before rerunning it. Never create duplicate long computations merely because the client stopped waiting.

## 10. Manage context and hidden state

Before treating results as final:

1. restart or clear the relevant kernel;
2. run the notebook from top to bottom in order;
3. confirm that every required definition is present in a cell or explicitly loaded package;
4. confirm that the same conclusions and diagnostics are reproduced.

Hidden state commonly comes from:

- definitions created by one-off agent evaluations but never inserted into the notebook;
- cells evaluated earlier and later deleted;
- packages or include files loaded outside the visible setup;
- symbols left over from a different calculation;
- evaluation performed out of notebook order.

Keep sessions focused. When agent context becomes long or confused, record a concise summary of established results, unresolved questions, and the next verified step before continuing in a fresh session.

## 11. Use version control as part of verification

Wolfbook notebooks are text files and should be version controlled with their supporting plans, packages, and data descriptions.

Commit after a stage has passed its verification, not merely after code has been added. A useful commit records the established result:

```text
Stage 3 verified: boundary residual below tolerance at 80-digit precision
```

Review notebook diffs for changes to:

- cell source;
- cell order;
- stored outputs;
- assumptions and conventions;
- validation thresholds.

Version control provides a recoverable record, but it does not replace a clean-kernel rerun.

## 12. Rules for AI agents

Before changing a notebook, an agent should read its current cells, outputs, notebook instructions, and kernel binding.

For notebook changes, use Wolfbook cell operations. Never edit the serialized `.wb`, `.evsnb`, or `.vsnb` file directly with generic filesystem replacement tools.

Prefer stable cell IDs when editing or moving cells because numeric positions change after insertion, deletion, and movement.

For a multi-step task:

1. state the stages and checks;
2. implement one stage;
3. run its verification;
4. resolve warnings or contradictions;
5. continue only after the evidence supports it.

When a choice changes the mathematical meaning—such as a branch, convention, ansatz, normalization, or prescription—ask the user or domain specialist rather than guessing.

## 13. Project-specific overlays

Projects may add conventions to this guide. An overlay should contain only rules genuinely specific to that project, such as:

- package APIs that must be used;
- named contexts;
- normalization conventions;
- admissible ansätze;
- branch or pole prescriptions;
- required project benchmarks.

Project instructions extend this guide; they should not silently replace its safety, reproducibility, or evidence standards.

## 14. Final notebook checklist

Before sharing, publishing, or relying on a notebook, confirm:

- [ ] The notebook states one precise question and its main result.
- [ ] Important notation and conventions are explicit.
- [ ] Displayed mathematics matches the evaluated code.
- [ ] Symbolic work precedes numerical approximation where practical.
- [ ] Every important stage has an independent verification.
- [ ] Outputs are concise, labelled, and current.
- [ ] Warnings, syntax messages, and failed checks are resolved.
- [ ] Residuals include scale, precision, and tolerance information.
- [ ] Fits are distinguished from independent validation.
- [ ] The notebook runs top-to-bottom in a fresh kernel.
- [ ] Required definitions are visible or explicitly loaded.
- [ ] The conclusion states exactly what was demonstrated.
- [ ] Project-specific assumptions are clearly labelled.
- [ ] The verified state is committed to version control.
