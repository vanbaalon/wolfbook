# Wolfbook MCP: Systemic Improvement Proposal

**Date:** 2026-08-17  
**Input:** *Wolfbook Field Report*, based on a long numerical-computation session  
**Scope:** Improvements that generalize across agents, notebooks, workloads, and MCP clients  
**Status:** Verified against the codebase 2026-08-17 (see *Code verification*); design
amendments incorporated; implementation plan appended at the end.

> **Format boundary (confirmed 2026-08-17):** this project must not change the
> `.wb`, `.evsnb`, or `.vsnb` file format or alter what the serializer persists.
> Source hashes, execution provenance, compact output manifests, journals,
> result handles, and derived/canonical views in this proposal are MCP-facing
> projections held in extension memory or bounded sidecars. They must never be
> injected into notebook cell metadata merely to support agents. Existing
> notebooks must remain byte/structure compatible apart from ordinary user
> edits, evaluated outputs, and explicit saves.

## Executive summary

The report is credible on its most important points. Inspection of the current
implementation confirms that several kernel-facing tools call `abortAndWait()`
before doing their own work. In particular, `runCell`, range execution,
`getKernelState`, and evaluate-after-edit paths can pre-empt an existing
evaluation. The controller even describes this behavior as allowing AI tools to
“claim priority.” That is unsafe as a default for long-running scientific work.

The highest-value response is not a collection of isolated tool fixes. Wolfbook
needs three shared contracts:

1. **A non-preemptive kernel arbiter.** No tool except an explicit abort command
   may interrupt current work. Every kernel-mutating tool must acquire the same
   execution lease or return a structured busy response.
2. **A unified operation and status model.** Long work must have an operation ID,
   lifecycle state, progress, timing, and attributable cancellation. Status must
   be read entirely from extension memory and never evaluate Wolfram code.
3. **Revision-bound output commits.** An output belongs to a specific cell ID,
   source revision, and execution ID. A tool may report success only after the
   matching output has been committed to the notebook document.

These changes address the lost computations, blind probing, stale displayed
results, ambiguous `$Aborted` state, and inconsistent timeout behavior as one
coherent reliability problem.

## Critical assessment of the field report

| Observation | Assessment | Evidence in the current implementation | Decision |
|---|---|---|---|
| Incoming tool calls can interrupt running work | **Confirmed and systemic** | Multiple tools call `controller.abortAndWait()` before running. `abortAndWait()` calls `abortEvaluation()`, clears the queue, and tells the user the AI took priority. | P0 fix |
| There is no side-effect-free busy/status query | **Confirmed** | `getKernelState` explicitly aborts active work and then evaluates a kernel expression. Controller fields already contain most status data, but no MCP tool exposes them without touching WSTP. | P0 fix |
| Edit-and-evaluate can report an output that the notebook does not show | **Plausible and architecturally explained** | Single-cell `editCell(evaluate:true)` evaluates source directly through `session.evaluate()` rather than the notebook execution pipeline. It returns the direct result but does not replace the cell's stored outputs. Batch edit uses the notebook pipeline, so the two modes have different guarantees. | P0 fix |
| Warnings stop range execution as if they were failures | **Confirmed** | Range execution sets `hasError` for either the error sentinel or any `Symbol::tag:` text and stops when `stopOnError` is true. This conflates messages with failed execution. | P1 fix |
| Stale abort state survives and causes later `$Aborted` | **Plausible, not fully proven by one transcript** | Abort state is distributed across `_abortPending`, `isAborting`, `_evalDispatched`, queue state, and native WSTP state. `abortAndWait()` force-clears JavaScript flags after a timeout even without proof that the native abort lifecycle is complete. | Address through P0 arbiter and cancellation provenance; add targeted stress tests |
| Numeric addressing causes destructive mistakes | **Confirmed risk, but user error is only part of it** | Stable cell IDs exist, yet numeric edits have no optimistic precondition for expected kind/source. Confirmation does not consistently show old kind and source preview. | P1 fix |
| Notebook output dominates raw `.wb` size | **Directionally confirmed, but on-disk redesign is out of scope** | The serializer persists every output MIME item, including rendered HTML and plain text. MCP should avoid exposing redundant render payloads by default while leaving serialization unchanged. | P2 MCP projection project |
| `getCellOutput` conflates never-run, suppressed, and running | **Confirmed** | With no stored output it returns one combined string: “not evaluated yet or suppressed result.” Execution state is not persisted with source provenance. | Fold into P0 output provenance |
| `list_clients` duplicates notebook entries | **Likely and cheap to prevent** | Formatting trusts each client's notebook array without deduplicating normalized paths. | P2 fix |
| Worker kernels would halve wall time | **Workload-specific and operationally expensive** | Parallelism may help independent integrals, but kernel licensing, state synchronization, package initialization, cancellation, and deterministic output ownership are unresolved. | Defer |

## Code verification and additional findings (2026-08-17)

Every row above was checked against the shipped code. Line references are into
`out/extension/`.

### Confirmed, with exact locations

- **Preemptive `abortAndWait()` call sites (seven agent paths):**
  `tools/index.js:517` (`evaluateExpression`), `:978` (`insertCells` with
  `evaluate:true`), `:1358` (`editCell` batch mode), `:1595` (`editCell`
  single-cell `evaluate:true`), `:1719` (`runCells` range mode), `:1866`
  (`runCell` single-cell), `:2023` (`getKernelState`). Two further callers:
  `oberon/core/wolframShim.js:565` (the Fairy's `runNotebook` — a *deliberate*
  exclusive claim for agent runs) and `remote/index.js:569` (`abortEval` — a
  legitimate explicit abort API, not preemption).
- **`abortAndWait()` itself** (`controller.js:1843–1888`): shows the toast
  “⚡ AI tool has taken kernel priority — your evaluation was aborted”, and after
  a 10 s poll timeout **force-clears `isAborting` and `_abortPending` without
  native confirmation** (`controller.js:1877–1883`). This substantiates the
  stale-abort/`$Aborted` observation mechanically, even though no single
  transcript proves the full chain.
- **`getKernelState` aborts then evaluates** (`tools/index.js:2022–2101`): calls
  `abortAndWait(8000)` if anything is running, then sends a symbol-listing
  expression through `session.evaluate`. It is genuinely a kernel *evaluation*
  tool misdocumented as a status check.
- **`editCell(evaluate:true)` divergence** (`tools/index.js:1586–1650`): the
  single-cell path evaluates the new source via `controller.session.evaluate`
  wrapped in `TimeConstrained`/`ToString[..., InputForm]`. The result goes only
  into the tool response; **the cell's stored outputs are never touched**, so
  the notebook keeps showing the previous output. Batch mode (`:1358` onward)
  runs `ctrl.execute` through the real pipeline. Two different guarantees under
  one tool name, exactly as the report claims. The direct path also has
  different semantics from a notebook run (no `Out[n]` history, no rich
  rendering, different multi-statement handling), so the divergence is worse
  than “output not committed”.
- **Range execution conflates messages with failures**
  (`tools/index.js:1786–1816`): `hasError` is set by the error sentinel **or**
  by the regex `/\w+::\w+:/` matched against any `text/plain` output, and
  `stopOnError` defaults to true. Note the regex also false-positives on
  legitimate *string results* that happen to contain `X::y:` — classification
  must come from structured evidence, not text sniffing (see amendment to §5).
- **`getCellOutput` conflation** (`tools/wolfslide-tools.js:2755`): a cell with
  no stored output returns the single combined string “no output (not evaluated
  yet or suppressed result)”.
- **`list_clients` never deduplicates** (`claude-mcp/server.js:771–833`):
  notebook arrays are trusted verbatim; duplicates and case/separator variants
  print as distinct rows.
- **Serializer persists every MIME item verbatim** (`serializer.js:106–130`).
  On *load* it already re-derives missing `text/plain` from stored HTML
  (`serializer.js:56–66`) — a precedent that derived render data can be
  recomputed rather than persisted, which supports the P2 direction.
- **Transport-layer operations** (`claude-mcp/server.js:499–609`): every
  `tools/call` is wrapped in an operation with `OPERATION_WAIT_MS = 300000`
  (5 min) and `OPERATION_LEASE_MS = 600000` (10 min auto-abort).

### New findings the field report missed

1. **Session-bound operation ownership breaks across reconnects.**
   `_waitEvaluation` rejects when `operation.sessionId !== sessionId`
   (`claude-mcp/server.js:534`), and the session ID is minted per SSE
   connection (`:223`) and dropped on close (`:233`). An SSE drop — most likely
   precisely during a 5-minute long poll — orphans the operation; the agent's
   reconnected session cannot collect or renew it, and 10 minutes later the
   lease expiry **aborts the kernel**. The resumability mechanism can itself
   destroy a computation after a network blip.
2. **Internal tool timeouts are the dominant escape path, not the 5-minute
   window.** Defaults: `runCell` 30 s (`tools/index.js:1860`), `editCell`
   evaluate 15 s (`:1602`), range mode 120 s (`:1701`), `getKernelState` 10 s.
   A long computation usually exits through one of these, the tool returns
   “execution may still be running”, the transport operation **settles
   successfully and is forgotten** — after which nothing at all tracks the
   still-running kernel work: no ID, no lease, no auto-abort, no way to wait.
   The transport registry only engages when the tool itself blocks past 5
   minutes. This is the strongest argument for §3 (execution-layer operations).
3. **Lease expiry aborts whatever is running now.** `_expireOperation`
   (`claude-mcp/server.js:586–603`) dispatches a bare
   `kernelControl(action:"abort")` without checking that the kernel is still
   working on that operation — it can kill newer, unrelated work started since.
4. **No agent-vs-agent mutual exclusion.** All tools poll the same controller
   flags (`_evalDispatched`, queue length). Two concurrent MCP sessions (e.g.
   Claude Desktop plus Copilot) targeting one window interleave: the second
   call's `abortAndWait` kills the first call's evaluation. The arbiter is
   needed for agent/agent conflicts, not only agent/user ones.
5. **Preemption is a deliberate feature today, not an accident.**
   `controller.js:1840–1842` documents `abortAndWait` as “Used by AI tools to
   claim priority over user-initiated evaluations”, with a user-facing toast.
   Collab-mode responsiveness (agent iterating quickly while a user cell
   blocks) was the point. A durable fix therefore *demotes preemption to an
   explicit, attributable, non-default policy* rather than deleting it — see
   the amendment to §1.
6. **New MCP tools require `package.json` declarations.** The MCP schema list is
   built from `contributes.languageModelTools` (`claude-mcp/server.js:866`), so
   every new tool in this plan (`kernelStatus`, `operationStatus`,
   `saveNotebook`, `getResult`, …) needs a matching `package.json` entry, and
   the agent-facing skill card
   (`claude-mcp/wolfbook-skill/SKILL.md`) plus tool descriptions must teach the
   new busy/status/operation protocol — otherwise agents will keep probing with
   `getKernelState` out of habit.

## P0 — establish correctness contracts

### 1. Introduce a single kernel execution arbiter

All kernel-facing paths—MCP, notebook UI, live watch, Dynamic, debugger, remote
bridge, and internal helpers—should declare their intent to one arbiter rather
than inspecting flags and calling `abortAndWait()` independently.

Suggested interface:

```js
kernelArbiter.status()                         // synchronous, memory-only
kernelArbiter.acquire({ owner, kind, policy, caption }) // returns lease or BusyError
kernelArbiter.abort({ operationId, requestedBy, reason })
kernelArbiter.release(lease, outcome)
```

Default policies:

- A new mutating/evaluation request while busy returns `busy`; it does not abort.
- Document-only reads bypass the arbiter.
- Kernel-inspection calls either wait behind the active lease or return `busy`.
- Only `wolfbook_kernelControl(action:"abort")`, the user Abort command, or an
  expired operation lease can cancel work.
- Queuing must be explicit (`busyPolicy:"queue"`), bounded, visible in status,
  and cancellable. The safer default for agents is `busyPolicy:"reject"` because
  silent queues can execute stale intentions much later.
- Every operation may carry a short, caller-supplied `caption` such as
  `"Integrate strip c3 at 80-digit precision"`. Captions are descriptive only:
  they never affect routing or identity, are length-bounded and sanitized, and
  appear in busy responses, queue listings, progress views, and journals. When
  omitted, Wolfbook derives a conservative caption from tool name, notebook,
  cell ID, and a truncated source preview. This is especially valuable after
  model context compaction, when an opaque operation ID alone is insufficient.

A structured busy response should include:

```json
{
  "state": "busy",
  "operation_id": "op_...",
  "caption": "Integrate strip c3 at 80-digit precision",
  "kind": "cell-evaluation",
  "cell_id": "c3a2",
  "started_at": "2026-08-17T10:00:00Z",
  "elapsed_ms": 418200,
  "queue_depth": 0,
  "abort_pending": false,
  "allowed_actions": ["wait", "abort"]
}
```

#### Design amendments (code review 2026-08-17)

- **Preemption stays as an explicit policy, not a default.** Collab-mode
  “AI takes priority” is a deliberate current feature (`controller.js:1841`).
  Add `busyPolicy:"preempt"` to the arbiter: gated by a user setting
  (default off), always journaled with requester and the aborted operation's
  ID, always surfaced in the UI. `"reject"` is the default for every agent
  path. This keeps the interactive quick-iteration workflow available without
  making destruction the silent default, and avoids the pressure to bypass the
  arbiter later when someone needs preemption back.
- **The arbiter is per kernel instance and must wrap that kernel's existing
  `executionQueue`, not sit beside it.** Initially each VS Code window owns one
  controller/kernel/arbiter tuple; the multi-kernel extension below generalizes
  this to a window-local kernel pool without changing arbitration semantics.
  the MCP primary routes calls to workers over HTTP (`_invokeWorker`). So the
  arbiter lives with the controller, and busy responses/status must flow
  through the same `client_id` routing as every other tool. A second,
  MCP-side queue with different semantics would be worse than none. Precedence
  rule: notebook UI executions enqueue as today (users expect shift-enter to
  queue); agent calls default to `reject` with a structured busy response.
- **The Fairy and the remote bridge must be first-class arbiter clients.**
  `wolframShim.evalOnce`/`runNotebook` (Fairy) intentionally claims the kernel
  exclusively; it should acquire a long-lived lease
  (`kind:"fairy-run"`, policy `preempt` under its own setting) so its runs are
  attributable and other agents get an honest busy response naming the Fairy
  run. `remote/index.js` `abortEval` is an explicit abort and routes through
  `arbiter.abort` with attribution. Dynamic/Manipulate subsession reads
  (`subAuto`) are explicitly *outside* the lease — they are the observation
  channel and must never block or be blocked.
- **Kernel restart invalidates all leases** and writes a journal entry naming
  the operations it killed; `restartKernel`/`quitKernel` go through the
  arbiter like any other destructive action.

#### Acceptance criteria

- Starting any MCP tool during a long cell evaluation never changes that
  evaluation's result unless the request is an explicit abort.
- A stress test sends every registered tool while a long evaluation is active;
  document reads succeed, kernel calls return/queue consistently, and the
  original evaluation completes unchanged.
- No tool implementation outside the arbiter calls `abortAndWait()` merely to
  obtain priority.
- UI, MCP, and remote calls follow the same policy.

### 2. Add `wolfbook_kernelStatus` as a memory-only tool

This must not call `session.evaluate`, `subAuto`, syntax checking, WSTP, or any
command that can enqueue or interrupt the kernel. It should take a synchronous
snapshot of controller and arbiter state.

Minimum result fields:

- lifecycle: `offline | launching | idle | busy | aborting | faulted`
- active operation ID, caption, owner, kind, notebook, cell ID/number, and source preview
- start time and elapsed milliseconds
- queue depth and queued operation summaries including caption and age
- abort request state, requester, reason, and timestamp
- WSTP link health and last completed operation
- safe document-read tools that remain available while busy

`wolfbook_getKernelState` should be renamed in its description to “inspect
symbols” and must no longer be suggested as a way to check whether the kernel is
busy.

#### Acceptance criteria

- Repeated status calls during a long evaluation do not send any WSTP packet.
- Status latency remains below 10 ms locally.
- Status correctly distinguishes setup/queued, evaluating, aborting, and idle.
- The active operation ID matches the ID returned by run/wait tools.

### 3. Move operation IDs from the transport layer into the execution layer

The new five-minute resumable MCP response is a useful transport safeguard, but
it is not sufficient by itself. Several tools have shorter internal deadlines
(often 15, 30, or 120 seconds). If a tool returns “execution may still be
running” at its own deadline, the generic MCP promise is already complete and
there is no operation result for `waitEvaluation` to retrieve.

Create operations when kernel work is scheduled, not when an HTTP request happens
to remain unresolved. One registry should support:

- `pending | running | completed | failed | aborted | expired`
- original tool, normalized arguments, target client/notebook/cell
- bounded caller caption plus a derived fallback caption
- start/end time and current phase
- result handle and truncated preview
- accumulated `Print` output and kernel messages
- cancellation provenance
- lease expiry and retrieval expiry

Use one optional execution mode across tools rather than adding a separate
`runCellAsync` family:

```json
{ "wait_mode": "up_to_timeout" }  // default; returns result or operation ID
{ "wait_mode": "async" }          // returns operation ID immediately
{ "caption": "Compute temperature sweep" }
```

`wolfbook_waitEvaluation` and a new `wolfbook_operationStatus` then work for
`runCell`, `runCells`, evaluate-on-insert/edit, and any deliberately asynchronous
`evaluateExpression` call. A computational timeout that actually invokes
`TimeConstrained` must be reported as a completed timeout—not as work that can
still be waited on.

#### Design amendments (code review 2026-08-17)

- **Ownership is the operation ID, not the MCP session.** The current
  `_waitEvaluation` rejects a resume from any session other than the one that
  started the call, but session IDs die with the SSE connection — a reconnect
  orphans the operation and the lease expiry then aborts the kernel. The
  operation ID is already an unguessable UUID; possessing it is sufficient
  authority to wait, poll, or abort. Log the session for attribution, never
  gate on it.
- **Lease expiry must be conditional.** Auto-abort on an abandoned lease is only
  legitimate while the arbiter confirms that operation still holds the kernel
  lease. If it no longer does (work finished, kernel restarted, another
  operation acquired), expiry just forgets the record. Expiry should also be
  disabled by default for operations the user started from the UI.
- **Operations must be minted in the window that owns the kernel.** The
  transport registry lives in the primary window, but the work may run in a
  worker window behind `_invokeWorker`. Execution-layer operations therefore
  live beside each controller; the primary proxies `operationStatus`/`wait`
  calls by `client_id` exactly like other tools. Otherwise operation IDs die
  with worker restarts or fail to resolve across windows.

#### Acceptance criteria

- Every response saying work is still running contains a valid operation ID.
- Waiting returns the original result exactly once; repeated status reads are
  idempotent and do not restart evaluation.
- Tool timeout, MCP response window, worker routing, and computational timeout
  are named separately in schemas and responses.
- Cross-window operations have identical behavior to primary-window operations.
- Abandoned leases abort only the operation they own; they cannot abort newer or
  unrelated work.

### 4. Make cell output commits revision-bound and atomic

All evaluate-after-edit/insert/run paths should use one notebook execution path.
Direct evaluation may be used internally, but success cannot be returned until
the result has been committed to the target cell.

**Implementation direction (code review 2026-08-17):** the cheapest correct fix
is reuse, not a new commit protocol. `RunCellTool`'s single-cell silent path
(`ctrl.execute` + idle-poll + read committed `cell.outputs`,
`tools/index.js:1862–1999`) already implements “evaluate through the pipeline
and report what the notebook shows”. Extract it into a shared helper and call
it from `editCell(evaluate:true)` and `insertCells(evaluate:true)`; delete the
`session.evaluate` branch of `editCell`. Direct evaluation remains only in
`evaluateExpression`, which is honestly a *scratch* evaluation — document it as
not cell-bound and exempt from the commit contract (but still behind the
arbiter). The provenance metadata below then has a single writer: the checkout
pipeline.

Track the following provenance in the in-memory operation registry, keyed by
notebook URI, stable cell ID, and source hash (optionally mirrored to a bounded
external sidecar when cross-restart recovery is explicitly enabled):

```json
{
  "cellEvaluation": {
    "operationId": "op_...",
    "sourceHash": "sha256:...",
    "status": "running|success|null|messages|failed|aborted",
    "completedAt": "..."
  }
}
```

At commit time, compare cell ID and source hash. If either changed while the
kernel was running, do not attach the result to the new source. Store it in the
operation journal and report an explicit stale-result conflict.

The tool response should be built from the committed notebook output, not from a
parallel direct-evaluation return value. It should include the operation ID,
source hash, output revision, and whether the document is dirty/saved.

This same MCP-side provenance lets `getCellOutput` distinguish during the
current extension session:

- never evaluated
- currently running
- evaluated successfully with visible output
- evaluated successfully to `Null`/suppressed output
- completed with messages
- failed or aborted
- stale output whose source hash no longer matches

#### Acceptance criteria

- After `editCell(evaluate:true)`, tool output and visible/stored cell output are
  byte-equivalent in their canonical plain representation.
- Editing a cell during its evaluation can never attach the old result to the
  new source.
- Reloading a saved notebook preserves the distinction between never-run and
  evaluated-to-Null.
- A fault-injection test between evaluation completion and output commit returns
  a failure; it never reports success with stale notebook state.

## P1 — make agent actions safe and diagnostically useful

### 5. Separate messages from execution failures

Wolfram messages are diagnostics, not a reliable severity system. A computation
can produce a useful result with `NIntegrate::slwcon`; conversely, some serious
messages still leave a symbolic expression rather than `$Failed`. The tool
contract should report outcome and messages independently.

Recommended range options:

```json
{
  "stop_on_failure": true,
  "message_policy": "collect"
}
```

Where:

- **failure** includes transport/kernel failure, `$Failed`, `$Aborted`, syntax
  failure, missing result caused by execution failure, or output-commit failure;
- **message** is collected and summarized by tag but does not stop the range by
  default;
- `message_policy:"stop"` provides today's strict behavior;
- the response reports `outcome`, `message_count`, `message_tags`, and whether a
  usable result was produced.

Do not attempt a permanent hard-coded warning/error taxonomy for all Wolfram
message tags. Allow a small explicit fatal set (especially syntax/protocol
failures) and let callers opt into tag allow/deny lists later.

**Classification must come from structure, not text sniffing (code review
2026-08-17).** Today `hasError` is set by matching `/\w+::\w+:/` against
`text/plain` output (`tools/index.js:1798`), which false-positives on any
string *result* containing `X::y:` and cannot distinguish a message from a
failure. The checkout pipeline already separates kernel messages into the
error-sentinel output; the kernel knows whether the result was `$Failed` /
`$Aborted`. Classify from those. The regex may survive only as an advisory
“output may contain messages” flag — never as a stop trigger.

### 6. Add optimistic preconditions to every cell mutation

Stable cell IDs should remain the preferred address. Numeric addressing is still
useful interactively, but destructive operations should accept and verify:

- `expected_cell_id`
- `expected_kind`
- `expected_source_hash` or `expected_source_prefix`

On mismatch, reject without editing and return the current kind and first source
line. Every edit confirmation should echo the resolved cell ID, kind, old first
line, new first line, and source hash.

Add `wolfbook_convertCellKind` (or a `kind` option on `editCell`) that preserves
cell identity where VS Code permits it. Code-shaped text sent to Markdown and
Markdown-shaped text sent to code should produce a warning, but heuristics must
not silently change the kind.

### 7. Make cancellation attributable and state-safe

Every abort should create a journal record:

- operation ID
- requester (`user`, MCP session, remote client, lease expiry, shutdown)
- reason and timestamp
- native acknowledgement timestamp
- final outcome

Do not force-clear JavaScript abort flags and immediately declare the kernel idle
unless native link state confirms it. If acknowledgement times out, expose
`faulted`/`abort-uncertain` and require recovery or restart. A later `$Aborted`
response should include the matching cancellation record when one exists.

### 8. Add verifiable save semantics

Implement `wolfbook_saveNotebook` as a real tool and route all agent-requested
saves through it. Return:

- canonical absolute path
- bytes written
- modification time observed after save
- SHA-256 of on-disk bytes
- current document dirty state
- notebook content/source revision

The operation succeeds only after reading the file back and verifying the hash.
For imported read-only `.nb` documents, return the exact required save-as action
instead of reporting an in-place save.

### 9. Provide bounded operation progress and a journal

Extend operation state rather than creating disconnected ad hoc tools:

- `wolfbook_operationStatus(operation_id, include_progress:true)` returns the
  latest bounded `Print` lines, new message tags, phase, and elapsed time.
- Keep a ring buffer, byte cap, and monotonic sequence number so polling returns
  only new progress and cannot grow responses without bound.
- `wolfbook_evaluationJournal` returns recent operation summaries after context
  compaction or reconnect: inputs truncated by policy, timing, outcome, target,
  message tags, and result handle.
- Persist only a small per-notebook journal sidecar if cross-restart recovery is
  required; never put unbounded transcripts into `.wb`.

#### Optional semantic progress monitors

Wolfram evaluations can expose meaningful progress by updating a symbol inside a
loop, and Wolfbook already has machinery for observing changing expressions
during a running evaluation. Build on that capability, but make monitoring an
explicit execution option rather than rewriting arbitrary code or guessing which
local variable represents progress.

Suggested input contract:

```json
{
  "caption": "Compute 120 momentum strips",
  "progress": {
    "expression": "stripIndex",
    "minimum": 0,
    "maximum": 120,
    "label_expression": "currentRegion",
    "sample_interval_ms": 1000
  }
}
```

For convenience, cell code can update a known global progress symbol, or a
future helper such as `WBProgress[current, total, label]` can standardize this.
Wolfbook samples the expression through the same non-preemptive
Dynamic/subsession mechanism used for live monitoring; it must never send an
ordinary evaluation packet, claim the kernel lease, or interrupt the main run.
The operation registry stores only the latest sample plus a small bounded
history.

Status should return both raw and normalized values:

```json
{
  "progress": {
    "state": "available",
    "current": 47,
    "minimum": 0,
    "maximum": 120,
    "fraction": 0.3917,
    "label": "region c3",
    "sampled_at": "2026-08-17T10:08:02Z",
    "stale_after_ms": 5000
  }
}
```

Important constraints:

- Monitoring is optional; absence of a monitor is not an error.
- Never inject assignments into user code automatically. That can change
  scoping, `Hold*` behavior, performance, or numerical semantics.
- Validate monitored expressions and restrict them to side-effect-free symbol or
  expression reads. Do not accept compound expressions containing assignment,
  I/O, process control, or arbitrary evaluation side effects.
- Sampling is rate-limited, serialized with all other subsession reads, and
  disabled when the native link reports that safe observation is unavailable.
- A monitor failure marks progress `unavailable`; it does not fail or abort the
  underlying computation.
- Progress is advisory. Completion is determined only by the operation state,
  never by reaching the declared maximum.

This gives the UI a real progress bar and gives agents evidence that a long
integral or loop is advancing. It is materially better than inferring progress
from elapsed time or repeatedly probing the kernel.

#### Progress and caption acceptance criteria

- A monitored long loop completes with exactly the same result with monitoring
  enabled and disabled.
- Sampling cannot trigger the arbiter's preemption or abort path.
- A changing monitored variable appears in operation status within two sampling
  intervals; a local/block-scoped or unavailable variable produces a clear
  `unavailable` state without affecting the run.
- Progress buffers remain below their configured byte/sample caps during an
  hour-long evaluation.
- Queue and journal responses always show a stable caption; user-supplied
  captions survive waiting and context compaction.
- Captions are escaped in Markdown/HTML views and capped (for example, 160
  characters) to prevent response flooding or UI injection.

Completion notifications are worth supporting where an MCP client implements
progress/task notifications, but polling must remain the portable baseline.

## P2 — reduce MCP token cost without changing notebook storage

This section is an MCP exposure redesign, not a `.wb` format redesign. The
serializer and persisted MIME payloads remain unchanged. MCP tools should build
compact canonical projections when reading notebook state and keep any derived
render cache outside the notebook file.

### 10. Define a canonical output representation and content-addressed cache

The report is right that persisted rendered HTML is expensive, but “store only
plain text” is too aggressive. Graphics, typeset structures, and offline notebook
reopening are user-visible features; plain text cannot reconstruct every output
without the original kernel state.

A safer design is:

- MCP responses expose canonical source plus a compact output manifest and plain preview;
- non-derivable artifacts (images, meshes) live in the existing image sidecar;
- derivable render products (KaTeX HTML, expanded box markup) live in a
  content-addressed cache keyed by renderer version, format, and canonical box
  data;
- optionally retain compact canonical box data when it is required to rerender
  symbolic output without a kernel;
- agent tools never return render caches unless explicitly requested;
- no serializer migration occurs; old and new notebooks retain the same on-disk format.

Before changing the MCP projection, measure a representative corpus and publish:

- bytes and estimated tokens by MIME item;
- cold/warm reopen latency;
- response-size and estimated context-window reduction;
- projection fidelity against the unchanged notebook output;
- cache cold/warm read latency.

Target: at least a 70% median reduction in MCP output tokens with no loss of
agent-requested information and no change to offline notebook behavior.

### 11. Standardize bounded result handles

All potentially large reads should use the same response envelope:

```json
{
  "preview": "...",
  "truncated": true,
  "total_chars": 184220,
  "result_handle": "result_...",
  "expires_at": "..."
}
```

Add one `wolfbook_getResult(handle, offset, limit, format)` tool rather than
inventing per-tool full-output switches. Handles should cover cell output,
operation results, kernel state, logs, and large notebook-context sections.

### 12. Normalize and deduplicate discovery output

Before storing or formatting client notebook lists:

- normalize path separators and case according to platform;
- deduplicate by normalized absolute URI;
- sort deterministically;
- include a registration generation/timestamp to replace stale entries cleanly.

Add a regression test where the same notebook is reported repeatedly and assert
that `list_clients` prints it once.

## Proposals to defer or narrow

### Per-symbol `.mx` persistence

Useful in principle, but `DumpSave` is not a general independent-object store.
Definitions can depend on contexts, packages, external files, library state, and
Wolfram/platform versions. First deliver operation journaling, verified notebook
saves, and explicit restart recovery. Later, consider named checkpoints with a
manifest of contexts and dependencies rather than promising arbitrary symbol
portability.

### `runInitCells`

Potentially valuable, but it requires a durable tag model, ordering rules,
idempotence guidance, trust/confirmation policy, and failure semantics. Treat it
as a notebook bootstrap feature after cell revision metadata exists. A first
version should run explicitly tagged code cells in document order and stop on
failure—not infer initialization cells heuristically.

### Worker kernels

Defer until the arbiter, operation registry, output provenance, and persistence
contracts are complete. Multiple kernels multiply state-consistency and
cancellation problems. An earlier, lower-risk improvement is documentation and
an opt-in helper for Wolfram's own parallel kernels, with licensing checks and a
clear statement that distributed definitions are the user's responsibility.

### Immediate completion notifications

Support as an optimization, not as the only protocol. MCP client support varies.
The operation registry plus status/wait tools must remain authoritative.

## Recommended delivery sequence

### Milestone A — no more accidental loss

1. Implement memory-only `wolfbook_kernelStatus`.
2. Add the central arbiter and remove implicit `abortAndWait()` calls.
3. Register operations at execution start and connect wait/abort to them.
4. Add cancellation provenance and busy/abort stress tests.

**Exit condition:** no non-abort tool can kill another operation.

### Milestone B — notebook and tool results cannot diverge

1. Add source hashes and evaluation metadata.
2. Route all edit/insert evaluation through one output-commit pipeline.
3. Add atomic commit and stale-source tests.
4. Expose precise cell output states.
5. Add verified save.

**Exit condition:** every reported result is traceable to the visible source and
stored notebook state.

### Milestone C — efficient long scientific runs

1. Separate failures from messages in batch execution.
2. Add progress buffers, optional semantic progress monitors, operation
   captions, and the operation journal.
3. Add bounded result handles.
4. Add mutation preconditions and cell-kind conversion.

**Exit condition:** agents can supervise long computations without blind probes,
duplicate execution, or excessive response size.

### Milestone D — explicit kernel identity and optional isolation

1. Surface stable session-local kernel IDs in UI, MCP status and operations.
2. Introduce the window-local `KernelManager` while preserving one shared
   default kernel.
3. Add notebook bindings and targeted lifecycle operations.
4. Enable bounded opt-in additional kernels only after routing tests pass.

**Exit condition:** users and agents can always identify the target kernel, and
optional within-window isolation cannot redirect or abort another kernel.

### Milestone E — MCP exposure redesign

1. Instrument the MCP payload produced from a representative notebook corpus.
2. Specify and version the canonical MCP output projection/cache format.
3. Build projection fidelity tests against unchanged serialized notebooks.
4. Roll out the MCP projection behind a setting before changing its default.

**Exit condition:** substantial token/diff reduction with measured fidelity and
reliable backward compatibility.

## Metrics that should gate release

- **Implicit abort rate:** zero in concurrency tests.
- **Unattributed aborts:** zero; every abort has requester and operation ID.
- **Tool/document divergence:** zero in edit/run fault-injection tests.
- **Busy status side effects:** zero WSTP packets per status call.
- **Long-run recovery:** 100% of still-running responses can be resumed or
  explicitly aborted by operation ID.
- **Progress non-interference:** monitored and unmonitored runs produce identical
  results; progress sampling causes zero implicit aborts or ordinary WSTP
  evaluations.
- **Queue legibility:** every active/queued operation has a bounded stable
  caption in status and journal output.
- **Batch semantics:** warnings continue by default; true failures stop by default.
- **Mutation conflicts:** 100% of stale source/kind preconditions reject without
  modifying the notebook.
- **Save verification:** returned hash equals independently computed disk hash.
- **Client discovery duplicates:** zero after normalized deduplication.
- **Output footprint:** measured against a fixed corpus before adopting a new
  serialization default.

## Bottom line

The report's central lesson is not merely “add more tools.” Wolfbook needs a
small number of authoritative state machines shared by every tool. A kernel
arbiter prevents accidental destruction, an operation registry makes long work
observable, and revision-bound commits make notebook outputs trustworthy. Those
three changes would improve nearly every agent workflow; the remaining proposals
become safer and simpler once those foundations exist.

---

# Implementation plan (2026-08-17)

Phases are ordered so each ships independently, is testable headlessly where
possible, and never leaves the extension in a state worse than today. All paths
are under `Extension Development/` unless noted. Remember: `out/` **is** the
source — edit it directly, verify with `node --check`, deploy with
`./deploy-extension.sh quick`.

## Phase 1 — arbiter + memory-only status (Milestone A, part 1)

Goal: no agent tool can silently destroy running work; agents get an honest
busy answer instead.

1. **New `out/extension/kernel/arbiter.js`** — vscode-free, unit-testable
   (pattern: `kernel/diagnose.js`). Scope deliberately minimal in this phase:
   - `status(ctrl)` — pure snapshot derived from existing controller fields
     (`kernelStatusString`, `_evalDispatched`, `executionQueue.queueLength()`,
     `isAborting`, `_abortPending`, `_dynCells.size`, `_silentExecution`) plus
     arbiter-held lease/journal state. No writes, no WSTP.
   - `acquire(ctrl, { owner, kind, policy, caption })` → `{ lease }` or
     `{ busy: <structured payload> }`. Single active agent lease; `policy` ∈
     `reject` (default) | `preempt` (calls the existing `abortAndWait`,
     journaled, toast preserved).
   - `release(lease, outcome)`, `abort({ requestedBy, reason, operationId })`
     (wraps `abortEvaluation`/`abortAndWait`, writes a journal record).
   - In-memory journal ring (≤100 entries) of acquisitions, aborts, forced
     flag-clears, restarts. `controller.js` instantiates one arbiter per
     controller and exposes it as `ctrl.arbiter`.
   - Do **not** try to own `executionQueue` in this phase — status is a view,
     leases gate only agent-initiated work. Full queue ownership is Phase 2+.
2. **New shared helper in `tools/shared.js`:**
   `acquireKernelForAgent(ctrl, { caption, policyOverride })` returning either
   a lease or a ready-made `LanguageModelToolResult` containing the structured
   busy JSON from §1. Policy read from a new setting
   `wolfbook.ai.busyPolicy` (`"reject"` default, `"preempt"` legacy behavior);
   per-call `busyPolicy` input allowed but `preempt` honored only when the
   setting permits it.
3. **Replace the seven `abortAndWait` call sites** in `tools/index.js`
   (`:517, :978, :1358, :1595, :1719, :1866, :2023`) with
   `acquireKernelForAgent` + `release` in a `finally`. `getKernelState`
   additionally: busy → return busy payload immediately (never abort, never
   wait), and its description gains “inspects symbols; NOT a busy check — use
   wolfbook_kernelStatus”.
4. **Route explicit aborts through the arbiter** for attribution:
   `KernelControlTool(action:"abort")` (`tools/index.js:2130`),
   `remote/index.js` `abortEval`, and the UI abort command if cheaply
   reachable. `wolframShim` (Fairy) switches to
   `acquire({ kind:'fairy-run', policy:'preempt' })` — behavior unchanged, now
   attributable; other agents see “busy: fairy-run” instead of killing it.
5. **New tool `wolfbook_kernelStatus`** in `tools/index.js` +
   `package.json` `contributes.languageModelTools` entry. Returns the §2 field
   set from `arbiter.status()` only. Add to the MCP skill card
   (`claude-mcp/wolfbook-skill/SKILL.md`): “to check busy state use
   wolfbook_kernelStatus; a busy response is not an error — wait or ask”.
6. **Tests:** `out/extension/kernel/tests/arbiter.test.js` (headless, mock
   controller): reject-while-busy, preempt journaling, release idempotence,
   restart invalidation, status purity (no method calls on the session object).
   Manual stress: start a 10-minute cell, fire every kernel tool via MCP,
   assert the evaluation completes and each tool returned busy/queued.
7. **Gold-suite guard:** the `wolframShim` change touches the Fairy substrate —
   run a gold subset (e.g. `GT14,GT01,TS04`) before and after, compare with
   `goldRunner.js compare`.

Exit: metric “implicit abort rate = zero in concurrency tests”; legacy behavior
recoverable via `wolfbook.ai.busyPolicy: "preempt"`.

### Phase 1 implementation status — complete (2026-08-17)

- The per-controller arbiter, bounded journal, pure status snapshot, structured
  busy result, safe default policy and explicitly gated legacy preemption are
  implemented. Explicit aborts from MCP, Remote, VS Code and the debugger carry
  attribution through the arbiter.
- Every agent-facing direct evaluation route is covered, including the original
  seven notebook routes plus symbol lookup, syntax validation, Paclet search,
  checkpoint/restore, slide eval blocks and full debug sessions. Direct tool
  evaluation goes through a tracked wrapper; Dynamic/live-watch observation is
  intentionally outside the lease as a non-interfering subsession channel.
- Fairy owns an attributable `fairy-run` lease. A regression test covers both
  physical-busy preemption and replacement of an arbiter-owned lease, including
  the legacy `preempt` path.
- `wolfbook_kernelStatus`, the setting/schema changes and agent guidance are
  shipped without changing notebook metadata or the `.wb` serialization format.
- Automated gates comprise the headless arbiter suite, operation-registry suite,
  and a static route guard that rejects raw agent `session.evaluate`, implicit
  tool `abortAndWait`, or bypasses of UI/Remote/debug/Fairy arbitration. The
  extension-wide JavaScript syntax pass and VSIX packaging pass. A live
  contention run confirmed that a concurrent request receives structured busy
  state while the original evaluation completes unchanged.

Phase 1's focused arbitration tests are the promotion gate for this substrate
change. The longer stochastic `GT14,GT01,TS04` Fairy sweep remains useful as a
release-level quality benchmark, but is not used as a correctness substitute
for the deterministic lease/preemption regressions above.

## Phase 2 — execution-layer operations (Milestone A, part 2)

Goal: every “still running” answer carries a durable handle; nothing is aborted
by accident when handles expire.

1. **New `out/extension/kernel/operations.js`** (vscode-free): per-window
   registry `{ id, tool, argsSummary, notebook, cellId, caption, state
   (pending|running|completed|failed|aborted|expired), startedAt, endedAt,
   resultPreview, progressRing, cancellation, retrievalExpiry }`. Bounded
   (last N=50 operations, ring-buffered progress ≤32 KB each).
2. **Mint operations at dispatch** in the kernel-mutating tools (`runCell`
   single + range, `insertCells`/`editCell` evaluate paths, async
   `evaluateExpression`). Add `wait_mode` (`up_to_timeout` default | `async`)
   and `caption` inputs (update `package.json` schemas). Every internal-timeout
   response (“execution may still be running”) must include the operation ID —
   this closes the dominant escape path found in verification.
3. **New tool `wolfbook_operationStatus`**; extend `runCell`-family responses
   and `waitEvaluation` to resolve IDs against the execution registry first,
   falling back to the transport registry. Routing: the primary proxies by
   `client_id` via `_invokeWorker`, same as any tool.
4. **Fix transport-layer hazards in `claude-mcp/server.js`:**
   - `_waitEvaluation`: drop the `operation.sessionId !== sessionId` gate
     (UUID possession is the capability; keep session in the log only).
   - `_expireOperation`: abort only after confirming via arbiter status that
     the kernel is still on that operation's work; otherwise just forget.
5. **Progress capture:** checkout pipeline appends `Print` lines and message
   tags to the active operation's ring buffer (byte-capped, sequence-numbered).
6. **Tests:** headless registry tests (lifecycle, expiry-without-abort,
   ring-buffer caps); live test: `runCell(timeoutSeconds:5)` on a 60 s cell →
   returns ID → `operationStatus` shows running → `waitEvaluation` from a
   *fresh* MCP session returns the result.

Exit: “100% of still-running responses can be resumed or explicitly aborted by
operation ID”, including across SSE reconnects.

### Phase 2 implementation status — complete (2026-08-17)

- A bounded per-window operation registry now owns durable execution UUIDs,
  lifecycle, captions, cell attribution, committed-output previews, retrieval
  expiry and byte-capped sequence-numbered progress. This is MCP-side memory
  only and does not change notebook metadata or the `.wb` file format.
- All evaluating `runCell`/`runCells`, `insertCells`, `editCell`, and
  `evaluateExpression` paths support `wait_mode:"async"`; transport and
  execution layers share one UUID. Expiring a transport waiter never aborts
  kernel work.
- `Print` packets and kernel messages are captured as bounded progress.
  `wolfbook_operationStatus`, the evaluation journal and result handles expose
  the operation after context loss or transport reconnect.
- Both `wolfbook_waitEvaluation` and `wolfbook_operationStatus` discover the
  UUID's owning VS Code window after a fresh untargeted SSE connection, while
  preserving explicit `client_id` routing when supplied.
- Five deterministic test files cover registry limits/lifecycle, expiry without
  abort, UUID unification, fresh-session worker discovery, schemas and static
  safety guards. A live macOS ARM64 MCP test ran an eight-second cell, observed
  three incremental `Print` events while running, disconnected, then recovered
  all eight progress events and `Out[1]=123` through a fresh SSE session.

## Phase 3 — one evaluation pipeline + output provenance (Milestone B)

**Implementation status: complete.** All notebook evaluation entry points use
the committed-output pipeline; source-hash provenance prevents stale attachment;
cell output uses the full status taxonomy; range execution separates messages,
failures and aborts; verified save and mutation preconditions are live-tested.

1. **Extract** `RunCellTool`'s silent-execution block
   (`tools/index.js:1862–1999`) into a shared
   `runCellViaPipeline(ctrl, notebook, idx, { timeoutMs, token })` helper;
   reuse it in `editCell(evaluate:true)` (deleting the `session.evaluate`
   branch) and `insertCells`. Responses are built from committed
   `cell.outputs` only.
2. **MCP-side provenance:** checkout updates the operation registry with
   `{ operationId, notebookUri, cellId, sourceHash, status, completedAt }` at
   execution start and completion without modifying cell metadata. At commit,
   compare the cell's current source hash; on mismatch, keep the result in the
   operation journal and report a stale-result conflict instead of attaching it.
3. **`getCellOutput` taxonomy** from that registry plus the current cell outputs:
   never-run / running /
   success-with-output / success-Null / completed-with-messages / failed /
   aborted / stale.
4. **Message vs failure in range mode:** classify from the error sentinel and
   `$Failed`/`$Aborted` detection; add `stop_on_failure` (default true) and
   `message_policy` (`collect` default | `stop`); demote the `::` regex to an
   advisory flag. Keep `stopOnError` accepted as a deprecated alias for one
   release.
5. **`wolfbook_saveNotebook`** with read-back SHA-256 verification; imported
   `.nb` documents return the explicit save-as instruction (per the serializer
   guard).
6. **Mutation preconditions:** `expected_cell_id` / `expected_kind` /
   `expected_source_prefix` on `editCell`, `deleteCell`, `moveCell`; mismatch
   rejects with current kind + first line. Echo resolved ID/kind/first-line in
   every confirmation.
7. **Tests:** fault-injection between completion and commit; edit-during-run
   stale check; same-session state distinguishes never-run vs Null and restart
   degrades explicitly to `unknown`; `editCell(evaluate:true)`
   response equals stored output byte-for-byte in plain form.

## Phase 4 — long-run ergonomics (Milestone C)

**Implementation status: complete.** Captions, bounded evaluation journal and
result retrieval, safe `subAuto` progress sampling, normalized client notebook
lists, and extension-host registration generations are implemented. Static and
transport regression tests cover bounded lifecycle behavior, reconnectable
operation handles, duplicate notebook normalization, and registration identity.

1. Captions everywhere (sanitized, ≤160 chars, derived fallback), shown in
   busy/status/journal output.
2. `wolfbook_evaluationJournal` (recent operations, bounded).
3. Optional semantic progress monitors, strictly through the existing
   Dynamic/Manipulate subsession channel (`subAuto`), sample interval ≥1 s,
   validated side-effect-free expressions only, `unavailable` on any failure —
   per the constraints in §9.
4. Bounded result handles + `wolfbook_getResult(handle, offset, limit)`.
5. `list_clients` normalization/dedup + registration generation
   (`claude-mcp/server.js:_buildClientList`), with the repeated-notebook
   regression test.

## Phase 5 — explicit kernel identity and optional isolation (Milestone D)

**Implementation status: complete.** A window-local `KernelManager` now owns
opaque kernel identities, with machine-wide live leases ensuring that `K1`,
`K2`, and subsequent visible labels never identify two different live kernels
across VS Code windows. Workspace-state notebook
bindings, bounded isolated kernels, identity-bearing controller and
status UI, target assertions, stale-target rejection, kernel-aware client and
notebook lists, and targeted lifecycle routing. No kernel identity is written by
the notebook serializer. Deterministic tests cover persistence, mismatch
rejection, target rebinding detection, bounded creation, and independent versus
shared-controller concurrency. Every window now exposes an internal endpoint on
the existing MCP worker bridge. The kernel picker discovers those owner records
and can attach a local proxy controller to a kernel in another VS Code window;
the owner arbiter holds one lease for the complete cell transaction, and owner
generation changes or disappearance fail explicitly rather than falling back.
Each local process also has a workspace-private logical slot distinct from its
ephemeral routing ID. The picker can explicitly start a new slot, and the pool,
display number, and notebook-to-slot associations are restored after an
extension-host reload. Explicitly stopping a kernel removes that slot. This
durability remains VS Code state only and does not change `.wb` serialization.

Implement the `KernelManager`, local notebook bindings, identity-bearing status
control, MCP `kernel_id` propagation, and targeted lifecycle operations defined
below. Preserve one shared default kernel and keep additional kernels opt-in.

## Phase 6 — MCP exposure redesign (Milestone E)

**Implementation status: complete.** The measured 587-notebook corpus achieves
89.33% aggregate and 72.53% median projected-size reduction with zero source or
MIME-item-count fidelity mismatches (see `mcp-output-corpus-report.md`). Version
1 canonical projections, an optional renderer-versioned content-addressed cache,
and uniform expiring result envelopes are implemented solely at the MCP
boundary behind settings. The serializer and persisted `.wb` shape are
unchanged.

Measure a corpus first, then introduce a versioned canonical-output projection
and optional content-addressed cache solely at the MCP boundary. The notebook
serializer and `.wb` file shape are explicitly out of scope and must remain
unchanged. Provenance lives in the operation registry or a bounded external
sidecar, never in persisted cell metadata.

## Cross-cutting rules

- **Deploy/test loop:** `node --check` on every touched file, then
  `./deploy-extension.sh quick`; version bump + VSIX only at phase boundaries.
- **Schema hygiene:** every new tool/input in both `package.json`
  `languageModelTools` and (automatically) the MCP list; update SKILL.md and
  tool descriptions in the same commit — the protocol change is only durable
  if agents are taught it at the point of use.
- **Compatibility:** `wolfbook.ai.busyPolicy: "preempt"` restores today's
  behavior wholesale; deprecated inputs (`stopOnError`) accepted with a notice
  for one minor version.
- **Risk watchlist:** (a) agents stalling on busy responses instead of
  waiting — mitigated by explicit `allowed_actions` and skill-card guidance;
  (b) arbiter/flag drift if new code writes controller flags directly — grep
  gate: no new `abortAndWait` callers outside `arbiter.js`; (c) Fairy
  regressions — gold subset compare at every phase that touches
  `wolframShim`, `checkout.js`, or the controller.

## Explicit kernel identity and optional per-notebook kernels

Today all Wolfbook notebooks in one VS Code window intentionally share one
kernel, while notebooks in different windows use different kernel processes.
Shared definitions are often convenient and the current behavior should remain
the default. However, window identity is not a sufficiently precise kernel
identity: agents cannot reliably explain which definitions, active operation,
or abort target belong to which notebook, and advanced users cannot isolate two
notebooks without opening another window.

Introduce a **window-local kernel pool** with explicit notebook bindings:

- Every live kernel gets an opaque session ID such as `kernel_id:"k-7f31"` and
  a short display label such as `K1`. IDs are unique for the extension-host
  lifetime and are regenerated after process recreation; they must never be
  inferred from a window title, port, PID, notebook path, or array position.
- Existing behavior is represented by a `default` kernel binding. Newly opened
  notebooks use it unless the user explicitly creates or selects another
  kernel. There is no automatic load balancing or silent isolation.
- Notebook URI → stable logical kernel-slot bindings live in VS Code
  workspace/window state. Runtime `kernel_id` capabilities remain ephemeral,
  and a saved non-default slot recreates a fresh process after reload. This is
  **not inside `.wb` metadata**, preserving the file-format boundary and
  preventing a notebook moved to another machine from referring to a dead
  local process.
- A notebook may bind to exactly one main kernel at a time. Rebinding while
  either source or destination kernel is busy is rejected unless the user
  explicitly aborts first. Rebinding does not copy definitions; the UI must
  warn that kernel state is different.
- Each kernel owns its own controller state, execution queue, arbiter, operation
  registry, abort state, Dynamic/subsession channel, symbol cache, and restart
  lifecycle. No mutable execution state is shared between pool entries.
- Kernel creation is explicit and bounded by a configurable maximum, with
  licensing/resource warnings. Closing the last notebook bound to a non-default
  kernel offers to stop it; idle cleanup must never kill a busy kernel.

### Identity in the UI

Replace the ambiguous status label shown as merely **Wolfram Kernel** with a
compact identity-bearing control, for example **Wolfram Kernel · K1**. Its
tooltip/dropdown should show:

- kernel ID and lifecycle (`idle`, `busy`, `aborting`, `faulted`);
- process ID when available, start time, Wolfram version, and executable path;
- notebooks currently bound to it;
- active operation ID and caption;
- actions: select existing kernel, create isolated kernel, rename display label,
  restart this kernel, and stop this kernel.

Use color/icon state in addition to text, but never color alone. Notebook tabs
or their toolbar should also expose the short label so two notebooks visibly
bound to different kernels are distinguishable without opening the dropdown.
User-assigned labels are presentation only; MCP continues to route by opaque ID.

### Identity in MCP and operations

- Add `kernel_id` to `wolfbook_kernelStatus`, every busy response, operation
  record, journal entry, result handle, cancellation record, and client listing.
- Notebook-targeted tools derive the kernel from the notebook binding and echo
  both `notebook` and `kernel_id`. A supplied `kernel_id` is an optimistic routing
  assertion: mismatch rejects rather than silently running against another
  kernel.
- Kernel-only tools require `kernel_id` whenever a window has more than one
  live kernel. With exactly one kernel they may omit it for compatibility.
- `abort`, `restart`, checkpoint/restore, symbol inspection, status/wait, and
  progress monitoring are kernel-scoped. An operation ID resolves to exactly one
  kernel and cannot abort work on another.
- Extend `wolfbook_list_clients` (or add `wolfbook_listKernels`) to return the
  hierarchy `client/window → kernels → bound notebooks`, including captions and
  busy state. This removes the current false equivalence of client ID and kernel.
- **Every notebook-targeting list must show its binding inline.** Wherever MCP
  lists `.wb`/`.evsnb`/`.vsnb` documents for selection—especially
  `wolfbook_list_clients`, target-conflict responses, and notebook context/list
  actions—each notebook entry includes `kernel_id`, friendly kernel label, and
  lifecycle. A compact textual row should read, for example,
  `solver.wb  [K2 · k-7f31 · busy]`, with the structured response retaining
  separate fields. Notebooks lacking a live binding are reported explicitly as
  `unbound`; they are never silently presented as belonging to the default
  kernel. Duplicate notebook paths are still normalized/deduplicated before
  binding annotations are added.
- `wolfbook_setTarget` should return the resolved triple
  `{client_id, notebook, kernel_id}` and retain it as the session target. If the
  notebook is rebound later, the next call fails with a target-changed response
  and the new binding rather than silently following it. The agent must refresh
  or explicitly accept the new kernel target.

### Multi-kernel implementation increment

1. Introduce `KernelManager` as the window-level owner of a map of
   `kernelId → {controller, arbiter, operations, metadata}`; wrap the current
   singleton controller as the default entry without changing behavior.
2. Add a binding service keyed by canonical notebook URI and persist only that
   local mapping in `workspaceState`. Clean stale bindings on restore.
3. Route notebook execution, MCP tools, debugger, Dynamic, Watch, Fairy, and
   remote calls through `resolveKernel({notebookUri, kernelId})` instead of a
   global `getController()`.
4. Update client/notebook discovery and `wolfbook_setTarget` so every listed or
   selected notebook carries its resolved kernel ID, label, and lifecycle; add
   stale-target and unbound-notebook regression tests.
5. Add the identity-bearing status control and kernel picker before enabling
   creation of a second kernel; users must always be able to see the target.
6. Enable explicit create/bind/unbind/stop operations behind an experimental
   setting, with maximum-count and licensing guards.
7. Add concurrency tests proving two kernels in one window can run
   simultaneously, while two notebooks sharing one kernel still serialize;
   targeted abort/restart must affect only the named kernel.

**Exit condition:** every evaluation and destructive kernel action is attributable
to a visible `kernel_id`; current shared-kernel behavior remains the zero-config
default; opting into isolation never changes the `.wb` file format.
