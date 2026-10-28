# Agent kernels and repository recommendations

Codex and Claude Code should declare their working directory before notebook work:

```json
{"working_directory":"/absolute/project/folder"}
```

Pass this to `wolfbook_setTarget`. It resolves relative notebook paths and recommends
associated windows/kernels. It does not restrict access by folder, session, or
sharing label. An explicit `client_id` can select another connected window.
If multiple windows match, select one from `wolfbook_list_clients` rather than guess.

Inventory shows all connected windows, exact notebook paths, kernel IDs, durable
slots, attribution, and controller readiness. Repository-associated entries have
`recommended:true` and appear first. `global:true` keeps the original window order.
Prefer an existing repository kernel; other available kernels remain usable,
including private-labelled kernels created by an earlier or different session.

The workspace can choose a default for new notebooks. In a notebook's kernel status
menu, choose **Use Wolfram … for new notebooks in this workspace**. This saves
`wolfbook.kernels.defaultForNewNotebooks` as a durable pool slot (`default` for
the window's shared kernel), so renaming/reloading does not lose the preference.
New notebooks use it on their first Shift+Enter without a picker, and
`wolfbook_newNotebook` inherits it even in a declared agent folder session.
Existing explicit notebook assignments, explicit `kernel_id`, and explicit
`isolation:"kernel"` take precedence. If the chosen slot is unavailable, select
another kernel explicitly; no other process is silently substituted. Clearing
the preference restores the first-keyboard-evaluation picker. Without a
configured preference, declared agent sessions retain their private-isolation
default. This setting belongs to the VS Code workspace, including notebooks
opened from outside its folder; it is not an access restriction.

Create or reopen a notebook using a chosen existing process:

```json
{"path":"agent-work.wb","kernel_id":"k-from-inventory","reveal":true}
```

Pass this to `wolfbook_newNotebook`. Existing cells are preserved unless
`overwrite:true`. Its binding receipt includes the exact notebook path,
`kernel_id`, durable `kernel_slot`, binding revision, `controller_selected` and
`evaluation_ready`. Successful binding also updates the session target atomically;
subsequent notebook calls inherit it. `target:false` preserves the old target.

`reveal:true` opens the editor and selects its controller in the same call.
If `controller_selected:false`, retry once with the returned exact path,
`reveal:true` and `kernel_id`. Do not ask the user to click Open Notebook or select
a kernel manually. Inspect status if the retry fails; do not claim cells ran.
`reveal:false` loads the model in the background and may not select a controller.

If a separate Wolfram process is useful:

```json
{"path":"agent-work.wb","isolation":"kernel","kernel_label":"Agent work","acknowledge_resource_cost":true,"reveal":true}
```

Alternatively use `wolfbook_kernelManager` with `action:"create"` and
`acknowledge_resource_cost:true`, or `action:"bind"` with an existing `kernel_id`.
The legacy setting `wolfbook.kernels.maximum` is a recommended local process count,
not a creation limit. Explicit creation may exceed it; list/create receipts expose
`capacity.recommended`, `above_recommended` and `hard_limit:null`. No kernel needs
to be stopped just because this recommendation is reached. Actual Wolfram license
or startup errors still apply. Failed startup/binding rolls back the new process.

Sharing labels (`private`, `folder`, `shared`) describe intended collaboration
and attribute new processes, not access rights. Reuse requires no
`acknowledge_shared_kernel` flag. Multiple agent sessions may target the same
notebook without `force:true`; shared processes share definitions and serialize
evaluations. Prefer separate notebooks and contexts for symbols, or a dedicated
process when kernel-wide settings must be isolated. Running work is not aborted
and a busy notebook cannot be moved to another kernel. A matching notebook/kernel
pair remains required, and missing bindings never silently fall back to K1.

Save the optional `scope.resume_token` for reconnect convenience. Resume it via
`wolfbook_setTarget {"resume_token":"..."}` within 60 minutes. Tokens preserve
session identity and cannot simultaneously identify two connected sessions, but
are not required to access an existing kernel from a new session. Resume restores
an exact target only when its durable slot is still available. Runtime IDs change
on reload; restoring bindings does not restore Wolfram definitions. All saved
slots are restored even when their count exceeds the recommendation, but stay
dormant until a user or agent requests evaluation (or explicitly starts or
restarts one). Opening a window, opening a notebook, and selecting an existing
kernel do not launch processes. The separate language-server process also waits
for the first successful kernel start, so its completions and diagnostics become
available then.

Explicit notebook paths/kernel IDs/window IDs outrank routing recommendations.
Choosing another window does not inject the old notebook or kernel into it.
Opaque operation IDs and result handles can be polled/read across sessions when
provided explicitly. Ambiguous targets, missing kernels, busy moves, and actual
startup failures remain errors. `force:true` is optional stale-target cleanup,
not a prerequisite for using another session's notebook.

A short agent prompt:

> Declare `/absolute/project/folder`, inspect Wolfbook inventory and prefer a
> kernel associated with this repository. Create/reopen your notebook with its
> kernel ID and `reveal:true`, then verify readiness. Other available kernels may
> be explicitly reused; the configured process count is only a recommendation.
> If isolation needs another process, acknowledge its cost and create it. Preserve
> running work and use the returned exact notebook/kernel target.

Folder declarations are opt-in and do not change general filesystem permissions.
Paper comment listeners retain their separate file/transaction routing.

## Recovering a stuck kernel

Closing a window awaits shutdown of every locally owned kernel and its language
server. Kernels hosted by other windows are not stopped. A launch still waiting
for preflight is cancelled, and restored assignments stay dormant on reopening.

Restart targets only the selected kernel. Its ID and notebook bindings stay the
same; its session epoch and PID change. Restart waits for replacement
initialization before reporting success. Definitions in that kernel are lost.
Other kernels in the window are not stopped or rebound.

If abort is not acknowledged, do not assume a timeout has stopped the work.
A restart stops new dispatch, verifies the owned process, terminates that process,
and waits for the native reader and callbacks before closing its link. If safe
shutdown cannot be confirmed, the tool reports failure and retains the old link
instead of resetting the window. An older loaded addon may require a safe window
reload to gain this capability; do not repeatedly restart it.

For reading or summarising saved `.nb` files, prefer
`wolfbook_readNotebookFile` (overview, selected cells, search or WB JSON). It uses
no Wolfram kernel. Avoid a batch of `Import[..., "NB"]` followed by serialization
merely to read notebooks; a Wolfram timeout/abort is not a process watchdog.
Kernel IDs still have extension-host lifetime: refresh inventory after an actual
host reconnect rather than treating old IDs as durable notebook data.
