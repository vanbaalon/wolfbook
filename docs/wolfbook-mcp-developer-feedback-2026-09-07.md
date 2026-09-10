# Wolfbook MCP developer feedback: efficiency and friction

**Date:** 2026-09-07  
**Perspective:** agent using Wolfbook through MCP in real notebook workflows  
**Evidence:** retained Wolfbook activity ledger for 2026-09-06 and 2026-09-07, plus direct inspection of current tool contracts

## Scope and an important limitation

The activity ledger does not currently record a Codex task ID or turn ID, so it
is impossible to isolate one conversation with certainty. The quantitative
sample below covers the retained two-day window and includes 15
`codex-mcp-client` sessions and two `claude-code` sessions. It should be read as
a representative workflow sample, not as an exact transcript of one turn.

That limitation is itself actionable feedback: every event should carry stable
`agentSessionId`, `taskId`, `turnId`, `operationId`, and `parentOperationId`
fields where the client provides them.

## Executive assessment

Wolfbook's core notebook operations are fast and generally dependable. Reading
context, searching cells, resolving status, switching targets, opening a
notebook, and saving are all low-friction. The main cost is not raw tool latency;
it is orchestration around long evaluations, repeated context retrieval,
routing, and incomplete lifecycle telemetry.

| Area | Assessment | Main reason |
| --- | --- | --- |
| Read and search | Excellent | Millisecond latency, stable results |
| Notebook mutation without evaluation | Good | Fast and cell-ID based |
| Evaluation lifecycle | Friction-heavy | Repeated polling and ambiguous long waits |
| Notebook routing | Functional but repetitive | Too many explicit target-resolution calls |
| Error recovery | Mixed | Strong cancellation concepts, weak structured errors |
| Observability | Needs work | Agent identity and terminal-event gaps |
| Small-model usability | Improving | Economy profile helps, but workflows still require many decisions |

## Observed performance

These figures are for `codex-mcp-client` calls in the two-day sample. Duration
percentiles use calls for which a matching terminal event was available.

| Tool | Calls | Median | p95 | Interpretation |
| --- | ---: | ---: | ---: | --- |
| `wolfbook_searchCells` | 89 | 1 ms | 4 ms | Essentially frictionless |
| `wolfbook_getNotebookContext` | 360 | 3 ms | 45 ms | Fast, but called very often and potentially token-heavy |
| `wolfbook_status` | 51 | 4 ms | 5 ms | Excellent unified read surface |
| `wolfbook_setTarget` | 55 | 1 ms | 4 ms | Cheap, but repeated routing is cognitive/tool-call overhead |
| `wolfbook_newNotebook` | 44 | 297 ms | 712 ms | Good for an editor-opening operation |
| `wolfbook_editCell` | 82 | 36 ms | 3.9 s | Fast normally; evaluation-coupled edits create a long tail |
| `wolfbook_insertCells` | 89 | 289 ms | 35 s | Mutation and evaluation are conflated |
| `wolfbook_runCell` | 44 | 309 ms | 28.5 s | Reasonable for computation, but lifecycle handling dominates |
| `wolfbook_evaluateExpression` | 318 | 23 ms | 96 s | Fast for small expressions; very long tail for real work |
| `wolfbook_operationStatus` | 252 | 30 s | 50 s | Polling/waiting consumes many agent turns |

The ledger contained 2,088 started operations, of which 112 had no matching
terminal event in the inspected files. Some may cross retention/day boundaries
or still have been active, but the number is high enough that interrupted or
expired operations need an explicit terminal state.

## What worked well

### 1. Notebook reads and navigation are genuinely fast

`wolfbook_getNotebookContext`, `wolfbook_searchCells`, and `wolfbook_status`
return quickly enough that an agent can inspect before editing without feeling
penalized. This supports the correct safety rule: read the notebook before
changing it.

Cell IDs are much safer than relying only on mutable cell numbers. Search
results that return both an ID and a preview make follow-up edits predictable.

### 2. The unified status direction is correct

`wolfbook_status` is a better model-facing surface than several overlapping
client/kernel/status tools. It is quick, side-effect-free, and gives the agent a
safe way to inspect a busy system.

Continue moving old aliases out of the advertised tool list while retaining
them only as compatibility shims. Smaller models benefit more from one obvious
status tool than from aliases with subtly different schemas.

### 3. Long-operation IDs are the right primitive

Durable operation IDs, explicit cancellation, result handles, progress
sequences, and the distinction between aborting execution and discarding a
future result are all sound design choices. They are substantially safer than
transport timeouts that silently terminate work.

### 4. Source fidelity and notebook safety are strong

The tools preserve Wolfram and LaTeX backslashes, reject corrupt control
characters, protect notebook JSON from generic file editing, and retain deleted
cells for recovery. These are valuable guardrails and should not be weakened in
the name of fewer calls.

### 5. Batch-oriented cell schemas help

Allowing several cells in one `insertCells` or `editCell` request can eliminate
many round trips. This is especially effective when the agent is creating a
short derivation containing explanatory Markdown and executable cells.

## Main sources of friction

### P0: notebook changes lose the responsible agent

All 394 `notebook.cell.*` events in the inspected period lacked both
`agentName` and `agentSessionId`, even when they occurred immediately after an
MCP tool operation. This prevents the UI from answering the most important
questions: who changed this cell, which task caused it, and which operation can
be inspected or undone?

The current async activity context does not survive the VS Code notebook-change
event boundary. Do not infer authorship from timing in the dashboard. Persist a
short-lived correlation record before applying the edit:

```text
notebook URI + cell ID + expected source hash
    -> agent session + task/turn + operation ID + action
```

Consume that record when `onDidChangeNotebookDocument` fires. Keep timing only
as a fallback and label inferred attribution explicitly.

### P0: every started operation needs a terminal event

On disconnect, extension reload, transport expiry, cancellation, or lost kernel
ownership, write a terminal event such as `interrupted`, `abandoned`,
`lost-on-reload`, or `unknown-after-crash`. A stale `running` event must never be
indistinguishable from live work.

The server should own this invariant rather than requiring each tool to emit
its own cleanup event.

### P0: errors should be structured and useful

Several recorded `tool.failed` events, including `wolfbook_kernelManager`
failures, had no useful `payload.error`. Every failed tool result and ledger
event should include:

```json
{
  "code": "KERNEL_BUSY",
  "message": "Kernel K3 is evaluating operation …",
  "retryable": true,
  "remedy": "Wait for operation … or abort it explicitly.",
  "currentState": {}
}
```

Models recover much more reliably from a small stable error vocabulary than
from prose matching.

### P1: polling dominates long-running workflows

There were 252 `wolfbook_operationStatus` calls, with a 30-second median and a
50-second p95. This is technically correct but interaction-heavy: the model
must decide how long to wait, call again, interpret another nonterminal state,
and preserve the operation ID repeatedly.

Recommended behavior:

- Keep `operationStatus` as an immediate snapshot.
- Make `waitEvaluation` a true long-poll that returns only on terminal state,
  meaningful progress change, or a bounded heartbeat.
- Return `nextRecommendedWaitMs` and `progressRevision` in every nonterminal
  response.
- Support `afterRevision` so unchanged progress does not consume response
  tokens.
- Where the MCP transport supports it, send completion/progress notifications
  instead of requiring polling.

### P1: mutation and evaluation should be easier to distinguish

`insertCells` and `editCell` can also evaluate. This is convenient, but it makes
a nominal edit call take anywhere from milliseconds to five minutes. It also
makes cancellation semantics harder for smaller models.

Keep the combined option for expert/batch use, but optimize the default contract
around two visible phases:

1. Apply the notebook mutation and return its revision/cell IDs immediately.
2. If evaluation was requested, return a separate operation handle immediately
   once execution exceeds a short threshold.

The response should say both independently:

```text
Edit: committed, notebook revision 42
Evaluation: running, operation 8b0…
```

This removes ambiguity about whether a timed-out request applied its edit.

### P1: context calls are cheap in time but expensive in tokens

The 360 context reads completed quickly, so backend performance is good. The
remaining cost is repeatedly returning cells the agent has already seen.

Add an incremental contract:

```json
{
  "notebook": "…",
  "sinceRevision": 41,
  "include": ["changedCells", "outputs", "selection"]
}
```

The response should return the current revision and only changes since the
known revision. Also provide a compact outline projection containing headings,
cell IDs, cell numbers, source hashes, and short previews. Full source can then
be fetched only for selected cells.

### P1: routing is fast but too explicit

There were 55 explicit `setTarget` calls and 96 recorded target changes. Target
selection is cheap, but every routing step is another opportunity for a small
model to choose a stale notebook or kernel.

Recommended improvements:

- Let every notebook tool accept `notebook` as an atomic routing assertion.
- Return the resolved notebook, window, and kernel on every mutation/evaluation.
- Preserve a session target across harmless transport reconnects.
- If the requested target changed, return a typed `TARGET_CHANGED` response
  with the replacement binding rather than requiring discovery from scratch.
- Prefer notebook URI as the durable target; treat kernel ID as an optimistic
  assertion because it is extension-host-lifetime state.

### P2: the economy profile should optimize workflows, not only tool count

A small model needs a compact set of orthogonal tools and short responses. A
useful economy surface is approximately:

1. `wolfbook_status`
2. `wolfbook_getNotebookContext`
3. `wolfbook_searchCells`
4. `wolfbook_newNotebook`
5. `wolfbook_editCell` / `wolfbook_insertCells`
6. `wolfbook_runCell` / `wolfbook_evaluateExpression`
7. `wolfbook_waitEvaluation`
8. `wolfbook_cancelOperation`
9. `wolfbook_getResult`

Deprecated aliases, team workflow tools, paper tools, terminal/file tools, and
specialist diagnostics should not appear in that profile. The economy profile
should also use compact response projections by default and include one
unambiguous `nextAction` hint.

### P2: human-waiting states should not look like compute time

The ledger showed implausibly long durations for plan/decision workflows.
Waiting for a human decision or UI interaction must be a distinct state such as
`waiting-user`, excluded from kernel-busy time and execution latency metrics.

## Recommended response contract

Every mutating or evaluating tool should return the same small envelope:

```json
{
  "ok": true,
  "state": "completed | running | queued | failed",
  "notebook": { "uri": "…", "revision": 42 },
  "cell": { "id": "…", "number": 17 },
  "kernel": { "id": "…", "label": "K3" },
  "operation": { "id": "…", "revision": 6 },
  "result": {},
  "nextAction": null
}
```

Fields that do not apply can be omitted. Consistency matters more than returning
every diagnostic detail in the main response. Large source, output, routing,
and debug data should be available behind handles or explicit detail flags.

## Suggested implementation order

1. Fix agent/task/operation attribution for notebook audit events.
2. Guarantee a terminal state for every started operation.
3. Standardize structured errors and the common response envelope.
4. Reduce polling with revision-aware long waits and notifications.
5. Add notebook revision-based incremental context.
6. Make routing atomic on notebook tools and reconnect-safe.
7. Tighten economy-mode schemas and response projections using telemetry from
   real small-model runs.

## Success metrics

For a representative notebook task, target:

- At least 95% of notebook changes attributed to an agent/task/operation.
- 100% of started operations eventually receiving a terminal state.
- Fewer than one status-poll call per meaningful progress change.
- At least a 50% reduction in repeated context bytes per task.
- No separate `setTarget` call when the next tool already supplies a notebook.
- Zero empty structured errors.
- A median of no more than three tool calls for: inspect one cell, edit it, run
  it, and confirm the result (excluding actual compute wait time).

## Bottom line

The notebook primitives themselves are already good. Wolfbook will feel much
more frictionless by making operation lifecycle, routing, attribution, and
incremental context implicit and consistent. The highest-value work is not
adding more tools; it is allowing an agent to make fewer decisions between the
tools that already work.
