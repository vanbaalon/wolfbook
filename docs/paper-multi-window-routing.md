# Paper MCP routing

Paper calls do not inherit notebook targets or kernel assertions. Selection is:
explicit client, exact open TeX document, longest matching workspace directory,
then the sole connected client. Multiple matching owners or no owner in a
multi-window session return a structured ambiguity response. Directory matching
respects path boundaries and Windows case-insensitivity. Relative paths require
an unambiguous open basename or an explicit client in multi-window sessions.

Windows advertise open TeX buffers and all workspace roots during registration;
open/close and workspace-folder events refresh these records. Upgrade/reload all
connected windows, not just the primary, to populate the metadata.

Preview and undo tokens have bounded, in-memory primary-side ownership records.
Token-only requests route to the original client; conflicting explicit clients
receive `transaction-client-mismatch`. Tokens are not portable across hosts.
Primary restarts discard routing receipts; pass the original client explicitly
if its transaction store survives. Restarting that client requires a new preview.

Apply opens a source buffer in the chosen host if necessary, without displaying
an editor tab. It rereads the buffer and retains hash checks, WorkspaceEdit undo,
disk-conflict checks and normal save semantics.

Responses expose `routing.client_id` and `routing.timing` with `routingMs` and
`dispatchRoundTripMs`. The latter includes worker transport and execution; it is
not labelled parse time or queue time. Per-phase parser/build timings and general
operation cancellation are not implemented by this change. Registry requests
retain their existing direct path; no new tool or global execution queue is added.
