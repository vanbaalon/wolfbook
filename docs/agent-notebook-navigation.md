# Agent notebook navigation

Wolfbook notebook tools load and edit their target document in the background.
By default they do not show a notebook editor or replace the active WPaper/source tab.
`wolfbook_newNotebook {path:"...",reveal:true,kernel_id:"..."}` explicitly
opens an editor and selects the intended controller in the same call. Use this
for a runnable new notebook or to recover an unselected controller automatically.

When an agent creates, selects, edits or evaluates a background notebook, a
nonmodal notification offers **Open Notebook**. Clicking opens a normal pinned
tab and reveals the latest affected cell in that notebook. Closing or ignoring
the notification does not change tabs or delay the agent's response. Repeated
operations are coalesced while a notification is pending and for 60 seconds
after it is shown. Read-only context inspection remains routing-neutral.

**Follow Agent** remains an explicit command for users who want automatic
navigation; **Stop Following Agent** turns it off. Collaboration mode can scroll
an existing right-hand notebook pane, but cannot automatically create one over
the paper the user is reading.

Notebook/kernel bindings and controller affinity are still recorded when a
notebook is loaded. Notebooks whose controllers are already selected continue
to evaluate through the existing evidence-gated cell pipeline in the background.
Selection targets an exact visible notebook editor, so an inactive notebook
can be associated while WPaper keeps focus. A hidden notebook needs an editor
for first-time selection: retry `wolfbook_newNotebook` with `reveal:true` and
its bound `kernel_id`; the agent completes this without a manual user click.
Silent cell recovery does not force a tab open, and reports an unassociated
cell as **NOT executed** rather than claiming success.
Clicking **Open Notebook** also attempts controller selection for the intended
binding, allowing later agent evaluations to remain in the background.

Regression coverage:

- `notebook-editor-resolution.test.js`: visible, loaded and unloaded targets;
  active-tab retention; pending/dismissed/coalesced notifications; latest-cell
  navigation; collaboration mode; explicit Follow/Stop commands.
- `notebook-background-create.test.js`: creation and safe existing-file loading
  without a visible editor; retained bindings; unattended toast; confirmed
  background evaluation; unassociated evaluation reported honestly.
- `notebook-background-association.test.js`: affinity without revealing a hidden
  document; selected-controller reuse; selection in an already-active notebook;
  user navigation during asynchronous selection setup.
- `notebook-background-shim.test.js`: background agent replay/probe association
  failures leave tabs alone and cannot be reported as clean or evaluated results.

## Saving clean cell results

After a code cell completes successfully without kernel messages, failure or
abort, Wolfbook automatically saves the notebook's source and completed outputs
through VS Code's notebook save API. This applies to agent and keyboard runs,
including definitions and suppressed results with no printed output, for `.wb`,
`.evsnb` and `.vsnb` files. Saving does not open or focus the notebook.

A changed/deleted cell, stale result, closed notebook, untitled notebook, or
imported Mathematica `.nb` view does not trigger a save. Saves of the same
notebook are serialized. A disk-save failure leaves the document dirty, reports
one nonmodal warning, and does not change the successful kernel result or stop
the execution queue.

`notebook-auto-save.test.js` checks source/output persistence, no-output success,
failure/message/abort/staleness guards, source edits during save setup, concurrent
save serialization, save-failure recovery, and the actual checkout completion
block's ordering and save eligibility.
