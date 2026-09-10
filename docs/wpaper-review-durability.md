# WPaper external-edit review

Rendering and approval are independent. A successful compile updates the page and
review placement, not the reader-approved source baseline. Closing the review hides
it; it does not accept its changes. Pending reviews, external arrival snapshots,
timestamps and feedback are persisted in private extension storage (`paper-reviews`).

The review diff describes current unresolved changes. History additionally exposes
full before/after snapshots of observed external arrivals, including edits later
superseded by another edit. Source files are not modified by opening History.

Accept + comment accepts the selected change and appends a dated, file/line-linked
comment to Feedback. Feedback is editable and copyable; nothing is sent to an agent.
Line numbers describe the location at review time, not a promise of future location.

MCP edits carry available client/session identity. Disk edits are labelled external
with unknown author: filenames and code style cannot identify a model. Explicit
viewer/mini-editor actions are marked as reader edits. VS Code does not provide
author identity for arbitrary document-change events; an unannounced extension edit
in the focused text editor can still be indistinguishable from typing. Tools should
use the review bus to identify their changes.

Tracking begins with the first observed source snapshot. Offline changes can be
compared against a saved snapshot, but intermediate disk writes never observed by
the extension cannot be reconstructed. This is a local review ledger, not version
control or a concurrent multi-window collaboration database.

Live rendering retains the user's compile/live-render settings. Frequent changes
no longer postpone a scheduled live build indefinitely: the debounce is capped at
three seconds. Build duration and errors can still delay the rendered page.
