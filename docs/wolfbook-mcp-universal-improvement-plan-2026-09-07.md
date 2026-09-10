# Wolfbook MCP: Universal Friction-Reduction Plan

**Date:** 2026-09-07  
**Scope:** Improve the existing Wolfbook MCP surface without adding tools  
**Inputs:** Long-running-agent feedback and the two-day MCP usage review

## Decision

Wolfbook does not primarily need more capabilities. Its notebook primitives are already strong: stable cell IDs, live kernels, targeted reads, search previews, durable notebook state, and operation tracking. The highest-impact work is to make the existing tools behave like one small, predictable protocol.

The desired normal workflow should be:

1. Read compact notebook context, explicitly naming the notebook.
2. Search several anchors in one request when needed.
3. Edit or insert cells; receive separate edit and evaluation outcomes.
4. Wait once on an operation handle if evaluation continues.
5. Save and receive an unambiguous persistence receipt.

This should usually require four or five calls, with no preliminary `status` or `setTarget` call.

## What the additional proposal gets right

The long-running-agent report confirms that the core notebook model works well. In particular, canonical cell reads, stable IDs, preview searches, persistent kernels, and save receipts make substantial notebook work possible without unsafe direct JSON editing.

It also identifies several general problems corroborated by the local usage ledger:

- response representations vary substantially among tools;
- target and lock identity are harder to reason about than necessary;
- large evaluation output can consume excessive context;
- repeated discovery, context reads, and polling create avoidable turns;
- persistence and evaluation outcomes are sometimes ambiguous;
- activity cannot always be attributed to the responsible agent operation.

Some requested capabilities already exist in partial form:

- `wolfbook_searchCells` already accepts a notebook internally, but its public and economy schemas do not expose that parameter consistently;
- server-level bounded results and result handles exist, but bounding is disabled by default and occurs too late in the response path;
- `wolfbook_operationStatus` already has sequence-aware waiting primitives;
- session targeting and notebook auto-routing already exist, but inconsistent schemas cause agents to fall back to extra routing calls;
- canonical output projection exists, but is optional rather than the normal MCP contract.

These are integration and default-policy gaps, not reasons to add more tools.

## Priority 1: One response contract for every existing tool

All tools should return a small human-readable `content` summary and a canonical `structuredContent` object. Do not return the same payload twice as prose and pretty-printed JSON.

A shared envelope should contain only applicable fields:

```json
{
  "ok": true,
  "state": "completed",
  "code": "ok",
  "message": "Edited cell c17 and completed evaluation.",
  "target": {
    "clientId": "...",
    "notebook": "file:///.../analysis.wb",
    "kernelId": "K3"
  },
  "notebookRevision": 42,
  "cells": [],
  "operation": {},
  "result": {},
  "warnings": [],
  "nextAction": null
}
```

Failures should use the same envelope with stable `code`, `retryable`, `currentState`, and `remedy` fields. Empty structured error objects should never occur.

This single change makes every tool easier for small and large models, removes bespoke parsers, and enables compact responses without losing machine-readable state.

## Priority 2: Bound results at their source and always preserve retrieval

Enable bounded MCP results by default. More importantly, enforce limits before large values are rendered and serialized, rather than only trimming the final transport string.

Every truncated value must include:

- a short preview;
- original size and returned size;
- a stable result handle usable with the existing result-retrieval tool;
- a structural summary such as head/type, dimensions, length, keys, message count, and failure count when available.

The current 4,096-character truncation in expression evaluation can hide the remainder without producing a retrievable handle because it occurs below the server’s larger bounding threshold. Internal truncation and transport-level bounding should therefore use the same result store.

Use a generic structural summarizer instead of adding a test-specific tool. Internally, the summarizer can recognize useful Wolfram heads such as `TestReportObject`, `Dataset`, `Association`, images, graphs, and large lists, but this must remain an implementation detail of `wolfbook_evaluateExpression` and `wolfbook_getResult`.

Suggested defaults:

- economy profile: approximately 4 KiB textual preview;
- normal profile: approximately 8–12 KiB textual preview;
- explicit full retrieval only through a handle, with its own page or byte limits.

## Priority 3: Explicit notebook routing on every notebook operation

Expose the already-supported `notebook` argument consistently in the schemas for context, search, edit, insert, delete, run, inspect, output retrieval, and save operations.

Routing should follow one documented rule:

1. explicit client or kernel constraint, if supplied;
2. explicit notebook URI, resolved to the client that owns it;
3. sticky session target;
4. fail with a compact list of viable targets.

Every response should echo the resolved client, notebook, and kernel. The sticky target remains a convenience, not hidden correctness state. `wolfbook_setTarget` remains useful for a series of operations but should not be required for ordinary notebook-addressed work.

Lock information should expose a canonical owner ID, display label, known aliases, lock mode, and expiry. The same logical agent must not appear as several unrelated owners merely because different clients supplied different labels.

`wolfbook_status` should stay read-only. It may resolve or display a notebook-specific target, but it should not silently mutate session routing.

## Priority 4: Revision-aware reads and batched search

Extend the existing context and search tools rather than adding discovery tools.

`wolfbook_getNotebookContext` should support:

- `since_revision` for cells changed since a known notebook revision;
- `if_revision` or equivalent cache validation;
- compact outline mode containing cell ID, kind, heading/name, execution state, and a short preview;
- selectors for cell IDs or ranges;
- bounded inclusion of outputs.

`wolfbook_searchCells` should retain the existing single `query` input and add a backward-compatible `queries` array. Results should be grouped per query, deduplicated, and globally bounded. Its notebook parameter must be present in every advertised schema, including economy mode.

Mutation tools should accept `expected_notebook_revision` and return the resulting revision. This prevents silent edits against stale context and is more generally useful than re-reading the full notebook before every change.

## Priority 5: One operation lifecycle, with edits separated from evaluation

All potentially long operations should share the same operation states and terminal semantics. An edit that triggers evaluation must report two independent outcomes:

```json
{
  "edit": { "state": "committed", "revision": 43 },
  "evaluation": { "state": "running", "operationId": "op-..." }
}
```

The initiating tool should use a short fast path: if work completes promptly, return the completed result; otherwise return a running operation handle. It should not block for an arbitrary long interval merely to avoid returning a handle.

Keep both existing status tools but make their roles sharp:

- `wolfbook_operationStatus`: immediate snapshot and metadata;
- `wolfbook_waitEvaluation`: wait until terminal state or meaningful sequence change, then return the same operation envelope.

The underlying sequence-aware behavior already exists and should become the normal client contract. Responses should include `nextAction` such as `wait`, `getResult`, `cancel`, or `none`, so an agent does not invent polling logic.

Operations must always reach a terminal state on cancellation, client disconnect, extension reload, kernel death, and retention expiry. This addresses the observed started-without-terminal ledger entries.

## Priority 6: Complete provenance for edits, runs, and saves

Register mutation intent before applying a notebook edit, then correlate the resulting notebook change event with the MCP session, tool call, and operation. Every activity event should contain:

- MCP session ID;
- stable agent identity and display label;
- tool-call or turn ID when supplied;
- operation ID;
- target client, notebook, kernel, and cell IDs;
- start, progress, and terminal timestamps.

Save responses should add:

```json
{
  "priorDirty": true,
  "writePerformed": true,
  "previousSha256": "...",
  "currentSha256": "...",
  "persistedBy": "explicit"
}
```

`persistedBy` should distinguish `explicit`, `autosave`, and `already-current`. This removes ambiguity when autosave races with an explicit MCP save.

## Priority 7: Reduce discovery cost without a new capabilities tool

Do not add `wolfbook_capabilities`. MCP tool discovery already serves that purpose.

Instead:

- place shared rules and workflow guidance in server instructions once;
- keep each tool description to its unique purpose, important hazard, and essential selector rules;
- hide deprecated aliases from discovery while retaining compatibility internally;
- ensure the configured profile is applied consistently to both tool listing and invocation;
- expose `economy` as a supported configuration value everywhere it can be selected;
- keep detailed examples in resources or documentation rather than repeating them in every schema.

The existing economy profile should advertise only the smallest complete notebook/kernel workflow. A useful core is context, batched search, edit, insert, delete, run/evaluate, wait/status, result retrieval, save, kernel control, and syntax validation. Slide, paper, LaTeX, terminal, team, and advanced inspection tools should remain outside that profile.

## Lower-priority safe evaluation improvements

Safer experimentation is a real need, but it should not create package- or test-specific tools. If implemented, add optional policies to `wolfbook_evaluateExpression`, for example a temporary context for newly created definitions and an explicit checkpoint-before-evaluation option.

These options must clearly document their limits: a temporary context does not undo mutations to existing symbols, external files, front-end state, or packages. Automatic kernel restart or implicit rollback should not be the default.

## Proposals to reshape or decline

- **Do not add `wolfbook_runTests`.** Use generic bounded structural summaries and result handles; optional internal recognition of `TestReportObject` is sufficient.
- **Do not add a capabilities tool.** Fix the existing discovery surface and schemas.
- **Do not add a package-reload helper.** If a common safe pattern is needed, express it as an evaluation policy or documentation recipe.
- **Do not combine status and target mutation.** Saving one call is not worth making a diagnostic tool stateful.
- **Do not default all evaluation to JSON.** Many Wolfram values are not naturally JSON. Return a structured manifest plus bounded textual representation, with JSON as an explicit requested form.
- **Do not solve ambiguous routing by silently creating or restarting kernels.** Resolve deterministically or return a concise actionable conflict.

## Recommended implementation order

1. Canonical envelope, structured errors, and no duplicated payloads.
2. Source-level bounding with handles for every truncation path; enable safe defaults.
3. Schema parity for notebook routing and economy mode.
4. Unified operation states, terminalization, and `nextAction`.
5. Revision-aware context and batched search.
6. Attribution and save provenance.
7. Schema-description cleanup and optional safe-evaluation policies.

## Success criteria

Measure the changes by behavior, not by the number of implemented features:

- ordinary notebook edit-and-run work takes no preliminary target/status calls;
- no tool response duplicates a full payload as both prose and JSON;
- no unbounded result reaches the model by default;
- every truncation has a retrievable handle;
- every started operation receives exactly one terminal event;
- at least 99% of MCP-originated notebook events have attributable session and operation IDs;
- repeated notebook reads can transfer only changes since the prior revision;
- one search request can resolve several anchors;
- economy discovery remains a small, complete surface with no hidden parameter differences from the full profile.

The central principle is simple: preserve the current tool vocabulary, but make every tool obey the same targeting, revision, operation, result-budget, error, and provenance contracts.
